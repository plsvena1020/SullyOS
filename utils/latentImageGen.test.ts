import { describe, expect, it, vi } from 'vitest';
import { generateLatentImage, queueLatentGeneration } from './latentImageGen';

type MockResp = {
    ok: boolean;
    status: number;
    body: any;
    blobBody?: Blob;
};

const jsonResp = (status: number, body: any): MockResp => ({ ok: status >= 200 && status < 300, status, body });

function makeFetch(script: MockResp[], calls: string[]) {
    let i = 0;
    return vi.fn(async (url: string, init?: any) => {
        const method = (init?.method || 'GET').toUpperCase();
        const u = String(url);
        const path = u.includes('/generate/status') ? 'status'
            : u.includes('/generate/') ? 'poll'
            : u.includes('/generate') ? 'submit'
            : u.includes('/media/') ? 'media' : 'unknown';
        calls.push(`${method} ${path}`);
        const resp = script[Math.min(i++, script.length - 1)];
        return {
            ok: resp.ok,
            status: resp.status,
            json: async () => resp.body,
            blob: async () => resp.blobBody ?? new Blob(['img'], { type: 'image/png' }),
            headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
        };
    });
}

const BASE = {
    apiKey: 'lat_sk_test',
    prompt: '1girl, silver hair',
    fetchImpl: undefined as any,
    pollIntervalMs: 1,
};

describe('generateLatentImage 参数校验', () => {
    it('缺 key 时抛中文提示', async () => {
        await expect(generateLatentImage({ ...BASE, apiKey: '  ' })).rejects.toThrow('Latent API Key');
    });

    it('空 prompt 时抛错', async () => {
        await expect(generateLatentImage({ ...BASE, prompt: '   ' })).rejects.toThrow();
    });
});

describe('generateLatentImage 完整链路', () => {
    it('status→提交→轮询→拉图全通，返回 blob 与 artworkId', async () => {
        const calls: string[] = [];
        const fetchImpl = makeFetch([
            jsonResp(200, { workersOnline: 2, queued: 0 }),
            jsonResp(202, { id: 'job-1', status: 'queued' }),
            jsonResp(200, { id: 'job-1', status: 'running', progress: 40 }),
            jsonResp(200, { id: 'job-1', status: 'succeeded', artworkId: 'art-1', seed: 42 }),
            jsonResp(200, {}),
        ], calls);
        const seen: any[] = [];
        const spy = vi.fn(async (url: string, init?: any) => {
            seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization });
            return fetchImpl(url, init);
        });

        const res = await generateLatentImage({ ...BASE, fetchImpl: spy, resolution: 'landscape' });
        expect(res.artworkId).toBe('art-1');
        expect(res.seed).toBe(42);
        expect(res.mimeType).toBe('image/png');
        expect(res.blob.size).toBeGreaterThan(0);
        expect(calls).toEqual(['GET status', 'POST submit', 'GET poll', 'GET poll', 'GET media']);
        // 提交体：prompt / resolution / 默认采样器·调度器·步数；鉴权头 Bearer
        expect(seen[1].body.prompt).toBe('1girl, silver hair');
        expect(seen[1].body.resolution).toBe('landscape');
        expect(seen[1].body.steps).toBe(12);
        expect(seen[1].body.sampler).toBe('er_sde');
        expect(seen[1].body.scheduler).toBe('linear_quadratic');
        expect(seen[1].auth).toBe('Bearer lat_sk_test');
    });

    it('步数超站点上限被 422 打回 → 按上限自动降级重提一次', async () => {
        const calls: string[] = [];
        const fetchImpl = makeFetch([
            jsonResp(200, { workersOnline: 1, queued: 0 }),
            jsonResp(422, { error: 'invalid_steps', message: 'steps must be <= 12' }),
            jsonResp(202, { id: 'job-1', status: 'queued' }),
            jsonResp(200, { id: 'job-1', status: 'succeeded', artworkId: 'art-1', seed: 7 }),
            jsonResp(200, {}),
        ], calls);
        const submitted: any[] = [];
        const spy = vi.fn(async (url: string, init?: any) => {
            if (init?.body) submitted.push(JSON.parse(init.body));
            return fetchImpl(url, init);
        });

        const res = await generateLatentImage({ ...BASE, steps: 16, fetchImpl: spy });

        expect(res.artworkId).toBe('art-1');
        expect(calls.filter(c => c === 'POST submit')).toHaveLength(2);
        expect(submitted[0].steps).toBe(16);
        expect(submitted[1].steps).toBe(12);
        // 降级只降步数，采样器/调度器照常
        expect(submitted[1].sampler).toBe('er_sde');
        expect(submitted[1].scheduler).toBe('linear_quadratic');
    });

    it('prompt 超 2000 字符被截断', async () => {
        const calls: string[] = [];
        const long = 'a'.repeat(2500);
        const fetchImpl = makeFetch([
            jsonResp(200, { workersOnline: 1, queued: 0 }),
            jsonResp(202, { id: 'job-1', status: 'queued' }),
            jsonResp(200, { id: 'job-1', status: 'succeeded', artworkId: 'art-1', seed: 1 }),
            jsonResp(200, {}),
        ], calls);
        const seen: any[] = [];
        const spy = vi.fn(async (url: string, init?: any) => {
            if (init?.body) seen.push(JSON.parse(init.body));
            return fetchImpl(url, init);
        });
        await generateLatentImage({ ...BASE, prompt: long, fetchImpl: spy });
        expect(seen[0].prompt).toHaveLength(2000);
    });

    it('GPU 离线时直接抛错不排队', async () => {
        const calls: string[] = [];
        const fetchImpl = makeFetch([jsonResp(200, { workersOnline: 0, queued: 5 })], calls);
        await expect(generateLatentImage({ ...BASE, fetchImpl })).rejects.toThrow('GPU');
        expect(calls).toEqual(['GET status']);
    });

    it('status 接口本身挂了 → 放行继续（fail-open）', async () => {
        const calls: string[] = [];
        const fetchImpl = makeFetch([
            jsonResp(502, { error: 'bad gateway' }),
            jsonResp(202, { id: 'job-1', status: 'queued' }),
            jsonResp(200, { id: 'job-1', status: 'succeeded', artworkId: 'art-1', seed: 1 }),
            jsonResp(200, {}),
        ], calls);
        const res = await generateLatentImage({ ...BASE, fetchImpl });
        expect(res.artworkId).toBe('art-1');
    });
});

describe('generateLatentImage 错误映射', () => {
    const submitErr = async (status: number, body: any) => {
        const calls: string[] = [];
        const fetchImpl = makeFetch([
            jsonResp(200, { workersOnline: 1, queued: 0 }),
            jsonResp(status, body),
        ], calls);
        return generateLatentImage({ ...BASE, fetchImpl });
    };

    it('401 → Key 无效', async () => {
        await expect(submitErr(401, { error: 'unauthorized' })).rejects.toThrow('Key');
    });

    it('409 → 并发已满', async () => {
        await expect(submitErr(409, { error: 'too_many_active' })).rejects.toThrow('并发');
    });

    it('429 → 周额度用尽', async () => {
        await expect(submitErr(429, { error: 'quota_exhausted' })).rejects.toThrow('额度');
    });

    it('503 → 队列已满', async () => {
        await expect(submitErr(503, { error: 'queue_full' })).rejects.toThrow('排队');
    });

    it('任务 failed → 带上 errorCode', async () => {
        const calls: string[] = [];
        const fetchImpl = makeFetch([
            jsonResp(200, { workersOnline: 1, queued: 0 }),
            jsonResp(202, { id: 'job-1', status: 'queued' }),
            jsonResp(200, { id: 'job-1', status: 'failed', errorCode: 'out_of_memory' }),
        ], calls);
        await expect(generateLatentImage({ ...BASE, fetchImpl })).rejects.toThrow('out_of_memory');
    });

    it('轮询超时 → 抛超时错', async () => {
        const calls: string[] = [];
        const fetchImpl = makeFetch([
            jsonResp(200, { workersOnline: 1, queued: 0 }),
            jsonResp(202, { id: 'job-1', status: 'queued' }),
            jsonResp(200, { id: 'job-1', status: 'running' }),
        ], calls);
        await expect(generateLatentImage({ ...BASE, fetchImpl, pollTimeoutMs: 5 })).rejects.toThrow('超时');
    });
});

describe('queueLatentGeneration 串行队列', () => {
    it('两个并发调用：第二个提交发生在第一个拉图之后', async () => {
        const calls: string[] = [];
        const oneJob = (art: string) => [
            jsonResp(200, { workersOnline: 1, queued: 0 }),
            jsonResp(202, { id: `job-${art}`, status: 'queued' }),
            jsonResp(200, { id: `job-${art}`, status: 'succeeded', artworkId: art, seed: 1 }),
            jsonResp(200, {}),
        ];
        const fetchImpl = makeFetch([...oneJob('a1'), ...oneJob('a2')], calls);
        const opts = { ...BASE, fetchImpl };
        const [r1, r2] = await Promise.all([
            queueLatentGeneration(opts),
            queueLatentGeneration(opts),
        ]);
        expect(r1.artworkId).toBe('a1');
        expect(r2.artworkId).toBe('a2');
        // 不串行的话两个 POST submit 会连在一起；串行时第二个 POST 在第一个 media 之后
        expect(calls.indexOf('POST submit')).toBeLessThan(calls.indexOf('GET media'));
        const submitIdx = calls.map((c, i) => (c === 'POST submit' ? i : -1)).filter(i => i >= 0);
        expect(submitIdx).toHaveLength(2);
        expect(submitIdx[1]).toBeGreaterThan(calls.indexOf('GET media'));
    });
});
