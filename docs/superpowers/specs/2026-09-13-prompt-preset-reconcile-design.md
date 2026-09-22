# 预设条目重复修复 · 设计

- 日期：2026-09-13
- 状态：已确认（用户批准执行；含「认知风风风风判定」错名修正）
- 涉及模块：预设数据播种（`utils/promptPresetSeeding.ts`）、IndexedDB 层（`utils/db.ts`）、内置提示词目录（`utils/promptPresetCatalog.ts`）、Preset App（只消费，不改）

## 背景与问题

用户报告：预设 App 里存在**完全相同的条目**——同一内置提示词出现两张名称/正文完全一致的卡片。经排查，这是播种（seeding）的并发竞态，不是设计意图；另有运行时静默偏好第一行的隐性后果。

## 根因

1. **播种非原子**：`utils/promptPresetSeeding.ts:15-38` 先读全表、算缺失 `sourceKey`、再逐条 `DB.savePromptPreset`（每条一个独立事务）。检查与写入跨越多个事务，没有互斥。
2. **`sourceKey` 非唯一键**：`prompt_presets` 的 keyPath 是 `id`（`utils/db.ts:368`），没有对 `sourceKey` 建唯一索引或任何约束。
3. **触发条件**：任意两条播种链重叠即双写——
   - dev 环境 React.StrictMode 双跑 effect（`index.tsx:38`；OSContext 的播种 effect 在 `context/OSContext.tsx:914-929`，`run()` 不被 cancelled 拦截）；
   - 同一浏览器两个标签页 / PWA 与网页同时打开（各自挂载 `OSProvider`，`App.tsx:40`）；
   - HMR / Provider 重挂载。
   两边都先读到"缺行"，各写一份带新 UUID 的行 → 每个内置条目两行。
4. **没有收尾去重**：`DB.getPromptPresets`（`utils/db.ts:4052-4067`）原样返回全部行；Preset App 原样渲染（`apps/PresetApp.tsx:253`）；`getResolvedPromptPresets`（`utils/promptPresetRuntime.ts:32-52`）也不去重。
5. **影响不止显示**：注入侧用 `.find()` 取排序后第一行（`utils/promptPresetRuntime.ts:77/94/108`）。用户在第二张重复卡上编辑或「恢复内置默认」时，实际注入的仍是第一行——改了不生效。重复行还会随备份的 `promptPresets` 字段（`types.ts:4369-4371`）导出导入持续传播，不会自愈。
6. **旁证旧缺陷**：提交 `9fa253b7` 把 `memory.personalityDetect` 的展示名从「记忆消化 · 认知风格判定」误改为「记忆消化 · 认知风风风风判定」（当前 `utils/promptPresetCatalog.ts:136`）。在该提交之后初次播种的用户数据里带着这个错名；目录已错，历史行需一次性修正。与重复问题无关，但同批处理。

## 方案决策

### 决策 1：原子化 + 历史自愈（不改 store 版本、不加索引）

新增 `DB.reconcilePromptPresets(seeds, builtinByKey)`：在**单个 `readwrite` 事务**内完成 `getAll()` → 按 `sourceKey` 分组 → 合并重复组 → 补写缺失 seed → 提交。IndexedDB 对同一 store 的 `readwrite` 事务跨连接串行化：并发调用的第二个事务会等第一个提交后再执行，并在自己的事务里读到最新数据，从根上杜绝双写。

选择理由：改动最小；不需要 DB 版本升级（加唯一索引需要 `onupgradeneeded` 迁移、且要预清理历史重复数据，成本与风险都更高）；对多标签页天然生效。

`seedBuiltinPromptPresets()` 的函数签名与调用点保持不变，OSContext 不改。

### 决策 2：重复组合并策略（keeper 规则）

- **作用域**：只处理 `sourceKey` 在目录登记过的行。无 `sourceKey` 或未登记的行一律不碰——用户手建的段落可能有意重复，系统不擅自合并。
- **keeper 选择**（确定性，实现为纯比较）：
  1. 组内某行的 `content` 或 `name` 与目录默认不同 → 视为"用户动过"；
  2. 存在多行"动过"时取 `updatedAt` 最新者；
  3. 都没有动过时取 `createdAt` 最早者（即首次播种的那行，与运行时 `.find()` 当前实际使用的一致，避免行为突变）；
  4. 平局取 `id` 字典序小者。
- **字段合并**：`order` / `name` / `content` / `builtinVersion` / `createdAt` 用 keeper 自己的；`enabled` 只要组内存在任意一行被停用即取 `false`（尊重用户的停用动作，宁可保守停用也不静默复活），否则用 keeper 的；`updatedAt` 不动。
- 删除非 keeper 行并计数，返回 `{ seeded, removed }` 供日志与测试使用。

### 决策 3：播种入口重写

`utils/promptPresetSeeding.ts` 的 `seedBuiltinPromptPresets` 不再自己读表判断，改为：

- 用 `BUILTIN_PROMPT_ENTRIES` 生成全部 seed 行（18 条，含新 UUID、`createdAt/updatedAt = now`）；
- 构造 `builtinByKey: Record<sourceKey, { name, content }>`；
- 调 `DB.reconcilePromptPresets(seeds, builtinByKey)`，由事务内决定补哪些；
- `seeded > 0 || removed > 0` 时调 `invalidatePromptPresetCache()` 并打日志。

### 决策 4：错名一次性修复

- **目录修正**：`utils/promptPresetCatalog.ts:136` → `"记忆消化 · 认知风格判定"`。快照测试（`utils/promptPresetCatalog.test.ts`）只对内容不对名字，改动安全。
- **历史行修复**：新增 `repairCorruptedBuiltinNames()`（同一 seeding 模块）：
  - 只处理 `sourceKey === 'memory.personalityDetect'`；
  - 只精确匹配错名字符串 `记忆消化 · 认知风风风风判定` 才改，新名从目录当前 `name` 读取；
  - 用户自己起的名字（任何其它字符串）不动；正文、启停、排序、`builtinVersion` 均不动；
  - 幂等；由 `seedBuiltinPromptPresets()` 末尾顺带调用（一次全表读，成本可忽略），修复到行时同步 `invalidatePromptPresetCache()`。

### 决策 5：不做的事

- 不动 IDB schema / 版本号；不新增索引。
- 不在 UI 层或 `DB.getPromptPresets` 里做去重（会隐藏数据问题、让用户无法删除被隐藏的行；数据层修好即可）。
- 不自动合并无 `sourceKey` 的自定义行。
- 不改备份格式与导入/导出流程。
- 不为「重复行来源」加埋点。

## 数据流（修复后）

启动 → `seedBuiltinPromptPresets()` → ① `reconcilePromptPresets` 单事务：读全表 / 合并重复 / 补缺 → ② `repairCorruptedBuiltinNames` 全表扫错名 → ③ 有变化则失效缓存 → ④ OSContext 继续预热 `getResolvedPromptPresets()`。之后 Preset App 读表渲染，天然无重复。

## 验收标准

- 并发任意次数播种后：每个登记 `sourceKey` 恰好一行；内置行数 = 目录条数。
- 历史重复组合并结果符合 keeper 策略；用户的内容/名字编辑、启停、排序保留。
- 错名修复幂等，且不碰用户自改名。
- 全量 `pnpm vitest run` 无新增失败；`npx tsc --noEmit` 无新增错误（基线：45 errors / 11 files，本次触碰文件不在其中）。

## 相容性与回滚

无 schema 变更、无数据格式变更、无新依赖。回滚 = 还原三个源文件；合并结果本身正确，无需恢复被删除的重复行（它们与 keeper 内容一致或已过时）。
