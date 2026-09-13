import { describe, expect, it } from 'vitest';
import worker from './index';
import { __resetSchemaForTest } from './schema';

type Row = Record<string, any>;

/** 最小内存 D1 替身：只实现本 worker 实际使用的语句形态。 */
function makeFakeDb() {
  const devices = new Map<string, Row>();
  const devicesByHash = new Map<string, string>();
  const roleTokens = new Map<string, Row>();
  const sessions = new Map<string, Row>();
  const summaries: Row[] = [];
  const ratelimit = new Map<string, Row>();

  const runResult = (changes: number) => ({ success: true, meta: { changes } });

  const db = {
    devices,
    sessions,
    async exec(_q: string) {
      return {};
    },
    prepare(q: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...a: unknown[]) {
          (stmt as any)._args = a;
          return stmt;
        },
        async run() {
          const a = (stmt as any)._args as any[];
          if (q.includes('INSERT INTO pv_devices')) {
            const [device_id, device_name, platform, token_hash, created_at, last_seen_at] = a;
            devices.set(device_id, { device_id, device_name, platform, revoked: 0 });
            devicesByHash.set(token_hash, device_id);
            void created_at;
            void last_seen_at;
            return runResult(1);
          }
          if (q.includes('UPDATE pv_devices SET revoked=1')) {
            const row = devices.get(a[0]);
            if (row) row.revoked = 1;
            return runResult(1);
          }
          if (q.includes('UPDATE pv_devices SET device_name=')) {
            const row = devices.get(a[1]);
            if (row) row.device_name = a[0];
            return runResult(1);
          }
          if (q.includes('UPDATE pv_devices SET last_seen_at=')) {
            return runResult(1);
          }
          if (q.includes('INSERT OR IGNORE INTO pv_sessions')) {
            const [id, device_id, platform, source, app_key, app_label, started_at, ended_at, duration_ms] = a;
            if (sessions.has(id)) return runResult(0);
            sessions.set(id, { id, device_id, platform, source, app_key, app_label, started_at, ended_at, duration_ms });
            return runResult(1);
          }
          if (q.includes("DELETE FROM pv_sessions WHERE device_id='default'")) {
            let n = 0;
            for (const [id, s] of sessions) {
              if (s.device_id === 'default') {
                sessions.delete(id);
                n++;
              }
            }
            return runResult(n);
          }
          if (q.includes('DELETE FROM pv_summaries WHERE device_id=')) {
            return runResult(0);
          }
          if (q.includes('DELETE FROM pv_sessions WHERE device_id=? AND started_at<?')) {
            let n = 0;
            for (const [id, s] of sessions) {
              if (s.device_id === a[0] && s.started_at < a[1]) {
                sessions.delete(id);
                n++;
              }
            }
            return runResult(n);
          }
          if (q.includes('DELETE FROM pv_sessions WHERE device_id=?')) {
            let n = 0;
            for (const [id, s] of sessions) {
              if (s.device_id === a[0]) {
                sessions.delete(id);
                n++;
              }
            }
            return runResult(n);
          }
          if (q.includes('DELETE FROM pv_sessions WHERE started_at<?')) {
            let n = 0;
            for (const [id, s] of sessions) {
              if (s.started_at < a[0]) {
                sessions.delete(id);
                n++;
              }
            }
            return runResult(n);
          }
          if (q.includes('DELETE FROM pv_ratelimit WHERE reset_at<?')) {
            return runResult(0);
          }
          if (q.includes('INSERT OR REPLACE INTO pv_ratelimit')) {
            ratelimit.set(a[0], { count: a[1], reset_at: a[2] });
            return runResult(1);
          }
          if (q.includes('UPDATE pv_ratelimit SET count=')) {
            const row = ratelimit.get(a[1]);
            if (row) row.count = a[0];
            return runResult(1);
          }
          if (q.includes('INSERT OR REPLACE INTO pv_role_tokens')) {
            roleTokens.set(a[0], { token_hash: a[0], char_id: a[1], device_id: a[2], revoked: 0 });
            return runResult(1);
          }
          if (q.includes('UPDATE pv_role_tokens SET revoked=1')) {
            for (const r of roleTokens.values()) {
              if (r.char_id === a[0] && r.device_id === a[1]) r.revoked = 1;
            }
            return runResult(1);
          }
          if (q.includes('INSERT INTO pv_summaries')) {
            summaries.push({ id: a[0] });
            return runResult(1);
          }
          throw new Error(`fake db: unsupported run: ${q}`);
        },
        async first() {
          const a = (stmt as any)._args as any[];
          if (q.includes('FROM pv_devices WHERE token_hash=')) {
            const id = devicesByHash.get(a[0]);
            const row = id ? devices.get(id) : undefined;
            return row ? { device_id: row.device_id, revoked: row.revoked } : null;
          }
          if (q.includes('FROM pv_role_tokens WHERE token_hash=')) {
            const row = roleTokens.get(a[0]);
            return row ? { device_id: row.device_id, char_id: row.char_id, revoked: row.revoked } : null;
          }
          if (q.includes('FROM pv_devices WHERE device_id=')) {
            return devices.get(a[0]) ?? null;
          }
          if (q.includes('FROM pv_ratelimit WHERE bucket=')) {
            return ratelimit.get(a[0]) ?? null;
          }
          if (q.includes('FROM pv_summaries WHERE device_id=')) {
            return null;
          }
          throw new Error(`fake db: unsupported first: ${q}`);
        },
        async all() {
          const a = (stmt as any)._args as any[];
          if (q.includes('FROM pv_sessions WHERE device_id=?')) {
            const rows = [...sessions.values()]
              .filter((s) => s.device_id === a[0] && s.started_at >= a[1] && s.started_at <= a[2])
              .sort((x, y) => x.started_at - y.started_at)
              .slice(0, a[3]);
            return { results: rows };
          }
          throw new Error(`fake db: unsupported all: ${q}`);
        },
      };
      return stmt;
    },
    batch(s: unknown[]) {
      return Promise.all((s as any[]).map((x) => x.run()));
    },
  };
  return db;
}

const env = (db: any, overrides: Record<string, string> = {}) => ({
  DB: db,
  PV_PAIRING_CODE: 'pair-123',
  ...overrides,
});

const post = (path: string, body: unknown, token?: string) =>
  new Request(`https://pv.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

describe('perspective worker', () => {
  it('preflight answers 204 without auth', async () => {
    __resetSchemaForTest();
    const res = await worker.fetch(
      new Request('https://pv.test/sessions', { method: 'OPTIONS' }),
      env(makeFakeDb()) as any,
    );
    expect(res.status).toBe(204);
  });

  it('preflight echoes custom headers and methods', async () => {
    __resetSchemaForTest();
    const res = await worker.fetch(
      new Request('https://pv.test/sessions', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://sully.test',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'x-future-feature, Authorization',
        },
      }),
      env(makeFakeDb()) as any,
    );
    expect(res.status).toBe(204);
    const allow = (res.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
    expect(allow).toContain('x-future-feature');
    expect(allow).toContain('authorization');
    expect(res.headers.get('Access-Control-Allow-Methods') || '').toContain('POST');
    expect(res.headers.get('Access-Control-Max-Age')).toBeTruthy();
  });

  it('health needs no auth', async () => {
    __resetSchemaForTest();
    const res = await worker.fetch(new Request('https://pv.test/health'), env(makeFakeDb()) as any);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ ok: true });
  });

  it('pair rejects wrong code and accepts right code', async () => {
    __resetSchemaForTest();
    const db = makeFakeDb();
    const bad = await worker.fetch(
      post('/device/register', { pairingCode: 'nope', deviceName: 't', platform: 'web' }),
      env(db) as any,
    );
    expect(bad.status).toBe(401);
    const good = await worker.fetch(
      post('/device/register', { pairingCode: 'pair-123', deviceName: 't', platform: 'web' }),
      env(db) as any,
    );
    expect(good.status).toBe(200);
    const data = (await good.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.deviceToken.startsWith('pvd_')).toBe(true);
  });

  it('sessions reject without token, accept batch, dedupe retry', async () => {
    __resetSchemaForTest();
    const db = makeFakeDb();
    const reg = (await (
      await worker.fetch(
        post('/device/register', { pairingCode: 'pair-123', deviceName: 't', platform: 'android' }),
        env(db) as any,
      )
    ).json()) as any;
    const noAuth = await worker.fetch(
      post('/sessions', { sessions: [] }),
      env(db) as any,
    );
    expect(noAuth.status).toBe(401);

    const session = {
      id: 's-1',
      platform: 'android',
      source: 'device',
      appKey: 'com.tencent.mm',
      appLabel: 'wechat',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      durationMs: 1000,
      schemaVersion: 1,
    };
    const first = (await (
      await worker.fetch(post('/sessions', { sessions: [session] }, reg.deviceToken), env(db) as any)
    ).json()) as any;
    expect(first).toMatchObject({ ok: true, accepted: 1, duplicates: 0 });
    const retry = (await (
      await worker.fetch(post('/sessions', { sessions: [session] }, reg.deviceToken), env(db) as any)
    ).json()) as any;
    expect(retry).toMatchObject({ ok: true, accepted: 0, duplicates: 1 });

    const list = (await (
      await worker.fetch(
        new Request('https://pv.test/sessions?limit=10', {
          headers: { Authorization: `Bearer ${reg.deviceToken}` },
        }),
        env(db) as any,
      )
    ).json()) as any;
    expect(list.sessions.length).toBe(1);
  });

  it('role token reads but cannot write', async () => {
    __resetSchemaForTest();
    const db = makeFakeDb();
    const reg = (await (
      await worker.fetch(
        post('/device/register', { pairingCode: 'pair-123', deviceName: 't', platform: 'web' }),
        env(db) as any,
      )
    ).json()) as any;
    const issued = (await (
      await worker.fetch(post('/role-tokens', { charId: 'char-a' }, reg.deviceToken), env(db) as any)
    ).json()) as any;
    expect(issued.roleToken.startsWith('pvc_')).toBe(true);

    const write = await worker.fetch(
      post('/sessions', { sessions: [] }, issued.roleToken),
      env(db) as any,
    );
    expect(write.status).toBe(403);
    const read = await worker.fetch(
      new Request('https://pv.test/sessions?limit=10', {
        headers: { Authorization: `Bearer ${issued.roleToken}` },
      }),
      env(db) as any,
    );
    expect(read.status).toBe(200);
  });

  it('purge-default needs credential', async () => {
    __resetSchemaForTest();
    const db = makeFakeDb();
    const anon = await worker.fetch(post('/admin/purge-default', {}), env(db) as any);
    expect(anon.status).toBe(401);
    const ok = await worker.fetch(post('/admin/purge-default', {}, 'pair-123'), env(db) as any);
    expect(ok.status).toBe(200);
  });
});
