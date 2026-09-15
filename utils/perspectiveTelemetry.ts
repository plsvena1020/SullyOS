/**
 * perspectiveTelemetry — 透视窗上报调度层
 *
 * 只处理「应用会话」：OSContext / 平台 provider 产出 AppActivitySession，
 * 这里入本地离线队列（sully_activity_v1），再批量幂等上传到用户自建 Worker。
 *
 * 不采集聊天内容 / 角色设定 / API 配置 / 网络状态 / 页面焦点。
 * 埋点永不影响主流程：失败静默，队列保留。
 *
 * 环境相关（IndexedDB / timer / window 监听）只在本文件；
 * 数据面在 utils/perspective.ts（环境无关，可进 worker bundle）。
 */

import { uploadPerspectiveSessions, type PerspectiveRuntimeAuth } from './perspective';
import { ackSessions, drainSessions, enqueueSession, outboxCount } from './platform/appActivity/queue';import type { AppActivitySession } from './platform/appActivity/types';
import type { RealtimeConfig } from '../types';

export interface PerspectiveTelemetryRuntime {
  getConfig: () => RealtimeConfig | undefined;
  getAuth: () => PerspectiveRuntimeAuth;
  getDeviceId: () => string | null;
}

let runtime: PerspectiveTelemetryRuntime | null = null;

/** OSContext 挂载后注入；避免本模块依赖 React。 */
export function setPerspectiveTelemetryRuntime(rt: PerspectiveTelemetryRuntime | null): void {
  runtime = rt;
}

function uploadable(): { workerUrl: string; token: string; deviceId: string } | null {
  const cfg = runtime?.getConfig();
  const auth = runtime?.getAuth();
  const deviceId = runtime?.getDeviceId();
  const workerUrl = (cfg as Record<string, unknown> | undefined)?.['perspectiveWorkerUrl'];
  if (!cfg?.perspectiveEnabled || typeof workerUrl !== 'string' || !workerUrl.trim() || !auth?.token || !deviceId) {
    return null;
  }
  return { workerUrl, token: auth.token, deviceId };
}

/** 会话是否命中应用排除名单（appKey 或 appLabel 精确匹配，任一命中即丢弃）。 */
export function isSessionExcluded(
  session: Pick<AppActivitySession, 'appKey' | 'appLabel'>,
  excluded: unknown,
): boolean {
  if (!Array.isArray(excluded) || excluded.length === 0) return false;
  const keys = new Set(excluded.filter((x): x is string => typeof x === 'string' && x.length > 0));
  if (keys.size === 0) return false;
  return keys.has(session.appKey) || keys.has(session.appLabel);
}

/** 会话入库（OS 层 / 平台 provider 的唯一入口）。未配置、未配对、暂停或命中排除名单时直接丢弃。 */
export async function notePerspectiveSession(session: AppActivitySession): Promise<void> {
  const cfg = runtime?.getConfig();
  if (!cfg?.perspectiveEnabled) return;
  if (isSessionExcluded(session, cfg.perspectiveExcludedApps)) return;
  try {
    const { isPerspectivePaused } = await import('./perspectiveTokens');
    if (isPerspectivePaused()) return;
  } catch {
    /* 读不到暂停态按未暂停处理 */
  }
  try {
    await enqueueSession(session);
  } catch {
    /* 队列写失败静默 */
  }
  void flushPerspectiveQueue();
}

/** 尝试上传队首一批。返回已发送与剩余数量（锁防并发）。 */
let flushing = false;

export async function flushPerspectiveQueue(): Promise<{ sent: number; remaining: number }> {
  if (flushing) return { sent: 0, remaining: await safeCount() };
  const up = uploadable();
  if (!up) return { sent: 0, remaining: await safeCount() };
  flushing = true;
  try {
    const batch = await drainSessions(100);
    if (batch.length === 0) return { sent: 0, remaining: 0 };
    const batchId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r = await uploadPerspectiveSessions(
      { perspectiveEnabled: true, perspectiveWorkerUrl: up.workerUrl } as RealtimeConfig,
      { token: up.token, deviceId: up.deviceId },
      { deviceId: up.deviceId, batchId, events: batch },
    );
    if (r.ok) {
      await ackSessions(batch.map((s) => s.id));
      return { sent: batch.length, remaining: await safeCount() };
    }
    if (r.reason === 'http') {
      // 400 类拒绝：整批丢弃防队头阻塞（服务端已做逐条校验）。
      console.warn('[perspective] batch rejected, dropping', r.status, r.message);
      await ackSessions(batch.map((s) => s.id));
      return { sent: 0, remaining: await safeCount() };
    }
    // unauthorized / rate_limited / network：保留队列等下次。
    return { sent: 0, remaining: await safeCount() };
  } catch {
    return { sent: 0, remaining: await safeCount() };
  } finally {
    flushing = false;
  }
}

async function safeCount(): Promise<number> {
  try {
    return await outboxCount();
  } catch {
    return 0;
  }
}

/** 清空本地待上传队列（设置页「清空记录」时连带调用）。 */
export async function clearPerspectiveQueue(): Promise<void> {
  try {
    const all = await drainSessions(5000);
    await ackSessions(all.map((s) => s.id));
  } catch {
    /* 忽略 */
  }
}

// ─── 定时 / 在线 / 切后台补传 ────────────────────────────────────────────────

let flushTimer: ReturnType<typeof setInterval> | null = null;
let listenersInstalled = false;

function onOnline(): void {
  void flushPerspectiveQueue();
}

function onHidden(): void {
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      void flushPerspectiveQueue();
    }
  } catch {
    /* 忽略 */
  }
}

/** 启动补传调度（OSContext 挂载时调用一次，幂等）。 */
export function installPerspectiveSync(): void {
  if (typeof window !== 'undefined' && !listenersInstalled) {
    listenersInstalled = true;
    try {
      window.addEventListener('online', onOnline);
      document.addEventListener('visibilitychange', onHidden);
    } catch {
      /* 受限环境静默 */
    }
  }
  if (flushTimer == null && typeof setInterval !== 'undefined') {
    flushTimer = setInterval(() => {
      void flushPerspectiveQueue();
    }, 60_000);
  }
}

/** 停止补传调度（测试 / 卸载用）。 */
export function uninstallPerspectiveSync(): void {
  if (flushTimer != null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (listenersInstalled && typeof window !== 'undefined') {
    listenersInstalled = false;
    try {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onHidden);
    } catch {
      /* 忽略 */
    }
  }
}
