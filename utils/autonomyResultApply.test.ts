/**
 * AIRP 自主生活结果落点（C1）：转述账本 / 日记 / 世界事件 / 心跳 + 降级改道 + 幂等。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层（无 storage stub）。
 *
 * 说明：markEventsDisclosed 与 materializeCommittedEvents 的 authorityOverride 断言也收在这里，
 * 以保证本次提交的 staged 文件集合与 brief 一致（不额外改动 eventStore.test / worldStore.test）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DB, openDB } from './db';
import { applyAutonomyResult } from './autonomyResultApply';
import { listAirpEventsByChar, markEventsDisclosed, saveAirpEvents } from './airp/eventStore';
import { loadAirpWorld, materializeCommittedEvents } from './airp/worldStore';
import { knownBackupStoreFieldMap } from './backupCoverage';
import type { AirpCommittedEvent } from './airp/commit';

const STORES = [
  'autonomous_outbox',
  'autonomous_heartbeats',
  'airp_events',
  'airp_world',
  'diaries',
  'characters',
];

async function clearStores(names: string[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    for (const name of names) tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

beforeEach(async () => {
  await clearStores(STORES);
});

const roundPayload = (overrides: Record<string, unknown> = {}) => ({
  resultKind: 'autonomy_result',
  charId: 'c1',
  experiences: [
    { id: 'exp-1', q: '想知道蝴蝶怎么过冬', note: '查了半天，蝴蝶会找树缝越冬。', kind: 'surf', importance: 'big', pushed: true },
    { id: 'exp-2', q: '试了新游戏', note: '玩了两小时，手感一般。', kind: 'game', importance: 'small', pushed: false },
  ],
  proposedEvents: [
    { type: 'activity', summary: '去河边跑步', impact: 'minor' },
    { type: 'discovery', summary: '翻到一本旧相册', impact: 'trace' },
  ],
  usage: { prompt: 120, completion: 80, total: 200 },
  toolsUsed: [],
  did: 'mixed',
  rested: false,
  ...overrides,
});

const seedChar = async (airp?: Record<string, unknown>): Promise<void> => {
  await DB.saveCharacter({ id: 'c1', name: '测试角色', avatar: '', ...(airp ? { airp } : {}) } as any);
};

const mkEvent = (id: string, disclosed: boolean, authority: AirpCommittedEvent['authority'] = 'confirmed_scene'): AirpCommittedEvent => ({
  id,
  charId: 'c1',
  type: 'activity',
  summary: `事件 ${id}`,
  participants: ['c1'],
  impact: 'minor',
  at: 100,
  authority,
  disclosedToUser: disclosed,
  source: { kind: 'runtime', label: 'airp-autonomy' },
});

describe('applyAutonomyResult — 完整一轮', () => {
  it('二经历 + 二提案：outbox / 日记 / 心跳 / 事件 / 世界事实全部落地', async () => {
    const before = Date.now();
    await expect(applyAutonomyResult(roundPayload())).resolves.toBe(true);
    const after = Date.now();

    // outbox：两条经历行，told=0，pushed 回显，importance 直接取信封字符串
    const outbox = await DB.getOutboxByChar('c1');
    expect(outbox.map((e) => e.id).sort()).toEqual(['exp-1', 'exp-2']);
    const byId = new Map(outbox.map((e) => [e.id, e]));
    expect(byId.get('exp-1')).toMatchObject({
      id: 'exp-1', charId: 'c1', q: '想知道蝴蝶怎么过冬', told: 0, pushed: 1, kind: 'surf', importance: 'big',
    });
    expect(byId.get('exp-2')).toMatchObject({ id: 'exp-2', told: 0, pushed: 0, kind: 'game', importance: 'small' });
    expect(outbox.every((e) => Array.isArray(e.eventIds) && e.eventIds.length === 0)).toBe(true);

    // 日记：角色侧落 note，用户侧空页
    const diaries = await DB.getDiariesByCharId('c1');
    expect(diaries.map((d) => d.id).sort()).toEqual(['airp-diary-exp-1', 'airp-diary-exp-2']);
    const diary = diaries.find((d) => d.id === 'airp-diary-exp-1')!;
    expect(diary.charPage?.text).toBe('查了半天，蝴蝶会找树缝越冬。');
    expect(diary.userPage.text).toBe('');
    expect(diary.isArchived).toBe(false);

    // 事件：未被改道 → 落库即 disclosed=true；authority runtime_state
    const events = await listAirpEventsByChar('c1');
    expect(events.map((e) => e.id).sort()).toEqual(['airp-c1-exp-1-0', 'airp-c1-exp-1-1']);
    // authority 已放宽为 AirpFactAuthority，事件行按 deviation-3 记 runtime_state。
    expect(events.every((e) => e.authority === 'runtime_state')).toBe(true);
    expect(events.every((e) => e.disclosedToUser === true)).toBe(true);
    expect(events.find((e) => e.id === 'airp-c1-exp-1-0')).toMatchObject({
      type: 'activity', summary: '去河边跑步', impact: 'minor', participants: [],
    });

    // 世界事实：物化 authority runtime_state、知识 known
    const world = await loadAirpWorld('c1');
    expect(world.facts.map((f) => f.id).sort()).toEqual(['airp-fact-airp-c1-exp-1-0', 'airp-fact-airp-c1-exp-1-1']);
    expect(world.facts.every((f) => f.authority === 'runtime_state')).toBe(true);
    expect(world.knowledge.every((k) => k.state === 'known' && k.knowerId === 'c1')).toBe(true);

    // 心跳：逐字段对齐面板契约
    const heartbeats = await DB.getHeartbeatsByChar('c1');
    expect(heartbeats).toHaveLength(1);
    const hb = heartbeats[0];
    expect(Object.keys(hb).sort()).toEqual(
      ['charId', 'did', 'id', 'outboxed', 'pushed', 'toolsUsed', 'ts', 'usage', 'wokeAt'],
    );
    expect(hb.id).toBe('airp-hb-c1-exp-1');
    expect(hb.charId).toBe('c1');
    expect(hb.did).toBe('mixed');
    expect(hb.toolsUsed).toEqual([]);
    expect(hb.usage).toEqual({ prompt: 120, completion: 80, total: 200 });
    expect(hb.pushed).toBe(1);
    expect(hb.outboxed).toBe(2);
    expect(hb.wokeAt).toBe(hb.ts);
    expect(hb.ts).toBeGreaterThanOrEqual(before);
    expect(hb.ts).toBeLessThanOrEqual(after);
  });
});

describe('applyAutonomyResult — importance 边界', () => {
  it('信封字符串直接透传；缺失 / 未知 / 旧数字一律 fail-safe 收成 small', async () => {
    await expect(applyAutonomyResult(roundPayload({
      experiences: [
        { id: 'exp-a', q: '', note: 'a', kind: 'surf', importance: 'big', pushed: false },
        { id: 'exp-b', q: '', note: 'b', kind: 'surf', importance: 2, pushed: false },
        { id: 'exp-c', q: '', note: 'c', kind: 'surf', pushed: false },
        { id: 'exp-d', q: '', note: 'd', kind: 'surf', importance: 'huge', pushed: false },
      ],
    }))).resolves.toBe(true);

    const byId = new Map((await DB.getOutboxByChar('c1')).map((e) => [e.id, e]));
    expect(byId.get('exp-a')!.importance).toBe('big');
    // 旧数字信封（>=2）不再被分档成 big——数值映射已下线。
    expect(byId.get('exp-b')!.importance).toBe('small');
    expect(byId.get('exp-c')!.importance).toBe('small');
    expect(byId.get('exp-d')!.importance).toBe('small');
  });
});

describe('applyAutonomyResult — 重投幂等', () => {
  it('同一份 payload 再投一次：outbox / 日记 / 心跳 / 事件 / 事实都不翻倍', async () => {
    const payload = roundPayload();
    await applyAutonomyResult(payload);
    const factsBefore = (await loadAirpWorld('c1')).facts.length;

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    expect(await DB.getOutboxByChar('c1')).toHaveLength(2);
    expect(await DB.getDiariesByCharId('c1')).toHaveLength(2);
    expect(await DB.getHeartbeatsByChar('c1')).toHaveLength(1);
    expect(await listAirpEventsByChar('c1')).toHaveLength(2);
    expect((await loadAirpWorld('c1')).facts).toHaveLength(factsBefore);
  });
});

describe('applyAutonomyResult — 降级改道（major × 档位）', () => {
  it('major + L2 → 不物化，落【待定】outbox 行 + 事件 disclosed=false', async () => {
    await seedChar({ autonomyLevel: 2 });
    const payload = roundPayload({
      experiences: [{ id: 'exp-1', q: '念头', note: '想换个城市住。', kind: 'rest', importance: 'small', pushed: false }],
      proposedEvents: [{ type: 'movement', summary: '决定搬去另一个城市', impact: 'major' }],
      did: 'rest',
    });

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    const outbox = await DB.getOutboxByChar('c1');
    const susp = outbox.find((e) => e.id === 'airp-c1-exp-1-susp-0');
    expect(susp).toMatchObject({
      charId: 'c1',
      q: '决定搬去另一个城市',
      note: '【待定】决定搬去另一个城市',
      kind: 'mixed',
      importance: 'big',
      told: 0,
      pushed: 0,
      eventIds: ['airp-c1-exp-1-0'],
    });

    const events = await listAirpEventsByChar('c1');
    expect(events).toHaveLength(1);
    expect(events[0].disclosedToUser).toBe(false);

    // 未物化：世界文档没有这条事实
    expect((await loadAirpWorld('c1')).facts).toHaveLength(0);

    const [hb] = await DB.getHeartbeatsByChar('c1');
    expect(hb.outboxed).toBe(2);
    expect(hb.pushed).toBe(0);
    expect(hb.did).toBe('rest');
  });

  it('major + L3 → 正常物化（authority runtime_state），无【待定】行', async () => {
    await seedChar({ autonomyLevel: 3 });
    const payload = roundPayload({
      experiences: [{ id: 'exp-1', q: '念头', note: '想换个城市住。', kind: 'rest', importance: 'small', pushed: false }],
      proposedEvents: [{ type: 'movement', summary: '决定搬去另一个城市', impact: 'major' }],
    });

    await expect(applyAutonomyResult(payload)).resolves.toBe(true);

    const outbox = await DB.getOutboxByChar('c1');
    expect(outbox.map((e) => e.id)).toEqual(['exp-1']);

    const events = await listAirpEventsByChar('c1');
    expect(events).toHaveLength(1);
    expect(events[0].disclosedToUser).toBe(true);

    const world = await loadAirpWorld('c1');
    expect(world.facts).toHaveLength(1);
    expect(world.facts[0]).toMatchObject({ authority: 'runtime_state', status: 'active' });
  });
});

describe('applyAutonomyResult — 坏载荷与存储契约', () => {
  it('非对象 / 缺 charId / 数组字段坏 → warn + 销账 true，零写入', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(applyAutonomyResult(null)).resolves.toBe(true);
      await expect(applyAutonomyResult({ charId: 'c1' })).resolves.toBe(true);
      await expect(applyAutonomyResult({ charId: 'c1', experiences: 'nope', proposedEvents: [] })).resolves.toBe(true);
      await expect(applyAutonomyResult({ charId: '', experiences: [], proposedEvents: [] })).resolves.toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(await DB.getOutboxByChar('c1')).toHaveLength(0);
    expect(await DB.getHeartbeatsByChar('c1')).toHaveLength(0);
    expect(await DB.getDiariesByCharId('c1')).toHaveLength(0);
    expect(await listAirpEventsByChar('c1')).toHaveLength(0);
  });

  it('rest 轮（空 experiences）也落心跳，锚点退化为处理时刻（不抛）', async () => {
    await expect(applyAutonomyResult(roundPayload({ experiences: [], proposedEvents: [], did: 'rest', rested: true }))).resolves.toBe(true);

    const [hb] = await DB.getHeartbeatsByChar('c1');
    expect(hb.did).toBe('rest');
    expect(hb.outboxed).toBe(0);
    expect(hb.id.startsWith('airp-hb-c1-')).toBe(true);
  });
});

describe('markEventsDisclosed', () => {
  it('按 id 翻 disclosedToUser，空输入 no-op', async () => {
    await saveAirpEvents([mkEvent('e1', false), mkEvent('e2', false), mkEvent('e3', true)]);

    await markEventsDisclosed('c1', []);
    await markEventsDisclosed('c1', ['e1']);
    let events = await listAirpEventsByChar('c1');
    expect(events.find((e) => e.id === 'e1')!.disclosedToUser).toBe(true);
    expect(events.find((e) => e.id === 'e2')!.disclosedToUser).toBe(false);

    await markEventsDisclosed('c1', ['e2', 'missing']);
    events = await listAirpEventsByChar('c1');
    expect(events.find((e) => e.id === 'e2')!.disclosedToUser).toBe(true);
    expect(events.find((e) => e.id === 'e3')!.disclosedToUser).toBe(true);
  });
});

describe('materializeCommittedEvents — authorityOverride', () => {
  it('默认 confirmed_scene；override runtime_state 生效', async () => {
    await materializeCommittedEvents('c1', [mkEvent('d1', true)], 100);
    await materializeCommittedEvents('c2', [mkEvent('o1', true)], 200, 'runtime_state');

    expect((await loadAirpWorld('c1')).facts.find((f) => f.id === 'airp-fact-d1')!.authority).toBe('confirmed_scene');
    expect((await loadAirpWorld('c2')).facts.find((f) => f.id === 'airp-fact-o1')!.authority).toBe('runtime_state');
  });
});

describe('备份登记与往返', () => {
  it('KNOWN 映射登记两个 v77 store', () => {
    expect(knownBackupStoreFieldMap()['autonomous_outbox']).toBe('autonomousOutbox');
    expect(knownBackupStoreFieldMap()['autonomous_heartbeats']).toBe('autonomousHeartbeats');
  });

  it('exportFullData → importFullData 往返：outbox 与心跳整组清-加恢复', async () => {
    await applyAutonomyResult(roundPayload());

    const exported = await DB.exportFullData();
    expect((exported.autonomousOutbox ?? []).map((e) => e.id).sort()).toEqual(['exp-1', 'exp-2']);
    expect((exported.autonomousHeartbeats ?? []).map((h) => h.id)).toEqual(['airp-hb-c1-exp-1']);

    await clearStores(['autonomous_outbox', 'autonomous_heartbeats']);
    expect(await DB.getOutboxByChar('c1')).toHaveLength(0);

    await DB.importFullData({ ...exported } as any);

    expect((await DB.getOutboxByChar('c1')).map((e) => e.id).sort()).toEqual(['exp-1', 'exp-2']);
    expect((await DB.getHeartbeatsByChar('c1')).map((h) => h.id)).toEqual(['airp-hb-c1-exp-1']);
  });
});
