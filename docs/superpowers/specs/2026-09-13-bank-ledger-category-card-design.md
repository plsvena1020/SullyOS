# 记账分类与银行卡联动 · 设计

- 日期：2026-09-13
- 状态：已与用户确认（收入显示绿色字为追加要求）
- 涉及模块：存钱罐 BankApp 账本、档案 App 生活记录·记账页、查手机银行卡、购物/外卖/角色点单流水

## 背景与问题

记账入口有两处，共用 IndexedDB 同一本流水（`bank_transactions`）：

1. 存钱罐「记一笔」弹窗（`apps/BankApp.tsx`）：有收支切换，但没有分类选择，分类靠展示层按备注关键词猜；手动记账不关联银行卡。
2. 档案 App 生活记录「记账」页签（`components/lifeRecord/LifeRecordPanel.tsx`）：只能记支出，金额写正数、`category='general'`，与银行 App 的负数约定冲突，进而污染支出统计。

已确认的缺陷：

- `BankAnalytics.tsx:61` 把带符号金额直接求和当「支出」展示，收入会冲减甚至倒挂成负数（用户所报的「收入依然是赤字」）；`:377` 明细行硬编码红色 `-` 前缀，收入显示为 `-¥100`；分类聚合（`:94`）与百分比（`:100`）同样带符号；预算结余（`:173`）被收入抬高。
- `BankApp.tsx:443` 删除一笔收入流水会错误减少今日支出（`todaySpent - abs(income)`）。
- `BankApp.tsx:313-319` 昨日 AP 结算未过滤角色流水（`ownerId`），且收入会冲减昨日支出、虚增 AP；与 `:353` 的加载口径不一致。
- 购物/外卖/角色点单明明扣了具体银行卡，流水未存 `cardId`，账单无法显示「哪张卡」。
- CSV 导出原地排序 props、缺收支方向与真实分类；AI 分析把收入当消费。
- 查手机银行流水显示 `general`/`income` 原始分类字符串。
- `components/bank/BankDashboard.tsx` 已无任何引用（死代码）。

## 决策（用户已选）

1. **选卡联动余额**：手动记账支出扣所选卡、收入充所选卡；删除手动流水时回滚。订单类流水（购物/外卖/角色点单/查手机代购）余额在下单流程已扣，流水只补归属、删除不回滚。
2. **分类体系**：支出沿用现有 8 类；收入新增 6 类。记账时可选，旧记录继续按备注猜。
3. **生活记录记账页同步升级**：加收支切换 + 分类 + 选卡，保持复古账簿风格。
4. **附带修复全做**（见问题清单）。
5. **收入用绿色字**：银行账本明细收入行 `+¥X` 绿色；记一笔弹窗收入模式下金额输入转绿；生活记录记账页收入数字/行用复古绿。

## 数据约定

**符号是唯一真相**：`amount < 0` 为支出，`amount > 0` 为收入。旧数据兼容问题用一次性迁移解决（见下）。

`BankTransaction` 新增字段（`types.ts`）：

```ts
cardId?: string;      // 归属银行卡 id；缺省=未关联
ownsBalance?: boolean; // true=该笔写入时余额由记账联动（删除时应回滚）；订单类流水为 false/缺省，余额归下单流程管
```

## 分类体系（`utils/bankCategories.ts` 新建）

- 支出 8 类（键沿用现有猜词结果键）：`food 餐饮 / transport 交通 / shopping 购物 / entertainment 娱乐 / bills 账单 / health 医疗 / education 学习 / other 其他`。图标、颜色、渐变从 `BankAnalytics.tsx:19-28` 的 `CATEGORIES` 原样迁出。
- 收入 6 类：`salary 工资 / redpacket 红包 / refund 退款 / parttime 兼职 / investment 理财 / income_other 其他`。
- 解析 `resolveCategory(tx)` 优先级：已知键（支出或收入注册表）→ 旧值别名（`购物→shopping`、`income→income_other`、`general` 视为未分类）→ 根据符号与备注：支出用 `guessExpenseCategory(note)`（从 `BankAnalytics.tsx:105-115` 迁入），收入归 `income_other`。
- 默认值：支出 `other`，收入 `income_other`。备注改为选填（为空时列表与 CSV 显示分类名）。

## 一次性迁移 v3（`BankApp.loadData`）

在现有 `dataVersion < 2` 块之后追加：

- 条件：`!currentState.dataVersion || currentState.dataVersion < 3`。
- 动作：把所有 `amount > 0 && category !== 'income'` 的流水金额转负（修生活记录历史正数脏数据），逐条 `DB.saveTransaction`，最后 `dataVersion = 3` 并写回 `bank_states`。
- 迁移后统计口径统一改为「负值取 abs 为支出、正值计收入」。

## 余额联动规则

- 手动记账（BankApp 弹窗、生活记录页）：
  - 支出：所选卡余额不足 → 拒绝并 toast（提示换卡 / 不关联 / 先记收入）。
  - 写入 `cardId` + `ownsBalance: true`，同一 `persistStateUpdate` 内更新卡余额（支出减、收入加）。
  - 删除：`cardId && ownsBalance` 时回滚 `balance = roundMoney(balance - tx.amount)`；卡已被删除则跳过。
- 订单类写入方（ShoppingApp、TakeoutApp、charOrder 出款/退款、charLedger 代购）：补 `cardId`，`ownsBalance` 缺省（false），不重复扣款、删除不退款。
- 角色视图（BankApp `actor=charId`）：只能选角色名下卡；「给TA记收入」默认选角色默认卡。
- 用户视图中卡选择器只列非角色卡。

## 展示规则

- 银行账本（BankAnalytics）：
  - hero 主数字 = 真实支出（负值 abs 和）；有收入时下方绿色副行 `收入 +¥X`。
  - 预算进度与结余只用支出计算。
  - 分类聚合只统计支出，占比分母为总支出。
  - 明细行：支出红色 `−¥X`，收入绿色 `+¥X`；显示中文分类与卡名（新增 `cards` prop）。
  - CSV：复制数组再排序、加「收支」与「银行卡」列、用真实分类。
  - AI 分析只把支出笔送进提示词与分类映射。
- 生活记录记账页：
  - 加载流水过滤 `ownerId`（不再混入角色流水），同时读 `bank_states.cards` 取用户卡。
  - 显示当/月支出（主）+ 收入（副），行内支出金褐、收入复古绿 `#5d7345`。
  - 新增 支出/收入 切换、分类 chips、卡选择；写入符号与银行 App 一致。
- 查手机银行流水：分类显示中文名，尾部附卡名（`bankCards` 查找 `cardId`）。

## 触碰文件

新增：`utils/bankCategories.ts`、`utils/bankTx.ts`、`utils/bankCategories.test.ts`、`utils/bankTx.test.ts`
修改：`types.ts`、`apps/BankApp.tsx`、`components/bank/BankAnalytics.tsx`、`components/lifeRecord/LifeRecordPanel.tsx`、`apps/CheckPhone.tsx`、`apps/ShoppingApp.tsx`、`apps/TakeoutApp.tsx`、`utils/charOrder.ts`、`utils/charLedger.ts`、`utils/charOrder.test.ts`、`notes/ethernet-features.md`
删除：`components/bank/BankDashboard.tsx`

## 验证

- `pnpm exec tsc --noEmit`
- `pnpm test:run`（新增单测 + `mojibakeGuard` 编码护栏）
- `pnpm build`
- 手动验收：记支出选卡（余额减、明细红、分类中文）→ 记收入（余额加、绿色 +、hero 不被冲减）→ 删除收入（余额回落、今日支出不变）→ 生活记录收支双向 → 购物流水显示卡名且删除不退款。
