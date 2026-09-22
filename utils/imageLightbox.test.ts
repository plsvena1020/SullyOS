import { describe, expect, it } from 'vitest';
import { shouldScrollImage, TALL_IMAGE_RATIO } from './imageLightbox';

describe('shouldScrollImage — 灯箱长图判定', () => {
    it('方形 / 普通横竖图 → 居中完整显示', () => {
        expect(shouldScrollImage(1000, 1000)).toBe(false);
        expect(shouldScrollImage(1920, 1080)).toBe(false);
        expect(shouldScrollImage(1000, 1500)).toBe(false);
    });

    it('高宽比超过阈值 → 按宽度铺满、纵向滚动', () => {
        expect(shouldScrollImage(1000, 1800)).toBe(true);
        expect(shouldScrollImage(1080, 4000)).toBe(true);
    });

    it('正好等于阈值不算长图（边界不进滚动档）', () => {
        expect(shouldScrollImage(1000, 1000 * TALL_IMAGE_RATIO)).toBe(false);
    });

    it('尺寸还不可用（0 / NaN）时按普通图处理', () => {
        expect(shouldScrollImage(0, 100)).toBe(false);
        expect(shouldScrollImage(100, 0)).toBe(false);
        expect(shouldScrollImage(NaN, 100)).toBe(false);
        expect(shouldScrollImage(100, NaN)).toBe(false);
    });
});
