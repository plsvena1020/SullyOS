import { describe, expect, it, vi } from 'vitest';
import { createWebAppActivity } from './web';

describe('web activity provider', () => {
  it('A -> B -> null produces two closed sessions', () => {
    let t = 1000;
    const seen: string[] = [];
    const p = createWebAppActivity({
      now: () => t,
      onSession: (s) => seen.push(`${s.appKey}:${s.durationMs}`),
    });
    p.noteSullyosForeground('a', 'A');
    t = 4000;
    p.noteSullyosForeground('b', 'B');
    t = 6000;
    p.noteSullyosForeground(null, null);
    // A: 1000->4000 = 3000ms；B: 4000->6000 = 2000ms。
    expect(seen).toEqual(['a:3000', 'b:2000']);
  });

  it('same app does not split session', () => {
    const cb = vi.fn();
    const p = createWebAppActivity({ now: () => 0, onSession: cb });
    p.noteSullyosForeground('a', 'A');
    p.noteSullyosForeground('a', 'A');
    expect(cb).not.toHaveBeenCalled();
  });
});
