import { describe, expect, it, vi } from 'vitest';
import {
    markImageGenStarted,
    markImageGenSettled,
    getPendingImageGenCount,
    subscribeImageGenPending,
} from './imageGenPending';

describe('imageGenPending · 生图进行中标记', () => {
    it('开始 +1、收尾 -1、归零删除；多余的 settle 不会带成负数', () => {
        markImageGenStarted('c-p1');
        expect(getPendingImageGenCount('c-p1')).toBe(1);
        markImageGenStarted('c-p1');
        expect(getPendingImageGenCount('c-p1')).toBe(2);
        markImageGenSettled('c-p1');
        expect(getPendingImageGenCount('c-p1')).toBe(1);
        markImageGenSettled('c-p1');
        expect(getPendingImageGenCount('c-p1')).toBe(0);
        markImageGenSettled('c-p1');
        expect(getPendingImageGenCount('c-p1')).toBe(0);
    });

    it('按角色隔离', () => {
        markImageGenStarted('c-pa');
        markImageGenStarted('c-pb');
        markImageGenSettled('c-pa');
        expect(getPendingImageGenCount('c-pa')).toBe(0);
        expect(getPendingImageGenCount('c-pb')).toBe(1);
        markImageGenSettled('c-pb');
    });

    it('订阅收到开始/结束通知，取消后不再收', () => {
        const fn = vi.fn();
        const unsub = subscribeImageGenPending(fn);
        markImageGenStarted('c-pc');
        expect(fn).toHaveBeenCalledTimes(1);
        markImageGenSettled('c-pc');
        expect(fn).toHaveBeenCalledTimes(2);
        unsub();
        markImageGenStarted('c-pc');
        markImageGenSettled('c-pc');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('空 charId 是空操作', () => {
        const fn = vi.fn();
        const unsub = subscribeImageGenPending(fn);
        markImageGenStarted('');
        markImageGenSettled('');
        expect(fn).not.toHaveBeenCalled();
        unsub();
    });
});
