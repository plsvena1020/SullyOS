import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AIRP_AUTHORITY_ORDER,
  compareFactAuthority,
  resolveFactConflict,
  selectActiveFacts,
  filterKnownBy,
} from './facts';
import type { AirpFact, AirpFactAuthority, AirpKnowledge } from './types';

const ORDER: AirpFactAuthority[] = [
  'user_canon',
  'confirmed_scene',
  'tool_verified',
  'runtime_state',
  'memory_summary',
  'director_inference',
];

function makeFact(overrides: Partial<AirpFact> = {}): AirpFact {
  return {
    id: 'fact-1',
    charId: 'char-1',
    subjectId: 'user-1',
    predicate: 'likes',
    value: 'coffee',
    authority: 'memory_summary',
    status: 'active',
    validFrom: 0,
    updatedAt: 100,
    source: { kind: 'memory', id: 'mem-1' },
    locked: false,
    ...overrides,
  };
}

describe('AIRP_AUTHORITY_ORDER / compareFactAuthority (behavior 1)', () => {
  it('exposes the fixed authority order', () => {
    expect(AIRP_AUTHORITY_ORDER).toEqual(ORDER);
  });

  it('ranks all 15 pairwise combinations', () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = i + 1; j < ORDER.length; j++) {
        expect(compareFactAuthority(ORDER[i], ORDER[j])).toBeLessThan(0);
        expect(compareFactAuthority(ORDER[j], ORDER[i])).toBeGreaterThan(0);
      }
    }
  });

  it('is reflexive and transitive (double loop)', () => {
    for (let i = 0; i < ORDER.length; i++) {
      expect(compareFactAuthority(ORDER[i], ORDER[i])).toBe(0);
      for (let j = 0; j < ORDER.length; j++) {
        for (let k = 0; k < ORDER.length; k++) {
          const ij = compareFactAuthority(ORDER[i], ORDER[j]);
          const jk = compareFactAuthority(ORDER[j], ORDER[k]);
          const ik = compareFactAuthority(ORDER[i], ORDER[k]);
          if (ij < 0 && jk < 0) expect(ik).toBeLessThan(0);
          if (ij === 0 && jk === 0) expect(ik).toBe(0);
        }
      }
    }
  });
});

describe('resolveFactConflict locked guard (behavior 2)', () => {
  it('keeps a locked current fact against non user_canon incoming without mutating it', () => {
    const current = makeFact({ locked: true, authority: 'memory_summary' });
    const before = structuredClone(current);
    const incoming = makeFact({
      id: 'fact-2',
      authority: 'confirmed_scene',
      updatedAt: 9999,
      value: 'tea',
    });

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('keep');
    expect(res.winner).toBe(current);
    expect(current).toEqual(before);
  });

  it('lets a user_canon incoming through the locked guard', () => {
    const current = makeFact({ locked: true, authority: 'user_canon', value: 'coffee', updatedAt: 100 });
    const incoming = makeFact({ id: 'fact-2', authority: 'user_canon', value: 'tea', updatedAt: 200 });

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('replace');
    expect(res.loser.status).toBe('superseded');
  });
});

describe('resolveFactConflict authority precedence (behavior 3)', () => {
  it('keeps the current fact when the incoming fact has higher authority', () => {
    const current = makeFact({ authority: 'memory_summary', updatedAt: 1 });
    const incoming = makeFact({ id: 'fact-2', authority: 'user_canon', updatedAt: 9999 });

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('keep');
    expect(res.winner).toBe(current);
  });

  it('replaces the current fact when the incoming fact has lower authority', () => {
    const current = makeFact({ authority: 'confirmed_scene', updatedAt: 9999 });
    const incoming = makeFact({ id: 'fact-2', authority: 'memory_summary', updatedAt: 1 });

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('replace');
    expect(res.winner).toEqual(incoming);
    expect(res.winner.id).toBe('fact-2');
    expect(res.loser.id).toBe(current.id);
    expect(res.loser.status).toBe('superseded');
  });
});

describe('resolveFactConflict same authority (behavior 4)', () => {
  it('replaces when incoming is newer', () => {
    const current = makeFact({ updatedAt: 100, value: 'coffee' });
    const incoming = makeFact({ id: 'fact-2', updatedAt: 200, value: 'tea' });

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('replace');
    expect(res.winner.id).toBe('fact-2');
    expect(res.loser.status).toBe('superseded');
  });

  it('keeps when incoming is older', () => {
    const current = makeFact({ updatedAt: 200 });
    const incoming = makeFact({ id: 'fact-2', updatedAt: 100 });

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('keep');
    expect(res.winner).toBe(current);
  });

  it('keeps when updatedAt is equal and values agree', () => {
    const current = makeFact({ updatedAt: 200, value: 'coffee' });
    const incoming = makeFact({ id: 'fact-2', updatedAt: 200, value: 'coffee' });

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('keep');
    expect(res.winner).toBe(current);
  });

  it('disputes contradictory values with equal updatedAt, keeping current as winner', () => {
    const current = makeFact({ updatedAt: 200, value: 'coffee', status: 'active' });
    const incoming = makeFact({ id: 'fact-2', updatedAt: 200, value: 'tea', status: 'active' });

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('dispute');
    expect(res.winner.id).toBe(current.id);
    expect(res.loser.id).toBe(incoming.id);
    expect(res.winner.status).toBe('active');
    expect(res.loser.status).toBe('active');
  });
});

describe('resolveFactConflict purity (behavior 5)', () => {
  it('returns new objects and does not mutate inputs on replace', () => {
    const current = makeFact({ authority: 'confirmed_scene', updatedAt: 100 });
    const incoming = makeFact({ id: 'fact-2', authority: 'memory_summary', updatedAt: 200 });
    const currentBefore = structuredClone(current);
    const incomingBefore = structuredClone(incoming);

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('replace');
    expect(res.winner).not.toBe(incoming);
    expect(res.loser).not.toBe(current);
    expect(current).toEqual(currentBefore);
    expect(incoming).toEqual(incomingBefore);
  });

  it('returns new objects and does not mutate inputs on dispute', () => {
    const current = makeFact({ updatedAt: 100, value: 'coffee' });
    const incoming = makeFact({ id: 'fact-2', updatedAt: 100, value: 'tea' });
    const currentBefore = structuredClone(current);
    const incomingBefore = structuredClone(incoming);

    const res = resolveFactConflict(current, incoming);

    expect(res.action).toBe('dispute');
    expect(res.winner).not.toBe(current);
    expect(res.loser).not.toBe(incoming);
    expect(current).toEqual(currentBefore);
    expect(incoming).toEqual(incomingBefore);
  });
});

describe('selectActiveFacts (behavior 6)', () => {
  it('drops expired and non-active facts', () => {
    const keepActive = makeFact({ id: 'a', status: 'active' });
    const keepNoExpiry = makeFact({ id: 'b', status: 'active', validUntil: undefined });
    const keepAtBoundary = makeFact({ id: 'c', status: 'active', validUntil: 500 });
    const dropExpired = makeFact({ id: 'd', status: 'active', validUntil: 499 });
    const dropSuperseded = makeFact({ id: 'e', status: 'superseded' });
    const dropDisputed = makeFact({ id: 'f', status: 'disputed' });
    const dropExpiredStatus = makeFact({ id: 'g', status: 'expired' });

    const res = selectActiveFacts(
      [keepActive, keepNoExpiry, keepAtBoundary, dropExpired, dropSuperseded, dropDisputed, dropExpiredStatus],
      500,
    );

    expect(res.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterKnownBy', () => {
  it('returns distinct fact ids the knower holds as known', () => {
    const knowledge: AirpKnowledge[] = [
      { factId: 'fact-1', knowerId: 'char-1', state: 'known' },
      { factId: 'fact-2', knowerId: 'char-1', state: 'known' },
      { factId: 'fact-2', knowerId: 'char-1', state: 'known' },
      { factId: 'fact-3', knowerId: 'char-1', state: 'suspected' },
      { factId: 'fact-4', knowerId: 'char-2', state: 'known' },
    ];

    expect(filterKnownBy(knowledge, 'char-1')).toEqual(['fact-1', 'fact-2']);
  });

  it('returns an empty array when the knower has nothing known', () => {
    expect(filterKnownBy([], 'char-1')).toEqual([]);
  });
});

describe('module purity (behavior 7)', () => {
  it('imports nothing but ./types', () => {
    const source = readFileSync(new URL('./facts.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);

    expect(specifiers.every((s) => s === './types')).toBe(true);
  });
});
