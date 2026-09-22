import { describe, expect, it, vi } from 'vitest';
import { suggestImageTags, parseTagSuggestion } from './imageGenFlow';

const API = { baseUrl: 'https://llm.test', apiKey: 'k', model: 'm' } as any;

const llmReply = (content: string) => {
    const fetchImpl = vi.fn(async (_url: string, init?: any) => ({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        blob: async () => new Blob([]),
        headers: { get: () => null },
        _init: init,
    }));
    return fetchImpl;
};

describe('suggestImageTags', () => {
    it('JSON 输出 → tags + 模型自选的画幅', async () => {
        const fetchImpl = llmReply('{"tags": "1girl, moonlit lake, standing", "resolution": "landscape"}');
        const out = await suggestImageTags('月下的湖边', { id: 'c1', name: '小苏' } as any, API, fetchImpl as any);
        expect(out).toEqual({ tags: '1girl, moonlit lake, standing', resolution: 'landscape' });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.messages[0].content).toContain('需要出现角色时');
        expect(body.messages[0].content).toContain('不要写发色');
        expect(String(body.messages[1].content)).toContain('月下的湖边');
    });

    it('代码块包裹 / 前后有废话的 JSON 也能解析', () => {
        const out = parseTagSuggestion('好的，结果如下：\n```json\n{"tags":"forest, mist","resolution":"square"}\n```');
        expect(out).toEqual({ tags: 'forest, mist', resolution: 'square' });
    });

    it('JSON 挂了退回一行 tag：中文画幅后缀认、缺省竖图', () => {
        expect(parseTagSuggestion('girl, smiling | 横')).toEqual({ tags: 'girl, smiling', resolution: 'landscape' });
        expect(parseTagSuggestion('forest, mist')).toEqual({ tags: 'forest, mist', resolution: 'portrait' });
    });

    it('LLM 没配好时抛中文提示', async () => {
        await expect(suggestImageTags('hi', { id: 'c1', name: 'x' } as any, {} as any))
            .rejects.toThrow('LLM');
    });

    it('空回 / 全是废话时抛错', async () => {
        await expect(suggestImageTags('hi', { id: 'c1', name: 'x' } as any, API, llmReply('   ') as any))
            .rejects.toThrow();
        expect(parseTagSuggestion('```\n\n```')).toBeNull();
    });
});
