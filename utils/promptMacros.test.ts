import { describe, expect, it } from 'vitest';
import { expandPromptMacros } from './promptMacros';

const noon = new Date(2026, 8, 22, 9, 5);

describe('expandPromptMacros', () => {
    it('全宏一次替换', () => {
        const out = expandPromptMacros(
            '{{char}}对{{user}}说：{{persona}} / 上句：{{lastUser}} / 上答：{{lastAssistant}} / {{time}} {{date}}',
            {
                charName: '阿澈', userName: '小雨', persona: '夜猫子',
                lastUser: '在吗', lastAssistant: '在的', now: noon,
            },
        );
        expect(out).toBe('阿澈对小雨说：夜猫子 / 上句：在吗 / 上答：在的 / 09:05 2026-09-22');
    });

    it('大小写与花括号内空格容错', () => {
        const out = expandPromptMacros('{{ Char }} + {{USER}} + {{  Time  }}', {
            charName: 'C', userName: 'U', now: noon,
        });
        expect(out).toBe('C + U + 09:05');
    });

    it('未知宏原样保留，不吞字', () => {
        expect(expandPromptMacros('记得{{affinity}}和{{char}}', { charName: 'C' }))
            .toBe('记得{{affinity}}和C');
    });

    it('userName 缺省回退「对方」（与 fillIdentity 同口径）', () => {
        expect(expandPromptMacros('{{user}}你好', {})).toBe('对方你好');
        expect(expandPromptMacros('{{user}}你好', { userName: '  ' })).toBe('对方你好');
    });

    it('charName 为空时 {{char}} 不替换', () => {
        expect(expandPromptMacros('我是{{char}}', {})).toBe('我是{{char}}');
        expect(expandPromptMacros('我是{{char}}', { charName: '' })).toBe('我是{{char}}');
    });

    it('未传的文本宏展开为空串', () => {
        expect(expandPromptMacros('A{{lastUser}}B{{persona}}C', {})).toBe('ABC');
    });

    it('无宏文本原样返回（含空串/非字符串守卫）', () => {
        expect(expandPromptMacros('', { charName: 'C' })).toBe('');
        expect(expandPromptMacros('纯文本', { charName: 'C' })).toBe('纯文本');
    });

    it('替换值里的 $ 不被当成分组引用', () => {
        const out = expandPromptMacros('价格{{lastUser}}', { lastUser: '$100 $&' });
        expect(out).toBe('价格$100 $&');
    });
});
