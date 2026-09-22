# 主动消息发图 + 生图提示词迁入神经链接 · 设计文档（2026-09-12）

> 状态：用户已批准。四项拍板：送达后本地生图（云端只回传生图请求）；定时主动消息与即时对话两条云端路都放开；主动消息模板加一句克制版配图引导；角色外貌提示词 UI 从设置页迁到神经链接（角色 App）设定页，并支持「从角色设定提取」和「上传参考图解析」两种自动解析。
> 范围：worker classifier 回程契约、客户端后处理管线接线、主动消息模板文案、角色 App 设定 UI、识图 API 说明。
> 不包含：云端生图（worker 调 latent.moe）、图片二进制旁路回传、新的开关层级、`FIRE_PACK_VERSION` 变更。
> 执行计划：`docs/superpowers/plans/2026-09-12-proactive-image-gen-plan.md`。

## 1. 背景与现状

角色在**本地生成**的聊天里已经能发图：模型输出 `[[GEN_IMAGE: 英文tag | 画幅]]`，`hooks/useChatAI.ts:2082` 传入 `imageGen` 运行时，`utils/applyAssistantPostProcessing.ts:2341` Step 5b 剥离标签并调用 `runImageGenReply`（latent.moe 生图 → blobref 落库 → 存相册）。

走**云端生成**的两条路（定时主动消息、即时对话）不能：

1. `utils/activeMsgRuntime.ts:672` 调同一条后处理管线时**没有**传 `imageGen` 运行时，Step 5b 只剥离、不执行；
2. 更早一步，worker 的 `sanitizeIntoSegments`（`utils/sanitize.ts:613`）会把「独占一行、剥光 `[[...]]` 后为空」的段整段丢掉——而提示词教的正是独占一行写法。标签通常连客户端都到不了。

提示词侧不用改就教了生图能力（`utils/chatPrompts.ts:862`，且对 `forFirePack` 模板同样生效）：角色想发也发不出来。

角色外貌档案（`CharacterProfile.imageGenProfile`）编辑 UI 现在在设置页「AI 生图」板块（`apps/Settings.tsx:3385-3406`），每角色一行输入框，`handleSaveImageGen`（`apps/Settings.tsx:1300-1312`）批量写回。项目已有「时间感知 / 时区迁到神经链接角色设定页」的先例（`apps/Settings.tsx:665` 注释、`apps/Character.tsx:1680`）。

自动提取现状：首次生图时 `imageGenFlow.ensureAppearanceProfile` 会用主 API 从人设提取一次（`utils/imageGenFlow.ts:78-138`），仅内部使用，无 UI 入口。识图通道现成：`utils/visionApi.ts` 的 `describeImageWithVisionApi`（OpenAI 兼容 vision 端点，`APIConfig.visionApi` 可作识图中转）。

## 2. 目标与非目标

**目标**

1. 定时主动消息与即时对话都能按 `[[GEN_IMAGE:]]` 发图，行为与本地聊天一致：文字气泡先落库，图片生成完追加 `type:'image'` 消息并进相册。
2. 生图请求经结构化 directive 跨 worker→客户端边界传输，不再依赖标签在文本段里存活。
3. 外貌提示词编辑迁入神经链接（角色 App）设定页；支持从角色设定（主 API 文本提取）或用户上传的参考图（vision 模型解析）一键生成 tag。
4. 沿用现有「自动生图」总开关与 latent key 作为唯一执行门，不新增开关；关着 / 没 key 时只剥离、不烧额度。

**非目标**

- 不在 worker/云端生图；图片二进制不经过推送或旁路存储。页面关着时文案先到，图在下次打开 App 冲刷收件箱时现场生成。
- 不改 `FIRE_PACK_VERSION`（fire_pack 形状不变，只有模板文案变化）。
- 不新增识别标签族（不处理全角冒号等畸形 `[[GEN_IMAGE：]]`，与本地路径现状一致）。
- 不为「纯图无文字」开特例（沿用现有 side-effects-only skip-push 政策）。

## 3. 方案

### 3.1 主动消息图：directive 回程 + 送达后本地执行

```
角色输出 [[GEN_IMAGE: tags | portrait]]（定时 fire / 云端即时对话）
  → worker classifier 摘成 { type:'gen_image', prompt, resolution }（标签从 cleanedText 剥净）
  → push metadata.directives（挂最后一段，沿用既有 isLastChunk 守卫）
  → 客户端 activeMsgRuntime 后处理：传 imageGen 运行时
  → applyAssistantPostProcessing：reconstructDirectiveTags 拼回 [[GEN_IMAGE: … | res]] → Step 5b
  → 开关开 + 有 key → runImageGenReply（浏览器经网络 Worker 直连 latent.moe）
  → 文字先落库；图生成完追加 image 消息 + 存相册 + announceChatGen(replyArrived)
```

选择 directive 而非让标签留在正文：`sanitizeIntoSegments` 的段级判空会吞掉独占一行的标签段（`utils/sanitize.ts:613`），directive 是唯一可靠通道。与转账 / 日程改动走 directive 的理由完全同构。

解析复用 `utils/imageGenTags.ts` 的 `extractGenImageTags` / `stripGenImageTags`（零依赖叶子，worker bundle 可直接 import），保证 worker 与客户端同一份 tag 语法。

### 3.2 生图提示词迁入神经链接 + 双来源解析

- 设置页「AI 生图」保留：自动生图总开关、Latent API Key、使用说明（文案改为指向神经链接）。删除每角色外貌档案输入区与 `handleSaveImageGen` 里的逐角色写回。
- 神经链接（`apps/Character.tsx`）『设定』tab（`detailTab === 'identity'`）新增一张卡片：外貌提示词输入框 + 两个按钮：
  - **从角色设定提取**：导出 `extractAppearanceFromPersona(char, apiConfig)`（复用 `extractAppearanceViaLLM`，失败抛人话错误）；
  - **上传图片解析**：`processImage(file, { maxWidth: 1024, forceJpeg: true })` → `extractAppearanceFromReferenceImage(dataUrl, apiConfig)` → 写回 `imageGenProfile`。
  - 编辑走既有 `handleChange` 自动保存链路，无需新保存按钮。
- 识图路由：`apiConfig.visionApi` 已启用 → 用识图 API（配置不全时按其固有错误抛）；否则回落主 API（baseUrl/key/model）。通过给 `describeImageWithVisionApi` 增加可选 `{ prompt, maxTokens, temperature }` 实现，默认值保持现状不变。

## 4. 数据与契约

### 4.1 directive 形状（worker `Directive` 与客户端 `PostProcessDirective` 两处同步）

```ts
| { type: 'gen_image'; prompt: string; resolution: 'square' | 'portrait' | 'landscape' }
```

- `prompt`：`extractGenImageTags` 清洗后的单行英文 tag（≤ 2000 字符由生图端再截断）。
- `resolution`：已归一化的画幅。
- 拼回文本形态：`[[GEN_IMAGE: ${prompt} | ${resolution}]]`，Step 5b 原样接住（`resolveResolution` 识别三种英文别名）。
- 一轮多个标签：directive 全量带回，客户端 Step 5b 只执行第一个（沿用现状并 warn）。

### 4.2 外貌提取 prompt（新增，写入 `utils/imageGenFlow.ts`）

```
你是角色外貌标签师。看这张参考图，提取画面人物固定可复用的外貌特征，输出一行英文 danbooru 风格 tag，逗号分隔，8-20 个 tag。
只写长相：发色、瞳色、发型、耳朵/尾巴等兽耳特征、体型、常穿的标志性服装。不要写动作、场景、光线、情绪、画风词。
直接输出 tag 串本身，不要解释、不要引号、不要 Markdown。
```

### 4.3 主动消息模板新增规则行（`utils/activeMsgClient.ts` 重要规则段）

```
- 值得给 ta 看画面的瞬间（你眼前的东西、你现在的样子、正好想分享的风景），可以附一张图：单独一行写 [[GEN_IMAGE: 英文tag | portrait]]，系统会真的把图发给他。不用每次都配，也别为了发图硬找话题。
```

## 5. 失败与边界

| 场景 | 行为 |
|---|---|
| 自动生图关 / 无 latent key | directive 照常重放，标签剥离、不执行；与本地路径同口径，不 toast（push 路径静默） |
| 页面关着 | 文案随推送先到；图在下次 App 打开冲刷收件箱时生成，追加在文字之后 |
| 纯图无文字 | worker 走既有 skip-push 政策，整轮不发（角色至少说一句话） |
| 一轮多图 | 只执行第一个 |
| 后处理重试 | 沿用 `prepareInboxRetry` 的 directives 重放闸，避免重复扣额度 |
| 老 worker + 新客户端 | 标签仍被段级丢弃（现状不变，不劣化） |
| 新 worker + 老客户端 | 未知 directive 只在 `reconstructDirectiveTags` default 分支 warn 跳过，不崩 |
| 识图 API 未配 | 回落主 API；主模型不支持看图时以人话 toast 收场，UI 提示可去设置配识图中转 |

## 6. 测试与验收

- `worker/instant-push/src/classifier.test.ts`：独占行 / 行内两种形态 → directive + cleanedText 无标签；与本地 `extractGenImageTags` 行为一致（分辨率别名、默认 portrait）。
- `utils/applyAssistantPostProcessing.imageGen.test.ts`：directive `gen_image` + 运行时开 → 调 `runImageGenReply`；开关关 / 无运行时 → 不调且文本无标签。
- `utils/activeMsgRuntime.test.ts`：inbox 消息带 `directives:[{type:'gen_image',…}]` + `imageGenEnabled` → 断言 `runImageGenReply`（mock）被调；档案回写不炸。
- `utils/visionApi.test.ts`：自定义 prompt / maxTokens 透传。
- `utils/imageGenFlow.test.ts`：`extractAppearanceFromPersona` 成功 / 失败抛错；`extractAppearanceFromReferenceImage` 在 visionApi 就绪与回落主 API 两种路由下都命中正确端点并清洗输出。
- 全量 `pnpm vitest run`；`pnpm build:workers`；含中文文件做 U+FFFD 字节自查。
- 手测（需重新部署 amsg worker、配好 latent key）：主动消息带 `[[GEN_IMAGE:]]` → 文字先上屏、图随后出现并存相册；角色页两个提取按钮可用。

## 7. 会触碰的文件

生产代码：`worker/instant-push/src/classifier.ts`、`utils/applyAssistantPostProcessing.ts`、`utils/activeMsgRuntime.ts`、`utils/activeMsgClient.ts`、`utils/visionApi.ts`、`utils/imageGenFlow.ts`、`apps/Character.tsx`、`apps/Settings.tsx`。

版本与产物：`utils/amsgBundleVersion.ts`、`utils/instantWorkerVersion.ts`、`public/instant-worker.version.txt`、`public/amsg-worker.bundle.js`、`public/instant-worker.deno.bundle.js`、`worker/amsg/worker.bundle.js`、`worker/instant-push/worker.bundle.js`、`worker/instant-push/worker.deno.bundle.js`。

测试：`worker/instant-push/src/classifier.test.ts`、`utils/applyAssistantPostProcessing.imageGen.test.ts`、`utils/activeMsgRuntime.test.ts`、`utils/visionApi.test.ts`、`utils/imageGenFlow.test.ts`。

文档：本文件与执行计划。
