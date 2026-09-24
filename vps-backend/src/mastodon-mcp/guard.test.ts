import { describe, it, expect, vi } from 'vitest';
import { createGuard, WRITE_TOOLS } from './guard.js';

describe('guard', () => {
  it('只读模式拒绝写工具', () => {
    const g = createGuard({ readOnly: true, auditLogPath: '/tmp/x.jsonl' });
    expect(() => g.assertAllowed('moments_post', { confirm: true })).toThrow('只读模式');
  });
  it('写工具缺 confirm 拒绝', () => {
    const g = createGuard({ readOnly: false, auditLogPath: '/tmp/x.jsonl' });
    expect(() => g.assertAllowed('moments_delete', {})).toThrow('confirm:true');
  });
  it('审计行不含 token 且正文截断', async () => {
    const written: string[] = [];
    const g = createGuard({ readOnly: false, auditLogPath: '/tmp/x.jsonl', appendFile: async (_p: string, s: string) => { written.push(s); } });
    await g.audit({ tool: 'moments_post', ownerId: 'user', ok: true, status: 'x'.repeat(100), accessToken: 'SECRET' });
    expect(written[0]).not.toContain('SECRET');
    expect(JSON.parse(written[0]).statusPreview.length).toBeLessThanOrEqual(40);
  });
  it('读工具放行', () => {
    const g = createGuard({ readOnly: true, auditLogPath: '/tmp/x.jsonl' });
    expect(() => g.assertAllowed('timeline_public', {})).not.toThrow();
    expect(WRITE_TOOLS).toContain('status_favourite');
  });
});
