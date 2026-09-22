# 预设条目重复修复 · 执行计划

- 日期：2026-09-13
- 对应 spec：`docs/superpowers/specs/2026-09-13-prompt-preset-reconcile-design.md`
- 执行顺序：按步骤编号顺序做，每步有验收判据；全部完成后跑总验收。
- 通用约定：只碰下列文件；不升级 IndexedDB 版本、不加 store 索引、不改备份格式；所有新代码注释用中文、字符串与既有风格一致。

## 触碰文件清单（供协调其他窗口）

| 文件 | 动作 |
|---|---|
| `utils/promptPresetCatalog.ts` | 136 行展示名改名 |
| `utils/db.ts` | `deletePromptPreset` 之后新增 `reconcilePromptPresets` |
| `utils/promptPresetSeeding.ts` | 重写 `seedBuiltinPromptPresets`、新增 `repairCorruptedBuiltinNames` |
| `utils/promptPresetSeeding.test.ts` | 新建回归测试 |
| `docs/superpowers/specs/2026-09-13-prompt-preset-reconcile-design.md` | 本 spec（已完成） |
| `docs/superpowers/plans/2026-09-13-prompt-preset-reconcile-plan.md` | 本计划（已完成） |

不改 `context/OSContext.tsx`、`apps/PresetApp.tsx`、`utils/promptPresetRuntime.ts`。

## 步骤 1：修正目录错名（utils/promptPresetCatalog.ts:136）

把：

```ts
        name: "记忆消化 · 认知风风风风判定",
```

改为：

```ts
        name: "记忆消化 · 认知风格判定",
```

判据：文件里不再出现 `风风风风`；后续 `pnpm vitest run utils/promptPresetCatalog.test.ts` 仍绿（快照测试只对内容不对名字）。

## 步骤 2：db.ts 新增原子对账方法

位置：`utils/db.ts` 的 `deletePromptPreset`（当前 4079-4087 行）之后、DB 对象结束的 `};`（4088 行）之前，插入：

```ts
  /**
   * 提示词预设的原子对账入口（播种 + 历史去重一站式）。
   *
   * 单个 readwrite 事务内读全表 → 按 sourceKey 合并重复组 → 补写缺失 seed。
   * IndexedDB 对同一 store 的 readwrite 事务跨连接串行化，并发调用不会双写，
   * 从根上杜绝「StrictMode 双跑 / 双标签页同时播种」产生的重复行。
   *
   * - 只处理 builtinByKey 里登记过的 sourceKey；无锚点或未登记的旧自定义行不动。
   * - keeper：内容或名字与目录默认不同视为用户动过，取 updatedAt 最新；都没动取
   *   createdAt 最早；平局取 id 字典序小者。enabled 只要组内有停用即取 false。
   */
  reconcilePromptPresets: async (
      seeds: PromptPreset[],
      builtinByKey: Record<string, { name: string; content: string }>,
  ): Promise<{ seeded: number; removed: number }> => {
      const db = await openDB();
      return new Promise<{ seeded: number; removed: number }>((resolve, reject) => {
          const tx = db.transaction(STORE_PROMPT_PRESETS, 'readwrite');
          const store = tx.objectStore(STORE_PROMPT_PRESETS);
          let seeded = 0;
          let removed = 0;
          const req = store.getAll();
          req.onsuccess = () => {
              const rows: PromptPreset[] = req.result || [];
              const groups = new Map<string, PromptPreset[]>();
              for (const row of rows) {
                  if (!row.sourceKey || !(row.sourceKey in builtinByKey)) continue;
                  const list = groups.get(row.sourceKey);
                  if (list) list.push(row);
                  else groups.set(row.sourceKey, [row]);
              }
              for (const [sourceKey, list] of groups) {
                  if (list.length <= 1) continue;
                  const builtin = builtinByKey[sourceKey];
                  const edited = list.filter(
                      (r) => (r.content ?? '') !== builtin.content || (r.name ?? '') !== builtin.name,
                  );
                  const pool = edited.length > 0 ? edited : list;
                  const keeper = pool.slice().sort((a, b) => {
                      if (edited.length > 0) {
                          const dt = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
                          if (dt !== 0) return dt;
                      } else {
                          const dt = (a.createdAt ?? 0) - (b.createdAt ?? 0);
                          if (dt !== 0) return dt;
                      }
                      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
                  })[0];
                  const anyDisabled = list.some((r) => !r.enabled);
                  for (const r of list) {
                      if (r.id === keeper.id) continue;
                      store.delete(r.id);
                      removed++;
                  }
                  if (anyDisabled && keeper.enabled) {
                      store.put({ ...keeper, enabled: false });
                  }
              }
              const present = new Set(groups.keys());
              for (const seed of seeds) {
                  if (seed.sourceKey && present.has(seed.sourceKey)) continue;
                  store.put(seed);
                  if (seed.sourceKey) present.add(seed.sourceKey);
                  seeded++;
              }
          };
          tx.oncomplete = () => resolve({ seeded, removed });
          tx.onerror = () => reject(tx.error || new Error('reconcilePromptPresets failed'));
          tx.onabort = () => reject(tx.error || new Error('reconcilePromptPresets aborted'));
      });
  },
```

实现要点（执行时不要丢）：

- `getAll` 的 `onsuccess` 里同步发出全部 `delete/put` 请求，事务在请求存活期间不会自动提交。
- 合并**只**针对 `builtinByKey` 登记的 sourceKey；`present` 集合同时用于「补缺」，`put` 后要同步加入，防 seed 键重复时双写。
- 失败路径同时挂 `tx.onerror` 与 `tx.onabort`，`tx.error` 可能为 null，要兜底 `new Error(...)`。

判据：`npx tsc --noEmit` 不在这份文件上新增错误。

## 步骤 3：重写 seeding（utils/promptPresetSeeding.ts）

用下面内容替换 `seedBuiltinPromptPresets`（当前 1-46 行）并在其后追加修复函数（`migrateLegacyVoiceOverrides` 保持原样保留）：

```ts
/**
 * 内置提示词条目的一次性播种（首次加载 / 版本升级补缺）。
 *
 * 规则：prompt_presets 里缺哪个 sourceKey 就补哪条——已存在的行**永不覆盖**，
 * 用户对内容的编辑、启停、排序都原样保留。落库走 DB.reconcilePromptPresets 的
 * 单事务对账：并发播种不会产生重复行，历史竞态重复行会在同一事务里合并。
 * OSContext 启动时调用，跑一次成本是一次写事务，之后秒回。
 */
import { DB } from './db';
import { BUILTIN_PROMPT_ENTRIES } from './promptPresetCatalog';
import { invalidatePromptPresetCache } from './promptPresetRuntime';
import type { PromptPreset } from '../types';

/** 已知被 9fa253b7 手滑改坏的展示名（sourceKey → 错名原文）；修复值取目录当前 name。 */
const CORRUPTED_BUILTIN_NAMES: Record<string, string[]> = {
    'memory.personalityDetect': ['记忆消化 · 认知风风风风判定'],
};

export const seedBuiltinPromptPresets = async (): Promise<void> => {
    try {
        const now = Date.now();
        const seeds: PromptPreset[] = BUILTIN_PROMPT_ENTRIES.map((entry) => ({
            id: crypto.randomUUID(),
            sourceKey: entry.sourceKey,
            category: entry.category,
            name: entry.name,
            content: entry.content,
            order: entry.order,
            enabled: true,
            builtinVersion: entry.builtinVersion,
            createdAt: now,
            updatedAt: now,
        }));
        const builtinByKey: Record<string, { name: string; content: string }> = {};
        for (const entry of BUILTIN_PROMPT_ENTRIES) {
            builtinByKey[entry.sourceKey] = { name: entry.name, content: entry.content };
        }
        const { seeded, removed } = await DB.reconcilePromptPresets(seeds, builtinByKey);
        if (seeded > 0) console.log(`[PresetPrompt] seeded ${seeded} builtin prompt entries`);
        if (removed > 0) console.log(`[PresetPrompt] merged ${removed} duplicate prompt rows`);
        await repairCorruptedBuiltinNames();
        if (seeded > 0 || removed > 0) invalidatePromptPresetCache();
    } catch (e) {
        console.warn('[PresetPrompt] seeding builtin entries failed:', e);
    }
};

/**
 * 一次性修复：把历史播种行上被改坏的展示名还原成目录当前 name。
 * 只精确匹配已知错名（避免覆盖用户自己起的名字），只动 name，内容/启停/排序/版本不动。
 * 幂等；导入的备份里带回来的错名行也会在下次启动时被修好。
 */
export const repairCorruptedBuiltinNames = async (): Promise<void> => {
    try {
        const rows = await DB.getPromptPresets();
        const now = Date.now();
        let fixed = 0;
        for (const row of rows || []) {
            const badNames = row.sourceKey ? CORRUPTED_BUILTIN_NAMES[row.sourceKey] : undefined;
            if (!badNames || !badNames.includes(row.name)) continue;
            const builtin = BUILTIN_PROMPT_ENTRIES.find((e) => e.sourceKey === row.sourceKey);
            if (!builtin || row.name === builtin.name) continue;
            await DB.savePromptPreset({ ...row, name: builtin.name, updatedAt: now });
            fixed++;
        }
        if (fixed > 0) {
            invalidatePromptPresetCache();
            console.log(`[PresetPrompt] repaired ${fixed} corrupted builtin name(s)`);
        }
    } catch (e) {
        console.warn('[PresetPrompt] corrupted builtin name repair skipped:', e);
    }
};
```

判据：原文件顶部 1-7 行的模块文档注释合并进新注释（不要留两段重复说明）；`migrateLegacyVoiceOverrides` 一字不动。

## 步骤 4：新建 utils/promptPresetSeeding.test.ts

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from './db';
import { seedBuiltinPromptPresets, repairCorruptedBuiltinNames } from './promptPresetSeeding';
import { BUILTIN_PROMPT_ENTRIES, getBuiltinEntry } from './promptPresetCatalog';
import type { PromptPreset } from '../types';

const STEEL_KEY = 'chat.steelExpression';
const TYPO_NAME = '记忆消化 · 认知风风风风判定';

const makeRow = (
    overrides: Partial<PromptPreset> & Pick<PromptPreset, 'id' | 'name' | 'content' | 'order'>,
): PromptPreset => ({
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
});

describe('提示词播种对账（并发去重 / 历史合并 / 错名修复）', () => {
    beforeEach(async () => {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('prompt_presets', 'readwrite');
            tx.objectStore('prompt_presets').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    });

    it('并发播种不会产生重复行：每个 sourceKey 恰好一行', async () => {
        await Promise.all([seedBuiltinPromptPresets(), seedBuiltinPromptPresets(), seedBuiltinPromptPresets()]);
        const rows = await DB.getPromptPresets();
        expect(rows).toHaveLength(BUILTIN_PROMPT_ENTRIES.length);
        const keys = rows.map((r) => r.sourceKey);
        expect(new Set(keys).size).toBe(BUILTIN_PROMPT_ENTRIES.length);
    });

    it('历史重复行在播种时合并：保留用户改过的那行', async () => {
        const builtin = getBuiltinEntry(STEEL_KEY)!;
        await DB.savePromptPreset(makeRow({
            id: 'dup-a', sourceKey: STEEL_KEY, category: 'chat',
            name: builtin.name, content: builtin.content, order: builtin.order,
            createdAt: 100, updatedAt: 100,
        }));
        await DB.savePromptPreset(makeRow({
            id: 'dup-b', sourceKey: STEEL_KEY, category: 'chat',
            name: builtin.name, content: '我的自定义表达规则', order: builtin.order,
            createdAt: 200, updatedAt: 500,
        }));
        await seedBuiltinPromptPresets();
        const rows = (await DB.getPromptPresets()).filter((r) => r.sourceKey === STEEL_KEY);
        expect(rows).toHaveLength(1);
        expect(rows[0].content).toBe('我的自定义表达规则');
    });

    it('历史重复行都没动过时保留最早创建的那行；组内停用会保持停用', async () => {
        const builtin = getBuiltinEntry(STEEL_KEY)!;
        await DB.savePromptPreset(makeRow({
            id: 'dup-late', sourceKey: STEEL_KEY,
            name: builtin.name, content: builtin.content, order: builtin.order,
            createdAt: 900, updatedAt: 900,
        }));
        await DB.savePromptPreset(makeRow({
            id: 'dup-early', sourceKey: STEEL_KEY,
            name: builtin.name, content: builtin.content, order: builtin.order,
            createdAt: 100, updatedAt: 100, enabled: false,
        }));
        await seedBuiltinPromptPresets();
        const rows = (await DB.getPromptPresets()).filter((r) => r.sourceKey === STEEL_KEY);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('dup-early');
        expect(rows[0].enabled).toBe(false);
    });

    it('重复播种不覆盖用户的编辑、启停与排序', async () => {
        await seedBuiltinPromptPresets();
        const target = (await DB.getPromptPresets()).find((r) => r.sourceKey === STEEL_KEY)!;
        await DB.savePromptPreset({ ...target, name: '我的钢印', content: '只属于我的规则', enabled: false, order: 999 });
        await seedBuiltinPromptPresets();
        const rows = await DB.getPromptPresets();
        expect(rows).toHaveLength(BUILTIN_PROMPT_ENTRIES.length);
        const after = rows.find((r) => r.sourceKey === STEEL_KEY)!;
        expect(after).toMatchObject({ name: '我的钢印', content: '只属于我的规则', enabled: false, order: 999 });
    });

    it('无 sourceKey 的自定义行不受影响、不参与合并', async () => {
        await DB.savePromptPreset(makeRow({ id: 'custom-1', name: '我的段落', content: '自定义', order: 50 }));
        await DB.savePromptPreset(makeRow({ id: 'custom-2', name: '我的段落', content: '自定义', order: 51 }));
        await Promise.all([seedBuiltinPromptPresets(), seedBuiltinPromptPresets()]);
        const rows = await DB.getPromptPresets();
        expect(rows).toHaveLength(BUILTIN_PROMPT_ENTRIES.length + 2);
        expect(rows.filter((r) => r.id.startsWith('custom-'))).toHaveLength(2);
    });

    it('错名修复幂等，且不碰用户自改的名字', async () => {
        const builtin = getBuiltinEntry('memory.personalityDetect')!;
        await DB.savePromptPreset(makeRow({
            id: 'bad-name', sourceKey: 'memory.personalityDetect', category: 'memory',
            name: TYPO_NAME, content: builtin.content, order: builtin.order,
        }));
        await DB.savePromptPreset(makeRow({
            id: 'user-named', sourceKey: 'song.craftRules', category: 'song',
            name: '我自己起的名字', content: '我改过的内容', order: 301,
        }));
        await repairCorruptedBuiltinNames();
        await repairCorruptedBuiltinNames();
        const rows = await DB.getPromptPresets();
        expect(rows.find((r) => r.id === 'bad-name')!.name).toBe(builtin.name);
        expect(rows.find((r) => r.id === 'user-named')!.name).toBe('我自己起的名字');
    });
});
```

判据：`pnpm vitest run utils/promptPresetSeeding.test.ts` 6 条全过；故意把 `db.ts` 的 `reconcilePromptPresets` 临时换回旧播种逻辑时第 1 条应失败（可选自查，不留在代码里）。

## 步骤 5：总验收

按顺序执行并核对输出：

1. `pnpm vitest run utils/promptPresetSeeding.test.ts utils/promptPresetCatalog.test.ts utils/db.promptPresets.backup.test.ts`
   预期：3 个文件全绿（新增 6 条 + 目录 5 条 + 备份 2 条）。
2. `pnpm vitest run`
   预期：全量通过；若有失败，逐条确认是否与本次改动相关（触碰文件跑出的失败=必须修；既有失败=记录并说明）。
3. `npx tsc --noEmit`
   预期：仍是 45 errors / 11 files（基线），且 `utils/promptPresetSeeding.ts`、`utils/db.ts`、`utils/promptPresetCatalog.ts`、`utils/promptPresetSeeding.test.ts` 不出现在错误文件列表里。
4. 中文文件字节级自查：对 4 个触碰文件扫 `EF BF BD` 字节序列（U+FFFD 替换符），预期 0 命中。
5. 手工冒烟（dev）：`pnpm dev` 打开应用 → 控制台按 sourceKey 分组查 `prompt_presets`，预期无长度 >1 的组；打开预设 App，每个内置条目恰好一张卡，「记忆消化 · 认知风格判定」显示正确。
6. 手工模拟历史脏数据（可选）：控制台复制任意一行（换新 id）写回后刷新，预期启动后被自动合并回一行。

## 回滚

还原 `utils/promptPresetCatalog.ts` / `utils/db.ts` / `utils/promptPresetSeeding.ts` 三个文件、删除测试即可。无 schema 变更，无需数据回滚。
