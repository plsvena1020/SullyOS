// ============================================================
// bankTx: 银行流水纯函数助手。
// 符号约定：amount<0 支出、>0 收入（v3 迁移后为唯一真相）。
// 卡余额联动只认 ownsBalance（手动记账 owns，订单类不回滚）。
// ============================================================
import type { BankCard, BankTransaction } from '../types';
import { roundMoney } from './format';

/** 支出额（负值取 abs，正值计 0） */
export const expenseOf = (tx: Pick<BankTransaction, 'amount'>): number =>
    tx.amount < 0 ? -tx.amount : 0;

/** 收入额（正值，负值计 0） */
export const incomeOf = (tx: Pick<BankTransaction, 'amount'>): number =>
    tx.amount > 0 ? tx.amount : 0;

/**
 * v3 迁移：旧数据存在「正数金额 + 非 income 分类」的支出写法
 * （历史生活记录手动入账），统一转为负数。返回新数组，不改入参。
 */
export function normalizeLegacyTransactions(list: BankTransaction[]): { list: BankTransaction[]; changedIds: string[] } {
    const changedIds: string[] = [];
    const next = (list || []).map(tx => {
        if (tx.amount > 0 && tx.category !== 'income') {
            changedIds.push(tx.id);
            return { ...tx, amount: -tx.amount };
        }
        return tx;
    });
    return { list: next, changedIds };
}

/** 卡余额加 delta（已 roundMoney）；卡不存在时原样返回 */
export function applyCardDelta(cards: BankCard[] | undefined, cardId: string, delta: number): BankCard[] {
    const list = cards || [];
    if (!cardId || !list.some(c => c.id === cardId)) return list;
    return list.map(c => (c.id === cardId ? { ...c, balance: roundMoney(c.balance + delta) } : c));
}

/** 删除流水时回滚余额：仅 cardId + ownsBalance 的写入者（手动记账）负责回滚 */
export function rollbackTxBalance(cards: BankCard[] | undefined, tx: BankTransaction): BankCard[] {
    const list = cards || [];
    if (!tx.cardId || !tx.ownsBalance) return list;
    return applyCardDelta(list, tx.cardId, -tx.amount);
}
