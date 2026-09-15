import type { AirpFact, AirpFactAuthority, AirpKnowledge } from './types';

export const AIRP_AUTHORITY_ORDER: readonly AirpFactAuthority[] = [
  'user_canon',
  'confirmed_scene',
  'tool_verified',
  'runtime_state',
  'memory_summary',
  'director_inference',
];

function authorityRank(authority: AirpFactAuthority): number {
  const index = AIRP_AUTHORITY_ORDER.indexOf(authority);
  return index === -1 ? AIRP_AUTHORITY_ORDER.length : index;
}

export function compareFactAuthority(left: AirpFactAuthority, right: AirpFactAuthority): number {
  return authorityRank(left) - authorityRank(right);
}

export interface AirpConflictResolution {
  winner: AirpFact;
  loser: AirpFact;
  action: 'keep' | 'replace' | 'dispute';
}

export function resolveFactConflict(current: AirpFact, incoming: AirpFact): AirpConflictResolution {
  if (current.locked === true && incoming.authority !== 'user_canon') {
    return { winner: current, loser: incoming, action: 'keep' };
  }

  const cmp = compareFactAuthority(current.authority, incoming.authority);

  if (cmp > 0) {
    return {
      winner: { ...incoming },
      loser: { ...current, status: 'superseded' },
      action: 'replace',
    };
  }

  if (cmp < 0) {
    return { winner: current, loser: incoming, action: 'keep' };
  }

  if (incoming.updatedAt > current.updatedAt) {
    return {
      winner: { ...incoming },
      loser: { ...current, status: 'superseded' },
      action: 'replace',
    };
  }

  if (incoming.updatedAt < current.updatedAt) {
    return { winner: current, loser: incoming, action: 'keep' };
  }

  if (current.value !== incoming.value) {
    return { winner: { ...current }, loser: { ...incoming }, action: 'dispute' };
  }

  return { winner: current, loser: incoming, action: 'keep' };
}

export function selectActiveFacts(facts: AirpFact[], now: number): AirpFact[] {
  return facts.filter(
    (fact) => fact.status === 'active' && (fact.validUntil === undefined || fact.validUntil >= now),
  );
}

export function filterKnownBy(knowledge: AirpKnowledge[], knowerId: string): string[] {
  const factIds = new Set<string>();
  for (const entry of knowledge) {
    if (entry.knowerId === knowerId && entry.state === 'known') {
      factIds.add(entry.factId);
    }
  }
  return [...factIds];
}
