# 预设套组系统（Preset Kit）· 设计

> 日期 2026-09-22。目标：把 Preset App 从「固定位置的片段合集」升级为
> SillyTavern 风格的「套组制预设」——多套切换、条目级注入控制（role /
> 相对位置 / 绝对深度 / marker）、tags 场景过滤、宏、采样参数随套组、
> 输出正则脚本、可导入导出分享。
>
> 参考实现：xiaolongbao0709/ai-virtual-phone 的 `lib/llm-prompt-assembler.ts`
>（PresetConfig + Prompt + prompt_order + MacroEngine + RegexRule + tags）。
> ethernet 只借鉴机制，不兼容其文件格式（用户已拍板）。

## 1. 现状与差距（2026-09-22 实测）

| 能力 | 参考仓库 | SullyOS 现状 |
|---|---|---|
| 条目 role（system/user/assistant） | 有 | 无，全是 system 文本 |
| 注入位置 | relative 排序 + absolute depth + chatHistory 分界 | 全挤在 stable 固定点（`utils/chatPrompts.ts:394-411`） |
| marker 槽位 | charDescription / worldInfoBefore-After / personaDescription / chatHistory | 无；角色卡/世界书注入点硬编码 |
| 宏 `{{char}}` 等 | MacroEngine 几十个宏 | 仅钢印 `fillIdentity` + 世界书 `expandWorldbookMacros`（`utils/worldbook.ts:191`） |
| 输出正则 | RegexRule 四作用域 | 无，全硬编码 |
| 采样参数随预设 | PresetConfig 自带 | temp 在 APIConfig，max_tokens 写死 8000（`hooks/useChatAI.ts:1067`） |
| 多套切换/分享 | 有 | 单表全局，无导入导出 |
| 按场景过滤 | tags（appTags） | 无；`category` 只做展示分类 |

## 2. 设计决策（已拍板，不再讨论）

1. 四期全做，可独立验收、可停。
2. 旧 `prompt_presets` 自定义段落（无 sourceKey）一次性迁入「默认预设」套组，
   保持原有相对顺序与 enabled，行为等价后才可编辑新能力。
3. 作用域=全局套组 + tags 场景过滤；**不做按角色隔离**（角色差异继续由
   世界书/角色卡承担，与参考仓库一致）。
4. 内置 20 条技术模板（memory.*/amsg.*/voice.*）**不动**——它们是功能内部模板，
   不走 prompt 主管道；仅 `chat.steelExpression` / `chat.steelYourself` 两条钢印
   纳入套组（等价 recency marker）。
5. 分享格式只定义自有格式 `sullyos.preset-kit`，不做 ST/参考仓库格式兼容。
6. `forFirePack` 路径维持现状（不带套组），列为后续小项，不在本设计解决。
7. 零额外 LLM 调用（计费红线）：宏/正则/预览全是本地计算。

## 3. 数据模型

### 3.1 PromptPreset 扩展（`types.ts:1014-1032`，只加可选字段）

```ts
export interface PromptPreset {
    /* …既有 9 个字段原样保留… */
    /** ST 风格标识（套组内唯一）；缺省=自动生成 `custom_<id前8>` */
    identifier?: string;
    /** 注入 role；缺省 'system' */
    role?: 'system' | 'user' | 'assistant';
    /** 'relative' = 跟随套组顺序；'absolute' = 按 injectionDepth 插进历史 */
    injectionPosition?: 'relative' | 'absolute';
    /** absolute 时距聊天底部的条数（参考世界书 depth 口径）；缺省 0 */
    injectionDepth?: number;
    /** relative 条目在套组内 chatHistory 分界之后 → 注入历史之后 */
    afterChatHistory?: boolean;
    /** marker 槽位（本条目是占位符而非正文时设） */
    marker?: 'chatHistory';
    /** 空/tags 缺省 = 全场景；否则要求 tags ⊆ 调用方 activeTags */
    tags?: string[];
}
```

### 3.2 PresetPack / Generation / Regex（`types.ts` 新增）

```ts
export interface PresetGeneration {
    temperature?: number; topP?: number; topK?: number;
    frequencyPenalty?: number; presencePenalty?: number;
    maxTokens?: number;
    /** 兼容酒馆高级参数报错的接口：true=只发 temperature+maxTokens */
    omitSamplingParams?: boolean;
}
export interface PresetPack {
    id: string;                      // 'default' = 「默认预设」
    name: string;
    /** 条目 id 数组，顺序=相对排序，是 prompt_order 的载体 */
    entryIds: string[];
    generation?: PresetGeneration;
    createdAt: number; updatedAt: number;
}
export interface PresetPackActive { id: 'active'; packId: string; }
export interface PresetRegexRule {
    id: string; scriptName: string;
    findRegex: string; replaceString: string;
    /** 1=输入 2=AI输出 4=仅显示 5=仅发给模型；缺省 [2] */
    placement: number[];
    disabled: boolean;
    displayOnly?: boolean;  // 只改显示，不改落库
    promptOnly?: boolean;   // 只改发给模型的，不改落库
    minDepth?: number; maxDepth?: number;
    tags?: string[];
}
export interface PresetRegexKit {
    id: string; name: string;
    rules: PresetRegexRule[];
    enabled: boolean;
    createdAt: number; updatedAt: number;
}
```

### 3.3 存储（`utils/db.ts`，DB_VERSION 77→78）

- 新 store：`preset_packs`（keyPath id）、`preset_pack_active`（keyPath id，
  单例 `active`）、`preset_regexes`（keyPath id）。
- `prompt_presets` 表结构不动（只读出新可选字段）。
- `FullBackupData`（`types.ts:4421` 一带）新增 `presetPacks` / `presetRegexes`；
  备份登记 `context/OSContext.tsx:3990` 一带，恢复 `OSContext.tsx:5082` 一带，
  `utils/backupCoverage.ts:100` 一带登记覆盖表。
- v78 迁移（`onupgradeneeded` 内幂等 `createStore` 即可，老库升上来
  缺 store 自动建；`prompt_presets` 无需动表）。

### 3.4 分享格式

`sullyos.preset-kit` JSON：`{ schema, version: 1, pack, entries, regexKit? }`。
导入校验：schema 必须命中；entryIds 失配（引了不存在的 id）→ 丢弃该引用；
重名套组 → 自动后缀「(1)」；绝不覆盖 `default` 本体（导入成新套组）。

## 4. 注入语义（核心）

### 4.1 三段式映射

SullyOS 三段式 `stable → history → volatileTail/recencyTail`
天然对应 ST 的「marker 前后」：

- relative + `afterChatHistory=false` → 进 `stable`（角色卡之后、易变状态之前，
  即现状位置，行为等价保证）。
- relative + `afterChatHistory=true` → 追加进 `volatileTail`（历史之后，
  recency 钢印**之前**——钢印永远最后一眼，`chatRequestPayload.ts:538` 纪律不变）。
- absolute → 按 `injectionDepth` 插进历史数组（复用
  `injectWorldbookDepthEntries` 的 bucket 算法，`utils/worldbook.ts:246-271`，
  抽成共享 `injectDepthEntries`，worldbook 与预设共用）。
- `marker: 'chatHistory'` 条目本身不注入，只做套组内分界。
- role 非 system 的条目插进历史时保持原 role（user/assistant），进 stable/
  volatileTail 的一律按 system 文本拼（沿用现状，不给 system 数组加 user 块，
  防 prefix-cache 结构漂移）。

### 4.2 套组内顺序

`entryIds` 数组顺序 = 相对顺序。`order` 字段保留做旧排序兼容：
迁移时按旧 `order` 生成 `entryIds`；新 UI 只改 `entryIds`，`order` 不再写入。

### 4.3 tags 过滤

- 调用方在 `PromptBuildOptions`（`utils/chatPrompts.ts:172`）新增
  `activeTags?: string[]`，缺省 `['chat']`。
- 条目 `tags` 为空 → 全场景；非空 → 要求 `tags ⊆ activeTags`。
- tags 词表（第一版，固定集合，UI 下拉选不手填）：
  `chat`（主聊天/群聊/主动消息）`date`（约会）`story`（剧情剧场）
  `song`（写歌）`phone`（查手机）`memory`（记忆宫殿向量召回提示等）。
- 钢印两条 tags 固定 `['chat']`（recency 只在主链路有意义）。
- 约会/写歌/剧场调用 `buildSystemPromptParts` 时传自己的 tags
  （`['chat','date']` 等），只改调用点传参，不改三段式结构。

### 4.4 宏（第 2 期）

`utils/promptMacros.ts`：`{{char}} {{user}} {{persona}} {{lastUser}}`
`{{lastAssistant}} {{time}} {{date}}`。展开点：套组条目 content、钢印
（替换现有 `fillIdentity` 调用）、世界书正文（与 `expandWorldbookMacros`
合并，`{{char}}/{{user}}` 口径一致）。未知宏原样保留（不吞字）。
`lastUser/lastAssistant` 取 `currentMsgs` 尾部对应 role 的最后一条。

### 4.4b marker 槽位与 tags 的正交说明

tags 决定「条目在哪些场景出现」，marker/position 决定「出现时落在哪」。
钢印是固定落 recency 的特殊条目（tags `['chat']`），不是 marker 槽位；
`chatHistory` marker 只做分界、本身不注入。两者不互相替代。

### 4.5 采样参数（第 3 期）

`hooks/useChatAI.ts:1061-1068`：activePack.generation 有值则逐项覆盖
`effectiveApi/apiConfig`（temperature/top_p/topK/penalties/max_tokens），
缺项回退。思考链开启时仍删采样参数（`useChatAI.ts:1100-1106` 纪律不变）。
`omitSamplingParams=true` 时只发 temperature + max_tokens
（`samplingParamCompat.ts` 的 400 降参逻辑保留做第二道）。

### 4.6 正则（第 4 期）

placement 口径对齐参考仓库：1=用户输入（发送前改）/ 2=AI 输出
（`normalizeAiContent` 之后、`consumeScheduleChanges` 之前跑）/
4=仅显示（renderAndPersist 落库前分支：落库原文、显示替换版）/
5=仅发给模型（prompt 组装处改，不改落库）。
`findRegex` 非法 → 该规则整条跳过并 console.warn（绝不抛）。
`displayOnly` 与 placement=4 同义（保留字段做 UI 语义，执行层统一看 placement）。
深度：`minDepth/maxDepth` 只对 placement=2 的历史回放生效（主输出 depth=0）；
流式增量不跑正则，只在整泡完成时跑一次。

**v1 边界（2026-09-22 落地确认）**：placement 4 / displayOnly「仅显示」暂不执行
——渲染层没有显示分支，执行层遇到这类规则整条跳过并 warn，UI 不提供该选项
（字段保留做格式兼容）。输入侧落点在 `buildChatRequestPayload`
（最后一条纯文本 user 消息，只改发给模型的版本，不写回 DB；vision 数组
content 跳过）；因此 emotion eval 读到的也是正则后的版本（与模型所见一致）。
输入正则跑在 worldbook 关键词扫描之前。

## 5. 迁移（第 1 期，幂等，可重跑）

`utils/presetKitsMigration.ts` `migrateToDefaultPack()`：

1. 读全表 `prompt_presets`；若 `preset_packs/default` 已存在 → 直接返回
   （幂等门）。
2. 自定义段落（无 sourceKey）按旧 `order` 排序 → 补 `identifier`
   （`custom_<id前8>`）、`role='system'`、`injectionPosition='relative'`、
   `afterChatHistory=false` → 写回。
3. 建 `default` 套组，`entryIds` = 上述排序；钢印两条（有 sourceKey
   `chat.steel*` 的行，若存在）**不**进 entryIds（它们走 recency 原生位，
   tags 记 `['chat']`，第 2 期 UI 才可视化）。
4. 写 `preset_pack_active = { id:'active', packId:'default' }`。
5. 若用户表空（新用户）：只建空 `default` 套组 + active 指针，不播种条目
   （条目播种仍走现有 `promptPresetSeeding`，不动）。

## 6. UI（第 2 期，风格约束）

Preset App 保持现有浅玻璃 slate 系（`bg-slate-100` + `bg-white/70` 卡 +
violet 点缀，`apps/PresetApp.tsx:191-194` 口径），不引入新视觉语言
（`docs/design-system.md` §八对照流程）：

- 顶层：套组列表（默认预设 + 用户套组；切换=写 active 指针；导出/导入按钮）。
- 组内：条目卡（沿用现有卡片：名 + tags 下拉 + role 下拉 + 位置下拉
  relative/absolute+depth 输入 + afterChatHistory 开关 + 启停 + 上下移改 entryIds）。
- 新增「注入预览」页：接 `composePromptPreview`（`utils/promptPreviewComposer.ts:124`，
  需小改——把预设块来源从 `getPromptPresets` 换成 active 套组解析）+ token 估算。
- 正则页 + 测试器（输入样文→输出替换结果，纯本地）。

## 7. 风险与红线

1. absolute 条目插历史会打散 stable 前缀缓存——文档与 UI 双提示：
   绝对深度只建议 depth≤2 的「开口前最后一眼」类条目。
2. `chatPrompts.ts` 是全链路热点：改前跑全量记红名单基线（见 plan），改后 diff
   行为（forFirePack/timelyByWorker 路径零变化是硬断言）。
3. 剧情剧场 `StoryQuickPresetPanel` 覆盖机制不动；`story` tag 只做标记。
4. 查手机 `CheckPhone.tsx` 的「API 预设」是另一套东西（凭据），本次不动、
   UI 文案不混。
5. 编码纪律：含中文文件只用 Read/Edit/Write 工具；收尾跑
   `mojibakeGuard` + U+FFFD 字节扫；commit message 英文。
6. forFirePack 不带套组是**有意维持**（主动消息模板时效纪律），不是遗漏。

## 8. 不做的事（明确边界）

- 按角色隔离套组；ST/参考仓库格式共通导入；fire_pack 带套组；
  示例对话 first_mes/mes_example 体系（角色卡结构缺口，另立项）；
  内置 20 条技术模板迁入套组；`order` 字段删除（保留只读兼容）。
