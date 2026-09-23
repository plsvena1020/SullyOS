# 预设统合（Unified Prompt）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 预设 App 三页化（提示词/世界书/调用地图），真实抓取为唯一的完整 prompt 来源，内置收编显示、可接管、每角色生效清单、chat.appRules 可编辑，世界书 App 退役。

**Architecture:** 数据层只加可选字段（`adoptPosition`）；解析层加 sourceKey 排除与接管分支；观测层新增 capture/registry/effective 三个纯模块；UI 层 PresetApp 重排三页，WorldbookApp 原样嵌入；删离线镜像模块。

**Tech Stack:** React+TS / vitest(fake-indexeddb) / IndexedDB(prompt_presets) / existing preset-kit infra

**Spec:** `docs/superpowers/specs/2026-09-23-prompt-unified-design.md`

## Global Constraints

- 分支 `ethernet`，git 身份 plasma953（`plasma953@users.noreply.github.com`），英文 commit message，每任务一 commit，只 add 本任务文件（CRLF 噪音不进）。
- 命令一律 `corepack pnpm@9.15.9`；测试 `vitest run <file>`；动中文文件必跑 `vitest run utils/mojibakeGuard.test.ts`。
- tsc 判据：触碰文件在 `tsc --noEmit` 输出零新增命中（存量约 45 不计）。
- 写文件只用 Write/Edit；bash 参数避免中文；工具参数绝不放 U+FFFD 字符。
- UI 沿用 PresetApp 现有浅玻璃 slate 卡片语言（`bg-white/70 border-white/60`、violet 点缀、Phosphor），不引入新视觉语言。
- 零额外 LLM 调用；抓取只存内存；不做 token 估算；phone/story/memory 不接线。
- 行号锚点允许 ±5 偏差，偏差超限停下问，不要猜。

## Review Focus

- 接管钢印在原生点未跳过导致双份注入 —— Task 2 的测试钉死单份。
- 内置行启停影响全套组（行是全局的）—— Task 9 卡上必须标注，不静默。
- capture 环形缓冲无界增长 —— Task 1 测试钉死每桶上限 3。
- 注册表登记项实现锚点漂移 —— Task 4 wiring 测试钉死。
- chat.appRules 槽位与渲染回填错位 —— Task 6 逐字一致测试钉死。

---

### Task 1: 真实抓取基础设施 promptCallCapture

**Files:**
- Create: `utils/promptCallCapture.ts`
- Create: `utils/promptCallCapture.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯模块）。
- Produces: `captureCall(siteId: string, messages: unknown[], meta: CaptureMeta): void`、`getCaptured(siteId: string): CapturedCall[]`、`clearCaptured(siteId?: string): void`、`renderCapturedText(entry: CapturedCall): string`（Task 9/12 消费渲染器）。

- [ ] **Step 1: 写测试**

```ts
// utils/promptCallCapture.test.ts
import { describe, it, expect } from 'vitest';
import { captureCall, getCaptured, clearCaptured } from './promptCallCapture';

const msg = (role: string, content: string) => ({ role, content });

describe('promptCallCapture', () => {
    it('keeps at most 3 per site, newest first', () => {
        clearCaptured('s');
        for (let i = 0; i < 5; i++) captureCall('s', [msg('system', `p${i}`)], { charId: 'c', label: 't' });
        const got = getCaptured('s');
        expect(got).toHaveLength(3);
        expect(got[0].messages[0]).toMatchObject({ content: 'p4' });
    });
    it('history folds into one placeholder entry', () => {
        clearCaptured('s2');
        captureCall('s2', [
            msg('system', 'STABLE TEXT'),
            msg('user', 'hi 1'), msg('assistant', 'yo 1'), msg('user', 'hi 2'),
            msg('system', 'TAIL TEXT'),
        ], { charId: 'c', label: 't' });
        const [entry] = getCaptured('s2');
        expect(entry.blocks.map(b => b.kind)).toEqual(['text', 'history', 'text']);
        expect(entry.blocks[1]).toMatchObject({ kind: 'history', count: 3 });
    });
    it('folds base64 image data urls', () => {
        clearCaptured('s3');
        captureCall('s3', [msg('system', 'see data:image/png;base64,AAAA and data:image/jpeg;base64,BBBB end')], { charId: 'c', label: 't' });
        const [entry] = getCaptured('s3');
        expect(entry.blocks[0].text).toContain('[图片 ×2]');
        expect(entry.blocks[0].text).not.toContain('base64');
    });
    it('renderCapturedText joins blocks with headers, verbatim body', () => {
        clearCaptured('s4');
        captureCall('s4', [msg('system', 'ABC')], { charId: 'c', label: 't' });
        const [entry] = getCaptured('s4');
        expect(renderCapturedText(entry)).toBe('ABC');
    });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `corepack pnpm@9.15.9 vitest run utils/promptCallCapture.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
// utils/promptCallCapture.ts
// 真实发送请求的内存抓取：唯一“完整 prompt”来源。不落盘，不估 token。
export interface CaptureMeta { charId: string; label: string; at?: number }
export type CaptureBlock =
    | { kind: 'text'; role: string; text: string }
    | { kind: 'history'; count: number; fromTs?: number; toTs?: number };
export interface CapturedCall { siteId: string; meta: Required<CaptureMeta>; blocks: CaptureBlock[]; charCount: number }

const BUCKETS = new Map<string, CapturedCall[]>();
const MAX_PER_SITE = 3;
const IMG_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

const foldImages = (text: string): string => {
    let n = 0;
    const out = String(text ?? '').replace(IMG_RE, () => { n += 1; return ''; });
    return n > 0 ? `${out}\n[图片 ×${n}]` : out;
};

export function captureCall(siteId: string, messages: Array<{ role?: string; content?: unknown }>, meta: CaptureMeta): void {
    const blocks: CaptureBlock[] = [];
    let pending: Array<{ role: string; content?: unknown }> = [];
    const flushHistory = () => {
        if (pending.length === 0) return;
        blocks.push({ kind: 'history', count: pending.length });
        pending = [];
    };
    for (const m of messages || []) {
        if (m?.role === 'user' || m?.role === 'assistant') { pending.push(m as { role: string }); continue; }
        flushHistory();
        blocks.push({ kind: 'text', role: String(m?.role ?? 'system'), text: foldImages(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')) });
    }
    flushHistory();
    const entry: CapturedCall = {
        siteId, meta: { charId: meta.charId, label: meta.label, at: meta.at ?? Date.now() },
        blocks, charCount: blocks.reduce((a, b) => a + (b.kind === 'text' ? b.text.length : 0), 0),
    };
    const list = BUCKETS.get(siteId) ?? [];
    list.unshift(entry);
    BUCKETS.set(siteId, list.slice(0, MAX_PER_SITE));
}

export function getCaptured(siteId: string): CapturedCall[] { return [...(BUCKETS.get(siteId) ?? [])]; }
export function clearCaptured(siteId?: string): void {
    if (siteId) BUCKETS.delete(siteId); else BUCKETS.clear();
}
export function renderCapturedText(entry: CapturedCall): string {
    return entry.blocks.map(b => b.kind === 'history' ? `[聊天历史 · ${b.count} 条]` : b.text).join('\n\n');
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `corepack pnpm@9.15.9 vitest run utils/promptCallCapture.test.ts`
Expected: 4 PASS。

- [ ] **Step 5: Commit**

```bash
git add utils/promptCallCapture.ts utils/promptCallCapture.test.ts
git commit -m "feat(prompt): in-memory capture of real sent requests"
```

---

### Task 2: 解析层防线——sourceKey 排除 + 接管字段与管道

**Files:**
- Modify: `types.ts`（PromptPreset 加 `adoptPosition?`，约 1014-1032 区）
- Modify: `utils/presetKits.ts`（`resolveActivePackEntries` 跳过 sourceKey；接管行并入三组）
- Modify: `utils/chatPrompts.ts`（钢印/透视窗原生点跳过已接管行；约 210-237、854-859、1186、1292-1295 区）
- Test: `utils/presetKitsResolve.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 无依赖；既有 `resolveActivePackEntries/activeTags/tagsMatch`。
- Produces: 接管后的三组语义（Task 3/8/9 消费：`ResolvedPresetEntry` 含 `adopted: boolean`）。

- [ ] **Step 1: types.ts 加字段**

```ts
    /**
     * 接管落位（仅 sourceKey 内置行有效）：'native' 缺省走原生注入点；
     * stable/afterHistory/absolute 即被接管进套组管道（原生点自动跳过）。
     */
    adoptPosition?: 'native' | 'stable' | 'afterHistory' | 'absolute';
```

- [ ] **Step 2: presetKits.ts 改 resolve（只贴改动处）**

```ts
export type ResolvedPresetEntry = PromptPreset & {
    role: PresetEntryRole;
    injectionPosition: PresetInjectionPosition;
    injectionDepth: number;
    afterChatHistory: boolean;
    adopted: boolean; // sourceKey 行被接管才 true；其余 sourceKey 行不进三组
};
```

循环内首行加：`if (r.sourceKey && r.adoptPosition !== 'stable' && r.adoptPosition !== 'afterHistory' && r.adoptPosition !== 'absolute') continue;`——接管行按 adoptPosition 进对应组并标 `adopted: true`；排序：同组自定义按 entryIds 序在前，接管按目录序（行 `order`）在后。

- [ ] **Step 3: chatPrompts.ts 原生点跳过（两处，各 2 行）**

钢印 `resolveSteel` 返回前加：若该行 `adoptPosition` 非 native 返回 null（注释：已接管走管道）。
透视窗 854-859 解析处同样：行被接管则 `perspectiveBlock` 置 null。

- [ ] **Step 4: 测试追加到 presetKitsResolve.test.ts**

```ts
it('skips sourceKey rows unless adopted', async () => {
    await DB.savePromptPreset(row({ id: 'sk-builtin', content: 'B', sourceKey: 'chat.steelExpression' }));
    await DB.savePromptPreset(row({ id: 'sk-adopt', content: 'A', sourceKey: 'chat.steelYourself', adoptPosition: 'afterHistory' }));
    // pack entryIds 含两行；stable/afterHistory 不应出现 sk-builtin，afterHistory 应含 sk-adopt 且 adopted=true
});
it('never double-injects adopted steel (resolveSteel returns null)', async () => {
    // 直接调 resolveSteel 语义：mock 行 adoptPosition='stable' 时返回 null。按 chatPrompts.ts:210 实现形态写。
});
```

- [ ] **Step 5: 跑测试**

Run: `corepack pnpm@9.15.9 vitest run utils/presetKitsResolve.test.ts utils/presetKits.test.ts utils/chatPrompts.preset.test.ts`
Expected: 全 PASS（既有逐字一致用例必须仍绿）。

- [ ] **Step 6: Commit**

```bash
git add types.ts utils/presetKits.ts utils/chatPrompts.ts utils/presetKitsResolve.test.ts
git commit -m "feat(preset): sourceKey exclusion plus adoptable steel blocks"
```

---

### Task 3: 生效判定 presetEffective + 注册表 + wiring 测试

**Files:**
- Create: `utils/presetEffective.ts`
- Create: `utils/presetEffective.test.ts`
- Create: `utils/promptCallRegistry.ts`
- Create: `utils/promptCallRegistry.test.ts`（wiring：每个登记项 grep 实现锚点）

**Interfaces:**
- Consumes: Task 2 的 `ResolvedPresetEntry.adopted`；真实 resolve 函数与 char 字段、`getTtsProvider()`。
- Produces: `effectiveStatus(entry, ctx): { state, reason }`（Task 9/12 消费）；`CALL_REGISTRY: CallSite[]`（Task 12 消费）。

- [ ] **Step 1: 写 presetEffective 测试（先红）**

```ts
// utils/presetEffective.test.ts
import { describe, it, expect } from 'vitest';
import { effectiveStatus } from './presetEffective';

describe('effectiveStatus', () => {
    it('disabled custom row -> 不注入·已停用', () => {
        expect(effectiveStatus(
            { id: 'x', name: 'X', content: 'x', enabled: false, tags: [] } as any,
            { char: { chatVoiceEnabled: true } as any, provider: 'minimax', activeTags: ['chat'] },
        )).toMatchObject({ state: 'off', reason: '已停用' });
    });
    it('voice row with mismatched provider -> 不注入·供应商不匹配', () => {
        expect(effectiveStatus(
            { id: 'v', name: 'V', content: 'v', enabled: true, sourceKey: 'voice.fish', tags: [] } as any,
            { char: { chatVoiceEnabled: true } as any, provider: 'minimax', activeTags: ['chat'] },
        ).reason).toContain('供应商');
    });
    it('voice row enabled but char voice off -> 不注入·该角色未开语音', () => {
        expect(effectiveStatus(
            { id: 'v', name: 'V', content: 'v', enabled: true, sourceKey: 'voice.minimax', tags: [] } as any,
            { char: { chatVoiceEnabled: false } as any, provider: 'minimax', activeTags: ['chat'] },
        ).reason).toContain('未开语音');
    });
    it('adopted steel -> 生效·已接管', () => {
        expect(effectiveStatus(
            { id: 's', name: 'S', content: 's', enabled: true, sourceKey: 'chat.steelExpression', adoptPosition: 'stable', tags: [] } as any,
            { char: {} as any, provider: 'minimax', activeTags: ['chat'] },
        )).toMatchObject({ state: 'on', adopted: true });
    });
});
```

- [ ] **Step 2: 实现 presetEffective.ts**

状态枚举：`on | on-fallback | on-adopted | off-disabled | off-tags | off-char | off-scene | dead`。
规则（按顺序命中）：
1. `!enabled` → off-disabled「已停用」（技术模板行除外：memory.*/rel.genGuide/amsg.emotionEval → on-fallback「生效·兜底内置」）。
2. sourceKey 语音四条：provider 不匹配 → off-char「供应商不匹配（当前 xx）」；`char.chatVoiceEnabled !== true` → off-char「该角色未开语音」；启用 → on；停用 → on-fallback「生效·兜底内置」（调用方 `??` 内置）。
3. voice.date：`char.dateVoiceEnabled` 关 → off-char；开 → on（停用仍 on-fallback）。
4. date.digDeeper：`char.dateStyleConfig?.digDeeper === false` → off-char；否则 on。
5. chat.perspectiveTool：adopted → on-adopted；`char.perspectiveEnabled` 关 → off-char；否则 on。
6. 钢印两条：adopted → on-adopted（落位标注）；native → on（停用 → off-disabled）。
7. song.craftRules：on（停用 → off-disabled，回退空串）。
8. 自定义行：tags 不含 activeTags → off-tags「场景不含」；afterChatHistory/absolute 在 ['chat'] 下正常 on；在 date/song 下 tags 命中即 on；phone/story/memory tags → off-scene「该场景暂未接入」。
9. amsg.emotionEvalMindful/Living：Task 7 接活后为 on（三选一按 scheduleStyle 标注），接活前保持 dead「无消费点」——实现时读 Task 7 后的真实分支，若分支不存在则 dead。

- [ ] **Step 3: 注册表 promptCallRegistry.ts（取材 spec §7，按此形态逐条登记约 70 项中的 v1 全量）**

```ts
export type CallVisibility = 'local' | 'local-uncaptured' | 'cloud';
export interface CallGate { kind: 'char' | 'global' | 'manual'; ref: string; label: string }
export interface CallSite {
    site: string; category: string; name: string; blurb: string;
    trigger: '每轮回复后' | '发送前' | '手动按钮' | '定时 fire' | '工具轮内';
    sources: string[]; // sourceKey 或 'hardcoded:<模块>'
    gates: CallGate[]; visibility: CallVisibility;
    anchor: string; // "文件:行" 实现锚点
}
export const CALL_REGISTRY: CallSite[] = [ /* 主聊天链路 10 + 记忆 7 + 情绪 2 + 关系 2 + 创作功能（song-mentor 等 1 接抓取、其余 local-uncaptured） + 后台云端 3 + 工具识图 */ ];
```

- [ ] **Step 4: wiring 测试（仿 amsg2ChatLoop.wiring.test.ts 范式）**

```ts
// utils/promptCallRegistry.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CALL_REGISTRY } from './promptCallRegistry';

describe('call registry anchors exist', () => {
    it('every local site has a resolvable file anchor', () => {
        for (const s of CALL_REGISTRY.filter(c => c.visibility !== 'cloud')) {
            const [file] = s.anchor.split(':');
            const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            expect(src.length).toBeGreaterThan(0);
        }
    });
    it('key anchors pin exact symbols', () => {
        const cp = readFileSync(new URL('../utils/chatPrompts.ts', import.meta.url), 'utf8');
        expect(cp).toContain('const resolveSteel');
        expect(cp).toContain('resolveVoiceActingGuide');
    });
});
```

- [ ] **Step 5: 跑测试**

Run: `corepack pnpm@9.15.9 vitest run utils/presetEffective.test.ts utils/promptCallRegistry.test.ts`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add utils/presetEffective.ts utils/presetEffective.test.ts utils/promptCallRegistry.ts utils/promptCallRegistry.test.ts
git commit -m "feat(prompt): effective-status engine plus call-site registry"
```

---

### Task 4: 七处抓取接线

**Files:**
- Modify: `hooks/useChatAI.ts`（chat-main payload 处约 913 行；emotion-eval 发包点约 208/228 行）
- Modify: `utils/memoryPalace/digestion.ts`（约 334 行 safeFetchJson 前）、`utils/memoryPalace/extraction.ts`（约 409 行前）
- Modify: `utils/relationshipGen.ts`（约 95 行前）、`utils/songPrompts.ts` 或 SongwritingApp 调用处、`apps/DateApp.tsx`（约 227 行 callLLM 内）
- Test: 既有相关测试零回归即验收（抓取无行为变化）

**Interfaces:**
- Consumes: Task 1 `captureCall`。
- Produces: 七个 site 的真实记录（Task 9/12 消费）。

- [ ] **Step 1-7: 每处加 3 行（形态统一）**

```ts
try {
    const { captureCall } = await import('./promptCallCapture');
    captureCall('<site>', fullMessagesOrSingle, { charId: char?.id ?? '', label: '<中文名>' });
} catch { /* 抓取永不挡主链路 */ }
```

site 映射：chat-main（fullMessages）/ emotion-eval（单 user 消息）/ memory-digest / memory-extract / rel-gen / song-mentor / date-session。单消息调用包成 `[{ role: 'user', content: prompt }]`。

- [ ] **Step 8: 跑相关测试**

Run: `corepack pnpm@9.15.9 vitest run utils/memoryPalace utils/relationshipGen.test.ts utils/xhsMcpClient.test.ts`
Expected: 全 PASS（行为零变化）。

- [ ] **Step 9: Commit**

```bash
git add hooks/useChatAI.ts utils/memoryPalace/digestion.ts utils/memoryPalace/extraction.ts utils/relationshipGen.ts utils/songPrompts.ts apps/DateApp.tsx
git commit -m "feat(prompt): capture real requests at seven call sites"
```

---

### Task 5: chat.appRules 提升为目录条目

**Files:**
- Modify: `utils/promptPresetCatalog.ts`（新条目 `chat.appRules`，整块原文 + `__槽位__`）
- Modify: `utils/chatPrompts.ts`（该块改调 resolve + 槽位回填）
- Test: `utils/chatPrompts.apprules.test.ts`（同一输入提升前后 stable 逐字一致）

**Interfaces:**
- Consumes: 既有目录机制（getBuiltinEntry/resolveManagedPromptSync）。
- Produces: 可编辑/启停/恢复默认的 `chat.appRules`（Task 9 内置段消费）。

- [ ] **Step 1: 读出整块原文**：打开 `utils/chatPrompts.ts` 找到 `### 聊天 App 行为规范 (Chat App Rules)` 模板字符串起止行，全文复制（不改一字，含 `${...}` 插值）。
- [ ] **Step 2: 插值转槽位**：每个 `${cond ? '文本' : ''}` 改为 `__SLOT_<名>__`（已知：日程教学、Notion、飞书、用户笔记、要图提醒；其余照此办理，槽位名大写下划线）。目录条目 content 即转后全文。
- [ ] **Step 3: 渲染处回填**：原模板位置改为 `resolveManagedPromptSync('chat.appRules', FALLBACK)` 取文 + 按同一条件把各槽位字符串 replace 回去 + `fillIdentity`/宏展开（口径与旧代码一致）。
- [ ] **Step 4: 逐字一致测试**

```ts
// utils/chatPrompts.apprules.test.ts
import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
// 同一 char（含日程/Notion/飞书开关全开与全关两档）调 buildSystemPromptParts，
// stable 必须包含行为规范块；停用 chat.appRules 行后该块消失（resolveManagedPrompt 语义）。
```

- [ ] **Step 5: 跑测试**：`vitest run utils/chatPrompts.apprules.test.ts utils/chatPrompts.test.ts` 全 PASS。
- [ ] **Step 6: Commit**：`git add utils/promptPresetCatalog.ts utils/chatPrompts.ts utils/chatPrompts.apprules.test.ts && git commit -m "feat(preset): promote chat app rules to editable catalog entry"`

---

### Task 6: emotionEval 三选一接活 + date/song tags 接线

**Files:**
- Modify: `hooks/useChatAI.ts`（164-167 硬编码改读 sourceKey 行）
- Modify: `utils/presetKits.ts`（抽共享渲染 helper `renderKitEntry(entry, macroCtx)`：content→宏→placement=5 正则）
- Modify: `utils/datePrompts.ts`（约会组装处传入 kit stable/afterHistory，activeTags ['chat','date']）、`utils/songPrompts.ts`（导师 prompt 处，activeTags ['chat','song']）
- Test: `utils/chatPrompts.preset.test.ts` 追加（date tags 在 date 下注入、phone tags 在 chat 下被滤）

**Interfaces:**
- Consumes: Task 2 解析器；`expandPromptMacros`；`applyRegexPlacement`。
- Produces: 真实三选一 + 两场景接线（Task 3 的 dead 标注解除，Task 9 消费）。

- [ ] **Step 1: emotionEval 接活**：164-167 改为按 `char.scheduleStyle` 选 sourceKey（`mindful`→amsg.emotionEvalMindful，`living`→amsg.emotionEvalLiving，否则 amsg.emotionEval），经 `resolveTechnicalPrompt` 取文（停用回退内置，保持技术模板语义）。
- [ ] **Step 2: helper**：`presetKits.ts` 导出 `renderKitEntryText(content, macroCtx)`，主链路 stable/afterHistory/absolute 渲染与 date/song 共用它（消灭三处重复实现）。
- [ ] **Step 3: date/song 接线**：两处组装器在拼系统提示时调 `resolveActivePackEntries` 对应 tags + helper 渲染后追加（位置：date 在 VN 块前、song 在导师 prompt 规则段后；行号按实读锚点）。
- [ ] **Step 4: 跑测试**：`vitest run utils/chatPrompts.preset.test.ts utils/worldbook.test.ts` 全 PASS。
- [ ] **Step 5: Commit**：`git commit -m "feat(preset): live emotionEval switch plus date/song kit wiring"`

---

### Task 7: PresetApp 三页重排（提示词/世界书/调用地图入口）

**Files:**
- Modify: `apps/PresetApp.tsx`（三页 tab；页1 = 套组条 + 角色 chip + 内置常驻段 + 自定义段 + 未入套组 + 真实发送 overlay；页2 = `<WorldbookApp embedded />`；页3见 Task 9）
- Modify: `apps/WorldbookApp.tsx`（`embedded?: boolean` prop：隐藏顶栏与 closeApp 按钮）
- Test: 手测清单（切换/拖动/接管拨动/角色 chip/overlay 有无记录）+ `mojibake` 绿

**Interfaces:**
- Consumes: Task 1 渲染器、Task 2 接管字段、Task 3 effective、Task 5 appRules。
- Produces: 三页 UI（Task 9 挂调用地图页）。

- [ ] **Step 1: WorldbookApp 加 prop**：`const WorldbookApp: React.FC<{ embedded?: boolean }>`，顶栏容器（约 562-564 行）`{!embedded && (...)}` 包裹；其余零改。
- [ ] **Step 2: PresetApp 页结构**：tab 状态 `'prompt' | 'worldbook' | 'map'`；套组管理整块收进顶栏 sheet（沿用现有 pack CRUD 函数）；角色 chip（`DB.getAllCharacters` 列表 + 可清空，localStorage 记上次选择）。
- [ ] **Step 3: 内置常驻段**：sourceKey 行按目录序渲染（可折叠；默认预设展开、他组折叠；拖动只写回 `order`；钢印/透视窗行带落位下拉 native/stable/afterHistory/absolute + depth 输入；技术模板/语音/约会写歌行标「原生注入」原因）。
- [ ] **Step 4: 生效行**：角色选中时每卡调 Task 3 `effectiveStatus` 显示状态 + 原因；互斥组（语音/情绪）组头行显示当前选择。
- [ ] **Step 5: 真实发送 overlay**：顶栏按钮开全屏 overlay，列当前角色各 site 最近记录（Task 1 `getCaptured`），点开展示渲染器输出 + 复制全文 + 导出 txt（文件名 ASCII）；无记录明示。
- [ ] **Step 6: 验证**：`vite build` 通过 + mojibake 绿 + U+FFFD 扫零。
- [ ] **Step 7: Commit**：`git commit -m "feat(preset): three-page app with effective states and real captures"`

---

### Task 8: 世界书 App 退役 + 调用地图页 + 收尾

**Files:**
- Modify: `types.ts`（删 `Worldbook = 'worldbook'`）、`constants.tsx`（删条目与图标）、`components/PhoneShell.tsx`（删懒加载/注册/渲染三处）、`components/os/appPreload.ts`、`utils/safeAreaApps.ts` + 测试、`components/os/acnhIcons.tsx`、`apps/Character.tsx`（2483 文案改指预设 App）
- Modify: `apps/PresetApp.tsx`（页3：分类分组 + 门三态 + 时序卡 + 云端卡 + sourceKey 跳转）
- Delete: `utils/promptPreviewComposer.ts`、`utils/promptPreviewComposer.test.ts`
- Modify: `notes/ethernet-features.md`、`notes/ethernet-branch-context.md`、`utils/buildInfo.ts`（`v3.18 (Unified Prompt)`）

**Interfaces:**
- Consumes: Task 3 注册表、Task 1 抓取、Task 7 的 tab 架子。
- Produces: 退役完成 + 地图页 + 文档。

- [ ] **Step 1: 退役八处**（逐处删，删后 grep `WorldbookApp|AppID.Worldbook` 全仓应只剩 Character 文案与类型引用）。
- [ ] **Step 2: 删离线镜像**：删两文件；修 PresetApp 内 `composePromptPreview` 引用（Task 7 已替换为抓取视图，此步确认零引用再删）。
- [ ] **Step 3: 地图页**：按 registry 分类渲染调用卡（门三态按当前角色实时算；sourceKey 点跳页1对应卡；site 有抓取显示“最近一次·时间”点开同渲染器；cloud 卡列补段清单；uncaptured 标「未接入抓取」）+ 顶部时序卡。
- [ ] **Step 4: 文档与版本**：features 补记三页/抓取/接管/appRules；branch-context 加 ✅；`APP_VERSION` 升 `v3.18 (Unified Prompt)`。
- [ ] **Step 5: 全量门禁**：`vitest run` 全绿（对比基线 480/6018，只允已知抖动）+ `vite build` + tsc 触碰零新增 + mojibake 绿 + U+FFFD 扫零。
- [ ] **Step 6: Commit**（分两 commit：退役+删镜像一 commit，地图页+文档一 commit）。

## Self-Review（对照 spec）

- §1 三页 → Task 7/8。§2 收编显示 → Task 2/7。§3 接管 → Task 2/7。
- §4 生效清单 → Task 3/7。§5 抓取+渲染+删镜像 → Task 1/4/8。
- §6 注册表+wiring+时序 → Task 3/8。§7 清单 → Task 3 取材。
- §8 appRules → Task 5。§9 三修复 → Task 6/8。§10 不做 → 无任务对应（ spoiler: phone/story/memory 接线、按角色启停、云端抓取、token 估算、entryIds 收编均无任务，符合）。
- 类型一致：`adoptPosition`（Task 2）与 effective/卡片落位下拉（Task 3/7）同名字；siteId 字符串与 registry.site 同源（Task 1/3/4）。
