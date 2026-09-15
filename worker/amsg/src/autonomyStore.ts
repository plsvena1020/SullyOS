/**
 * 自主背景生活（autonomy）的云端落库层。
 *
 * 两张表，都建在用户自己的 D1 里、和上游表并列，绝不改上游 schema：
 *   autonomy_experiences —— 角色自己攒下的经历（Task 18 写、之后读进提示词）
 *   autonomy_state       —— 调度器的记账：窗口、当日轮数、token、熔断、configHash
 *
 * B0：角色的 fire_pack 不在这两张表里，它是上游 `client_state` 表里 namespace
 * `amsg:char:<charId>` 下的 `fire_pack` 键（utils/amsgFirePack.ts:22-24）——cron 那条路
 * 没有请求上下文，只能直接扫那张表、按 user_id 解密、再解析（见 autonomyScheduler 的
 * scanAutonomyPacks）。
 *
 * 表懒建，照 worker/post-office/src/index.ts 的做法：模块级 ready 短路 + CREATE
 * TABLE/INDEX IF NOT EXISTS，老库缺列靠 ALTER 吞 "duplicate column" 补。
 */

/**
 * 调度器和 store 真正用到的那部分 D1（结构子集，与 pushFanout 的 FanoutDb 同一手法）。
 *
 * 不直接用 `D1Database` 这个名字：它在本仓库没有任何声明（worker 侧要么自己声明，
 * 要么像这里取结构子集），写上去就是一个新的 tsc 错误。
 */
export interface AutonomyStatement {
  bind(...args: unknown[]): AutonomyStatement;
  run(): Promise<unknown>;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results?: Array<Record<string, unknown>> }>;
}

export interface AutonomyDb {
  prepare(sql: string): AutonomyStatement;
}

/** 经历行的保留期：超过就删（cron 每跳顺手清一次）。 */
export const AUTONOMY_EXPERIENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AUTONOMY_EXPERIENCES_DDL = `CREATE TABLE IF NOT EXISTS autonomy_experiences (
  id TEXT PRIMARY KEY,
  char_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  q TEXT,
  note TEXT NOT NULL,
  kind TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 0,
  pushed INTEGER NOT NULL DEFAULT 0
)`;

export const AUTONOMY_EXPERIENCES_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_autonomy_experiences_char_created ON autonomy_experiences (char_id, created_at)';

export const AUTONOMY_STATE_DDL = `CREATE TABLE IF NOT EXISTS autonomy_state (
  char_id TEXT PRIMARY KEY,
  last_round_at INTEGER NOT NULL DEFAULT 0,
  last_push_at INTEGER NOT NULL DEFAULT 0,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  rounds_date TEXT NOT NULL DEFAULT '',
  rounds_today INTEGER NOT NULL DEFAULT 0,
  tokens_date TEXT NOT NULL DEFAULT '',
  tokens_today INTEGER NOT NULL DEFAULT 0,
  config_hash TEXT NOT NULL DEFAULT ''
)`;

export interface AutonomyStateRow {
  charId: string;
  lastRoundAt: number;
  lastPushAt: number;
  failStreak: number;
  roundsDate: string;
  roundsToday: number;
  tokensDate: string;
  tokensToday: number;
  configHash: string;
}

export const emptyAutonomyState = (charId: string): AutonomyStateRow => ({
  charId,
  lastRoundAt: 0,
  lastPushAt: 0,
  failStreak: 0,
  roundsDate: '',
  roundsToday: 0,
  tokensDate: '',
  tokensToday: 0,
  configHash: '',
});

export interface AutonomyExperienceInput {
  charId: string;
  createdAt: number;
  /** 触发这条经历的用户原话（没有就 null）。 */
  q?: string | null;
  note: string;
  kind: string;
  importance?: number;
  pushed?: boolean;
  /** 不传就现造一个 uuid。 */
  id?: string;
}

let schemaReady = false;

/** 只为单测：模块级 ready 短路在用例之间会串味，测之前清一次。 */
export const resetAutonomySchemaCacheForTesting = (): void => {
  schemaReady = false;
};

/**
 * 懒建两张表。任何一句失败都不吞：建不出表的话调度器整个跑不起来，
 * 让它在下一次 cron 重试，别静默当成「没有角色要跑」。
 */
export async function ensureAutonomySchema(db: AutonomyDb): Promise<void> {
  if (schemaReady) return;
  await db.prepare(AUTONOMY_EXPERIENCES_DDL).run();
  await db.prepare(AUTONOMY_EXPERIENCES_INDEX_DDL).run();
  await db.prepare(AUTONOMY_STATE_DDL).run();
  schemaReady = true;
}

const readNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 每角色一行记账；行不在（或字段被老库截断）时回落到零值。 */
export async function getAutonomyState(db: AutonomyDb, charId: string): Promise<AutonomyStateRow> {
  const row = await db
    .prepare('SELECT char_id, last_round_at, last_push_at, fail_streak, rounds_date, rounds_today, tokens_date, tokens_today, config_hash FROM autonomy_state WHERE char_id = ?')
    .bind(charId)
    .first();
  if (!row) return emptyAutonomyState(charId);
  return {
    charId,
    lastRoundAt: readNumber(row.last_round_at),
    lastPushAt: readNumber(row.last_push_at),
    failStreak: readNumber(row.fail_streak),
    roundsDate: readString(row.rounds_date),
    roundsToday: readNumber(row.rounds_today),
    tokensDate: readString(row.tokens_date),
    tokensToday: readNumber(row.tokens_today),
    configHash: readString(row.config_hash),
  };
}

/** 整行 upsert（读-改-写的那一整行，不做字段级补丁，省得两处口径漂移）。 */
export async function setAutonomyState(db: AutonomyDb, state: AutonomyStateRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO autonomy_state
        (char_id, last_round_at, last_push_at, fail_streak, rounds_date, rounds_today, tokens_date, tokens_today, config_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(char_id) DO UPDATE SET
         last_round_at = excluded.last_round_at,
         last_push_at = excluded.last_push_at,
         fail_streak = excluded.fail_streak,
         rounds_date = excluded.rounds_date,
         rounds_today = excluded.rounds_today,
         tokens_date = excluded.tokens_date,
         tokens_today = excluded.tokens_today,
         config_hash = excluded.config_hash`,
    )
    .bind(
      state.charId,
      state.lastRoundAt,
      state.lastPushAt,
      state.failStreak,
      state.roundsDate,
      state.roundsToday,
      state.tokensDate,
      state.tokensToday,
      state.configHash,
    )
    .run();
}

/** 记一条经历（Task 18 的 handler 调用）。 */
export async function addAutonomyExperience(
  db: AutonomyDb,
  entry: AutonomyExperienceInput,
): Promise<string> {
  const id = entry.id ?? crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO autonomy_experiences (id, char_id, created_at, q, note, kind, importance, pushed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      entry.charId,
      entry.createdAt,
      entry.q ?? null,
      entry.note,
      entry.kind,
      entry.importance ?? 0,
      entry.pushed ? 1 : 0,
    )
    .run();
  return id;
}

/** 删掉早于 beforeMs 的经历，返回删了几条。 */
export async function cleanupAutonomyExperiences(db: AutonomyDb, beforeMs: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM autonomy_experiences WHERE created_at < ?')
    .bind(beforeMs)
    .run();
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes) ? changes : 0;
}
