import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { runImageGenReply, extractAppearanceFromPersona, extractAppearanceFromReferenceImage, generateImageBlobOnly, runImageGenTest } from './imageGenFlow';
import { getPendingImageGenCount } from './imageGenPending';

type MockResp = { ok: boolean; status: number; body: any };

const jsonResp = (status: number, body: any): MockResp => ({ ok: status >= 200 && status < 300, status, body });

function makeFetch(script: MockResp[]) {
    let i = 0;
    return vi.fn(async (_url: string, _init?: any) => {
        const resp = script[Math.min(i++, script.length - 1)];
        return {
            ok: resp.ok,
            status: resp.status,
            json: async () => resp.body,
            blob: async () => new Blob(['fake-png-bytes'], { type: 'image/png' }),
            headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
        };
    });
}

const GEN_SCRIPT: MockResp[] = [
    jsonResp(200, { workersOnline: 2, queued: 0 }),
    jsonResp(202, { id: 'job-1', status: 'queued' }),
    jsonResp(200, { id: 'job-1', status: 'succeeded', artworkId: 'art-9', seed: 7 }),
    jsonResp(200, {}),
];

const makeDeps = (overrides: any = {}) => ({
    apiConfig: {
        baseUrl: 'https://llm.test', apiKey: 'k', model: 'm',
        latentImageKey: 'lat_sk_test', imageGenEnabled: true,
    },
    char: { id: 'c-flow', name: '阿画', imageGenProfile: 'cat girl, silver hair' },
    userProfile: { name: '我' },
    characters: [{ id: 'c-flow', name: '阿画', imageGenProfile: 'cat girl, silver hair' }],
    contextMsgs: [],
    hooks: { addToast: vi.fn() },
    saveCharProfile: vi.fn(),
    ...overrides,
});

describe('runImageGenReply 落库链路', () => {
    it('生成成功 → image 消息落库（含档案替换后的 prompt）+ 进相册', async () => {
        const deps = makeDeps({ fetchImpl: makeFetch(GEN_SCRIPT) });
        await runImageGenReply(
            { prompt: '@阿画 sitting under moonlight', resolution: 'portrait' },
            deps as any,
        );

        const msgs = await DB.getRecentMessagesByCharId('c-flow', 50);
        const img = msgs.find(m => m.type === 'image');
        expect(img).toBeTruthy();
        expect(img!.content.startsWith('blobref:')).toBe(true);
        expect(img!.metadata?.imageGen?.prompt).toContain('cat girl, silver hair');
        expect(img!.metadata?.imageGen?.prompt).not.toContain('@阿画');
        expect(img!.metadata?.imageGen?.artworkId).toBe('art-9');

        const gallery = await DB.getGalleryImages('c-flow');
        expect(gallery.some(g => g.url === img!.content)).toBe(true);

        expect(deps.hooks.addToast).not.toHaveBeenCalledWith(expect.stringContaining('失败'), 'error');
    });

    it('缺 key → toast 提示，不落库', async () => {
        const deps = makeDeps({
            char: { id: 'c-nokey', name: '没钥匙', imageGenProfile: 'cat' },
            characters: [{ id: 'c-nokey', name: '没钥匙', imageGenProfile: 'cat' }],
            apiConfig: { baseUrl: 'https://llm.test', apiKey: 'k', model: 'm', latentImageKey: '', imageGenEnabled: true },
            fetchImpl: makeFetch(GEN_SCRIPT),
        });
        await runImageGenReply({ prompt: 'cat', resolution: 'portrait' }, deps as any);
        expect(deps.hooks.addToast).toHaveBeenCalledWith(expect.stringContaining('Key'), 'error');
        const msgs = await DB.getRecentMessagesByCharId('c-nokey', 50);
        expect(msgs.filter(m => m.type === 'image')).toHaveLength(0);
    });

    it('生成失败 → toast 错误，不落库', async () => {
        const deps = makeDeps({
            fetchImpl: makeFetch([
                jsonResp(200, { workersOnline: 1, queued: 0 }),
                jsonResp(429, { error: 'quota_exhausted' }),
            ]),
        });
        await runImageGenReply({ prompt: 'cat', resolution: 'portrait' }, deps as any);
        expect(deps.hooks.addToast).toHaveBeenCalledWith(expect.stringContaining('额度'), 'error');
    });
});

describe('runImageGenReply 外貌档案自动提取', () => {
    it('无档案时调一次 LLM 提取 → 存档 → 本次即用', async () => {
        const char: any = { id: 'c-new', name: '新人', systemPrompt: '银发猫耳少女，绿眼睛' };
        const seen: string[] = [];
        const fetchImpl = vi.fn(async (url: string, init?: any) => {
            seen.push(String(url));
            if (String(url).includes('/chat/completions')) {
                return {
                    ok: true, status: 200,
                    json: async () => ({ choices: [{ message: { content: 'cat girl, silver hair, green eyes' } }] }),
                    blob: async () => new Blob([]),
                    headers: { get: () => null },
                };
            }
            const script = GEN_SCRIPT;
            const idx = Math.min(seen.filter(u => !u.includes('/chat/completions')).length - 1, script.length - 1);
            const resp = script[idx];
            return {
                ok: resp.ok, status: resp.status,
                json: async () => resp.body,
                blob: async () => new Blob(['x'], { type: 'image/png' }),
                headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
            };
        });
        const deps = makeDeps({
            char,
            characters: [char],
            fetchImpl,
        });
        await runImageGenReply({ prompt: '@新人 smiling', resolution: 'portrait' }, deps as any);

        expect(deps.saveCharProfile).toHaveBeenCalledWith('c-new', 'cat girl, silver hair, green eyes');
        const msgs = await DB.getRecentMessagesByCharId('c-new', 50);
        const img = msgs.find(m => m.type === 'image');
        expect(img?.metadata?.imageGen?.prompt).toContain('silver hair');
    });
});

// 神经链接角色页的两个「自动解析」入口：从人设（主 API 文本提取）与从参考图
// （vision 路由）。手动入口必须可重试（不吃自动路径的失败缓存），失败抛人话。
describe('外貌提示词提取入口', () => {
    const tagFetch = (content: string) => vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
        blob: async () => new Blob([]),
        headers: { get: () => null },
    })) as any;

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('从角色设定提取：清洗成单行 tag；空输出抛错', async () => {
        const char = { id: 'c-persona', name: '小画', systemPrompt: '银发猫耳少女，绿眼睛' } as any;
        const apiConfig = { baseUrl: 'https://llm.test', apiKey: 'k', model: 'm' } as any;

        await expect(extractAppearanceFromPersona(char, apiConfig, tagFetch('"cat girl, silver hair"')))
            .resolves.toBe('cat girl, silver hair');
        await expect(extractAppearanceFromPersona(char, apiConfig, tagFetch('')))
            .rejects.toThrow(/人设/);
    });

    it('上传图片解析：visionApi 就绪时打识图端点，回落时打主 API', async () => {
        const stub = () => vi.fn(async () => new Response(JSON.stringify({
            choices: [{ message: { content: 'cat girl, green eyes' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));

        vi.stubGlobal('fetch', stub());
        const withVision = {
            baseUrl: 'https://main.test', apiKey: 'mk', model: 'mm',
            visionApi: { enabled: true, baseUrl: 'https://vision.test/v1', apiKey: 'vk', model: 'vm' },
        } as any;
        await expect(extractAppearanceFromReferenceImage('data:image/jpeg;base64,AAAA', withVision))
            .resolves.toBe('cat girl, green eyes');
        expect(String((globalThis.fetch as any).mock.calls[0][0])).toBe('https://vision.test/v1/chat/completions');

        vi.stubGlobal('fetch', stub());
        const noVision = { baseUrl: 'https://main.test', apiKey: 'mk', model: 'mm' } as any;
        await expect(extractAppearanceFromReferenceImage('data:image/jpeg;base64,BBBB', noVision))
            .resolves.toBe('cat girl, green eyes');
        expect(String((globalThis.fetch as any).mock.calls[0][0])).toBe('https://main.test/chat/completions');
    });

    it('上传图片解析：模型没给 tag 时抛错（不写回空串）', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            // 只有一对引号：识图层的描述清洗放行，tag 清洗层剥成空 → 必须抛错。
            choices: [{ message: { content: '""' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })));
        const apiConfig = { baseUrl: 'https://main.test', apiKey: 'mk', model: 'mm' } as any;
        await expect(extractAppearanceFromReferenceImage('data:image/jpeg;base64,CCCC', apiConfig))
            .rejects.toThrow(/没解析出/);
    });
});

// Spark 帖子首图等外部场景复用同一个生图内核：只返回 blobref 令牌，
// 不许往聊天记录 / 相册里写东西（那两处只属于聊天回复的图片消息）。
describe('generateImageBlobOnly 独立生图内核', () => {
    it('生成成功 → 只回令牌，不写聊天、不进相册', async () => {
        const char: any = { id: 'c-standalone', name: '阿画', imageGenProfile: 'cat girl, silver hair' };
        const deps = makeDeps({
            char,
            characters: [char],
            fetchImpl: makeFetch(GEN_SCRIPT),
        });
        const before = await DB.getRecentMessagesByCharId('c-standalone', 50);

        const result = await generateImageBlobOnly(
            { prompt: '@阿画 waving under moonlight', resolution: 'landscape' },
            deps as any,
        );

        expect(result.token.startsWith('blobref:')).toBe(true);
        expect(result.prompt).toContain('cat girl, silver hair');
        expect(result.prompt).not.toContain('@阿画');
        // 质量提示词是所有生图出口默认前置的（不靠调用方记得加）
        expect(result.prompt.startsWith('masterpiece, best quality')).toBe(true);
        expect(result.meta.artworkId).toBe('art-9');

        const after = await DB.getRecentMessagesByCharId('c-standalone', 50);
        expect(after.length, '不能写聊天消息').toBe(before.length);
        expect(await DB.getGalleryImages('c-standalone'), '不能进相册').toHaveLength(0);
    });

    it('缺 Key → 抛错（调用方自己决定怎么提示）', async () => {
        const deps = makeDeps({
            apiConfig: { baseUrl: 'https://llm.test', apiKey: 'k', model: 'm', latentImageKey: '', imageGenEnabled: true },
            fetchImpl: makeFetch(GEN_SCRIPT),
        });
        await expect(generateImageBlobOnly({ prompt: 'cat', resolution: 'portrait' }, deps as any))
            .rejects.toThrow(/Key/);
    });

    it('固定注入读角色档案：画风通用、性别仅在 @角色 时注入', async () => {
        const char: any = {
            id: 'c-style', name: '小画', imageGenProfile: 'long hair, red eyes',
            imageGenStyleTags: 'by wlop', imageGenGender: 'female',
        };
        const deps = makeDeps({ char, characters: [char], fetchImpl: makeFetch(GEN_SCRIPT) });

        const result = await generateImageBlobOnly(
            { prompt: '@小画 standing, 1girl', resolution: 'portrait' },
            deps as any,
        );

        expect(result.prompt).toBe(
            'masterpiece, best quality, amazing quality, very aesthetic, absurdres, '
            + '1girl, long hair, red eyes standing, by wlop',
        );
    });

    it('纯景色（prompt 没有 @角色）→ 不注入性别，但画风照常通用注入', async () => {
        const char: any = {
            id: 'c-scenery', name: '小画', imageGenProfile: 'long hair, red eyes',
            imageGenStyleTags: 'by wlop', imageGenGender: 'male',
        };
        const deps = makeDeps({ char, characters: [char], fetchImpl: makeFetch(GEN_SCRIPT) });

        const result = await generateImageBlobOnly(
            { prompt: 'misty forest, morning light', resolution: 'landscape' },
            deps as any,
        );

        expect(result.prompt).toContain('misty forest');
        expect(result.prompt).toContain('by wlop');
        expect(result.prompt).not.toContain('1boy');
        expect(result.prompt).not.toContain('male focus');
    });
});

// 设置页「测试生图」：固定测试词真跑一次，只回图（不落聊天 / 相册 / blob store）。
describe('runImageGenTest 设置页测试生图', () => {
    const API = {
        baseUrl: 'https://llm.test', apiKey: 'k', model: 'm',
        latentImageKey: 'lat_sk_test', imageGenEnabled: true,
    } as any;

    it('成功：回图 + 完整 prompt（质量词前置），不写聊天 / 相册', async () => {
        const before = await DB.getRecentMessagesByCharId('c-test-none', 50);

        const result = await runImageGenTest(API, { fetchImpl: makeFetch(GEN_SCRIPT) });

        expect(result.blob.size).toBeGreaterThan(0);
        expect(result.mimeType).toBe('image/png');
        expect(result.prompt.startsWith('masterpiece, best quality')).toBe(true);
        expect(result.prompt).toContain('silver hair');
        expect(result.seed).toBe(7);
        expect(result.artworkId).toBe('art-9');

        const after = await DB.getRecentMessagesByCharId('c-test-none', 50);
        expect(after.length, '测试不写聊天').toBe(before.length);
        expect(await DB.getGalleryImages('c-test-none'), '测试不进相册').toHaveLength(0);
    });

    it('缺 Key → 抛可直接展示的中文错误', async () => {
        await expect(runImageGenTest(
            { baseUrl: 'https://llm.test', apiKey: 'k', model: 'm' } as any,
            { fetchImpl: makeFetch(GEN_SCRIPT) },
        )).rejects.toThrow(/Key/);
    });

    it('额度用尽 → 原样抛出 latent 的中文映射', async () => {
        const fetchImpl = makeFetch([
            jsonResp(200, { workersOnline: 1, queued: 0 }),
            jsonResp(429, { error: 'quota_exhausted' }),
        ]);
        await expect(runImageGenTest(API, { fetchImpl })).rejects.toThrow(/额度/);
    });
});

// 「正在加载图片…」提示的接线：生成期间该角色 pending=1，收尾（成功/失败/缺 Key）都必须归零，
// 否则聊天页会永远挂着一条加载气泡。
describe('runImageGenReply 生图期间挂 pending 标记', () => {
    it('生成中 pending=1，完成后归零', async () => {
        const charId = `c-pend-ok-${Date.now()}`;
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const scripted = makeFetch(GEN_SCRIPT);
        const fetchImpl = vi.fn(async (url: string, init?: any) => {
            await gate;
            return scripted(url, init);
        });
        const char: any = { id: charId, name: '阿画', imageGenProfile: 'cat girl' };
        const deps = makeDeps({ char, characters: [char], fetchImpl });

        const pending = runImageGenReply({ prompt: 'cat', resolution: 'portrait' }, deps as any);
        expect(getPendingImageGenCount(charId), '生成中要亮灯').toBe(1);
        release();
        await pending;
        expect(getPendingImageGenCount(charId), '完成后必须熄灯').toBe(0);
    });

    it('缺 Key 不打标记（本来就不会生成，不亮灯）', async () => {
        const charId = `c-pend-nokey-${Date.now()}`;
        const char: any = { id: charId, name: '没钥匙', imageGenProfile: 'cat' };
        const deps = makeDeps({
            char,
            characters: [char],
            apiConfig: { baseUrl: 'https://llm.test', apiKey: 'k', model: 'm', latentImageKey: '', imageGenEnabled: true },
            fetchImpl: makeFetch(GEN_SCRIPT),
        });
        await runImageGenReply({ prompt: 'cat', resolution: 'portrait' }, deps as any);
        expect(getPendingImageGenCount(charId)).toBe(0);
    });

    it('生成失败也归零（不能留幽灵加载气泡）', async () => {
        const charId = `c-pend-fail-${Date.now()}`;
        const char: any = { id: charId, name: '会失败', imageGenProfile: 'cat' };
        const deps = makeDeps({
            char,
            characters: [char],
            fetchImpl: vi.fn(async () => { throw new Error('network down'); }) as any,
        });
        await runImageGenReply({ prompt: 'cat', resolution: 'portrait' }, deps as any);
        expect(getPendingImageGenCount(charId)).toBe(0);
    });
});
