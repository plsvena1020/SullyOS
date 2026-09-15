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
