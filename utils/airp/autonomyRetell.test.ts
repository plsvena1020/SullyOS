/**
 * 自主生活转述块（C2）+ 账本 told 记账 + 事件披露翻转。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层（无 storage stub）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from '../db';
import { buildAutonomyRetellBlock, markAutonomyTold } from './autonomyRetell';
import { listAirpEventsByChar, saveAirpEvents } from './eventStore';
import type { AirpCommittedEvent } from './commit';
import type { AutonomousOutboxEntry } from '../../types';
import type { ResolvedAirpAutonomy } from './autonomySettings';

const HEADER = '[System: 离线自主经历]';
// §2.5 固定分寸语（逐字）。
const TONE = '你前几晚自己去网上逛过/玩过，记着这些——TA 聊到相关话头、或你自己想分享时自然带一句就好；别报流水账、别每轮都提。';

const STYLE_LINES: Record<string, string> = {
  battle: '讲得像打了一场仗：句子短、有输有赢，带点劲儿。',
  brief: '挑重点讲，三言两语说完，别铺开。',
  casual: '随口一提的口气，像闲聊时顺嘴带出来的。',
  coquettish: '带点撒娇的软劲儿，尾音拖一点，别腻。',
  diary: '像翻自己的日记那样平实地说，安静一点。',
  teaser: '只说个开头勾一下，留一半等对方追问。',
  plain: '平实地讲，不加修饰。',
};

const retell = (
  over: Partial<ResolvedAirpAutonomy['retell']> = {},
): ResolvedAirpAutonomy['retell'] => ({
  style: 'plain',
  maxItems: 5,
  maxChars: 800,
  opener: false,
  ...over,
});

let seq = 0;
function freshCharId(): string {
  seq += 1;
  return `c-retell-${Date.now()}-${seq}`;
}

function mkEntry(over: Partial<AutonomousOutboxEntry> & { id: string; charId: string }): AutonomousOutboxEntry {
  return {
    ts: 100,
    q: 'q',
    note: 'note',
    kind: 'surf',
    importance: 'small',
    told: 0,
    pushed: 0,
    ...over,
  };
}

function mkEvent(id: string, charId: string, disclosed: boolean): AirpCommittedEvent {
  return {
    id,
    charId,
    at: 100,
    type: 'activity',
    summary: `event ${id}`,
    participants: [charId],
    impact: 'minor',
    authority: 'runtime_state',
    disclosedToUser: disclosed,
    source: { kind: 'runtime', label: 'airp-autonomy' },
  };
}

async function clearStore(store: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

beforeEach(async () => {
  await clearStore('autonomous_outbox');
  await clearStore('airp_events');
});

describe('buildAutonomyRetellBlock（真实 DB 层）', () => {
  it('空账本 → 整块不注入：block 空串、toldIds 空', async () => {
    const out = await buildAutonomyRetellBlock(freshCharId(), retell());
    expect(out).toEqual({ block: '', toldIds: [] });
  });

  it('只取 told=0 && pushed=0；big 优先、同级 ts 倒序', async () => {
    const charId = freshCharId();
    await DB.saveOutboxEntries([
      mkEntry({ id: 'a', charId, ts: 100, importance: 'big', note: 'aaa' }),
      mkEntry({ id: 'b', charId, ts: 300, importance: 'small', note: 'bbb' }),
      mkEntry({ id: 'c', charId, ts: 200, importance: 'big', note: 'ccc' }),
      mkEntry({ id: 'd', charId, ts: 400, importance: 'big', note: 'ddd', told: 1 }),
      mkEntry({ id: 'e', charId, ts: 500, importance: 'big', note: 'eee', pushed: 1 }),
    ]);

    const out = await buildAutonomyRetellBlock(charId, retell());
    expect(out.toldIds).toEqual(['c', 'a', 'b']);
    expect(out.block).toContain(`${HEADER}\n${TONE}\n${STYLE_LINES.plain}\n- ccc\n- aaa\n- bbb`);
  });

  it('条数上限：超过 maxItems 只取前几条，toldIds 同步截断', async () => {
    const charId = freshCharId();
    await DB.saveOutboxEntries(
      Array.from({ length: 7 }, (_, i) =>
        mkEntry({ id: `s${i}`, charId, ts: 1000 - i, importance: 'big', note: `n${i}` })),
    );

    const out = await buildAutonomyRetellBlock(charId, retell({ maxItems: 5, maxChars: 10000 }));
    expect(out.toldIds).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(out.block).not.toContain('- n5');
  });

  it('字数上限：整条丢弃、绝不截断（放不下的条目整条不出现）', async () => {
    const charId = freshCharId();
    const long = (tag: string) => `${tag}${'x'.repeat(297)}`;
    await DB.saveOutboxEntries([
      mkEntry({ id: 'l0', charId, ts: 300, importance: 'big', note: long('A') }),
      mkEntry({ id: 'l1', charId, ts: 200, importance: 'big', note: long('B') }),
      mkEntry({ id: 'l2', charId, ts: 100, importance: 'big', note: long('C') }),
    ]);

    const out = await buildAutonomyRetellBlock(charId, retell({ maxItems: 10, maxChars: 800 }));
    expect(out.toldIds).toEqual(['l0', 'l1']);
    expect(out.block).toContain(long('A'));
    expect(out.block).toContain(long('B'));
    expect(out.block).not.toContain('C');
    // 入选条目是完整原文，不存在被裁成半截的痕迹。
    expect(out.block).toContain(`- ${long('A')}\n- ${long('B')}`);
  });

  it('7 格语气各出一句；custom 用 customHint 原样拼', async () => {
    const charId = freshCharId();
    await DB.saveOutboxEntries([mkEntry({ id: 'one', charId, ts: 1, note: 'eee' })]);
    for (const [style, line] of Object.entries(STYLE_LINES)) {
      const out = await buildAutonomyRetellBlock(charId, retell({ style: style as any }));
      expect(out.block).toContain(line);
    }

    const custom = await buildAutonomyRetellBlock(
      charId,
      retell({ style: 'custom', customHint: '用你自己的腔调，别学别人。' }),
    );
    expect(custom.block).toContain('用你自己的腔调，别学别人。');
    expect(custom.block).not.toContain(STYLE_LINES.plain);

    // custom 但没写提示 → 回落 plain，不能凭空编一句。
    const customNoHint = await buildAutonomyRetellBlock(charId, retell({ style: 'custom' }));
    expect(customNoHint.block).toContain(STYLE_LINES.plain);
  });
});

describe('markAutonomyTold（真实 DB 层）', () => {
  it('标记 told + toldBy，并翻转 linked 事件的 disclosedToUser', async () => {
    const charId = freshCharId();
    await DB.saveOutboxEntries([
      mkEntry({ id: 'm1', charId, ts: 1, eventIds: ['e1', 'e2'] }),
      mkEntry({ id: 'm2', charId, ts: 2, eventIds: [] }),
    ]);
    await saveAirpEvents([mkEvent('e1', charId, false), mkEvent('e2', charId, false), mkEvent('e9', charId, false)]);

    const res = await markAutonomyTold(charId, ['m1', 'm2'], 4242);
    expect(res.marked.sort()).toEqual(['m1', 'm2']);
    expect(res.flipped.sort()).toEqual(['e1', 'e2']);

    const rows = await DB.getOutboxByChar(charId);
    expect(rows.find(r => r.id === 'm1')?.told).toBe(1);
    expect(rows.find(r => r.id === 'm1')?.toldBy).toBe(4242);
    expect(rows.find(r => r.id === 'm2')?.toldBy).toBe(4242);

    const events = await listAirpEventsByChar(charId);
    expect(events.find(e => e.id === 'e1')?.disclosedToUser).toBe(true);
    expect(events.find(e => e.id === 'e2')?.disclosedToUser).toBe(true);
    expect(events.find(e => e.id === 'e9')?.disclosedToUser).toBe(false);
  });

  it('toldBy 未定义时不写该字段', async () => {
    const charId = freshCharId();
    await DB.saveOutboxEntries([mkEntry({ id: 'n1', charId, ts: 1 })]);
    await markAutonomyTold(charId, ['n1'], undefined);
    expect((await DB.getOutboxByChar(charId))[0].toldBy).toBeUndefined();
  });

  it('幂等：已 told 的重跑跳过，只返回新标记的', async () => {
    const charId = freshCharId();
    await DB.saveOutboxEntries([mkEntry({ id: 'i1', charId, ts: 1 })]);

    const first = await markAutonomyTold(charId, ['i1'], 1);
    expect(first.marked).toEqual(['i1']);

    const second = await markAutonomyTold(charId, ['i1'], 2);
    expect(second).toEqual({ marked: [], flipped: [] });
    const row = (await DB.getOutboxByChar(charId))[0];
    expect(row.toldBy).toBe(1);
  });

  it('缺失 id 静默跳过；空输入 no-op', async () => {
    const charId = freshCharId();
    await DB.saveOutboxEntries([mkEntry({ id: 'k1', charId, ts: 1 })]);
    const res = await markAutonomyTold(charId, ['ghost', 'k1'], 7);
    expect(res.marked).toEqual(['k1']);
    expect(await markAutonomyTold(charId, [], 7)).toEqual({ marked: [], flipped: [] });
    expect(await markAutonomyTold('', ['k1'], 7)).toEqual({ marked: [], flipped: [] });
  });
});
