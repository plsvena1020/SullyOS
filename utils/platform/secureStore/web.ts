import type { SecureStore } from './types';

export const SECURE_DB_NAME = 'sully_secure_v1';
export const SECURE_STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SECURE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SECURE_STORE)) {
        req.result.createObjectStore(SECURE_STORE, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('secure store open failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(SECURE_STORE, mode);
      const req = fn(tx.objectStore(SECURE_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('secure store request failed'));
    });
  } finally {
    db.close();
  }
}

/** Web 安全存储：独立 IDB 库，绝不写入主库 AetherOS_Data（避免进备份）。 */
export function createWebSecureStore(): SecureStore {
  return {
    async get(key: string): Promise<string | null> {
      const row = await withStore<{ k: string; v: string } | undefined>('readonly', (s) => s.get(key));
      return row?.v ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      await withStore('readwrite', (s) => s.put({ k: key, v: value }));
    },
    async remove(key: string): Promise<void> {
      await withStore('readwrite', (s) => s.delete(key));
    },
  };
}
