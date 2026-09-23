// utils/momentsFeed.ts
// 朋友圈纯函数：封面尺寸门（Task 2）；归一化/去重/映射（Task 3 追加）。
import type { SocialPost } from '../types';

export const MOMENTS_COVER_MAX_BYTES = 1024 * 1024;
export function coverSizeOk(dataUrlLengthBytes: number): boolean {
  return dataUrlLengthBytes <= MOMENTS_COVER_MAX_BYTES;
}

export function normalizeMastodonStatus(s: { id: string; url?: string | null; content?: string; visibility: string; created_at: string; in_reply_to_id?: string | null; media_attachments?: Array<{ id: string; url?: string | null }> }, instance: string, ownerId: string): SocialPost {
  return {
    id: `mastodon-${instance}-${s.id}`,
    authorName: ownerId, authorAvatar: '', title: '', tags: [],
    content: (s.content ?? '').replace(/<[^>]*>/g, ''),
    images: (s.media_attachments ?? []).map((m) => m.url ?? '').filter(Boolean),
    likes: 0, isCollected: false, isLiked: false, comments: [],
    timestamp: Date.parse(s.created_at) || Date.now(),
    origin: 'mastodon', mastodonStatusId: s.id, mastodonInstance: instance, mastodonOwnerId: ownerId,
  };
}

export function dedupeByRemoteId(local: SocialPost[], fresh: SocialPost[]): SocialPost[] {
  const known = new Set(local.map((p) => p.mastodonStatusId).filter(Boolean));
  return fresh.filter((p) => p.mastodonStatusId && !known.has(p.mastodonStatusId));
}

export function toMastodonVisibility(local: string | undefined): 'public' | 'unlisted' | 'private' | 'direct' {
  if (local === 'public') return 'unlisted';
  if (local === 'direct') return 'direct';
  return 'private';
}

// 发现页中文过滤：Mastodon language 字段为准（zh 开头全收：简/繁/粤）；缺失时看正文含 CJK 即收。
export function isChineseStatus(s: { language?: string | null; text: string }): boolean {
  if (s.language) return s.language.toLowerCase().startsWith('zh');
  return /[一-鿿㐀-䶿]/.test(s.text);
}
