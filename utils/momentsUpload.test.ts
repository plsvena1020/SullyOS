import { describe, expect, test } from 'vitest';
import { buildUploadArgs, parseUploadResult, POST_IMAGE_MAX_BYTES, stripDataUrlPrefix, uploadThenPost } from './momentsUpload';

describe('stripDataUrlPrefix', () => {
  test('去掉 dataURL 前缀', () => {
    expect(stripDataUrlPrefix('data:image/png;base64,aGk=')).toBe('aGk=');
  });
  test('纯 base64 原样返回', () => {
    expect(stripDataUrlPrefix('aGk=')).toBe('aGk=');
  });
});

describe('buildUploadArgs', () => {
  test('组出服务端要的形状且 confirm 为 true', () => {
    expect(buildUploadArgs({ ownerId: 'user', dataUrl: 'data:image/png;base64,aGk=', mimeType: 'image/png', alt: 'a' })).toEqual({
      ownerId: 'user', fileBase64: 'aGk=', mimeType: 'image/png', description: 'a', confirm: true,
    });
  });
  test('空 alt 回退默认', () => {
    expect(buildUploadArgs({ ownerId: 'user', dataUrl: 'aGk=', mimeType: 'image/png', alt: '  ' }).description).toBe('朋友圈配图');
  });
});

describe('parseUploadResult', () => {
  test('structuredContent.media_id（展开与包两层都认）', () => {
    expect(parseUploadResult({ success: true, data: { media_id: 'm1' } })).toBe('m1');
    expect(parseUploadResult({ success: true, data: { structuredContent: { media_id: 'm2' } } })).toBe('m2');
  });
  test('文本回退：rawText 里 media_id= 解析', () => {
    expect(parseUploadResult({ success: true, rawText: '上传成功 media_id=m3' })).toBe('m3');
  });
  test('失败返回 null', () => {
    expect(parseUploadResult({ success: false, rawText: 'x' })).toBeNull();
  });
});

describe('POST_IMAGE_MAX_BYTES', () => {
  test('上限为 10MB', () => {
    expect(POST_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

const okUpload = async () => ({ success: true, data: { media_id: 'm1' } });
const okPost = async () => ({ success: true, data: { id: 's1' } });

describe('uploadThenPost', () => {
  test('有图：先 upload 再 post，media_ids 带上，ownerId 一致', async () => {
    const calls: Array<[string, any]> = [];
    const callTool = async (name: string, args: any) => {
      calls.push([name, args]);
      return name === 'moments_upload' ? okUpload() : okPost();
    };
    const r = await uploadThenPost({
      callTool, ownerId: 'user', status: 'hi', visibility: 'private',
      image: { dataUrl: 'data:image/png;base64,aGk=', mimeType: 'image/png', alt: 'a' },
    });
    expect(r).toEqual({ mediaId: 'm1', posted: true, cancelled: false, postRes: { data: { id: 's1' }, rawText: undefined } });
    expect(r.postRes).not.toBeNull();
    expect(calls[0][0]).toBe('moments_upload');
    expect(calls[0][1]).toMatchObject({ ownerId: 'user', fileBase64: 'aGk=', confirm: true });
    expect(calls[1][0]).toBe('moments_post');
    expect(calls[1][1]).toMatchObject({ ownerId: 'user', media_ids: ['m1'], confirm: true });
  });
  test('upload 失败：回退纯文字发帖', async () => {
    const events: string[] = [];
    const callTool = async (name: string) =>
      name === 'moments_upload' ? { success: false, error: 'boom' } : okPost();
    const r = await uploadThenPost({
      callTool, ownerId: 'user', status: 'hi', visibility: 'private',
      image: { dataUrl: 'data:image/png;base64,aGk=', mimeType: 'image/png', alt: 'a' },
      onEvent: (e) => { events.push(e.kind); },
    });
    expect(r.posted).toBe(true);
    expect(r.mediaId).toBeNull();
    expect(events).toContain('upload_failed');
  });
  test('无图：只调 post，不带 media_ids', async () => {
    const calls: Array<[string, any]> = [];
    const r = await uploadThenPost({ callTool: async (n, a) => { calls.push([n, a]); return okPost(); }, ownerId: 'user', status: 'hi', visibility: 'private', image: null });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('moments_post');
    expect(calls[0][1]).not.toHaveProperty('media_ids');
    expect(r.postRes).not.toBeNull();
  });
  test('有图编排透出 post 回执 structuredContent', async () => {
    const callTool = async (name: string, _args: any) => {
      if (name === 'moments_upload') return { success: true, data: { media_id: 'm1' } };
      return { success: true, data: { id: 's1' }, rawText: '..', structuredContent: { media_id: 'm1' } };
    };
    const r = await uploadThenPost({
      callTool, ownerId: 'user', status: 'hi', visibility: 'private',
      image: { dataUrl: 'data:image/png;base64,aGk=', mimeType: 'image/png', alt: 'a' },
    });
    expect((r.postRes as any)?.structuredContent?.media_id).toBe('m1');
  });
});
