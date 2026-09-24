// scripts/sync-lib.test.ts
import { describe, expect, it, vi } from 'vitest';
import { shouldIgnore, createDebouncer, compareAssetSets } from './sync-lib.mjs';

describe('shouldIgnore', () => {
  it('ignores dist, node_modules, .git, logs, tmp packs', () => {
    expect(shouldIgnore('D:/sullyos/dist/assets/a.js')).toBe(true);
    expect(shouldIgnore('D:/sullyos/node_modules/x/y.js')).toBe(true);
    expect(shouldIgnore('D:/sullyos/.git/HEAD')).toBe(true);
    expect(shouldIgnore('D:/sullyos/app.ts')).toBe(false);
    expect(shouldIgnore('D:/sullyos/logs/watch-sync.log')).toBe(true);
  });
});

describe('createDebouncer', () => {
  it('fires once after quiet period', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(5000, fn);
    d.push(); d.push(); d.push();
    vi.advanceTimersByTime(4999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('compareAssetSets', () => {
  it('matches identical sets, reports diffs', () => {
    const a = '<script src="/assets/i-AAA.js">';
    const b = '<script src="/assets/i-AAA.js">';
    expect(compareAssetSets(a, b).ok).toBe(true);
    const c = '<script src="/assets/i-BBB.js">';
    const r = compareAssetSets(a, c);
    expect(r.ok).toBe(false);
    expect(r.onlyLocal).toEqual(['/assets/i-AAA.js']);
    expect(r.onlyRemote).toEqual(['/assets/i-BBB.js']);
  });
});
