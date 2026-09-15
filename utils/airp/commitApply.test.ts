/**
 * commitAirpRound：把导演产出里「正文已经叙述」的事件落进 airp_events，物化进 airp_world，
 * 并在本轮锚点气泡的 metadata.airpCommittedIds 上记账（重跑同轮幂等去重）。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层（无 storage stub）。
 * CJK literals are written as escapes so the source file stays pure ASCII.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from '../db';
import { commitAirpRound } from './commitApply';
import { listAirpEventsByChar } from './eventStore';
import { loadAirpWorld } from './worldStore';
import type { AirpDirectorOutput, AirpProposedEvent } from './types';

const GO_PARK = '\u53bb\u516c\u56ed\u6563\u6b65'; // 去公园散步
const DRINK_COFFEE = '\u559d\u4e86\u4e00\u676f\u5496\u5561'; // 喝了一杯咖啡
const WATCH_MOVIE = '\u770b\u4e86\u4e00\u573a\u7535\u5f71'; // 看了一场电影
const REPLY = GO_PARK + '\uff0c' + DRINK_COFFEE; // 去公园散步，喝了一杯咖啡

const AT_MS = 1_700_000_000_000;

function proposal(
  summary: string,
  type: AirpProposedEvent['type'] = 'activity',
): AirpProposedEvent {
  return { type, summary, participants: ['me'], proposedAt: AT_MS, impact: 'minor' };
}

function director(proposedEvents: AirpProposedEvent[]): AirpDirectorOutput {
  return {
    v: 1,
    sceneGoal: 'goal',
    replyIntent: 'intent',
    beats: [],
    allowedDisclosures: [],
    forbiddenAssumptions: [],
    toolIntents: [],
    proposedEvents,
    commitCandidates: [],
  };
}

let seq = 0;
function freshCharId(): string {
  seq += 1;
  return `c-airp-commit-${Date.now()}-${seq}`;
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
  await clearStore('airp_events');
  await clearStore('airp_world');
});

async function seedAssistant(
  charId: string,
  timestamp: number,
  metadata?: any,
): Promise<number> {
  return DB.saveMessage({
    charId,
    role: 'assistant',
    type: 'text',
    content: 'ok',
    timestamp,
    metadata,
  });
}

describe('commitAirpRound（真实 DB 层）', () => {
  it('完整一轮：已叙述事件落库 + 物化 + 锚点记账', async () => {
    const charId = freshCharId();
    const output = director([
      proposal(GO_PARK, 'activity'),
      proposal(WATCH_MOVIE, 'discovery'), // 未叙述 → 不提交
      proposal(DRINK_COFFEE, 'conversation'),
    ]);
    const anchorId = await seedAssistant(charId, AT_MS + 5);

    const result = await commitAirpRound({
      charId,
      output,
      replyText: REPLY,
      atMs: AT_MS,
      postStartMs: AT_MS,
    });

    // 非抛异常 resolve（reject 会让 await 抛出、测试直接失败）
    expect(result).toBeDefined();
    expect(result.committed.map(e => e.summary)).toEqual([GO_PARK, DRINK_COFFEE]);
    expect(result.committed.map(e => e.id)).toEqual([
      `airp-${charId}-${AT_MS}-0`,
      `airp-${charId}-${AT_MS}-1`,
    ]);
    expect(result.anchorMessageId).toBe(anchorId);
    expect(result.skippedIds).toEqual([]);

    const events = await listAirpEventsByChar(charId);
    expect([...events.map(e => e.id)].sort()).toEqual(result.committed.map(e => e.id).sort());

    const world = await loadAirpWorld(charId);
    expect([...world.facts.map(f => f.predicate)].sort()).toEqual([
      'airp_event_activity',
      'airp_event_conversation',
    ]);
    expect(world.knowledge.length).toBe(2);
    expect(world.knowledge.every(k => k.knowerId === charId && k.state === 'known')).toBe(true);

    const anchored = await DB.getMessageById(anchorId);
    expect([...(anchored?.metadata?.airpCommittedIds ?? [])].sort()).toEqual(
      result.committed.map(e => e.id).sort(),
    );
  });

  it('重复提交同一轮 → committed 为空、skippedIds 记下已提交 id（幂等）', async () => {
    const charId = freshCharId();
    const output = director([proposal(GO_PARK), proposal(DRINK_COFFEE)]);
    await seedAssistant(charId, AT_MS + 5);

    const first = await commitAirpRound({
      charId, output, replyText: REPLY, atMs: AT_MS, postStartMs: AT_MS,
    });
    const priorIds = [...first.committed.map(e => e.id)].sort();
    expect(priorIds.length).toBe(2);

    const second = await commitAirpRound({
      charId, output, replyText: REPLY, atMs: AT_MS, postStartMs: AT_MS,
    });

    expect(second).toBeDefined();
    expect(second.committed).toEqual([]);
    expect([...second.skippedIds].sort()).toEqual(priorIds);
    expect((await listAirpEventsByChar(charId)).length).toBe(2);
  });

  it('正文未叙述任何提议 → 空结果且零写入（事件/世界/记账都不动）', async () => {
    const charId = freshCharId();
    const anchorId = await seedAssistant(charId, AT_MS + 5);

    const result = await commitAirpRound({
      charId,
      output: director([proposal(GO_PARK)]),
      replyText: WATCH_MOVIE,
      atMs: AT_MS,
      postStartMs: AT_MS,
    });

    expect(result).toEqual({ committed: [], skippedIds: [] });
    expect(await listAirpEventsByChar(charId)).toEqual([]);
    expect(await DB.getAirpWorld(charId)).toBeUndefined();
    expect((await DB.getMessageById(anchorId))?.metadata?.airpCommittedIds).toBeUndefined();
  });

  it('窗口内无本轮 assistant 气泡 → 事件仍落库、anchorMessageId 为空、不写记账', async () => {
    const charId = freshCharId();

    const result = await commitAirpRound({
      charId,
      output: director([proposal(GO_PARK)]),
      replyText: GO_PARK,
      atMs: AT_MS,
      postStartMs: AT_MS + 10_000_000, // 窗口内没有任何气泡能达标
    });

    expect(result.anchorMessageId).toBeUndefined();
    expect(result.committed.length).toBe(1);
    expect((await listAirpEventsByChar(charId)).length).toBe(1);
    expect((await loadAirpWorld(charId)).facts.length).toBe(1);
  });

  it('postStartMs 门槛：旧气泡的记账不抑制新 id，锚点落在本轮气泡', async () => {
    const charId = freshCharId();
    const oldId = await seedAssistant(charId, AT_MS - 100_000, {
      airpCommittedIds: ['airp-old-0'],
    });
    const newId = await seedAssistant(charId, AT_MS + 5);

    const result = await commitAirpRound({
      charId,
      output: director([proposal(GO_PARK), proposal(DRINK_COFFEE)]),
      replyText: REPLY,
      atMs: AT_MS,
      postStartMs: AT_MS,
    });

    expect(result.committed.length).toBe(2);
    expect(result.anchorMessageId).toBe(newId);

    const oldMsg = await DB.getMessageById(oldId);
    expect(oldMsg?.metadata?.airpCommittedIds).toEqual(['airp-old-0']);

    const newMsg = await DB.getMessageById(newId);
    expect([...(newMsg?.metadata?.airpCommittedIds ?? [])].sort()).toEqual(
      result.committed.map(e => e.id).sort(),
    );
  });

  it('锚点已知 → 落库事件的 source.id 回填为锚点消息 id', async () => {
    const charId = freshCharId();
    const anchorId = await seedAssistant(charId, AT_MS + 5);

    await commitAirpRound({
      charId,
      output: director([proposal(GO_PARK)]),
      replyText: GO_PARK,
      atMs: AT_MS,
      postStartMs: AT_MS,
    });

    const events = await listAirpEventsByChar(charId);
    expect(events).toHaveLength(1);
    expect(events[0].source.id).toBe(String(anchorId));
  });

  it('锚点缺失 → 事件仍落库但 source.id 不写，不抛异常', async () => {
    const charId = freshCharId();

    const result = await commitAirpRound({
      charId,
      output: director([proposal(GO_PARK)]),
      replyText: GO_PARK,
      atMs: AT_MS,
      postStartMs: AT_MS + 10_000_000,
    });

    expect(result).toBeDefined();
    expect(result.anchorMessageId).toBeUndefined();
    const events = await listAirpEventsByChar(charId);
    expect(events).toHaveLength(1);
    expect(events[0].source.id).toBeUndefined();
  });
});
