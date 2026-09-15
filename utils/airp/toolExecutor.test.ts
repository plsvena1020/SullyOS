import { describe, it, expect, vi } from 'vitest';
import { createChatToolExecutor } from './toolExecutor';
import type { AgenticToolCtx } from '../agenticTools';
import type { AirpToolExecutor } from './directorClient';

// 注入桩 dispatch：不 mock 真实工具，只验证「目录名 → 仓库真名」的映射与结果编码。
const ctx = { char: { name: 'Aria' }, userProfile: { name: '小明' } } as unknown as AgenticToolCtx;

function makeExecutor(dispatchImpl: (...args: any[]) => any): {
    executor: AirpToolExecutor;
    dispatch: ReturnType<typeof vi.fn>;
} {
    const dispatch = vi.fn(dispatchImpl);
    return { executor: createChatToolExecutor(dispatch as any, ctx), dispatch };
}

describe('createChatToolExecutor —— AIRP 目录名映射到仓库工具', () => {
    it('recall_deep → recall，实参 / ctx 原样透传', async () => {
        const { executor, dispatch } = makeExecutor(async () => '回忆文本');
        const args = { year: '2026', month: '06' };

        const result = await executor.executeTool('recall_deep', args);

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith('recall', args, ctx);
        expect(result).toEqual({ ok: true, text: '回忆文本' });
    });

    it('web_search / read_note 走同名真工具', async () => {
        const web = makeExecutor(async () => '搜索结果');
        expect(await web.executor.executeTool('web_search', { q: 'x' }))
            .toEqual({ ok: true, text: '搜索结果' });
        expect(web.dispatch).toHaveBeenCalledWith('web_search', { q: 'x' }, ctx);

        const note = makeExecutor(async () => '笔记');
        expect(await note.executor.executeTool('read_note', { id: 'n1' }))
            .toEqual({ ok: true, text: '笔记' });
        expect(note.dispatch).toHaveBeenCalledWith('read_note', { id: 'n1' }, ctx);
    });

    it('对象结果序列化成 JSON 字符串', async () => {
        const { executor } = makeExecutor(async () => ({ ok: true, items: [1, 2] }));

        const result = await executor.executeTool('recall_deep', {});

        expect(result).toEqual({ ok: true, text: JSON.stringify({ ok: true, items: [1, 2] }) });
    });

    it('无法序列化的结果回落空串，不抛', async () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        const { executor } = makeExecutor(async () => cycle);

        expect(await executor.executeTool('read_note', {})).toEqual({ ok: true, text: '' });
    });

    it('真工具抛错 → ok:false，text 带「执行失败：」与原因', async () => {
        const { executor } = makeExecutor(async () => { throw new Error('boom'); });

        expect(await executor.executeTool('web_search', {})).toEqual({ ok: false, text: '执行失败：boom' });
    });

    it('非 Error 抛值也编码成失败文本', async () => {
        const { executor } = makeExecutor(async () => { throw 'plain'; });

        expect(await executor.executeTool('web_search', {})).toEqual({ ok: false, text: '执行失败：plain' });
    });

    it('未知目录名直接抛错、不派发（directorClient 的 catch 会落成「执行失败」）', async () => {
        const { executor, dispatch } = makeExecutor(async () => 'never');

        await expect(executor.executeTool('weather_elsewhere', {})).rejects.toThrow(/weather_elsewhere/);
        expect(dispatch).not.toHaveBeenCalled();
    });
});
