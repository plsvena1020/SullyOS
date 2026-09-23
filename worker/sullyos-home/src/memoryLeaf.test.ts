// worker/sullyos-home/src/memoryLeaf.test.ts
import { describe, it, expect } from 'vitest';
import { extractMemories } from './memoryLeaf';
describe('memoryLeaf', () => {
  it('闲聊不成记忆', () => {
    expect(extractMemories([{ role: 'user', content: '哈哈' }])).toEqual([]);
  });
  it('含事实句成记忆', () => {
    const out = extractMemories([{ role: 'user', content: '我下周三要去上海出差' }]);
    expect(out.length).toBe(1);
    expect(out[0].summary).toContain('上海');
  });
});
