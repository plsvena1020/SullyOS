/**
 * charOrder 退款分类口径：退款即收入，不虚增 BankApp 今日支出。
 * IndexedDB 由 test-setup 的 fake-indexeddb 提供，走真实 DB 层（照抄 lifeRecords.test.ts 风格）。
 */
import { describe, it, expect } from 'vitest';
import { DB } from './db';
import { debitCharCardForOrder, refundCharOrder } from './charOrder';
import { sumMoney } from './format';
import { expenseOf } from './bankTx';

// BankApp 今日支出统计（apps/BankApp.tsx）的口径：只认符号（负值取 abs，正数一律收入不计）。
// v3 迁移已把旧的「正数金额支出」写法转负，所以这里不再按 category==='income' 兜底。
const spentContribution = (t: { amount: number }): number => expenseOf(t);

async function ensureCharCard(charId: string): Promise<void> {
    const bank = await DB.getBankState();
    const cards = bank?.cards || [];
    if (!cards.some((c: any) => c.owner === 'char' && (c as any).ownerId === charId)) {
        await DB.saveBankState({
            ...(bank || { config: { dailyBudget: 100, currencySymbol: '¥' }, shop: {} as any, goals: [], todaySpent: 0, lastLoginDate: '2026-01-01' }),
            cards: [...cards, { id: `card_test_char_${charId}`, name: 'CharTest', tailNo: '1002', balance: 1000, isDefault: true, owner: 'char', ownerId: charId }],
        } as any);
    } else {
        await DB.saveBankState({
            ...(bank as any),
            cards: cards.map((c: any) => (c.owner === 'char' && (c as any).ownerId === charId
                ? { ...c, balance: Math.max(Number(c.balance || 0), 1000) }
                : c)),
        } as any);
    }
}

describe('refundCharOrder 退款不虚增今日支出', () => {
    it('退款落正数 income 流水，BankApp 支出映射计 0', async () => {
        const charId = `char-refund-${Math.random().toString(36).slice(2, 8)}`;
        const orderId = `refund-guard-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        await ensureCharCard(charId);

        const pay = await debitCharCardForOrder({ orderId, charId, charName: '测试角色', shop: '测试店', total: 36 });
        expect(pay.ok).toBe(true);

        const res = await refundCharOrder(orderId, charId, { shop: '测试店' });
        expect(res.refunded).toBe(true);

        const txs = await DB.getAllTransactions();
        const refund = txs.find(t => t.id === res.txnId);
        expect(refund).toBeTruthy();
        expect(refund!.amount).toBeGreaterThan(0);
        // 退款即收入：与 BankApp 手动记账 / lifeRecords 代记的 income 口径一致
        expect(refund!.category).toBe('income');
        // 今日支出统计里贡献为 0（回归锁：以前 category='refund' 时这里会计入正数支出）
        expect(spentContribution(refund!)).toBe(0);
        expect(sumMoney([refund!].map(spentContribution))).toBe(0);

        for (const t of txs.filter(t => t.linkedPurchaseId === orderId || t.id === pay.txnId || t.id === res.txnId)) {
            await DB.deleteTransaction(t.id);
        }
    });

    it('char 账本流水不进 user 今日支出（ownerId 过滤）；正数一律不计支出', async () => {
        // BankApp 加载统计口径：先按 ownerId 排除 char 流水，再做符号映射（负数=支出）
        const today = '2099-01-01';
        const txs = [
            { amount: -50, category: '购物', dateStr: today, ownerId: 'char-1' },
            { amount: -30, category: 'general', dateStr: today },
            { amount: 100, category: 'income', dateStr: today },
            { amount: 12, category: 'general', dateStr: today },
        ];
        const scoped = txs.filter(t => t.dateStr === today && !(t as any).ownerId);
        expect(scoped.length).toBe(3);
        expect(sumMoney(scoped.map(spentContribution))).toBe(30);
    });
});
