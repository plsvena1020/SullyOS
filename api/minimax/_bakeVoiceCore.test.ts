import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLONE_SOURCE_TEXT, resolveMinimaxUrls, runBakeVoice } from './_bakeVoiceCore';

const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const okT2a = () => json({ base_resp: { status_code: 0 }, data: { audio: '0a0b0c' } });
const okUpload = () => json({ file: { file_id: 'fid-1' } });
const okClone = () => json({ base_resp: { status_code: 0 }, data: {} });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('resolveMinimaxUrls', () => {
    it('默认国内，overseas 切海外（body 优先于 header 和 env）', () => {
        expect(resolveMinimaxUrls({}).t2a).toContain('api.minimaxi.com');
        expect(resolveMinimaxUrls({ bodyRegion: 'overseas' }).t2a).toContain('api.minimax.io');
        expect(resolveMinimaxUrls({ headerRegion: 'OVERSEAS' }).clone).toContain('api.minimax.io');
        expect(resolveMinimaxUrls({ bodyRegion: 'domestic', headerRegion: 'overseas' }).t2a).toContain('api.minimaxi.com');
    });
});

describe('runBakeVoice', () => {
    it('缺参直接抛，不发请求', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(runBakeVoice({ apiKey: '', voiceId: 'v', ttsPayload: {} } as any, { fetchImpl: fetchMock as any })).rejects.toThrow('Missing apiKey');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('三步成功返回 file_id/voice_id（hex 音频不走下载）', async () => {
        const calls: string[] = [];
        const fetchMock = vi.fn(async (input: any) => {
            const url = String(input);
            calls.push(url);
            if (url.includes('/t2a_v2')) return okT2a();
            if (url.includes('/files/upload')) return okUpload();
            if (url.includes('/voice_clone')) return okClone();
            throw new Error(`unexpected ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);
        const result = await runBakeVoice(
            { apiKey: 'k', voiceId: 'v1', ttsPayload: { voice_setting: {} } },
            { fetchImpl: fetchMock as any },
        );
        expect(result).toEqual({ file_id: 'fid-1', voice_id: 'v1', clone_data: expect.anything() });
        expect(calls).toHaveLength(3);
    });

    it('T2A 业务失败直接抛，不再往下走', async () => {
        const fetchMock = vi.fn(async () => json({ base_resp: { status_code: 1004, status_msg: 'auth failed' } }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(runBakeVoice(
            { apiKey: 'k', voiceId: 'v1', ttsPayload: {} },
            { fetchImpl: fetchMock as any },
        )).rejects.toThrow('T2A failed: auth failed');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('CLONE_SOURCE_TEXT 非空（克隆需要长音频）', () => {
        expect(CLONE_SOURCE_TEXT.length).toBeGreaterThan(50);
    });
});
