import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, Message, UserProfile, VisionApiConfig } from '../types';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { materializeVisionDescriptions, visionApiConfigFromPreset, describeImageWithVisionApi } from './visionApi';

const config: VisionApiConfig = {
  enabled: true,
  baseUrl: 'https://vision.example.com/v1',
  apiKey: 'vision-key',
  model: 'vision-model',
};

const image = 'data:image/jpeg;base64,AAAA';

const message = (id: number): Message => ({
  id,
  charId: 'char-1',
  role: 'user',
  type: 'image',
  content: image,
  timestamp: 1_700_000_000_000 + id,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('independent vision API', () => {
  it('can load a generic model preset into vision without carrying unrelated main-model options', () => {
    expect(visionApiConfigFromPreset({
      id: 'preset-1',
      name: '视觉模型',
      config: {
        baseUrl: ' https://vision.example.com/v1/// ',
        apiKey: '\u200Bvision-key\u2060',
        model: ' vision-model ',
        stream: true,
        temperature: 1.2,
      },
    })).toEqual(config);
  });

  it('recognizes identical image data once, writes both message caches, then reuses them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '一只黑猫坐在窗边，窗外正在下雨。' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const updateSpy = vi.spyOn(DB, 'updateMessageMetadata').mockResolvedValue(undefined);

    const prepared = await materializeVisionDescriptions([message(1), message(2)], config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(prepared.map(item => item.metadata?.visionDescription)).toEqual([
      '一只黑猫坐在窗边，窗外正在下雨。',
      '一只黑猫坐在窗边，窗外正在下雨。',
    ]);

    await materializeVisionDescriptions(prepared, config);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('feeds the main model a text placeholder instead of image_url when enabled', () => {
    const described = {
      ...message(3),
      metadata: { visionDescription: '一张写着「周五见」的聊天截图。' },
    };
    const { apiMessages } = ChatPrompts.buildMessageHistory(
      [described],
      10,
      { id: 'char-1', name: 'Sully' } as CharacterProfile,
      { name: 'User' } as UserProfile,
      [],
      undefined,
      { useVisionDescriptions: true },
    );

    expect(typeof apiMessages[0].content).toBe('string');
    expect(apiMessages[0].content).toContain('[图片：一张写着「周五见」的聊天截图。]');
    expect(JSON.stringify(apiMessages)).not.toContain('image_url');
    expect(JSON.stringify(apiMessages)).not.toContain('data:image');
  });

  it('keeps the legacy multimodal payload when vision API is not selected', () => {
    const described = {
      ...message(4),
      metadata: { visionDescription: '旧缓存不应在关闭时改变原逻辑' },
    };
    const { apiMessages } = ChatPrompts.buildMessageHistory(
      [described],
      10,
      { id: 'char-1', name: 'Sully' } as CharacterProfile,
      { name: 'User' } as UserProfile,
      [],
    );

    expect(Array.isArray(apiMessages[0].content)).toBe(true);
    expect(JSON.stringify(apiMessages)).toContain('image_url');
    expect(JSON.stringify(apiMessages)).toContain(image);
  });

  // 角色生图提示词的「上传图片解析」复用这条调用，但要求模型输出 danbooru tag
  // 而不是通用描述——prompt / 采样参数必须能透传，且默认行为不受影响。
  it('custom prompt / maxTokens / temperature 透传（外貌 tag 解析用）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'cat girl, silver hair' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await describeImageWithVisionApi(image, config, {
      prompt: '解析外貌 tag',
      maxTokens: 300,
      temperature: 0.2,
    });

    expect(out).toBe('cat girl, silver hair');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.messages[0].content[0].text).toBe('解析外貌 tag');
    expect(body.max_tokens).toBe(300);
    expect(body.temperature).toBe(0.2);
  });

  describe('webpage_card 帧拼图识图（B站预览帧）', () => {
    const card = (id: number, video: any): Message => ({
      id,
      charId: 'char-1',
      role: 'user',
      type: 'webpage_card',
      content: '测试视频',
      timestamp: 1_700_000_000_000 + id,
      metadata: {
        webpage: {
          title: '测试视频', siteName: '哔哩哔哩', content: '',
          finalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', video,
        },
      },
    } as Message);

    it('已有画面描述缓存时不调用识图', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const prepared = await materializeVisionDescriptions(
        [card(11, { frames: [image], visionDescription: '街景与人群' })],
        config,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect((prepared[0].metadata as any)?.webpage?.video?.visionDescription).toBe('街景与人群');
    });

    it('无 canvas 环境跳过拼图：不调用识图、不写库、消息原样返回', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const updateSpy = vi.spyOn(DB, 'updateMessageMetadata').mockResolvedValue(undefined);
      const input = card(12, { frames: [image] });
      const prepared = await materializeVisionDescriptions([input], config);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      expect(prepared[0]).toBe(input);
    });
  });
});
