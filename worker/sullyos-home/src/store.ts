const now = () => Date.now();
export async function listMessages(db: any, charId: string, limit: number) {
  return (await db.prepare(
    'SELECT * FROM home_messages WHERE char_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(charId, limit).all()).results ?? [];
}
export async function insertMessage(db: any, b: { charId: string; role: string; content: string }) {
  const row = { id: `m_${now()}_${Math.floor(Math.random() * 1e6)}`, ...b, created_at: now(), updated_at: now() };
  await db.prepare(
    'INSERT INTO home_messages(id, char_id, role, content, created_at, updated_at) VALUES(?,?,?,?,?,?)'
  ).bind(row.id, row.charId, row.role, row.content, row.created_at, row.updated_at).run();
  return row;
}

export async function listMemories(db: any, charId: string, limit: number) {
  const n = Math.floor(Number(limit));
  const safe = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 50;
  return (await db.prepare(
    'SELECT * FROM home_memories WHERE char_id = ? ORDER BY updated_at DESC LIMIT ?'
  ).bind(charId, safe).all()).results ?? [];
}

export async function insertEvents(db: any, charId: string, events: Array<{ kind: string; payload: unknown }>) {
  const ts = now();
  const rows = events.map((e) => ({
    id: `e_${ts}_${Math.floor(Math.random() * 1e6)}`,
    charId, kind: e.kind, payload: JSON.stringify(e.payload ?? null),
    disclosed_to_user: 0, created_at: ts,
  }));
  for (const r of rows) {
    await db.prepare(
      'INSERT INTO home_events(id, char_id, kind, payload, disclosed_to_user, created_at) VALUES(?,?,?,?,?,?)'
    ).bind(r.id, r.charId, r.kind, r.payload, r.disclosed_to_user, r.created_at).run();
  }
  return rows;
}

export interface HomeServerConfig {
  /** 自主生活每隔多少分钟转一轮（5–120，缺省 30）。 */
  roundIntervalMin: number;
  /** 夜间安静段起点（HH:MM，缺省 '00:00'）。 */
  quietStart: string;
  /** 一天最多转几轮（0–96，缺省 48）。 */
  dailyMaxRounds: number;
}

export const HOME_SERVER_CONFIG_DEFAULTS: HomeServerConfig = {
  roundIntervalMin: 30,
  quietStart: '00:00',
  dailyMaxRounds: 48,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function clampHomeServerConfig(input: unknown): HomeServerConfig {
  const raw = (input !== null && typeof input === 'object' && !Array.isArray(input))
    ? input as Record<string, unknown>
    : {};
  const interval = Number(raw.roundIntervalMin);
  const daily = Number(raw.dailyMaxRounds);
  const quiet = typeof raw.quietStart === 'string' && HHMM.test(raw.quietStart)
    ? raw.quietStart
    : HOME_SERVER_CONFIG_DEFAULTS.quietStart;
  return {
    roundIntervalMin: Number.isFinite(interval)
      ? Math.min(120, Math.max(5, Math.floor(interval)))
      : HOME_SERVER_CONFIG_DEFAULTS.roundIntervalMin,
    quietStart: quiet,
    dailyMaxRounds: Number.isFinite(daily)
      ? Math.min(96, Math.max(0, Math.floor(daily)))
      : HOME_SERVER_CONFIG_DEFAULTS.dailyMaxRounds,
  };
}

export async function getHomeConfig(db: any, charId: string): Promise<HomeServerConfig> {
  const row = await db.prepare(
    'SELECT config FROM home_config WHERE char_id = ?'
  ).bind(charId).first() as { config?: unknown } | null;
  if (!row || typeof row.config !== 'string') return { ...HOME_SERVER_CONFIG_DEFAULTS };
  try {
    return clampHomeServerConfig(JSON.parse(row.config));
  } catch {
    return { ...HOME_SERVER_CONFIG_DEFAULTS };
  }
}

export async function putHomeConfig(db: any, charId: string, patch: unknown): Promise<HomeServerConfig> {
  const base = await getHomeConfig(db, charId);
  const raw = (patch !== null && typeof patch === 'object' && !Array.isArray(patch))
    ? patch as Record<string, unknown>
    : {};
  // 存量坏行（旧 JSON 形）先经 getHomeConfig 洗成合法终值，再叠本次 patch。
  const next = clampHomeServerConfig({ ...base, ...raw });
  const ts = now();
  await db.prepare(
    'INSERT INTO home_config(char_id, config, updated_at) VALUES(?,?,?) ' +
    'ON CONFLICT(char_id) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at'
  ).bind(charId, JSON.stringify(next), ts).run();
  return next;
}
