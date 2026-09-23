// utils/presetEffective.test.ts
import { describe, it, expect } from 'vitest';
import { effectiveStatus } from './presetEffective';

describe('effectiveStatus', () => {
    it('disabled custom row -> 不注入·已停用', () => {
        expect(effectiveStatus(
            { id: 'x', name: 'X', content: 'x', enabled: false, tags: [] } as any,
            { char: { chatVoiceEnabled: true } as any, provider: 'minimax', activeTags: ['chat'] },
        )).toMatchObject({ state: 'off', reason: '已停用' });
    });
    it('voice row with mismatched provider -> 不注入·供应商不匹配', () => {
        expect(effectiveStatus(
            { id: 'v', name: 'V', content: 'v', enabled: true, sourceKey: 'voice.fish', tags: [] } as any,
            { char: { chatVoiceEnabled: true } as any, provider: 'minimax', activeTags: ['chat'] },
        ).reason).toContain('供应商');
    });
    it('voice row enabled but char voice off -> 不注入·该角色未开语音', () => {
        expect(effectiveStatus(
            { id: 'v', name: 'V', content: 'v', enabled: true, sourceKey: 'voice.minimax', tags: [] } as any,
            { char: { chatVoiceEnabled: false } as any, provider: 'minimax', activeTags: ['chat'] },
        ).reason).toContain('未开语音');
    });
    it('adopted steel -> 生效·已接管', () => {
        expect(effectiveStatus(
            { id: 's', name: 'S', content: 's', enabled: true, sourceKey: 'chat.steelExpression', adoptPosition: 'stable', tags: [] } as any,
            { char: {} as any, provider: 'minimax', activeTags: ['chat'] },
        )).toMatchObject({ state: 'on', adopted: true });
    });
});
