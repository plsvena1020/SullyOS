import type { AppActivityProvider, AppActivitySession } from './types';

/**
 * Web provider：只跟踪 SullyOS 内部 App。
 * OSContext 把 activeApp 变化经 noteSullyosForeground() 喂进来，
 * 本模块负责闭合会话并计算时长。
 */
export function createWebAppActivity(opts?: {
  now?: () => number;
  deviceId?: string;
  onSession?: (s: AppActivitySession) => void;
}): AppActivityProvider {
  const now = opts?.now ?? (() => Date.now());
  let current: { appKey: string; appLabel: string; startedAt: number } | null = null;
  let listener: ((s: AppActivitySession) => void) | null = opts?.onSession ?? null;
  let counter = 0;

  const close = (endedAt: number): AppActivitySession | null => {
    if (!current) return null;
    const session: AppActivitySession = {
      id: `web-${current.startedAt}-${counter++}`,
      deviceId: opts?.deviceId ?? 'local',
      platform: 'web',
      source: 'sullyos',
      appKey: current.appKey,
      appLabel: current.appLabel,
      startedAt: current.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - current.startedAt),
      schemaVersion: 1,
    };
    current = null;
    return session;
  };

  return {
    kind: 'sullyos',
    isSupported: () => true,
    async getPermissionState() {
      return 'granted';
    },
    async requestPermission() {
      return 'granted';
    },
    async start(onSession) {
      listener = onSession;
    },
    async stop() {
      listener = null;
      current = null;
    },
    noteSullyosForeground(appKey, appLabel) {
      const t = now();
      if (appKey == null) {
        const done = close(t);
        if (done) listener?.(done);
        return;
      }
      if (current && current.appKey === appKey) return;
      const done = close(t);
      if (done) listener?.(done);
      current = { appKey, appLabel: appLabel ?? appKey, startedAt: t };
    },
  };
}
