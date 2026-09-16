/**
 * AIRP 投影共享词汇表（stage 5 基础模块）。
 *
 * 各 App 把 AIRP 事件投影成自己能显示的东西时，统一从这里取分类、筛选与场景块渲染，
 * 避免每个 App 各写一套可见性判断。本模块是纯叶子：只做类型导入（见文件末），
 * 浏览器与 worker 打包都能安全引入。
 *
 * 投影锚点约定（anchor convention — 由各 App 任务自行实现，本模块不含任何持久化代码）：
 * 1. 每条投影出来的实体都必须带 `airpEventId: <event.id>`，时间戳取 `event.at`
 *    （不要用写入时刻重新计时，否则事件与投影无法对账）。
 * 2. 再次投影前，先逐条扫描该 App 中现有的 `airpEventId`，收集成集合即可，无需额外索引。
 * 3. 若已有同 id 的实体就跳过写入：同一事件重复投影必须幂等，第二次跑不产生副本。
 * 4. 去重与写入由消费本模块的各个 App 任务落实，本模块只保证词汇统一。
 */
import type { AirpCommittedEvent } from './commit';

export type AirpEventVisibility = 'public' | 'private' | 'trace';

/** 影响为 trace/minor 时才可能公开的活动组类型。 */
const PUBLIC_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'activity',
  'movement',
  'schedule',
  'discovery',
]);

/** 本质上属于私密交互的类型，无论影响大小都不外泄。 */
const PRIVATE_TYPES: ReadonlySet<string> = new Set(['conversation', 'relationship']);

function isPresentText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPresentNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 分类采用「宁少勿多」：模糊一律按私密处理。
 * 判定顺序锁定为：先 major/关系/对话 → private；再 social_trace → trace；
 * 再活动组且 trace/minor → public；其余默认 private。
 */
export function classifyEventVisibility(
  event: Pick<AirpCommittedEvent, 'type' | 'impact'>,
): AirpEventVisibility {
  if (event.impact === 'major' || PRIVATE_TYPES.has(event.type)) return 'private';
  if (event.type === 'social_trace') return 'trace';
  if (
    PUBLIC_ACTIVITY_TYPES.has(event.type) &&
    (event.impact === 'trace' || event.impact === 'minor')
  ) {
    return 'public';
  }
  return 'private';
}

/**
 * 按 at 倒序防御性重排：即使调用方给的是乱序（或本身已排序）也保证结果有序；
 * at 相等或非有限值时保持输入相对顺序（稳定）。返回新数组，不修改入参。
 */
function sortByAtDesc<T extends { at: number }>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (b.event.at - a.event.at) || (a.index - b.index))
    .map((entry) => entry.event);
}

/** limit 未给 → 不限；limit <= 0 → 空；否则取前 limit 条。 */
function takeLimit<T>(events: T[], limit?: number): T[] {
  if (limit === undefined) return events;
  if (limit <= 0) return [];
  return events.slice(0, limit);
}

export function selectEventsByVisibility<
  T extends Pick<AirpCommittedEvent, 'type' | 'impact' | 'at'>,
>(events: readonly T[], visibility: AirpEventVisibility, limit?: number): T[] {
  const matched = events.filter((event) => classifyEventVisibility(event) === visibility);
  return takeLimit(sortByAtDesc(matched), limit);
}

export function selectEventsByType<
  T extends Pick<AirpCommittedEvent, 'type' | 'at'>,
>(events: readonly T[], type: AirpCommittedEvent['type'], limit?: number): T[] {
  const matched = events.filter((event) => event.type === type);
  return takeLimit(sortByAtDesc(matched), limit);
}

export interface AirpSceneInput {
  now: number;
  tzId: string;
  locationLabel?: string;
  activity?: string;
  energy?: number;
  mood?: string;
  weatherText?: string;
  movements: Pick<AirpCommittedEvent, 'summary' | 'locationLabel' | 'at'>[];
}

const MAX_MOVEMENTS = 3;

/**
 * 与 utils/airp/directorPrompt.ts:62 的 wallClockText 逐字一致（同一墙钟格式，
 * 全仓不允许出现第二套）。无效 tzId 返回 null，由调用方走 ISO/UTC 兜底。
 */
function wallClockText(tzId: string, now: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch { return null; }
}

/**
 * 渲染角色的当前场景块。缺什么略什么；`now` 不是有限数（时间不可表示）时整块可为空串。
 * 精力/情绪只在活动行存在时以括号附注；近期行踪最多 3 条、按 at 倒序（最近的在前）。
 */
export function renderSceneBlock(input: AirpSceneInput): string {
  const lines: string[] = [];

  if (isPresentNumber(input.now)) {
    const wall = isPresentText(input.tzId) ? wallClockText(input.tzId, input.now) : null;
    lines.push(
      wall
        ? `时间：${wall}（${input.tzId}）`
        : `时间：${new Date(input.now).toISOString()}（UTC）`,
    );
  }

  if (isPresentText(input.locationLabel)) lines.push(`地点：${input.locationLabel}`);

  if (isPresentText(input.activity)) {
    const extras: string[] = [];
    if (isPresentNumber(input.energy)) extras.push(`精力 ${input.energy}`);
    if (isPresentText(input.mood)) extras.push(`情绪 ${input.mood}`);
    lines.push(
      extras.length > 0 ? `活动：${input.activity}（${extras.join('，')}）` : `活动：${input.activity}`,
    );
  }

  if (isPresentText(input.weatherText)) lines.push(`天气：${input.weatherText}`);

  const movements = (Array.isArray(input.movements) ? input.movements : []).filter((movement) =>
    isPresentText(movement?.summary),
  );
  const recent = sortByAtDesc(movements)
    .slice(0, MAX_MOVEMENTS)
    .map((movement) => movement.summary);
  if (recent.length > 0) {
    lines.push('近期行踪：');
    for (const summary of recent) lines.push(`- ${summary}`);
  }

  return lines.join('\n');
}
