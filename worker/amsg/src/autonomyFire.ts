/**
 * 自主背景生活（`autonomous_round`）到点这一轮 —— wrapper 层 handler。
 *
 * 调度器（autonomyScheduler）把任务建出来，这里到点干活：读 fire_pack 的完整人格模板 +
 * 自主设置终值，拼成一轮「你自己的时间」的提示词交给上游那次 fire，模型回一份 JSON，
 * 这里落 D1（autonomy_experiences）→ 过反刍闸 → 判要不要推 → emitResult 把结果送回
 * 客户端 → reportAutonomyOutcome 回账。
 *
 * 四个不显然的设计点：
 *
 * 1. **D1 走模块级 holder**（`configureAutonomyFireDb`）。kind 分派点是模块级的
 *    `amsgHooks`，上游调 hook 只传一个参数（chunk 里 `hooks.onBeforeFire(fireCtx)`），
 *    闭包够不到 `env`；`KindFireCtx` / `KindSessionCtx` 也刻意不含 db。所以照
 *    `configureInstantErrorPush` 的先例：`buildWorkerConfig` 里注入一次，handler 只读
 *    这个 holder。**holder 没配上时整轮安全跳过（skip-plan），绝不抛**——单测自己喂
 *    hand-rolled 的假库并在 afterEach 里清回 null，vitest 按文件隔离，不会串味。
 *
 * 2. **这一轮没有工具面**。kind 路径的 wrapper 不转发 tools / toolChoice
 *    （index.ts:1661-1664），就算模型幻觉出 tool_calls 也没有执行器。所以提示词里
 *    **绝不出现工具块**，只明说「本轮没有可用工具」，让模型从上下文（人格、对话尾巴、
 *    兴趣、此刻的读数）里取材。真工具面留到有 live-fire 验证的那一期再接。
 *
 * 3. **采样参数不在这里**。temperature / maxTokens 由 Task-17 的
 *    `buildAutonomyScheduleRequest` 写进任务 payload（fire 侧从 payload 取），handler
 *    一个采样参数都不设；top_p 全篇不出现。
 *
 * 4. **纯逻辑全导出**：反刍闸的输入、后处理三件、两层容错解析、提示词组装都是纯函数
 *    （D1 读写只在 handler 里），单测直接钉它们，不用起 ctx。
 *
 * 结果信封 `AUTONOMY_RESULT_KIND`（= 'autonomy_result'）的字段是 Task 18→19 的锁定
 * 契约：experiences（每条带 D1 行 id，客户端按它对账 outbox）/ proposedEvents /
 * usage / toolsUsed / did / rested。
 */

import { AUTONOMY_RESULT_KIND } from '../../../utils/airp/autonomySettings';
import {
  AMSG_FIRE_PACK_KEY,
  amsgStateNamespace,
  parseFirePack,
  renderFirePack,
  unpackStateValue,
  wallClockPartsInZone,
  type AmsgFirePack,
} from '../../../utils/amsgFirePack';
import {
  RUMIN_PAGES,
  RUMIN_WINDOW_H,
  buildRuminationBanLine,
  resolveRumination,
  ruminationVerdict,
  type RuminationPage,
} from './autonomyRumination';
import { autonomyDateKey, reportAutonomyOutcome } from './autonomyScheduler';
import {
  addAutonomyExperience,
  ensureAutonomySchema,
  getAutonomyState,
  type AutonomyDb,
} from './autonomyStore';
import type {
  FireKindHandler,
  KindDecision,
  KindFireCtx,
  KindFirePlan,
  KindSessionCtx,
} from './fireKinds';
import type { ResolvedAirpAutonomy } from '../../../utils/airp/autonomySettings';

/** 只为单测导出：让测试能不经 index.ts 直接喂一份 ctx。 */
export type { KindFireCtx, KindSessionCtx };

// ─── D1 holder（见文件头第 1 点） ────────────────────────────────────────

let fireDb: AutonomyDb | null = null;

/**
 * `buildWorkerConfig` 的写入口；export 只为单测注入假库。
 * 传 null / undefined 一律收成 null：没配 D1 的部署整轮跳过，不抛。
 */
export function configureAutonomyFireDb(db: AutonomyDb | null | undefined): void {
  fireDb = db ?? null;
}

// ─── 跳过原因（日志与单测共用的字面量） ──────────────────────────────────

export const AUTONOMY_FIRE_SKIP = {
  dbUnavailable: 'autonomy-db-unavailable',
  stateMissing: 'autonomy-state-missing',
  packMissing: 'autonomy-pack-missing',
  packUnreadable: 'autonomy-pack-unreadable',
  disabled: 'autonomy-disabled',
  tzInvalid: 'autonomy-tz-invalid',
} as const;

export const AUTONOMY_BAD_OUTPUT_REASON = 'autonomy-bad-output';

// ─── 常量 ────────────────────────────────────────────────────────────────

/**
 * 一条 note 的理想长度（B2 的 800 字）。超了就整句收笔裁进这个帽——
 * 调用侧的 maxTokens 1600 正好是这个数 ×2，留给 JSON 信封与收笔的余量。
 */
export const AUTONOMY_NOTE_MAX_CHARS = 800;

const HOUR_MS = 60 * 60 * 1000;

/** 数「当日推了几条」时的回溯窗：26h 覆盖任何时区偏移，按角色时区日期过滤。 */
const PUSH_COUNT_LOOKBACK_MS = 26 * HOUR_MS;

/** 禁清嗓子的开头（B2 的指名清单，原样抄）。 */
export const THROAT_CLEARING_OPENERS = ['翻到了', '查到了', '记一下', '去查了一眼'] as const;

/** 心跳与 did 认得的几种「做了什么」（对齐 rulings 里 Task-19 的心跳契约）。 */
export const AUTONOMY_DID_KINDS = ['surf', 'game', 'forum', 'rest'] as const;

/** proposedEvents 认得的 type（对齐 utils/airp/types.ts 的 AirpProposedEvent）。 */
export const AUTONOMY_EVENT_TYPES = [
  'conversation', 'activity', 'movement', 'schedule', 'relationship', 'discovery', 'social_trace',
] as const;

const EVENT_TYPE_SET = new Set<string>(AUTONOMY_EVENT_TYPES);
const DID_KIND_SET = new Set<string>(AUTONOMY_DID_KINDS);

// ─── 后处理三件（纯） ────────────────────────────────────────────────────

/**
 * 禁清嗓子：把开头的口水话削掉，让首句从数字 / 画面 / 推翻预期处落笔。
 * 连削多道（「记一下：翻到了……」这种叠着来的）。削完可能是空串——调用方丢掉这条。
 */
export function stripThroatClearing(text: string, openers: readonly string[] = THROAT_CLEARING_OPENERS): string {
  let out = text.trimStart();
  let changed = true;
  while (changed) {
    changed = false;
    for (const opener of openers) {
      if (out.startsWith(opener)) {
        out = out.slice(opener.length).replace(/^[，,、：:。.!！?？\s]+/u, '');
        changed = true;
      }
    }
  }
  return out;
}

/**
 * 洗链接：`[词](url)` 只留词，裸网址整段抹掉。
 * 先处理带词的，再抹裸的——`[https://x](https://x)` 这种两步都能收干净。
 */
export function washMarkdownLinks(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*\)/g, '$1')
    // 裸网址只吃 URL 合法字符：中文正文里网址后面常常直接接汉字，用 \S+ 会把后半句一起吞掉。
    .replace(/https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/g, '');
}

/**
 * 整句收笔：超帽裁进帽，先退到帽前最后一个整句（。！？…），
 * 一句都没有（长句没标点）就抹掉吊尾的逗号/顿号/空白，绝不留半句话。
 */
export function fullStopNote(text: string, cap: number = AUTONOMY_NOTE_MAX_CHARS): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, cap);
  let lastEnd = -1;
  for (const mark of ['。', '！', '？', '…', '!', '?', '.']) {
    lastEnd = Math.max(lastEnd, head.lastIndexOf(mark));
  }
  if (lastEnd >= 0) return head.slice(0, lastEnd + 1);
  return head.replace(/[，,、；;\s]+$/u, '');
}

/** 三件按序过一遍：清嗓子 → 洗链接 → 整句收笔。空串 = 这条 note 没救了。 */
export function postProcessNote(note: string, cap: number = AUTONOMY_NOTE_MAX_CHARS): string {
  return fullStopNote(washMarkdownLinks(stripThroatClearing(note)), cap).trim();
}

// ─── 两层容错解析（纯） ──────────────────────────────────────────────────

export interface AutonomyParsedExperience {
  q: string;
  note: string;
  kind: string;
  importance: number;
}

export interface AutonomyProposedEvent {
  type: string;
  summary: string;
  participants?: string[];
  locationLabel?: string;
  impact?: string;
}

export interface AutonomyRoundReply {
  /** 这一轮什么都不记（rest:true，或压根没产出可用经历）。 */
  rested: boolean;
  experiences: AutonomyParsedExperience[];
  proposedEvents: AutonomyProposedEvent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const PARSE_FAILED = Symbol('parse-failed');

const tryParseJson = (text: string): unknown | typeof PARSE_FAILED => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return PARSE_FAILED;
  }
};

/**
 * 第一层：从模型输出里把那个 JSON 对象掏出来。容忍 ```json 围栏、前后闲话
 * （按最外层的 `{`…`}` 再切一刀）。掏不出来回 null。
 */
export function extractAutonomyJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = fenced ? [fenced[1], trimmed] : [trimmed];
  for (const candidate of candidates) {
    const direct = tryParseJson(candidate.trim());
    if (direct !== PARSE_FAILED) return direct;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const sliced = tryParseJson(candidate.slice(start, end + 1));
      if (sliced !== PARSE_FAILED) return sliced;
    }
  }
  return null;
}

const toExperience = (raw: Record<string, unknown>): AutonomyParsedExperience | null => {
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (!note) return null;
  const kind = typeof raw.kind === 'string' && raw.kind.trim() ? raw.kind.trim() : 'rest';
  const importance = typeof raw.importance === 'number' && Number.isFinite(raw.importance)
    ? Math.trunc(raw.importance)
    : 0;
  return { q: typeof raw.q === 'string' ? raw.q.trim() : '', note, kind, importance };
};

/** 认不出来的 type 直接丢（不致命）——影响档位一律透传，客户端自己去降级。 */
const toProposedEvent = (raw: Record<string, unknown>): AutonomyProposedEvent | null => {
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!type || !summary || !EVENT_TYPE_SET.has(type)) return null;
  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    type,
    summary,
    ...(participants && participants.length > 0 ? { participants } : {}),
    ...(typeof raw.locationLabel === 'string' && raw.locationLabel.trim()
      ? { locationLabel: raw.locationLabel.trim() } : {}),
    ...(typeof raw.impact === 'string' && raw.impact.trim() ? { impact: raw.impact.trim() } : {}),
  };
};

/**
 * 第二层：形状校验 + 逐项抢救。
 *
 * 硬失败（回 null，调用方走失败路径）：找不到 JSON、不是对象、`v` 不是 1、
 * `rest` 不是布尔、experiences / proposedEvents 不是数组、整个对象一个认得的字段都没有。
 * 软容错：单条 experience 没有 note 就丢、未知 event type 就丢、别的字段缺了就补默认。
 *
 * `rest: true` 优先于同轮的 experiences（模型自己说歇了，就别硬记）。
 */
export function parseAutonomyRoundReply(text: string): AutonomyRoundReply | null {
  const raw = extractAutonomyJson(text);
  if (!isRecord(raw)) return null;
  if (raw.v !== undefined && raw.v !== 1) return null;
  if (raw.rest !== undefined && typeof raw.rest !== 'boolean') return null;
  if (raw.experiences !== undefined && !Array.isArray(raw.experiences)) return null;
  if (raw.proposedEvents !== undefined && !Array.isArray(raw.proposedEvents)) return null;

  const rest = raw.rest === true;
  const experiences = rest
    ? []
    : (raw.experiences ?? [])
      .filter(isRecord)
      .map(toExperience)
      .filter((item): item is AutonomyParsedExperience => item !== null);
  const proposedEvents = (raw.proposedEvents ?? [])
    .filter(isRecord)
    .map(toProposedEvent)
    .filter((item): item is AutonomyProposedEvent => item !== null);

  const hasKnownField = raw.rest !== undefined || raw.experiences !== undefined || raw.proposedEvents !== undefined;
  if (!hasKnownField) return null;
  return {
    rested: rest || (experiences.length === 0 && proposedEvents.length === 0),
    experiences,
    proposedEvents,
  };
}

// ─── 反刍闸的输入与提示词（纯） ──────────────────────────────────────────

/**
 * 已经写腻了的方向（喂给「这次别再碰」的禁区行）：近窗口里自己就撞满
 * `RUMIN_HIT_PAGES` 页的搜索词，最新在前、去重。
 */
export function collectBurntLines(pages: readonly RuminationPage[], nowMs: number): string[] {
  const burnt: string[] = [];
  for (const page of pages) {
    const line = typeof page?.q === 'string' ? page.q.trim() : '';
    if (!line || burnt.includes(line)) continue;
    if (ruminationVerdict(line, pages, nowMs).blocked) burnt.push(line);
  }
  return burnt;
}

const HINT_LINE_MAX = 80;
const HINT_LINE_COUNT = 8;

const DIALOGUE_HEADING = '【最近对话上下文】';
const DIALOGUE_HEADING_END = '【当前时刻补充】';
const EMPTY_TRANSCRIPT = '（暂时没有最近聊天记录）';

/**
 * 对话尾巴：从渲染好的人格模板里把【最近对话上下文】那一段的最后 8 行取出来
 * （每行截 80 字）。fire_pack 里对话只有这一个常驻落点——`pack.chat` 只在那条
 * 即时对话上传路径上才有，不能赌。
 */
export function extractDialogueTail(personalityText: string): string[] {
  const start = personalityText.indexOf(DIALOGUE_HEADING);
  if (start < 0) return [];
  const after = personalityText.slice(start + DIALOGUE_HEADING.length);
  const end = after.indexOf(DIALOGUE_HEADING_END);
  const section = end >= 0 ? after.slice(0, end) : after;
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== EMPTY_TRANSCRIPT)
    .slice(-HINT_LINE_COUNT)
    .map((line) => (line.length > HINT_LINE_MAX ? line.slice(0, HINT_LINE_MAX) : line));
}

const renderTopicBlock = (args: {
  personality: string;
  autonomy: ResolvedAirpAutonomy;
}): string => {
  const { autonomy } = args;
  const tail = extractDialogueTail(args.personality);
  const lines: string[] = [];
  if (tail.length > 0) {
    lines.push('最近聊到过这些：');
    lines.push(...tail.map((line) => `- ${line}`));
  } else if (autonomy.interests.length > 0) {
    lines.push(`你平时惦记这些：${autonomy.interests.join('、')}`);
  }
  if (autonomy.avoidTopics.length > 0) {
    lines.push(`这些方向你自己说过这次不碰：${autonomy.avoidTopics.join('、')}`);
  }
  if (lines.length === 0) return '';
  return [
    '【可以顺着去的由头】',
    ...lines,
    '里头要有当时心里一动、这会儿想接着琢磨的，就顺着去；没有就当没看见，不用汇报、不用接着聊。',
  ].join('\n');
};

/** 这一轮的提示词。顺序锁死：人格全文 → 框定语 → 自由度 → 由头 → 语气 → 无工具 → 产出。 */
export function buildAutonomyRoundPrompt(args: {
  pack: AmsgFirePack;
  nowMs: number;
  pages: readonly RuminationPage[];
  autonomy: ResolvedAirpAutonomy;
}): string {
  // 人格全文：fire_pack 的完整模板（含人设 + 对话尾巴 + 此刻的读数），槽位在 fire
  // 时刻填掉。「本次任务」留空——这一轮的任务书在下面，不借用聊天那条路的指令槽。
  const personality = renderFirePack(args.pack, args.nowMs, '');
  const topicBlock = renderTopicBlock({ personality, autonomy: args.autonomy });
  const banLine = buildRuminationBanLine(collectBurntLines(args.pages, args.nowMs));
  const noteHint = args.autonomy.noteStyleHint
    ? [`【记录的语气】`, args.autonomy.noteStyleHint].join('\n')
    : '';

  return [
    personality,
    [
      '【这一轮的处境】',
      '- 对方没有在等你回话，你现在做的事不需要为了谁，也不用向谁交代。',
      '- 这是属于你自己的一小会儿：可以发呆，可以随便看看，也可以什么都不做。',
      '- 不用哄谁，不用汇报，也不用有产出。',
    ].join('\n'),
    [
      '【怎么过这一小会儿】',
      '- 允许无聊，允许只记下碎片，不追求有用。',
      '- 允许这次什么都不记。',
    ].join('\n'),
    topicBlock,
    banLine,
    noteHint,
    [
      '【这一轮没有可用工具】',
      '本轮你没有任何工具可调，也别在正文里写工具调用——内容只能从上面给你的上下文'
        + '（人设、对话、兴趣、此刻的读数）里来。',
    ].join('\n'),
    [
      '【这一轮的产出】',
      '上面那份聊天模板是你在正常聊天时的规矩；这一轮不一样：不发给任何人，也不聊天，'
        + '只把结果写成一个 JSON 对象。',
      '{"v":1,"experiences":[{"q":"为什么会有这条（一句话）","note":"第一人称随手记，口语、具体、有画面",'
        + '"kind":"surf|game|forum|rest","importance":0}],"proposedEvents":[],"rest":false}',
      'kind 只能从 surf（上网闲逛）、game（玩游戏）、forum（逛社区）、rest（发呆歇着）里挑一个；'
        + 'importance 是 0 到 3 的数字。',
      'proposedEvents 只在「这件事会影响你之后的生活」时才写，每项 '
        + '{"type":"conversation|activity|movement|schedule|relationship|discovery|social_trace",'
        + '"summary":"...","impact":"trace|minor|major"}；平时就写空数组。',
      '想说的那条放 experiences 最前面。这一轮什么都不想记就写 {"v":1,"rest":true}。',
      '除了这个 JSON 什么都别输出（不要解释、不要代码块之外的话）。',
    ].join('\n'),
  ].filter((block) => block.length > 0).join('\n\n');
}

// ─── 推送判定（纯） ──────────────────────────────────────────────────────

const parseHHMM = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 静默段判定（含跨夜，start === end 视为没有静默段）。 */
export function isWithinQuietHours(
  quiet: { start: string; end: string } | undefined,
  minutes: number,
): boolean {
  if (!quiet) return false;
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === null || end === null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export interface AutonomyPushGateInput {
  push: ResolvedAirpAutonomy['push'];
  /** 角色时区下的当日已推条数。 */
  pushedToday: number;
  lastPushAt: number;
  nowMs: number;
  quietHours?: { start: string; end: string };
  /** 角色当地时间的当日分钟数（0..1439）。 */
  minutesOfDay: number;
}

/** big 才推；当日配额、冷却、静默段全过才推。 */
export function shouldPushAutonomy(input: AutonomyPushGateInput): boolean {
  const { push } = input;
  if (push.mode !== 'big') return false;
  if (input.pushedToday >= push.maxPerDay) return false;
  if (input.lastPushAt > 0 && push.cooldownMinutes > 0
    && input.nowMs - input.lastPushAt <= push.cooldownMinutes * 60_000) return false;
  return !isWithinQuietHours(input.quietHours, input.minutesOfDay);
}

// ─── 结果信封（锁定的 Task 18→19 契约） ──────────────────────────────────

export interface AutonomyResultExperience {
  /** D1 行的 id：客户端按它把 outbox 对账回这条经历。 */
  id: string;
  q: string;
  note: string;
  kind: string;
  importance: number;
  pushed: boolean;
}

export interface AutonomyUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface AutonomyResultPayload {
  resultKind: typeof AUTONOMY_RESULT_KIND;
  charId: string;
  experiences: AutonomyResultExperience[];
  proposedEvents: AutonomyProposedEvent[];
  usage: AutonomyUsage;
  /** 这一轮没有工具面，永远是空数组（字段留给接上工具的那一期）。 */
  toolsUsed: string[];
  did: string;
  rested: boolean;
}

export function buildAutonomyResultPayload(args: {
  charId: string;
  experiences: AutonomyResultExperience[];
  proposedEvents: AutonomyProposedEvent[];
  usage: AutonomyUsage;
  did: string;
  rested: boolean;
}): AutonomyResultPayload {
  return {
    resultKind: AUTONOMY_RESULT_KIND,
    charId: args.charId,
    experiences: args.experiences,
    proposedEvents: args.proposedEvents,
    usage: args.usage,
    toolsUsed: [],
    did: args.did,
    rested: args.rested,
  };
}

/** 占主导的「做了什么」；多于一种就是 mixed；一条都没有就是 rest。 */
export function dominantAutonomyKind(experiences: readonly { kind: string }[]): string {
  if (experiences.length === 0) return 'rest';
  const kinds = new Set(experiences.map((item) => item.kind));
  if (kinds.size !== 1) return 'mixed';
  const only = [...kinds][0];
  return DID_KIND_SET.has(only) ? only : 'mixed';
}

// ─── llmOutput 的随身状态（beforeFire → llmOutput） ──────────────────────

interface AutonomyFireState {
  charId: string;
  autonomy: ResolvedAirpAutonomy;
  pages: RuminationPage[];
  tzId: string;
  dateKey: string;
  lastPushAt: number;
  nowMs: number;
}

const readCarriedState = (state: unknown): AutonomyFireState | null => {
  if (!isRecord(state)) return null;
  const { charId, tzId, dateKey, nowMs } = state;
  if (typeof charId !== 'string' || !charId) return null;
  if (typeof tzId !== 'string' || !tzId) return null;
  if (typeof dateKey !== 'string' || !dateKey) return null;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  if (!isRecord(state.autonomy)) return null;
  return {
    charId,
    tzId,
    dateKey,
    nowMs,
    autonomy: state.autonomy as unknown as ResolvedAirpAutonomy,
    pages: Array.isArray(state.pages) ? (state.pages as RuminationPage[]) : [],
    lastPushAt: typeof state.lastPushAt === 'number' && Number.isFinite(state.lastPushAt) ? state.lastPushAt : 0,
  };
};

const readUsage = (ctx: KindSessionCtx): AutonomyUsage => {
  const raw = (ctx as { usage?: Record<string, unknown> | null }).usage;
  const pick = (key: string): number => {
    const value = raw?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const prompt = pick('prompt_tokens');
  const completion = pick('completion_tokens');
  const total = pick('total_tokens') || prompt + completion;
  return { prompt, completion, total };
};

// ─── D1 读写（只经 holder） ──────────────────────────────────────────────

const readRecentExperiencePages = async (
  db: AutonomyDb,
  charId: string,
  sinceMs: number,
): Promise<RuminationPage[]> => {
  const rows = await db
    .prepare('SELECT q, created_at FROM autonomy_experiences WHERE char_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?')
    .bind(charId, sinceMs, RUMIN_PAGES)
    .all();
  return (rows.results ?? [])
    .filter(isRecord)
    .map((row) => ({
      q: typeof row.q === 'string' ? row.q : null,
      createdAt: typeof row.created_at === 'number' ? row.created_at : Number.NaN,
    }));
};

/** 角色时区下的当日推送条数。没有 pushes_today 列，就从经历行的 pushed 标记数。 */
const countPushedOnDate = async (
  db: AutonomyDb,
  charId: string,
  tzId: string,
  dateKey: string,
  nowMs: number,
): Promise<number> => {
  const rows = await db
    .prepare('SELECT created_at FROM autonomy_experiences WHERE char_id = ? AND pushed = 1 AND created_at >= ?')
    .bind(charId, nowMs - PUSH_COUNT_LOOKBACK_MS)
    .all();
  let count = 0;
  for (const row of rows.results ?? []) {
    if (!isRecord(row) || typeof row.created_at !== 'number') continue;
    try {
      if (autonomyDateKey(row.created_at, tzId) === dateKey) count += 1;
    } catch {
      /* 时区刚在 beforeFire 校验过；这里只是数数，读不出来就不算 */
    }
  }
  return count;
};

// ─── handler ─────────────────────────────────────────────────────────────

const findFirePackRow = (
  rows: Array<{ key: string; value: string }>,
): { key: string; value: string } | undefined => rows.find((row) => row.key === AMSG_FIRE_PACK_KEY);

/**
 * 回账只记日志、不往外抛。
 *
 * 走到回账这一步时副作用已经落地（经历写进 D1、结果送进收件箱）。抛出去的话上游会把整轮
 * 判失败重跑：同一次 LLM 的产出再落一行经历、再发一次结果——比丢一次账严重得多。
 * 熔断那侧不用担心：D1 真坏了的话调度器自己的每一道闸也会一起失败。
 */
const reportOutcome = async (
  charId: string,
  outcome: Parameters<typeof reportAutonomyOutcome>[1],
  args: Parameters<typeof reportAutonomyOutcome>[2],
): Promise<void> => {
  try {
    await reportAutonomyOutcome(charId, outcome, args);
  } catch (error) {
    console.warn('[amsg:autonomy] 结局没记进 autonomy_state（不重跑，免得重复落经历行）', charId, error);
  }
};

export const autonomyRoundHandler: FireKindHandler = {
  async beforeFire({ ctx, charId }): Promise<KindFirePlan> {
    const db = fireDb;
    if (!db) return { skip: true, reason: AUTONOMY_FIRE_SKIP.dbUnavailable };

    const nowMs = ctx.now.getTime();
    const rows = await ctx.readState(amsgStateNamespace(charId));
    const row = findFirePackRow(rows);
    if (!row?.value) {
      console.warn('[amsg:autonomy] 云端没有这个角色的 fire_pack，这一轮跳过', charId);
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.packMissing };
    }

    let pack: AmsgFirePack | null = null;
    try {
      pack = parseFirePack(await unpackStateValue(row.value));
    } catch (error) {
      console.warn('[amsg:autonomy] fire_pack 解压失败，这一轮跳过', charId, error);
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.packUnreadable };
    }
    if (!pack) {
      console.warn('[amsg:autonomy] fire_pack 形状不认识，这一轮跳过', charId);
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.packUnreadable };
    }
    // 调度器建任务前也判过同一个开关；到点再判一次，防的是「建完任务用户就关了」。
    const autonomy = pack.autonomy;
    if (!autonomy || autonomy.enabled !== true) {
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.disabled };
    }

    let dateKey: string;
    try {
      dateKey = autonomyDateKey(nowMs, pack.tzId);
    } catch {
      return { skip: true, reason: AUTONOMY_FIRE_SKIP.tzInvalid };
    }

    await ensureAutonomySchema(db);
    const pages = await readRecentExperiencePages(db, charId, nowMs - RUMIN_WINDOW_H * HOUR_MS);
    const state = await getAutonomyState(db, charId);

    return {
      messages: [{ role: 'user', content: buildAutonomyRoundPrompt({ pack, nowMs, pages, autonomy }) }],
      state: {
        charId,
        autonomy,
        pages,
        tzId: pack.tzId,
        dateKey,
        lastPushAt: state.lastPushAt,
        nowMs,
      } satisfies AutonomyFireState,
    };
  },

  async llmOutput({ ctx, state }): Promise<KindDecision> {
    const db = fireDb;
    if (!db) return { decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.dbUnavailable };
    const carried = readCarriedState(state);
    if (!carried) return { decision: 'skip-push', reason: AUTONOMY_FIRE_SKIP.stateMissing };

    const reply = parseAutonomyRoundReply(ctx.llmOutputText || '');
    if (!reply) {
      console.warn('[amsg:autonomy] 这一轮的输出解析不出来（形状/版本对不上），判失败', carried.charId);
      await reportOutcome(
        carried.charId,
        { ok: false },
        { db, dateKey: carried.dateKey, nowMs: carried.nowMs },
      );
      return { decision: 'skip-push', reason: AUTONOMY_BAD_OUTPUT_REASON };
    }

    const usage = readUsage(ctx);

    // 反刍闸：模型报上来的选题逐条比近 96h / 12 页。全撞 = 这一轮收成 rest；
    // 只撞一部分就只丢撞的那些（模型可以在同一份输出里换个题）。
    let experiences = reply.experiences;
    let rested = reply.rested;
    if (experiences.length > 0) {
      const verdicts = experiences.map((item) =>
        ruminationVerdict(item.q, carried.pages, carried.nowMs));
      if (resolveRumination(verdicts) === 'rest') {
        console.warn('[amsg:autonomy] 选题全是最近写过的冷饭，这一轮收成 rest', carried.charId);
        experiences = [];
        rested = true;
      } else {
        experiences = experiences.filter((_, index) => !verdicts[index].blocked);
      }
    }

    const processed = experiences
      .map((item) => ({ ...item, note: postProcessNote(item.note) }))
      .filter((item) => item.note.length > 0);

    // 推送判定在写库之前：pushed 要跟着经历行一起落（客户端按它决定要不要转述）。
    const parts = wallClockPartsInZone(carried.nowMs, { tzId: carried.tzId });
    const pushedToday = await countPushedOnDate(db, carried.charId, carried.tzId, carried.dateKey, carried.nowMs);
    const push = shouldPushAutonomy({
      push: carried.autonomy.push,
      pushedToday,
      lastPushAt: carried.lastPushAt,
      nowMs: carried.nowMs,
      ...(carried.autonomy.quietHours ? { quietHours: carried.autonomy.quietHours } : {}),
      minutesOfDay: parts.hour * 60 + parts.minute,
    }) && processed.length > 0;

    const written: AutonomyResultExperience[] = [];
    for (const [index, item] of processed.entries()) {
      const isPushed = push && index === 0;
      const id = crypto.randomUUID();
      await addAutonomyExperience(db, {
        id,
        charId: carried.charId,
        createdAt: carried.nowMs,
        q: item.q,
        note: item.note,
        kind: item.kind,
        importance: item.importance,
        pushed: isPushed,
      });
      written.push({
        id,
        q: item.q,
        note: item.note,
        kind: item.kind,
        importance: item.importance,
        pushed: isPushed,
      });
    }

    // 这一轮没产出任何可用经历（含被后处理削空）= 事实上的 rest。
    const finalRested = rested || written.length === 0;
    const did = dominantAutonomyKind(written);
    const payload = buildAutonomyResultPayload({
      charId: carried.charId,
      experiences: written,
      proposedEvents: reply.proposedEvents,
      usage,
      did,
      rested: finalRested,
    });
    const notification = push && written.length > 0
      ? { show: 'always' as const, body: written[0].note }
      : { show: false as const };

    const outcome = async (): Promise<void> => {
      await reportOutcome(
        carried.charId,
        { ok: true, tokens: usage.total, ...(push ? { pushed: true } : {}) },
        { db, dateKey: carried.dateKey, nowMs: carried.nowMs },
      );
    };

    if (typeof ctx.emitResult !== 'function') {
      // 老部署没有这个能力：经历已经落 D1（角色自己的账没白记），只是送不回客户端。
      console.warn('[amsg:autonomy] 这台 worker 不支持 emitResult，这一轮结果送不回去', carried.charId);
      await outcome();
      return { decision: 'skip-push', reason: 'autonomy-emit-result-unsupported' };
    }

    try {
      await ctx.emitResult({ ...payload, notification });
    } catch (error) {
      // 收件箱表缺列这类失败重试也送不回去（LLM 已经烧过一次），就地收成跳过。
      console.warn('[amsg:autonomy] 结果送不进收件箱（多半是收件箱表没建全）', carried.charId, error);
      await outcome();
      return { decision: 'skip-push', reason: 'autonomy-emit-result-failed' };
    }

    await outcome();
    console.log('[amsg:autonomy] 这一轮跑完', {
      charId: carried.charId,
      did,
      rested: finalRested,
      experiences: written.length,
      pushed: push,
      tokens: usage.total,
    });
    return { decision: 'skip-push', reason: finalRested ? 'autonomy-rested' : 'autonomy-result-emitted' };
  },
};
