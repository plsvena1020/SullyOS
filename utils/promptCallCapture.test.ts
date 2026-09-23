// utils/promptCallCapture.test.ts
import { describe, it, expect } from 'vitest';
import { captureCall, getCaptured, clearCaptured, renderCapturedText } from './promptCallCapture';

const msg = (role: string, content: string) => ({ role, content });

describe('promptCallCapture', () => {
    it('keeps at most 3 per site, newest first', () => {
        clearCaptured('s');
        for (let i = 0; i < 5; i++) captureCall('s', [msg('system', `p${i}`)], { charId: 'c', label: 't' });
        const got = getCaptured('s');
        expect(got).toHaveLength(3);
        expect(got[0].blocks[0]).toMatchObject({ text: 'p4' });
    });
    it('history folds into one placeholder entry', () => {
        clearCaptured('s2');
        captureCall('s2', [
            msg('system', 'STABLE TEXT'),
            msg('user', 'hi 1'), msg('assistant', 'yo 1'), msg('user', 'hi 2'),
            msg('system', 'TAIL TEXT'),
        ], { charId: 'c', label: 't' });
        const [entry] = getCaptured('s2');
        expect(entry.blocks.map(b => b.kind)).toEqual(['text', 'history', 'text']);
        expect(entry.blocks[1]).toMatchObject({ kind: 'history', count: 3 });
    });
    it('folds base64 image data urls', () => {
        clearCaptured('s3');
        captureCall('s3', [msg('system', 'see data:image/png;base64,AAAA and data:image/jpeg;base64,BBBB end')], { charId: 'c', label: 't' });
        const [entry] = getCaptured('s3');
        expect(entry.blocks[0].text).toContain('[图片 ×2]');
        expect(entry.blocks[0].text).not.toContain('base64');
    });
    it('renderCapturedText joins blocks with headers, verbatim body', () => {
        clearCaptured('s4');
        captureCall('s4', [msg('system', 'ABC')], { charId: 'c', label: 't' });
        const [entry] = getCaptured('s4');
        expect(renderCapturedText(entry)).toBe('ABC');
    });
});
