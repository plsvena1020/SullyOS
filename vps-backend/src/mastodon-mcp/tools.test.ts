import { describe, it, expect, vi } from 'vitest';
import { TOOL_DEFS } from './tools.js';

const names = () => TOOL_DEFS.map((t) => t.name);
describe('tools', () => {
  it('8 个工具齐全', () => {
    expect(names()).toEqual(['moments_post','moments_upload','moments_delete','status_favourite','status_unfavourite','timeline_home','timeline_public','account_statuses']);
  });
  it('发帖缺正文又缺图被 schema 拒绝', () => {
    const post = TOOL_DEFS.find((t) => t.name === 'moments_post')!;
    expect(() => post.inputSchema.parse({ confirm: true })).toThrow();
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
});
