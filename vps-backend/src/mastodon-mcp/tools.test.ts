import { describe, it, expect, vi } from 'vitest';
import { TOOL_DEFS } from './tools.js';

const names = () => TOOL_DEFS.map((t) => t.name);
describe('tools', () => {
  it('8 个工具齐全', () => {
    expect(names()).toEqual(['moments_post','moments_upload','moments_delete','status_favourite','status_unfavourite','timeline_home','timeline_public','account_statuses']);
  });
  it('发帖缺正文又缺图被拒（run 层）', async () => {
    const post = TOOL_DEFS.find((t) => t.name === 'moments_post')!;
    await expect(async () => post.run({ api: {}, accounts: [], guard: { assertAllowed: () => {}, audit: async () => {} } } as never, { confirm: true }))
      .rejects.toThrow('status 与 media_ids 至少其一');
  });
  it('8 个工具 schema 都是 ZodObject（SDK 注册要 .shape）', () => {
    for (const t of TOOL_DEFS) expect(typeof t.inputSchema.shape).toBe('object');
  });
  it('删帖标 destructive，读时间线标 readOnly+openWorld', () => {
    const del = TOOL_DEFS.find((t) => t.name === 'moments_delete')!;
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const pub = TOOL_DEFS.find((t) => t.name === 'timeline_public')!;
    expect(pub.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
  it('run 走守卫→选号→api→审计', async () => {
    const api = { postStatus: vi.fn(async () => ({ id: 's1', url: 'u', content: 'c', visibility: 'private', created_at: 't', in_reply_to_id: null, media_attachments: [] })) };
    const guard = { assertAllowed: vi.fn(), audit: vi.fn(async () => {}) };
    const accounts = [{ ownerId: 'user', instance: 'a.social', handle: '@u', accessToken: 'tok' }];
    const post = TOOL_DEFS.find((t) => t.name === 'moments_post')!;
    const out = await post.run({ api, accounts, guard } as never, { status: 'hi', confirm: true });
    expect(guard.assertAllowed).toHaveBeenCalledWith('moments_post', expect.anything());
    expect(api.postStatus).toHaveBeenCalledWith(expect.objectContaining({ instance: 'a.social', accessToken: 'tok', visibility: 'private' }));
    expect(guard.audit).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(out.structuredContent.id).toBe('s1');
  });
  it('READ_ONLY 拒绝也被审计', async () => {
    const audited: unknown[] = [];
    const guard = { assertAllowed: () => { throw new Error('只读模式'); }, audit: async (e: unknown) => { audited.push(e); } };
    const post = TOOL_DEFS.find((t) => t.name === 'moments_post')!;
    await expect(post.run({ api: {}, accounts: [], guard } as never, { status: 'hi', confirm: true })).rejects.toThrow('只读模式');
    expect(audited).toHaveLength(1);
  });
  it('点赞失败也被审计', async () => {
    const audited: unknown[] = [];
    const api = { favouriteStatus: async () => { throw new Error('boom'); } };
    const guard = { assertAllowed: () => {}, audit: async (e: unknown) => { audited.push(e); } };
    const fav = TOOL_DEFS.find((t) => t.name === 'status_favourite')!;
    await expect(fav.run({ api, accounts: [{ ownerId: 'user', instance: 'a.social', handle: '@u', accessToken: 't' }], guard } as never, { id: 's1', confirm: true })).rejects.toThrow('boom');
    expect(audited).toHaveLength(1);
  });
});
