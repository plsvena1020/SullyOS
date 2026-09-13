import type { AppActivitySession } from './types';

export const ACTIVITY_DB = 'sully_activity_v1';
export const ACTIVITY_STORE = 'outbox';
export const ACTIVITY_MAX_BATCH = 200;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ACTIVITY_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(ACTIVITY_STORE)) {
        req.result.createObjectStore(ACTIVITY_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('activity queue open failed'));
  });
}

export async function enqueueSession(session: AppActivitySession): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ACTIVITY_STORE, 'readwrite');
      // put 保证同一 id 幂等覆盖，不产生重复项。
      const req = tx.objectStore(ACTIVITY_STORE).put(session);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('enqueue failed'));
    });
  } finally {
    db.close();
  }
}

export async function drainSessions(max = ACTIVITY_MAX_BATCH): Promise<AppActivitySession[]> {
  const db = await openDb();
  try {
    const all = await new Promise<AppActivitySession[]>((resolve, reject) => {
      const req = db.transaction(ACTIVITY_STORE, 'readonly').objectStore(ACTIVITY_STORE).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as AppActivitySession[]);
      req.onerror = () => reject(req.error ?? new Error('drain failed'));
    });
    return all.sort((a, b) => a.startedAt - b.startedAt).slice(0, max);
  } finally {
    db.close();
  }
}

export async function ackSessions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ACTIVITY_STORE, 'readwrite');
      const store = tx.objectStore(ACTIVITY_STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('ack failed'));
    });
  } finally {
    db.close();
  }
}

export async function outboxCount(): Promise<number> {
  const db = await openDb();
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = db.transaction(ACTIVITY_STORE, 'readonly').objectStore(ACTIVITY_STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('count failed'));
    });
  } finally {
    db.close();
  }
}
