// bake-voice 三步编排核心（运行时无关，Node 侧两处共用）：
// - api/minimax/bake-voice.ts（Vercel serverless：req/res 适配）
// - server/bake-voice-middleware.ts（Vite dev 中间件：IncomingMessage/ServerResponse 适配）
// 中心 worker 的 POST /minimax/bake-voice（worker/index.js）是 edge 运行时独立实现，
// 逻辑对齐但不共用本文件。

const DOMESTIC_BASE = 'https://api.minimaxi.com';
const OVERSEAS_BASE = 'https://api.minimax.io';

export interface BakeVoiceUrls {
    t2a: string;
    upload: string;
    clone: string;
}

// Long text (~15s of speech) to ensure enough audio for voice cloning
export const CLONE_SOURCE_TEXT = '在一个阳光明媚的早晨，小鸟在枝头欢快地歌唱，微风轻轻拂过脸庞，带来了花朵的芬芳。远处的山峦在薄雾中若隐若现，宛如一幅水墨画。人们漫步在林荫小道上，享受着这难得的宁静时光。孩子们在草地上奔跑嬉戏，笑声回荡在空气中，让人感到无比温暖和幸福。';

export function resolveMinimaxUrls(parts: {
    bodyRegion?: unknown;
    headerRegion?: unknown;
    envRegion?: unknown;
}): BakeVoiceUrls {
    const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
    const region = norm(parts.bodyRegion) || norm(parts.headerRegion) || norm(parts.envRegion);
    const base = region === 'overseas' ? OVERSEAS_BASE : DOMESTIC_BASE;
    return {
        t2a: `${base}/v1/t2a_v2`,
        upload: `${base}/v1/files/upload`,
        clone: `${base}/v1/voice_clone`,
    };
}

export interface BakeVoiceInput {
    apiKey: string;
    voiceId: string;
    model?: string;
    ttsPayload: Record<string, any>;
    groupId?: string;
    region?: unknown;
    regionHeader?: unknown;
}

export interface BakeVoiceResult {
    file_id: string;
    voice_id: string;
    clone_data: any;
}

/**
 * 三步编排：T2A 合成长音频 → upload 拿 file_id → voice_clone 固定 voice_id。
 * 成功返回结果；任何一步失败抛 Error（调用方按各自运行时转成 HTTP 状态）。
 */
export async function runBakeVoice(
    input: BakeVoiceInput,
    deps?: { fetchImpl?: typeof fetch; envRegion?: unknown },
): Promise<BakeVoiceResult> {
    const { apiKey, voiceId, model, ttsPayload, groupId } = input;
    if (!apiKey) throw new Error('Missing apiKey');
    if (!voiceId) throw new Error('Missing voiceId');
    if (!ttsPayload) throw new Error('Missing ttsPayload');

    const envRegion = deps?.envRegion
        ?? (typeof process !== 'undefined' ? (process as any).env?.MINIMAX_REGION : '');
    const urls = resolveMinimaxUrls({ bodyRegion: input.region, headerRegion: input.regionHeader, envRegion });
    const fetchImpl = deps?.fetchImpl ?? fetch;

    // Step 1: Synthesize a long audio sample using T2A with timber_weights
    const t2aBody: Record<string, any> = {
        ...ttsPayload,
        text: CLONE_SOURCE_TEXT,
        stream: false,
        output_format: 'url',
        audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
    };
    if (groupId) t2aBody.group_id = groupId;

    console.log('[bake-voice] step 1: synthesizing long audio sample...', { target: urls.t2a });
    const t2aRes = await fetchImpl(urls.t2a, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(t2aBody),
    });
    const t2aData = await t2aRes.json() as any;
    const t2aStatus = t2aData?.base_resp?.status_code;
    if (typeof t2aStatus === 'number' && t2aStatus !== 0) {
        throw new Error(`T2A failed: ${t2aData?.base_resp?.status_msg || 'unknown'}`);
    }
    const audioRaw = t2aData?.data?.audio;
    if (!audioRaw || typeof audioRaw !== 'string') {
        throw new Error('T2A returned no audio');
    }

    // Get audio as Buffer
    let audioBuffer: Buffer;
    if (/^https?:\/\//i.test(audioRaw.trim())) {
        const audioRes = await fetchImpl(audioRaw.trim());
        if (!audioRes.ok) throw new Error(`Audio download failed: HTTP ${audioRes.status}`);
        audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    } else {
        // HEX format
        const cleanHex = audioRaw.trim().replace(/^0x/i, '');
        audioBuffer = Buffer.from(cleanHex, 'hex');
    }
    console.log(`[bake-voice] step 1 done: ${audioBuffer.length} bytes`);

    // Step 2: Upload audio to MiniMax for cloning
    const boundary = `----BakeVoice${Date.now()}`;
    const parts: Buffer[] = [];
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice_sample.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nvoice_clone\r\n`
    ));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const multipartBody = Buffer.concat(parts);

    console.log('[bake-voice] step 2: uploading audio for cloning...');
    const uploadRes = await fetchImpl(urls.upload, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody as any,
    });
    const uploadData = await uploadRes.json() as any;
    const fileId = uploadData?.file?.file_id;
    if (!fileId) {
        const msg = uploadData?.base_resp?.status_msg || JSON.stringify(uploadData);
        throw new Error(`Upload failed: ${msg}`);
    }
    console.log(`[bake-voice] step 2 done: file_id=${fileId}`);

    // Step 3: Call voice_clone
    console.log('[bake-voice] step 3: cloning voice...');
    const cloneRes = await fetchImpl(urls.clone, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            file_id: fileId,
            voice_id: voiceId,
            model: model || 'speech-2.8-hd',
            text: '你好，这是固定后的声音，听听看效果怎么样？',
            need_noise_reduction: false,
            need_volumn_normalization: true,
        }),
    });
    const cloneData = await cloneRes.json() as any;
    const cloneStatus = cloneData?.base_resp?.status_code;
    if (typeof cloneStatus === 'number' && cloneStatus !== 0) {
        throw new Error(`Clone failed: ${cloneData?.base_resp?.status_msg || JSON.stringify(cloneData)}`);
    }
    console.log(`[bake-voice] step 3 done: voice_id=${voiceId}`);

    return {
        file_id: fileId,
        voice_id: voiceId,
        clone_data: cloneData,
    };
}
