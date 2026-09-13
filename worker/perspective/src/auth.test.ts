import { describe, expect, it } from 'vitest';
import { generateToken, sha256Hex, timingSafeEqualHex, validateSession } from './auth';

describe('perspective auth', () => {
  it('generates prefixed tokens', () => {
    const d = generateToken('pvd_');
    const r = generateToken('pvc_');
    expect(d.startsWith('pvd_')).toBe(true);
    expect(r.startsWith('pvc_')).toBe(true);
    expect(d.length).toBe(4 + 48);
    expect(r.length).toBe(4 + 48);
    expect(d).not.toBe(generateToken('pvd_'));
  });

  it('sha256 matches known vector', async () => {
    // echo -n "abc" | sha256sum
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('timing-safe compare', () => {
    expect(timingSafeEqualHex('ab', 'ab')).toBe(true);
    expect(timingSafeEqualHex('ab', 'ac')).toBe(false);
    expect(timingSafeEqualHex('ab', 'abc')).toBe(false);
  });

  it('validates sessions', () => {
    const base = {
      id: 's1',
      deviceId: 'd1',
      platform: 'android',
      source: 'device',
      appKey: 'com.tencent.mm',
      appLabel: 'wechat',
      startedAt: 1000,
      endedAt: 2000,
      durationMs: 1000,
      schemaVersion: 1,
    };
    expect(validateSession({ ...base }, Date.now()).ok).toBe(true);
    expect(validateSession({ ...base, durationMs: -1 }, Date.now()).ok).toBe(false);
    expect(validateSession({ ...base, endedAt: 500 }, Date.now()).ok).toBe(false);
    expect(validateSession({ ...base, appKey: '' }, Date.now()).ok).toBe(false);
    expect(validateSession({ ...base, deviceId: 'default' }, Date.now()).ok).toBe(false);
    // 未来超过 5 分钟的时间戳拒绝（客户端时钟漂移保护）。
    expect(validateSession({ ...base, startedAt: Date.now() + 10 * 60_000, endedAt: Date.now() + 11 * 60_000 }, Date.now()).ok).toBe(false);
  });
});
