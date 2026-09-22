import { describe, expect, it, vi } from 'vitest';
import {
    applyRegexPlacement,
    runRegexRule,
} from './presetRegex';
import type { PresetRegexKit, PresetRegexRule } from '../types';

const rule = (over: Partial<PresetRegexRule> = {}): PresetRegexRule => ({
    id: 'r', scriptName: 'R', findRegex: 'x', replaceString: 'y',
    placement: [2], disabled: false, ...over,
});
const kit = (rules: PresetRegexRule[], over: Partial<PresetRegexKit> = {}): PresetRegexKit => ({
    id: 'k', name: 'K', rules, enabled: true, createdAt: 0, updatedAt: 0, ...over,
});

describe('runRegexRule', () => {
    it('基本查找替换（全局）', () => {
        expect(runRegexRule(rule({ findRegex: '猫', replaceString: '狗' }), '猫追猫')).toBe('狗追狗');
    });
    it('分组引用 $1', () => {
        expect(runRegexRule(
            rule({ findRegex: '\\[\\[(.*?)\\]\\]', replaceString: '<$1>' }),
            '看[[这样]]好',
        )).toBe('看<这样>好');
    });
    it('替换串里的 $ 按字面走（不触发 $& 语义）', () => {
        expect(runRegexRule(rule({ findRegex: 'a', replaceString: '$&$100' }), 'a')).toBe('$&$100');
    });
    it('替换串支持 {{char}} 宏', () => {
        expect(runRegexRule(
            rule({ findRegex: '你', replaceString: '{{char}}说' }),
            '你好', { charName: '阿澈' },
        )).toBe('阿澈说好');
    });
    it('非法正则整条跳过并 warn，不抛', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(runRegexRule(rule({ findRegex: '([' }), '原文')).toBe('原文');
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('applyRegexPlacement', () => {
    it('无 kit/停用 kit/空文本原样返回', () => {
        expect(applyRegexPlacement('t', null, 2)).toBe('t');
        expect(applyRegexPlacement('t', kit([rule()]), 2)).toBe('t');
        expect(applyRegexPlacement('t', kit([rule()], { enabled: false }), 2)).toBe('t');
        expect(applyRegexPlacement('', kit([rule()]), 2)).toBe('');
    });
    it('placement 分流：只跑对上号的规则', () => {
        const k = kit([
            rule({ id: 'a', findRegex: 'a', replaceString: 'A', placement: [1] }),
            rule({ id: 'b', findRegex: 'b', replaceString: 'B', placement: [2] }),
        ]);
        expect(applyRegexPlacement('a b', k, 1)).toBe('A b');
        expect(applyRegexPlacement('a b', k, 2)).toBe('a B');
    });
    it('disabled 规则跳过，多规则按数组顺序串行', () => {
        const k = kit([
            rule({ findRegex: 'a', replaceString: 'b', placement: [2] }),
            rule({ findRegex: 'b', replaceString: 'c', placement: [2], disabled: true }),
        ]);
        expect(applyRegexPlacement('a', k, 2)).toBe('b');
    });
    it('tags 过滤', () => {
        const k = kit([rule({ findRegex: 'a', replaceString: 'B', placement: [2], tags: ['date'] })]);
        expect(applyRegexPlacement('a', k, 2, { activeTags: ['chat'] })).toBe('a');
        expect(applyRegexPlacement('a', k, 2, { activeTags: ['chat', 'date'] })).toBe('B');
    });
    it('depth 门只卡 placement=2', () => {
        const k = kit([rule({ findRegex: 'a', replaceString: 'B', placement: [2], minDepth: 1, maxDepth: 3 })]);
        expect(applyRegexPlacement('a', k, 2, { depth: 0 })).toBe('a');
        expect(applyRegexPlacement('a', k, 2, { depth: 2 })).toBe('B');
        expect(applyRegexPlacement('a', k, 2, { depth: 4 })).toBe('a');
    });
    it('displayOnly/4 规则跳过并 warn', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const k = kit([rule({ findRegex: 'a', replaceString: 'B', placement: [2, 4] })]);
            expect(applyRegexPlacement('a', k, 2)).toBe('a');
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
    it('promptOnly 视为 placement=5', () => {
        const k = kit([rule({ findRegex: 'a', replaceString: 'B', placement: [], promptOnly: true })]);
        expect(applyRegexPlacement('a', k, 5)).toBe('B');
        expect(applyRegexPlacement('a', k, 2)).toBe('a');
    });
});
