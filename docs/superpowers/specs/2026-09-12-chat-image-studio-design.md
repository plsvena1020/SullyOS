# 聊天相册生图 · 设计文档（2026-09-12）

> 状态：用户已批准。拍板四项：生成结果当作「我发的图」进聊天并存相册；独立相册 App 的「＋」入口移除，只留聊天「相册」按钮；画风与质量词通用注入、性别仅在画面出现该角色时注入；画角色/纯景色与画幅都由模型按描述判断。
> 范围：聊天加号面板「相册」按钮的二选一入口、生成弹窗、按角色配置的固定注入、生图内核注入规则、静默失败诊断。
> 不包含：独立相册 App 的生成 UI（本轮移除）、worker 改动、Spark 首图行为变更（只受益于通用画风注入）。
> 执行计划：`docs/superpowers/plans/2026-09-12-chat-image-studio-plan.md`。

## 1. 背景与现状

- 聊天加号面板的「相册」按钮（`components/chat/ChatInputArea.tsx:826-833`）现在直接开系统文件选择器：选图 → `handleImageSelect` → `handleSendText(base64,'image')` 以用户消息上屏、自动存相册、触发角色回应。
- 上一轮把「上传 / 生成」入口做进了独立相册 App（`apps/Gallery.tsx`），位置不对；本轮迁到聊天按钮，并撤掉相册 App 的入口。
- 生图链路已就绪：`generateImageBlobOnly`（唯一出口，质量词统一前置）→ `composeImagePrompt`（质量词/性别/主体/画风四层去重）→ latent.moe（er_sde / linear_quadratic / 12 步）。
- 现状盲区：模型写了 `[[GEN_IMAGE:]]` 但未执行（开关没开/缺 Key/无运行时）时**完全静默**，用户不知道图为什么没来（用户实操反馈「明确让它发自拍也没有图」就是撞在这里或模型没写标签）。

## 2. 目标

1. 聊天「相册」按钮点开是二选一：上传图片（原行为不变）/ 生成图片（只填一句描述）。
2. 生成结果当作「我发的图」：上屏 + 存相册 + 角色照常回应（与上传同一条路）。
3. 画风（画师 tag）与性别配置迁到神经链接角色页；画风 + 质量词对所有生图通用，性别只在画面里出现该角色时注入。
4. 画幅（尺寸）与「画面里有没有角色」由模型按描述判断，生成界面不再有画幅/画风/性别控件。
5. 静默失败可诊断：标签被拦时留 devDebug + console，本地路径每会话节流提示一次。

## 3. 方案

### 3.1 入口与弹窗

- `ChatInputArea.tsx`：相册按钮 → `onPanelAction('image-source')`；删除只服务它的 hidden input / `handleImageChange` / `chatImageInputRef`（已确认无第二处引用）。
- `apps/Chat.tsx` + `components/chat/ChatModals.tsx`：新增 `image-source` 弹窗，两态：
  - `menu`：上传图片（触发 Chat.tsx 的 hidden file input → `handleImageSelect`）/ 生成图片（切到 `generate`）；
  - `generate`：描述输入 + 分析中/生成中状态；确认后 `suggestImageTags` → `generateImageBlobOnly` → `handleSendText(token, 'image')`。
- `apps/Gallery.tsx`：移除「＋」及生成相关状态/弹窗/导入，恢复纯浏览。

### 3.2 模型决定画幅与角色

`suggestImageTags` 返回 `{ tags, resolution }`：

- system prompt 增加：按画面构图自选画幅（特写/竖构图 portrait、横向 landscape、方构图 square，默认 portrait）；**画面需要出现角色时才用 `@名字`**，纯景色禁止人物与 `@`；不写外貌、性别标记（1girl/1boy）、画风/画师 tag。
- 输出契约：优先 JSON `{"tags":"…","resolution":"portrait|landscape|square"}`；解析容错两级——剥代码块后取首个 `{…}` 解析；失败则按「一行 tag（可带 `| 画幅` 后缀）」解析；再失败抛人话错误（可直接 toast）。

### 3.3 固定注入（角色档案 → 生图内核）

- `CharacterProfile` 增加两个字段：
  - `imageGenStyleTags?: string`：画风/画师固定注入。**通用**：该角色所有生图（含纯景色、聊天自动配图、主动消息、Spark 首图）都注入。
  - `imageGenGender?: 'male' | 'female'`：**仅当 prompt 里出现该角色的 `@引用` 时**注入（替换外貌前判定，大小写不敏感），并把 prompt 里模型可能写错的 `1girl/1boy/male focus/female focus` 剔除。
- 注入点在唯一出口 `generateImageBlobOnly`：`composeImagePrompt(resolved, { qualityTags, styleTags: char.imageGenStyleTags, gender: mentionsChar ? char.imageGenGender : undefined })`。
- `GenImageRequest` 去掉请求级 `styleTags/gender`（档案是唯一来源）；`composeImagePrompt` 继续负责去重/防打架。
- 神经链接角色页「AI 生图 · 外貌提示词」卡片增加：性别三态（不注入 / 女 / 男）+ 画风 input，沿用 formData 自动保存。

### 3.4 静默失败诊断

`applyAssistantPostProcessing` Step 5b：

- 找到标签且执行 → devDebug 留一条 `[imageGen] 已触发`（charId / prompt / resolution / 是否 push 路径）；
- 找到标签但未执行 → console.warn + devDebug 记录原因（`no-runtime` / `disabled` / `no-key`）；
- 本地路径 `disabled` / `no-key` 每会话节流一次 `addToast`（提示去「设置 → AI 生图」），push 路径的 addToast 本来就是静默 log，不产生打扰。

## 4. 失败与边界

| 场景 | 行为 |
|---|---|
| 生成时开关关/缺 Key | 生成弹窗直接提示去设置；不静默 |
| 模型分析输出不是 JSON | 两级回退解析；仍失败 toast「模型没写出 tag」 |
| 描述是纯景色但模型写了 @ | 外貌/性别仍会注入（模型责任）；提示词已明确禁止，属可接受余量 |
| 多角色同框 | 画风/质量词照旧；性别只看「当前角色是否被 @」（其它角色不注入性别标记） |
| 生成失败 | toast 带 latent 的中文错误（额度/超时/Key 等） |
| 生成成功 | 用户图消息 + 自动存相册 + 角色正常回应（同上传路径） |

## 5. 测试与验收

- `imageGenSuggest.test.ts`：JSON 返回、`| 画幅` 回退、纯 tag 行默认 portrait、错误路径、系统提示包含「需要角色才用 @ / 不写性别标记」。
- `imageGenFlow.test.ts`：画风通用注入；性别仅在 `@角色` 出现时注入；纯景色（无 @）不注入性别但注入画风；质量词去重。
- `imageGenTags.test.ts`：`mentionsCharacterRef` 大小写不敏感；compose 既有用例保持。
- `tsc` 零新增错误、全量 `vitest run` 绿、`vite build` 过、含中文改动文件无 U+FFFD/BOM。
- 手测（本地 dev）：聊天加号「相册」→ 生成一张 → 我发的图上屏 + 进相册 + 角色回应；描述纯景色不出角色；描述角色套外貌与档案性别；神经链接改性别/画风即时生效；独立相册 App 无「＋」。

## 6. 会触碰的文件

生产代码：`components/chat/ChatInputArea.tsx`、`components/chat/ChatModals.tsx`、`apps/Chat.tsx`、`apps/Gallery.tsx`、`apps/Character.tsx`、`types.ts`、`utils/imageGenFlow.ts`、`utils/imageGenTags.ts`、`utils/applyAssistantPostProcessing.ts`。

测试：`utils/imageGenSuggest.test.ts`、`utils/imageGenFlow.test.ts`、`utils/imageGenTags.test.ts`。

文档：本文件、执行计划、`notes/ethernet-features.md`。
