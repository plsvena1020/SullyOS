import type { ActivityPermissionState, AppActivityProvider, AppActivitySession } from './types';
import { listenTauri } from '../native';

interface TauriActivitySession {
  app_key: string;
  app_label: string;
  started_at: number;
  ended_at: number;
  duration_ms: number;
}

/**
 * Windows provider：前台进程会话（经 Tauri `activity-session` 事件）。
 * 只收可执行文件名 + 起止；窗口标题不在协议里，永远收不到。
 */
export function createWindowsAppActivity(opts?: { deviceId?: string }): AppActivityProvider {
  let unlisten: (() => void) | null = null;

  return {
    kind: 'foreground-process',
    isSupported: () => true,
    async getPermissionState(): Promise<ActivityPermissionState> {
      return 'granted';
    },
    async requestPermission(): Promise<ActivityPermissionState> {
      return 'granted';
    },
    async start(onSession: (s: AppActivitySession) => void) {
      if (unlisten) return;
      unlisten = await listenTauri<TauriActivitySession>('activity-session', (p) => {
        if (!p || !p.app_key) return;
        onSession({
          id: `windows-${p.started_at}-${p.app_key}`,
          deviceId: opts?.deviceId ?? 'local',
          platform: 'windows',
          source: 'device',
          appKey: p.app_key,
          appLabel: p.app_label || p.app_key,
          startedAt: p.started_at,
          endedAt: p.ended_at,
          durationMs: Math.max(0, p.duration_ms),
          schemaVersion: 1,
        });
      });
    },
    async stop() {
      if (unlisten) {
        try {
          unlisten();
        } catch {
          /* 忽略 */
        }
        unlisten = null;
      }
    },
    noteSullyosForeground() {
      // Windows 设备侧由原生采集；SullyOS 内部会话走 Web 层 effect，本 provider 不处理。
    },
  };
}
