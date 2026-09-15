import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeAirpSettings, type AirpSettings } from './settings';

const DEFAULTS: AirpSettings = {
  enabled: false,
  autonomyLevel: 2,
  directorModel: undefined,
  capabilities: [],
  mcpAllow: [],
  writable: false,
  version: 1,
};

describe('mergeAirpSettings — full defaults for non-object inputs', () => {
  for (const input of [undefined, null, 42, 0, 'x', '', true, false, [], NaN]) {
    it(`returns full defaults for ${JSON.stringify(input)}`, () => {
      expect(mergeAirpSettings(input)).toEqual(DEFAULTS);
    });
  }

  it('returns defaults when called with no argument', () => {
    expect(mergeAirpSettings()).toEqual(DEFAULTS);
  });
});

describe('mergeAirpSettings — partial overrides keep other defaults', () => {
  it('keeps other defaults when only enabled and autonomyLevel are set', () => {
    expect(mergeAirpSettings({ enabled: true, autonomyLevel: 3 })).toEqual({
      ...DEFAULTS,
      enabled: true,
      autonomyLevel: 3,
    });
  });

  it('accepts a directorModel string', () => {
    const out = mergeAirpSettings({ directorModel: 'opencode-go/deepseek-v4.1-flash' });
    expect(out).toEqual({ ...DEFAULTS, directorModel: 'opencode-go/deepseek-v4.1-flash' });
  });

  it('accepts string arrays for capabilities and mcpAllow', () => {
    const out = mergeAirpSettings({ capabilities: ['memory.read'], mcpAllow: ['fs'] });
    expect(out).toEqual({ ...DEFAULTS, capabilities: ['memory.read'], mcpAllow: ['fs'] });
  });

  it('accepts writable true and each autonomy level', () => {
    for (const level of [0, 1, 2, 3] as const) {
      expect(mergeAirpSettings({ autonomyLevel: level }).autonomyLevel).toBe(level);
    }
    expect(mergeAirpSettings({ writable: true }).writable).toBe(true);
  });
});

describe('mergeAirpSettings — illegal values fall back', () => {
  it('rejects illegal autonomy, non-boolean enabled/writable and non-array capabilities', () => {
    const out = mergeAirpSettings({
      autonomyLevel: 9,
      enabled: 'yes',
      capabilities: 'nope',
      writable: 1,
    });
    expect(out).toEqual(DEFAULTS);
  });

  it('rejects autonomy levels that are not 0|1|2|3', () => {
    for (const level of [-1, 4, 1.5, '2', null, undefined]) {
      expect(mergeAirpSettings({ autonomyLevel: level }).autonomyLevel).toBe(2);
    }
  });

  it('rejects blank / non-string directorModel', () => {
    expect(mergeAirpSettings({ directorModel: '' }).directorModel).toBeUndefined();
    expect(mergeAirpSettings({ directorModel: '   ' }).directorModel).toBeUndefined();
    expect(mergeAirpSettings({ directorModel: 42 }).directorModel).toBeUndefined();
    expect(mergeAirpSettings({ directorModel: null }).directorModel).toBeUndefined();
  });

  it('drops non-string entries from capabilities and mcpAllow', () => {
    const out = mergeAirpSettings({
      capabilities: ['ok', 42, null, 'also-ok', { x: 1 }, true],
      mcpAllow: [1, 2, 3],
    });
    expect(out.capabilities).toEqual(['ok', 'also-ok']);
    expect(out.mcpAllow).toEqual([]);
  });

  it('rejects non-boolean writable', () => {
    for (const value of ['true', 1, 0, null, {}, []]) {
      expect(mergeAirpSettings({ writable: value }).writable).toBe(false);
    }
  });
});

describe('mergeAirpSettings — version is always forced to 1', () => {
  for (const version of [2, 0, -1, '1', null, undefined, 1.5]) {
    it(`forces version 1 for input ${JSON.stringify(version)}`, () => {
      expect(mergeAirpSettings({ version }).version).toBe(1);
    });
  }
});

describe('mergeAirpSettings — never throws, even on hostile input', () => {
  const hostile: unknown[] = [
    undefined, null, 0, 1, -1, NaN, Infinity, '', 'str', true, false, [], {},
    () => {}, Symbol('x'), 10n,
    { enabled: {} }, { autonomyLevel: {} }, { capabilities: {} }, { mcpAllow: {} },
    { writable: {} }, { directorModel: {} },
    Object.create(null),
    Object.assign(Object.create(null), { enabled: true }),
    new Map(),
    new Set(),
    new Date(),
    { toString: () => 'x' },
    { valueOf: () => { throw new Error('boom'); } },
    JSON.stringify({ enabled: true }),
  ];

  for (const input of hostile) {
    it(`does not throw for ${describeInput(input)}`, () => {
      expect(() => mergeAirpSettings(input)).not.toThrow();
      const out = mergeAirpSettings(input);
      expect(typeof out.enabled).toBe('boolean');
      expect([0, 1, 2, 3]).toContain(out.autonomyLevel);
      expect(Array.isArray(out.capabilities)).toBe(true);
      expect(Array.isArray(out.mcpAllow)).toBe(true);
      expect(out.version).toBe(1);
    });
  }
});

describe('mergeAirpSettings — purity', () => {
  it('does not mutate the raw input arrays', () => {
    const raw = { capabilities: ['a'], mcpAllow: ['b'] };
    const before = structuredClone(raw);
    mergeAirpSettings(raw);
    expect(raw).toEqual(before);
  });

  it('returns a fresh copy that does not alias the input arrays', () => {
    const raw = { capabilities: ['a'] };
    const out = mergeAirpSettings(raw);
    out.capabilities.push('b');
    expect(raw.capabilities).toEqual(['a']);
  });
});

describe('module hygiene', () => {
  it('imports nothing but ./types', () => {
    const source = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);

    expect(specifiers.every((s) => s === './types')).toBe(true);
  });
});

function describeInput(input: unknown): string {
  if (typeof input === 'symbol') return 'Symbol';
  if (typeof input === 'bigint') return '10n';
  if (typeof input === 'function') return 'function';
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}
