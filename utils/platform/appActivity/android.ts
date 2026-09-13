import type { ActivityPermissionState, AppActivityProvider, AppActivitySession } from './types';
import { loadCapacitorPlugin } from '../native';

interface AppUsageSession {
  appKey: string;
  appLabel: string;
  startedAt: number;
  endedAt: number;
}

interface AppUsagePlugin {
  hasUsageAccess(): Promise<{ granted: boolean }>;
  openUsageAccessSettings(): Promise<void>;
  drainSessions(options: { sinceTs: number }): Promise<{ sessions: AppUsageSession[] }>;
}

const SELF_PACKAGE = 'com.aetheros.simulator';

/**
 * Android provider：UsageStatsManager 前台应用记录（经 Capacitor 插件）。
 * 只收包名 + 起止时间；通知/输入/屏幕一律不碰；排除自身包。
 */
export function createAndroidAppActivity(opts?: { deviceId?: string }): AppActivityProvider {
  let timer: ReturnType<typeof setInterval> | null = null;
  let listener: ((s: AppActivitySession) => void) | null = null;
  let lastTs = 0;

  const isAndroid = (): boolean => {
    try {
      const cap = (globalThis as any).Capacitor;
      return cap?.isNativePlatform === true && cap?.getPlatform?.() === 'android';
    } catch {
      return false;
    }
  };

  const pull = async () => {
    if (!listener) return;
    try {
      const plugin = await loadCapacitorPlugin<AppUsagePlugin>('AppUsage');
      const { sessions } = await plugin.drainSessions({ sinceTs: lastTs });
      for (const s of sessions ?? []) {
        if (!s || s.appKey === SELF_PACKAGE || !s.appKey) continue;
        lastTs = Math.max(lastTs, s.endedAt || 0);
        listener({
          id: `android-${s.startedAt}-${s.appKey}`,
          deviceId: opts?.deviceId ?? 'local',
          platform: 'android',
          source: 'device',
          appKey: s.appKey,
          appLabel: s.appLabel || s.appKey,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          durationMs: Math.max(0, s.endedAt - s.startedAt),
          schemaVersion: 1,
        });
      }
    } catch {
      /* 插件不可用时静默，下次轮询再试 */
    }
  };

  return {
    kind: 'usage-stats',
    isSupported: isAndroid,
    async getPermissionState(): Promise<ActivityPermissionState> {
      if (!isAndroid()) return 'unsupported';
      try {
        const plugin = await loadCapacitorPlugin<AppUsagePlugin>('AppUsage');
        const r = await plugin.hasUsageAccess();
        return r.granted ? 'granted' : 'denied';
      } catch {
        return 'denied';
      }
    },
    async requestPermission(): Promise<ActivityPermissionState> {
      if (!isAndroid()) return 'unsupported';
      try {
        const plugin = await loadCapacitorPlugin<AppUsagePlugin>('AppUsage');
        await plugin.openUsageAccessSettings();
        return 'prompt';
      } catch {
        return 'denied';
      }
    },
    async start(onSession) {
      listener = onSession;
      lastTs = Date.now() - 15 * 60_000;
      await pull();
      if (timer == null) {
        timer = setInterval(() => {
          void pull();
        }, 60_000);
      }
    },
    async stop() {
      listener = null;
      if (timer != null) {
        clearInterval(timer);
        timer = null;
      }
    },
    noteSullyosForeground() {
      // Android 设备侧由原生采集，SullyOS 内部会话仍由 Web 层 activeApp effect 经
      // noteSullyosForeground 上报——本 provider 不处理，避免双记。
    },
  };
}
