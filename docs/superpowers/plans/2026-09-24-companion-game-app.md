# Companion Game App Implementation Plan (Plan 1/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SullyOS 内独立游戏 App（频道聊天、悬浮窗数据、记忆开关），吃游戏频道事件，验证期纯文本。

**Architecture:** 复用 `chatGenEvents` 的 window CustomEvent 范式新建游戏频道总线；会话缓冲/节拍/快照放纯逻辑模块；App 壳照 FAQApp 最小范式注册四步。采集层（Plan 2/3）只调总线派发。

**Tech Stack:** React + TS, vitest (jsdom for DOM, node for logic), CustomEvent bus, localStorage toggle.

**Spec:** `docs/superpowers/specs/2026-09-24-game-companion-design.md` (validation scope: §7 pure-text, §8 gates, §9 loop items 1/5/6 web-side)

**Worktree:** `.worktrees/game-companion` (`feat/game-companion`). All work happens there, never on main.

## Global Constraints

- Validation only: horizontal single-area dialog, pure text, latest-only display, history cap 20.
- Game channel NEVER wires into `ProactiveChat.start/resume/onTrigger`; no `markAmsgStateDirty`/autoArchive calls from game code.
- Raw script lines NEVER leave the session buffer (snapshot carries hashes/counts only).
- Voice/audio/STT/overlay shells/vertical/ruby are Phase 2+ (other plans). Reply input dispatches an event only; no AI call in this plan.
- Commands run on Windows pwsh; prefix Chinese-output commands with `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)`.

## Review Focus

- Burst of 500 subtitle lines in 1s shows latest only with bounded memory — Task 2 test pins buffer cap + Task 3 test pins rendered latest.
- App unmount leaks a channel listener and later dispatches crash state updates — Task 1 test pins unsubscribe; Task 3 test pins post-unmount dispatch safety.
- Rapid line change records a choice against stale options — Task 2 test pins choice binds to latest options id.
- Missing/unresolved avatar breaks the ball image — Task 4 test pins fallback initial rendered.
- Snapshot JSON contains raw line text (privacy leak) — Task 2 test pins absence of pushed texts.

---

### Task 1: Worktree sync + game channel event bus

**Files:**
- Create: `utils/gameChannel.ts`
- Create: `utils/gameChannel.test.ts`
- Modify: none

**Interfaces:**
- Consumes: `window.CustomEvent`/`dispatchEvent`/`addEventListener` (pattern from `utils/chatGenEvents.ts:59`).
- Produces: `GAME_CHANNEL_EVENTS`, `SubtitleLine`, `OptionSet`, `announceGameLine`, `announceGameOptions`, `announceGameChoice`, `announceUserReply`, `subscribeGameChannel` (used by Tasks 2–4 and later Plans 2/3).

- [ ] **Step 1: Sync worktree to latest spec**

```bash
git merge ethernet --no-edit
git log --oneline -3
```

Run in: `.worktrees/game-companion`. Expected: merge ok (resolve to latest spec), log shows spec commits incl. `overlay expanded state is the game-channel chat`.

- [ ] **Step 2: Verify spec present**

```bash
grep -c "提示球" docs/superpowers/specs/2026-09-24-game-companion-design.md
```

Expected: output `>= 3`. If 0, stop: wrong branch state, do not continue.

- [ ] **Step 3: Write the failing test**

`utils/gameChannel.test.ts`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  GAME_CHANNEL_EVENTS,
  announceGameChoice,
  announceGameLine,
  announceGameOptions,
  announceUserReply,
  subscribeGameChannel,
} from './gameChannel';

describe('gameChannel', () => {
  it('delivers a subtitle line to subscribers', () => {
    const seen: string[] = [];
    const off = subscribeGameChannel(GAME_CHANNEL_EVENTS.line, (d) => seen.push(d.text));
    announceGameLine({ text: '今夜は満月だ', at: 1, source: 'pc-window' });
    off();
    expect(seen).toEqual(['今夜は満月だ']);
  });

  it('unsubscribes cleanly', () => {
    const fn = vi.fn();
    const off = subscribeGameChannel(GAME_CHANNEL_EVENTS.line, fn);
    off();
    announceGameLine({ text: 'x', at: 2, source: 'pc-window' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('delivers options, choice and user reply', () => {
    const got: unknown[] = [];
    const offs = [
      subscribeGameChannel(GAME_CHANNEL_EVENTS.options, (d) => got.push(d)),
      subscribeGameChannel(GAME_CHANNEL_EVENTS.choice, (d) => got.push(d)),
      subscribeGameChannel(GAME_CHANNEL_EVENTS.reply, (d) => got.push(d)),
    ];
    announceGameOptions({ id: 'o1', options: ['留下', '离开'], at: 3 });
    announceGameChoice({ optionsId: 'o1', index: 0, at: 4 });
    announceUserReply({ text: '选第一个', at: 5 });
    offs.forEach((off) => off());
    expect(got).toHaveLength(3);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run utils/gameChannel.test.ts`
Expected: FAIL with "Cannot find module './gameChannel'".

- [ ] **Step 5: Write minimal implementation**

`utils/gameChannel.ts` (mirror `utils/chatGenEvents.ts:59` dispatch shape):

```ts
export const GAME_CHANNEL_EVENTS = {
  line: 'game-channel:line',
  options: 'game-channel:options',
  choice: 'game-channel:choice',
  reply: 'game-channel:reply',
} as const;

export type GameChannelEventName =
  (typeof GAME_CHANNEL_EVENTS)[keyof typeof GAME_CHANNEL_EVENTS];

export interface SubtitleLine {
  text: string;
  at: number;
  source: 'pc-window' | 'scaled-window' | 'tablet-mirror';
}

export interface OptionSet {
  id: string;
  options: string[];
  at: number;
}

export interface ChoiceRecord {
  optionsId: string;
  index: number;
  at: number;
}

export interface UserReply {
  text: string;
  at: number;
}

type DetailByEvent = {
  'game-channel:line': SubtitleLine;
  'game-channel:options': OptionSet;
  'game-channel:choice': ChoiceRecord;
  'game-channel:reply': UserReply;
};

function announce<T extends GameChannelEventName>(event: T, detail: DetailByEvent[T]): void {
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

export function announceGameLine(detail: SubtitleLine): void {
  announce(GAME_CHANNEL_EVENTS.line, detail);
}

export function announceGameOptions(detail: OptionSet): void {
  announce(GAME_CHANNEL_EVENTS.options, detail);
}

export function announceGameChoice(detail: ChoiceRecord): void {
  announce(GAME_CHANNEL_EVENTS.choice, detail);
}

export function announceUserReply(detail: UserReply): void {
  announce(GAME_CHANNEL_EVENTS.reply, detail);
}

export function subscribeGameChannel<T extends GameChannelEventName>(
  event: T,
  handler: (detail: DetailByEvent[T]) => void,
): () => void {
  const listener = (e: Event): void => {
    handler((e as CustomEvent<DetailByEvent[T]>).detail);
  };
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run utils/gameChannel.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add utils/gameChannel.ts utils/gameChannel.test.ts
git commit -m "feat: add game channel event bus for companion subtitles"
```

---

### Task 2: Session buffer + pacing + privacy-safe snapshot

**Files:**
- Create: `utils/gameSession.ts`
- Create: `utils/gameSession.test.ts`
- Modify: none

**Interfaces:**
- Consumes: `SubtitleLine`, `OptionSet`, `ChoiceRecord` from Task 1 (`./gameChannel`).
- Produces: `GameSession`, `VOICE_MIN_GAP_MS` (15000), `TEXT_MIN_GAP_MS` (8000), `buildSnapshot` (used by Task 4 summary view).

- [ ] **Step 1: Write the failing test**

`utils/gameSession.test.ts` (node env default, injectable clock):

```ts
import { describe, expect, it } from 'vitest';
import { GameSession, TEXT_MIN_GAP_MS, VOICE_MIN_GAP_MS } from './gameSession';

describe('GameSession', () => {
  it('keeps only the latest pending item (queue length 1)', () => {
    const s = new GameSession(() => 0);
    s.pushLine({ text: 'a', at: 1, source: 'pc-window' });
    s.pushLine({ text: 'b', at: 2, source: 'pc-window' });
    expect(s.takePending()?.text).toBe('b');
    expect(s.takePending()).toBeNull();
  });

  it('caps the rolling buffer', () => {
    const s = new GameSession(() => 0);
    for (let i = 0; i < 500; i += 1) s.pushLine({ text: `l${i}`, at: i, source: 'pc-window' });
    expect(s.lineCount()).toBeLessThanOrEqual(200);
    expect(s.latestLine()?.text).toBe('l499');
  });

  it('enforces voice/text pacing floors', () => {
    let now = 0;
    const s = new GameSession(() => now);
    expect(VOICE_MIN_GAP_MS).toBe(15000);
    expect(TEXT_MIN_GAP_MS).toBe(8000);
    expect(s.maySpeakVoice()).toBe(true);
    s.markVoiceSpoken();
    now += 1000;
    expect(s.maySpeakVoice()).toBe(false);
    expect(s.mayShowText()).toBe(false);
    now += 8000;
    expect(s.mayShowText()).toBe(true);
    expect(s.maySpeakVoice()).toBe(false);
  });

  it('binds a choice to the latest options id', () => {
    const s = new GameSession(() => 0);
    s.pushOptions({ id: 'o1', options: ['a', 'b'], at: 1 });
    s.pushOptions({ id: 'o2', options: ['c', 'd'], at: 2 });
    s.recordChoice(0, 3);
    expect(s.choices()[0].optionsId).toBe('o2');
  });

  it('snapshot carries no raw line text', () => {
    const s = new GameSession(() => 7);
    s.pushLine({ text: '秘密の合言葉は月', at: 1, source: 'pc-window' });
    s.pushOptions({ id: 'o1', options: ['留下', '离开'], at: 2 });
    s.recordChoice(1, 3);
    const snap = s.buildSnapshot();
    const json = JSON.stringify(snap);
    expect(json).not.toContain('秘密の合言葉は月');
    expect(json).not.toContain('留下');
    expect(snap.lineCount).toBe(1);
    expect(snap.choiceCount).toBe(1);
    expect(typeof snap.choicesHash).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run utils/gameSession.test.ts`
Expected: FAIL with "Cannot find module './gameSession'".

- [ ] **Step 3: Write minimal implementation**

`utils/gameSession.ts`:

```ts
import type { ChoiceRecord, OptionSet, SubtitleLine } from './gameChannel';

export const VOICE_MIN_GAP_MS = 15000;
export const TEXT_MIN_GAP_MS = 8000;
const MAX_BUFFER_LINES = 200;

function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export interface SessionSnapshot {
  choicesHash: string;
  lineCount: number;
  optionCount: number;
  choiceCount: number;
  charCount: number;
  startedAt: number;
  endedAt: number;
  headline: string;
}

export class GameSession {
  private lines: SubtitleLine[] = [];
  private optionSets: OptionSet[] = [];
  private choiceList: ChoiceRecord[] = [];
  private pending: SubtitleLine | null = null;
  private lastVoiceAt = -VOICE_MIN_GAP_MS;
  private lastTextAt = -TEXT_MIN_GAP_MS;
  private startedAt: number | null = null;

  constructor(private clock: () => number = () => Date.now()) {}

  pushLine(line: SubtitleLine): void {
    if (this.startedAt === null) this.startedAt = line.at;
    this.lines.push(line);
    if (this.lines.length > MAX_BUFFER_LINES) {
      this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES);
    }
    this.pending = line;
  }

  pushOptions(set: OptionSet): void {
    this.optionSets.push(set);
  }

  recordChoice(index: number, at: number): void {
    const latest = this.optionSets[this.optionSets.length - 1];
    if (!latest) return;
    this.choiceList.push({ optionsId: latest.id, index, at });
  }

  takePending(): SubtitleLine | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  latestLine(): SubtitleLine | null {
    return this.lines.length > 0 ? this.lines[this.lines.length - 1] : null;
  }

  lineCount(): number {
    return this.lines.length;
  }

  choices(): ChoiceRecord[] {
    return [...this.choiceList];
  }

  maySpeakVoice(): boolean {
    return this.clock() - this.lastVoiceAt >= VOICE_MIN_GAP_MS;
  }

  markVoiceSpoken(): void {
    // Pacing coupling (load-bearing, asymmetric, test-pinned): a voice
    // utterance also resets the text clock — voice suppresses text for
    // TEXT_MIN_GAP_MS, text does not suppress voice. Do not "simplify".
    this.lastVoiceAt = this.clock();
    this.lastTextAt = this.clock();
  }

  mayShowText(): boolean {
    return this.clock() - this.lastTextAt >= TEXT_MIN_GAP_MS;
  }

  markTextShown(): void {
    this.lastTextAt = this.clock();
  }

  buildSnapshot(): SessionSnapshot {
    const charCount = this.lines.reduce((n, l) => n + l.text.length, 0);
    const endedAt = this.lines.length > 0 ? this.lines[this.lines.length - 1].at : 0;
    return {
      choicesHash: hashString(JSON.stringify(this.choiceList)),
      lineCount: this.lines.length,
      optionCount: this.optionSets.length,
      choiceCount: this.choiceList.length,
      charCount,
      startedAt: this.startedAt ?? 0,
      endedAt,
      headline: `共 ${this.lines.length} 行/${this.optionSets.length} 组选项/选了 ${this.choiceList.length} 次`,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run utils/gameSession.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/gameSession.ts utils/gameSession.test.ts
git commit -m "feat: add game session buffer with pacing and safe snapshot"
```

---

### Task 3: App registration + shell rendering latest line

**Files:**
- Create: `apps/CompanionGameApp.tsx`
- Modify: `types.ts` (~line 6, AppID enum — read lines 1-30, copy exact member syntax)
- Modify: `constants.tsx` (~line 92 INSTALLED_APPS row, ~line 47 Icons map — read both, copy exact row shape)
- Modify: `components/PhoneShell.tsx` (~lines 19-60 lazy import, ~lines 851-875 switch — copy exact shape)

**Interfaces:**
- Consumes: `useOS()` (`context/OSContext.tsx:5519`, destructure `closeApp` only per `apps/FAQApp.tsx:221`), `subscribeGameChannel` + `GAME_CHANNEL_EVENTS` (Task 1).
- Produces: registered `game-companion` App rendering latest line (used by Task 4 which extends this file).

- [ ] **Step 1: Write the failing test**

`apps/CompanionGameApp.test.tsx` (full file):

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CompanionGameApp from './CompanionGameApp';
import { announceGameLine } from '../utils/gameChannel';

vi.mock('../context/OSContext', () => ({
  useOS: () => ({ closeApp: vi.fn() }),
}));

describe('CompanionGameApp', () => {
  afterEach(() => cleanup());

  it('renders the latest line after a channel event', () => {
    render(<CompanionGameApp />);
    announceGameLine({ text: '桜が咲いた', at: 1, source: 'pc-window' });
    expect(screen.getByTestId('companion-latest-line').textContent).toBe('桜が咲いた');
  });

  it('renders a close button', () => {
    render(<CompanionGameApp />);
    expect(screen.getByTestId('companion-close')).toBeTruthy();
  });
});
```

Note: check `@testing-library/react` exists in devDependencies first (`grep '"@testing-library/react"' package.json`). If absent, STOP this task and report: DOM test needs the harness's approved DOM-test approach — do not add dependencies unilaterally. (`utils/appIcon.test.ts:10` documents the DOM pattern; confirm the render helper it uses and mirror that instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/CompanionGameApp.test.tsx`
Expected: FAIL with "Cannot find module './CompanionGameApp'".

- [ ] **Step 3: Register the App (4 edits, copy exact shapes from cited lines)**

1. `types.ts` ~line 6: add enum member following the file's exact syntax, value `'game-companion'`.
2. `constants.tsx` ~line 92: add INSTALLED_APPS row copying the neighboring row shape (id + title + icon key).
3. `constants.tsx` ~line 47: add Icons key used by that row.
4. `components/PhoneShell.tsx`: add lazy import (~lines 19-60 shape) + switch case (~lines 851-875 shape) returning `<CompanionGameApp />`; default export required (`apps/FAQApp.tsx:397` pattern).
5. Optional: `components/os/appPreload.ts:30-60` importer entry (prefetch only; skip if unsure — comment in file says it only affects optimization).

- [ ] **Step 4: Write minimal shell component**

`apps/CompanionGameApp.tsx` (follow `apps/FAQApp.tsx:220` `React.FC` no-props shape):

```tsx
import React, { useEffect, useState } from 'react';
import { useOS } from '../context/OSContext';
import { GAME_CHANNEL_EVENTS, subscribeGameChannel } from '../utils/gameChannel';

const CompanionGameApp: React.FC = () => {
  const { closeApp } = useOS() as { closeApp: () => void };
  const [latest, setLatest] = useState('');

  useEffect(
    () =>
      subscribeGameChannel(GAME_CHANNEL_EVENTS.line, (detail) => {
        setLatest(detail.text);
      }),
    [],
  );

  return (
    <div data-testid="companion-app">
      <button data-testid="companion-close" type="button" onClick={() => closeApp()}>
        关闭
      </button>
      <div data-testid="companion-latest-line">{latest}</div>
    </div>
  );
};

export default CompanionGameApp;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run apps/CompanionGameApp.test.tsx`
Expected: PASS (2 tests). If `useOS` mock shape mismatches the real provider, read `context/OSContext.tsx:5519` surroundings and adjust the mock only (never the provider).

- [ ] **Step 6: Commit**

```bash
git add apps/CompanionGameApp.tsx apps/CompanionGameApp.test.tsx types.ts constants.tsx components/PhoneShell.tsx
git commit -m "feat: register companion game app shell with latest line"
```

(If `appPreload.ts` was touched, add it to the same commit.)

---

### Task 4: Avatar ball + 20-line history + reply event + memory toggle

**Files:**
- Modify: `apps/CompanionGameApp.tsx`
- Modify: `apps/CompanionGameApp.test.tsx`
- Modify: none else

**Interfaces:**
- Consumes: `CharacterProfile.avatar` (`types.ts:3031`) via `useOS()` `characters` + `activeCharacterId` (verify names against provider at `context/OSContext.tsx:5519` before coding); `TokenImg` (`components/os/TokenImg.tsx:11`) + `useBlobRefUrl` pattern (`apps/Launcher.tsx:136-147`); `announceUserReply` (Task 1); `GameSession` history? No — history lives in component state capped at 20 (session module owns pacing/snapshot; keep view dumb).
- Produces: expanded chat view (used by overlay shells in Plans 2/3 via this same component).

- [ ] **Step 1: Extend the failing tests**

Append to `apps/CompanionGameApp.test.tsx` (extend the `useOS` mock to include characters):

```tsx
vi.mock('../context/OSContext', () => ({
  useOS: () => ({
    closeApp: vi.fn(),
    characters: [{ id: 'c1', avatar: 'blobref:abc' }],
    activeCharacterId: 'c1',
  }),
}));
```

New cases:

```tsx
it('shows avatar ball with fallback when avatar missing', () => {
  render(<CompanionGameApp />);
  expect(screen.getByTestId('companion-ball')).toBeTruthy();
});

it('keeps 20 lines of history and sends reply as event', async () => {
  const { default: App } = await import('./CompanionGameApp');
  void App;
  render(<CompanionGameApp />);
  for (let i = 0; i < 25; i += 1) {
    announceGameLine({ text: `line-${i}`, at: i, source: 'pc-window' });
  }
  expect(screen.getAllByTestId('companion-history-line')).toHaveLength(20);
  expect(screen.getByTestId('companion-history-line-0').textContent).toBe('line-5');
});
```

And a reply case: type into `companion-reply-input`, click `companion-reply-send`, assert a `reply` channel event fires (subscribe in-test and capture). Memory toggle case: click `companion-memory-toggle`, assert `localStorage.getItem('companion-game:record')` flips `'1'`/`'0'`, default `'1'`.

(Write these as plain synchronous cases following the Task 3 file's style; drop the `async import` dance — keep the static import at top. The reply capture subscribes before clicking send.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/CompanionGameApp.test.tsx`
Expected: FAIL (missing testids `companion-ball`, `companion-history-line-0`, `companion-reply-input`, `companion-memory-toggle`).

- [ ] **Step 3: Extend the component**

Requirements for the edit (no new deps):
- Ball: `<div data-testid="companion-ball">` containing `TokenImg value={avatar}` when active character avatar non-empty, else fallback initial (first char of name or '?'). Verify `TokenImg` prop name against `components/os/TokenImg.tsx:11` and the `useBlobRefUrl` usage at `apps/Launcher.tsx:136-147` before coding; if the shape differs, mirror Launcher exactly.
- History: state array capped at 20 (drop oldest), each row `data-testid="companion-history-line"` with first row additionally `data-testid="companion-history-line-0"`. Latest-line div from Task 3 stays in sync (same event).
- Reply: input `data-testid="companion-reply-input"` + button `data-testid="companion-reply-send"`; on send, `announceUserReply({ text: value.trim(), at: Date.now() })` and clear. Empty trim sends nothing. No AI call.
- Memory toggle: button `data-testid="companion-memory-toggle"` flipping `localStorage 'companion-game:record'` between `'1'`/`'0'`, label shows current state. Default `'1'`. This flag is what later plans gate summarization on.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/CompanionGameApp.test.tsx`
Expected: PASS (all cases incl. Task 3's).

- [ ] **Step 5: Commit**

```bash
git add apps/CompanionGameApp.tsx apps/CompanionGameApp.test.tsx
git commit -m "feat: companion chat history, avatar ball, reply event, memory toggle"
```

---

### Task 5: Full verification run

**Files:** none (verification only).

- [ ] **Step 1: Run the touched-area tests**

```bash
pnpm vitest run utils/gameChannel.test.ts utils/gameSession.test.ts apps/CompanionGameApp.test.tsx
```

Expected: all PASS.

- [ ] **Step 2: Run the full suite once**

```bash
pnpm vitest run
```

Expected: PASS with no new failures. If failures exist, check whether they touch game files (`git stash` + rerun the failing file + `git stash pop` to confirm pre-existing). Record pre-existing failures by name in the final report; do not fix unrelated code.

- [ ] **Step 3: Report, no commit** (nothing to commit; post the file list + test counts as the task result).

---

## Plan 2/3 preview (not in this plan)

- Plan 2: PC sidecar (WGC source-window capture, manual ROI, PP-OCR mobile, change-trigger, localhost bridge dispatching Task 1 events) + PC overlay shell reusing Task 4 view.
- Plan 3: Tablet native service (MediaProjection, ImageReader ROI 2–3fps, ML Kit zh-Hant, overlay) + PTT STT (sherpa-onnx SenseVoice int8 + Silero VAD).
