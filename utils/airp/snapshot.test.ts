import { describe, it, expect } from 'vitest';
import { buildAirpRuntimeSnapshot, type AirpEpisodeSummary, type BuildSnapshotOpts } from './snapshot';
import { AIRP_CAPABILITIES } from './capabilityCatalog';
import type { AirpFact } from './types';
import type { CharacterProfile } from '../../types';

const NOW = 1_700_000_000_000;

function makeChar(overrides: Record<string, unknown> = {}): CharacterProfile {
  return { id: 'char-1', name: '测试角色', ...overrides } as unknown as CharacterProfile;
}

function makeFact(id: string, predicate: string, overrides: Partial<AirpFact> = {}): AirpFact {
  return {
    id,
    charId: 'char-1',
    subjectId: 'char-1',
    predicate,
    value: `${predicate}-value`,
    authority: 'user_canon',
    status: 'active',
    validFrom: 1,
    updatedAt: 1,
    source: { kind: 'user_message' },
    locked: false,
    ...overrides,
  };
}

function stubOpts() {
  return {
    now: NOW,
    recallMemories: async () => [] as AirpFact[],
    loadRealtime: async () => null,
  };
}

const RECALLED = [makeFact('given-1', 'given_one'), makeFact('given-2', 'given_two')];

describe('buildAirpRuntimeSnapshot', () => {
  it('renders every section for a fully-populated character', async () => {
    const char = makeChar({
      customTimezoneEnabled: true,
      customTimezone: 'Asia/Tokyo',
      memoryPalaceEnabled: true,
      roomPlatesInjection: 'ROOM-PLATE',
      location: { province: '广东省', city: '深圳市', district: '南山区', source: 'user', updatedAt: 1 },
      airp: { enabled: true, autonomyLevel: 3, capabilities: [], mcpAllow: [], writable: false, version: 1 },
    });

    const snap = await buildAirpRuntimeSnapshot(char, {
      now: NOW,
      recentDialogueTail: ['m1', 'm2', 'm3', 'm4'],
      recallMemories: async () => [...RECALLED],
      loadEpisodes: async () => [
        { summary: 'e1' },
        { summary: 'e2', threadOpen: true },
        { summary: 'e3', threadOpen: false },
        { summary: 'e4', threadOpen: true },
      ],
      loadRealtime: async () => ({
        weatherText: '深圳晴，气温 26°C',
        holidayText: '中秋节',
        newsItems: ['n1', 'n2', 'n3', 'n4'],
        observedAt: 123,
      }),
      loadSchedule: async () => '赶一份稿子',
    });

    expect(snap.v).toBe(1);
    expect(snap.charId).toBe('char-1');
    expect(snap.builtAt).toBe(NOW);
    expect(snap.scene.now).toBe(NOW);
    expect(snap.scene.tzId).toBe('Asia/Tokyo');
    expect(snap.scene.locationLabel).toBe('广东省深圳市南山区');
    expect(snap.scene.activity).toBe('赶一份稿子');
    expect(snap.autonomyLevel).toBe(3);
    expect(snap.knowledge).toEqual([]);
    expect(snap.capabilities).toEqual([...AIRP_CAPABILITIES]);
    expect(snap.facts.map((f) => f.predicate)).toEqual([
      'room_plate_digest',
      'current_location',
      'given_one',
      'given_two',
      'weather_now',
      'holiday_today',
      'news_hot',
      'news_hot',
      'news_hot',
    ]);
    expect(snap.recentEventSummaries).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(snap.unresolvedThreads).toEqual(['e2', 'e4']);
    expect(snap.facts.find((f) => f.predicate === 'weather_now')?.source).toEqual({
      kind: 'tool',
      label: 'realtime_cache',
      observedAt: 123,
    });
  });

  it('keeps stub-recalled facts unchanged (D1 determinism)', async () => {
    const snap = await buildAirpRuntimeSnapshot(makeChar(), {
      ...stubOpts(),
      recallMemories: async () => [...RECALLED],
    });
    expect(snap.facts).toContain(RECALLED[0]);
    expect(snap.facts).toContain(RECALLED[1]);
    expect(snap.facts.filter((f) => f.authority === 'user_canon')).toHaveLength(2);
  });

  it('builds the recall query from the last three dialogue lines', async () => {
    const seen: string[] = [];
    await buildAirpRuntimeSnapshot(makeChar(), {
      ...stubOpts(),
      recentDialogueTail: ['1', '2', '3', '4'],
      recallMemories: async (query) => {
        seen.push(query);
        return [];
      },
    });
    expect(seen).toEqual(['2\n3\n4']);

    const empty: string[] = [];
    await buildAirpRuntimeSnapshot(makeChar(), {
      ...stubOpts(),
      recallMemories: async (query) => {
        empty.push(query);
        return [];
      },
    });
    expect(empty).toEqual(['']);
  });

  it('omits absent sources and appends additional facts as-is', async () => {
    const extra = makeFact('extra-1', 'director_note', { authority: 'director_inference' });
    const snap = await buildAirpRuntimeSnapshot(makeChar(), {
      ...stubOpts(),
      additionalFacts: [extra],
    });

    expect('activity' in snap.scene).toBe(false);
    expect(snap.scene.locationLabel).toBeUndefined();
    expect(snap.recentEventSummaries).toEqual([]);
    expect(snap.unresolvedThreads).toEqual([]);
    expect(snap.facts).toEqual([extra]);
    expect(snap.facts[0]).toBe(extra);
    expect(snap.facts.some((f) => f.authority === 'tool_verified')).toBe(false);
  });

  it('defaults autonomy to 2, keeps knowledge empty and returns a fresh capability copy', async () => {
    const snap = await buildAirpRuntimeSnapshot(makeChar(), stubOpts());

    expect(snap.autonomyLevel).toBe(2);
    expect(snap.knowledge).toEqual([]);
    expect(snap.capabilities).not.toBe(AIRP_CAPABILITIES);
    expect(snap.capabilities).toEqual([...AIRP_CAPABILITIES]);
    expect(snap.capabilities).toHaveLength(AIRP_CAPABILITIES.length);
  });

  it('never rejects when every injected source throws', async () => {
    const snap = await buildAirpRuntimeSnapshot(
      makeChar({ memoryPalaceEnabled: true, roomPlatesInjection: 'RP' }),
      {
        now: NOW,
        recallMemories: async () => {
          throw new Error('recall');
        },
        loadEpisodes: async () => {
          throw new Error('episodes');
        },
        loadRealtime: async () => {
          throw new Error('realtime');
        },
        loadSchedule: async () => {
          throw new Error('schedule');
        },
      },
    );

    expect(snap.v).toBe(1);
    expect(snap.charId).toBe('char-1');
    expect('activity' in snap.scene).toBe(false);
    expect(snap.recentEventSummaries).toEqual([]);
    expect(snap.unresolvedThreads).toEqual([]);
    expect(snap.facts.map((f) => f.predicate)).toEqual(['room_plate_digest']);
  });

  it('falls back to Asia/Shanghai when no custom timezone is resolved', async () => {
    const absent = await buildAirpRuntimeSnapshot(makeChar(), stubOpts());
    expect(absent.scene.tzId).toBe('Asia/Shanghai');

    const blank = await buildAirpRuntimeSnapshot(
      makeChar({ customTimezoneEnabled: true, customTimezone: '   ' }),
      stubOpts(),
    );
    expect(blank.scene.tzId).toBe('Asia/Shanghai');

    const custom = await buildAirpRuntimeSnapshot(
      makeChar({ customTimezoneEnabled: true, customTimezone: 'America/New_York' }),
      stubOpts(),
    );
    expect(custom.scene.tzId).toBe('America/New_York');
  });

  it('always produces a finite builtAt and scene.now', async () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const snap = await buildAirpRuntimeSnapshot(makeChar(), { ...stubOpts(), now: bad });
      expect(Number.isFinite(snap.builtAt)).toBe(true);
      expect(Number.isFinite(snap.scene.now)).toBe(true);
      expect(snap.scene.now).toBe(snap.builtAt);
    }
  });

  it('gates the room-plate digest on memoryPalaceEnabled and slices to 2000 chars', async () => {
    const gated = await buildAirpRuntimeSnapshot(makeChar({ roomPlatesInjection: 'RP' }), stubOpts());
    expect(gated.facts.some((f) => f.predicate === 'room_plate_digest')).toBe(false);

    const blank = await buildAirpRuntimeSnapshot(
      makeChar({ memoryPalaceEnabled: true, roomPlatesInjection: '   ' }),
      stubOpts(),
    );
    expect(blank.facts.some((f) => f.predicate === 'room_plate_digest')).toBe(false);

    const long = '啊'.repeat(2500);
    const sliced = await buildAirpRuntimeSnapshot(
      makeChar({ memoryPalaceEnabled: true, roomPlatesInjection: long }),
      stubOpts(),
    );
    const fact = sliced.facts.find((f) => f.predicate === 'room_plate_digest');
    expect(fact?.value).toBe('啊'.repeat(2000));
    expect(fact?.authority).toBe('runtime_state');
    expect(fact?.source.kind).toBe('room_plate');
  });

  it('joins location parts, omitting empties, and skips the fact when absent', async () => {
    const some = await buildAirpRuntimeSnapshot(
      makeChar({ location: { city: '深圳市', source: 'user', updatedAt: 1 } }),
      stubOpts(),
    );
    expect(some.scene.locationLabel).toBe('深圳市');
    const fact = some.facts.find((f) => f.predicate === 'current_location');
    expect(fact?.value).toBe('深圳市');
    expect(fact?.source.kind).toBe('runtime');

    const none = await buildAirpRuntimeSnapshot(makeChar(), stubOpts());
    expect(none.scene.locationLabel).toBeUndefined();
    expect(none.facts.some((f) => f.predicate === 'current_location')).toBe(false);
  });

  it('assigns stable identity and metadata to builder-created facts', async () => {
    const char = makeChar({
      memoryPalaceEnabled: true,
      roomPlatesInjection: 'RP',
      location: { province: '京都府', city: '京都市', source: 'user', updatedAt: 1 },
    });
    const snap = await buildAirpRuntimeSnapshot(char, {
      now: NOW,
      recallMemories: async () => [...RECALLED],
      loadRealtime: async () => ({
        weatherText: 'w',
        holidayText: 'h',
        newsItems: ['n'],
        observedAt: 999,
      }),
    });

    snap.facts.forEach((fact, index) => {
      if (fact.id.startsWith('airp-')) {
        expect(fact.id).toBe(`airp-${NOW}-${index}`);
        expect(fact.charId).toBe('char-1');
        expect(fact.subjectId).toBe('char-1');
        expect(fact.status).toBe('active');
        expect(fact.validFrom).toBe(NOW);
        expect(fact.updatedAt).toBe(NOW);
        expect(fact.locked).toBe(false);
      }
    });
    expect(snap.facts.filter((f) => f.id.startsWith('airp-'))).toHaveLength(5);
    expect(snap.facts.find((f) => f.predicate === 'weather_now')?.source).toEqual({
      kind: 'tool',
      label: 'realtime_cache',
      observedAt: 999,
    });
  });

  it('keeps only the last five summaries and at most five open threads', async () => {
    const episodes: AirpEpisodeSummary[] = Array.from({ length: 7 }, (_, i) => ({
      summary: `s${i}`,
      threadOpen: true,
    }));
    const snap = await buildAirpRuntimeSnapshot(makeChar(), {
      ...stubOpts(),
      loadEpisodes: async () => episodes,
    });

    expect(snap.recentEventSummaries).toEqual(['s2', 's3', 's4', 's5', 's6']);
    expect(snap.unresolvedThreads).toEqual(['s2', 's3', 's4', 's5', 's6']);
    expect(snap.unresolvedThreads).toHaveLength(5);
  });

  it('real default emits a holiday-only digest without any network access', async () => {
    const builtAt = Date.parse('2026-10-01T04:00:00Z');
    const snap = await buildAirpRuntimeSnapshot(makeChar(), {
      now: builtAt,
      recallMemories: async () => [],
      loadSchedule: async () => null,
    });

    const holiday = snap.facts.find((f) => f.predicate === 'holiday_today');
    expect(holiday?.value).toBe('国庆节');
    expect(holiday?.authority).toBe('tool_verified');
    expect(holiday?.source).toEqual({ kind: 'tool', label: 'realtime_cache', observedAt: builtAt });
    expect(snap.facts.some((f) => f.predicate === 'weather_now' || f.predicate === 'news_hot')).toBe(false);
  });

  it('survives a non-array dialogue tail and keeps the other sections intact', async () => {
    const extra = makeFact('extra-2', 'director_note');
    const snap = await buildAirpRuntimeSnapshot(makeChar(), {
      now: NOW,
      recentDialogueTail: 'not-an-array' as unknown as string[],
      recallMemories: async () => [],
      loadEpisodes: async () => [{ summary: 'e1' }],
      loadRealtime: async () => null,
      additionalFacts: [extra],
    });

    expect(snap.charId).toBe('char-1');
    expect(snap.facts).toEqual([extra]);
    expect(snap.recentEventSummaries).toEqual(['e1']);
  });

  it('returns a minimal snapshot when opts is null instead of rejecting', async () => {
    const snap = await buildAirpRuntimeSnapshot(makeChar(), null as unknown as BuildSnapshotOpts);

    expect(snap.v).toBe(1);
    expect(snap.charId).toBe('char-1');
    expect(snap.facts).toEqual([]);
    expect(snap.scene.tzId).toBe('Asia/Shanghai');
    expect(snap.knowledge).toEqual([]);
    expect(snap.capabilities).toEqual([...AIRP_CAPABILITIES]);
    expect(Number.isFinite(snap.builtAt)).toBe(true);
    expect(Number.isFinite(snap.scene.now)).toBe(true);
  });

  it('gives each realtime fact its own source object', async () => {
    const snap = await buildAirpRuntimeSnapshot(makeChar(), {
      now: NOW,
      recallMemories: async () => [],
      loadRealtime: async () => ({
        weatherText: 'w',
        holidayText: 'h',
        newsItems: ['n'],
        observedAt: 999,
      }),
    });

    const weather = snap.facts.find((f) => f.predicate === 'weather_now');
    const holiday = snap.facts.find((f) => f.predicate === 'holiday_today');
    const news = snap.facts.find((f) => f.predicate === 'news_hot');

    expect(weather?.source).not.toBe(holiday?.source);
    expect(holiday?.source).not.toBe(news?.source);
    expect(weather?.source).toEqual(holiday?.source);

    (weather!.source as { observedAt?: number }).observedAt = 1;
    expect(holiday?.source.observedAt).toBe(999);
    expect(news?.source.observedAt).toBe(999);
  });
});
