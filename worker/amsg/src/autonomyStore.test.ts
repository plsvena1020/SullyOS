import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTONOMY_EXPERIENCE_TTL_MS,
  addAutonomyExperience,
  claimAutonomyTick,
  cleanupAutonomyExperiences,
  emptyAutonomyState,
  ensureAutonomySchema,
  getAutonomyState,
  resetAutonomySchemaCacheForTesting,
  setAutonomyState,
} from './autonomyStore';

interface Recorded {
  sql: string;
  args: unknown[];
}

/**
 * 极简 D1 替身（照 index.test.ts:4548 那类手搓 fake 的做法）：记录每一句 SQL 与绑定参数，
 * first/all 按预设的序列作答。DSL 只有本模块真正用到的那几句。
 */
const createFakeDb = (options: {
  firstRows?: Array<Record<string, unknown> | null>;
  changes?: number[];
} = {}) => {
  const statements: Recorded[] = [];
  let firstIndex = 0;
  let runIndex = 0;
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
          const changes = options.changes?.[runIndex];
          runIndex += 1;
          return { success: true, meta: { changes: changes ?? 0 } };
        },
        async first() {
          statements.push({ sql, args: stmt._args });
          const row = options.firstRows?.[firstIndex] ?? null;
          firstIndex += 1;
          return row;
        },
        async all() {
          statements.push({ sql, args: stmt._args });
          return { results: [] };
        },
      };
      return stmt;
    },
  };
  return { db, statements };
};

beforeEach(() => {
  resetAutonomySchemaCacheForTesting();
});

describe('ensureAutonomySchema', () => {
  it('建经历表 + 索引 + 记账表 + tick 认领表', async () => {
    const { db, statements } = createFakeDb();
    await ensureAutonomySchema(db);

    expect(statements).toHaveLength(5);
    expect(statements[0].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_experiences');
    expect(statements[0].sql).toContain('char_id TEXT NOT NULL');
    expect(statements[0].sql).toContain('importance INTEGER NOT NULL DEFAULT 0');
    expect(statements[1].sql).toContain('CREATE INDEX IF NOT EXISTS idx_autonomy_experiences_char_created');
    expect(statements[2].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_state');
    for (const column of [
      'last_round_at', 'last_push_at', 'fail_streak', 'rounds_date',
      'rounds_today', 'tokens_date', 'tokens_today', 'config_hash',
    ]) {
      expect(statements[2].sql).toContain(column);
    }
    expect(statements[3].sql).toContain('CREATE TABLE IF NOT EXISTS autonomy_tick');
    expect(statements[3].sql).toContain('id INTEGER PRIMARY KEY CHECK (id = 1)');
    expect(statements[3].sql).toContain('minute INTEGER NOT NULL DEFAULT 0');
    expect(statements[4].sql).toBe('INSERT OR IGNORE INTO autonomy_tick (id, minute) VALUES (1, 0)');
  });

  it('第二次调用走模块级短路，不再打 DDL', async () => {
    const { db, statements } = createFakeDb();
    await ensureAutonomySchema(db);
    statements.length = 0;
    await ensureAutonomySchema(db);
    expect(statements).toEqual([]);
  });
});

describe('claimAutonomyTick', () => {
  it('同一分钟第二次认领 → false；下一分钟 → true', async () => {
    const { db, statements } = createFakeDb();
    const minute = 29_700_000;

    // 只有第一句 UPDATE 真的改了行（changes=1），第二句同分钟 changes=0。
    const { db: dbSeq, statements: seqStatements } = createFakeDb({ changes: [1, 0, 1] });
    expect(await claimAutonomyTick(dbSeq, minute)).toBe(true);
    expect(await claimAutonomyTick(dbSeq, minute)).toBe(false);
    expect(await claimAutonomyTick(dbSeq, minute + 1)).toBe(true);

    expect(seqStatements).toHaveLength(3);
    for (const s of seqStatements) {
      expect(s.sql).toBe('UPDATE autonomy_tick SET minute = ? WHERE id = 1 AND minute < ?');
      expect(s.args).toHaveLength(2);
    }
    expect(seqStatements[0].args).toEqual([minute, minute]);
    expect(seqStatements[2].args).toEqual([minute + 1, minute + 1]);

    // 没有 meta.changes 的形态按「没抢到」处理（宁可少跑一跳，不冒双跑风险）。
    expect(await claimAutonomyTick(db, minute)).toBe(false);
    expect(statements).toHaveLength(1);
  });
});

describe('getAutonomyState', () => {
  it('行不在 → 零值', async () => {
    const { db } = createFakeDb({ firstRows: [null] });
    expect(await getAutonomyState(db, 'c1')).toEqual(emptyAutonomyState('c1'));
  });

  it('行在 → 映射成驼峰（缺字段/类型不对回零）', async () => {
    const { db } = createFakeDb({
      firstRows: [{
        char_id: 'c1',
        last_round_at: 1000,
        last_push_at: 900,
        fail_streak: 2,
        rounds_date: '2026-07-25',
        rounds_today: 1,
        tokens_date: '2026-07-25',
        tokens_today: 1234,
        config_hash: 'abc',
      }],
    });
    expect(await getAutonomyState(db, 'c1')).toEqual({
      charId: 'c1',
      lastRoundAt: 1000,
      lastPushAt: 900,
      failStreak: 2,
      roundsDate: '2026-07-25',
      roundsToday: 1,
      tokensDate: '2026-07-25',
      tokensToday: 1234,
      configHash: 'abc',
    });
  });
});

describe('setAutonomyState', () => {
  it('整行 upsert（ON CONFLICT char_id）', async () => {
    const { db, statements } = createFakeDb();
    await setAutonomyState(db, { ...emptyAutonomyState('c1'), lastRoundAt: 42, roundsToday: 2 });
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('INSERT INTO autonomy_state');
    expect(statements[0].sql).toContain('ON CONFLICT(char_id) DO UPDATE SET');
    expect(statements[0].args).toEqual(['c1', 42, 0, 0, '', 2, '', 0, '']);
  });
});

describe('addAutonomyExperience', () => {
  it('插入一行并回 id（不传 id 时自动生成）', async () => {
    const { db, statements } = createFakeDb();
    const id = await addAutonomyExperience(db, {
      charId: 'c1',
      createdAt: 1000,
      q: '在吗',
      note: '读到一条关于潮汐的笔记',
      kind: 'note',
      importance: 3,
      pushed: true,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statements[0].sql).toContain('INSERT INTO autonomy_experiences');
    expect(statements[0].args).toEqual([id, 'c1', 1000, '在吗', '读到一条关于潮汐的笔记', 'note', 3, 1]);
  });

  it('省略 q / importance / pushed 时落 null / 0 / 0', async () => {
    const { db, statements } = createFakeDb();
    await addAutonomyExperience(db, { id: 'fixed', charId: 'c1', createdAt: 1, note: 'n', kind: 'k' });
    expect(statements[0].args).toEqual(['fixed', 'c1', 1, null, 'n', 'k', 0, 0]);
  });
});

describe('cleanupAutonomyExperiences', () => {
  it('按截止时刻删并回条数', async () => {
    const { db, statements } = createFakeDb({ changes: [4] });
    const removed = await cleanupAutonomyExperiences(db, 777);
    expect(statements[0].sql).toBe('DELETE FROM autonomy_experiences WHERE created_at < ?');
    expect(statements[0].args).toEqual([777]);
    expect(removed).toBe(4);
  });

  it('没有 meta.changes 时回 0（d1 / better-sqlite3 形态差异）', async () => {
    const { db } = createFakeDb();
    expect(await cleanupAutonomyExperiences(db, 1)).toBe(0);
  });
});

describe('保留期常量', () => {
  it('7 天', () => {
    expect(AUTONOMY_EXPERIENCE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
