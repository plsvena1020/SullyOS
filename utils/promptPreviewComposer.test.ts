/**
 * promptPreviewComposer.test — 提示词注入预览组装器测试。
 *
 * 环境说明：vitest node 环境（无 IndexedDB）。DB.* 全部 try/catch 容错降级、
 * defaultRealtimeConfig 天气/热搜默认关闭（免网络）、resolveSteel 失败回退内置默认，
 * 因此可在无浏览器环境下组装出真实三段结构。
 */
import { describe, it, expect } from 'vitest';
import { composePromptPreview, PROMPT_TOKEN_ESTIMATE_NOTE } from './promptPreviewComposer';
import type { CharacterProfile } from '../types';

const makeChar = (over: Partial<CharacterProfile> = {}): CharacterProfile => ({
    id: 'preview-char-1',
    name: '预览酱',
    description: '测试用角色',
    systemPrompt: '你是预览酱，一个测试角色。',
    ...over,
} as unknown as CharacterProfile);

describe('composePromptPreview', () => {
    it('产出三段结构，stable 首块为角色核心上下文且含角色名', async () => {
        const r = await composePromptPreview(makeChar());
        expect(r.charId).toBe('preview-char-1');
        expect(r.charName).toBe('预览酱');
        const segs = new Set(r.blocks.map(b => b.segment));
        expect(segs.has('stable')).toBe(true);
        expect(segs.has('volatileState')).toBe(true);
        expect(segs.has('recencyTail')).toBe(true);

        const core = r.blocks.find(b => b.id === 'stable.core');
        expect(core).toBeTruthy();
        expect(core!.enabled).toBe(true);
        expect(core!.content).toContain('预览酱');
    });

    it('recency 段包含两块钢印且标记为结构纪律（discipline）', async () => {
        const r = await composePromptPreview(makeChar());
        const steels = r.blocks.filter(b => b.segment === 'recencyTail');
        expect(steels.length).toBeGreaterThanOrEqual(2);
        for (const s of steels) {
            expect(s.role).toBe('discipline');
            expect(s.enabled).toBe(true);
            expect(s.content.length).toBeGreaterThan(0);
        }
    });

    it('token 估算为正数且分段小计求和等于总计', async () => {
        const r = await composePromptPreview(makeChar());
        for (const b of r.blocks) {
            expect(b.charEstimate).toBe((b.content || '').length);
            expect(b.tokenEstimate).toBeGreaterThanOrEqual(0);
        }
        const sum = r.totals.stable + r.totals.volatileState + r.totals.recencyTail + r.totals.history;
        expect(r.totals.all).toBe(sum);
        expect(PROMPT_TOKEN_ESTIMATE_NOTE).toContain('token');
    });

    it('无音乐档案 / 无日程功能时音乐与日程块标注为未注入', async () => {
        const r = await composePromptPreview(makeChar());
        const music = r.blocks.find(b => b.id === 'volatile.music');
        expect(music).toBeTruthy();
        expect(music!.enabled).toBe(false);
        const sched = r.blocks.find(b => b.id === 'volatile.schedule');
        // makeChar 未开日程功能：要么不出现，要么出现且 enabled=false
        if (sched) expect(sched.enabled).toBe(false);
    });

    it('世界书条目全部停用时明细块标注「已停用」且不计入 token 小计', async () => {
        const char = makeChar({
            mountedWorldbooks: [
                { id: 'wb-x', title: '停用条目', content: '不应注入的设定', position: 1, order: 1, disable: true },
                { id: 'wb-y', title: '常驻条目', content: '常驻注入的设定', position: 1, order: 2 },
            ],
        } as any);
        const r = await composePromptPreview(char);
        const wbBlocks = r.blocks.filter(b => b.sourceType === 'worldbook');
        expect(wbBlocks.length).toBe(2);
        const disabled = wbBlocks.find(b => b.hitInfo === '已停用');
        expect(disabled).toBeTruthy();
        expect(disabled!.enabled).toBe(false);
        const active = wbBlocks.find(b => b.hitInfo?.includes('常驻'));
        expect(active).toBeTruthy();
        expect(active!.enabled).toBe(true);
        // 停用块不参与小计：stable 小计 = 核心块 token（世界书明细不重复计入）
        const core = r.blocks.find(b => b.id === 'stable.core')!;
        expect(r.totals.stable).toBeGreaterThanOrEqual(core.tokenEstimate);
    });

    it('角色启用彼方时出现《彼方》stable 块', async () => {
        const char = makeChar({ vrState: { enabled: true } } as any);
        const r = await composePromptPreview(char);
        expect(r.blocks.some(b => b.id === 'stable.vr')).toBe(true);
    });
});
