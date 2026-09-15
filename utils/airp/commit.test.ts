import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractCommittedEvents } from './commit';
import type { AirpCommittedEvent } from './commit';
import type { AirpDirectorOutput, AirpProposedEvent } from './types';

// CJK literals are written as escapes so the source file stays pure ASCII.
const COFFEE = '\u559d\u5496\u5561'; // 喝咖啡
const COFFEE_REPLY = COFFEE + '\u5f88\u597d\u559d'; // 喝咖啡很好喝
const TEA = '\u559d\u8336'; // 喝茶
const COFFEE_TEA = '\u559d\u5496\u5561\u8336'; // 喝咖啡茶 -> bigrams: 喝咖 / 咖啡 / 啡茶
const COFFEE_BOOK = '\u559d\u5496\u5561\u770b\u4e66'; // 喝咖啡看书 -> 4 bigrams

function makeProposal(overrides: Partial<AirpProposedEvent> = {}): AirpProposedEvent {
  return {
    type: 'conversation',
    summary: COFFEE,
    participants: ['char-1'],
    proposedAt: 1000,
    impact: 'minor',
    ...overrides,
  };
}

function makeDirector(proposedEvents: unknown): AirpDirectorOutput {
  return {
    v: 1,
    sceneGoal: 'goal',
    replyIntent: 'intent',
    beats: [],
    allowedDisclosures: [],
    forbiddenAssumptions: [],
    toolIntents: [],
    proposedEvents: proposedEvents as AirpProposedEvent[],
    commitCandidates: [],
  };
}

describe('extractCommittedEvents matching rules', () => {
  it('commits a proposal whose normalized summary appears verbatim in the reply', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE })]);
    const events = extractCommittedEvents(director, COFFEE_REPLY, { charId: 'char-1', atMs: 1000 });

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe(COFFEE);
  });

  it('commits when two keywords of a longer summary hit (non-verbatim)', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE_BOOK })]);
    const events = extractCommittedEvents(director, COFFEE + '\u53bb\u4e86', { charId: 'char-1', atMs: 1000 });

    expect(events).toHaveLength(1);
  });

  it('commits a two-keyword summary when both keywords hit non-contiguously', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE })]);
    const reply = '\u5148\u559d\u5496\u518d\u5496\u5561'; // 先喝咖再咖啡 (no verbatim 喝咖啡)
    const events = extractCommittedEvents(director, reply, { charId: 'char-1', atMs: 1000 });

    expect(events).toHaveLength(1);
  });

  it('commits a single-keyword summary when that lone keyword hits (and the summary does not)', () => {
    const summary = 'ab' + '\u5496'; // "ab咖" -> only keyword is "ab"
    const director = makeDirector([makeProposal({ summary })]);
    const events = extractCommittedEvents(director, 'ab', { charId: 'char-1', atMs: 1000 });

    expect(events).toHaveLength(1);
  });

  it('does NOT commit when only one of three keywords hits', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE_TEA })]);
    const events = extractCommittedEvents(director, '\u5496\u5561', { charId: 'char-1', atMs: 1000 });

    expect(events).toEqual([]);
  });

  it('does NOT commit when the reply is unrelated', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE })]);
    const events = extractCommittedEvents(director, TEA + '\u771f\u597d\u559d', { charId: 'char-1', atMs: 1000 });

    expect(events).toEqual([]);
  });

  it('commits events of every impact level when narrated', () => {
    const director = makeDirector([
      makeProposal({ summary: 'alpha beta', impact: 'trace' }),
      makeProposal({ summary: 'beta gamma', impact: 'minor' }),
      makeProposal({ summary: 'gamma delta', impact: 'major' }),
    ]);
    const events = extractCommittedEvents(director, 'alpha beta gamma delta', { charId: 'char-1', atMs: 1000 });

    expect(events.map((e) => e.impact)).toEqual(['trace', 'minor', 'major']);
  });
});

describe('extractCommittedEvents event construction', () => {
  it('builds the committed event with source fields, authority and disclosure defaults', () => {
    const director = makeDirector([
      makeProposal({ summary: 'alpha beta', participants: ['char-1', 'user-1'], locationLabel: 'park' }),
    ]);
    const events = extractCommittedEvents(director, 'alpha beta', {
      charId: 'char-1',
      atMs: 1700,
      messageId: 42,
    });

    expect(events).toHaveLength(1);
    const event: AirpCommittedEvent = events[0];
    expect(event).toEqual({
      id: 'airp-char-1-1700-0',
      charId: 'char-1',
      type: 'conversation',
      summary: 'alpha beta',
      participants: ['char-1', 'user-1'],
      locationLabel: 'park',
      impact: 'minor',
      at: 1700,
      authority: 'confirmed_scene',
      disclosedToUser: true,
      source: { kind: 'assistant_message', id: '42' },
    });
    expect(event.authority).toBe('confirmed_scene');
    expect(event.disclosedToUser).toBe(true);
  });

  it('omits source.id when no messageId is supplied', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE })]);
    const events = extractCommittedEvents(director, COFFEE_REPLY, { charId: 'char-1', atMs: 5 });

    expect(events[0].source).toEqual({ kind: 'assistant_message' });
    expect('id' in events[0].source).toBe(false);
  });

  it('omits locationLabel when the proposal does not carry one', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE })]);
    const events = extractCommittedEvents(director, COFFEE_REPLY, { charId: 'char-1', atMs: 5 });

    expect('locationLabel' in events[0]).toBe(false);
  });

  it('defaults participants to an empty array', () => {
    const proposal = makeProposal({ summary: COFFEE });
    delete (proposal as Partial<AirpProposedEvent>).participants;
    const director = makeDirector([proposal]);
    const events = extractCommittedEvents(director, COFFEE_REPLY, { charId: 'char-1', atMs: 5 });

    expect(events[0].participants).toEqual([]);
  });

  it('numbers ids by committed position, skipping non-committed proposals', () => {
    const director = makeDirector([
      makeProposal({ summary: 'zeta omega' }),
      makeProposal({ summary: COFFEE }),
      makeProposal({ summary: 'alpha beta', impact: 'major' }),
    ]);
    const events = extractCommittedEvents(director, COFFEE + ' alpha beta', {
      charId: 'char-1',
      atMs: 99,
    });

    expect(events.map((e) => e.id)).toEqual(['airp-char-1-99-0', 'airp-char-1-99-1']);
  });

  it('falls back to Date.now() when atMs is omitted', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE })]);
    const before = Date.now();
    const events = extractCommittedEvents(director, COFFEE_REPLY, { charId: 'char-1' });
    const after = Date.now();

    expect(events).toHaveLength(1);
    expect(events[0].at).toBeGreaterThanOrEqual(before);
    expect(events[0].at).toBeLessThanOrEqual(after);
  });

  it('produces deterministic ids for identical inputs', () => {
    const director = makeDirector([
      makeProposal({ summary: COFFEE, impact: 'trace' }),
      makeProposal({ summary: 'alpha beta', impact: 'major' }),
    ]);
    const opts = { charId: 'char-1', atMs: 4321, messageId: 7 };

    const first = extractCommittedEvents(director, COFFEE + ' alpha beta', opts);
    const second = extractCommittedEvents(director, COFFEE + ' alpha beta', opts);

    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
    expect(first).toEqual(second);
  });

  it('does not mutate the director output', () => {
    const proposal = makeProposal({ summary: COFFEE });
    const director = makeDirector([proposal]);
    const before = structuredClone(director);

    extractCommittedEvents(director, COFFEE_REPLY, { charId: 'char-1', atMs: 1 });

    expect(director).toEqual(before);
  });
});

describe('extractCommittedEvents edge rules', () => {
  it('returns [] for an empty reply', () => {
    const director = makeDirector([makeProposal({ summary: COFFEE })]);
    expect(extractCommittedEvents(director, '', { charId: 'char-1', atMs: 1 })).toEqual([]);
  });

  it('returns [] for a null or undefined director output (no throw)', () => {
    expect(extractCommittedEvents(null as unknown as AirpDirectorOutput, COFFEE_REPLY, { charId: 'c' })).toEqual([]);
    expect(extractCommittedEvents(undefined as unknown as AirpDirectorOutput, COFFEE_REPLY, { charId: 'c' })).toEqual([]);
  });

  it('returns [] when proposedEvents is absent or not an array', () => {
    expect(extractCommittedEvents({} as AirpDirectorOutput, COFFEE_REPLY, { charId: 'c' })).toEqual([]);
    expect(extractCommittedEvents(makeDirector(undefined), COFFEE_REPLY, { charId: 'c' })).toEqual([]);
    expect(
      extractCommittedEvents(makeDirector('nope'), COFFEE_REPLY, { charId: 'c' }),
    ).toEqual([]);
  });

  it('skips proposals without a usable summary', () => {
    const director = makeDirector([
      makeProposal({ summary: '' }),
      makeProposal({ summary: '   ' }),
      makeProposal({ summary: 123 as unknown as string }),
      null,
      42,
      'x',
    ]);
    expect(extractCommittedEvents(director, COFFEE_REPLY, { charId: 'c' })).toEqual([]);
  });

  it('never throws on hostile inputs', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      'director',
      { proposedEvents: 'nope' },
      { proposedEvents: [null, 42, 'x', {}] },
      { proposedEvents: [makeProposal({ summary: 7 as unknown as string })] },
    ];
    for (const input of inputs) {
      expect(() =>
        extractCommittedEvents(input as AirpDirectorOutput, COFFEE_REPLY, { charId: 'c', atMs: 1 }),
      ).not.toThrow();
    }
  });
});

describe('module purity (commit.ts)', () => {
  it('imports nothing but ./types', () => {
    const source = readFileSync(new URL('./commit.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);

    expect(specifiers.every((s) => s === './types')).toBe(true);
  });
});
