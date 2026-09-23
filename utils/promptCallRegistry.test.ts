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
    it('every anchor line contains its pinned symbol', () => {
        for (const s of CALL_REGISTRY) {
            expect(s.pin, `site ${s.site} missing pin`).toBeTruthy();
            const [file, lineNo] = s.anchor.split(':');
            const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            const line = src.split('\n')[Number(lineNo) - 1] ?? '';
            expect(line, `site ${s.site} anchor ${s.anchor}`).toContain(s.pin);
        }
    });
});
