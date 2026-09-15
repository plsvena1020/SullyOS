import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  decryptPayload,
  deriveUserEncryptionKey,
  encryptForStorage,
} from '@rei-standard/amsg-server/cloudflare';
import { FIRE_PACK_VERSION, type AmsgFirePack } from '../../../utils/amsgFirePack';
import { AUTONOMOUS_ROUND_KIND, type ResolvedAirpAutonomy } from '../../../utils/airp/autonomySettings';
import { FIRE_KIND_HANDLERS } from './fireKinds';
import {
  AUTONOMY_FAIL_LIMIT,
  AUTONOMY_SKIP_REASONS,
  autonomyDateKey,
  autonomyConfigHash,
  buildAutonomyScheduleRequest,
  createAutonomyPostTask,
  encryptPayloadMirror,
  reportAutonomyOutcome,
  runAutonomyTick,
  scanAutonomyPacks,
  type AutonomyTickPack,
} from './autonomyScheduler';
import {
  emptyAutonomyState,
  type AutonomyStateRow,
} from './autonomyStore';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CHAR_ID = 'char-lumen';
const CHAR_NAME = '陆铭';
const MASTER = 'a'.repeat(64);
/** 2026-07-25 20:00 Asia/Shanghai（无夏令时，UTC+8）。 */
const NOW = Date.parse('2026-07-25T12:00:00.000Z');

const baseAutonomy = (overrides: Partial<ResolvedAirpAutonomy> = {}): ResolvedAirpAutonomy => ({
  enabled: true,
  cadence: { minHours: 1, maxHours: 1 },
  maxRoundsPerDay: 3,
  interests: [],
  avoidTopics: [],
  retell: { style: 'plain', maxItems: 5, maxChars: 800, opener: false },
  push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 0 },
  dailyTokenBudget: 100_000,
  autonomyLevel: 2,
  mcpAllow: [],
  writable: false,
  ...overrides,
});

const packFor = (autonomy: ResolvedAirpAutonomy | undefined): AmsgFirePack => ({
  v: FIRE_PACK_VERSION,
  template: '模板 {{AMSG_CURRENT_TIME}}',
  lastUserMessageAt: null,
  tzId: 'Asia/Shanghai',
  userTzId: 'Asia/Shanghai',
  targetName: '小明',
  builtAt: 0,
  pendingTasks: [],
  scene: null,
  selfScheduleEnabled: true,
  ...(autonomy ? { autonomy } : {}),
});

const toSnake = (state: AutonomyStateRow | undefined): Record<string, unknown> | null =>
  state
    ? {
        char_id: state.charId,
        last_round_at: state.lastRoundAt,
        last_push_at: state.lastPushAt,
        fail_streak: state.failStreak,
        rounds_date: state.roundsDate,
        rounds_today: state.roundsToday,
        tokens_date: state.tokensDate,
        tokens_today: state.tokensToday,
        config_hash: state.configHash,
      }
    : null;

/**
 * 记录型 D1 替身：autonomy_state 走一份真的内存表（读-改-写、claim 之后能查），
 * 其余语句只记下来供断言。经历表和 DDL 的细节由 autonomyStore.test.ts 管。
 */
const createStateDb = (initial: AutonomyStateRow[] = []) => {
  const states = new Map<string, AutonomyStateRow>(initial.map((state) => [state.charId, state]));
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._args = args;
          return stmt;
        },
        async run() {
          statements.push({ sql, args: stmt._args });
          if (sql.includes('INSERT INTO autonomy_state')) {
            const a = stmt._args;
            states.set(String(a[0]), {
              charId: String(a[0]),
              lastRoundAt: Number(a[1]),
              lastPushAt: Number(a[2]),
              failStreak: Number(a[3]),
              roundsDate: String(a[4]),
              roundsToday: Number(a[5]),
              tokensDate: String(a[6]),
              tokensToday: Number(a[7]),
              configHash: String(a[8]),
            });
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first() {
          statements.push({ sql, args: stmt._args });
          if (sql.includes('FROM autonomy_state')) return toSnake(states.get(String(stmt._args[0])));
          return null;
        },
        async all() {
          statements.push({ sql, args: stmt._args });
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  return { db, states, statements };
};

const tick = (
  db: ReturnType<typeof createStateDb>['db'],
  packs: AutonomyTickPack[],
  options: { nowMs?: number; rand01?: () => number; postTask?: (args: unknown) => Promise<unknown> } = {},
) =>
  runAutonomyTick({
    nowMs: options.nowMs ?? NOW,
    rand01: options.rand01 ?? (() => 0),
    db,
    packs,
    postTask: options.postTask ?? (async () => ({ status: 200 })),
  });

const tickPack = (autonomy: ResolvedAirpAutonomy | undefined): AutonomyTickPack[] => [
  { userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack: packFor(autonomy) },
];

describe('自动化轮次 —— 闸的判定', () => {
  it('没开自主 / 档位为 0 → autonomy-disabled', async () => {
    const { db } = createStateDb();
    const off = await tick(db, tickPack(baseAutonomy({ enabled: false })));
    expect(off.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.disabled }]);
    expect(off.built).toEqual([]);

    const { db: db2 } = createStateDb();
    const zero = await tick(db2, tickPack(baseAutonomy({ autonomyLevel: 0 })));
    expect(zero.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.disabled);

    const { db: db3 } = createStateDb();
    const absent = await tick(db3, [{ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack: packFor(undefined) }]);
    expect(absent.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.disabled);
  });

  it('cadence 不合法 → cadence-invalid（minHours>0 且 min<=max）', async () => {
    const { db } = createStateDb();
    const zero = await tick(db, tickPack(baseAutonomy({ cadence: { minHours: 0, maxHours: 4 } })));
    expect(zero.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.cadenceInvalid);

    const { db: db2 } = createStateDb();
    const inverted = await tick(db2, tickPack(baseAutonomy({ cadence: { minHours: 3, maxHours: 2 } })));
    expect(inverted.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.cadenceInvalid);
  });

  it('窗口没到 → spacing-window；到窗则建任务', async () => {
    const fresh = createStateDb();
    const first = await tick(fresh.db, tickPack(baseAutonomy()));
    expect(first.built).toEqual([CHAR_ID]);

    const { db } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastRoundAt: NOW - 30 * 60_000 }]);
    const due = await tick(db, tickPack(baseAutonomy()));
    expect(due.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.spacingWindow }]);

    const { db: db2 } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastRoundAt: NOW - 2 * 60 * 60_000 }]);
    expect((await tick(db2, tickPack(baseAutonomy()))).built).toEqual([CHAR_ID]);
  });

  it('用户刚说过话 → spacing-window（间隔的第二半句）', async () => {
    const pack = { ...packFor(baseAutonomy()), lastUserMessageAt: NOW - 60_000 };
    const { db } = createStateDb();
    const result = await tick(db, [{ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack }]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.spacingWindow }]);
  });

  it('窗口按 cadence 采样（每个角色只消费一次随机数）', async () => {
    const spent: number[] = [];
    const rand01 = () => { spent.push(1); return 0.5; };
    const { db } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastRoundAt: NOW - 2 * 60 * 60_000 }]);
    const result = await tick(db, tickPack(baseAutonomy({ cadence: { minHours: 1, maxHours: 3 } })), { rand01 });
    // 窗口 = 1h + 0.5 * 2h = 2h，NOW-2h 不满足 ">" → 跳过
    expect(result.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.spacingWindow);
    expect(spent).toHaveLength(1);
  });

  it('非法时区 → tz-invalid（不猜一个钟）', async () => {
    const pack = { ...packFor(baseAutonomy()), tzId: 'Not/AZone' };
    const { db } = createStateDb();
    const result = await tick(db, [{ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack }]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.tzInvalid }]);
  });

  it('静默段（含跨夜）', async () => {
    const overnight = baseAutonomy({ quietHours: { start: '23:00', end: '06:00' } });
    // 上海 00:30 → 落在跨夜段里
    const inside = createStateDb();
    const at0030 = await tick(inside.db, tickPack(overnight), { nowMs: Date.parse('2026-07-25T16:30:00.000Z') });
    expect(at0030.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.quietHours);
    // 上海 20:00 → 不在跨夜段里
    const outside = createStateDb();
    expect((await tick(outside.db, tickPack(overnight))).built).toEqual([CHAR_ID]);

    const midday = baseAutonomy({ quietHours: { start: '12:00', end: '13:00' } });
    // 上海 12:30 → 在段内（非跨夜）
    const { db } = createStateDb();
    const noon = await tick(db, tickPack(midday), { nowMs: Date.parse('2026-07-25T04:30:00.000Z') });
    expect(noon.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.quietHours);
    // 上海 13:00（段尾，左闭右开）→ 放行
    const { db: db2 } = createStateDb();
    expect((await tick(db2, tickPack(midday), { nowMs: Date.parse('2026-07-25T05:00:00.000Z') })).built).toEqual([CHAR_ID]);
  });

  it('当日轮数上限 + 角色时区翻日', async () => {
    const today = await autonomyDateKey(NOW, 'Asia/Shanghai');
    expect(today).toBe('2026-07-25');

    const { db } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), roundsDate: today, roundsToday: 3 },
    ]);
    const capped = await tick(db, tickPack(baseAutonomy({ maxRoundsPerDay: 3 })));
    expect(capped.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.dailyLimit);

    const { db: db2, states } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), roundsDate: '2026-07-24', roundsToday: 3 },
    ]);
    const rolled = await tick(db2, tickPack(baseAutonomy({ maxRoundsPerDay: 3 })));
    expect(rolled.built).toEqual([CHAR_ID]);
    expect(states.get(CHAR_ID)).toMatchObject({ roundsDate: today, roundsToday: 1 });
  });

  it('推送冷却（0 / 未推过都放行）', async () => {
    const { db } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastPushAt: NOW - 10 * 60_000 }]);
    const cooled = await tick(db, tickPack(baseAutonomy({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 60 } })));
    expect(cooled.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.pushCooldown);

    const { db: db2 } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastPushAt: 0 }]);
    expect((await tick(db2, tickPack(baseAutonomy({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 60 } })))).built)
      .toEqual([CHAR_ID]);

    const { db: db3 } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), lastPushAt: NOW - 1 }]);
    expect((await tick(db3, tickPack(baseAutonomy({ push: { mode: 'big', maxPerDay: 1, cooldownMinutes: 0 } })))).built)
      .toEqual([CHAR_ID]);
  });

  it('token 预算（同翻日口径）', async () => {
    const today = await autonomyDateKey(NOW, 'Asia/Shanghai');
    const { db } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), tokensDate: today, tokensToday: 1000 },
    ]);
    const broke = await tick(db, tickPack(baseAutonomy({ dailyTokenBudget: 1000 })));
    expect(broke.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.tokenBudget);

    const { db: db2 } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), tokensDate: '2026-07-24', tokensToday: 1000 },
    ]);
    expect((await tick(db2, tickPack(baseAutonomy({ dailyTokenBudget: 1000 })))).built).toEqual([CHAR_ID]);
  });

  it('连续失败到上限 → fail-muted', async () => {
    const autonomy = baseAutonomy();
    const { db } = createStateDb([{
      ...emptyAutonomyState(CHAR_ID),
      failStreak: AUTONOMY_FAIL_LIMIT,
      configHash: autonomyConfigHash(autonomy),
    }]);
    const muted = await tick(db, tickPack(autonomy));
    expect(muted.skipped[0].reason).toBe(AUTONOMY_SKIP_REASONS.failMuted);
  });

  it('configHash 变了 → 清熔断并把新口径记下来', async () => {
    const autonomy = baseAutonomy();
    const { db, states } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), failStreak: 2, configHash: 'stale' },
    ]);
    await tick(db, tickPack(autonomy));
    const after = states.get(CHAR_ID)!;
    expect(after.failStreak).toBe(0);
    expect(after.configHash).toBe(autonomyConfigHash(autonomy));
  });

  it('claim-first：postTask 抛错也不回滚，账已经扣掉', async () => {
    const { db, states } = createStateDb();
    const calls: unknown[] = [];
    const result = await tick(db, tickPack(baseAutonomy()), {
      postTask: async (args) => {
        calls.push(args);
        throw new Error('schedule-message 拒绝（HTTP 500）');
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.built).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: AUTONOMY_SKIP_REASONS.postFailed }]);
    expect(states.get(CHAR_ID)).toMatchObject({ lastRoundAt: NOW, roundsToday: 1 });
  });

  it('每跳清一遍 7 天前的经历', async () => {
    const { db, statements } = createStateDb();
    await tick(db, tickPack(baseAutonomy()));
    const cleanup = statements.find((s) => s.sql.includes('DELETE FROM autonomy_experiences'));
    expect(cleanup?.args).toEqual([NOW - 7 * 24 * 60 * 60 * 1000]);
  });
});

describe('reportAutonomyOutcome', () => {
  it('skipped 不动账', async () => {
    const { db, states } = createStateDb([{ ...emptyAutonomyState(CHAR_ID), failStreak: 1 }]);
    await reportAutonomyOutcome(CHAR_ID, { ok: false, skipped: true }, { db, dateKey: '2026-07-25' });
    expect(states.get(CHAR_ID)!.failStreak).toBe(1);
  });

  it('ok 清熔断 + 记 token 与推送时间；fail 累加并翻日', async () => {
    const today = '2026-07-25';
    const { db, states } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), failStreak: 2, tokensDate: today, tokensToday: 100 },
    ]);
    await reportAutonomyOutcome(
      CHAR_ID,
      { ok: true, tokens: 500, pushed: true },
      { db, dateKey: today, nowMs: NOW },
    );
    expect(states.get(CHAR_ID)).toMatchObject({
      failStreak: 0, tokensToday: 600, lastPushAt: NOW, tokensDate: today,
    });

    const { db: db2, states: states2 } = createStateDb([
      { ...emptyAutonomyState(CHAR_ID), failStreak: 1, tokensDate: '2026-07-24', tokensToday: 100 },
    ]);
    await reportAutonomyOutcome(CHAR_ID, { ok: false }, { db: db2, dateKey: today });
    expect(states2.get(CHAR_ID)).toMatchObject({ failStreak: 2, tokensToday: 0, tokensDate: today });
  });
});

describe('scanAutonomyPacks', () => {
  const scanDb = (rows: Array<Record<string, unknown>>) => ({
    prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
  });

  const encrypted = async (userId: string, value: unknown) =>
    encryptForStorage(JSON.stringify(value), await deriveUserEncryptionKey(userId, MASTER));

  it('解出 fire_pack，并从同命名空间的 tool_pack 取 charName', async () => {
    const pack = packFor(baseAutonomy());
    const db = scanDb([
      {
        user_id: USER_ID,
        namespace: `amsg:char:${CHAR_ID}`,
        key: 'fire_pack',
        value: await encrypted(USER_ID, pack),
      },
      {
        user_id: USER_ID,
        namespace: `amsg:char:${CHAR_ID}`,
        key: 'tool_pack',
        value: await encrypted(USER_ID, {
          v: 1,
          charName: CHAR_NAME,
          xhsEnabled: false,
          activeMemoryMonths: [],
          memories: [],
          timeAwarenessEnabled: true,
        }),
      },
      {
        user_id: USER_ID,
        namespace: 'amsg:job',
        key: 'plate:1',
        value: await encrypted(USER_ID, { hello: 1 }),
      },
    ]);

    const result = await scanAutonomyPacks({ db: db as never, masterKey: MASTER });
    expect(result.skipped).toEqual([]);
    expect(result.packs).toHaveLength(1);
    expect(result.packs[0]).toMatchObject({ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME });
    expect(result.packs[0].pack.v).toBe(FIRE_PACK_VERSION);
  });

  it('读不出来的行记 pack-unreadable 并跳过（不拖垮整轮）', async () => {
    const db = scanDb([
      { user_id: USER_ID, namespace: `amsg:char:${CHAR_ID}`, key: 'fire_pack', value: 'not-encrypted' },
    ]);
    const result = await scanAutonomyPacks({ db: db as never, masterKey: MASTER });
    expect(result.packs).toEqual([]);
    expect(result.skipped).toEqual([{ charId: CHAR_ID, reason: 'pack-unreadable' }]);
  });
});

describe('自转发的载荷与加密', () => {
  it('加密镜像是 12B iv + 16B tag 的 base64 信封，且能被上游 decryptPayload 解开', async () => {
    const key = await deriveUserEncryptionKey(USER_ID, MASTER);
    const probe = { 你好: '世界', n: 1, nested: { ok: true } };
    const envelope = await encryptPayloadMirror(probe, key);

    expect(Object.keys(envelope).sort()).toEqual(['authTag', 'encryptedData', 'iv']);
    for (const part of [envelope.iv, envelope.authTag, envelope.encryptedData]) {
      expect(part).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    }
    expect(atob(envelope.iv)).toHaveLength(12);
    expect(atob(envelope.authTag)).toHaveLength(16);

    expect(await decryptPayload(envelope, key)).toEqual(probe);
  });

  it('组出来的 /schedule-message 请求符合上游校验口径', async () => {
    const request = await buildAutonomyScheduleRequest({
      userId: USER_ID,
      charId: CHAR_ID,
      charName: CHAR_NAME,
      masterKey: MASTER,
      clientToken: 'shared-secret',
    });

    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname.endsWith('/schedule-message')).toBe(true);
    expect(request.headers.get('X-User-Id')).toBe(USER_ID);
    expect(request.headers.get('X-Payload-Encrypted')).toBe('true');
    expect(request.headers.get('X-Encryption-Version')).toBe('1');
    expect(request.headers.get('X-Client-Token')).toBe('shared-secret');

    const envelope = await request.json() as { iv: string; authTag: string; encryptedData: string };
    const payload = await decryptPayload(envelope, await deriveUserEncryptionKey(USER_ID, MASTER)) as Record<string, any>;
    expect(payload.contactName).toBe(CHAR_NAME);
    expect(payload.messageType).toBe('auto');
    expect(payload.messageSubtype).toBe('job');
    expect(payload.immediate).toBe(true);
    expect(payload.recurrenceType).toBe('none');
    expect(payload.metadata).toMatchObject({
      charId: CHAR_ID,
      charName: CHAR_NAME,
      source: 'active_msg_2',
      amsgKind: AUTONOMOUS_ROUND_KIND,
    });
    expect(typeof payload.metadata.amsgJobId).toBe('string');
    expect(payload.credRefs).toEqual({ chat: `char:${CHAR_ID}/chat` });
    expect(payload.messages).toHaveLength(1);
  });

  it('没配口令不带 X-Client-Token；charName 缺失时回落到 charId', async () => {
    const request = await buildAutonomyScheduleRequest({
      userId: USER_ID, charId: CHAR_ID, charName: '', masterKey: MASTER,
    });
    expect(request.headers.get('X-Client-Token')).toBeNull();
    const payload = await decryptPayload(
      await request.json() as { iv: string; authTag: string; encryptedData: string },
      await deriveUserEncryptionKey(USER_ID, MASTER),
    ) as Record<string, any>;
    expect(payload.contactName).toBe(CHAR_ID);
  });

  it('createAutonomyPostTask：非 2xx 抛错，2xx 回状态码', async () => {
    const ok = createAutonomyPostTask({ forward: async () => new Response('{}', { status: 200 }), masterKey: MASTER });
    expect(await ok({ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack: packFor(baseAutonomy()) }))
      .toEqual({ status: 200 });

    const bad = createAutonomyPostTask({ forward: async () => new Response('{}', { status: 500 }), masterKey: MASTER });
    await expect(bad({ userId: USER_ID, charId: CHAR_ID, charName: CHAR_NAME, pack: packFor(baseAutonomy()) }))
      .rejects.toThrow(/HTTP 500/);
  });
});

describe('接线', () => {
  it('注册表里有 autonomous_round，且 stub 零 LLM 零副作用（skip-plan）', async () => {
    const handler = FIRE_KIND_HANDLERS[AUTONOMOUS_ROUND_KIND];
    expect(handler).toBeTruthy();

    const plan = await handler.beforeFire({
      ctx: { task: {}, readState: async () => [], now: new Date(NOW), scratch: {} },
      charId: CHAR_ID,
      taskMeta: {},
    });
    expect(plan).toEqual({ skip: true, reason: 'handler-pending-task-18' });

    const decision = await handler.llmOutput({ ctx: { llmOutputText: '' }, state: null });
    expect(decision).toEqual({ decision: 'skip-push', reason: 'handler-pending-task-18' });
  });

  it('cron 的 scheduled() 里调了 runAutonomyTick', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf-8');
    const start = source.indexOf('async scheduled(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 2000);
    expect(body).toContain('runAutonomyTick');
    expect(body).toContain('scanAutonomyPacks');
    expect(body).toContain('createAutonomyPostTask');
  });
});
