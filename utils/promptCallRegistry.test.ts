// utils/promptCallRegistry.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CALL_REGISTRY } from './promptCallRegistry';

describe('call registry anchors exist', () => {
    it('every local site has a resolvable file anchor', () => {
        for (const s of CALL_REGISTRY.filter(c => c.visibility !== 'cloud')) {
            const [file] = s.anchor.split(':');
            const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            expect(src.length).toBeGreaterThan(0);
        }
    });
    it('key anchors pin exact symbols', () => {
        const cp = readFileSync(new URL('../utils/chatPrompts.ts', import.meta.url), 'utf8');
        expect(cp).toContain('const resolveSteel');
        expect(cp).toContain('resolveVoiceActingGuide');
    });
    it('every anchor file still contains its pinned symbol', () => {
        // 按符号全文搜索定位，不依赖 anchor 里的行号：任何窗口在文件上方插行都不会让本测试误报。
        // 行号只作为「大致在哪」的可读提示保留在 registry 里。
        for (const s of CALL_REGISTRY) {
            expect(s.pin, `site ${s.site} missing pin`).toBeTruthy();
            const [file] = s.anchor.split(':');
            const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            expect(src, `site ${s.site} pin "${s.pin}" not found in ${file}`).toContain(s.pin);
        }
    });
});
