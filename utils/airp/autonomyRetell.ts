/**
 * 自主背景生活的「转述块」（plans/autonomy-round.md §2.5，C2）。
 *
 * 把角色离线自主生活攒下的经历（autonomous_outbox 里 told=0 && pushed=0 的条目）
 * 折成一段背景块，交给私聊主链的 volatileTail。只负责「说没说出口」：
 * 谁把条目讲给用户听了，谁就用 markAutonomyTold 记账，顺带把 linked 的
 * AIRP 事件翻成「已对用户交代」。
 *
 * 纯浏览器侧：只 import DB + 类型；worker 侧的渲染（C3）不在本期，不在此文件。
 */
import { DB } from '../db';
import type { AutonomousOutboxEntry } from '../../types';
import type { ResolvedAirpAutonomy, RetellStyle } from './autonomySettings';
import { markEventsDisclosed } from './eventStore';

export interface AutonomyRetellSelection {
  /** 要拼进 volatileTail 的整块文本；没有可转述的条目时为空串（整块不注入）。 */
  block: string;
  /** 块里出现过的 outbox 条目 id —— told 记账的输入。 */
  toldIds: string[];
}

// 块头与固定分寸语：plans/autonomy-round.md §2.5 逐字。
const BLOCK_HEADER = '[System: 离线自主经历]';
const FIXED_TONE = '你前几晚自己去网上逛过/玩过，记着这些——TA 聊到相关话头、或你自己想分享时自然带一句就好；别报流水账、别每轮都提。';

/**
 * 语气映射（7 格；custom 走 customHint 原样拼）。都是「怎么说」的口吻指令，
 * 不带人设声明、不含剧情指令 —— 人设与内容由角色自身与经历条目决定。
 */
const STYLE_LINES: Record<Exclude<RetellStyle, 'custom'>, string> = {
  battle: '讲得像打了一场仗：句子短、有输有赢，带点劲儿。',
  brief: '挑重点讲，三言两语说完，别铺开。',
  casual: '随口一提的口气，像闲聊时顺嘴带出来的。',
  coquettish: '带点撒娇的软劲儿，尾音拖一点，别腻。',
  diary: '像翻自己的日记那样平实地说，安静一点。',
  teaser: '只说个开头勾一下，留一半等对方追问。',
  plain: '平实地讲，不加修饰。',
};

const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_MAX_CHARS = 800;

/**
 * 起头许可（opener）单向分叉：默认收紧 —— 只有显式 `opener === true` 才允许主动提起。
 * 位置在条目清单之后：紧随语气行会切断「块头/分寸语/语气/清单」的连续文本断言。
 */
const OPENER_LINES = {
  allowed: '这些经历你也可以主动提起，不必等用户先聊到。',
  restricted: '只有聊到相关话头时才自然带出，不要主动提起这些经历。',
} as const;

const styleLine = (retell: ResolvedAirpAutonomy['retell']): string => {
  if (retell.style === 'custom') {
    const hint = (retell.customHint ?? '').trim();
    return hint.length > 0 ? hint : STYLE_LINES.plain;
  }
  return STYLE_LINES[retell.style] ?? STYLE_LINES.plain;
};

const openerLine = (retell: ResolvedAirpAutonomy['retell']): string =>
  retell.opener === true ? OPENER_LINES.allowed : OPENER_LINES.restricted;

/** big 优先、同级按时间倒序；同 ts 用 id 兜底，保证选择结果稳定可复现。 */
const compareImportance = (a: AutonomousOutboxEntry, b: AutonomousOutboxEntry): number => {
  const rank = (entry: AutonomousOutboxEntry): number => (entry.importance === 'big' ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.ts !== b.ts) return b.ts - a.ts;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
};

/**
 * 组装本轮转述块。told=0 && pushed=0 的条目按重要性排序，取到条数 / 字数上限为止；
 * 上限按条目整条结算——放不下的整条丢弃，绝不把一条经历截成半截。
 * 一条都取不出（含空账本）→ 整块不注入（"没查"与"查了没有"不共用出口的既有纪律）。
 * 块尾按 opener 补一句「可否主动提起」的许可：`true` 才允许主动起头，否则只接话头。
 */
export async function buildAutonomyRetellBlock(
  charId: string,
  retell: ResolvedAirpAutonomy['retell'],
): Promise<AutonomyRetellSelection> {
  if (!charId) return { block: '', toldIds: [] };

  const rows = await DB.getOutboxByChar(charId);
  const candidates = rows.filter((row) => row.told === 0 && row.pushed === 0);
  candidates.sort(compareImportance);

  const maxItems = retell.maxItems > 0 ? Math.floor(retell.maxItems) : DEFAULT_MAX_ITEMS;
  const maxChars = retell.maxChars > 0 ? Math.floor(retell.maxChars) : DEFAULT_MAX_CHARS;

  const selected: AutonomousOutboxEntry[] = [];
  let usedChars = 0;
  for (const row of candidates) {
    if (selected.length >= maxItems) break;
    const note = typeof row.note === 'string' ? row.note : '';
    const line = `- ${note}`;
    if (usedChars + line.length > maxChars) break;
    selected.push(row);
    usedChars += line.length;
  }

  if (selected.length === 0) return { block: '', toldIds: [] };

  const block = [
    BLOCK_HEADER,
    FIXED_TONE,
    styleLine(retell),
    ...selected.map((row) => `- ${typeof row.note === 'string' ? row.note : ''}`),
    openerLine(retell),
  ].join('\n');

  return { block, toldIds: selected.map((row) => row.id) };
}

/**
 * 把条目标成「已转述」，并翻转它们 linked 的 AIRP 事件。
 *
 * - 缺失 / 已 told 的 id 静默跳过（重跑幂等），返回的 marked 只含本次新标记的；
 * - toldBy 未定义时保持字段缺省（不给它编一个数字）；
 * - 存储失败向外抛：调用方（后处理 Step 8）整段包了 try/catch，永远不挡本轮聊天。
 */
export async function markAutonomyTold(
  charId: string,
  toldIds: string[],
  toldBy: number | undefined,
): Promise<{ marked: string[]; flipped: string[] }> {
  const marked: string[] = [];
  const flipped: string[] = [];
  if (!charId || !Array.isArray(toldIds) || toldIds.length === 0) return { marked, flipped };

  const wanted = new Set(
    toldIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  if (wanted.size === 0) return { marked, flipped };

  const rows = await DB.getOutboxByChar(charId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const updated: AutonomousOutboxEntry[] = [];
  const linked: string[] = [];

  for (const id of wanted) {
    const row = byId.get(id);
    if (!row || row.told === 1) continue;
    updated.push({ ...row, told: 1, ...(toldBy !== undefined ? { toldBy } : {}) });
    marked.push(id);
    const eventIds = Array.isArray(row.eventIds) ? row.eventIds : [];
    for (const eventId of eventIds) {
      if (typeof eventId === 'string' && eventId.length > 0) linked.push(eventId);
    }
  }

  if (updated.length === 0) return { marked, flipped };

  await DB.saveOutboxEntries(updated);
  if (linked.length > 0) {
    await markEventsDisclosed(charId, linked);
    flipped.push(...linked);
  }
  return { marked, flipped };
}
