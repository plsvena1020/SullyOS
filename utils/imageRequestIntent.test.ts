import { describe, expect, it } from 'vitest';
import { looksLikeImageRequest, lastUserMessageWantsImage } from './imageRequestIntent';

describe('looksLikeImageRequest', () => {
    it('常见的要图说法都能命中', () => {
        for (const text of [
            '给我发个自拍',
            '拍张照片给我看看',
            '发张图',
            '画一张你现在的样子',
            '画张我们在海边的画',
            '给我看看你的样子',
            '看看你的脸',
            '想看你长什么样',
        ]) {
            expect(looksLikeImageRequest(text), text).toBe(true);
        }
    });

    it('普通闲聊不误判', () => {
        for (const text of ['今天好累', '我们在看动画片', '计划周末去爬山', '晚安']) {
            expect(looksLikeImageRequest(text), text).toBe(false);
        }
    });
});

describe('lastUserMessageWantsImage', () => {
    it('取最后一条 user 消息判定，忽略后面的 assistant', () => {
        expect(lastUserMessageWantsImage([
            { role: 'assistant', content: '在呢' },
            { role: 'user', content: '给我发张自拍' },
            { role: 'assistant', content: '好呀' },
        ])).toBe(true);
        expect(lastUserMessageWantsImage([
            { role: 'user', content: '给我发张自拍' },
            { role: 'user', content: '算了，今天先这样' },
        ])).toBe(false);
    });

    it('空数组 / undefined 不抛错', () => {
        expect(lastUserMessageWantsImage([])).toBe(false);
        expect(lastUserMessageWantsImage(undefined)).toBe(false);
    });
});
