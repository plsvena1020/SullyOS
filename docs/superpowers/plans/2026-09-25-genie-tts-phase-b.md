# Genie-TTS 阶段 B 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把阶段 A 已验证的 Genie 语音链路做成用户可开、可试、可配的完整功能：设置页默认勾选的开关 + 两处试听 + 约会缓存修正。

**Architecture:** 阶段 A 已落地全部合成路径（VPS 适配层 → main-agent 转发 → 浏览器客户端 → 路由分流），本阶段只加 UI 面、缓存键与合同加固，不碰任何合成逻辑。开关语义沿用阶段 A 的 `genieVoiceEnabled === true` 严格判断；"默认开启"只体现为设置页 UI 默认勾选、首次保存时写入，绝不在代码里把 `undefined` 当 `true`。

**Tech Stack:** React + TypeScript (Vite 5, vitest 2.1.9, node environment 默认；components/apps 内 React 单测按文件头 `@vitest-environment` 切 jsdom）、Cloudflare Workers (main-agent 已冻结，本阶段不动）。

**Spec:** `docs/superpowers/specs/2026-09-24-genie-tts-provider-design.md`（§8.2/§8.3 为验收依据，§10.1 为"默认开启"的唯一合法落地方式）

## Global Constraints

- `genieVoiceEnabled === true` 才是开，其余一律视为关。任何地方不得把 `undefined`/`null` 当作开启（spec §10.1）。
- `disgusted` 不补录；一切 Genie 情绪输入非白名单一律回落 `calm`。
- 禁止触碰会抹用户数据的迁移链：`promptPresetCatalog.ts`、`promptPresetSeeding.ts`、`presetEffective.ts`、`promptCallRegistry.ts` 一律不改（spec §271）。
- 仓库里禁止出现真实后端域名（`networkFailureDiagnosis.ts:414-415` 注释即此规）。
- 写文件只用专用读写工具，必须 UTF-8 无 BOM；含中文的 oldString 只从 Read 输出逐字取。
- 错误体契约不变：顶层 `{"error": "<code>"}`，不包 `detail`。
- 超时预算不变：浏览器 135s、代理 150s、服务端现实最坏约 130s。本阶段不调任何超时数值。
- git commit message 用英文；提交只加本次文件（仓库是多窗口共享环境）。
- §293 老用户迁移明确不做：不得给 `os_api_config` 批量补写 `genieVoiceEnabled: true`，不得为此提前执行阶段 B 内容；是否迁移留到阶段 B 结束时单独决定。
- 缓存必须有界：Date 进程内缓存插入序上限 30 条（`DATE_VOICE_CACHE_LIMIT`，读命中不刷新 recency、复写才刷新——会话级够用，不做真 LRU）+ 淘汰即 revoke blob URL；ttsCache 按条数上限（`TTS_CACHE_MAX_ENTRIES`，按 lastUsedAt 最旧优先）修剪 + 设置页手动清空。修缓存逻辑不得改变命中语义（同键同情绪仍命中）。

## Review Focus

1. 开关显示"开"但尚未保存时，实际合成路径必须仍走旧引擎（显示态与持久态分叉是最容易让用户困惑的点）。→ 钉在 T1 测试。
2. 约会页同一句台词 `calm` 与 `sad` 播出同一段音频（缓存键漏情绪）。→ 钉在 T3 回归测试（即 spec §8.2-8）。
3. Genie 音频下载成 `.mp3` 后缀或 `audio/mpeg` 类型，分享面板走错路由。→ 钉在 T4 测试。
4. 模型在 Genie 下发出 `[v:disgusted]`，用户实际听到 `calm`（情绪静默失效）。→ 钉在 T6 守卫测试。
5. APK 本地壳里 Genie 报 `genie_unavailable`，被误诊成梯子/DNS 问题。→ 钉在 T5 测试。
6. 长约会/大量试听后内存只涨不掉：进程内缓存无上限且 blob URL 从未释放，IndexedDB 无淘汰。→ 钉在 T3 淘汰测试 + 修剪测试（上限、revoke、淘汰顺序、非 tts_ 不动）。

## 本次会触碰的文件清单

新建：`utils/genieSettings.ts`、`utils/genieSettings.test.ts`、`utils/genieAudition.ts`、`utils/genieAudition.test.ts`、`utils/dateVoiceCache.ts`、`utils/voiceDownload.ts`、`utils/voiceDownload.test.ts`、`components/date/dateVoiceCache.test.ts`、`utils/ttsCache.test.ts`
修改：`utils/genieTts.ts`（仅：导出 GENIE_EMOTIONS + 类型；ERROR_TEXT 加 2 码；合成成功处加 WAV 校验）、`apps/Settings.tsx`（Genie 区 + 保存装配 + 试听/清空两按钮）、`apps/Character.tsx`（试听按钮 + 处理函数 + 1 个 import）、`components/date/DateSession.tsx`（声明换 Map + 4 处缓存键）、`utils/ttsCache.ts`（追加修剪/清空函数 + save 计数门）、`utils/datePrompts.ts`（1 个 import 扩展 + 1 个 export + 1 处替换 + 新测试文件 `utils/dateVoiceGuide.test.ts`）、`apps/Chat.tsx`（1 处后缀 + 1 处 MIME）、`apps/CallApp.tsx`（1 处后缀 + 1 处 MIME）、`utils/networkFailureDiagnosis.ts`（1 个新函数 + 测试）、`api/backend-proxy.ts`（2 行头转发 + 已有测试文件加 case）
明确不碰：`promptPresetCatalog.ts`、`promptPresetSeeding.ts`、`presetEffective.ts`、`promptCallRegistry.ts`、`types.ts`（字段已存在）、`utils/ttsRouter.ts`、`utils/ttsProvider.ts`、`context/OSContext.tsx`、`worker/main-agent/*`、`vps-backend/*`。

## 任务依赖图

- 随时可并行：T3、T4、T5、T6（文件零重叠）。
- T1 先行（它改 `genieTts.ts` 第 43 行 1 个词）；T7 在 T1 之后（同文件另两处）；T2 在 T1 之后（试听按钮放在 T1 建的 Genie 区里），且 T2 在 T3 之后（清空缓存按钮 `import { clearTtsCache } from '../utils/ttsCache'`，T3 建）。
- Fixture 耦合（非文件冲突，T8 前必处理）：T7 给合成加严 RIFF/`fmt ` 校验后，T2/T3 测试里的 mock 音频若仍是全零/仅 RIFF 会立刻变红——两处测试的 `wavBytes` 必须带 `RIFF` + `fmt ` 头（本计划 T2 Step2、T3 Step2 已按此写）。T8 全量重跑是最终兜底。
- T8 最后（跑全量验收）。

---

### Task 1: 设置页 Genie 开关 + 情绪模式 + 固定情绪

**Files:**
- Modify: `utils/genieTts.ts:43`（`const` → `export const`，并追加类型导出）
- Create: `utils/genieSettings.ts`
- Create: `utils/genieSettings.test.ts`
- Modify: `apps/Settings.tsx`（state 区、`handleSaveOtherApis`、Genie UI 区）

**Interfaces:**
- Consumes: `APIConfig`（`types.ts:428/430/432` 字段已存在，无需改 types）。
- Produces: `genieSwitchInitial(apiConfig)`、`buildGenieConfigPatch(local)`（T2 的试听按钮不依赖这两个函数，但 T2 的按钮放在本任务建的 UI 区里，所以 T2 必须等 T1 落地）。

**Background:** 开关走"保存按钮持久化"模式：只改 `handleSaveOtherApis`（当前 `:1350-1354`），在其中装配 `updateApiConfig({...buildOtherApiConfig(), ...buildGenieConfigPatch(...)})`。**禁止**套用 `selectTtsProvider` 的立即落库模式（`Settings.tsx:1412-1417` 的 `updateApiConfig(buildOtherApiConfig({ ttsProvider: provider }))`），**禁止**把 Genie 片段摊进 `buildOtherApiConfig` 本体（`selectFishModel` `:1420`、`selectElevenLabsModel` `:1426` 同样走它立即落库）：spec §10.1 要求"默认开启"只体现为 UI 默认勾选、首次保存时写入；任何一条立即落库侧路都会让"只打开设置页看一眼"的老用户也被写入 `true`。（注：行号以符号定位为准，此处数值为审稿时实测；若对不上，先按符号名找 `handleSaveOtherApis` / `selectTtsProvider` 再下笔。）

- [ ] **Step 1: 导出情绪表与类型**

在 `utils/genieTts.ts:43` 把：
```ts
const GENIE_EMOTIONS = ['calm', 'happy', 'sad', 'angry', 'surprised', 'fearful', 'fluent'] as const;
```
改为：
```ts
export const GENIE_EMOTIONS = ['calm', 'happy', 'sad', 'angry', 'surprised', 'fearful', 'fluent'] as const;
export type GenieEmotion = typeof GENIE_EMOTIONS[number];
```
其余一行不动。

- [ ] **Step 2: 新建纯函数模块**

创建 `utils/genieSettings.ts`，完整内容：
```ts
import type { APIConfig } from '../types';

/** 设置页开关的显示初值。undefined（老用户/新用户均未保存过）显示为勾选，
 * 但这只是显示态；持久态仍以 apiConfig.genieVoiceEnabled === true 为准，
 * 只有按保存按钮才会写入（见 buildGenieConfigPatch）。 */
export function genieSwitchInitial(apiConfig: Pick<APIConfig, 'genieVoiceEnabled'>): boolean {
  return apiConfig.genieVoiceEnabled ?? true;
}

export interface GenieLocalSettings {
  enabled: boolean;
  emotionMode: 'auto' | 'fixed';
  emotion: string;
}

/** 把设置页本地态装配成可持久化的 config 片段。emotion 只在 fixed 模式且非空时写入。 */
export function buildGenieConfigPatch(local: GenieLocalSettings): Partial<APIConfig> {
  return {
    genieVoiceEnabled: local.enabled,
    genieEmotionMode: local.emotionMode,
    genieEmotion: local.emotionMode === 'fixed' && local.emotion.trim() ? local.emotion.trim() : undefined,
  };
}
```

- [ ] **Step 3: 写测试**

创建 `utils/genieSettings.test.ts`，完整内容：
```ts
import { describe, expect, it } from 'vitest';
import { buildGenieConfigPatch, genieSwitchInitial } from './genieSettings';
import { GENIE_EMOTIONS } from './genieTts';

describe('genieSwitchInitial', () => {
  it('undefined 显示勾选（默认开），但这只是显示态', () => {
    expect(genieSwitchInitial({})).toBe(true);
  });
  it('显式 false 保持不勾选', () => {
    expect(genieSwitchInitial({ genieVoiceEnabled: false })).toBe(false);
  });
  it('显式 true 保持勾选', () => {
    expect(genieSwitchInitial({ genieVoiceEnabled: true })).toBe(true);
  });
});

describe('GENIE_EMOTIONS', () => {
  it('恰好 7 项且不含 disgusted', () => {
    expect([...GENIE_EMOTIONS].sort()).toEqual(
      ['calm', 'fearful', 'fluent', 'happy', 'sad', 'angry', 'surprised'].sort(),
    );
    expect((GENIE_EMOTIONS as readonly string[]).includes('disgusted')).toBe(false);
  });
});

describe('buildGenieConfigPatch', () => {
  it('原样装配开关与模式', () => {
    expect(buildGenieConfigPatch({ enabled: true, emotionMode: 'auto', emotion: '' })).toEqual({
      genieVoiceEnabled: true,
      genieEmotionMode: 'auto',
      genieEmotion: undefined,
    });
  });
  it('fixed 模式才写 emotion，空白回落 undefined', () => {
    expect(buildGenieConfigPatch({ enabled: true, emotionMode: 'fixed', emotion: '  ' })).toMatchObject({
      genieEmotion: undefined,
    });
    expect(buildGenieConfigPatch({ enabled: false, emotionMode: 'fixed', emotion: 'sad' })).toMatchObject({
      genieVoiceEnabled: false,
      genieEmotion: 'sad',
    });
  });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run utils/genieSettings.test.ts`
Expected: 6 passed, 0 failed。

- [ ] **Step 5: Settings 接线（state）**

在 `apps/Settings.tsx` 的 `localTtsProvider` 初始化之后（`:670-674` 块结束处）插入：
```tsx
const [localGenieEnabled, setLocalGenieEnabled] = useState(genieSwitchInitial(apiConfig));
const [localGenieEmotionMode, setLocalGenieEmotionMode] = useState<'auto' | 'fixed'>(
  apiConfig.genieEmotionMode === 'fixed' ? 'fixed' : 'auto',
);
const [localGenieEmotion, setLocalGenieEmotion] = useState(apiConfig.genieEmotion || 'calm');
```
并在文件顶部按既有 import 风格加：`import { buildGenieConfigPatch, genieSwitchInitial } from '../utils/genieSettings';` 与 `import { GENIE_EMOTIONS } from '../utils/genieTts';`。
**禁止**把这三个 state 加进 `:999-1031` 的重同步 effect 依赖——用户拨了开关后若因外部 apiConfig 变化被重置回默认勾选，是惊吓行为。初始化一次即可。（行号以符号定位为准。）

- [ ] **Step 6: Settings 接线（保存装配——只进保存路径）**

只改 `handleSaveOtherApis`（当前 `:1350-1354`），把：
```ts
const handleSaveOtherApis = () => {
  updateApiConfig(buildOtherApiConfig());
```
改成：
```ts
const handleSaveOtherApis = () => {
  updateApiConfig({
    ...buildOtherApiConfig(),
    ...buildGenieConfigPatch({
      enabled: localGenieEnabled,
      emotionMode: localGenieEmotionMode,
      emotion: localGenieEmotion,
    }),
  });
```
`setOtherStatusMsg` 两行不动。**为什么不能摊进 `buildOtherApiConfig`**：`selectTtsProvider`（`:1412-1417`）、`selectFishModel`（`:1420`）、`selectElevenLabsModel`（`:1426`）都调 `buildOtherApiConfig` 做立即落库；摊进去会让"只打开设置页、点一下引擎 radio、从不按保存"的老用户也被写入 `genieVoiceEnabled: true`，`?? true` + "仅保存写入"的保证当场作废。不在 toggle 的 onChange 里调 `updateApiConfig`。（行号以符号定位为准。）

- [ ] **Step 7: Settings 接线（UI 区）**

在引擎三选一 radio 卡片外层收尾之后（当前 `:3377` 的 `</div>`，即 `space-y-2` 内层 `:3376` 之下一行）插入 Genie 区完整 JSX，位置在语音提示词注释（当前 `:3379`）之前。注意 `:3376` 才是内层列表收尾，不要按内层数；行号以符号定位为准（找 radio 卡片外层收尾的 `</div>` + 紧随其后的语音提示词注释双锚点）：
```tsx
{/* Genie-TTS —— 自建语音开关（默认勾选，保存才写入；绝不立即落库） */}
<div className="group rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5 block">Genie 语音（自建）</label>
    <p className="text-[11px] text-slate-400 mb-2.5">打开后聊天语音条 / 约会 / 电话走自建 Genie-TTS；关闭则回退原三家。上面三家的配置都会保留。</p>
    <label className="w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left cursor-pointer border-slate-200 bg-white/70">
        <input
            type="checkbox"
            checked={localGenieEnabled}
            onChange={(e) => setLocalGenieEnabled(e.target.checked)}
            className="w-4 h-4 accent-primary"
        />
        <span className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-slate-700">启用 Genie-TTS</span>
            <span className="block text-[11px] text-slate-400 mt-0.5">需主代理可达；改动只在按保存后生效</span>
        </span>
    </label>
    {localGenieEnabled && (
        <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
                {(['auto', 'fixed'] as const).map((m) => (
                    <button
                        key={m}
                        type="button"
                        onClick={() => setLocalGenieEmotionMode(m)}
                        className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold ${localGenieEmotionMode === m ? 'border-primary bg-primary/5 text-primary' : 'border-slate-200 bg-white/70 text-slate-700'}`}
                    >
                        {m === 'auto' ? '跟随消息情绪' : '固定情绪'}
                    </button>
                ))}
            </div>
            {localGenieEmotionMode === 'fixed' && (
                <select
                    value={localGenieEmotion}
                    onChange={(e) => setLocalGenieEmotion(e.target.value)}
                    className="w-full bg-white rounded-2xl px-3 py-2 text-xs border border-slate-200"
                >
                    {GENIE_EMOTIONS.map((e) => (
                        <option key={e} value={e}>{e}</option>
                    ))}
                </select>
            )}
            {/* T2: 试听按钮插这里 */}
        </div>
    )}
</div>
```
checkbox 的 onChange 只改本地 state，绝不调 `updateApiConfig`（见 Step 6 的禁止项）。

- [ ] **Step 8: 跑测试 + 类型确认通过**

Run: `pnpm vitest run utils/genieSettings.test.ts utils/genieTts.test.ts`
Expected: 全绿。
Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^(apps/Settings\.tsx|utils/genieSettings|utils/genieTts)'`
Expected: 无输出（零命中）。

- [ ] **Step 9: 提交**

```bash
git add utils/genieTts.ts utils/genieSettings.ts utils/genieSettings.test.ts apps/Settings.tsx
git commit -m "feat(settings): Genie switch default-checked with save-button persistence"
```

---

### Task 2: 两处试听（设置页 + 角色页）

**Files:**
- Create: `utils/genieAudition.ts`
- Create: `utils/genieAudition.test.ts`
- Modify: `apps/Settings.tsx`（T1 占位行处加按钮）
- Modify: `apps/Character.tsx`（ElevenLabs 块 `:2024` 之后加 Genie 块 + 顶部加 1 个 import）

**Interfaces:**
- Consumes: `synthesizeSpeechGenieDetailed`（`genieTts.ts:64` 已导出）、`apiConfig`（两处调用方均已在作用域内：Settings 全文件可用，Character 经 `useOS()` `:100`)、`GENIE_EMOTIONS`（T1 已导出；试听固定文本不需要它，仅固定情绪用 `resolveGenieEmotion` 内部逻辑）。
- Produces: `auditionGenieVoice(apiConfig, opts?)`（本任务内自产自销；外部契约无新增）。

**Background:** 套用 `Character.tsx:251-284` 的 ElevenLabs 试听形状（调详细合成函数 → `new Audio(url)` → 播完/播错释放 blob URL → toast）。区别只有两点：调的是 Genie 详细合成函数，且 cfg 强制 `{...apiConfig, genieVoiceEnabled: true}`（试听的意义就是"开之前先听"，不能因开关没开而试听失败）。

- [ ] **Step 1: 新建试听 helper**

创建 `utils/genieAudition.ts`，完整内容：
```ts
import { synthesizeSpeechGenieDetailed } from './genieTts';
import type { APIConfig, CharacterProfile } from '../types';

export const GENIE_AUDITION_TEXT = '你好，我是你的新声音。现在能听见我吗？';

/** 合成固定试听句并播放。强制启用 Genie（试听先于开关），情绪走调用方配置的正常解析
 *（fixed 模式用配置值，否则 calm 兜底）。返回 stop 供"试听中…"切换/卸载时调用。 */
export async function auditionGenieVoice(
  apiConfig: APIConfig,
  charName?: string,
): Promise<{ stop: () => void }> {
  const cfg = { ...apiConfig, genieVoiceEnabled: true as const };
  const text = charName ? `你好，我是${charName}。现在能听见我的声音吗？` : GENIE_AUDITION_TEXT;
  const { url } = await synthesizeSpeechGenieDetailed(
    text,
    { id: 'genie-audition' } as CharacterProfile,
    cfg,
  );
  const audio = new Audio(url);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { audio.pause(); } catch { /* ignore */ }
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  };
  audio.onended = stop;
  audio.onerror = stop;
  await audio.play();
  return { stop };
}
```

- [ ] **Step 2: 写测试**

创建 `utils/genieAudition.test.ts`，完整内容（setup 逐项说明：`readAgentRoutingConfig` 无 agentUrl 即抛"未配置主代理地址"，故必须写 localStorage；node 下无 `Audio` 与 `URL.createObjectURL`，必须 stub；T7 落地后合成要求 RIFF + `fmt ` 头，故 fixture 必须带两者，否则 T8 必红）：
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditionGenieVoice, GENIE_AUDITION_TEXT } from './genieAudition';

const AGENT = 'https://agent.test';

const wavBytes = () => {
  const buf = new ArrayBuffer(2048);
  const u8 = new Uint8Array(buf);
  u8.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  u8.set([0x66, 0x6d, 0x74, 0x20], 12); // 'fmt '
  return buf;
};

class MockAudio {
  static instances: MockAudio[] = [];
  play = vi.fn(async () => {});
  pause = vi.fn(() => {});
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public src?: string) { MockAudio.instances.push(this); }
}

describe('auditionGenieVoice', () => {
  beforeEach(() => {
    MockAudio.instances = [];
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: AGENT, agentToken: 'tok' }));
    vi.stubGlobal('Audio', MockAudio as any);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:audition-1', revokeObjectURL: () => {} } as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wavBytes(), {
      status: 200, headers: { 'content-type': 'audio/wav', 'X-Genie-Resolved-Emotion': 'calm' },
    })));
  });
  afterEach(() => { localStorage.removeItem('os_api_config'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('强制启用 Genie 并播放固定试听句', async () => {
    const fetchMock = globalThis.fetch as any;
    const { stop } = await auditionGenieVoice({ genieVoiceEnabled: false } as any);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).text).toBe(GENIE_AUDITION_TEXT);
    expect(MockAudio.instances).toHaveLength(1);
    expect(MockAudio.instances[0].play).toHaveBeenCalledTimes(1);
    stop();
  });

  it('带角色名时试听句含角色名', async () => {
    const fetchMock = globalThis.fetch as any;
    await auditionGenieVoice({} as any, '小糖');
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).text).toContain('小糖');
  });

  it('stop 幂等且只释放一次', async () => {
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      createObjectURL: () => 'blob:audition',
      revokeObjectURL: (u: string) => { revoked.push(u); },
    } as any);
    const { stop } = await auditionGenieVoice({} as any);
    stop(); stop();
    expect(revoked).toEqual(['blob:audition']);
  });

  it('合成失败时抛错且不建 Audio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"busy"}', {
      status: 503, headers: { 'content-type': 'application/json' },
    })));
    await expect(auditionGenieVoice({} as any)).rejects.toThrow();
    expect(MockAudio.instances).toHaveLength(0);
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run utils/genieAudition.test.ts`
Expected: 4 passed, 0 failed。

- [ ] **Step 4: 设置页按钮**

把 T1 留的 `{/* T2: 试听按钮插这里 */}` 占位行替换为完整按钮（`isTesting` state 放在 T1 三个 state 之后；`auditionGenieVoice` 的 import 与 T1 的 import 加在同一处）：
```tsx
const [isTestingGenieVoice, setIsTestingGenieVoice] = useState(false);
```
```tsx
<button
    type="button"
    onClick={() => {
      if (isTestingGenieVoice) return;
      setIsTestingGenieVoice(true);
      auditionGenieVoice(apiConfig)
        .then(() => addToast('Genie 试听已开始', 'success'))
        .catch((e: any) => addToast(e?.message || 'Genie 试听失败', 'error'))
        .finally(() => setIsTestingGenieVoice(false));
    }}
    disabled={isTestingGenieVoice}
    className="w-full rounded-xl border px-3 py-2 text-sm font-semibold border-slate-200 bg-white/70 text-slate-700 disabled:opacity-50"
>
    {isTestingGenieVoice ? '试听中…' : '试听 Genie 语音'}
</button>
```
（播完即止、不支持中途停止：helper 内部已接 `onended`/`onerror` 自释放，与注释对齐，故不保留 stop 句柄。）

同一 Genie 区内、试听按钮之后追加清空缓存按钮（完整粘贴；`clearTtsCache` 来自 T3 新增的 `utils/ttsCache.ts`，**本步骤开工前确认 T3 已落地**）：
```tsx
<button
    type="button"
    onClick={async () => {
      try {
        const n = await clearTtsCache();
        addToast(n > 0 ? `已清空语音缓存 ${n} 条` : '语音缓存本来就是空的', 'success');
      } catch {
        addToast('清空语音缓存失败', 'error');
      }
    }}
    className="w-full rounded-xl border px-3 py-2 text-sm font-semibold border-slate-200 bg-white/70 text-slate-700"
>
    清空语音缓存
</button>
```
并在 T2 的 import 行旁加：`import { clearTtsCache } from '../utils/ttsCache';`。说明行（按钮下方小字，已在 T1 区文案里预留位置，没有就加一行）：“持久缓存只存旧三家音频，Genie 从不写入；清空只删 `tts_` 条目，收藏/图片等其他 assets 不动。”
样式镜像同区 radio 按钮的中性风格，不引入新颜色体系。`apiConfig` 在 Settings 全文件作用域内已可用。

- [ ] **Step 5: 角色页按钮**

`apps/Character.tsx` 顶部 import 区（`:26` 的 elevenLabs import 行之后）加：
```ts
import { auditionGenieVoice } from '../utils/genieAudition';
```
在 ElevenLabs 音色块结束处（`:2024` 的 `</div>` 之后、语速区 `:2026` 之前）插入完整 Genie 音色块：
```tsx
{/* Genie 音色：无需填写 ID；设置页打开 Genie 开关后该角色即用自建语音。 */}
<div className="rounded-2xl border border-slate-200/60 bg-slate-50/40 p-2.5 space-y-1.5">
    <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Genie 音色</div>
        <button
            type="button"
            onClick={() => void handleTestGenieVoice()}
            disabled={isTestingGenieVoice}
            className="text-[10px] rounded-lg border border-slate-200 bg-white px-2 py-1 font-bold text-slate-600 disabled:opacity-50"
        >
            {isTestingGenieVoice ? '试听中…' : '试听'}
        </button>
    </div>
    <p className="text-[10px] text-slate-400">自建 Genie-TTS，无需填写音色 ID；设置里打开 Genie 开关后使用，与 MiniMax、鱼声、ElevenLabs 音色分别保存。</p>
</div>
```
handler 放在 `handleTestElevenLabsVoice`（`:251-284`）之后，镜像其结构，完整内容：
```ts
const [isTestingGenieVoice, setIsTestingGenieVoice] = useState(false);
const handleTestGenieVoice = async () => {
  if (!formData || isTestingGenieVoice) return;
  setIsTestingGenieVoice(true);
  try {
    const { stop } = await auditionGenieVoice(apiConfig, formData?.name);
    void stop;
    addToast('Genie 试听已开始', 'success');
  } catch (error: any) {
    addToast(error?.message || 'Genie 试听失败', 'error');
  } finally {
    setIsTestingGenieVoice(false);
  }
};
```
（首行守卫与 ElevenLabs 版 `:250` 同形：null 时直接返回，不进 try/catch 吞成含混 toast。`apiConfig` 来自 `useOS()` `:100`；`void stop` 占位——页面级试听播完即止，不提供中途停止。）**不要**加任何 ID 输入框（Genie 没有 per-char ID 概念）。

- [ ] **Step 6: 跑测试 + 类型确认通过**

Run: `pnpm vitest run utils/genieAudition.test.ts utils/genieSettings.test.ts`
Expected: 全绿。
Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^(apps/Settings\.tsx|apps/Character\.tsx|utils/genieAudition)'`
Expected: 无输出。

- [ ] **Step 7: 提交**

```bash
git add utils/genieAudition.ts utils/genieAudition.test.ts apps/Settings.tsx apps/Character.tsx
git commit -m "feat(voice): Genie audition in Settings and character page"
```

---

### Task 3: 约会缓存键加情绪 + 缓存有界（插入序淘汰 + 修剪 + 清空）

**Files:**
- Create: `utils/dateVoiceCache.ts`
- Create: `components/date/dateVoiceCache.test.ts`
- Modify: `components/date/DateSession.tsx`（声明换 Map + 4 个区域，读写点见 Step 4 枚举表）
- Modify: `utils/ttsCache.ts`（末尾追加修剪/清空 + save 计数门）
- Create: `utils/ttsCache.test.ts`

**Interfaces:**
- Consumes: 各站点的现有 emotion 变量（`currentLineEmotionRef.current`、 Novel 的 `voiceEmotion` 参数、`target.voiceEmotion`）——均为已在作用域内的值，不新增数据源。
- Produces: `dateVoiceCacheKey(text, emotion)`（本任务内自产自销）。

**Background:** 4 处缓存键今天全是裸文本（`:352`、`:385`、`:406`、`:496`），同一句台词 `calm` 与 `sad` 命中同一条。spec §8.2-8 点名这就是回归项。键是不透明字符串（只做全等比较，从不解析），分隔符用 `‖`（U+2016，CJK 文本实质上不会出现；即使出现也只是全等比较，不产生歧义）。加情绪维度后条目数翻倍，故同任务内把缓存做有界：进程内 Map 上限 30 条、淘汰即 revoke blob URL；ttsCache 上限 300 条按次分摊修剪 + 设置页手动清空（按钮在 T2）。命中语义不变：同键同情绪仍命中，只是超限部分会被淘汰后重合成。

- [ ] **Step 1: 新建键函数**

创建 `utils/dateVoiceCache.ts`，完整内容：
```ts
/** 约会语音进程内缓存的键：文本 + 情绪。情绪不同必须不同键（spec §8.2-8），
 * 否则同一句台词 calm/sad 会播出同一段音频。键不透明，只做全等比较。 */
export function dateVoiceCacheKey(text: string, emotion?: string | null): string {
  return `${text}‖${emotion ?? ''}`;
}

/** 进程内缓存上限（条）。一条 Genie WAV 约 64–192KB，30 条封顶约 4.5MB，
 * 对单次约会会话绰绰有余；超了淘汰最久未用的，绝不无限涨。
 *（用户明确要求：缓存必须有界，否则内存只涨不掉。） */
export const DATE_VOICE_CACHE_LIMIT = 30;

/** 带上限的写入：Map 按插入序淘汰最旧；被淘汰条若是 blob: URL 则 revoke。
 * 不 revoke 的话 Blob 常驻内存，播多少句都释放不掉——这正是"占内存"的根因。
 * remoteUrl（http(s)）不归我们管，只放行不释放（revokeObjectURL 对非 blob:
 * URL 本来也是 no-op，这里显式守卫纯为可读）。
 * 注意 DateSpeechResult 只活在 DateSession.tsx（:143），这里故意不用它，
 * 只取最小结构做泛型，避免 utils 反向依赖组件文件。 */
export function setVoiceCacheWithLimit<T extends { url: string }>(
  cache: Map<string, T>,
  key: string,
  speech: T,
  limit: number = DATE_VOICE_CACHE_LIMIT,
): void {
  limit = Math.max(1, limit); // limit≤0 会删掉刚插入条目并 revoke 其 URL，调用方拿到死链——直接钳住
  const prev = cache.get(key);
  // 复写同一键时旧 blob 若不再被任何条目引用必须先放掉，否则换多少次情绪都漏一个 blob。
  // 注意：先取 prev 再 delete，不调 helper 递归（递归会重复走淘汰循环）。
  if (prev && prev !== speech) {
    try {
      if (typeof prev.url === 'string' && prev.url.startsWith('blob:')) {
        URL.revokeObjectURL(prev.url);
      }
    } catch { /* ignore */ }
  }
  cache.delete(key); // 先删再插：刷新 recency，复写同一键不误杀
  cache.set(key, speech);
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const victim = cache.get(oldest.value);
    cache.delete(oldest.value);
    try {
      if (victim && typeof victim.url === 'string' && victim.url.startsWith('blob:')) {
        URL.revokeObjectURL(victim.url);
      }
    } catch { /* ignore：释放失败不能影响播放链路 */ }
  }
}
```

- [ ] **Step 2: 写测试**

创建 `components/date/dateVoiceCache.test.ts`（放在 components/date 下是为了让 spec §8.2-1 的 `pnpm vitest run ... components/date` 字面命令有文件可跑；vitest include 已覆盖 `components/**/*.test.{ts,tsx}`），完整内容（setup 说明：`synthesizeSpeechGenieDetailed` 无 agentUrl 即抛，故必须写 localStorage；node 下无 `URL.createObjectURL`，必须 stub；T7 落地后合成要求 RIFF + `fmt ` 头，故 fixture 必须带两者）：
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dateVoiceCacheKey, DATE_VOICE_CACHE_LIMIT, setVoiceCacheWithLimit } from '../../utils/dateVoiceCache';
import * as ttsCache from '../../utils/ttsCache';
import { synthesizeSpeechGenieDetailed } from '../../utils/genieTts';

const AGENT = 'https://agent.test';

const wavBytes = () => {
  const buf = new ArrayBuffer(2048);
  const u8 = new Uint8Array(buf);
  u8.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  u8.set([0x66, 0x6d, 0x74, 0x20], 12); // 'fmt '
  return buf;
};

const revoked: string[] = [];

beforeEach(() => {
  revoked.length = 0;
  localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: AGENT, agentToken: 'tok' }));
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:date-1',
    revokeObjectURL: (u: string) => { revoked.push(u); },
  } as any);
});
afterEach(() => { localStorage.removeItem('os_api_config'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('dateVoiceCacheKey', () => {
  it('同文本不同情绪键不同', () => {
    expect(dateVoiceCacheKey('你回来啦', 'calm')).not.toBe(dateVoiceCacheKey('你回来啦', 'sad'));
  });
  it('同文本同情绪键相同', () => {
    expect(dateVoiceCacheKey('你回来啦', 'calm')).toBe(dateVoiceCacheKey('你回来啦', 'calm'));
  });
  it('无情绪时稳定（undefined 与缺省一致）', () => {
    expect(dateVoiceCacheKey('你回来啦')).toBe(dateVoiceCacheKey('你回来啦', undefined));
    expect(dateVoiceCacheKey('你回来啦', null)).toBe(dateVoiceCacheKey('你回来啦', undefined));
  });
});

describe('Genie 跳过共享缓存', () => {
  it('Genie 合成零读写 ttsCache（结构性跳过，钉死防回归）', async () => {
    const getSpy = vi.spyOn(ttsCache, 'getCachedTts');
    const saveSpy = vi.spyOn(ttsCache, 'saveCachedTts');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wavBytes(), {
      status: 200, headers: { 'content-type': 'audio/wav' },
    })));
    try {
      await synthesizeSpeechGenieDetailed('测试', { id: 'c1' } as any, { genieVoiceEnabled: true } as any);
      expect(getSpy).not.toHaveBeenCalled();
      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      getSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });
});

describe('setVoiceCacheWithLimit', () => {
  it('超上限淘汰最旧且 revoke 其 blob URL', () => {
    const cache = new Map<string, { url: string }>();
    for (let i = 0; i < DATE_VOICE_CACHE_LIMIT; i++) {
      setVoiceCacheWithLimit(cache, `k${i}`, { url: `blob:old-${i}` });
    }
    expect(cache.size).toBe(DATE_VOICE_CACHE_LIMIT);
    setVoiceCacheWithLimit(cache, 'k-new', { url: 'blob:new' });
    expect(cache.size).toBe(DATE_VOICE_CACHE_LIMIT);
    expect(cache.has('k0')).toBe(false);
    expect(cache.has('k-new')).toBe(true);
    expect(revoked).toEqual(['blob:old-0']);
  });

  it('复写同一键刷新 recency，不误杀（旧 blob 照样释放）', () => {
    const cache = new Map<string, { url: string }>();
    for (let i = 0; i < DATE_VOICE_CACHE_LIMIT; i++) {
      setVoiceCacheWithLimit(cache, `k${i}`, { url: `blob:${i}` });
    }
    setVoiceCacheWithLimit(cache, 'k0', { url: 'blob:k0-v2' });
    setVoiceCacheWithLimit(cache, 'k-new', { url: 'blob:new' });
    expect(cache.has('k0')).toBe(true);
    expect(cache.has('k1')).toBe(false);
    // 复写 k0 时旧 'blob:0' 先被 revoke，加 k-new 时淘汰 k1 再 revoke 'blob:k1'
    expect(revoked).toEqual(['blob:0', 'blob:k1']);
  });

  it('非 blob URL 只放行不释放', () => {
    const cache = new Map<string, { url: string }>();
    for (let i = 0; i < DATE_VOICE_CACHE_LIMIT; i++) {
      setVoiceCacheWithLimit(cache, `k${i}`, { url: `https://cdn.example/${i}.wav` });
    }
    setVoiceCacheWithLimit(cache, 'k-new', { url: 'blob:new' });
    expect(cache.size).toBe(DATE_VOICE_CACHE_LIMIT);
    expect(revoked).toEqual([]);
  });

  it('自定义小上限同样生效', () => {
    const cache = new Map<string, { url: string }>();
    setVoiceCacheWithLimit(cache, 'a', { url: 'blob:a' }, 2);
    setVoiceCacheWithLimit(cache, 'b', { url: 'blob:b' }, 2);
    setVoiceCacheWithLimit(cache, 'c', { url: 'blob:c' }, 2);
    expect([...cache.keys()]).toEqual(['b', 'c']);
    expect(revoked).toEqual(['blob:a']);
  });
});
```

- [ ] **Step 3: 跑测试确认通过（此时 DateSession 还没改，key 测试与淘汰测试应全绿，回归意义在后面步骤）**

Run: `pnpm vitest run components/date/dateVoiceCache.test.ts`
Expected: 8 passed, 0 failed（key 3 + 跳过 1 + 淘汰 4）。

- [ ] **Step 4: 改声明 + 4 处缓存键（枚举如下，逐项可数）**

先把声明从 Record 换成 Map（插入序即淘汰序；读命中不刷新 recency，复写才刷新——会话级够用，不做真 LRU）：
`components/date/DateSession.tsx:282` 的 `const voiceCacheRef = useRef<Record<string, DateSpeechResult>>({});` 改为：
```ts
const voiceCacheRef = useRef<Map<string, DateSpeechResult>>(new Map());
```
在文件顶部按既有 import 风格加：`import { dateVoiceCacheKey, setVoiceCacheWithLimit } from '../../utils/dateVoiceCache';`
4 处逐一改（emotion 来源不变；读改 `.get`，写改 helper——helper 内含淘汰 + revoke）：
1. `:352` → `const cacheKey = dateVoiceCacheKey(dialogueText, currentLineEmotionRef.current);`；`:355` → `let speech: DateSpeechResult | undefined = voiceCacheRef.current.get(cacheKey);`；`:362` → `setVoiceCacheWithLimit(voiceCacheRef.current, cacheKey, speech);`
2. `:385` → `const cacheKey = dateVoiceCacheKey(dialogueText, currentLineEmotionRef.current);`；`:386` → `let speech: DateSpeechResult | undefined = voiceCacheRef.current.get(cacheKey);`；`:392` → `setVoiceCacheWithLimit(voiceCacheRef.current, cacheKey, speech);`
3. `:406` → `const cached = voiceCacheRef.current.get(dateVoiceCacheKey(dialogueText, voiceEmotion));`；`:425` → `setVoiceCacheWithLimit(voiceCacheRef.current, dateVoiceCacheKey(dialogueText, voiceEmotion), speech);`
4. `:496` → `let speech: DateSpeechResult | undefined = voiceCacheRef.current.get(dateVoiceCacheKey(target.originalText, target.voiceEmotion));`；`:499` → `if (speech) setVoiceCacheWithLimit(voiceCacheRef.current, dateVoiceCacheKey(target.originalText, target.voiceEmotion), speech);`
其余逻辑（loading 态、toast、播放）一行不动。改完跑 `Select-String -Pattern 'voiceCacheRef\.current\['` 必须零命中（残留一处即漏改）。

- [ ] **Step 5: ttsCache 修剪上限 + 手动清空**

`utils/ttsCache.ts` 末尾追加（完整粘贴；`DB.getAllAssets`/`DB.deleteAsset` 见 `db.ts:1286/1343`，均已存在）：
```ts
/** tts_ 条目上限。单条 Genie WAV 约 64–192KB，300 条封顶约 45MB（最坏），
 * 相对移动端配额可接受；超了按 lastUsedAt 淘汰最旧。用户明确要求不能无限涨。
 *（条目自带 createdAt/lastUsedAt 就是为这一天准备的，见文件头注释。） */
export const TTS_CACHE_MAX_ENTRIES = 300;
const PRUNE_EVERY_N_SAVES = 20;
let saveCountSincePrune = 0;

/** 判断某次 save 之后是否该跑修剪。纯函数，单测直接钉 cadence 规则。 */
export function shouldPruneTtsCache(saveCount: number): boolean {
  return saveCount % PRUNE_EVERY_N_SAVES === 0;
}

/** 按 lastUsedAt 淘汰到上限内。返回实际删掉的条数（逐条成功计数，不是预计算）；任何失败吞掉返回已删数——
 * 修剪绝不能阻断合成。注意 getAllAssets 会全表读（含 blob），故只在
 * saveCachedTts 里按次分摊调用，不给外部高频调用。 */
export async function pruneTtsCache(maxEntries: number = TTS_CACHE_MAX_ENTRIES): Promise<number> {
  try {
    const rows = await DB.getAllAssets();
    const keys = rows
      .filter(r => typeof r?.id === 'string' && r.id.startsWith('tts_'))
      .sort((a, b) => ((a.data as any)?.lastUsedAt ?? 0) - ((b.data as any)?.lastUsedAt ?? 0))
      .map(r => r.id);
    const overflow = keys.length - maxEntries;
    if (overflow <= 0) return 0;
    let deleted = 0;
    for (const k of keys.slice(0, overflow)) {
      try { await DB.deleteAsset(k); deleted += 1; } catch { /* 单条失败继续删下一条 */ }
    }
    return deleted;
  } catch {
    console.warn('[TTS cache] prune failed');
    return 0;
  }
}

/** 清空全部 tts_ 条目（设置页"清空语音缓存"按钮用）。返回实际删掉的条数；失败返回已删数。 */
export async function clearTtsCache(): Promise<number> {
  try {
    const rows = await DB.getAllAssets();
    const keys = rows.filter(r => typeof r?.id === 'string' && r.id.startsWith('tts_')).map(r => r.id);
    let deleted = 0;
    for (const k of keys) {
      try { await DB.deleteAsset(k); deleted += 1; } catch { /* ignore */ }
    }
    return deleted;
  } catch {
    console.warn('[TTS cache] clear failed');
    return 0;
  }
}
```
再改 `saveCachedTts`（`:66-74`）尾部、`await DB.saveAssetRaw(key, entry);` 之后加三行（catch 块之前）：
```ts
    saveCountSincePrune += 1;
    if (shouldPruneTtsCache(saveCountSincePrune)) pruneTtsCache().catch(() => {});
```
`catch (e)` 分支不动。只过滤 `tts_` 前缀：用户收藏/图片等其他 assets 行一律不碰。

创建 `utils/ttsCache.test.ts`（`./db` 用提升安全的工厂 mock，Map 内存实现；完整粘贴）：
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => {
  const m = new Map<string, any>();
  return {
    DB: {
      getAssetRaw: (id: string) => Promise.resolve(m.get(id) ?? null),
      saveAssetRaw: (id: string, data: any) => { m.set(id, data); return Promise.resolve(); },
      deleteAsset: (id: string) => { m.delete(id); return Promise.resolve(); },
      getAllAssets: () => Promise.resolve([...m.entries()].map(([id, data]) => ({ id, data }))),
      __clear: () => m.clear(),
    },
  };
});

import { DB } from './db';
import { clearTtsCache, pruneTtsCache, shouldPruneTtsCache, TTS_CACHE_MAX_ENTRIES } from './ttsCache';

const seed = async (n: number, prefix = 'tts_', base = 0) => {
  for (let i = 0; i < n; i++) {
    await DB.saveAssetRaw(`${prefix}${i}`, { blob: {}, createdAt: base + i, lastUsedAt: base + i });
  }
};

beforeEach(() => { (DB as any).__clear(); });

describe('shouldPruneTtsCache', () => {
  it('每 20 次触发一次', () => {
    expect(shouldPruneTtsCache(20)).toBe(true);
    expect(shouldPruneTtsCache(40)).toBe(true);
    expect(shouldPruneTtsCache(19)).toBe(false);
    expect(shouldPruneTtsCache(1)).toBe(false);
  });
});

describe('pruneTtsCache', () => {
  it('超上限淘汰最旧，保留最新', async () => {
    await seed(5);
    const deleted = await pruneTtsCache(3);
    expect(deleted).toBe(2);
    expect(await DB.getAssetRaw('tts_0')).toBeNull();
    expect(await DB.getAssetRaw('tts_1')).toBeNull();
    expect(await DB.getAssetRaw('tts_4')).not.toBeNull();
  });

  it('未超上限不动', async () => {
    await seed(3);
    expect(await pruneTtsCache(300)).toBe(0);
    expect(await DB.getAssetRaw('tts_0')).not.toBeNull();
  });

  it('非 tts_ 行一律不碰', async () => {
    await DB.saveAssetRaw('fav_1', { blob: {} });
    await seed(5);
    const deleted = await pruneTtsCache(3);
    expect(deleted).toBe(2);
    expect(await DB.getAssetRaw('fav_1')).not.toBeNull();
  });
});

describe('clearTtsCache', () => {
  it('清空全部 tts_ 并返回条数，非 tts_ 保留', async () => {
    await DB.saveAssetRaw('fav_1', { blob: {} });
    await seed(4);
    expect(await clearTtsCache()).toBe(4);
    expect(await DB.getAssetRaw('tts_0')).toBeNull();
    expect(await DB.getAssetRaw('fav_1')).not.toBeNull();
  });

  it('空库返回 0', async () => {
    expect(await clearTtsCache()).toBe(0);
  });
});
```

- [ ] **Step 6: 跑测试 + 类型确认通过**

Run: `pnpm vitest run components/date utils/datePrompts.test.ts utils/ttsCache.test.ts`
Expected: 全绿。
Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^(components/date/DateSession\.tsx|components/date/dateVoiceCache|utils/dateVoiceCache|utils/ttsCache)'`
Expected: 无输出。

- [ ] **Step 7: 提交**

```bash
git add utils/dateVoiceCache.ts components/date/dateVoiceCache.test.ts components/date/DateSession.tsx utils/ttsCache.ts utils/ttsCache.test.ts
git commit -m "fix(date): emotion cache keys with bounded eviction; prune and clear TTS cache"
```

---

### Task 4: 下载后缀 .wav + MIME

**Files:**
- Create: `utils/voiceDownload.ts`
- Create: `utils/voiceDownload.test.ts`
- Modify: `apps/Chat.tsx`（`:720`、`:722` 两行）
- Modify: `apps/CallApp.tsx`（`:1427`、`:1428` 两行）

**Interfaces:**
- Consumes: `isGenieVoiceEnabled(apiConfig)`（`genieTts.ts:39`；两处调用方 apiConfig 均已在作用域内：Chat 经 `useOS()` `:147`，CallApp 经 `useOS()` `:521`)。
- Produces: `voiceDownloadFileName`、`voiceDownloadMime`（本任务内自产自销）。

**Background:** 两处下载今天写死 `.mp3` 后缀 + `audio/mpeg` 类型。Genie 产出的是 WAV；以后缀/MIME 错配进系统分享面板会走错路由。StoredVoice 记录里没有 provider 字段（`Chat.tsx:465-472` 只有 blob/remoteUrl/favorite/originalText/spokenText/lang），所以后缀与 MIME 一律按**下载时刻的开关状态**决定。已接受的边界：合成后、下载前切换开关会导致后缀与内容不一致——只是文件名问题，内容照播，不做跨时一致性（那需要改 StoredVoice 结构，超纲）。另注：`Chat.tsx:755`、`CallApp.tsx:2227/2232` 还有两处 `audio/mpeg`，走的是**收藏路径**的 `fallbackMime`，不是下载后缀，不在本任务范围内；执行到 Step 4 改调用点时顺手确认 Genie 收藏 blob 的实际类型能正常播放即可，不阻塞、不改代码。

- [ ] **Step 1: 新建纯函数模块**

创建 `utils/voiceDownload.ts`，完整内容：
```ts
/** Genie 产出 WAV，其余引擎产出 MP3。以后缀与 MIME 同时切换，分享面板才不会走错路由。 */
export function voiceDownloadFileName(base: string, id: string | number, isGenie: boolean): string {
  const safe = base.replace(/[\\/:*?"<>|]/g, '_');
  return isGenie ? `${safe}_语音_${id}.wav` : `${safe}_语音_${id}.mp3`;
}

export function voiceDownloadMime(isGenie: boolean): 'audio/wav' | 'audio/mpeg' {
  return isGenie ? 'audio/wav' : 'audio/mpeg';
}
```
（`safe` 的正则与两处现有代码逐字一致。）

- [ ] **Step 2: 写测试**

创建 `utils/voiceDownload.test.ts`，完整内容：
```ts
import { describe, expect, it } from 'vitest';
import { voiceDownloadFileName, voiceDownloadMime } from './voiceDownload';

describe('voiceDownloadFileName', () => {
  it('Genie 用 .wav', () => {
    expect(voiceDownloadFileName('小糖', 42, true)).toBe('小糖_语音_42.wav');
  });
  it('非 Genie 用 .mp3', () => {
    expect(voiceDownloadFileName('小糖', 42, false)).toBe('小糖_语音_42.mp3');
  });
  it('非法文件名字符照旧清洗', () => {
    expect(voiceDownloadFileName('a/b:c', 1, true)).toBe('a_b_c_语音_1.wav');
  });
});

describe('voiceDownloadMime', () => {
  it('Genie audio/wav，否则 audio/mpeg', () => {
    expect(voiceDownloadMime(true)).toBe('audio/wav');
    expect(voiceDownloadMime(false)).toBe('audio/mpeg');
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run utils/voiceDownload.test.ts`
Expected: 4 passed, 0 failed。

- [ ] **Step 4: 改两处调用点**

`apps/Chat.tsx`：在 `handleDownloadVoice` 内、现有 `stored` 读取之后加一行 `const genie = isGenieVoiceEnabled(apiConfig);`（import 按既有风格加 `import { isGenieVoiceEnabled } from '../utils/genieTts';`），然后：
`:720` 的 `fetchBlobForShare(stored.remoteUrl, 'audio/mpeg')` → `fetchBlobForShare(stored.remoteUrl, voiceDownloadMime(genie))`（加 `import { voiceDownloadFileName, voiceDownloadMime } from '../utils/voiceDownload';`）
`:722` 的 `` `${(char?.name || '语音').replace(/[\\/:*?"<>|]/g, '_')}_语音_${msg.id}.mp3` `` → `voiceDownloadFileName(char?.name || '语音', msg.id, genie)`
`apps/CallApp.tsx`：同理，`:1427-1428` 的两行改成 helper 调用，`selectedChar?.name || '通话'` 与 `ts || Date.now()` 原样传入。其余逻辑（toast、shareOrDownloadBlob）一行不动。

- [ ] **Step 5: 跑测试 + 类型确认通过**

Run: `pnpm vitest run utils/voiceDownload.test.ts`
Expected: 全绿。
Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^(apps/Chat\.tsx|apps/CallApp\.tsx|utils/voiceDownload)'`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add utils/voiceDownload.ts utils/voiceDownload.test.ts apps/Chat.tsx apps/CallApp.tsx
git commit -m "feat(voice): .wav suffix and MIME for Genie downloads"
```

---

### Task 5: 诊断加 Genie/APK 说明

**Files:**
- Modify: `utils/networkFailureDiagnosis.ts`（末尾追加 1 个函数）
- Create: `utils/networkFailureDiagnosis.genie.test.ts`

**Interfaces:** 无上下游依赖（纯新增导出；本阶段不接任何 UI 调用点，留给调试终端与后续诊断链路使用——这点要在提交信息里写明，避免后人误以为它已接线）。

**Background:** APK 本地壳没有 `/agent` 路由（见 `:426-430` 注释），`genie_unavailable` 在壳里与在桌面浏览器里是两种完全不同的病因，现有文案只会让人去查梯子/DNS。

- [ ] **Step 1: 加函数**

在 `utils/networkFailureDiagnosis.ts` 文件末尾追加：
```ts
/** Genie 合成失败的诊断一句话。APK 本地壳（origin hostname 为 localhost）没有
 * /agent 路由，genie_unavailable 在那里几乎总是"agentUrl 没指向公网后端"，
 * 不要按梯子/DNS 去查。桌面端才走通用主代理不可达清单。 */
export function describeGenieFailure(code: string, pageOrigin?: string): string {
  const inApkShell = (() => {
    try {
      return new URL(pageOrigin ?? (typeof location !== 'undefined' ? location.origin : '')).hostname === 'localhost';
    } catch {
      return false;
    }
  })();
  if (code === 'genie_unavailable' && inApkShell) {
    return 'Genie 失败：当前在 APK 本地壳里，没有 /agent 路由。去设置里把主代理地址（agentUrl）改成公网后端域名，不要填 127.0.0.1 也不要留空。';
  }
  if (code === 'genie_unavailable') {
    return 'Genie 失败：浏览器连不上主代理。按顺序查：主代理地址是否可访问、令牌对不对、VPS 上 main-agent 在不在跑。';
  }
  if (code === 'synth_timeout') {
    return 'Genie 失败：120 秒合成上限被触发（多为长文本或排队）。拆短再试；连续出现去看 VPS 上 genie-tts 是否被毒化（持续 503 warming_up 即需重启进程）。';
  }
  if (code === 'busy' || code === 'lock_timeout') {
    return 'Genie 失败：并发或排队撞上限（队列上限 2）。等几秒再试；这是设计内的降级，不是故障。';
  }
  return '';
}
```

- [ ] **Step 2: 写测试**

创建 `utils/networkFailureDiagnosis.genie.test.ts`，完整内容：
```ts
import { describe, expect, it } from 'vitest';
import { describeGenieFailure } from './networkFailureDiagnosis';

describe('describeGenieFailure', () => {
  it('APK 壳里的 genie_unavailable 指向 agentUrl，不提梯子', () => {
    const msg = describeGenieFailure('genie_unavailable', 'https://localhost');
    expect(msg).toContain('agentUrl');
    expect(msg).not.toContain('梯子');
  });
  it('桌面端的 genie_unavailable 走主代理清单', () => {
    const msg = describeGenieFailure('genie_unavailable', 'https://app.example.com');
    expect(msg).toContain('主代理');
  });
  it('synth_timeout 提到 120 秒与毒化', () => {
    const msg = describeGenieFailure('synth_timeout');
    expect(msg).toContain('120');
  });
  it('busy/lock_timeout 说明是设计内降级', () => {
    expect(describeGenieFailure('busy')).toContain('设计内');
    expect(describeGenieFailure('lock_timeout')).toContain('设计内');
  });
  it('未知码返回空串', () => {
    expect(describeGenieFailure('no_such_code')).toBe('');
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run utils/networkFailureDiagnosis.genie.test.ts`
Expected: 5 passed, 0 failed。

- [ ] **Step 4: 提交**

```bash
git add utils/networkFailureDiagnosis.ts utils/networkFailureDiagnosis.genie.test.ts
git commit -m "feat(diagnosis): Genie failure lines with APK-specific guidance"
```

---

### Task 6: 见面 [v:xxx] 指南的 Genie 参数化（去 disgusted）

**Files:**
- Modify: `utils/datePrompts.ts`（`:26` import 扩展 + `buildVNModeBlock` 导出 + `:631` 参数化）
- Create: `utils/dateVoiceGuide.test.ts`

**Interfaces:** 无上下游依赖（读 Genie 单例，只写 prompt 文本）。

**Background:** 见面语音情绪 `[v:xxx]` 在 `DateSession.tsx:34-39` 用 `VALID_EMOTIONS`（8 条：7 条目录项 + `fluent`）校验，指南正文（`promptPresetCatalog.ts:181` 的 voice.date 条目）教模型 `xxx 仅限 happy/sad/angry/fearful/disgusted/surprised/calm`（目录原文 7 条，含 `disgusted`、无 `fluent`）。Genie 下 `disgusted` 会静默回落 `calm`——与阶段 A 的 chatPrompts 问题同构，同法治（节点内替换 + 字面量守卫测试）。**catalog 本体一个字不许动**（迁移链禁区）；`buildVNModeBlock` 所在函数无 apiConfig 参数（签名见 `:600-606`：char/userName/geo/sceneBlock），所以必须走 `isGenieVoiceEnabledSync()` 单例——与阶段 A 的 chatPrompts 做法一致。本任务内"目录 7 条原文"指 catalog 字面量（含 disgusted），"Genie 去 disgusted 版"指去掉 `/disgusted` 后的 6 条，一律以字面量为准，不以条数名指代。

- [ ] **Step 1: import 扩展 + 导出函数**

`utils/datePrompts.ts:26` 的 `import { getVoicePromptOverride } from './ttsProvider';` 改为：
```ts
import { getVoicePromptOverride, isGenieVoiceEnabledSync } from './ttsProvider';
```
`utils/datePrompts.ts:599` 的 `const buildVNModeBlock = (` 改为：
```ts
export const buildVNModeBlock = (
```

- [ ] **Step 2: 参数化（目录原文逐字照抄 catalog :181）**

定义两个模块级常量（放在 `DATE_VOICE_GUIDE` 定义 `:42` 之后）：
```ts
/** catalog voice.date 条目里的目录原文（promptPresetCatalog.ts:181），7 条，逐字照抄，仅作替换锚点。 */
const DATE_VOICE_CATALOG = 'xxx 仅限 happy/sad/angry/fearful/disgusted/surprised/calm';
/** Genie 版：去 disgusted（无参考音频，会静默回落 calm，不如不教），剩 6 条。 */
const DATE_VOICE_GENIE = 'xxx 仅限 happy/sad/angry/fearful/surprised/calm';
```
把 `:631` 改成三段式：
```ts
const dateVoiceGuideRaw = char.dateVoiceEnabled ? (resolveVoiceGuideSync('voice.date', getVoicePromptOverride('dateVoice')) ?? DATE_VOICE_GUIDE) : '';
// Genie 没有 disgusted 参考音频：自定义覆盖若含目录原文同样替换；不含则原样返回（replace 无命中是安全的）。
const dateVoiceGuide = isGenieVoiceEnabledSync() ? dateVoiceGuideRaw.replace(DATE_VOICE_CATALOG, DATE_VOICE_GENIE) : dateVoiceGuideRaw;
```
并把模板里 `:631` 的 `${...}` 换成 `${dateVoiceGuide}`。注意 `const` 必须放在 `return` 模板之前、函数体内（`:607-622` 的 const 区之后）。

- [ ] **Step 3: 写守卫测试（字面量放测试文件里，不 import 生产常量）**

创建 `utils/dateVoiceGuide.test.ts`，完整内容（字面量与生产常量逐字对齐，命名同步；不断言生产常量本身，只断言产出文本）：
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildVNModeBlock } from './datePrompts';
import { setGenieVoiceEnabled } from './ttsProvider';

const CATALOG = 'xxx 仅限 happy/sad/angry/fearful/disgusted/surprised/calm';
const GENIE = 'xxx 仅限 happy/sad/angry/fearful/surprised/calm';

const char = {
  id: 'date-guide-test',
  name: '测试角色',
  dateVoiceEnabled: true,
} as any;

afterEach(() => { setGenieVoiceEnabled(false); });

describe('date voice guide emotion list', () => {
  it('Genie 关闭时保留目录原文', () => {
    setGenieVoiceEnabled(false);
    const prompt = buildVNModeBlock(char, '测试用户');
    expect(prompt).toContain(CATALOG);
    expect(prompt).not.toContain(GENIE);
  });

  it('Genie 开启时用去 disgusted 版，不教 disgusted', () => {
    setGenieVoiceEnabled(true);
    const prompt = buildVNModeBlock(char, '测试用户');
    expect(prompt).toContain(GENIE);
    expect(prompt).not.toContain('disgusted');
  });

  it('dateVoiceEnabled 关闭时整段不出', () => {
    setGenieVoiceEnabled(true);
    const prompt = buildVNModeBlock({ ...char, dateVoiceEnabled: false }, '测试用户');
    expect(prompt).not.toContain('xxx 仅限');
  });
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run utils/dateVoiceGuide.test.ts`
Expected: 3 passed, 0 failed。

- [ ] **Step 5: 跑关联回归（Date 提示词全套）**

Run: `pnpm vitest run utils/datePrompts.test.ts utils/dateVoiceGuide.test.ts`
Expected: 全绿。

- [ ] **Step 6: 类型确认 + 提交**

Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^(utils/datePrompts\.ts|utils/dateVoiceGuide)'`
Expected: 无输出。
```bash
git add utils/datePrompts.ts utils/dateVoiceGuide.test.ts
git commit -m "feat(date): Genie voice emotion list without disgusted, byte-guarded"
```

---

### Task 7: 代理与客户端合同加固

**Files:**
- Modify: `api/backend-proxy.ts`（`:95-97` 后加 2 行）
- Modify: `api/backend-proxy.test.ts`（加 1 个 case）
- Modify: `utils/genieTts.ts`（ERROR_TEXT 加 2 码；合成成功处加 WAV 校验）
- Modify: `utils/genieTts.test.ts`（加 3 个 case）

**Interfaces:**
- Consumes: T1 对 `genieTts.ts:43` 的导出改动（同一文件先后写：**本任务必须在 T1 落地后开工**，动手前先 `git log --oneline -3` 确认 T1 提交已在）。
- Produces: 无（终端加固项）。

**Background:** 三个都是终审点名的可延期项，互不相干但都小，合一个 reviewer gate：Vercel 链路丢情绪头（`api/backend-proxy.ts:93-106` 只透 `Content-Type` + `Cache-Control`）；控制面两码（main-agent 的 `unauthorized`、`method_not_allowed`）在客户端只有通用 `语音服务返回 <status>`；合成成功只验长度不验结构（`genieTts.ts:92-93` 的 44 字节门）。

- [ ] **Step 1: 代理透情绪头**

在 `api/backend-proxy.ts` 的 `:95-97`（Content-Type / Cache-Control 转发）之后加：
```ts
const ge = upstream.headers.get('x-genie-resolved-emotion');
if (ge) res.setHeader('X-Genie-Resolved-Emotion', ge);
```
其余不动（502 `Backend unreachable` 分支不动；body 管道不动）。

- [ ] **Step 2: 代理测试加完整 case**

在 `api/backend-proxy.test.ts` 末尾、`it('upstream failure → 502', ...)` 整个 case 之后、describe 收尾的 `});` 之前，插入完整 case（mock 形状沿用该文件既有的 `mockRes`/`mockReq`/`vi.stubGlobal('fetch', ...)`，一字不改直接粘贴）：
```ts
  it('forwards X-Genie-Resolved-Emotion on audio responses', async () => {
    const wav = new Uint8Array(2048);
    wav.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    wav.set([0x66, 0x6d, 0x74, 0x20], 12); // 'fmt '
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wav.buffer as ArrayBuffer, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav', 'X-Genie-Resolved-Emotion': 'sad' },
    })));
    const res = mockRes();
    await handler(mockReq({ query: { ns: 'agent', rest: 'v1/tts' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-genie-resolved-emotion']).toBe('sad');
    expect(res.headers['content-type']).toContain('audio/wav');
  });
```
其余 case 一行不动。

- [ ] **Step 3: 修既有 mock（前置条件，不修后面全红）**

`utils/genieTts.test.ts` 里四个成功用例（`:36`、`:44`、`:56`、`:67`）全用 `new ArrayBuffer(2048)` 全零 body。Step 5 的 WAV 校验落地后，这四个会全部抛"损坏"。先修 fixture：
1. 在 `makeResponse` 定义（`:11-19`）之后加 helper（完整粘贴）：
```ts
const wavBytes = () => {
  const buf = new ArrayBuffer(2048);
  const u8 = new Uint8Array(buf);
  u8.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  u8.set([0x66, 0x6d, 0x74, 0x20], 12); // 'fmt '
  return buf;
};
```
2. 把四个 `makeResponse(200, new ArrayBuffer(2048))` 全改成 `makeResponse(200, wavBytes())`（四个调用点逐字相同，用 replaceAll，改完数一下必须是 4 处；`413` 用例是字符串 body，不要动）。

- [ ] **Step 4: ERROR_TEXT 加 2 码**

在 `utils/genieTts.ts:19-32` 的 map 末尾（`genie_unavailable` 行之后）加：
```ts
unauthorized: '主代理鉴权失败，请检查令牌',
method_not_allowed: '请求方法不正确',
```

- [ ] **Step 5: 合成成功加 WAV 结构校验**

把 `utils/genieTts.ts:92-93`：
```ts
const buf = await res.arrayBuffer();
if (buf.byteLength < 44) throw new Error('语音服务返回了空音频');
```
改成：
```ts
const buf = await res.arrayBuffer();
if (buf.byteLength < 44) throw new Error('语音服务返回了空音频');
const magic = new TextDecoder().decode(buf.slice(0, 4));
const fmt = new TextDecoder().decode(buf.slice(12, 16));
if (magic !== 'RIFF' || fmt !== 'fmt ') throw new Error('语音服务返回了损坏的音频');
```
（44 字节门保留在前：短包先报空音频，不走到魔数分支。）

- [ ] **Step 6: 客户端测试加 3 个完整 case**

在 `utils/genieTts.test.ts` 第一个 describe 末尾（`413` 用例之后、`:93` 的 `});` 之前）追加完整代码（`makeResponse` 与 `char`/`apiConfig` 沿用该文件既有定义；`wavBytes` 是 Step 3 新增的 helper，直接用）：
```ts
  it('unauthorized 抛鉴权文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(401, '{"error":"unauthorized"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/鉴权/);
  });

  it('200 但 body 全零 → 抛损坏', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, new ArrayBuffer(2048))));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/损坏/);
  });

  it('200 + 合法 WAV 头 → 成功且 blob.type 为 audio/wav', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, wavBytes())));
    const res = await synthesizeSpeechGenieDetailed('你好', char, apiConfig);
    expect(res.blob.type).toBe('audio/wav');
    expect(res.url).toBe('blob:genie-1');
  });
```
注意第二个 case 故意保留一次全零 `new ArrayBuffer(2048)`（不套 `wavBytes()`）——它就是"损坏"路径的回归钉子，不要"顺手"改成合法头。

- [ ] **Step 7: 跑测试 + 类型确认通过**

Run: `pnpm vitest run api/backend-proxy.test.ts utils/genieTts.test.ts`
Expected: 全绿。
Run: `pnpm exec tsc --noEmit 2>&1 | Select-String -Pattern '^(api/backend-proxy|utils/genieTts)'`
Expected: 无输出。

- [ ] **Step 8: 提交**

```bash
git add api/backend-proxy.ts api/backend-proxy.test.ts utils/genieTts.ts utils/genieTts.test.ts
git commit -m "feat(tts): forward emotion header on Vercel, harden client contract"
```

---

### Task 8: 最终验收（§8.2 全过 + §8.3 冒烟）

**Files:** 无代码改动（只跑命令 + 手动流程 + 记录结果）。若某条红了，停下来修，不在本任务里"顺手改"——修完重跑该条。

**Interfaces:**
- Consumes: T1–T7 全部落地。

- [ ] **Step 1: 跑 §8.2-1–3（自动化套件）**

Run: `pnpm vitest run utils/ttsRouter utils/ttsProvider utils/genieTts components/date utils/ttsCache.test.ts`
Expected: 全绿（含 T3 新增的 `components/date/dateVoiceCache.test.ts`——这条路径此前零文件，本任务是它第一次被点名，必须有输出；`utils/ttsProvider` 子串能命中阶段 A 建的 `utils/ttsProvider.genie.test.ts`，保留它可顺带回归单例逻辑）。
Run: `pnpm vitest run worker/main-agent`
Expected: 全绿（本阶段未动，应保持 28/28）。
Run: `pnpm vitest run utils/promptPresetCatalog utils/presetEffective utils/promptPresetSeeding`
Expected: 全绿（本阶段禁区未碰，证明迁移链完好）。

- [ ] **Step 2: 跑 §8.2-4–6（静态门）**

Run: `npx tsc --noEmit 2>&1 | Select-String -Pattern '^(apps/Settings\.tsx|apps/Character\.tsx|apps/Chat\.tsx|apps/CallApp\.tsx|components/date/DateSession\.tsx|utils/(genieSettings|genieAudition|dateVoiceCache|voiceDownload|datePrompts|dateVoiceGuide|networkFailureDiagnosis|genieTts|ttsCache)|api/backend-proxy)'`
Expected: 无输出（本次触碰文件零命中；存量错误与基线一致即可）。
Run: `pnpm vitest run utils/mojibakeGuard.test.ts`
Expected: 绿。
Run（FFFD 字节扫，本次触碰的含中文文件逐个过）: 对 `apps/Settings.tsx`、`apps/Character.tsx`、`components/date/DateSession.tsx`、`utils/datePrompts.ts`、`utils/networkFailureDiagnosis.ts`、`utils/genieTts.ts`（T7 加中文文案）、`utils/ttsCache.ts`（T3 加中文注释）、`utils/dateVoiceCache.ts`（新建，含中文注释）及新增测试文件，用 Python 读字节扫 `EF BF BD` 序列。
Expected: 零命中。
Run: `node scripts/build-workers.mjs` 后 `git status --short` 只应出现 main-agent 之外的**零**改动（本阶段不该动任何 bundle；若有附带产物，`git checkout --` 回退，只留源码）。外加一行断言 main-agent bundle 仍含路由（防构建脚本行为漂移）：`Select-String -Path worker/main-agent/worker.bundle.js -Pattern '/v1/tts'` 必须命中。

- [ ] **Step 3: §8.2-7 手动（设置页选 Genie → 试听出声；Chat 选 Genie → 自动合成）**

前置：`pnpm dev` 起本地开发服；`os_api_config.agentUrl/agentToken` 配好；VPS 侧 `genie-tts` + `sullyos.service` 在跑（沿用阶段 A 的部署，不重装）。
1. 打开设置页 → Genie 开关应**默认勾选**（未保存过的新配置）→ 按保存 → toast 成功。
2. 点试听 → 出声，内容为固定试听句。
3. Chat 发一句带 `<语音>` 的消息 → 语音条出现可播放。
4. 把开关关掉 → 保存 → 同样操作回退旧引擎（行为变化肉眼可辨：后缀/音色不同）。
每步 PASS/FAIL 如实记录进报告。

- [ ] **Step 4: §8.2-8 手动（Date 缓存回归）**

在约会页让**同一句台词**分别以 `calm` 和 `sad` 触发语音（用 `[v:calm]` / `[v:sad]` 各发一次）→ 两次音频**必须不同**（长度不同即算，Genie 采样本就不确定；严禁比 hash 判相同，只判"不同"）。
FAIL 则 T3 返工。

- [ ] **Step 5: §8.3 线上冒烟（需 VPS pull + 重启 main-agent 后）**

手机端真实链路：选 Genie → 收一条语音 → 下载文件能播。令牌只从 VPS `.env` 现取现用，不回显、不落盘。探针文件放 OS 临时目录，不进仓库；跑完删除。

- [ ] **Step 6: 写验收报告并提交（报告进 ledger，不进仓库）**

验收结论（每条 PASS/FAIL + 证据行）追加到 `C:\Users\杜昱莹\AppData\Local\Temp\opencode\sdd-genie-tts-phase-a\progress.md` 末尾的新 `## Phase B acceptance` 小节。**无代码提交**（本任务不产文件）。

---

## Self-review 记录（写完即执行，不另派）

1. Spec 覆盖：§261-265 四项（设置开关区 / 角色页试听 / DateSession 缓存键 + ttsCache 跳过 / 下载后缀 + Capacitor 说明）→ T1 / T2 / T3 / T4+T5；§10.1 默认开启 → T1（`?? true` 显示态 + 仅保存写入）；终审四项可延期债务（①控制面错误码文案 → T7 Step 4/6；②客户端真实 WAV 校验 → T7 Step 5/6；③Date [v:xxx] 规则 → T6；④跨层正向矩阵 → T8 全量验收）→ 均有归属；§8.2-7/8.2-8/§8.3 → T8。§293 老用户迁移**明确不做**（Global Constraints 已列正文声明）。用户追加诉求"缓存有界" → T3（Date 有界淘汰 + revoke + ttsCache 修剪/清空）+ T2（清空按钮）+ Review Focus 第 6 项。
2. 占位扫描：无 TBD/TODO/"类似地"/"适当处理"；每处"读某文件找形状"都限定了行数上限与禁止重构。
3. 类型一致：`GenieLocalSettings` 只在 T1 内产销；`GENIE_EMOTIONS`/`GenieEmotion` 由 T1 导出，T2 不复述；`dateVoiceCacheKey(text, emotion?)` 与 `setVoiceCacheWithLimit<T extends { url: string }>(cache, key, speech, limit?)` 签名在 T3 内统一（泛型避开 Map 方差问题；`DateSpeechResult` 不跨文件引用）；`pruneTtsCache(max?)`/`clearTtsCache()` 返回 `Promise<number>`，失败一律吞掉返回 0；T6 的 `DATE_VOICE_CATALOG`（目录 7 条原文）→ `DATE_VOICE_GENIE`（去 disgusted 版 6 条）字面量与 catalog :181 逐字对齐（含 `xxx 仅限 ` 前缀），测试内 `CATALOG`/`GENIE` 同步更名。
4. Review Focus 五项各有归属测试：见 Review Focus 末尾标注。
