import type { SecureStore } from './types';
import { loadCapacitorPlugin } from '../native';

interface SecureStorePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

/** Android 安全存储：EncryptedSharedPreferences（经 Capacitor 插件）。 */
export function createAndroidSecureStore(): SecureStore {
  const plugin = () => loadCapacitorPlugin<SecureStorePlugin>('SecureStore');
  return {
    async get(key) {
      const p = await plugin();
      const r = await p.get({ key });
      return r.value;
    },
    async set(key, value) {
      const p = await plugin();
      await p.set({ key, value });
    },
    async remove(key) {
      const p = await plugin();
      await p.remove({ key });
    },
  };
}
