/**
 * 自主背景生活结果在客户端的落点（C1）。
 *
 * worker 跑完一轮 `autonomous_round` 后把结果信封（resultKind='autonomy_result'）送回
 * 收件箱；这里把它折成客户端的三份账：
 *   - 转述账本 `autonomous_outbox`：每条经历一行（id = D1 行 id，重投 put 覆盖去重），
 *     外加被降级改道的大事件行（`【待定】` + summary）；
 *   - 日记 `diaries`：每条经历在当天写一页，角色侧 charPage 落 note；
 *   - 世界事件 `airp_events` + 物化 `airp_world`：proposedEvents 里未被降级的事件。
 * 另写一条 `autonomous_heartbeats` 心跳（面板只读）。
 *
 * 幂等：outbox / 事件 / 日记 / 心跳全部按确定性 id put 覆盖，同一份 payload 重投不翻倍。
 *
 * 返回契约同 dispatchAmsgResult：`true` = 销账（含「形状坏了，留着也没用」的坏载荷），
 * `false` = 这次没落地（存储抛错），账留着下次上线重试。
 *
 * 降级改道（deviation 2）：`impact==='major' && autonomyLevel < 3` 的事件不物化世界
 * 事实，改落一条 importance=big、told=0 的 outbox 待定行（等用户 engage 再交代），
 * 事件行仍按历史落库但 disclosedToUser=false；其余事件落库即 disclosed=true，
 * 由 outbox 的 told 标记单独追踪是否被转述（refined disclosed-rule）。
 */

import { DB } from './db';
import { mergeAutonomySettings } from './airp/autonomySettings';
import { saveAirpEvents } from './airp/eventStore';
import { materializeCommittedEvents } from './airp/worldStore';
import type { AirpCommittedEvent } from './airp/commit';
import type { AutonomousOutboxEntry, AutonomyHeartbeat } from '../types';

const HEADER = '[airp:autonomy]';

const AUTONOMY_DID_KINDS = ['surf', 'game', 'forum', 'rest', 'mixed'] as const;
type AutonomyDid = (typeof AUTONOMY_DID_KINDS)[number];

const OUTBOX_KINDS = ['surf', 'game', 'forum', 'rest'] as const;
type OutboxKind = 'surf' | 'game' | 'forum' | 'rest' | 'mixed';

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'conversation', 'activity', 'movement', 'schedule', 'relationship', 'discovery', 'social_trace',
]);

const EVENT_IMPACTS = ['trace', 'minor', 'major'] as const;
type EventImpact = (typeof EVENT_IMPACTS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** 经历 importance 是 0..3 的数字；outbox 只分大小两档（>=2 视为 big）。 */
const toOutboxImportance = (value: unknown): 'big' | 'small' =>
  typeof value === 'number' && Number.isFinite(value) && value >= 2 ? 'big' : 'small';

const toOutboxKind = (value: unknown): OutboxKind =>
  typeof value === 'string' && (OUTBOX_KINDS as readonly string[]).includes(value)
    ? (value as OutboxKind)
    : 'mixed';

const toEventImpact = (value: unknown): EventImpact =>
  typeof value === 'string' && (EVENT_IMPACTS as readonly string[]).includes(value)
    ? (value as EventImpact)
    : 'trace';

const toDid = (value: unknown): AutonomyDid =>
  typeof value === 'string' && (AUTONOMY_DID_KINDS as readonly string[]).includes(value)
    ? (value as AutonomyDid)
    : 'mixed';

/** 日记日用 UTC YYYY-MM-DD（确定性选择：payload 不带角色时区日期）。 */
const utcDateKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const readUsage = (raw: unknown): { prompt: number; completion: number; total: number } => {
  const rec = isRecord(raw) ? raw : {};
  const pick = (key: string): number => {
    const value = rec[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const prompt = pick('prompt');
  const completion = pick('completion');
  const total = pick('total') || prompt + completion;
  return { prompt, completion, total };
};

interface NormalizedExperience {
  id: string;
  q: string;
  note: string;
  kind: OutboxKind;
  importance: 'big' | 'small';
  pushed: 0 | 1;
}

const normalizeExperience = (raw: unknown): NormalizedExperience | null => {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  return {
    id: raw.id,
    q: typeof raw.q === 'string' ? raw.q : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    kind: toOutboxKind(raw.kind),
    importance: toOutboxImportance(raw.importance),
    pushed: raw.pushed === true ? 1 : 0,
  };
};

interface NormalizedProposedEvent {
  type: AirpCommittedEvent['type'];
  summary: string;
  participants: string[];
  locationLabel?: string;
  impact: EventImpact;
}

const normalizeProposedEvent = (raw: unknown): NormalizedProposedEvent | null => {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  const summary = raw.summary;
  if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return null;
  if (typeof summary !== 'string' || summary.length === 0) return null;
  const participants = Array.isArray(raw.participants)
    ? raw.participants.filter((item): item is string => typeof item === 'string')
    : [];
  const event: NormalizedProposedEvent = {
    type: type as AirpCommittedEvent['type'],
    summary,
    participants,
    impact: toEventImpact(raw.impact),
  };
  if (typeof raw.locationLabel === 'string' && raw.locationLabel.length > 0) {
    event.locationLabel = raw.locationLabel;
  }
  return event;
};

/**
 * 自主生活结果落点。坏载荷（非对象 / 缺 charId / experiences、proposedEvents 不是数组）
 * 打 warn 后销账（true），不写任何东西；存储抛错回 false 留账重试。
 */
export async function applyAutonomyResult(payload: unknown): Promise<boolean> {
  if (!isRecord(payload)) {
    console.warn(`${HEADER} 载荷不是对象，丢弃`, payload);
    return true;
  }
  const charId = payload.charId;
  if (!isNonEmptyString(charId)) {
    console.warn(`${HEADER} 载荷缺 charId，丢弃`, payload);
    return true;
  }
  const experiencesRaw = payload.experiences;
  const proposedRaw = payload.proposedEvents;
  if (!Array.isArray(experiencesRaw) || !Array.isArray(proposedRaw)) {
    console.warn(`${HEADER} experiences/proposedEvents 不是数组，丢弃`, charId);
    return true;
  }

  try {
    await landAutonomyResult({
      charId,
      experiences: experiencesRaw.map(normalizeExperience).filter((item): item is NormalizedExperience => item !== null),
      proposedEvents: proposedRaw.map(normalizeProposedEvent).filter((item): item is NormalizedProposedEvent => item !== null),
      usage: readUsage(payload.usage),
      toolsUsed: Array.isArray(payload.toolsUsed)
        ? payload.toolsUsed.filter((item): item is string => typeof item === 'string')
        : [],
      did: toDid(payload.did),
      anchorFromFirstExperience: isRecord(experiencesRaw[0]) && isNonEmptyString(experiencesRaw[0].id)
        ? experiencesRaw[0].id
        : undefined,
    });
    return true;
  } catch (error) {
    console.warn(`${HEADER} 落库失败，账没销，下次上线重试`, charId, error);
    return false;
  }
}

interface LandInput {
  charId: string;
  experiences: NormalizedExperience[];
  proposedEvents: NormalizedProposedEvent[];
  usage: { prompt: number; completion: number; total: number };
  toolsUsed: string[];
  did: AutonomyDid;
  anchorFromFirstExperience?: string;
}

async function landAutonomyResult(input: LandInput): Promise<void> {
  const { charId } = input;
  const atMs = Date.now();
  // rest 轮（无经历）没有 D1 行 id 可锚，退化成处理时刻；重投会换锚（崩溃窗口内的
  // 残留重复，记录在案）。有经历时锚定首条 D1 id，重投稳定。
  const roundAnchor = input.anchorFromFirstExperience ?? `ts${atMs}`;

  const level = await readAutonomyLevel(charId);

  const outboxEntries: AutonomousOutboxEntry[] = input.experiences.map((exp) => ({
    id: exp.id,
    charId,
    ts: atMs,
    q: exp.q,
    note: exp.note,
    kind: exp.kind,
    importance: exp.importance,
    told: 0,
    pushed: exp.pushed,
    // 经历行与 proposedEvents 之间没有 per-proposal 关联（信封里就没有），
    // 不做粗粒度的整轮关联——只有改道行带精确的 1:1 eventIds。
    eventIds: [],
  }));

  const events: AirpCommittedEvent[] = [];
  const materializeQueue: AirpCommittedEvent[] = [];

  for (const [index, proposal] of input.proposedEvents.entries()) {
    const eventId = `airp-${charId}-${roundAnchor}-${index}`;
    const rerouted = proposal.impact === 'major' && level < 3;
    const event: AirpCommittedEvent = {
      id: eventId,
      charId,
      type: proposal.type,
      summary: proposal.summary,
      participants: [...proposal.participants],
      ...(proposal.locationLabel !== undefined ? { locationLabel: proposal.locationLabel } : {}),
      impact: proposal.impact,
      at: atMs,
      // commit.ts 的 authority 是 'confirmed_scene' 字面量（不在本次改动范围），
      // 自主事件没人目击、按 deviation-3 记 runtime_state，运行时值优先于这里的窄化声明。
      authority: 'runtime_state' as AirpCommittedEvent['authority'],
      // 落地即有 outbox/转述账追踪的事件视为已交代（told 标记才是真正的追踪面）；
      // 改道的大事件没人知道，等 told-flip 翻。
      disclosedToUser: !rerouted,
      source: { kind: 'runtime', label: 'airp-autonomy' },
    };
    events.push(event);

    if (rerouted) {
      outboxEntries.push({
        id: `airp-${charId}-${roundAnchor}-susp-${index}`,
        charId,
        ts: atMs,
        q: proposal.summary.slice(0, 80),
        note: `【待定】${proposal.summary}`,
        kind: 'mixed',
        importance: 'big',
        told: 0,
        pushed: 0,
        eventIds: [eventId],
      });
    } else {
      materializeQueue.push(event);
    }
  }

  // 1. 转述账本（经历行 + 改道行）
  await DB.saveOutboxEntries(outboxEntries);

  // 2. 日记：每条经历在当天写一页角色侧（userPage 只是占位空页）
  for (const exp of input.experiences) {
    await DB.saveDiary({
      id: `airp-diary-${exp.id}`,
      charId,
      date: utcDateKey(atMs),
      userPage: { text: '', paperStyle: 'grid', stickers: [] },
      charPage: { text: exp.note, paperStyle: 'plain', stickers: [] },
      timestamp: atMs,
      isArchived: false,
    });
  }

  // 3. 世界事件 + 物化（改道的事件不物化）
  await saveAirpEvents(events);
  for (const event of materializeQueue) {
    await materializeCommittedEvents(charId, [event], atMs, 'runtime_state');
  }

  // 4. 心跳（字段与面板只读行逐一对齐）
  const heartbeat: AutonomyHeartbeat = {
    id: `airp-hb-${charId}-${roundAnchor}`,
    charId,
    ts: atMs,
    wokeAt: atMs,
    did: input.did,
    toolsUsed: input.toolsUsed,
    usage: input.usage,
    pushed: input.experiences.some((exp) => exp.pushed === 1) ? 1 : 0,
    outboxed: outboxEntries.length,
  };
  await DB.saveHeartbeat(heartbeat);
}

/** 读角色的自主档位；角色不在库里按 0（改道，不物化）。存取器缺表时 getAllCharacters 仍可用。 */
async function readAutonomyLevel(charId: string): Promise<number> {
  const characters = await DB.getAllCharacters();
  const character = characters.find((item) => item.id === charId);
  if (!character) return 0;
  return mergeAutonomySettings(character).autonomyLevel;
}
