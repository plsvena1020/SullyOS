// utils/momentsFeed.test.ts（Task 1 先建文件，后续任务追加用例）
import { describe, it, expect } from 'vitest';
import { AppID } from '../types';
describe('moments entry', () => {
  it('AppID.Moments 为 moments', () => { expect(AppID.Moments).toBe('moments'); });
});
