import { describe, expect, it } from 'vitest';
import { extractGenImageTags, resolveAppearanceRefs, stripGenImageTags, composeImagePrompt, mentionsCharacterRef } from './imageGenTags';

describe('extractGenImageTags', () => {
    it('parses a basic tag with explicit resolution', () => {
        const reqs = extractGenImageTags('今晚的月色真美\n[[GEN_IMAGE: 1girl, silver hair, moonlight | landscape]]');
        expect(reqs).toHaveLength(1);
        expect(reqs[0].prompt).toBe('1girl, silver hair, moonlight');
        expect(reqs[0].resolution).toBe('landscape');
    });

    it('defaults to portrait when no resolution suffix', () => {
        const reqs = extractGenImageTags('[[GEN_IMAGE: 1girl, smile]]');
        expect(reqs).toHaveLength(1);
        expect(reqs[0].prompt).toBe('1girl, smile');
        expect(reqs[0].resolution).toBe('portrait');
    });

    it('accepts Chinese resolution words', () => {
        expect(extractGenImageTags('[[GEN_IMAGE: cat | 横]]')[0].resolution).toBe('landscape');
        expect(extractGenImageTags('[[GEN_IMAGE: cat | 竖]]')[0].resolution).toBe('portrait');
        expect(extractGenImageTags('[[GEN_IMAGE: cat | 方]]')[0].resolution).toBe('square');
    });

    it('treats unknown trailing segment as part of the prompt, not resolution', () => {
        const reqs = extractGenImageTags('[[GEN_IMAGE: 1girl | sunset]]');
        expect(reqs).toHaveLength(1);
        expect(reqs[0].prompt).toBe('1girl | sunset');
        expect(reqs[0].resolution).toBe('portrait');
    });

    it('ignores empty prompts', () => {
        expect(extractGenImageTags('[[GEN_IMAGE:   ]]')).toHaveLength(0);
        expect(extractGenImageTags('[[GEN_IMAGE: | portrait]]')).toHaveLength(0);
    });

    it('returns empty array when no tag present', () => {
        expect(extractGenImageTags('今晚吃火锅吗')).toHaveLength(0);
    });

    it('collapses inner whitespace and newlines in prompt', () => {
        const reqs = extractGenImageTags('[[GEN_IMAGE: 1girl,\n  silver   hair]]');
        expect(reqs[0].prompt).toBe('1girl, silver hair');
    });

    // 模型手滑变体：全角冒号 / 中括号间空格 / 收尾空格——以前会漏解析、标签原样漏进气泡。
    it('tolerates full-width colon and stray spaces', () => {
        const fullWidth = extractGenImageTags('[[GEN_IMAGE：1girl, cat | 竖]]');
        expect(fullWidth).toHaveLength(1);
        expect(fullWidth[0].prompt).toBe('1girl, cat');
        expect(fullWidth[0].resolution).toBe('portrait');

        const spaced = extractGenImageTags('[[ GEN_IMAGE ： 1girl, moonlight ]]');
        expect(spaced).toHaveLength(1);
        expect(spaced[0].prompt).toBe('1girl, moonlight');
    });
});

describe('stripGenImageTags', () => {
    it('removes the tag but keeps surrounding text', () => {
        const out = stripGenImageTags('第一句\n[[GEN_IMAGE: 1girl | portrait]]\n第二句');
        expect(out).not.toContain('GEN_IMAGE');
        expect(out).toContain('第一句');
        expect(out).toContain('第二句');
    });

    it('also strips the full-width / spaced variants', () => {
        const out = stripGenImageTags('看这个\n[[ GEN_IMAGE：1girl, cat ]]\n好看吧');
        expect(out).not.toContain('GEN_IMAGE');
        expect(out).toContain('看这个');
        expect(out).toContain('好看吧');
    });

    it('leaves text without tags untouched', () => {
        expect(stripGenImageTags('纯文本')).toBe('纯文本');
    });
});

describe('resolveAppearanceRefs', () => {
    const profiles = [
        { names: ['Sully', '小苏'], tags: 'cat girl, silver hair, green eyes' },
        { names: ['阿白'], tags: 'white fox ears, red eyes' },
    ];

    it('replaces @name with the archived appearance tags', () => {
        const out = resolveAppearanceRefs('@Sully sitting under moonlight', profiles);
        expect(out).toBe('cat girl, silver hair, green eyes sitting under moonlight');
    });

    it('matches nicknames too', () => {
        const out = resolveAppearanceRefs('@小苏 和 @阿白 在喝茶', profiles);
        expect(out).toContain('cat girl, silver hair, green eyes');
        expect(out).toContain('white fox ears, red eyes');
    });

    it('leaves unknown @refs untouched', () => {
        expect(resolveAppearanceRefs('@路人甲 走过', profiles)).toBe('@路人甲 走过');
    });

    it('prefers the longest matching name to avoid prefix shadowing', () => {
        const ps = [
            { names: ['小白'], tags: 'SHORT' },
            { names: ['小白脸'], tags: 'LONG' },
        ];
        expect(resolveAppearanceRefs('@小白脸 笑了', ps)).toBe('LONG 笑了');
    });

    it('名字大小写不敏感（模型把 @Sully 写成 @sully 也认）', () => {
        expect(resolveAppearanceRefs('@sully smiling', profiles))
            .toBe('cat girl, silver hair, green eyes smiling');
    });
});

// 提示词合成：质量词 / 性别 / 主体 / 画风固定注入四层合并，必须不重复、不打架。
describe('mentionsCharacterRef', () => {
    it('大小写不敏感，且要求是一个完整的 @引用', () => {
        expect(mentionsCharacterRef('@Sully smiling', 'sully')).toBe(true);
        expect(mentionsCharacterRef('@sully smiling', 'Sully')).toBe(true);
        expect(mentionsCharacterRef('sully smiling', 'Sully')).toBe(false);
        expect(mentionsCharacterRef('@Sullyface', 'Sully')).toBe(false);
        expect(mentionsCharacterRef('', 'Sully')).toBe(false);
    });
});

describe('composeImagePrompt', () => {
    const Q = 'masterpiece, best quality';

    it('顺序为 质量词 → 性别 → 主体 → 画风；全部去重（大小写不敏感）', () => {
        const out = composeImagePrompt('1boy, moonlight, lake, Best Quality', {
            qualityTags: Q,
            gender: 'male',
            styleTags: 'by wlop, watercolor, MOONLIGHT',
        });
        expect(out).toBe('masterpiece, best quality, 1boy, moonlight, lake, by wlop, watercolor');
    });

    it('显式性别会剔除主体/画风里的性别标记（含裸 male/female），不打架', () => {
        const out = composeImagePrompt('1girl, female, smiling', {
            qualityTags: Q,
            gender: 'male',
            styleTags: 'by artist, male',
        });
        expect(out).toBe('masterpiece, best quality, 1boy, smiling, by artist');
    });

    it('不传性别时原样保留（聊天自动生图不受影响）', () => {
        const out = composeImagePrompt('1girl, silver hair', { qualityTags: Q });
        expect(out).toBe('masterpiece, best quality, 1girl, silver hair');
    });

    it('纯景色（无性别、无角色 tag）只合并质量词与画风', () => {
        const out = composeImagePrompt('misty forest, morning light', {
            qualityTags: Q,
            styleTags: 'by guweiz',
        });
        expect(out).toBe('masterpiece, best quality, misty forest, morning light, by guweiz');
    });

    it('中文逗号也能切分，空层不产生多余逗号', () => {
        const out = composeImagePrompt('girl，smiling', { qualityTags: Q, styleTags: '  ' });
        expect(out).toBe('masterpiece, best quality, girl, smiling');
    });
});
