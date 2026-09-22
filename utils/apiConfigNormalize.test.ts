import { describe, expect, it } from 'vitest';
import {
  hasChatCompletionsSuffix,
  normalizeApiBaseUrl,
  normalizeApiConfig,
  normalizeApiCredential,
} from './apiConfigNormalize';

describe('API config normalization', () => {
  it('removes pasted whitespace and invisible edge characters from credentials', () => {
    expect(normalizeApiCredential(' \n\u200Bsk-example\u2060\r ')).toBe('sk-example');
  });

  it('normalizes the base URL without touching its path', () => {
    expect(normalizeApiBaseUrl('  https://api.example.com/v1///\u200B ')).toBe('https://api.example.com/v1');
  });

  // Base URL 约定填到 /v1 为止；用户常把端点也填进去，程序再拼 /chat/completions
  // 或 /models 就必 404（api.example.com/v1/chat/completions/models）。
  it('strips a trailing /chat/completions mistakenly pasted into the base URL', () => {
    expect(normalizeApiBaseUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1');
    expect(normalizeApiBaseUrl(' https://api.example.com/v1/chat/Completions/\u200B ')).toBe('https://api.example.com/v1');
  });

  it('is idempotent for valid base URLs and only strips the suffix at the end', () => {
    expect(normalizeApiBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(normalizeApiBaseUrl('https://api.example.com/chat/completions/v1'))
      .toBe('https://api.example.com/chat/completions/v1');
  });

  it('hasChatCompletionsSuffix only fires for the trailing endpoint (case/whitespace tolerant)', () => {
    expect(hasChatCompletionsSuffix('https://api.example.com/v1/chat/completions')).toBe(true);
    expect(hasChatCompletionsSuffix('https://api.example.com/v1/chat/completions///\u200B')).toBe(true);
    expect(hasChatCompletionsSuffix('https://api.example.com/v1/chat/Completions')).toBe(true);
    expect(hasChatCompletionsSuffix('https://api.example.com/v1')).toBe(false);
    expect(hasChatCompletionsSuffix('https://api.example.com/chat/completions/v1')).toBe(false);
  });

  it('keeps unrelated API settings intact', () => {
    expect(normalizeApiConfig({
      baseUrl: ' https://api.example.com/v1/ ',
      apiKey: '\uFEFFsk-test\u200B',
      model: ' gpt-test ',
      stream: true,
      temperature: 0.7,
      minimaxApiKey: 'mini-key',
      visionApi: {
        enabled: true,
        baseUrl: ' https://vision.example.com/v1/// ',
        apiKey: '\u200Bvision-key\u2060',
        model: ' vision-model ',
      },
    })).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      stream: true,
      temperature: 0.7,
      minimaxApiKey: 'mini-key',
      visionApi: {
        enabled: true,
        baseUrl: 'https://vision.example.com/v1',
        apiKey: 'vision-key',
        model: 'vision-model',
      },
    });
  });
});
