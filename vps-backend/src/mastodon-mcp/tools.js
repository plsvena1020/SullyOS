// vps-backend/src/mastodon-mcp/tools.js
// 8 工具定义：zod schema + annotations + run（解析→守卫→选号→api→审计）。
// parse-first：run 入口先过 inputSchema.parse，保证 zod 默认值（如 visibility=private）与 refine 生效。
// audit-all：守卫拒绝/选号失败/api 失败全部落审计行（成功失败都记）。
import { z } from 'zod';
import { resolveAccount } from './accounts.js';

const ownerId = z.string().optional().describe('身份：user 或角色 id，空=默认第 0 个账号');
const confirm = z.boolean().describe('写操作二次确认，必须传 true');
const visibility = z.enum(['public', 'unlisted', 'private', 'direct']).default('private')
  .describe('可见度，默认 private（仅粉丝，防路人）');
const limit = z.number().int().min(1).max(40).default(20).describe('条数 1-40');

const textOf = (s) => `id=${s.id} 可见度=${s.visibility} 链接=${s.url ?? '无'}`;

const MomentsPostInput = z.object({
  ownerId, status: z.string().max(500).optional().describe('正文（无 media_ids 时必填）'),
  media_ids: z.array(z.string()).optional().describe('附件 id（先调 moments_upload 拿）'),
  visibility, sensitive: z.boolean().optional(), spoiler_text: z.string().optional(),
  in_reply_to_id: z.string().optional().describe('回复目标 status id'),
  language: z.string().optional(), confirm,
}).refine((a) => a.status || (a.media_ids && a.media_ids.length), 'status 与 media_ids 至少其一');

const MomentsUploadInput = z.object({
  ownerId, fileBase64: z.string().describe('文件 base64'),
  mimeType: z.string().default('image/png'), description: z.string().describe('无障碍 alt，必填'), confirm,
});

const IdInput = (desc) => z.object({ ownerId, id: z.string().describe(desc), confirm });

const TimelineInput = z.object({ ownerId, limit });

const PublicTimelineInput = z.object({ ownerId, local: z.boolean().optional(), limit });

const AccountStatusesInput = z.object({ ownerId, accountId: z.string(), limit });

// 统一审计包装：fn(ctx, parsed) 的抛错（含守卫拒绝）全部记 ok:false 再抛出。
const audited = (tool, fn) => async (ctx, p) => {
  try {
    const out = await fn(ctx, p);
    await ctx.guard.audit({ tool, ownerId: out.ownerId, ok: true, ...(out.status ? { status: out.status } : {}) });
    return out.result;
  } catch (e) {
    await ctx.guard.audit({ tool, ownerId: p.ownerId ?? '', ok: false, error: e.message });
    throw e;
  }
};

export const TOOL_DEFS = [
  {
    name: 'moments_post', description: '以所选身份发帖（可带图、可回复）。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: MomentsPostInput,
    run: (ctx, a) => audited('moments_post', async (c, p) => {
      c.guard.assertAllowed('moments_post', p);
      const acc = resolveAccount(c.accounts, p.ownerId);
      const s = await c.api.postStatus({ instance: acc.instance, accessToken: acc.accessToken, ...p });
      return { ownerId: acc.ownerId, status: s.content, result: { content: [{ type: 'text', text: `已发布：${textOf(s)}` }], structuredContent: s } };
    })(ctx, MomentsPostInput.parse(a)),
  },
  {
    name: 'moments_upload', description: '上传图片拿 media id（v2 异步，服务端轮询转码）。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: MomentsUploadInput,
    run: (ctx, a) => audited('moments_upload', async (c, p) => {
      c.guard.assertAllowed('moments_upload', p);
      const acc = resolveAccount(c.accounts, p.ownerId);
      const id = await c.api.uploadMedia({ instance: acc.instance, accessToken: acc.accessToken, ...p });
      return { ownerId: acc.ownerId, result: { content: [{ type: 'text', text: `上传成功 media_id=${id}` }], structuredContent: { media_id: id } } };
    })(ctx, MomentsUploadInput.parse(a)),
  },
  {
    name: 'moments_delete', description: '删自己的一条帖子。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: IdInput('status id'),
    run: (ctx, a) => audited('moments_delete', async (c, p) => {
      c.guard.assertAllowed('moments_delete', p);
      const acc = resolveAccount(c.accounts, p.ownerId);
      const s = await c.api.deleteStatus({ instance: acc.instance, accessToken: acc.accessToken, id: p.id });
      return { ownerId: acc.ownerId, result: { content: [{ type: 'text', text: `已删除 id=${s.id}` }], structuredContent: s } };
    })(ctx, IdInput('status id').parse(a)),
  },
  {
    name: 'status_favourite', description: '点赞。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: IdInput('status id'),
    run: (ctx, a) => audited('status_favourite', async (c, p) => {
      c.guard.assertAllowed('status_favourite', p);
      const acc = resolveAccount(c.accounts, p.ownerId);
      const s = await c.api.favouriteStatus({ instance: acc.instance, accessToken: acc.accessToken, id: p.id });
      return { ownerId: acc.ownerId, result: { content: [{ type: 'text', text: `已点赞：${textOf(s)}` }], structuredContent: s } };
    })(ctx, IdInput('status id').parse(a)),
  },
  {
    name: 'status_unfavourite', description: '取消点赞。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: IdInput('status id'),
    run: (ctx, a) => audited('status_unfavourite', async (c, p) => {
      c.guard.assertAllowed('status_unfavourite', p);
      const acc = resolveAccount(c.accounts, p.ownerId);
      const s = await c.api.unfavouriteStatus({ instance: acc.instance, accessToken: acc.accessToken, id: p.id });
      return { ownerId: acc.ownerId, result: { content: [{ type: 'text', text: `已取消点赞 id=${s.id}` }], structuredContent: s } };
    })(ctx, IdInput('status id').parse(a)),
  },
  {
    name: 'timeline_home', description: '读所选身份的 home 时间线。只读。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: TimelineInput,
    run: (ctx, a) => audited('timeline_home', async (c, p) => {
      c.guard.assertAllowed('timeline_home', p);
      const acc = resolveAccount(c.accounts, p.ownerId);
      const list = await c.api.homeTimeline({ instance: acc.instance, accessToken: acc.accessToken, limit: p.limit });
      return { ownerId: acc.ownerId, result: { content: [{ type: 'text', text: `取回 ${list.length} 条` }], structuredContent: { statuses: list } } };
    })(ctx, TimelineInput.parse(a)),
  },
  {
    name: 'timeline_public', description: '刷公开流（local 可选只看本站）。只读，可匿名。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: PublicTimelineInput,
    run: (ctx, a) => audited('timeline_public', async (c, p) => {
      c.guard.assertAllowed('timeline_public', p);
      const acc = p.ownerId ? resolveAccount(c.accounts, p.ownerId) : { instance: process.env.MASTODON_DEFAULT_INSTANCE || 'mastodon.social', accessToken: '' };
      const list = await c.api.publicTimeline({ instance: acc.instance, accessToken: acc.accessToken || undefined, local: p.local, limit: p.limit });
      return { ownerId: p.ownerId ?? '', result: { content: [{ type: 'text', text: `取回 ${list.length} 条` }], structuredContent: { statuses: list } } };
    })(ctx, PublicTimelineInput.parse(a)),
  },
  {
    name: 'account_statuses', description: '读某账号的帖子列表。只读。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: AccountStatusesInput,
    run: (ctx, a) => audited('account_statuses', async (c, p) => {
      c.guard.assertAllowed('account_statuses', p);
      const acc = p.ownerId ? resolveAccount(c.accounts, p.ownerId) : { instance: process.env.MASTODON_DEFAULT_INSTANCE || 'mastodon.social', accessToken: '' };
      const list = await c.api.accountStatuses({ instance: acc.instance, accessToken: acc.accessToken || undefined, accountId: p.accountId, limit: p.limit });
      return { ownerId: p.ownerId ?? '', result: { content: [{ type: 'text', text: `取回 ${list.length} 条` }], structuredContent: { statuses: list } } };
    })(ctx, AccountStatusesInput.parse(a)),
  },
];
