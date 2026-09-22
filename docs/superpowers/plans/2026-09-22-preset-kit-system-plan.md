# 预设套组系统（Preset Kit）· 执行计划

> 对应设计：`docs/superpowers/specs/2026-09-22-preset-kit-system-design.md`。
> 日期 2026-09-22。弱执行者标准：每步自带文件路径 + 行号锚点 + 完整意图、
> 验收命令与预期输出、边界禁项。步骤按序执行，不回看对话历史。
>
> 全局门禁（每期收尾必跑）：
> - `corepack pnpm@9.15.9 vitest run <本次新增/触碰的测试文件>`
> - 全量：`corepack pnpm@9.15.9 vitest run`（基线见下；storageOptimize 4 项全量
>   并发抖动已知，单跑 `vitest run utils/storageOptimize.test.ts` 应 84/84）
> - `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`（动中文文件必跑）
> - tsc：本次触碰文件零新增（存量约 45，见 engineet ethernet-branch-context）。
>   命令：`corepack pnpm@9.15.9 exec tsc --noEmit` 后 grep 本次文件名。
> - U+FFFD 字节扫：`python3 -c` 扫本次触碰文件 `b'\xef\xbf\xbd'`，期望零命中，
>   只打印 ASCII 摘要（行号+前后长度，不打印中文）。
> - 禁：改业务代码前先确认本计划对应步骤已打勾；禁在 VPS 改文件；
>   commit 只在全部收尾后统一做（英文 message），中途不 commit。
> - 测试基线：开工先跑一次全量，记录总文件数/用例数/失败名单，
>   每期收尾对比（只允许已知抖动项波动）。

## 第 0 期 · 基线（先做，约 10 分钟）

- [ ] 跑全量 `corepack pnpm@9.15.9 vitest run`，把「X 文件 / Y 用例 / 失败名单」
>   记到本计划下方「基线记录」。
- [ ] `git status --short` 确认工作区干净（有 WIP 先记下文件名，不碰它们）。

基线记录（执行时填写）：467 文件 / 5956 用例 / 失败：无（2026-09-22 实测，全绿，137s）

## 第 1 期 · 数据模型 + 可控注入 + 迁移

### 1.1 types.ts 加字段（锚点 `types.ts:1014-1032`）

- [ ] `PromptPreset` 追加 7 个**全可选**字段：`identifier? role? injectionPosition?`
>   `injectionDepth? afterChatHistory? marker? tags?`（注释写清缺省语义，
>   照抄设计 §3.1；不许改既有 9 个字段、不许加必填）。
- [ ] `types.ts` 末尾（`FullBackupData` 附近，约 4421 行）新增
>   `PresetGeneration / PresetPack / PresetPackActive / PresetRegexRule / PresetRegexKit`
>   五个 interface（照抄设计 §3.2 全文），`FullBackupData` 加
>   `presetPacks?: PresetPack[]; presetRegexes?: PresetRegexKit[];`。
- 验收：`tsc` 本文件零新增。

### 1.2 db.ts v78 三个 store + 读写函数（锚点 `db.ts:41 / 229-236 / 372-378 / 4233-4268`）

- [ ] `DB_VERSION` 77→78（改 `db.ts:41` 行尾注释为 `v78: preset_packs + active + regexes`）。
- [ ] `onupgradeneeded` 内 `createStore(STORE_PROMPT_PRESETS…)`（约 378 行）下方加：
>   `createStore('preset_packs', { keyPath: 'id' })`、
>   `createStore('preset_pack_active', { keyPath: 'id' })`、
>   `createStore('preset_regexes', { keyPath: 'id' })`。
>   常量名 `STORE_PRESET_PACKS / STORE_PRESET_PACK_ACTIVE / STORE_PRESET_REGEXES`
>   加在 `STORE_PROMPT_PRESETS`（89 行）下方。
- [ ] `reconcilePromptPresets`（4281 行）之后、`};`（4340 行）之前加四个函数：
>   `getPresetPacks / savePresetPack / getActivePackId / setActivePackId /
>   getPresetRegexes / savePresetRegex`（getAll+sort 写法抄 `getPromptPresets`，
>   put/delete 抄 `savePromptPreset`；`getActivePackId` 读 id='active'，
>   缺行返回 `'default'`）。
- [ ] 新建 `utils/presetKits.test.ts`：fake-indexeddb（抄 `utils/db.test.ts` 头部
>   的 mock 写法）测 get/save/active 缺省四条。
- 验收：`vitest run utils/presetKits.test.ts` 绿。
- 禁：不动 `prompt_presets` 表、不动 reconcile 逻辑。

### 1.3 迁移函数（新建 `utils/presetKitsMigration.ts` + 测试）

- [ ] 实现 `migrateToDefaultPack(): Promise<{ created: boolean }>`，
>   逻辑逐行照设计 §5（幂等门 → 排序 → 补字段写回 → 建 default → 写 active）。
- [ ] 新建 `utils/presetKitsMigration.test.ts`：空表建空套组；有旧段落
>   （order 乱序+enabled 混搭）迁移后 entryIds 顺序正确、active=default；
>   跑两次第二次 `created=false`。
- 验收：`vitest run utils/presetKitsMigration.test.ts` 绿。
- 调用点：`context/OSContext.tsx:913-923` 播种处之后调一次
>   `migrateToDefaultPack()`（try/catch 包住，失败只 console.warn，不挡启动）。
>   先读该处 20 行确认调用形态再下手。

### 1.4 套组解析器（新建 `utils/presetKits.ts` + 测试）

- [ ] 实现 `resolveActivePackEntries(activeTags: string[]): Promise<PresetPreset[]>`
>   （返回拼好的**有序**条目）：
>   读 active pack → 按 entryIds 取 `prompt_presets` 行（缺失 id 跳过）→
>   过滤 `enabled` → 过滤 tags（空=全过；否则 `tags ⊆ activeTags`）→
>   补缺省（role='system'，position='relative'）→ 返回。
>   另导出 `splitPackEntries` 把结果分成 `{ stable, afterHistory, absolute }`
>   三组（afterChatHistory→afterHistory；absolute→absolute；其余→stable）。
- [ ] `utils/presetKitsResolve.test.ts`：tags 过滤（全场景/命中/未命中）、
>   entryIds 顺序保持、缺失 id 跳过、disabled 剔除。
- 验收：`vitest run utils/presetKitsResolve.test.ts` 绿。

### 1.5 depth 注入共享化（锚点 `utils/worldbook.ts:246-271`）

- [ ] 把 `injectWorldbookDepthEntries` 的 bucket 算法抽成
>   `injectDepthEntries<T>(messages, items: { depth, order, role, content }[])`，
>   同文件导出；原函数改调它（worldbook 行为零变化，`worldbook.test.ts` 全过是硬门）。
- [ ] `Absolute` 预设条目复用它（下一步用）。
- 验收：`vitest run utils/worldbook.test.ts` 全绿。

### 1.6 chatPrompts 接入套组（锚点 `chatPrompts.ts:394-411 / 172-187`）

- [ ] `PromptBuildOptions` 加 `activeTags?: string[]`（注释：缺省 `['chat']`）。
- [ ] 替换 394-411 块为三段路由（**forFirePack 时整段跳过，保持现状**）：
>   stable 组 → `【name】\ncontent` 拼进 baseSystemPrompt（与旧格式逐字一致）；
>   afterHistory 组 → 返回值新增字段带出（见下）；
>   absolute 组 → 暂存（payload 层插入，见 1.7）。
>   `buildSystemPromptParts` 返回类型加 `presetAfterHistory: string`（拼好的文本块）
>   与 `presetAbsolute: { role, content, depth }[]`。
>   旧 `【name】` 包裹格式保留（ equidistant 行为：无新字段的旧条目输出与旧版逐字一致，
>   用单测锁死）。
- [ ] `utils/chatPrompts.preset.test.ts`：旧条目输出与旧格式逐字一致；
>   afterChatHistory 条目进 presetAfterHistory；absolute 条目进 presetAbsolute；
>   tags 不命中被滤掉；forFirePack 时两字段为空。
- 验收：新测试绿 + 既有 chatPrompts 相关测试全绿。
- 禁：不动 volatileState/recency 逻辑；不动 steel（第 2 期才动）。

### 1.7 chatRequestPayload 落位（锚点 `chatRequestPayload.ts:406-417 / 536-549`）

- [ ] worldbook depth 注入（414-417）之后加一段：`presetAbsolute` 经
>   `injectDepthEntries` 插进 `messagesWithWorldbookDepth`
>   （role 保持条目 role，content 原样；depth 口径与世界书一致：距底条数）。
- [ ] `volatileTail += parts.recencyTail`（538 行）之前加：
>   `if (parts.presetAfterHistory) volatileTail += '\n\n' + parts.presetAfterHistory`
>   （钢印仍是最后，纪律不变）。
- [ ] 测试：`chatRequestPayload` 相关既有用例全绿；新用例 2 条
>   （absolute 落点 depth=0 在历史末尾；afterHistory 在 volatileTail 且在钢印前）。
>   若该文件暂无单测文件，先 grep 确认调用者的测试覆盖再补。
- 验收：触碰链路测试绿；forFirePack/timelyByWorker 快照行为不变（跑相关测试）。

### 1.8 备份链路（锚点 `OSContext.tsx:3990 / 5082`, `backupCoverage.ts:100`）

- [ ] 导出登记处加 `presetPacks: await DB.getPresetPacks()` +
>   `presetRegexes: await DB.getPresetRegexes()`；导入处 clear-and-add 写回三 store
>   （抄相邻 `promptPresets` 的写法，约 4185-4188 行是 db 侧导入实现——先读再抄）；
>   `backupCoverage.ts` 登记两行。
- [ ] 旧备份（无此二字段）导入 → 跑 `migrateToDefaultPack()` 兜底（幂等门保证安全）。
- 验收：备份相关测试绿（grep `backupCoverage|FullBackup` 找测试文件）。

### 1.9 第 1 期收尾门禁

- [ ] 全量 `vitest run` 对比基线（只允已知抖动）。
- [ ] tsc 触碰文件零新增；mojibake 绿；U+FFFD 扫零。
- [ ] PresetApp 旧 UI 不动——行为验证：旧自定义段落仍按原顺序注入
>   （跑 1.6 的逐字一致单测即证明）。

## 第 2 期 · 宏 + 套组 UI + 预览 + 导入导出

### 2.1 宏引擎（新建 `utils/promptMacros.ts` + `utils/promptMacros.test.ts`）

- [ ] `expandPromptMacros(content, ctx: { charName, userName, persona?, lastUser?, lastAssistant?, now?: Date })`：
>   替换 `{{char}} {{user}} {{persona}} {{lastUser}} {{lastAssistant}} {{time}} {{date}}`
>   （`{{x}}` 允许内部空格，大小写不敏感；未知宏原样保留）。
>   `{{time}}`=`HH:MM`、`{{date}}`=`YYYY-MM-DD`（用 `now ?? new Date()`，测试可注入）。
- [ ] 接入点（三处，只加展开调用，不改逻辑）：
>   ① 1.6 的 stable/afterHistory 拼接处展开条目 content；
>   ② `makeSteelBlocks`（chatPrompts.ts:220）的 `fill` 改调宏展开
>   （`fillIdentity` 保留做回退，口径：charName 为空时 `{{char}}` 不替换）；
>   ③ `expandWorldbookMacros`（worldbook.ts:191）内部复用同一正则口径
>   （只统一 `{{char}}/{{user}}` 行为，不扩宏集合）。
- [ ] 测试 8+ 条：全宏替换、未知宏保留、大小写/空格容错、空 charName 不吞字、
>   lastUser 取尾部最后一条 user。
- 验收：新测试绿 + steel/worldbook 既有测试绿。

### 2.2 PresetApp 双页重构（锚点 `apps/PresetApp.tsx` 全文件 406 行）

- [ ] 保持现有浅玻璃 slate 卡片语言（`bg-white/70 border-white/60`、violet 点缀、
>   Phosphor 图标、active:scale），不引入新视觉语言。
- [ ] 顶层 tab：`套组 | 条目 | 正则(第4期占位 disabled) | 预览`。
>   套组页：列表（默认预设置顶标「默认」）、新建/重命名/删除（默认预设不可删）、
>   切换（写 active）、导出（下载 json）、导入（文件选择+校验，错格式 toast）。
>   条目页（当前 active 套组）：沿用现有卡片，加三控件——tags 多选下拉
>   （固定 6 个词，见设计 §4.3）、role 下拉、位置下拉
>   （relative / relative-history后 / absolute+depth 数字框 + marker:chatHistory 分界条目型）。
>   上下移改写 `entryIds`（单条 put pack，不再 O(n) 全表写；条目本身只在编辑正文时 put）。
- [ ] 预览页：调 `composePromptPreview`，传当前角色（用第一个角色或记忆上次选的
>   charId，localStorage 键 `preset_preview_char`）；composer 内预设块来源换成
>   `resolveActivePackEntries(['chat'])`（改 `promptPreviewComposer.ts` 约 184-200 行，
>   先读确认）；token 估算沿用既有 `estTokens`。
- 验收：手测清单（切换/新建/导入导出 round-trip/预览块数>0）+ mojibake 绿。
- 禁：不动内置技术模板的 resolve 逻辑；默认预设删除按钮不渲染。

### 2.3 导入导出（新建 `utils/presetKitShare.ts` + 测试）

- [ ] `exportPresetKit(pack, entries, regexKit?) → json string`；
>   `importPresetKit(json) → { pack, entries }`（校验照设计 §3.4；
>   entryIds 失配引用丢弃；重名 pack 后缀「(1)」；id 冲突重新 randomUUID 并重写 entryIds）。
- [ ] `presetKitShare.test.ts`：导出→导入 round-trip 相等；坏 schema 抛错；
>   失配引用丢弃；重名后缀。
- 验收：测试绿。分享文件名 `sully-preset-<name>-<日期>.json`（ASCII 名，防 Win 中文文件名坑）。

### 2.4 第 2 期收尾门禁（同 1.9，另加 `vite build` 通过）

## 第 3 期 · 采样参数跟套组

### 3.1 useChatAI 读 generation（锚点 `hooks/useChatAI.ts:1061-1069 / 1100-1106`）

- [ ] `baseReqBody` 组装前读 activePack.generation（try/catch，失败回退全缺省）：
>   temperature/top_p/top_k/frequency_penalty/presence_penalty/max_tokens 逐项覆盖；
>   `omitSamplingParams=true` → 只保留 temperature+max_tokens（删其余四项）。
>   思考链删除逻辑（1104-1105）保持在后执行（纪律不变）。
- [ ] 套组条目编辑 UI 加 generation 折叠区（5 数字框 + omit 开关；空=不覆盖，
>   placeholder 写「空=跟 API 设置」）。
- [ ] 测试：新建 `hooks/useChatAI.generation.test.ts`？先 grep 看该 hooks 有无既有
>   测试架子；无则把覆盖逻辑抽成 `utils/presetGeneration.ts` 纯函数
>   `applyGenerationOverride(base, gen)` + 单测（覆盖/缺项回退/omit/思考链后删）。
>   —— 推荐后者，不碰 hooks 测试地狱。
- 验收：新单测绿；`samplingParamCompat` 相关测试绿。
- 禁：不动 API 预设（ApiPreset）逻辑；不动 max_tokens 以外的写死值。

### 3.2 第 3 期收尾门禁（同 1.9）

## 第 4 期 · 正则脚本

### 4.1 执行器（新建 `utils/presetRegex.ts` + `utils/presetRegex.test.ts`）

- [ ] `runRegexRule(rule, text): string`（new RegExp try/catch，非法整条跳过+warn；
>   `$1` 等分组替换原生支持；replaceString 跑宏展开（复用 2.1，`{{char}}` 等））。
- [ ] `applyRegexPlacement(text, kit, placement, ctx: { depth }): string`
>   按 placement 分发 + enabled + tags（activeTags 透传）+ min/maxDepth 门。
- [ ] 测试 10+ 条：分组替换、非法正则跳过、disabled 跳过、placement 分流、
>   depth 门、宏展开。

### 4.2 接入点（两处）

- [ ] 输出侧：`applyAssistantPostProcessing.ts` Step 1（751-752 行）后加
>   placement=2（`normalizeAiContent` 之后、`consumeScheduleChanges` 之前）；
>   placement=4 在 `renderAndPersist` 落库前分支（落库原文、显示替换版——先读
>   800-900 行确认 persistMessage 调用点再下手，只做最小改）。
>   正则 kit 读取失败 → 整段跳过（try/catch，不挡主链路）。
- [ ] 输入/prompt 侧：chatPrompts 的 stable 拼接处 placement=5（只改发给模型的
>   文本，不写回 DB）；用户输入发送前（useChatAI send 入口）placement=1。
>   —— 先 grep `sendMessage` 入口确认单点后再改，只改一处。
- 验收：接入点相关既有测试绿；新行为单测 4 条。

### 4.3 PresetApp 正则页 + 测试器

- [ ] 正则 tab 启用：kit 列表（默认建一个空 kit「默认正则」随套组？——不，
>   独立 active：`preset_regex_active` 复用 pack_active 模式，单例 id='active'；
>   db.ts 1.2 的 active store 通用化，key 区分）。
>   规则卡：名/find/replace/placement 多选/depth 范围/启停/删除；
>   测试器：样文框→输出框（调 `applyRegexPlacement`，纯本地）。
- 验收：手测 + mojibake 绿。

### 4.4 第 4 期收尾门禁（同 1.9，另加 `vite build` 通过）

## 收尾

- [ ] 全量 `vitest run` vs 基线；tsc 触碰零新增；mojibake 绿；U+FFFD 扫零。
- [ ] `notes/ethernet-features.md` 补记（功能账本：预设套组四件套+数据源说明）。
>   先读该文件确认格式再写。
- [ ] `utils/buildInfo.ts` 的 `APP_VERSION` 升版（做完大功能改一下；括号代号自拟，
>   构建 hash 不管）。
- [ ] `git diff --stat` 逐 hunk 确认归属后统一提交（英文 message，
>   身份 plasma953；CRLF 噪音文件不加）。
- [ ] 本计划基线记录回填实际数字。
