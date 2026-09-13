/**
 * 原生模块懒加载收口。
 * 全仓只有本文件允许动态 import @capacitor/* 与 @tauri-apps/*。
 * 业务代码一律经 getPlatformBridge() 间接使用。
 */

export async function loadCapacitorCore(): Promise<any> {
  if (typeof globalThis === 'undefined' || (globalThis as any).Capacitor == null) {
    throw new Error('capacitor unavailable: not running inside a Capacitor shell');
  }
  return import('@capacitor/core');
}

export async function loadCapacitorPlugin<T>(name: string): Promise<T> {
  const core = (await loadCapacitorCore()) as any;
  const plugin = core?.Plugins?.[name] ?? core?.[name];
  if (plugin == null) throw new Error(`capacitor plugin unavailable: ${name}`);
  return plugin as T;
}

export async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof globalThis === 'undefined' || (globalThis as any).__TAURI_INTERNALS__ == null) {
    throw new Error(`tauri unavailable (cmd=${cmd}): not running inside a Tauri shell`);
  }
  const core = (await import('@tauri-apps/api/core')) as any;
  return core.invoke(cmd, args) as Promise<T>;
}

export async function listenTauri<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (typeof globalThis === 'undefined' || (globalThis as any).__TAURI_INTERNALS__ == null) {
    throw new Error(`tauri unavailable (event=${event}): not running inside a Tauri shell`);
  }
  const core = (await import('@tauri-apps/api/event')) as any;
  return core.listen(event, (e: { payload: T }) => cb(e.payload)) as Promise<() => void>;
}
