import type { ApiPreset, Message, VisionApiConfig } from '../types';
import { DB } from './db';
import { extractContent, safeFetchJson } from './safeApi';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';
import { isBlobRef, resolveRefToDataUrl } from './blobRef';

export const VISION_DESCRIPTION_METADATA_KEY = 'visionDescription';

/** 设置页测试识图能力时发送的 48×48 白底紫色圆点 PNG。 */
export const VISION_API_TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADKSURBVGhD7Y+5DQMxDASvLtfmll2DDQYHHDYwfxGCdoBJFGg513dzLnzYDQZMw4BpGDANA568Xx+zVZQE4HEes6QC8JiMUcIBeECFEUIBOFypF3cADnbowRWAQ51aOScAB1Zo4YwA/HilGgzoVoMB3WqoAfjhajXUAAE/XakGA7rVYEC3GqYAAT9eoYVzAgQc6NTKWQECDnXowR0g4GClXkIBAg5XGCEcIOABGaOkAm7wGI9ZSgJu8Lh/VlEaMAEDpmHANAyYZvuAH2hIrK7auxVfAAAAAElFTkSuQmCC';

const VISION_PROMPT = `请准确、具体地描述图片中实际可见的内容，供另一个无法看图的对话模型理解。
请覆盖主体、动作、场景、重要物品、画面中的文字或界面信息；不要猜测画面外的信息，不要寒暄，只输出描述正文。`;

/**
 * 这个值还能拿去识图吗。三种形态都算数：内嵌的 data URL、网络地址，以及本机存的
 * 图片令牌（`blobref:`，二进制在 blob_assets 里，见 utils/blobRef.ts）——令牌发出去
 * 之前会由网络出口统一还原成 data URL（utils/apiBlobRefs.ts），这里只负责别把它
 * 误判成「图没了」。
 *
 * 判漏的后果是静默的：图明明在，识图这步却直接跳过或报「图片数据不可用」，
 * 界面上一点征兆都没有。
 */
const canDescribeImage = (value: unknown): value is string =>
  typeof value === 'string' && (/^(data:image\/|https?:\/\/)/i.test(value) || isBlobRef(value));

const inFlightDescriptions = new Map<string, Promise<string>>();

/** 把一份通用模型预设填入独立识图配置，不改变主 API 当前选择。 */
export const visionApiConfigFromPreset = (preset: ApiPreset, enabled = true): VisionApiConfig => ({
  enabled,
  baseUrl: normalizeApiBaseUrl(preset.config.baseUrl),
  apiKey: normalizeApiCredential(preset.config.apiKey),
  model: normalizeApiModel(preset.config.model),
});

export const isVisionApiReady = (config?: VisionApiConfig | null): config is VisionApiConfig =>
  config?.enabled === true
  && !!config.baseUrl?.trim()
  && !!config.apiKey?.trim()
  && !!config.model?.trim();

export const readVisionDescription = (message: Message): string => {
  const value = message.metadata?.[VISION_DESCRIPTION_METADATA_KEY];
  return typeof value === 'string' ? value.trim() : '';
};

const cleanDescription = (value: string): string => value
  .replace(/^\s*\[?图片\s*[：:]\s*/i, '')
  .replace(/\]\s*$/i, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 4000);

/** 调用 OpenAI 兼容视觉端点，把一张图片变成可交给纯文本模型的描述。 */
export interface VisionDescribeOptions {
  /** 覆盖默认的通用描述 prompt（默认 VISION_PROMPT）。 */
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function describeImageWithVisionApi(
  imageUrl: string,
  config: VisionApiConfig,
  options?: VisionDescribeOptions,
): Promise<string> {
  if (!isVisionApiReady(config)) {
    throw new Error('识图 API 已开启，但 URL、Key 或 Model 尚未填写完整');
  }
  if (!canDescribeImage(imageUrl)) {
    throw new Error('图片数据不可用，无法调用识图 API');
  }

  const existing = inFlightDescriptions.get(imageUrl);
  if (existing) return existing;

  const request = (async () => {
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
    const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model.trim(),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: options?.prompt || VISION_PROMPT },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
        temperature: options?.temperature ?? 0,
        max_tokens: options?.maxTokens ?? 1200,
        stream: false,
      }),
    }, 1, 60_000, { appName: '消息', purpose: '识图' });

    const description = cleanDescription(extractContent(data));
    if (!description) throw new Error('识图 API 没有返回图片描述');
    return description;
  })();

  inFlightDescriptions.set(imageUrl, request);
  try {
    return await request;
  } finally {
    inFlightDescriptions.delete(imageUrl);
  }
}

/**
 * B站卡片预览帧拼图识图：frames（blobref / data URL）拼成一张 3 列网格图，
 * 单次调用拿到覆盖全部画面的描述，写回 metadata.webpage.video.visionDescription。
 *
 * 计费红线：每张卡终身只花 1 次识图调用（已有缓存直接返回；失败返回原消息，
 * 加分项永不破坏聊天）。
 */
async function materializeWebpageCardFrames(message: Message, config: VisionApiConfig): Promise<Message> {
    try {
        const video: any = message.metadata?.webpage?.video;
        if (!video || typeof video !== 'object') return message;
        if (typeof video.visionDescription === 'string' && video.visionDescription.trim()) return message;
        const frames = Array.isArray(video.frames) ? video.frames.filter(canDescribeImage) : [];
        if (!frames.length) return message;
        if (typeof document === 'undefined') return message;
        const canvas = document.createElement('canvas');
        if (typeof canvas.getContext !== 'function') return message;
        const ctx = canvas.getContext('2d');
        if (!ctx || typeof createImageBitmap === 'undefined') return message;

        const dataUrls: string[] = [];
        for (const f of frames.slice(0, 6)) {
            try {
                const url = isBlobRef(f) ? await resolveRefToDataUrl(f) : f;
                if (url) dataUrls.push(url);
            } catch { /* 单帧解析失败跳过 */ }
        }
        if (!dataUrls.length) return message;
        const bitmaps: ImageBitmap[] = [];
        for (const url of dataUrls) {
            try {
                bitmaps.push(await createImageBitmap(await (await fetch(url)).blob()));
            } catch { /* 单帧加载失败跳过 */ }
        }
        if (!bitmaps.length) return message;
        const cols = 3, cellW = 320, cellH = 180;
        canvas.width = cols * cellW;
        canvas.height = Math.ceil(bitmaps.length / cols) * cellH;
        bitmaps.forEach((bm, i) => {
            try {
                ctx.drawImage(bm, (i % cols) * cellW, Math.floor(i / cols) * cellH, cellW, cellH);
                bm.close();
            } catch { /* ignore */ }
        });
        const description = await describeImageWithVisionApi(canvas.toDataURL('image/jpeg', 0.75), config);

        const prevWebpage: any = message.metadata?.webpage || {};
        const prevVideo: any = prevWebpage.video || {};
        const patch = {
            webpage: {
                ...prevWebpage,
                video: {
                    ...prevVideo,
                    [VISION_DESCRIPTION_METADATA_KEY]: description,
                    visionRecognizedAt: Date.now(),
                    visionModel: config.model.trim(),
                },
            },
        };
        // 先写回 DB 再调用主模型：下一轮与刷新页面后都会直接命中，不重复扣识图额度。
        await DB.updateMessageMetadata(message.id, prev => ({ ...(prev || {}), ...patch }));
        return { ...message, metadata: { ...(message.metadata || {}), ...patch } };
    } catch {
        return message;
    }
}

/**
 * 为聊天历史里的图片补齐识图描述。
 *
 * 描述写回消息 metadata，因此同一条图片消息后续聊天、重 roll、主动消息都只识别一次；
 * 同一批里内容完全相同的图片也会复用第一次结果。
 */
export async function materializeVisionDescriptions(
  messages: Message[],
  config?: VisionApiConfig | null,
): Promise<Message[]> {
  if (config?.enabled !== true) return messages;
  if (!isVisionApiReady(config)) {
    throw new Error('识图 API 已开启，但 URL、Key 或 Model 尚未填写完整');
  }

  const descriptionByImage = new Map<string, string>();
  const prepared: Message[] = [];

    for (const message of messages) {
        // B站预览帧（webpage_card.metadata.webpage.video.frames）：纯文本主模型 + 开识图时，
        // 把多帧拼成 1 张图调 1 次识图（按调用次数计费，帧再多也只花 1 次），描述写回卡片
        // metadata 永久缓存。无 canvas 的运行时（测试 / SSR / worker）直接跳过。
        if (message.type === 'webpage_card') {
            prepared.push(await materializeWebpageCardFrames(message, config));
            continue;
        }
        if (message.type !== 'image') {
            prepared.push(message);
            continue;
        }

    const cached = readVisionDescription(message);
    if (cached) {
      descriptionByImage.set(message.content, cached);
      prepared.push(message);
      continue;
    }

    const imageUrl = typeof message.content === 'string' ? message.content : '';
    // 纯文字备份会保留 image 消息但移除原图数据；这种历史沿用“图片已不可用”占位，
    // 不能因为新开了识图 API 就让整轮聊天失败。
    if (!canDescribeImage(imageUrl)) {
      prepared.push(message);
      continue;
    }
    const description = descriptionByImage.get(imageUrl)
      || await describeImageWithVisionApi(imageUrl, config);
    descriptionByImage.set(imageUrl, description);

    const metadata = {
      ...(message.metadata || {}),
      [VISION_DESCRIPTION_METADATA_KEY]: description,
      visionRecognizedAt: Date.now(),
      visionModel: config.model.trim(),
    };
    // 先写回 DB 再调用主模型：下一轮与刷新页面后都会直接命中，不重复扣识图额度。
    await DB.updateMessageMetadata(message.id, prev => ({ ...(prev || {}), ...metadata }));
    prepared.push({ ...message, metadata });
  }

  return prepared;
}
