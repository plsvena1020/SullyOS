# 记账分类与银行卡联动 · 执行计划

- 日期：2026-09-13
- 对应 spec：`docs/superpowers/specs/2026-09-13-bank-ledger-category-card-design.md`
- 执行顺序：按步骤编号顺序做，每步有验收判据；全部完成后跑总验收。
- 通用约定：金额一律 `roundMoney`；写入符号 `<0 支出 / >0 收入`；卡余额联动只发生在手动记账路径，订单路径只补 `cardId`。

## 步骤 1：类型（types.ts:2553-2562）

`BankTransaction` 改为：

```ts
export interface BankTransaction {
    id: string;
    amount: number; // <0 支出，>0 收入 —— 符号是唯一真相（v3 迁移后）
    category: string; // 分类 key，见 utils/bankCategories.ts；旧值 'general'/'购物'/'income' 由解析层兼容
    note: string;
    timestamp: number;
    dateStr: string; // YYYY-MM-DD
    ownerId?: string; // char 账本流水归属（不进 user 预算）
    linkedPurchaseId?: string; // 查手机购买记录关联（PhoneEvidence id、可空）
    cardId?: string; // 归属银行卡 id；缺省=未关联
    ownsBalance?: boolean; // true=余额由本笔记账联动（删除时回滚）；订单类流水缺省 false（余额归下单流程）
}
```

验收：`pnpm exec tsc --noEmit` 通过（此时其它改动未做，允许后续步骤再跑）。

## 步骤 2：分类注册表（新建 utils/bankCategories.ts）

导出：

- `EXPENSE_CATEGORIES`：8 类，键与元数据照抄 `BankAnalytics.tsx:19-28`（icon 用 Twemoji URL、label、color、gradient）。
- `INCOME_CATEGORIES`：`salary 工资 / redpacket 红包 / refund 退款 / parttime 兼职 / investment 理财 / income_other 其他`；icon 用同风格 Twemoji：1f4bc / 1f9e7 / 21a9 / 1f6e0 / 1f4c8 / 1f4b0；color 分别 `#66BB6A / #EF5350 / #42A5F5 / #FFA726 / #26A69A / #78909C`；gradient 用近似 Tailwind 档。
- `EXPENSE_CATEGORY_ORDER`、`INCOME_CATEGORY_ORDER`（数组，顺序同上）。
- `DEFAULT_EXPENSE_CATEGORY='other'`、`DEFAULT_INCOME_CATEGORY='income_other'`。
- `LEGACY_CATEGORY_ALIASES={'购物':'shopping','income':'income_other'}`。
- `guessExpenseCategory(note)`：照抄 `BankAnalytics.tsx:105-115`。
- `categoryMeta(key, isIncome)`：未知 key 回落 other / income_other。
- `resolveCategory(tx: Pick<BankTransaction,'amount'|'category'|'note'>): { key, meta, isIncome }`：已知键 → 别名 → `general`/未知：支出按 note 猜、收入归 income_other。

验收：写单测（步骤 3）。

## 步骤 3：账务助手（新建 utils/bankTx.ts）+ 单测

- `expenseOf(tx)=amount<0?-amount:0`、`incomeOf(tx)=amount>0?amount:0`。
- `normalizeLegacyTransactions(list)`：返回 `{ list, changedIds }`，把 `amount>0 && category!=='income'` 的项改为负值（不原地改）。
- `applyCardDelta(cards, cardId, delta)`：返回新数组；卡不存在返回原数组。
- `rollbackTxBalance(cards, tx)`：`tx.cardId && tx.ownsBalance` 时 `balance - tx.amount`，否则原数组。

单测 `utils/bankTx.test.ts`：迁移（正 general→负、正 income 不动、负值不动、ownerId 同样处理）、expenseOf/incomeOf、余额增减、回滚条件（无 ownsBalance 不回滚、卡缺失跳过）。
单测 `utils/bankCategories.test.ts`：已知键、旧值别名、general/未知按备注猜、收入正数未知归 income_other。

## 步骤 4：BankApp.tsx

1. 导入 `DEFAULT_*`、`EXPENSE_CATEGORY_ORDER`、`INCOME_CATEGORY_ORDER`、`categoryMeta`、`expenseOf`、`normalizeLegacyTransactions`、`applyCardDelta`、`rollbackTxBalance`。
2. 状态：新增 `txCategory`、`txCardId`（`''`=不关联）。
3. `openAddTxModal(overrides?)`：统一入口（`:865` 记账按钮、`:874` 给角色记收入都用它）；默认 `txCategory` 按类型、`txCardId` = 该身份默认卡 id。
4. 迁移 v3：`:303` 的 v2 块后执行 `dataVersion < 3` 块（normalize + 逐条 save + dataVersion=3）。
5. `:313-319` 昨日 AP：`txs.filter(t => t.dateStr===yesterdayStr && !t.ownerId)` 且 `sumMoney(map(expenseOf))`。
6. `:355` 今日支出：`sumMoney(todayTx.map(expenseOf))`。
7. `handleAddTransaction`：校验金额/分类；备注选填；支出选卡时余额不足拒绝；写 `category/txCategory`、`cardId`、`ownsBalance:true`（有卡时）；同一 `persistStateUpdate` 更新 `todaySpent`（user）与卡余额；char 路径同样联动角色卡、不动 todaySpent。
8. `handleDeleteTransaction`：先 `rollbackTxBalance` 回滚（char 分支也要，再 return）；todaySpent 减项条件改为 `!tx.ownerId && tx.amount<0 && tx.dateStr===today`。
9. 弹窗 UI（`:1217-1250`）：收支切换行下加分类 chips（支出 4 列 / 收入 3 列网格，选中态用分类色）；备注下加卡选择 chips（该身份可用的卡 + 「不关联」）；收入模式金额输入文字/边框转绿。
10. `:1008-1015` `<BankAnalytics cards={state.cards || []} … />`。
11. char 快速收入按钮（`:874`）用 `openAddTxModal({ type:'income', note: … })`。

验收：`tsc` 通过；手动路径见总验收。

## 步骤 5：BankAnalytics.tsx

1. 删本地 `CATEGORIES`/`guessCategory`，改 import `utils/bankCategories`；props 加 `cards?: BankCard[]`。
2. 计算：`totalExpense`（负值 abs 和）、`totalIncome`（正值和）；hero 主数字=支出，收入>0 时绿色副行。
3. `budgetRemaining`/进度条用 `totalExpense`。
4. `categoryData` 只聚 `amount<0`，`total=abs`，`percentage=total/totalExpense`；解析用 `resolveCategory(tx).meta`。
5. 明细行：`amount<0` → 红 `−¥X`；`>0` → 绿 `+¥X`；副行显示 `resolveCategory` label + 卡名（`cards.find(c=>c.id===tx.cardId)`）。
6. CSV：`[...transactions].sort`；表头 `日期,时间,收支,金额,分类,银行卡,备注`；方向、分类、卡名实填。
7. AI 分析：只取 `filteredTx.filter(t=>t.amount<0)`；无支出时按钮禁用/提示。

## 步骤 6：LifeRecordPanel.tsx

1. `reload` 加 `DB.getBankState()`，`setTxs(t.filter(t=>!t.ownerId)…)`，新增 `cards` 状态（仅 `owner!=='char'`）。
2. 汇总：`dayExpense/dayIncome`、`monthExpense/monthIncome`；UI 主数字=支出，收入副行绿 `#5d7345`。
3. 表单：`txType/txCategory/txCardId`；分类 chips（复用注册表，小型账簿风）；卡选择；支出余额不足拒绝；写入 `-amount` 支出 / `+amount` 收入、`category`、`cardId`、`ownsBalance:true`，同步卡余额；详情行红/绿符号。
4. 保留「与银行 App 共用一本账」提示，流水标题不变。

## 步骤 7：写入方补卡归属

- `apps/ShoppingApp.tsx:275-279`：加 `cardId: payCard.id`。
- `apps/TakeoutApp.tsx:305-309`：加 `cardId: payCard.id`。
- `utils/charOrder.ts:64-73` 出款加 `cardId`；`:106-115` 退款加 `cardId: target.id`。
- `utils/charLedger.ts:57-66` 加 `cardId: cardId || undefined`。

## 步骤 8：查手机 + 清理 + 测试更新

- `apps/CheckPhone.tsx:2693-2705`：分类行改 `resolveCategory(t).meta.label`，日期行附卡名。
- 删除 `components/bank/BankDashboard.tsx`（先确认零引用）。
- `utils/charOrder.test.ts:10-13` 本地映射改 sign-only（用 `expenseOf`），保留既有断言；补一条「正数 general 不再计支出」用例。

## 步骤 9：总验收与收尾

1. `pnpm exec tsc --noEmit`
2. `pnpm test:run`
3. `pnpm build`
4. 编码护栏：全仓扫 U+FFFD（`mojibakeGuard` 测试 + 必要时 python 复扫）。
5. 更新 `notes/ethernet-features.md` 六、银行与记账。
