import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanTextForTtsGenie,
  isGenieVoiceEnabled,
  resolveGenieEmotion,
  synthesizeSpeechGenieDetailed,
} from './genieTts';

const AGENT = 'https://agent.test';

function makeResponse(status: number, body: ArrayBuffer | string, contentType = 'audio/wav') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
    text: async () => (typeof body === 'string' ? body : new TextDecoder().decode(body)),
  } as unknown as Response;
}

describe('synthesizeSpeechGenieDetailed', () => {
  // Genie 是独立开关，不进 TtsProvider；阶段 A 是 opt-in，测试里必须显式写 true。
  const apiConfig = { genieVoiceEnabled: true, ttsProvider: 'minimax' } as any;
  const char = { id: 'c1' } as any;

  beforeEach(() => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: AGENT, agentToken: 'tok' }));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:genie-1', revokeObjectURL: () => {} } as any);
  });
  afterEach(() => {
    localStorage.removeItem('os_api_config');
    vi.unstubAllGlobals();
  });

  it('成功时返回 url 与 blob 两个字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, new ArrayBuffer(2048))));
    const res = await synthesizeSpeechGenieDetailed('你好', char, apiConfig, { emotion: 'happy' });
    expect(res.url).toBe('blob:genie-1');
    expect(res.blob).toBeInstanceOf(Blob);
  });

  it('agentUrl 结尾带斜杠时不产生双斜杠', async () => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: `${AGENT}/`, agentToken: 'tok' }));
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试', char, apiConfig);
    const [url] = fetchMock.mock.calls[0] as any;
    expect(String(url)).toBe(`${AGENT}/agent/v1/tts`);
    // 注意不能断言 not.toContain('//agent')：AGENT 是 https://agent.test，
    // 协议后的 // 紧跟主机名 agent，这个子串天然存在，与实现无关。
    // 真正要防的是 host 与 path 之间出现双斜杠（test//agent）。
    expect(String(url)).not.toContain('test//agent');
  });

  it('带上 X-Client-Token 鉴权头与 emotion', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试文本', char, apiConfig, { emotion: 'sad' });
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.headers['X-Client-Token']).toBe('tok');
    const body = JSON.parse(init.body);
    expect(body.text).toBe('测试文本');
    expect(body.emotion).toBe('sad');
  });

  it('发送前已剥掉语音标签与字幕，只剩正文', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed(
      '<语音 emotion="happy">(laughs)今天真开心</语音><字幕>今天真开心</字幕>',
      char,
      apiConfig,
    );
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(JSON.parse(init.body).text).toBe('今天真开心');
  });

  it('503 busy 抛出可读的中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(503, '{"error":"busy"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/忙/);
  });

  it('504 抛出超时错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(504, '{"error":"synth_timeout"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/超时/);
  });

  it('413 抛出文本过长错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(413, '{"error":"chunk_too_long"}', 'application/json')));
    // ERROR_TEXT.chunk_too_long 的文案是「太长」，不是「过长」——断言要跟实现一致。
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/太长/);
  });
});

describe('isGenieVoiceEnabled', () => {
  it('阶段 A 是 opt-in：undefined 不算开启（老用户零行为变化）', () => {
    expect(isGenieVoiceEnabled({} as any)).toBe(false);
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: undefined } as any)).toBe(false);
  });
  it('只有显式 true 才开启', () => {
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: true } as any)).toBe(true);
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: false } as any)).toBe(false);
  });
});

describe('resolveGenieEmotion', () => {
  it('auto 模式跟随 options.emotion', () => {
    expect(resolveGenieEmotion({ emotion: 'sad' }, {} as any)).toBe('sad');
  });
  it('auto 模式遇非白名单回落 calm', () => {
    expect(resolveGenieEmotion({ emotion: 'disgusted' }, {} as any)).toBe('calm');
    expect(resolveGenieEmotion(undefined, {} as any)).toBe('calm');
  });
  it('fixed 模式忽略 options.emotion，用配置值', () => {
    expect(resolveGenieEmotion(
      { emotion: 'sad' },
      { genieEmotionMode: 'fixed', genieEmotion: 'angry' } as any,
    )).toBe('angry');
  });
  it('fixed 模式配置值非法时回落 calm', () => {
    expect(resolveGenieEmotion(
      undefined,
      { genieEmotionMode: 'fixed', genieEmotion: 'nope' } as any,
    )).toBe('calm');
  });
});

describe('cleanTextForTtsGenie', () => {
  it('只保留 <语音> 块内的正文', () => {
    expect(cleanTextForTtsGenie('你说真的假的？<语音 emotion="surprised">Wait, are you serious?</语音><字幕>等等……你是认真的？</字幕>'))
      .toBe('Wait, are you serious?');
  });

  it('剥掉 MiniMax 停顿标记与动作词', () => {
    expect(cleanTextForTtsGenie('你好<#0.5#>世界')).toBe('你好世界');
  });
});
