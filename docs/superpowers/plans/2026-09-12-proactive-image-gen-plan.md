# 执行计划：主动消息发图 + 生图提示词迁入神经链接（2026-09-12）

> 设计见 `docs/superpowers/specs/2026-09-12-proactive-image-gen-design.md`。本文件按序执行，每步自带文件、定位、代码意图与验收。
> 弱执行者注意：定位行号是改动前的编号，做完一步行号会漂移，按「符号名 + 上下文」找位置，不要死认行号。
> 禁止：改 `FIRE_PACK_VERSION`；把 latent key 上云；给「纯图无文字」开特例；跑任何改状态的 git 命令。

## 步骤清单

- [x] 1. worker classifier：`gen_image` directive + 测试
- [x] 2. 客户端 directive 重放 + 测试
- [x] 3. activeMsgRuntime 注入 imageGen 运行时 + 测试
- [x] 4. 主动消息模板加配图引导
- [x] 5. visionApi 支持自定义 prompt
- [x] 6. imageGenFlow 两个外貌提取入口 + 测试
- [x] 7. 角色页（神经链接）生图提示词卡片
- [x] 8. 设置页移除逐角色档案 + 文案
- [x] 9. 版本号 bump + 重建 worker bundle
- [x] 10. 全量测试 + 编码自查

## 执行记录（2026-09-12）

- 全量 `corepack pnpm vitest run`：431 个文件 / 5143 用例全绿（含新增的 classifier 5 例、directive 重放 2 例、收件箱生图 1 例、visionApi 透传 1 例、提取入口 3 例）。
- `corepack pnpm build:workers` 通过；`corepack pnpm exec vite build` 通过。
  （本机 pnpm 不在系统 PATH，`pnpm build` 内嵌的 `pnpm run build:workers` 会失败，
  所以拆成上面两条执行；用户机器上 `pnpm build` 正常则无需拆。）
- `tsc --noEmit` 对本轮改动文件零新增报错（仓库基线存在其它历史报错）。
- 含中文改动文件字节级扫描：无 U+FFFD、无 BOM。
- 变更产物：`worker/amsg/worker.bundle.js`、`worker/instant-push/worker.bundle.js`、
  `worker/instant-push/worker.deno.bundle.js`、`public/instant-worker.deno.bundle.js`、
  `public/instant-worker.version.txt`、`public/amsg-worker.bundle.js`（未跟踪）。
- 部署：**已完成**（2026-09-12，opencode 会话用存档里的用户 token 走 CF API）。
  `sullyos-amsg` 与 `instant-push` 都已上传新 bundle 并恢复 compatibility / observability，
  `GET /config-check` / `/version` 均报 `2026-09-12`。详情见
  `plans/2026-09-11-cf-workers-redeploy.md` 的第二轮执行记录。
- 剩余：前端（Vercel/静态站）需照常部署一次，客户端侧改动（角色页外貌提示词卡片、
  收件箱生图接线）才会随之下发。


---

## 步骤 1：worker classifier

**文件**：`worker/instant-push/src/classifier.ts`

1. 顶部 import 增加（与 `sanitize` import 同区）：
   ```ts
   import { extractGenImageTags, stripGenImageTags, type ImageGenResolution } from '../../../utils/imageGenTags';
   ```
2. `Directive` union（当前 :48-78）末尾加：
   ```ts
   // AI 生图 [[GEN_IMAGE: tag | 画幅]]：worker 只摘成请求（不执行），客户端收到后
   // 走本地 imageGenFlow 生图（开关/Key 由客户端把关，云端不碰 latent key）。
   | { type: 'gen_image'; prompt: string; resolution: ImageGenResolution }
   ```
3. `classifyLLMOutput` 里，`const scheduleParsed = extractScheduleChangeDirectives(textAfterTransfers);` 之后、`for (const spec of SIDE_EFFECT_TAGS)` 之前插入：
   ```ts
   // 2.1 AI 生图标签：跟转账/日程同理走 directive 通道。留在正文里的话，
   // sanitizeIntoSegments 会把「剥光 [[...]] 后为空」的独占行整段丢掉，
   // 客户端永远收不到生图请求。
   const genImageReqs = extractGenImageTags(textAfterSchedule);
   const textAfterGenImage = stripGenImageTags(textAfterSchedule);
   for (const req of genImageReqs) {
     directives.push({ type: 'gen_image', prompt: req.prompt, resolution: req.resolution });
   }
   ```
4. 把后续两处 `textAfterSchedule` 换成 `textAfterGenImage`：
   - `for (const spec of SIDE_EFFECT_TAGS) { const matches = Array.from(textAfterSchedule.matchAll(spec.re)); ... }`
   - `let cleanedText = textAfterSchedule;`

**测试**：`worker/instant-push/src/classifier.test.ts` 新增 describe 或若干 it：
- `classifyLLMOutput('看这个\n[[GEN_IMAGE: 1girl, cat ears | landscape]]\n好看吧')` → kind finish；directives 含 `{type:'gen_image', prompt:'1girl, cat ears', resolution:'landscape'}`；cleanedText 不含 `GEN_IMAGE`，含「看这个」「好看吧」。
- 行内形态 `'给你看[[GEN_IMAGE: 1girl, silver hair]]'` → resolution 默认 `portrait`，cleanedText 为 `'给你看'`。
- 中文画幅别名 `| 方` → `square`（复用 extractGenImageTags 行为，不重复实现）。

**验收**：`pnpm vitest run worker/instant-push/src/classifier.test.ts` 全绿。

## 步骤 2：客户端 directive 重放

**文件**：`utils/applyAssistantPostProcessing.ts`

1. `PostProcessDirective` union（当前 :264-288）末尾加：
   ```ts
   // AI 生图：worker 把 [[GEN_IMAGE:]] 摘成结构化请求传回来。这里拼回原 tag
   // 让 Step 5b 用与本地生成完全同一份执行路径（开关/Key 门都在那边）。
   | { type: 'gen_image'; prompt: string; resolution: 'square' | 'portrait' | 'landscape' }
   ```
2. `reconstructDirectiveTags`（当前 :299-375）在 `feishu_write_diary` case 后加：
   ```ts
   case 'gen_image':
       parts.push(`[[GEN_IMAGE: ${d.prompt} | ${d.resolution}]]`);
       break;
   ```

**测试**：`utils/applyAssistantPostProcessing.imageGen.test.ts`
- `makeCtx` 增加可选第三参 `directives`，塞进返回对象的 `directives` 字段。
- 新增 it「directive 重放（push 路径）：worker 传来的 gen_image 也执行」：`applyAssistantPostProcessing('给你看看\n', makeCtx(charId, RUNTIME(true), [{ type:'gen_image', prompt:'1girl, cat', resolution:'portrait' }]))`；断言 `mockedRun` 调用一次、参数 `{prompt:'1girl, cat', resolution:'portrait'}`；落库文本不含 `GEN_IMAGE`、含「给你看看」。
- 新增 it「directive + 开关关 → 不执行」：同 ctx 但 `RUNTIME(false)`，`mockedRun` 不被调。
- 把原「没传运行时（群聊/push 路径）」的用例注释改成「没传运行时（群聊）」——push 路径现在会传运行时。

**验收**：`pnpm vitest run utils/applyAssistantPostProcessing.imageGen.test.ts` 全绿。

## 步骤 3：activeMsgRuntime 注入运行时

**文件**：`utils/activeMsgRuntime.ts`

在 `applyAssistantPostProcessing(message.body || '', { ... })`（当前 :672）的 ctx 里、`skipSecondPassLLM: true` 之前（或任意与 `directives` 相邻处）加：

```ts
// AI 生图运行时：与本地聊天路径同一份执行器。开关/Key 的门在 Step 5b
// （imageGenEnabled !== true 时只剥离不执行，不会悄悄烧额度）。
// characters 用本函数开头已读好的全量列表（档案提取可能命中 @ 到的别角色）；
// saveCharProfile 走读改写落库（React 的 updateCharacter 在这里够不着）。
imageGen: {
  apiConfig,
  characters,
  saveCharProfile: (charId, profile) => {
    const target = characters.find(c => c.id === charId);
    if (!target) return;
    void DB.saveCharacter({ ...target, imageGenProfile: profile });
  },
},
```

前置确认：`characters` 变量在该函数（`processInboxMessageWithPostProcessing`，当前 :549）已加载；`apiConfig` 在同一作用域（当前 :576）；`DB` 已 import；`CharacterProfile.imageGenProfile` 字段存在（`types.ts:3376` 附近）。

**测试**：`utils/activeMsgRuntime.test.ts`
1. 文件顶部加 `vi.mock('./imageGenFlow', () => ({ runImageGenReply: vi.fn(async () => {}) }));` 与 `import { runImageGenReply } from './imageGenFlow';`。
2. 在即时对话相关 describe 内仿现有 `inboxMsg` 用法加一个 it：
   - localStorage 写 `os_api_config`：`{ baseUrl:'http://localhost:0', apiKey:'k', model:'m', latentImageKey:'lat_sk_x', imageGenEnabled: true }`（用完后按该文件既有清理方式还原）。
   - `DB.saveCharacter({ id: 'char-img-push', name: '发图角色' })`。
   - 写 inbox：`body: '给你看看\n'`、`messageType:'text'`、`messageIndex: 1, totalMessages: 1`、`metadata: { directives: [{ type:'gen_image', prompt:'1girl, cat', resolution:'portrait' }] }`。
   - `await flushInboxToChat()`；断言 `vi.mocked(runImageGenReply)` 被调一次且第一参含 `prompt:'1girl, cat'`。
   - 若该测试文件的 DB/localStorage 清理结构不适合 mock，可退化为源码级 wiring 断言（沿用 `utils/amsg2ChatLoop.wiring.test.ts` 的 readFileSync 风格）：断言 `applyAssistantPostProcessing` 调用参数里出现 `imageGen:` 与 `saveCharProfile`。

**验收**：`pnpm vitest run utils/activeMsgRuntime.test.ts` 全绿。

## 步骤 4：主动消息模板配图引导

**文件**：`utils/activeMsgClient.ts`，`buildFirePack` 的 template 数组（当前 :737-760 一带）。

在「角色设定里描述的查记忆、读日记、联网搜索、逛小红书等能力照常可用」那一行（当前 :747）后面加一行：

```ts
'- 值得给 ta 看画面的瞬间（你眼前的东西、你现在的样子、正好想分享的风景），可以附一张图：单独一行写 [[GEN_IMAGE: 英文tag | portrait]]，系统会真的把图发给他。不用每次都配，也别为了发图硬找话题。',
```

不改其它文案；不加 `@名字` 说明（系统设定里已有）。

**验收**：`pnpm vitest run utils/activeMsgClient.test.ts` 全绿（若无该文件则跑全量时确认无回归）。

## 步骤 5：visionApi 自定义 prompt

**文件**：`utils/visionApi.ts`

1. `describeImageWithVisionApi` 签名改为：

```ts
export interface VisionDescribeOptions {
  /** 覆盖默认的通用描述 prompt（默认 VISION_PROMPT）。 */
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function describeImageWithVisionApi(
  imageUrl: string,
  config: VisionApiConfig,
  options?: VisionDescribeOptions,
): Promise<string> {
```

2. body 里：
   - `{ type: 'text', text: options?.prompt || VISION_PROMPT }`
   - `temperature: options?.temperature ?? 0`
   - `max_tokens: options?.maxTokens ?? 1200`

其余（缓存、错误、cleanDescription）不动。

**测试**：`utils/visionApi.test.ts` 新增用例：stub fetch 捕获请求体，调用 `describeImageWithVisionApi(image, config, { prompt: '自定义', maxTokens: 300, temperature: 0.2 })`，断言 body.messages[0].content[0].text === '自定义'、max_tokens 300、temperature 0.2。

**验收**：`pnpm vitest run utils/visionApi.test.ts` 全绿。

## 步骤 6：imageGenFlow 两个外貌提取入口

**文件**：`utils/imageGenFlow.ts`

1. import 追加：`import { describeImageWithVisionApi, isVisionApiReady, type VisionDescribeOptions } from './visionApi';`（`VisionDescribeOptions` 若未用到可不引）。
2. 在 `PROFILE_EXTRACT_SYS` 附近加：

```ts
/** 参考图解析的 system prompt：只要固定外貌特征，不要动作/场景/画风。 */
const PROFILE_FROM_IMAGE_SYS = `你是角色外貌标签师。看这张参考图，提取画面人物固定可复用的外貌特征，输出一行英文 danbooru 风格 tag，逗号分隔，8-20 个 tag。
只写长相：发色、瞳色、发型、耳朵/尾巴等兽耳特征、体型、常穿的标志性服装。不要写动作、场景、光线、情绪、画风词。
直接输出 tag 串本身，不要解释、不要引号、不要 Markdown。`;

/**
 * 从角色设定提取外貌 tag（角色页「从角色设定提取」按钮）。
 * 与首次生图自动提取同一份实现，但**不吃**模块级失败缓存——手动点按钮要能重试。
 * 失败抛 Error，message 可直接 toast。
 */
export async function extractAppearanceFromPersona(
  char: CharacterProfile,
  apiConfig: APIConfig,
  fetchImpl?: LatentFetch,
): Promise<string> {
  const tags = await extractAppearanceViaLLM(char, apiConfig, fetchImpl);
  if (!tags) throw new Error('没能从人设里提取出外貌 tag：检查 API 配置，或先把人设写具体一点');
  return tags;
}

/**
 * 从用户上传的参考图解析外貌 tag（角色页「上传图片解析」按钮）。
 * 路由与聊天识图一致：visionApi 开着就用它（配置不全时抛它自己的提示），
 * 否则回落主 API——主模型不支持看图时会以人话错误收场。
 */
export async function extractAppearanceFromReferenceImage(
  imageDataUrl: string,
  apiConfig: APIConfig,
): Promise<string> {
  const vision = apiConfig.visionApi?.enabled
    ? apiConfig.visionApi
    : { enabled: true, baseUrl: apiConfig.baseUrl || '', apiKey: apiConfig.apiKey || '', model: apiConfig.model || '' };
  const text = await describeImageWithVisionApi(imageDataUrl, vision, {
    prompt: PROFILE_FROM_IMAGE_SYS,
    maxTokens: 300,
    temperature: 0.2,
  });
  const tags = cleanTagLine(text);
  if (!tags) throw new Error('模型没解析出外貌 tag，换一张人物更清楚的图再试');
  return tags;
}
```

**测试**：`utils/imageGenFlow.test.ts` 新增 describe：
- `extractAppearanceFromPersona`：注入 `fetchImpl` 返回 tag → 得到清洗后的单行；返回空内容 → rejects 带「人设」字样。
- `extractAppearanceFromReferenceImage`：stub fetch 捕获 URL；`apiConfig.visionApi = {enabled:true, baseUrl:'https://v.test/v1', apiKey:'vk', model:'vm'}` → 请求打到 `https://v.test/v1/chat/completions`；不带 visionApi → 请求打到主 API baseUrl；返回带引号/换行的 tag 会被 `cleanTagLine` 清成单行。

**验收**：`pnpm vitest run utils/imageGenFlow.test.ts` 全绿。

## 步骤 7：角色页（神经链接）生图提示词卡片

**文件**：`apps/Character.tsx`

1. import 追加：`import { extractAppearanceFromPersona, extractAppearanceFromReferenceImage } from '../utils/imageGenFlow';`（`processImage` 已在 :6 import）。
2. 组件状态区（`formData` 声明附近，当前 :138）加：
   ```ts
   const [isImageProfileBusy, setIsImageProfileBusy] = useState(false);
   ```
3. `handleChange`（当前 :387）下方加两个 handler：

```ts
// 神经链接 · 生图外貌提示词：从人设或参考图一键生成 tag，写回 formData 由自动保存链路落库。
const handleExtractImageProfileFromPersona = async () => {
    if (!formData || isImageProfileBusy) return;
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
        addToast('请先在设置里配置主 API（baseUrl / Key / 模型）', 'error');
        return;
    }
    setIsImageProfileBusy(true);
    try {
        const tags = await extractAppearanceFromPersona(formData, apiConfig);
        handleChange('imageGenProfile', tags);
        addToast('已从角色设定提取外貌提示词', 'success');
    } catch (e: any) {
        addToast(e?.message || '提取失败，稍后再试', 'error');
    } finally {
        setIsImageProfileBusy(false);
    }
};

const handleParseImageProfile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !formData || isImageProfileBusy) return;
    setIsImageProfileBusy(true);
    try {
        const dataUrl = await processImage(file, { maxWidth: 1024, forceJpeg: true, quality: 0.85 });
        const tags = await extractAppearanceFromReferenceImage(dataUrl, apiConfig);
        handleChange('imageGenProfile', tags);
        addToast('已按参考图解析出外貌提示词', 'success');
    } catch (err: any) {
        addToast(err?.message || '图片解析失败，稍后再试', 'error');
    } finally {
        setIsImageProfileBusy(false);
    }
};
```

4. 在音色卡片结束后、Worldbook 区块之前（当前 :2030 的 `</div>` 与 :2032 的 `{/* Worldbook Section */}` 之间）插入：

```tsx
{/* AI 生图 · 外貌提示词（防串脸）：生图时 @名字 会替换成这串 tag。
    全局开关与 Latent Key 在「设置 → AI 生图」；这里只管角色自己长什么样。 */}
<div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-3">
    <div>
        <label className="text-[10px] font-bold text-fuchsia-600 uppercase tracking-widest block">AI 生图 · 外貌提示词</label>
        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">聊天和主动消息里生图时，@名字 会换成这串 tag，保证每张图长一个样。可以从角色设定自动提取，或上传一张参考图让模型解析；也能手填。开关与 Key 在「设置 → AI 生图」。</p>
    </div>
    <textarea
        value={(formData as any).imageGenProfile || ''}
        onChange={(e) => handleChange('imageGenProfile', e.target.value)}
        spellCheck={false}
        className="w-full h-16 bg-slate-50 rounded-2xl px-3 py-2 text-xs font-mono border border-slate-200 outline-none focus:ring-1 focus:ring-fuchsia-300 resize-none"
        placeholder="cat girl, silver hair, green eyes（英文 tag，逗号分隔）"
    />
    <div className="flex gap-2">
        <button
            type="button"
            disabled={isImageProfileBusy}
            onClick={() => void handleExtractImageProfileFromPersona()}
            className="flex-1 py-2 rounded-2xl text-[11px] font-bold bg-fuchsia-50 text-fuchsia-600 border border-fuchsia-200/60 disabled:opacity-50 active:scale-95 transition-all"
        >
            {isImageProfileBusy ? '处理中…' : '从角色设定提取'}
        </button>
        <label className={`flex-1 py-2 rounded-2xl text-[11px] font-bold text-center border border-fuchsia-200/60 ${isImageProfileBusy ? 'bg-slate-50 text-slate-300' : 'bg-fuchsia-500 text-white border-fuchsia-500 active:scale-95 cursor-pointer'} transition-all`}>
            上传图片解析
            <input type="file" accept="image/*" hidden disabled={isImageProfileBusy} onChange={(e) => void handleParseImageProfile(e)} />
        </label>
    </div>
</div>
```

注：`imageGenProfile` 已在 `CharacterProfile` 类型里（`types.ts`），不强制 `(formData as any)`；按 TS 报错情况去掉断言。样式沿用同页卡片的圆角/描边档位。

**验收**：`pnpm tsc --noEmit`（或项目既有类型检查命令）无新报错；`pnpm build` 能过（可放在步骤 10）。

## 步骤 8：设置页移除逐角色档案

**文件**：`apps/Settings.tsx`

1. 删除状态 `profileDrafts`（当前 :660-661 两行注释+声明）。
2. `handleSaveImageGen`（当前 :1299-1312）改成只保存 apiConfig：
   ```ts
   // AI 生图板块独立保存：key + 总开关进 apiConfig。角色外貌提示词已迁到
   // 神经链接（角色 App → 设定），那里改完即时落库，不再从这里批量写回。
   const handleSaveImageGen = () => {
     updateApiConfig({ latentImageKey: localLatentKey, imageGenEnabled: localImageGenEnabled });
     setImageGenStatusMsg('已保存');
     setTimeout(() => setImageGenStatusMsg(''), 2000);
   };
   ```
3. 删除「角色外貌档案（防串脸）」整块（当前 :3385-3406，含 label/p/列表/空态）。
4. 板块说明文案（当前 :3336）改为：
   ```
   聊天和主动消息里，角色会在关键场面自动配图（回复里写 [[GEN_IMAGE:]] 标签触发）。图片走 latent.moe 生图、自动存进相册。每个角色的外貌提示词在「神经链接 → 角色 → 设定」里维护。
   ```

**验收**：`pnpm tsc --noEmit` 无新报错；全局 grep 确认 `profileDrafts` 无残留引用。

## 步骤 9：版本号与 bundle

1. `utils/amsgBundleVersion.ts`：`AMSG_BUNDLE_VERSION = '2026-09-12'`。
2. `utils/instantWorkerVersion.ts`：`INSTANT_WORKER_VERSION = '2026-09-12'`。
3. `pnpm build:workers`，确认产物更新：`worker/amsg/worker.bundle.js`、`public/amsg-worker.bundle.js`、`worker/instant-push/worker.bundle.js`、`public/instant-worker.bundle.js`、`worker/instant-push/worker.deno.bundle.js`、`public/instant-worker.deno.bundle.js`、`public/instant-worker.version.txt`。
4. 二改仓库不提交，产物留在工作区由用户自行部署；提醒用户：主动消息要生效需在「设置 → 主动消息 2.0」重新部署 Worker。

**验收**：构建脚本输出各 bundle 大小，无报错；`git status` 能看到上述产物变更。

## 步骤 10：全量验证

1. `pnpm vitest run` 全绿（重点盯 classifier / applyAssistantPostProcessing.imageGen / activeMsgRuntime / visionApi / imageGenFlow 五个文件）。
2. `pnpm build` 通过。
3. 含中文的改动文件做 U+FFFD 自查（扫 `EF BF BD` 字节序列），确认零命中。
4. 收尾：删除本次临时产物（无）；文档与代码一起留在工作区等待用户 review。

## 边界与禁止事项

- 不把 latent key 写进任何上云 payload / fire_pack / task metadata。
- 不改 `FIRE_PACK_VERSION`（7 保持）。
- 不动 `utils/sanitize.ts` 的段级判空规则（directive 通道已绕开它）。
- 不改聊天主路径 `hooks/useChatAI.ts`（本地路径行为不变）。
- 不引入新依赖；不用 `npm` / `yarn`。
- 测试 fixture 用户名用「小明」等虚构名。
