import type { RealtimeConfig } from '../types';

/**
 * 旧 Supabase 透视窗一次性迁移（浏览器专用）。
 *
 * 决策：历史事件点不导入新后端（旧行没有开始/结束/时长，无法还原会话）。
 * 只做两件事：删除旧 Supabase 里 device_id='default' 的行；清空本地旧配置字段。
 */

export interface LegacyPerspectiveConfig {
  perspectiveSupabaseUrl?: string;
  perspectiveSupabaseAnonKey?: string;
  perspectiveWorkerUrl?: string;
}

/** 需要迁移 = 旧端点非空 且 新端点为空。纯函数。 */
export function needsPerspectiveMigration(rc: Partial<LegacyPerspectiveConfig> | undefined): boolean {
  if (!rc) return false;
  const oldUrl = (rc.perspectiveSupabaseUrl || '').trim();
  const oldKey = (rc.perspectiveSupabaseAnonKey || '').trim();
  const newUrl = (rc.perspectiveWorkerUrl || '').trim();
  return !!oldUrl && !!oldKey && !newUrl;
}

export async function purgeLegacyDefaultEvents(legacy: {
  url: string;
  key: string;
}): Promise<{ ok: boolean; status?: number; message?: string }> {
  const base = legacy.url.trim().replace(/\/+$/, '');
  const headers = {
    apikey: legacy.key,
    Authorization: `Bearer ${legacy.key}`,
    Prefer: 'return=minimal',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    for (const table of ['perspective_events', 'perspective_summaries']) {
      const res = await fetch(`${base}/rest/v1/${table}?device_id=eq.default`, {
        method: 'DELETE',
        headers,
        signal: ctrl.signal,
      });
      if (!res.ok) return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message };
  } finally {
    clearTimeout(timer);
  }
}

export const LEGACY_MIGRATED_KEY = 'sully_pv_legacy_purged_v1';

export function isLegacyMigrationDone(): boolean {
  try {
    return localStorage.getItem(LEGACY_MIGRATED_KEY) === '1';
  } catch {
    return true; // 读不到存储时不再尝试，避免每次启动都打旧端点。
  }
}

export function markLegacyMigrationDone(): void {
  try {
    localStorage.setItem(LEGACY_MIGRATED_KEY, '1');
  } catch {
    /* 忽略 */
  }
}

/**
 * 启动时调用一次（fire-and-forget，不阻塞 UI）。
 * onCleared 由调用方清空本地旧字段（updateRealtimeConfig）。
 */
export async function runPerspectiveLegacyMigration(
  rc: Partial<RealtimeConfig> | undefined,
  onCleared: () => void,
): Promise<{ clearedLegacyConfig: boolean; purgedRemote: boolean }> {
  if (!needsPerspectiveMigration(rc) || isLegacyMigrationDone()) {
    return { clearedLegacyConfig: false, purgedRemote: false };
  }
  const legacy = {
    url: String((rc as Record<string, unknown>)?.['perspectiveSupabaseUrl'] ?? ''),
    key: String((rc as Record<string, unknown>)?.['perspectiveSupabaseAnonKey'] ?? ''),
  };
  let purgedRemote = false;
  try {
    purgedRemote = (await purgeLegacyDefaultEvents(legacy)).ok;
  } catch {
    purgedRemote = false;
  }
  try {
    onCleared();
  } catch {
    /* 忽略 */
  }
  markLegacyMigrationDone();
  return { clearedLegacyConfig: true, purgedRemote };
}
