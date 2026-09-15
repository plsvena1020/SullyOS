import { DB } from '../db';
import type { AirpFact, AirpKnowledge } from './types';
import type { AirpCommittedEvent } from './commit';
import { resolveFactConflict } from './facts';

/**
 * AIRP 世界事实/知识的浏览器侧入口。存储落在 utils/db.ts 的 `airp_world` store
 * （v75，keyPath 'charId'），每个角色一份世界文档：facts 是当前世界状态（含被淘汰的
 * 留痕事实），knowledge 是该角色对事实的知晓情况。
 *
 * 物化语义：把已提交的世界事件（airp_events）折叠成 predicates 事实槽——
 *   predicate = `airp_event_<type>`，同一 (subjectId, predicate) 只保留一条 active 事实，
 *   冲突交给 Task-2 的 resolveFactConflict 决定胜负；输家按返回状态留痕（superseded 不删、
 *   dispute 双双 active）。事实 id 由事件 id 确定性派生（`airp-fact-<event.id>`），
 *   重复物化同一事件会与自己的旧事实再判一次（同权威、updatedAt 相等 → keep），
 *   因此不会产生重复事实。
 */

export interface AirpWorldDoc {
  charId: string;
  facts: AirpFact[];
  knowledge: AirpKnowledge[];
  updatedAt: number;
}

const emptyDoc = (charId: string): AirpWorldDoc => ({
  charId,
  facts: [],
  knowledge: [],
  updatedAt: 0,
});

/** 读：缺表 / 无记录 → 空文档；不落库（读不写）。 */
export async function loadAirpWorld(charId: string): Promise<AirpWorldDoc> {
  if (!charId) return emptyDoc(charId);
  const doc = await DB.getAirpWorld(charId);
  if (!doc) return emptyDoc(charId);
  return {
    charId,
    facts: Array.isArray(doc.facts) ? doc.facts : [],
    knowledge: Array.isArray(doc.knowledge) ? doc.knowledge : [],
    updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0,
  };
}

/** 同一 (subjectId, predicate) 下最近更新的 active 事实下标；无则 -1（同 updatedAt 取靠后写入的）。 */
function findLatestActiveIndex(
  facts: AirpFact[],
  subjectId: string,
  predicate: string,
): number {
  let best = -1;
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    if (fact.status !== 'active') continue;
    if (fact.subjectId !== subjectId || fact.predicate !== predicate) continue;
    if (best === -1 || fact.updatedAt >= facts[best].updatedAt) best = i;
  }
  return best;
}

export async function materializeCommittedEvents(
  charId: string,
  events: AirpCommittedEvent[],
  atMs: number,
): Promise<{ factsWritten: AirpFact[]; knowledgeAdded: AirpKnowledge[] }> {
  if (!Array.isArray(events) || events.length === 0) {
    return { factsWritten: [], knowledgeAdded: [] };
  }

  const doc = await loadAirpWorld(charId);
  const facts = doc.facts;
  const knowledge = doc.knowledge;
  const factsWritten: AirpFact[] = [];
  const knowledgeAdded: AirpKnowledge[] = [];

  for (const event of events) {
    const candidate: AirpFact = {
      id: `airp-fact-${event.id}`,
      charId,
      subjectId: charId,
      predicate: `airp_event_${event.type}`,
      value: event.summary,
      authority: 'confirmed_scene',
      status: 'active',
      validFrom: event.at,
      updatedAt: atMs,
      source: { kind: 'assistant_message', label: 'airp-commit' },
      locked: false,
    };

    const existingIndex = findLatestActiveIndex(facts, candidate.subjectId, candidate.predicate);
    let winner = candidate;

    if (existingIndex === -1) {
      facts.push(candidate);
      factsWritten.push(candidate);
    } else {
      const resolution = resolveFactConflict(facts[existingIndex], candidate);
      winner = resolution.winner;
      // 赢家占位；输家按返回状态留痕（superseded 保留，dispute 双双 active）。
      facts[existingIndex] = resolution.winner;
      if (resolution.loser.id !== resolution.winner.id) {
        const loserIndex = facts.findIndex((f) => f.id === resolution.loser.id);
        if (loserIndex === -1) facts.push(resolution.loser);
        else facts[loserIndex] = resolution.loser;
      }
      factsWritten.push(resolution.winner);
      if (resolution.loser.id !== resolution.winner.id) factsWritten.push(resolution.loser);
    }

    const entry: AirpKnowledge = {
      factId: winner.id,
      knowerId: charId,
      state: 'known',
      learnedAt: atMs,
    };
    const knowledgeIndex = knowledge.findIndex(
      (k) => k.factId === entry.factId && k.knowerId === entry.knowerId,
    );
    if (knowledgeIndex === -1) knowledge.push(entry);
    else knowledge[knowledgeIndex] = entry;
    knowledgeAdded.push(entry);
  }

  doc.updatedAt = atMs;
  await DB.saveAirpWorld(doc);

  return { factsWritten, knowledgeAdded };
}
