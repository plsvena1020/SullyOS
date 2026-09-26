// vps-backend/src/mastodon-mcp/mastodonApi.js
// Mastodon REST 薄封装：Bearer + 幂等键 + 错误中文映射 + v2 发图轮询。
// 不碰磁盘、不记日志（审计在 guard.js）；纯函数式，可单测。
import { createHash } from 'node:crypto';

const trim = (s) => String(s ?? '').slice(0, 120);

export function mapMastodonError(status, body) {
  const raw = typeof body?.error === 'string' ? body.error : `HTTP ${status}`;
  if (status === 401) return 'Mastodon token 无效或被撤销，请重绑账号';
  if (status === 403 && raw.includes('outside the authorized scopes'))
    return '缺 scope：按 spec §2.5 对照表补申请后再试';
  if (status === 403) return `Mastodon 拒绝（403）：${trim(raw)}`;
  if (status === 422 && raw.includes('authenticated user'))
    return 'token 类型错误（app token 当 user token 用了），请重走授权拿 user token';
  if (status === 429) return 'Mastodon 限流（429），稍后再试';
  return `Mastodon HTTP ${status}：${trim(raw)}`;
}

const slim = (s) => ({
  id: s.id, url: s.url ?? null, content: s.content ?? '',
  visibility: s.visibility, created_at: s.created_at,
  in_reply_to_id: s.in_reply_to_id ?? null,
  media_attachments: (s.media_attachments ?? []).map((m) => ({ id: m.id, url: m.url })),
  account: s.account ? { display_name: s.account.display_name ?? '', username: s.account.username ?? '', avatar: s.account.avatar ?? '' } : null,
  language: s.language ?? null,
});

const idempotencyKeyOf = (payload) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

export function createMastodonClient({ fetchImpl = fetch, pollIntervalMs = 2000, pollMaxAttempts = 10 } = {}) {
  const req = async (instance, accessToken, method, path, { body, idempotent = false } = {}) => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    let payload = undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
      if (idempotent) headers['Idempotency-Key'] = idempotencyKeyOf(body);
    }
    const resp = await fetchImpl(`https://${instance}${path}`, { method, headers, body: payload });
    let data = null;
    try { data = await resp.json(); } catch { data = { error: `HTTP ${resp.status}` }; }
    if (!resp.ok) throw new Error(mapMastodonError(resp.status, data));
    return data;
  };

  return {
    postStatus: async ({ instance, accessToken, status, media_ids, visibility = 'private', sensitive, spoiler_text, in_reply_to_id, language }) => {
      const data = await req(instance, accessToken, 'POST', '/api/v1/statuses', {
        idempotent: true,
        body: { status, media_ids, visibility, sensitive, spoiler_text, in_reply_to_id, language },
      });
      return slim(data);
    },
    deleteStatus: (args) => req(args.instance, args.accessToken, 'DELETE', `/api/v1/statuses/${args.id}`).then(slim),
    favouriteStatus: (args) => req(args.instance, args.accessToken, 'POST', `/api/v1/statuses/${args.id}/favourite`).then(slim),
    unfavouriteStatus: (args) => req(args.instance, args.accessToken, 'POST', `/api/v1/statuses/${args.id}/unfavourite`).then(slim),
    homeTimeline: (args) => req(args.instance, args.accessToken, 'GET', `/api/v1/timelines/home?limit=${args.limit ?? 20}`).then((list) => list.map(slim)),
    publicTimeline: async ({ instance, accessToken, local, limit }) => {
      const q = new URLSearchParams({ limit: String(limit ?? 20) });
      if (local) q.set('local', 'true');
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const resp = await fetchImpl(`https://${instance}/api/v1/timelines/public?${q}`, { headers });
      let data = null;
      try { data = await resp.json(); } catch { data = { error: `HTTP ${resp.status}` }; }
      if (!resp.ok) {
        // 匿名读被要求登录 = 该实例关闭了公开预览，不是 token 类型错。
        if (!accessToken && resp.status === 422) throw new Error('该实例要求登录才能读公开流，绑定账号后即可看「发现」');
        throw new Error(mapMastodonError(resp.status, data));
      }
      return data.map(slim);
    },
    accountStatuses: async ({ instance, accessToken, accountId, limit }) => {
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const resp = await fetchImpl(`https://${instance}/api/v1/accounts/${accountId}/statuses?limit=${limit ?? 20}`, { headers });
      let data = null;
      try { data = await resp.json(); } catch { data = { error: `HTTP ${resp.status}` }; }
      if (!resp.ok) throw new Error(mapMastodonError(resp.status, data));
      return data.map(slim);
    },
    verifyCredentials: async ({ instance, accessToken }) => {
      const v = await req(instance, accessToken, 'GET', '/api/v1/accounts/verify_credentials');
      return { id: v.id, username: v.username, acct: v.acct, display_name: v.display_name ?? '' };
    },
    uploadMedia: async ({ instance, accessToken, fileBase64, mimeType, description }) => {
      const form = new FormData();
      const bytes = Buffer.from(fileBase64, 'base64');
      form.set('file', new Blob([bytes], { type: mimeType }), 'upload');
      if (description) form.set('description', description);
      const up = await fetchImpl(`https://${instance}/api/v2/media`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form,
      });
      let media = null;
      try { media = await up.json(); } catch { media = { error: `HTTP ${up.status}` }; }
      if (!up.ok) throw new Error(mapMastodonError(up.status, media));
      for (let i = 0; i < pollMaxAttempts; i++) {
        if (media.url) return media.id;
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        media = await req(instance, accessToken, 'GET', `/api/v1/media/${media.id}`);
      }
      throw new Error('媒体转码超时（10 轮未出 url），请稍后用该 media id 重试发帖');
    },
  };
}
