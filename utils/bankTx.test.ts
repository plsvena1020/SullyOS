/**
 * bankTx 纯函数：符号口径 / v3 迁移 / 卡余额联动与回滚。
 */
import { describe, it, expect } from 'vitest';
import { expenseOf, incomeOf, normalizeLegacyTransactions, applyCardDelta, rollbackTxBalance } from './bankTx';
import type { BankCard, BankTransaction } from '../types';

const tx = (over: Partial<BankTransaction>): BankTransaction => ({
    id: 'tx-1', amount: -10, category: 'general', note: '', timestamp: 0, dateStr: '2026-01-01', ...over,
});

const card = (over: Partial<BankCard>): BankCard => ({
    id: 'c1', name: '零花钱卡', tailNo: '0001', balance: 100, isDefault: true, ...over,
});

describe('expenseOf / incomeOf', () => {
    it('负值=支出取 abs，正值=收入', () => {
        expect(expenseOf({ amount: -30 })).toBe(30);
        expect(incomeOf({ amount: -30 })).toBe(0);
        expect(expenseOf({ amount: 50 })).toBe(0);
        expect(incomeOf({ amount: 50 })).toBe(50);
        expect(expenseOf({ amount: 0 })).toBe(0);
    });
});

describe('normalizeLegacyTransactions v3 迁移', () => {
    it('正数 + 非 income 分类 → 转负并列进 changedIds', () => {
        const legacy = tx({ id: 'a', amount: 66.6, category: 'general' });
        const { list, changedIds } = normalizeLegacyTransactions([legacy]);
        expect(list[0].amount).toBe(-66.6);
        expect(changedIds).toEqual(['a']);
        expect(legacy.amount).toBe(66.6);
    });
    it('正数 income / 负值 / 正数 ownerId 记账不受影响（正数 income 保留）', () => {
        const income = tx({ id: 'b', amount: 100, category: 'income' });
        const expense = tx({ id: 'c', amount: -20, category: 'general' });
        const charIncome = tx({ id: 'd', amount: 30, category: 'income', ownerId: 'char-1' });
        const { list, changedIds } = normalizeLegacyTransactions([income, expense, charIncome]);
        expect(list.map(t => t.amount)).toEqual([100, -20, 30]);
        expect(changedIds).toEqual([]);
    });
});

describe('applyCardDelta', () => {
    it('给目标卡加 delta 并收敛到分', () => {
        const next = applyCardDelta([card({ id: 'c1', balance: 100 })], 'c1', -30.555);
        expect(next[0].balance).toBe(69.44);
    });
    it('卡不存在 / cardId 为空 → 原样返回', () => {
        const cards = [card({})];
        expect(applyCardDelta(cards, 'nope', 10)).toBe(cards);
        expect(applyCardDelta(cards, '', 10)).toBe(cards);
    });
});

describe('rollbackTxBalance 删除回滚', () => {
    it('ownsBalance 的支出删除 → 余额加回', () => {
        const next = rollbackTxBalance([card({ balance: 70 })], tx({ amount: -30, cardId: 'c1', ownsBalance: true }));
        expect(next[0].balance).toBe(100);
    });
    it('ownsBalance 的收入删除 → 余额扣回', () => {
        const next = rollbackTxBalance([card({ balance: 150 })], tx({ amount: 50, cardId: 'c1', ownsBalance: true }));
        expect(next[0].balance).toBe(100);
    });
    it('订单类（无 ownsBalance）删除不回滚', () => {
        const cards = [card({ balance: 70 })];
        expect(rollbackTxBalance(cards, tx({ amount: -30, cardId: 'c1' }))).toBe(cards);
    });
    it('卡已删除 → 跳过', () => {
        const cards = [card({ id: 'c2' })];
        expect(rollbackTxBalance(cards, tx({ amount: -30, cardId: 'c1', ownsBalance: true }))).toBe(cards);
    });
});
