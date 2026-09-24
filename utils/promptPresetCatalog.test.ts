import { describe, expect, it } from 'vitest';
import { BUILTIN_PROMPT_ENTRIES, PROMPT_CATEGORY_META, getBuiltinEntry, getBuiltinContent, fillIdentity } from './promptPresetCatalog';
import { BUILTIN_PROMPT_SNAPSHOT } from './snapshotBuiltinPrompts';
import {
    AUTONOMY_ROUND_OVERRIDE,
    AUTONOMY_ROUND_SITU,
    AUTONOMY_ROUND_FREEDOM,
    AUTONOMY_ROUND_NO_TOOLS,
    AUTONOMY_ROUND_OUTPUT,
} from '../worker/amsg/src/autonomyFire';

describe('builtin prompt catalog', () => {
    it('每条目录条目都有非空正文与合法元数据', () => {
        expect(BUILTIN_PROMPT_ENTRIES.length).toBeGreaterThan(0);
        for (const e of BUILTIN_PROMPT_ENTRIES) {
            expect(e.content.length, e.sourceKey).toBeGreaterThan(0);
            expect(e.name.length, e.sourceKey).toBeGreaterThan(0);
            expect(PROMPT_CATEGORY_META.map((c) => c.id), e.sourceKey).toContain(e.category);
            expect(e.order, e.sourceKey).toBeGreaterThan(0);
            expect(e.builtinVersion, e.sourceKey).toBeGreaterThan(0);
        }
    });

    it('sourceKey 全表唯一，order 同分类内唯一', () => {
        const keys = BUILTIN_PROMPT_ENTRIES.map((e) => e.sourceKey);
        expect(new Set(keys).size).toBe(keys.length);
        for (const cat of PROMPT_CATEGORY_META.map((c) => c.id)) {
            const orders = BUILTIN_PROMPT_ENTRIES.filter((e) => e.category === cat).map((e) => e.order);
            expect(new Set(orders).size).toBe(orders.length);
        }
    });

    it('目录内容与改造前源码快照逐字节一致（防中文/转义/占位符漂移）', () => {
        for (const e of BUILTIN_PROMPT_ENTRIES) {
            expect(e.content, e.sourceKey).toBe(BUILTIN_PROMPT_SNAPSHOT[e.sourceKey as keyof typeof BUILTIN_PROMPT_SNAPSHOT]);
        }
        expect(Object.keys(BUILTIN_PROMPT_SNAPSHOT).length).toBe(BUILTIN_PROMPT_ENTRIES.length);
    });

    it('amsg 主模板带评估上下文槽位与身份占位符（worker 还原链路依赖）', () => {
        const ev = getBuiltinEntry('amsg.emotionEval');
        expect(ev).toBeDefined();
        expect(ev!.content).toContain('__CONTEXT_SECTION__');
        expect(ev!.content).toContain('__BUFFS__');
        expect(ev!.content).toContain('__SCHEDULE_RULE__');
        expect(ev!.content).toContain('{{char}}');
        expect(ev!.content).toContain('{{user}}');
    });

    it('fillIdentity 替换身份占位符，{{user}} 缺省兜底「对方」', () => {
        expect(fillIdentity('你是{{char}}，对面是{{user}}', '小雪', '阿岚')).toBe('你是小雪，对面是阿岚');
        expect(fillIdentity('{{user}}在吗', '小雪')).toBe('对方在吗');
    });
});

describe('autonomy presets', () => {
    it('autonomy 分类与 5 条内置存在', () => {
        expect(PROMPT_CATEGORY_META.some((c) => c.id === 'autonomy')).toBe(true);
        expect(BUILTIN_PROMPT_ENTRIES.filter((e) => e.category === 'autonomy').length).toBe(5);
    });

    it('5 条内置可读（getBuiltinContent 命中）', () => {
        for (const key of ['autonomy.override', 'autonomy.situ', 'autonomy.freedom', 'autonomy.noTools', 'autonomy.output']) {
            expect(getBuiltinContent(key).length, key).toBeGreaterThan(0);
        }
    });

    it('目录 5 条正文与 worker 运行时常量逐字一致', () => {
        expect(getBuiltinContent('autonomy.override')).toBe(AUTONOMY_ROUND_OVERRIDE);
        expect(getBuiltinContent('autonomy.situ')).toBe(AUTONOMY_ROUND_SITU);
        expect(getBuiltinContent('autonomy.freedom')).toBe(AUTONOMY_ROUND_FREEDOM);
        expect(getBuiltinContent('autonomy.noTools')).toBe(AUTONOMY_ROUND_NO_TOOLS);
        expect(getBuiltinContent('autonomy.output')).toBe(AUTONOMY_ROUND_OUTPUT);
    });
});
