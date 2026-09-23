import { describe, it, expect } from 'vitest';
import { normInstance, buildAuthorizeUrl, useCodeGuard } from './mastodonOAuth.js';
describe('mastodonOAuth', () => {
  it('实例归一化', () => { expect(normInstance('HTTPS://Mstdn.Social/')).toBe('mstdn.social'); });
  it('授权地址带 scope 与回调', () => {
    const u = buildAuthorizeUrl({ instance: 'mstdn.social', clientId: 'cid', redirectUri: 'https://app/x/cb', scope: 'profile read:statuses' });
    expect(u).toContain('/oauth/authorize');
    expect(u).toContain('scope=profile');
  });
  it('同一 code 只消费一次', () => {
    const g = useCodeGuard();
    expect(g.take('c1')).toBe(true);
    expect(g.take('c1')).toBe(false);
  });
});
