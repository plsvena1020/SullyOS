import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideAirpCapability } from './capabilities';
import type {
  AirpAutonomyLevel,
  AirpCapability,
  AirpExecutionEnvironment,
} from './types';

const LEVELS: AirpAutonomyLevel[] = [0, 1, 2, 3];
const ENVIRONMENTS: AirpExecutionEnvironment[] = ['browser', 'worker'];

function makeCapability(overrides: Partial<AirpCapability> = {}): AirpCapability {
  return {
    id: 'cap-1',
    title: 'Sample capability',
    environment: 'shared',
    risk: 'read',
    category: 'memory',
    toolNames: [],
    ...overrides,
  };
}

describe('read risk — L1+ auto-allow, L0 autonomy_too_low', () => {
  for (const environment of ENVIRONMENTS) {
    for (const level of LEVELS) {
      it(`read/${environment}/L${level}`, () => {
        const res = decideAirpCapability(
          makeCapability({ risk: 'read' }),
          level,
          environment,
        );
        if (level >= 1) {
          expect(res).toEqual({
            allowed: true,
            requiresConfirmation: false,
            reason: 'allowed_read',
          });
        } else {
          expect(res).toEqual({
            allowed: false,
            requiresConfirmation: false,
            reason: 'autonomy_too_low',
          });
        }
      });
    }
  }
});

describe('low_write risk — L2+ auto-allow, L0/L1 autonomy_too_low', () => {
  for (const environment of ENVIRONMENTS) {
    for (const level of LEVELS) {
      it(`low_write/${environment}/L${level}`, () => {
        const res = decideAirpCapability(
          makeCapability({ risk: 'low_write' }),
          level,
          environment,
        );
        if (level >= 2) {
          expect(res).toEqual({
            allowed: true,
            requiresConfirmation: false,
            reason: 'allowed_low_write',
          });
        } else {
          expect(res).toEqual({
            allowed: false,
            requiresConfirmation: false,
            reason: 'autonomy_too_low',
          });
        }
      });
    }
  }
});

describe('confirm risk — browser confirms at every level, worker always rejects', () => {
  for (const level of LEVELS) {
    it(`confirm/browser/L${level}`, () => {
      const res = decideAirpCapability(
        makeCapability({ risk: 'confirm' }),
        level,
        'browser',
      );
      expect(res).toEqual({
        allowed: true,
        requiresConfirmation: true,
        reason: 'confirmation_required',
      });
    });

    it(`confirm/worker/L${level}`, () => {
      const res = decideAirpCapability(
        makeCapability({ risk: 'confirm' }),
        level,
        'worker',
      );
      expect(res).toEqual({
        allowed: false,
        requiresConfirmation: false,
        reason: 'forbidden',
      });
    });
  }
});

describe('forbidden risk — rejected at every level and environment', () => {
  for (const environment of ENVIRONMENTS) {
    for (const level of LEVELS) {
      it(`forbidden/${environment}/L${level}`, () => {
        const res = decideAirpCapability(
          makeCapability({ risk: 'forbidden' }),
          level,
          environment,
        );
        expect(res).toEqual({
          allowed: false,
          requiresConfirmation: false,
          reason: 'forbidden',
        });
      });
    }
  }
});

describe('environment mismatch wins over risk and autonomy (checked first)', () => {
  for (const level of LEVELS) {
    it(`browser-only capability in worker → wrong_environment at L${level}`, () => {
      expect(
        decideAirpCapability(
          makeCapability({ environment: 'browser', risk: 'read' }),
          level,
          'worker',
        ),
      ).toEqual({
        allowed: false,
        requiresConfirmation: false,
        reason: 'wrong_environment',
      });
    });

    it(`worker-only capability in browser → wrong_environment at L${level}`, () => {
      expect(
        decideAirpCapability(
          makeCapability({ environment: 'worker', risk: 'read' }),
          level,
          'browser',
        ),
      ).toEqual({
        allowed: false,
        requiresConfirmation: false,
        reason: 'wrong_environment',
      });
    });
  }

  it('mismatch beats the forbidden risk', () => {
    expect(
      decideAirpCapability(
        makeCapability({ environment: 'browser', risk: 'forbidden' }),
        3,
        'worker',
      ),
    ).toEqual({
      allowed: false,
      requiresConfirmation: false,
      reason: 'wrong_environment',
    });
  });

  it('mismatch beats the confirm risk (browser-only confirm in worker is wrong_environment, not forbidden)', () => {
    expect(
      decideAirpCapability(
        makeCapability({ environment: 'browser', risk: 'confirm' }),
        3,
        'worker',
      ),
    ).toEqual({
      allowed: false,
      requiresConfirmation: false,
      reason: 'wrong_environment',
    });
  });

  it('mismatch beats autonomy_too_low (browser-only read in worker at L0)', () => {
    expect(
      decideAirpCapability(
        makeCapability({ environment: 'browser', risk: 'read' }),
        0,
        'worker',
      ),
    ).toEqual({
      allowed: false,
      requiresConfirmation: false,
      reason: 'wrong_environment',
    });
  });

  it('shared environment executes in both environments', () => {
    for (const environment of ENVIRONMENTS) {
      const res = decideAirpCapability(
        makeCapability({ environment: 'shared', risk: 'read' }),
        1,
        environment,
      );
      expect(res).toEqual({
        allowed: true,
        requiresConfirmation: false,
        reason: 'allowed_read',
      });
    }
  });
});

describe('precedence', () => {
  it('forbidden is rejected even at max autonomy, not auto-allowed', () => {
    const res = decideAirpCapability(
      makeCapability({ risk: 'forbidden' }),
      3,
      'browser',
    );
    expect(res.reason).toBe('forbidden');
    expect(res.allowed).toBe(false);
  });

  it('confirm gate outranks a too-low autonomy (browser confirm at L0)', () => {
    const res = decideAirpCapability(
      makeCapability({ risk: 'confirm' }),
      0,
      'browser',
    );
    expect(res).toEqual({
      allowed: true,
      requiresConfirmation: true,
      reason: 'confirmation_required',
    });
  });
});

describe('purity', () => {
  it('does not mutate the capability input', () => {
    const cap = makeCapability({ risk: 'low_write', environment: 'worker' });
    const before = structuredClone(cap);
    decideAirpCapability(cap, 3, 'worker');
    expect(cap).toEqual(before);
  });

  it('imports nothing but ./types', () => {
    const source = readFileSync(new URL('./capabilities.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);

    expect(specifiers.every((s) => s === './types')).toBe(true);
  });
});
