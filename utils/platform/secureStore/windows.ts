import type { SecureStore } from './types';
import { invokeTauri } from '../native';

/** Windows 安全存储：DPAPI 加密文件（经 Tauri command）。 */
export function createWindowsSecureStore(): SecureStore {
  return {
    async get(key) {
      return invokeTauri<string | null>('secure_store_get', { key });
    },
    async set(key, value) {
      await invokeTauri<void>('secure_store_set', { key, value });
    },
    async remove(key) {
      await invokeTauri<void>('secure_store_remove', { key });
    },
  };
}
