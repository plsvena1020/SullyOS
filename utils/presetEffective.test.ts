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
    it('elevenlabs v3 user: std row off with model reason', () => {
        const r = effectiveStatus(
            { id: 'v', name: 'V', content: 'v', enabled: true, sourceKey: 'voice.elevenlabsStd', tags: [] } as any,
            { char: { chatVoiceEnabled: true } as any, provider: 'elevenlabs', isElevenLabsV3: true, activeTags: ['chat'] },
        );
        expect(r.state).toBe('off-char');
        expect(r.reason).toContain('v3');
    });
    it('elevenlabs std user: v3 row off with model reason', () => {
        const r = effectiveStatus(
            { id: 'v', name: 'V', content: 'v', enabled: true, sourceKey: 'voice.elevenlabsV3', tags: [] } as any,
            { char: { chatVoiceEnabled: true } as any, provider: 'elevenlabs', isElevenLabsV3: false, activeTags: ['chat'] },
        );
        expect(r.state).toBe('off-char');
        expect(r.reason).toContain('标准');
    });
    it('elevenlabs v3 user: v3 row on', () => {
        expect(effectiveStatus(
            { id: 'v', name: 'V', content: 'v', enabled: true, sourceKey: 'voice.elevenlabsV3', tags: [] } as any,
            { char: { chatVoiceEnabled: true } as any, provider: 'elevenlabs', isElevenLabsV3: true, activeTags: ['chat'] },
        )).toMatchObject({ state: 'on' });
    });
    it('appRules native row -> on', () => {
        expect(effectiveStatus(
            { id: 'a', name: 'A', content: 'a', enabled: true, sourceKey: 'chat.appRules', tags: [] } as any,
            { char: {} as any, provider: 'minimax', activeTags: ['chat'] },
        )).toMatchObject({ state: 'on', adopted: false });
    });
    it('appRules adopted row -> on + adopted', () => {
        expect(effectiveStatus(
            { id: 'a', name: 'A', content: 'a', enabled: true, sourceKey: 'chat.appRules', adoptPosition: 'stable', tags: [] } as any,
            { char: {} as any, provider: 'minimax', activeTags: ['chat'] },
        )).toMatchObject({ state: 'on', adopted: true });
    });
    it('appRules disabled row -> off-disabled', () => {
        expect(effectiveStatus(
            { id: 'a', name: 'A', content: 'a', enabled: false, sourceKey: 'chat.appRules', tags: [] } as any,
            { char: {} as any, provider: 'minimax', activeTags: ['chat'] },
        )).toMatchObject({ state: 'off-disabled' });
    });
});
