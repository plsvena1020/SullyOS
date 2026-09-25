// 纯函数：朋友圈发帖带图。无 React 依赖，可单测。
export const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // Mastodon 图片默认上限对齐
export const ACCEPTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function stripDataUrlPrefix(dataUrl: string): string {
  const i = dataUrl.indexOf(';base64,');
  return i >= 0 ? dataUrl.slice(i + ';base64,'.length) : dataUrl;
}

export function altTextOrFallback(alt: string, fallback = '朋友圈配图'): string {
  return alt.trim() || fallback;
}

export function buildUploadArgs(input: { ownerId: string; dataUrl: string; mimeType: string; alt: string }) {
  return {
    ownerId: input.ownerId,
    fileBase64: stripDataUrlPrefix(input.dataUrl),
    mimeType: input.mimeType,
    description: altTextOrFallback(input.alt),
    confirm: true as const,
  };
}

export function parseUploadResult(res: { success: boolean; data?: any; rawText?: string }): string | null {
  if (!res.success) return null;
  const d = res.data as any;
  if (typeof d?.media_id === 'string' && d.media_id) return d.media_id;
  if (typeof d?.structuredContent?.media_id === 'string' && d.structuredContent.media_id) return d.structuredContent.media_id;
  const m = /media_id=([A-Za-z0-9_-]+)/.exec(res.rawText ?? (typeof d === 'string' ? d : ''));
  return m ? m[1] : null;
}

export type UploadCallTool = (
  toolName: string,
  args: Record<string, any>,
) => Promise<{ success: boolean; data?: any; rawText?: string; error?: string }>;

export type UploadPostEventKind = 'uploaded' | 'upload_failed' | 'posted' | 'post_failed' | 'cancelled';

export async function uploadThenPost(input: {
  callTool: UploadCallTool;
  ownerId: string;
  status: string;
  visibility: 'public' | 'unlisted' | 'private' | 'direct';
  image?: { dataUrl: string; mimeType: string; alt: string } | null;
  onEvent?: (e: { kind: UploadPostEventKind; message?: string }) => void;
}): Promise<{ mediaId: string | null; posted: boolean; cancelled: boolean }> {
  const { callTool, ownerId, status, visibility, image, onEvent } = input;
  let mediaId: string | null = null;
  if (image) {
    const up = await callTool('moments_upload', buildUploadArgs({ ownerId, dataUrl: image.dataUrl, mimeType: image.mimeType, alt: image.alt }));
    if (!up.success && /拒绝/.test(up.error ?? '')) {
      onEvent?.({ kind: 'cancelled' });
      return { mediaId: null, posted: false, cancelled: true };
    }
    mediaId = parseUploadResult(up);
    if (mediaId) onEvent?.({ kind: 'uploaded' });
    else onEvent?.({ kind: 'upload_failed', message: up.error });
  }
  const postArgs: Record<string, any> = { ownerId, status, visibility, confirm: true };
  if (mediaId) postArgs.media_ids = [mediaId];
  const post = await callTool('moments_post', postArgs);
  if (!post.success && /拒绝/.test(post.error ?? '')) {
    onEvent?.({ kind: 'cancelled' });
    return { mediaId, posted: false, cancelled: true };
  }
  onEvent?.({ kind: post.success ? 'posted' : 'post_failed', message: post.error });
  return { mediaId, posted: post.success, cancelled: false };
}
