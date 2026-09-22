/**
 * latentImageGen — latent.moe 生图客户端（公益站点 GPU 池）。
 *
 * 流程（照 openapi.json）：
 *   1. GET  /latent/generate/status        → GPU worker 在线检查（离线直接抛错，不白排队）
 *   2. POST /latent/generate               → 202 { id }（异步排队）
 *   3. GET  /latent/generate/{id}          → 轮询到 succeeded / failed / cancelled
 *   4. GET  /latent/media/{artworkId}?size=preview → 图片二进制
 *
 * 全部经 sfworker `/latent/*` 代理（latent.moe API 不发 CORS 头，浏览器直连会被拦；
 * worker 只做透传、不读不存 key——跟 /replicate、鱼声同一个信任模型）。
 * 地址走中心配置 getProxyWorkerUrl()，跟其他代理能力同一个源。
 */

import { getProxyWorkerUrl } from './proxyWorker';
import type { ImageGenResolution } from './imageGenTags';

export type LatentFetch = (url: string, init?: any) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<any>;
    blob: () => Promise<Blob>;
    headers: { get: (name: string) => string | null };
}>;

/** latent.moe 采样器枚举（openapi：euler / res_multistep / er_sde）。 */
export type LatentSampler = 'euler' | 'res_multistep' | 'er_sde';
/** latent.moe 调度器枚举（openapi：sgm_uniform / beta / beta57 / linear_quadratic）。 */
export type LatentScheduler = 'sgm_uniform' | 'beta' | 'beta57' | 'linear_quadratic';

/**
 * 全站生图默认参数：采样器 ER SDE + 调度器 Linear Quadratic + 12 步（latent.moe
 * 当前文档上限，openapi 2026-09-12：8–12）。采样器/调度器是官方枚举值，直接生效。
 * 提交值若超过上限会被 422 参数校验打回，此时按上限自动降级重提一次（见 LATENT_STEPS_MAX）。
 */
export const DEFAULT_LATENT_STEPS = 12;
export const LATENT_STEPS_MAX = 12;
export const LATENT_STEPS_MIN = 8;
export const DEFAULT_LATENT_SAMPLER: LatentSampler = 'er_sde';
export const DEFAULT_LATENT_SCHEDULER: LatentScheduler = 'linear_quadratic';

export interface LatentGenerateOptions {
    apiKey: string;
    prompt: string;
    negativePrompt?: string;
    resolution?: ImageGenResolution;
    seed?: number;
    /** 默认 DEFAULT_LATENT_STEPS(12)；超过站点上限时会被 422 打回并自动按上限重提。 */
    steps?: number;
    sampler?: LatentSampler;
    scheduler?: LatentScheduler;
    signal?: AbortSignal;
    /** 轮询状态回调（UI 进度用）。 */
    onStatus?: (stage: string, progress?: number) => void;
    /** 单测注入；缺省用全局 fetch。 */
    fetchImpl?: LatentFetch;
    /** 单测覆盖；默认 2000ms。 */
    pollIntervalMs?: number;
    /** 单测覆盖；默认 5 分钟。 */
    pollTimeoutMs?: number;
}

export interface LatentGenerateResult {
    blob: Blob;
    mimeType: string;
    artworkId: string;
    seed: number;
}

// latent.moe GenerationRequest.prompt 上限 2000 字符。
const PROMPT_MAX_LEN = 2000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

class AbortError extends Error {
    constructor() { super('aborted'); this.name = 'AbortError'; }
}

const checkAbort = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new AbortError();
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AbortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
});

const latentBase = (): string => `${getProxyWorkerUrl()}/latent`;

const authHeader = (apiKey: string): string =>
    apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;

async function readJsonSafe(res: { json: () => Promise<any> }): Promise<any> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

function mapSubmitError(status: number, data: any): string {
    const detail = data?.message || data?.error || '';
    const suffix = detail ? `：${String(detail).slice(0, 120)}` : '';
    if (status === 401) return `Latent Key 无效或已被撤销，请去「设置 → AI 生图」检查${suffix}`;
    if (status === 409) return `Latent 并发任务已满，稍后再试${suffix}`;
    if (status === 422) return `生图参数不合法${suffix}`;
    if (status === 429) return `本周生图额度用完了，下周再来${suffix}`;
    if (status === 503) return `Latent 站点排队已满，稍后再试${suffix}`;
    return `Latent 提交失败 (HTTP ${status})${suffix}`;
}

/**
 * 单次生图（提交 → 轮询 → 拉图）。抛出的 Error message 都是可直接 toast 的中文。
 */
export async function generateLatentImage(opts: LatentGenerateOptions): Promise<LatentGenerateResult> {
    const {
        signal,
        onStatus,
        pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
        pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    } = opts;
    const fetchImpl: LatentFetch = opts.fetchImpl ?? (fetch as unknown as LatentFetch);

    const apiKey = (opts.apiKey || '').trim();
    if (!apiKey) throw new Error('请先在「设置 → AI 生图」里填 Latent API Key (lat_sk_...)');
    const prompt = (opts.prompt || '').trim();
    if (!prompt) throw new Error('生图 prompt 为空');
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': authHeader(apiKey),
    };

    // ── 0. GPU 在线检查：离线直接抛错。检查接口本身挂了则放行（fail-open）。──
    onStatus?.('checking');
    try {
        const stRes = await fetchImpl(`${latentBase()}/generate/status`, { method: 'GET', headers, signal });
        const stData = await readJsonSafe(stRes);
        if (stRes.ok && stData && typeof stData.workersOnline === 'number' && stData.workersOnline <= 0) {
            throw new Error('Latent 站点 GPU 离线中，任务排了也不会开工，稍后再试');
        }
    } catch (e) {
        if (e instanceof AbortError) throw e;
        if (e instanceof Error && e.message.includes('GPU 离线')) throw e;
        // 状态接口不可用 → 继续走提交
    }
    checkAbort(signal);

    // ── 1. 提交 ──
    onStatus?.('queued');
    const requestedSteps = Math.max(
        LATENT_STEPS_MIN,
        Math.round(opts.steps ?? DEFAULT_LATENT_STEPS),
    );
    const buildSubmitBody = (steps: number) => JSON.stringify({
        prompt: prompt.slice(0, PROMPT_MAX_LEN),
        ...(opts.negativePrompt?.trim() ? { negativePrompt: opts.negativePrompt.trim().slice(0, PROMPT_MAX_LEN) } : {}),
        resolution: opts.resolution ?? 'portrait',
        steps,
        sampler: opts.sampler ?? DEFAULT_LATENT_SAMPLER,
        scheduler: opts.scheduler ?? DEFAULT_LATENT_SCHEDULER,
        ...(typeof opts.seed === 'number' ? { seed: opts.seed } : {}),
    });
    let submitRes = await fetchImpl(`${latentBase()}/generate`, {
        method: 'POST',
        headers,
        body: buildSubmitBody(requestedSteps),
        signal,
    });
    // 默认 12 步就是站点文档上限；万一调用方给了更大的值被 422 参数校验打回，
    // 按上限降级重提一次，别让功能因此整个不可用。
    if (!submitRes.ok && submitRes.status === 422 && requestedSteps > LATENT_STEPS_MAX) {
        console.warn(`[imageGen] Latent 拒绝 ${requestedSteps} 步（当前上限 ${LATENT_STEPS_MAX}），按上限重提`);
        submitRes = await fetchImpl(`${latentBase()}/generate`, {
            method: 'POST',
            headers,
            body: buildSubmitBody(LATENT_STEPS_MAX),
            signal,
        });
    }
    const submitData = await readJsonSafe(submitRes);
    if (!submitRes.ok) throw new Error(mapSubmitError(submitRes.status, submitData));
    const jobId: string | undefined = submitData?.id;
    if (!jobId) throw new Error('Latent 没返回任务 id');

    // ── 2. 轮询 ──
    const deadline = Date.now() + pollTimeoutMs;
    let artworkId = '';
    let seed = typeof opts.seed === 'number' ? opts.seed : 0;
    while (true) {
        checkAbort(signal);
        if (Date.now() > deadline) throw new Error('生图超时（>5 分钟），站点可能太忙，稍后可手动重试');
        await sleep(pollIntervalMs, signal);
        const pollRes = await fetchImpl(`${latentBase()}/generate/${encodeURIComponent(jobId)}`, {
            method: 'GET',
            headers,
            signal,
        });
        const job = await readJsonSafe(pollRes);
        const status = String(job?.status || '');
        onStatus?.(status, typeof job?.progress === 'number' ? job.progress : undefined);
        if (status === 'succeeded') {
            artworkId = String(job?.artworkId || '');
            if (!artworkId) throw new Error('Latent 任务成功但没返回 artworkId');
            if (typeof job?.seed === 'number') seed = job.seed;
            break;
        }
        if (status === 'failed') throw new Error(`Latent 生成失败${job?.errorCode ? `：${job.errorCode}` : ''}`);
        if (status === 'cancelled') throw new Error('Latent 任务被取消');
        // queued / leased / running → 继续等；异常 body 也继续等（瞬时抖动不杀整单）
    }

    // ── 3. 拉图 ──
    onStatus?.('downloading');
    checkAbort(signal);
    const mediaRes = await fetchImpl(`${latentBase()}/media/${encodeURIComponent(artworkId)}?size=preview`, {
        method: 'GET',
        headers,
        signal,
    });
    if (!mediaRes.ok) throw new Error(`下载生成图失败 (HTTP ${mediaRes.status})`);
    const mimeType = mediaRes.headers.get('Content-Type') || 'image/png';
    const blob = await mediaRes.blob();
    if (!blob || !blob.size) throw new Error('下载生成图为空文件');

    onStatus?.('done', 100);
    return { blob, mimeType, artworkId, seed };
}

// ── 串行队列：latent.moe 限制每账号并发，客户端一次只跑一张，后到的排队。──
let latentQueue: Promise<unknown> = Promise.resolve();

/**
 * 排队生图。多个并发调用按到达顺序串行执行；前一个失败不影响后一个。
 */
export function queueLatentGeneration(opts: LatentGenerateOptions): Promise<LatentGenerateResult> {
    const run = latentQueue.then(() => generateLatentImage(opts));
    // 链条本身永不 reject（失败只影响这一单的返回 promise）。
    latentQueue = run.catch(() => { /* 下一单照常 */ });
    return run;
}
