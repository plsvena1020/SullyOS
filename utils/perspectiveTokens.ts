import type { AgenticToolCtx } from './agenticTools';
import type { CharacterProfile, RealtimeConfig } from '../types';
import { getPlatformBridge } from './platform/bridge';

/**
 * 透视窗令牌管理（浏览器专用，禁止被 worker bundle import）。
 *
 * - 设备 pvd_ 令牌：配对成功后存 SecureStore，内存 Map 做同步读取缓存。
 * - 角色 pvc_ 只读令牌：per-char 缓存，关闭授权即吊销。
 * - 令牌永不写入 RealtimeConfig / localStorage / 备份。
 */

const K_DEVICE_ID = 'perspective.deviceId';
const K_DEVICE_TOKEN = 'perspective.deviceToken';
const K_DEVICE_NAME = 'perspective.deviceName';
const roleKey = (charId: string) => `perspective.roleToken.${charId}`;

/** 暂停采集（本地开关，暂停期间不产生新会话；暂停前队列仍可上传）。 */
const K_PAUSED_LS = 'sully_pv_paused_v1';

export function isPerspectivePaused(): boolean {
  try {
    return localStorage.getItem(K_PAUSED_LS) === '1';
  } catch {
    return false;
  }
}

export function setPerspectivePaused(paused: boolean): void {
  try {
    if (paused) localStorage.setItem(K_PAUSED_LS, '1');
    else localStorage.removeItem(K_PAUSED_LS);
  } catch {
    /* 忽略 */
  }
}

const mem: { deviceId: string | null; deviceToken: string | null; roles: Map<string, string>; hydrated: boolean } = {
  deviceId: null,
  deviceToken: null,
  roles: new Map(),
  hydrated: false,
};

async function hydrate(): Promise<void> {
  if (mem.hydrated) return;
  mem.hydrated = true;
  try {
    const store = getPlatformBridge().secureStore;
    const [id, token] = await Promise.all([store.get(K_DEVICE_ID), store.get(K_DEVICE_TOKEN)]);
    if (id) mem.deviceId = id;
    if (token) mem.deviceToken = token;
  } catch {
    // 安全存储不可用时按未配对处理，不掀翻调用方。
  }
}

export async function hydratePerspectiveTokens(): Promise<void> {
  await hydrate();
}

/** 同步读缓存（perceptionRegistry 等同步渲染路径用；启动后由 hydrate 填充）。 */
export function hasPerspectiveDeviceTokenSync(): boolean {
  return mem.deviceToken != null;
}

export function getPerspectiveDeviceId(): string | null {
  return mem.deviceId;
}

export function getCachedPerspectiveRoleToken(charId: string): string | null {
  return mem.roles.get(charId) ?? null;
}

export function getPerspectiveRuntimeAuth(): { token?: string; deviceId?: string } {
  if (!mem.deviceToken) return {};
  return { token: mem.deviceToken, deviceId: mem.deviceId ?? undefined };
}

function workerBase(url: string): string | null {
  const u = (url || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(u) ? u : null;
}

export async function ensurePerspectiveDevice(
  workerUrl: string,
  opts?: { pairingCode?: string; deviceName?: string },
): Promise<{ deviceId: string; deviceToken: string } | null> {
  await hydrate();
  if (mem.deviceId && mem.deviceToken) return { deviceId: mem.deviceId, deviceToken: mem.deviceToken };
  const base = workerBase(workerUrl);
  const pairingCode = (opts?.pairingCode || '').trim();
  if (!base || !pairingCode) return null;
  let res: Response;
  try {
    res = await fetch(`${base}/device/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode, deviceName: opts?.deviceName || 'SullyOS', platform: 'web' }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body.deviceId !== 'string' || typeof body.deviceToken !== 'string') return null;
  mem.deviceId = body.deviceId;
  mem.deviceToken = body.deviceToken;
  try {
    const store = getPlatformBridge().secureStore;
    await Promise.all([
      store.set(K_DEVICE_ID, body.deviceId),
      store.set(K_DEVICE_TOKEN, body.deviceToken),
      ...(opts?.deviceName ? [store.set(K_DEVICE_NAME, opts.deviceName)] : []),
    ]);
  } catch {
    // 持久化失败不影响本次内存态。
  }
  return { deviceId: body.deviceId, deviceToken: body.deviceToken };
}

export async function ensurePerspectiveRoleToken(workerUrl: string, charId: string): Promise<string | null> {
  await hydrate();
  const cached = mem.roles.get(charId);
  if (cached) return cached;
  const base = workerBase(workerUrl);
  if (!base || !mem.deviceToken) return null;
  let res: Response;
  try {
    res = await fetch(`${base}/role-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mem.deviceToken}` },
      body: JSON.stringify({ charId }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body.roleToken !== 'string') return null;
  mem.roles.set(charId, body.roleToken);
  try {
    await getPlatformBridge().secureStore.set(roleKey(charId), body.roleToken);
  } catch {
    /* 内存态已生效 */
  }
  return body.roleToken;
}

export async function revokePerspectiveRoleToken(workerUrl: string, charId: string): Promise<void> {
  mem.roles.delete(charId);
  try {
    await getPlatformBridge().secureStore.remove(roleKey(charId));
  } catch {
    /* 忽略 */
  }
  const base = workerBase(workerUrl);
  if (!base || !mem.deviceToken) return;
  try {
    await fetch(`${base}/role-tokens/${encodeURIComponent(charId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${mem.deviceToken}` },
    });
  } catch {
    /* 吊销尽力而为；本地缓存已清即不再携带 */
  }
}

export async function enableCharacterPerspective(
  workerUrl: string,
  charId: string,
): Promise<{ ok: true; token: string } | { ok: false; reason: 'not_paired' | 'network' | 'denied' }> {
  const token = await ensurePerspectiveRoleToken(workerUrl, charId);
  if (token) return { ok: true, token };
  await hydrate();
  if (!mem.deviceToken) return { ok: false, reason: 'not_paired' };
  return { ok: false, reason: 'network' };
}

export async function disableCharacterPerspective(workerUrl: string, charId: string): Promise<void> {
  await revokePerspectiveRoleToken(workerUrl, charId);
}

/** 清除本机设备身份（重置配对；不删云端数据，删数据走 clearPerspectiveSessions）。 */
export async function resetPerspectiveDevice(): Promise<void> {
  mem.deviceId = null;
  mem.deviceToken = null;
  mem.roles.clear();
  try {
    const store = getPlatformBridge().secureStore;
    await Promise.all([store.remove(K_DEVICE_ID), store.remove(K_DEVICE_TOKEN), store.remove(K_DEVICE_NAME)]);
  } catch {
    /* 忽略 */
  }
}

export interface PerspectiveToolConfig {
  endpoint: { baseUrl: string; token: string };
  days: number;
  minIntervalSec: number;
  summaryEnabled: boolean;
  summaryThreshold: number;
}

/**
 * 为单次前台工具调用解析透视窗凭据。
 * 返回 undefined 的情形（全部走既有 not_configured 圆场，不抛错）：
 * 全局开关关 / 角色开关关 / Worker URL 非法 / 角色令牌拿不到。
 */
export async function resolvePerspectiveToolConfig(
  char: Pick<CharacterProfile, 'id' | 'perspectiveEnabled'>,
  rc: Partial<RealtimeConfig> | undefined,
): Promise<PerspectiveToolConfig | undefined> {
  if (!rc?.perspectiveEnabled || !char?.perspectiveEnabled) return undefined;
  const base = workerBase(String((rc as Record<string, unknown>)?.['perspectiveWorkerUrl'] ?? ''));
  if (!base) return undefined;
  const token = await ensurePerspectiveRoleToken(base, char.id);
  if (!token) return undefined;
  return {
    endpoint: { baseUrl: base, token },
    days: rc.perspectiveDays ?? 7,
    minIntervalSec: rc.perspectiveMinIntervalSec ?? 60,
    summaryEnabled: !!rc.perspectiveSummaryEnabled,
    summaryThreshold: rc.perspectiveSummaryThreshold ?? 500,
  };
}

/** 仅类型复用：AgenticToolCtx['perspective'] 的装配形状与工具层一致。 */
export type PerspectiveCtx = NonNullable<AgenticToolCtx['perspective']>;

/** 测试用：重置内存缓存。 */
export function __resetPerspectiveTokensForTest(): void {
  mem.deviceId = null;
  mem.deviceToken = null;
  mem.roles.clear();
  mem.hydrated = true;
}

/** 测试用：预置内存态。 */
export function __seedPerspectiveTokensForTest(seed: { deviceId?: string; deviceToken?: string; roles?: Record<string, string> }): void {
  mem.hydrated = true;
  if (seed.deviceId !== undefined) mem.deviceId = seed.deviceId;
  if (seed.deviceToken !== undefined) mem.deviceToken = seed.deviceToken;
  if (seed.roles) {
    for (const [k, v] of Object.entries(seed.roles)) mem.roles.set(k, v);
  }
}
