/**
 * Perspective Worker · 鉴权与会话校验（纯函数，可单测）。
 * D1 访问只在 index.ts 做，本文件不碰 DB，便于 worker/前端复用逻辑。
 */

export type TokenPrefix = 'pvd_' | 'pvc_';

const HEX = '0123456789abcdef';

export function generateToken(prefix: TokenPrefix): string {
  const bytes = new Uint8Array(24);
  const c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let hex = '';
  for (const b of bytes) hex += HEX[b >> 4] + HEX[b & 0x0f];
  return `${prefix}${hex}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 定长比较，避免短路时序泄露。长度不等直接 false。 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const FUTURE_SKEW_MS = 5 * 60_000;
export const MAX_NAME_LEN = 128;

export interface IncomingSession {
  id?: unknown;
  deviceId?: unknown;
  platform?: unknown;
  source?: unknown;
  appKey?: unknown;
  appLabel?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  durationMs?: unknown;
  schemaVersion?: unknown;
}

export function validateSession(
  s: IncomingSession,
  nowMs: number,
): { ok: true } | { ok: false; error: string } {
  if (typeof s.id !== 'string' || s.id.length === 0 || s.id.length > 128) {
    return { ok: false, error: 'bad id' };
  }
  if (typeof s.deviceId !== 'string' || s.deviceId.length === 0) {
    return { ok: false, error: 'bad deviceId' };
  }
  // 旧默认设备不再接受写入；清理走 /admin/purge-default。
  if (s.deviceId === 'default') return { ok: false, error: 'legacy device' };
  if (s.platform !== 'web' && s.platform !== 'android' && s.platform !== 'windows') {
    return { ok: false, error: 'bad platform' };
  }
  if (s.source !== 'sullyos' && s.source !== 'device') {
    return { ok: false, error: 'bad source' };
  }
  if (typeof s.appKey !== 'string' || s.appKey.length === 0 || s.appKey.length > MAX_NAME_LEN) {
    return { ok: false, error: 'bad appKey' };
  }
  if (typeof s.appLabel !== 'string' || s.appLabel.length === 0 || s.appLabel.length > MAX_NAME_LEN) {
    return { ok: false, error: 'bad appLabel' };
  }
  if (typeof s.startedAt !== 'number' || typeof s.endedAt !== 'number' || typeof s.durationMs !== 'number') {
    return { ok: false, error: 'bad time' };
  }
  if (!Number.isFinite(s.startedAt) || !Number.isFinite(s.endedAt) || !Number.isFinite(s.durationMs)) {
    return { ok: false, error: 'bad time' };
  }
  if (s.startedAt > s.endedAt) return { ok: false, error: 'ended before started' };
  if (s.durationMs < 0) return { ok: false, error: 'negative duration' };
  if (s.startedAt > nowMs + FUTURE_SKEW_MS || s.endedAt > nowMs + FUTURE_SKEW_MS) {
    return { ok: false, error: 'clock skew' };
  }
  if (s.schemaVersion !== 1) return { ok: false, error: 'bad schema' };
  return { ok: true };
}
