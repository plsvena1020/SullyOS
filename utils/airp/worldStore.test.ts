/**
 * AIRP 世界事实/知识：airp_world store 事件物化 + 备份登记。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层（无 storage stub）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from '../db';
import { loadAirpWorld, materializeCommittedEvents } from './worldStore';
import { knownBackupStoreFieldMap } from '../backupCoverage';
import type { AirpCommittedEvent } from './commit';

const mkEvent = (
  id: string,
  charId: string,
  type: AirpCommittedEvent['type'],
  summary: string,
  at: number,
): AirpCommittedEvent => ({
  id,
  charId,
  at,
  type,
  summary,
  participants: [charId],
  impact: 'minor',
  authority: 'confirmed_scene',
  disclosedToUser: true,
  source: { kind: 'assistant_message', id: 'msg-1' },
});

async function clearAirpWorld(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('airp_world', 'readwrite');
    tx.objectStore('airp_world').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function rawWorldCount(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('airp_world', 'readonly');
    const req = tx.objectStore('airp_world').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

beforeEach(async () => {
  await clearAirpWorld();
});

describe('loadAirpWorld / materializeCommittedEvents（真实 DB 层）', () => {
  it('空世界返回空文档，且读不落行', async () => {
    const doc = await loadAirpWorld('c1');
    expect(doc).toEqual({ charId: 'c1', facts: [], knowledge: [], updatedAt: 0 });
    expect(await DB.getAirpWorld('c1')).toBeUndefined();
    expect(await rawWorldCount()).toBe(0);
  });

  it('空事件输入 no-op，不落行', async () => {
    const result = await materializeCommittedEvents('c1', [], 1000);
    expect(result).toEqual({ factsWritten: [], knowledgeAdded: [] });
    expect(await rawWorldCount()).toBe(0);
  });

  it('两个不同事件 → 两条事实 + 两条 known，重载仍在', async () => {
    const result = await materializeCommittedEvents('c1', [
      mkEvent('ev1', 'c1', 'activity', '去公园散步', 100),
      mkEvent('ev2', 'c1', 'discovery', '发现一本旧相册', 200),
    ], 500);

    expect(result.factsWritten.map(f => f.id).sort()).toEqual(['airp-fact-ev1', 'airp-fact-ev2']);
    expect(result.knowledgeAdded.map(k => k.factId).sort()).toEqual(['airp-fact-ev1', 'airp-fact-ev2']);

    const doc = await loadAirpWorld('c1');
    expect(doc.updatedAt).toBe(500);
    expect(doc.facts.map(f => f.predicate).sort()).toEqual([
      'airp_event_activity',
      'airp_event_discovery',
    ]);
    expect(doc.facts.every(f => f.status === 'active')).toBe(true);
    expect(doc.facts.every(f => f.source.label === 'airp-commit')).toBe(true);
    expect(doc.knowledge).toHaveLength(2);
    expect(doc.knowledge.every(k => k.knowerId === 'c1' && k.state === 'known')).toBe(true);
  });

  it('同 predicate 两次（atMs2 > atMs1）→ 新者胜、旧者留痕 superseded、知识指向赢家', async () => {
    await materializeCommittedEvents('c1', [
      mkEvent('a1', 'c1', 'activity', '在家看书', 100),
    ], 1000);
    await materializeCommittedEvents('c1', [
      mkEvent('a2', 'c1', 'activity', '去河边跑步', 200),
    ], 2000);

    const doc = await loadAirpWorld('c1');
    expect(doc.facts.filter(f => f.status === 'active').map(f => f.id)).toEqual(['airp-fact-a2']);
    expect(doc.facts.filter(f => f.status === 'superseded').map(f => f.id)).toEqual(['airp-fact-a1']);
    // 知识条目按「本次物化的赢家」新增：最新一条指向 a2
    expect(doc.knowledge.filter(k => k.learnedAt === 2000).map(k => k.factId)).toEqual(['airp-fact-a2']);
  });

  it('重复物化同一批事件 → 事实不重复（确定性 id 收敛）', async () => {
    const events = [
      mkEvent('r1', 'c1', 'activity', '去公园散步', 100),
      mkEvent('r2', 'c1', 'discovery', '发现一本旧相册', 200),
    ];
    await materializeCommittedEvents('c1', events, 500);
    await materializeCommittedEvents('c1', events, 500);

    const doc = await loadAirpWorld('c1');
    expect(doc.facts.map(f => f.id).sort()).toEqual(['airp-fact-r1', 'airp-fact-r2']);
    expect(doc.facts.every(f => f.status === 'active')).toBe(true);
    expect(doc.knowledge).toHaveLength(2);
  });

  it('knowledge 按 (factId+knowerId) upsert：同键替换不追加', async () => {
    await materializeCommittedEvents('c1', [
      mkEvent('k1', 'c1', 'activity', '在家看书', 100),
    ], 1000);
    await materializeCommittedEvents('c1', [
      mkEvent('k1', 'c1', 'activity', '在家看书', 100),
    ], 3000);

    const doc = await loadAirpWorld('c1');
    expect(doc.knowledge).toHaveLength(1);
    expect(doc.knowledge[0].factId).toBe('airp-fact-k1');
    expect(doc.knowledge[0].knowerId).toBe('c1');
    expect(doc.knowledge[0].learnedAt).toBe(3000);
  });

  it('按角色隔离：不同 charId 各存各的世界文档', async () => {
    await materializeCommittedEvents('c1', [
      mkEvent('x1', 'c1', 'activity', '在家看书', 100),
    ], 1000);
    await materializeCommittedEvents('c2', [
      mkEvent('x2', 'c2', 'discovery', '发现一本旧相册', 200),
    ], 2000);

    expect((await loadAirpWorld('c1')).facts.map(f => f.id)).toEqual(['airp-fact-x1']);
    expect((await loadAirpWorld('c2')).facts.map(f => f.id)).toEqual(['airp-fact-x2']);
  });
});

describe('备份登记（airp_world → airpWorlds）', () => {
  it('KNOWN 映射指向 airpWorlds 字段', () => {
    expect(knownBackupStoreFieldMap()['airp_world']).toBe('airpWorlds');
  });

  it('exportFullData → importFullData 往返：世界文档整组清-加恢复', async () => {
    await materializeCommittedEvents('c1', [
      mkEvent('b1', 'c1', 'activity', '在家看书', 10),
    ], 100);
    await materializeCommittedEvents('c2', [
      mkEvent('b2', 'c2', 'activity', '去公园散步', 20),
    ], 200);

    const exported = await DB.exportFullData();
    expect((exported.airpWorlds ?? []).map(d => d.charId).sort()).toEqual(['c1', 'c2']);

    await clearAirpWorld();
    expect(await DB.getAirpWorld('c1')).toBeUndefined();

    await DB.importFullData({ ...exported } as any);

    expect((await loadAirpWorld('c1')).facts.map(f => f.id)).toEqual(['airp-fact-b1']);
    expect((await loadAirpWorld('c2')).facts.map(f => f.id)).toEqual(['airp-fact-b2']);
  });
});
