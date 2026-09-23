// utils/momentsFeed.test.ts（Task 1 先建文件，后续任务追加用例）
import { describe, it, expect } from 'vitest';
import { AppID } from '../types';
describe('moments entry', () => {
  it('AppID.Moments 为 moments', () => { expect(AppID.Moments).toBe('moments'); });
});
describe('moments cover', () => {
  it('超 1MB 封面拒绝', async () => {
    const { coverSizeOk } = await import('./momentsFeed.js');
    expect(coverSizeOk(1024 * 1024 + 1)).toBe(false);
    expect(coverSizeOk(1024 * 1024)).toBe(true);
  });
});
