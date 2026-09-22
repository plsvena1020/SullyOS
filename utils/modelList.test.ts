import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractModelIds, fetchChatModelList, normalizeModelIds } from './modelList';

describe('model list normalization', () => {
    it('keeps strings and common object identifiers without leaking objects into the UI', () => {
        expect(normalizeModelIds([
            'gpt-4.1',
            { id: 'claude-sonnet-4' },
            { model: 'gemini-2.5-pro' },
            { name: 'deepseek-chat' },
            { unexpected: true },
            null,
            7,
            'gpt-4.1',
        ])).toEqual(['gpt-4.1', 'claude-sonnet-4', 'gemini-2.5-pro', 'deepseek-chat']);
    });

    it('accepts OpenAI-compatible and nested gateway response shapes', () => {
        expect(extractModelIds({ data: [{ id: 'gpt-4.1' }] })).toEqual(['gpt-4.1']);
        expect(extractModelIds({ data: { models: [{ model_name: 'nested-model' }] } })).toEqual(['nested-model']);
    });
});

describe('fetchChatModelList（浏览器拉 /models 唯一入口）', () => {
    const AGENT_KEY = 'os_api_config';
    const okJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    beforeEach(() => {
        localStorage.removeItem(AGENT_KEY);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('未配置中转：浏览器直连，key 放 Authorization', async () => {
        const seen: Array<{ url: string; init: RequestInit }> = [];
        const fake = vi.fn(async (url: string, init: RequestInit) => {
            seen.push({ url: String(url), init });
            return okJson({ data: [{ id: 'm1' }] });
        });
        vi.stubGlobal('fetch', fake);
        const out = await fetchChatModelList('https://api.example.com/v1/', 'sk-x');
        expect(out).toEqual(['m1']);
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe('https://api.example.com/v1/models');
        expect((seen[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-x');
    });

    it('Base URL 误带 /chat/completions：请求仍打到 /v1/models（不是 .../chat/completions/models）', async () => {
        const seen: Array<{ url: string; init: RequestInit }> = [];
        const fake = vi.fn(async (url: string, init: RequestInit) => {
            seen.push({ url: String(url), init });
            return okJson({ data: [{ id: 'm3' }] });
        });
        vi.stubGlobal('fetch', fake);
        const out = await fetchChatModelList('https://api.example.com/v1/chat/completions', 'sk-z');
        expect(out).toEqual(['m3']);
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe('https://api.example.com/v1/models');
    });

    it('已配置中转：走 /agent/v1/models 透传，key 不进 URL', async () => {
        localStorage.setItem(AGENT_KEY, JSON.stringify({ agentUrl: 'https://agent.example.com/', agentToken: 'agent-tok' }));
        const seen: Array<{ url: string; init: RequestInit }> = [];
        const fake = vi.fn(async (url: string, init: RequestInit) => {
            seen.push({ url: String(url), init });
            return okJson({ data: [{ id: 'm2' }] });
        });
        try {
            vi.stubGlobal('fetch', fake);
            const out = await fetchChatModelList('https://opencode.ai/zen/go/v1', 'sk-y');
            expect(out).toEqual(['m2']);
            expect(seen).toHaveLength(1);
            expect(seen[0].url).toBe(
                'https://agent.example.com/agent/v1/models?target='
                + encodeURIComponent('https://opencode.ai/zen/go/v1/models'),
            );
            const headers = seen[0].init.headers as Record<string, string>;
            expect(headers['X-Client-Token']).toBe('agent-tok');
            expect(headers['X-Relay-Target-Authorization']).toBe('Bearer sk-y');
            expect(seen[0].url).not.toContain('sk-y');
        } finally {
            localStorage.removeItem(AGENT_KEY);
        }
    });

    it('上游非 200 / 非法 JSON 按原样抛错', async () => {
        const bad = vi.fn(async () => okJson({ error: 'x' }, 401));
        vi.stubGlobal('fetch', bad);
        await expect(fetchChatModelList('https://a.example.com', 'k'))
            .rejects.toThrow('HTTP 401');
        const broken = vi.fn(async () => new Response('not-json', { status: 200 }));
        vi.stubGlobal('fetch', broken);
        await expect(fetchChatModelList('https://a.example.com', 'k'))
            .rejects.toThrow('模型列表不是合法 JSON');
    });
});
