/**
 * bankCategories：分类解析（新键 / 旧值别名 / 未分类按备注猜 / 收入兜底）。
 */
import { describe, it, expect } from 'vitest';
import { resolveCategory, guessExpenseCategory, DEFAULT_EXPENSE_CATEGORY, DEFAULT_INCOME_CATEGORY } from './bankCategories';

describe('resolveCategory', () => {
    it('已知支出键直接命中', () => {
        const r = resolveCategory({ amount: -20, category: 'food', note: '' });
        expect(r.key).toBe('food');
        expect(r.meta.label).toBe('餐饮');
        expect(r.isIncome).toBe(false);
    });
    it('已知收入键直接命中（绿色语义由调用方决定）', () => {
        expect(resolveCategory({ amount: 100, category: 'salary', note: '' }).key).toBe('salary');
        expect(resolveCategory({ amount: 100, category: 'refund', note: '' }).meta.label).toBe('退款');
    });
    it("旧值 '购物' → shopping", () => {
        expect(resolveCategory({ amount: -20, category: '购物', note: '' }).key).toBe('shopping');
    });
    it("旧值 'income' + 正数 → income_other", () => {
        expect(resolveCategory({ amount: 100, category: 'income', note: '' }).key).toBe(DEFAULT_INCOME_CATEGORY);
    });
    it('general / 未知分类：支出按备注猜', () => {
        expect(resolveCategory({ amount: -20, category: 'general', note: '午饭' }).key).toBe('food');
        expect(resolveCategory({ amount: -20, category: '', note: '完全无关的备注' }).key).toBe(DEFAULT_EXPENSE_CATEGORY);
    });
    it('未知分类 + 正数 → income_other', () => {
        expect(resolveCategory({ amount: 20, category: 'weird', note: '午饭' }).key).toBe(DEFAULT_INCOME_CATEGORY);
    });
});

describe('guessExpenseCategory', () => {
    it('关键词命中与兜底', () => {
        expect(guessExpenseCategory('地铁')).toBe('transport');
        expect(guessExpenseCategory('')).toBe('other');
    });
});
