import type { APIConfig, ApiPreset } from '../types';

// Clipboard contents can carry zero-width characters that String.trim() does not
// remove. They are never valid at the edges of an API URL, token, or model id.
const EDGE_INVISIBLE_CHARS = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

const cleanEdgeCharacters = (value: unknown): string =>
  String(value ?? '').replace(EDGE_INVISIBLE_CHARS, '');

/** Base URL 结尾误带端点路径的常见写法；只剥这一个，不做通用猜测。 */
const CHAT_COMPLETIONS_SUFFIX = /\/chat\/completions$/i;

/** 输入（清洗后）是否以误填的 /chat/completions 结尾。保存提示用。 */
export const hasChatCompletionsSuffix = (value: unknown): boolean =>
  CHAT_COMPLETIONS_SUFFIX.test(cleanEdgeCharacters(value).replace(/\/+$/, ''));

export const normalizeApiBaseUrl = (value: unknown): string => {
  const cleaned = cleanEdgeCharacters(value).replace(/\/+$/, '');
  // 用户常把端点路径也填进 Base URL（如 .../v1/chat/completions），
  // 程序会在其后拼 /chat/completions、/models，带着这段就必 404。
  // 剥掉后可能残留尾斜杠，再清一次。
  return cleaned.replace(CHAT_COMPLETIONS_SUFFIX, '').replace(/\/+$/, '');
};

export const normalizeApiCredential = (value: unknown): string =>
  cleanEdgeCharacters(value);

export const normalizeApiModel = (value: unknown): string =>
  cleanEdgeCharacters(value);

export function normalizeApiConfig(config: APIConfig): APIConfig {
  const visionApi = config.visionApi;
  return {
    ...config,
    baseUrl: normalizeApiBaseUrl(config.baseUrl),
    apiKey: normalizeApiCredential(config.apiKey),
    model: normalizeApiModel(config.model),
    ...(visionApi ? {
      visionApi: {
        enabled: visionApi.enabled === true,
        baseUrl: normalizeApiBaseUrl(visionApi.baseUrl),
        apiKey: normalizeApiCredential(visionApi.apiKey),
        model: normalizeApiModel(visionApi.model),
      },
    } : {}),
  };
}

export function normalizeApiPreset(preset: ApiPreset): ApiPreset {
  return {
    ...preset,
    name: String(preset.name ?? '').trim(),
    config: normalizeApiConfig(preset.config),
  };
}
