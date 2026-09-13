/**
 * SullyOS · 透视窗后端（用户自建 Cloudflare Worker + D1）
 *
 * 只存「应用身份 + 会话时长」：不设窗口标题 / URL / 正文 / 消息列，
 * 客户端传了也不入库（validateSession 按白名单字段校验）。
 *
 * 路由：
 *   GET    /health
 *   POST   /device/register   { pairingCode, deviceName, platform }
 *   GET    /devices                                   [设备] 本机
 *   PATCH  /devices/:id       { name }                [设备] 仅自身
 *   DELETE /devices/:id                               [设备] 仅自身（撤销）
 *   POST   /sessions          { sessions: [...] }     [设备] 批量≤200，幂等
 *   GET    /sessions?since&until&limit                 [设备/角色] 角色只读绑定设备
 *   DELETE /sessions?beforeDays                       [设备] 清本机
 *   POST   /role-tokens       { charId }              [设备] 签发角色只读令牌
 *   DELETE /role-tokens/:charId                       [设备] 吊销
 *   GET    /summaries?until                           [设备/角色]
 *   POST   /summaries         {...}                   [设备]
 *   POST   /admin/purge-default                       [管理] 清旧 device_id='default'
 */

export interface Env {
  DB: D1Database;
  /** 配对码（secret）。未配置时注册接口 503。 */
  PV_PAIRING_CODE?: string;
  /** 管理令牌（secret，可选；purge-default 可用配对码或管理令牌）。 */
  PV_ADMIN_TOKEN?: string;
  /** 限流 IP 盐（secret，建议配置）。 */
  PV_IP_SALT?: string;
  /** 保留天数（默认 30，夹取 1..30）。 */
  PV_RETENTION_DAYS?: string;
  /** 每设备每分钟事件上限（默认 120）。 */
  PV_RATE_EVENTS_PER_MIN?: string;
  /** 单批上限（默认 200）。 */
  PV_MAX_BATCH?: string;
}

interface D1Database {
  prepare(q: string): D1PreparedStatement;
  batch(s: D1PreparedStatement[]): Promise<unknown[]>;
  exec(q: string): Promise<unknown>;
}
interface D1PreparedStatement {
  bind(...a: unknown[]): D1PreparedStatement;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
  first<T = unknown>(c?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

import { preflightResponse, corsHeaders } from '../../shared/cors';
import { ensureSchema } from './schema';
import { generateToken, sha256Hex, timingSafeEqualHex, validateSession } from './auth';

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const json = (req: Request, data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });

const num = (v: string | undefined, dflt: number) => {
  const n = parseInt(v || '', 10);
  return Number.isFinite(n) ? n : dflt;
};

const retentionDays = (env: Env) => Math.min(30, Math.max(1, num(env.PV_RETENTION_DAYS, 30)));
const maxBatch = (env: Env) => Math.min(500, Math.max(1, num(env.PV_MAX_BATCH, 200)));
const ratePerMin = (env: Env) => Math.min(1000, Math.max(1, num(env.PV_RATE_EVENTS_PER_MIN, 120)));

type Authed =
  | { kind: 'device'; deviceId: string }
  | { kind: 'role'; deviceId: string; charId: string };

async function authenticate(req: Request, db: D1Database): Promise<Authed | null> {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.get('Authorization') || '');
  const token = (m?.[1] || '').trim();
  if (!token) return null;
  const hash = await sha256Hex(token);
  const dev = await db
    .prepare(`SELECT device_id, revoked FROM pv_devices WHERE token_hash=?`)
    .bind(hash)
    .first<{ device_id: string; revoked: number }>();
  if (dev && Number(dev.revoked) === 0) return { kind: 'device', deviceId: dev.device_id };
  const role = await db
    .prepare(`SELECT device_id, char_id, revoked FROM pv_role_tokens WHERE token_hash=?`)
    .bind(hash)
    .first<{ device_id: string; char_id: string; revoked: number }>();
  if (role && Number(role.revoked) === 0) {
    return { kind: 'role', deviceId: role.device_id, charId: role.char_id };
  }
  return null;
}

async function checkRate(db: D1Database, bucket: string, limit: number, cost = 1): Promise<boolean> {
  const now = Date.now();
  const row = await db
    .prepare(`SELECT count, reset_at FROM pv_ratelimit WHERE bucket=?`)
    .bind(bucket)
    .first<{ count: number; reset_at: number }>();
  if (!row || row.reset_at <= now) {
    await db
      .prepare(`INSERT OR REPLACE INTO pv_ratelimit (bucket, count, reset_at) VALUES (?, ?, ?)`)
      .bind(bucket, cost, now + 60_000)
      .run();
    return cost <= limit;
  }
  if (row.count + cost > limit) return false;
  await db
    .prepare(`UPDATE pv_ratelimit SET count=? WHERE bucket=?`)
    .bind(row.count + cost, bucket)
    .run();
  return true;
}

async function pruneExpired(db: D1Database, env: Env): Promise<void> {
  const cutoff = Date.now() - retentionDays(env) * 86_400_000;
  await db.prepare(`DELETE FROM pv_sessions WHERE started_at<?`).bind(cutoff).run();
  await db.prepare(`DELETE FROM pv_ratelimit WHERE reset_at<?`).bind(Date.now()).run();
}

const stripSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return preflightResponse(request);
    const db = env.DB as unknown as D1Database | undefined;
    if (!db) return json(request, { ok: false, error: 'D1 binding "DB" missing' }, 500);
    await ensureSchema(db as unknown as Parameters<typeof ensureSchema>[0]);

    const url = new URL(request.url);
    const path = stripSlash(url.pathname);

    if (request.method === 'GET' && path === '/health') {
      return json(request, { ok: true, service: 'sullyos-perspective', retentionDays: retentionDays(env) });
    }

    if (request.method === 'POST' && path === '/device/register') {
      if (!env.PV_PAIRING_CODE) return json(request, { ok: false, error: 'pairing not configured' }, 503);
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json(request, { ok: false, error: 'bad json' }, 400);
      }
      if (typeof body.pairingCode !== 'string' || !timingSafeEqualHex(body.pairingCode, env.PV_PAIRING_CODE)) {
        return json(request, { ok: false, error: 'bad pairing code' }, 401);
      }
      const platform = body.platform === 'android' || body.platform === 'windows' ? body.platform : 'web';
      const deviceName = [...String(body.deviceName ?? '')].slice(0, 64).join('') || platform;
      const deviceId = uuid();
      const token = generateToken('pvd_');
      const now = Date.now();
      await db
        .prepare(
          `INSERT INTO pv_devices (device_id, device_name, platform, token_hash, created_at, last_seen_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(deviceId, deviceName, platform, await sha256Hex(token), now, now)
        .run();
      // 令牌明文只返回这一次，不落日志。
      return json(request, { ok: true, deviceId, deviceToken: token });
    }

    if (request.method === 'POST' && path === '/admin/purge-default') {
      const m = /^Bearer\s+(.+)$/.exec(request.headers.get('Authorization') || '');
      const presented = (m?.[1] || '').trim();
      const adminOk = !!env.PV_ADMIN_TOKEN && timingSafeEqualHex(presented, env.PV_ADMIN_TOKEN);
      const pairOk = !!env.PV_PAIRING_CODE && timingSafeEqualHex(presented, env.PV_PAIRING_CODE);
      if (!adminOk && !pairOk) return json(request, { ok: false, error: 'unauthorized' }, 401);
      const ev = await db.prepare(`DELETE FROM pv_sessions WHERE device_id='default'`).run();
      const sm = await db.prepare(`DELETE FROM pv_summaries WHERE device_id='default'`).run();
      return json(request, {
        ok: true,
        deletedSessions: ev.meta?.changes ?? 0,
        deletedSummaries: sm.meta?.changes ?? 0,
      });
    }

    // 以下全部需要设备或角色令牌。
    const authed = await authenticate(request, db);
    if (!authed) return json(request, { ok: false, error: 'unauthorized' }, 401);

    if (request.method === 'GET' && path === '/devices') {
      if (authed.kind !== 'device') return json(request, { ok: false, error: 'forbidden' }, 403);
      const row = await db
        .prepare(`SELECT device_id, device_name, platform, revoked FROM pv_devices WHERE device_id=?`)
        .bind(authed.deviceId)
        .first<{ device_id: string; device_name: string; platform: string; revoked: number }>();
      return json(request, { ok: true, device: row });
    }

    const devMatch = /^\/devices\/([^/]+)$/.exec(path);
    if (devMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
      if (authed.kind !== 'device' || devMatch[1] !== authed.deviceId) {
        return json(request, { ok: false, error: 'forbidden' }, 403);
      }
      if (request.method === 'DELETE') {
        await db.prepare(`UPDATE pv_devices SET revoked=1 WHERE device_id=?`).bind(authed.deviceId).run();
        return json(request, { ok: true });
      }
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json(request, { ok: false, error: 'bad json' }, 400);
      }
      if (typeof body.name === 'string' && body.name.length > 0) {
        const name = [...body.name].slice(0, 64).join('');
        await db.prepare(`UPDATE pv_devices SET device_name=? WHERE device_id=?`).bind(name, authed.deviceId).run();
      }
      return json(request, { ok: true });
    }

    if (request.method === 'POST' && path === '/sessions') {
      if (authed.kind !== 'device') return json(request, { ok: false, error: 'forbidden' }, 403);
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json(request, { ok: false, error: 'bad json' }, 400);
      }
      const list = Array.isArray(body.sessions) ? body.sessions : null;
      if (!list) return json(request, { ok: false, error: 'bad sessions' }, 400);
      if (list.length > maxBatch(env)) return json(request, { ok: false, error: 'batch too large' }, 400);
      if (!(await checkRate(db, `sess:${authed.deviceId}`, ratePerMin(env), Math.max(1, list.length)))) {
        return json(request, { ok: false, error: 'rate limited' }, 429);
      }
      const now = Date.now();
      let accepted = 0;
      let duplicates = 0;
      for (const raw of list) {
        // 服务端以令牌绑定设备为准，忽略客户端伪造的 deviceId。
        const v = validateSession({ ...(raw as object), deviceId: authed.deviceId }, now);
        if (!v.ok) return json(request, { ok: false, error: `bad session: ${(v as { error: string }).error}` }, 400);
        const s = raw as Record<string, number | string>;
        const r = await db
          .prepare(
            `INSERT OR IGNORE INTO pv_sessions (id, device_id, platform, source, app_key, app_label, started_at, ended_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(s['id'], authed.deviceId, s['platform'], s['source'], s['appKey'], s['appLabel'], s['startedAt'], s['endedAt'], s['durationMs'])
          .run();
        if ((r.meta?.changes ?? 0) > 0) accepted++;
        else duplicates++;
      }
      await db.prepare(`UPDATE pv_devices SET last_seen_at=? WHERE device_id=?`).bind(now, authed.deviceId).run();
      await pruneExpired(db, env);
      return json(request, { ok: true, accepted, duplicates });
    }

    if (request.method === 'GET' && path === '/sessions') {
      const since = num(url.searchParams.get('since') || undefined, 0);
      const until = num(url.searchParams.get('until') || undefined, Date.now());
      const limit = Math.min(500, Math.max(1, num(url.searchParams.get('limit') || undefined, 100)));
      const rows = await db
        .prepare(
          `SELECT id, device_id, platform, source, app_key, app_label, started_at, ended_at, duration_ms FROM pv_sessions WHERE device_id=? AND started_at>=? AND started_at<=? ORDER BY started_at LIMIT ?`,
        )
        .bind(authed.deviceId, since, until, limit)
        .all();
      return json(request, { ok: true, sessions: rows.results });
    }

    if (request.method === 'DELETE' && path === '/sessions') {
      if (authed.kind !== 'device') return json(request, { ok: false, error: 'forbidden' }, 403);
      const beforeDays = num(url.searchParams.get('beforeDays') || undefined, 0);
      const r =
        beforeDays > 0
          ? await db
              .prepare(`DELETE FROM pv_sessions WHERE device_id=? AND started_at<?`)
              .bind(authed.deviceId, Date.now() - beforeDays * 86_400_000)
              .run()
          : await db.prepare(`DELETE FROM pv_sessions WHERE device_id=?`).bind(authed.deviceId).run();
      return json(request, { ok: true, deleted: r.meta?.changes ?? 0 });
    }

    if (request.method === 'POST' && path === '/role-tokens') {
      if (authed.kind !== 'device') return json(request, { ok: false, error: 'forbidden' }, 403);
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json(request, { ok: false, error: 'bad json' }, 400);
      }
      if (typeof body.charId !== 'string' || body.charId.length === 0) {
        return json(request, { ok: false, error: 'bad charId' }, 400);
      }
      const token = generateToken('pvc_');
      await db
        .prepare(`INSERT OR REPLACE INTO pv_role_tokens (token_hash, char_id, device_id, created_at, revoked) VALUES (?, ?, ?, ?, 0)`)
        .bind(await sha256Hex(token), body.charId, authed.deviceId, Date.now())
        .run();
      return json(request, { ok: true, roleToken: token });
    }

    const roleMatch = /^\/role-tokens\/([^/]+)$/.exec(path);
    if (roleMatch && request.method === 'DELETE') {
      if (authed.kind !== 'device') return json(request, { ok: false, error: 'forbidden' }, 403);
      await db
        .prepare(`UPDATE pv_role_tokens SET revoked=1 WHERE char_id=? AND device_id=?`)
        .bind(decodeURIComponent(roleMatch[1]), authed.deviceId)
        .run();
      return json(request, { ok: true });
    }

    if (request.method === 'GET' && path === '/summaries') {
      const until = num(url.searchParams.get('until') || undefined, Date.now());
      const row = await db
        .prepare(
          `SELECT id, device_id, window_start, window_end, session_count, total_duration_ms, summary, model, created_at FROM pv_summaries WHERE device_id=? AND window_end<=? ORDER BY window_end DESC LIMIT 1`,
        )
        .bind(authed.deviceId, until)
        .first();
      return json(request, { ok: true, summary: row });
    }

    if (request.method === 'POST' && path === '/summaries') {
      if (authed.kind !== 'device') return json(request, { ok: false, error: 'forbidden' }, 403);
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return json(request, { ok: false, error: 'bad json' }, 400);
      }
      const required = ['windowStart', 'windowEnd', 'sessionCount', 'totalDurationMs', 'summary', 'model'];
      for (const k of required) {
        if (body[k] == null || body[k] === '') return json(request, { ok: false, error: `bad ${k}` }, 400);
      }
      const id = uuid();
      await db
        .prepare(
          `INSERT INTO pv_summaries (id, device_id, window_start, window_end, session_count, total_duration_ms, summary, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          authed.deviceId,
          body.windowStart,
          body.windowEnd,
          body.sessionCount,
          body.totalDurationMs,
          [...String(body.summary)].slice(0, 4000).join(''),
          [...String(body.model)].slice(0, 64).join(''),
          Date.now(),
        )
        .run();
      return json(request, { ok: true, id });
    }

    return json(request, { ok: false, error: 'not found' }, 404);
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const db = env.DB as unknown as D1Database | undefined;
    if (!db) return;
    await ensureSchema(db as unknown as Parameters<typeof ensureSchema>[0]);
    await pruneExpired(db, env);
  },
};
