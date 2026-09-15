import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseAirpDirectorOutput,
  validateAirpDirectorOutput,
} from './directorCore';
import type { AirpDirectorOutput } from './types';

const EVENT_TYPES = [
  'conversation',
  'activity',
  'movement',
  'schedule',
  'relationship',
  'discovery',
  'social_trace',
] as const;

const EVENT_IMPACTS = ['trace', 'minor', 'major'] as const;

function makeOutput(overrides: Partial<AirpDirectorOutput> = {}): AirpDirectorOutput {
  return {
    v: 1,
    sceneGoal: 'Ease the tension without conceding the boundary.',
    replyIntent: 'Answer warmly, stay firm.',
    beats: [
      { actorId: 'char-1', intent: 'deflect the question', referencedFactIds: ['fact-1'] },
    ],
    allowedDisclosures: ['the weather'],
    forbiddenAssumptions: ['they have already forgiven her'],
    toolIntents: [
      {
        capabilityId: 'cap-1',
        toolName: 'get_weather',
        reason: 'the scene needs it',
        arguments: {},
      },
    ],
    proposedEvents: [
      {
        type: 'conversation',
        summary: 'small talk at the door',
        participants: ['char-1', 'user-1'],
        proposedAt: 1700000000000,
        impact: 'trace',
      },
    ],
    commitCandidates: ['the door was already unlocked'],
    ...overrides,
  };
}

describe('behavior 1: a native object is validated directly', () => {
  it('validate accepts a complete valid output', () => {
    expect(validateAirpDirectorOutput(makeOutput())).toBe(true);
  });

  it('parse round-trips a complete valid output', () => {
    expect(parseAirpDirectorOutput(makeOutput())).toEqual(makeOutput());
  });

  it('rejects when v is not the literal 1', () => {
    expect(validateAirpDirectorOutput({ ...makeOutput(), v: 2 })).toBe(false);
    expect(parseAirpDirectorOutput({ ...makeOutput(), v: 2 })).toBeNull();
  });

  it('rejects a stringified version number', () => {
    expect(validateAirpDirectorOutput({ ...makeOutput(), v: '1' })).toBe(false);
  });
});

describe('behavior 2: strings are parsed through three layers, first success wins', () => {
  it('(a) parses a whole-string JSON document', () => {
    expect(parseAirpDirectorOutput(JSON.stringify(makeOutput()))).toEqual(makeOutput());
  });

  it('(a) tolerates surrounding whitespace on a whole-string document', () => {
    const raw = `\n\n   ${JSON.stringify(makeOutput())}\n`;
    expect(parseAirpDirectorOutput(raw)).toEqual(makeOutput());
  });

  it('(b) parses the first ```json fenced block', () => {
    const raw = `Here is the plan.\n\`\`\`json\n${JSON.stringify(makeOutput())}\n\`\`\`\nThanks!`;
    expect(parseAirpDirectorOutput(raw)).toEqual(makeOutput());
  });

  it('(b) is preferred over the later brace span', () => {
    const raw = `noise \`\`\`json ${JSON.stringify(makeOutput())} \`\`\` tail {"v":2}`;
    expect(parseAirpDirectorOutput(raw)).toEqual(makeOutput());
  });

  it('(c) parses from the first { to the last } around chatter', () => {
    const raw = `Thinking out loud... ${JSON.stringify(makeOutput())} ...done.`;
    expect(parseAirpDirectorOutput(raw)).toEqual(makeOutput());
  });

  it('(c) still runs when a fenced block is present but malformed', () => {
    const raw = '```json not-json``` then {"v":1,"sceneGoal":"g","replyIntent":"r"}';
    expect(parseAirpDirectorOutput(raw)).toEqual({
      v: 1,
      sceneGoal: 'g',
      replyIntent: 'r',
      beats: [],
      toolIntents: [],
      proposedEvents: [],
      allowedDisclosures: [],
      forbiddenAssumptions: [],
      commitCandidates: [],
    });
  });
});

describe('behavior 3: structurally invalid values are rejected', () => {
  it('rejects v !== 1', () => {
    expect(validateAirpDirectorOutput({ v: 2, sceneGoal: 'g', replyIntent: 'r' })).toBe(false);
  });

  it('rejects an empty sceneGoal', () => {
    expect(validateAirpDirectorOutput({ v: 1, sceneGoal: '', replyIntent: 'r' })).toBe(false);
  });

  it('rejects a whitespace-only sceneGoal', () => {
    expect(validateAirpDirectorOutput({ v: 1, sceneGoal: '   ', replyIntent: 'r' })).toBe(false);
  });

  it('rejects a missing replyIntent', () => {
    expect(validateAirpDirectorOutput({ v: 1, sceneGoal: 'g' })).toBe(false);
  });

  it('rejects an empty replyIntent', () => {
    expect(validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: '' })).toBe(false);
  });

  it('rejects beats that is present but not an array', () => {
    expect(validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', beats: {} })).toBe(false);
    expect(validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', beats: null })).toBe(false);
  });

  it('rejects a beat missing actorId', () => {
    expect(
      validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', beats: [{ intent: 'i' }] }),
    ).toBe(false);
  });

  it('rejects a beat missing intent', () => {
    expect(
      validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', beats: [{ actorId: 'a' }] }),
    ).toBe(false);
  });

  it('rejects a beat with an empty actorId', () => {
    expect(
      validateAirpDirectorOutput({
        v: 1,
        sceneGoal: 'g',
        replyIntent: 'r',
        beats: [{ actorId: '', intent: 'i' }],
      }),
    ).toBe(false);
  });

  it('rejects a proposedEvent with an unknown type', () => {
    const bad = { type: 'teleport', summary: 's', participants: [], proposedAt: 1, impact: 'trace' };
    expect(
      validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', proposedEvents: [bad] }),
    ).toBe(false);
  });

  it('rejects a proposedEvent with an unknown impact', () => {
    const bad = { type: 'conversation', summary: 's', participants: [], proposedAt: 1, impact: 'huge' };
    expect(
      validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', proposedEvents: [bad] }),
    ).toBe(false);
  });

  it('accepts every allowed proposedEvent type and impact combination', () => {
    for (const type of EVENT_TYPES) {
      for (const impact of EVENT_IMPACTS) {
        const event = { type, summary: 's', participants: [], proposedAt: 1, impact };
        expect(
          validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', proposedEvents: [event] }),
        ).toBe(true);
      }
    }
  });

  it('rejects a toolIntent with an empty toolName', () => {
    expect(
      validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', toolIntents: [{ toolName: '' }] }),
    ).toBe(false);
  });

  it('rejects a toolIntent missing toolName', () => {
    expect(
      validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r', toolIntents: [{}] }),
    ).toBe(false);
  });

  it('parse returns null for a structurally invalid JSON string', () => {
    expect(parseAirpDirectorOutput(JSON.stringify({ v: 2, sceneGoal: 'g', replyIntent: 'r' }))).toBeNull();
  });
});

describe('behavior 4: missing array fields default to []', () => {
  it('validate accepts an object carrying only the required scalars', () => {
    expect(validateAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r' })).toBe(true);
  });

  it('parse fills all six missing arrays with []', () => {
    const parsed = parseAirpDirectorOutput({ v: 1, sceneGoal: 'g', replyIntent: 'r' });
    expect(parsed).toEqual({
      v: 1,
      sceneGoal: 'g',
      replyIntent: 'r',
      beats: [],
      toolIntents: [],
      proposedEvents: [],
      allowedDisclosures: [],
      forbiddenAssumptions: [],
      commitCandidates: [],
    });
  });

  it('parses a minimal JSON string the same way', () => {
    expect(parseAirpDirectorOutput('{"v":1,"sceneGoal":"g","replyIntent":"r"}')).toEqual({
      v: 1,
      sceneGoal: 'g',
      replyIntent: 'r',
      beats: [],
      toolIntents: [],
      proposedEvents: [],
      allowedDisclosures: [],
      forbiddenAssumptions: [],
      commitCandidates: [],
    });
  });

  it('keeps provided arrays instead of replacing them', () => {
    const output = makeOutput();
    const parsed = parseAirpDirectorOutput(output);
    expect(parsed?.beats).toEqual(output.beats);
    expect(parsed?.toolIntents).toEqual(output.toolIntents);
    expect(parsed?.proposedEvents).toEqual(output.proposedEvents);
    expect(parsed?.allowedDisclosures).toEqual(output.allowedDisclosures);
    expect(parsed?.forbiddenAssumptions).toEqual(output.forbiddenAssumptions);
    expect(parsed?.commitCandidates).toEqual(output.commitCandidates);
  });

  it('accepts explicit empty arrays', () => {
    expect(
      validateAirpDirectorOutput({
        v: 1,
        sceneGoal: 'g',
        replyIntent: 'r',
        beats: [],
        toolIntents: [],
        proposedEvents: [],
        allowedDisclosures: [],
        forbiddenAssumptions: [],
        commitCandidates: [],
      }),
    ).toBe(true);
  });
});

describe('behavior 5: parse failures return null and never throw', () => {
  it('does not throw and returns null on malformed JSON', () => {
    expect(() => parseAirpDirectorOutput('{"v":1,')).not.toThrow();
    expect(parseAirpDirectorOutput('{"v":1,')).toBeNull();
  });

  it('returns null for valid JSON that fails validation', () => {
    expect(parseAirpDirectorOutput(JSON.stringify({ v: 1, sceneGoal: '', replyIntent: 'r' }))).toBeNull();
  });

  it('never returns a partially-filled object pretending success', () => {
    expect(parseAirpDirectorOutput('{"v":1,"sceneGoal":"g","replyIntent":""}')).toBeNull();
  });
});

describe('behavior 6: non-object / non-string / non-JSON inputs return null', () => {
  it('whitespace-only strings', () => {
    expect(parseAirpDirectorOutput('    ')).toBeNull();
    expect(parseAirpDirectorOutput('\n\t  ')).toBeNull();
  });

  it('plain prose with no JSON', () => {
    expect(parseAirpDirectorOutput('The director considers the scene and says nothing.')).toBeNull();
  });

  it('a number', () => {
    expect(parseAirpDirectorOutput(42)).toBeNull();
    expect(validateAirpDirectorOutput(42)).toBe(false);
  });

  it('null', () => {
    expect(parseAirpDirectorOutput(null)).toBeNull();
    expect(validateAirpDirectorOutput(null)).toBe(false);
  });

  it('undefined', () => {
    expect(parseAirpDirectorOutput(undefined)).toBeNull();
  });

  it('a boolean', () => {
    expect(parseAirpDirectorOutput(false)).toBeNull();
  });

  it('a top-level array', () => {
    expect(parseAirpDirectorOutput([makeOutput()])).toBeNull();
    expect(validateAirpDirectorOutput([])).toBe(false);
  });

  it('a JSON array string', () => {
    expect(parseAirpDirectorOutput('[]')).toBeNull();
  });

  it('a JSON number string', () => {
    expect(parseAirpDirectorOutput('123')).toBeNull();
  });

  it('a bare JSON object string that is not a director output', () => {
    expect(parseAirpDirectorOutput('{"hello":"world"}')).toBeNull();
  });

  it('validate rejects a JSON string (type guard is object-only)', () => {
    expect(validateAirpDirectorOutput(JSON.stringify(makeOutput()))).toBe(false);
  });
});

describe('purity and module boundary', () => {
  it('does not mutate the input object', () => {
    const input = makeOutput();
    const before = structuredClone(input);
    parseAirpDirectorOutput(input);
    expect(input).toEqual(before);
  });

  it('imports nothing but ./types', () => {
    const source = readFileSync(new URL('./directorCore.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);

    expect(specifiers.every((s) => s === './types')).toBe(true);
  });
});
