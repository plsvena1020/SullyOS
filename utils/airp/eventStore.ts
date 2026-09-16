import { DB } from '../db';
import type { AirpCommittedEvent } from './commit';

/**
 * AIRP 世界事件流的浏览器侧读写入口。存储落在 utils/db.ts 的 `airp_events` store
 * （v75，keyPath 'id' + charId 索引），本模块只做薄封装：不直接碰 IDB，缺表/空输入
 * 时静默降级，保证老库或未升级场景下调用方不需要额外判断。
 */

export async function saveAirpEvents(events: AirpCommittedEvent[]): Promise<void> {
  if (!Array.isArray(events) || events.length === 0) return;
  await DB.saveAirpEvents(events);
}

export async function listAirpEventsByChar(
  charId: string,
  limit = 50,
): Promise<AirpCommittedEvent[]> {
  if (!charId) return [];
  return DB.getAirpEventsByChar(charId, limit);
}

/**
 * 把指定事件标成「已对用户交代」。转述账本（autonomous_outbox）被消费时，
 * 消费方拿条目上的 eventIds 调这里翻掉 linked 事件的 disclosedToUser。
 * 空输入 / 空 charId no-op；事件表缺表时 list 回空数组，自然 no-op。
 */
export async function markEventsDisclosed(charId: string, ids: string[]): Promise<void> {
  if (!charId || !Array.isArray(ids) || ids.length === 0) return;
  const wanted = new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0));
  if (wanted.size === 0) return;
  const events = await listAirpEventsByChar(charId, 1000);
  const flipped = events
    .filter((event) => wanted.has(event.id) && event.disclosedToUser !== true)
    .map((event) => ({ ...event, disclosedToUser: true }));
  if (flipped.length === 0) return;
  await saveAirpEvents(flipped);
}
