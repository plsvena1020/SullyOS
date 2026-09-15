/**
 * AIRP 世界事件流：airp_events store 读写 + 备份登记。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层（无 storage stub）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from '../db';
import { listAirpEventsByChar, saveAirpEvents } from './eventStore';
import { knownBackupStoreFieldMap } from '../backupCoverage';
import type { AirpCommittedEvent } from './commit';

const mkEvent = (id: string, charId: string, at: number): AirpCommittedEvent => ({
  id,
  charId,
  at,
  type: 'activity',
  summary: `事件 ${id}`,
  participants: [charId],
  impact: 'minor',
  authority: 'confirmed_scene',
  disclosedToUser: true,
  source: { kind: 'assistant_message', id: 'msg-1' },
});

async function clearAirpEvents(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('airp_events', 'readwrite');
    tx.objectStore('airp_events').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

beforeEach(async () => {
  await clearAirpEvents();
});

describe('saveAirpEvents / listAirpEventsByChar（真实 DB 层）', () => {
  it('空输入 no-op；空表 / 空 charId 返回 []', async () => {
    await saveAirpEvents([]);
    expect(await listAirpEventsByChar('c1')).toEqual([]);
    expect(await listAirpEventsByChar('')).toEqual([]);
  });

  it('按角色隔离、at 倒序、limit 截断', async () => {
    await saveAirpEvents([
      mkEvent('e1', 'c1', 100),
      mkEvent('e2', 'c1', 300),
      mkEvent('e3', 'c1', 200),
      mkEvent('e9', 'c2', 999),
    ]);

    expect((await listAirpEventsByChar('c1')).map(e => e.id)).toEqual(['e2', 'e3', 'e1']);
    expect((await listAirpEventsByChar('c1', 2)).map(e => e.id)).toEqual(['e2', 'e3']);
    expect((await listAirpEventsByChar('c2')).map(e => e.id)).toEqual(['e9']);
  });

  it('同 id 重复保存按 put 幂等覆盖，不产生重复行', async () => {
    await saveAirpEvents([mkEvent('dup', 'c1', 100), mkEvent('other', 'c1', 50)]);
    await saveAirpEvents([mkEvent('dup', 'c1', 500)]);

    const all = await listAirpEventsByChar('c1');
    expect(all.map(e => e.id)).toEqual(['dup', 'other']);
    expect(all[0].at).toBe(500);
  });
});

describe('备份登记（airp_events → airpEvents）', () => {
  it('KNOWN 映射指向 airpEvents 字段', () => {
    expect(knownBackupStoreFieldMap()['airp_events']).toBe('airpEvents');
  });

  it('exportFullData → importFullData 往返：事件整组清-加恢复', async () => {
    await saveAirpEvents([mkEvent('b1', 'c1', 10), mkEvent('b2', 'c2', 20)]);

    const exported = await DB.exportFullData();
    expect((exported.airpEvents ?? []).map(e => e.id).sort()).toEqual(['b1', 'b2']);

    await clearAirpEvents();
    expect(await listAirpEventsByChar('c1')).toEqual([]);

    await DB.importFullData({ ...exported } as any);

    expect((await listAirpEventsByChar('c1')).map(e => e.id)).toEqual(['b1']);
    expect((await listAirpEventsByChar('c2')).map(e => e.id)).toEqual(['b2']);
  });
});
