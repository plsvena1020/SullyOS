// utils/xhsVpsToolConfig.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolConfig } from './amsgToolPack';
import type { RealtimeConfig } from '../types';

const baseRc = (xhs: any): RealtimeConfig => ({ xhsMcpConfig: xhs } as unknown as RealtimeConfig);

describe('buildToolConfig xhs modes', () => {
    it('vps mode uploads bridgeToken and never a cookie', () => {
        const cfg = JSON.parse(JSON.stringify(buildToolConfig(baseRc({
            enabled: true, mode: 'vps', serverUrl: 'https://ethernet-vps.bot.cd/xhs-api/api',
            bridgeToken: 'tok-1', cookie: 'a1=SHOULD_NOT_UPLOAD', platform: 'xhs',
        }))!));
        expect(cfg.xhsMcpConfig.bridgeToken).toBe('tok-1');
        expect(JSON.stringify(cfg)).not.toContain('SHOULD_NOT_UPLOAD');
    });
    it('manual lite mode keeps uploading the cookie unchanged', () => {
        const cfg = JSON.parse(JSON.stringify(buildToolConfig(baseRc({
            enabled: true, mode: 'lite', serverUrl: 'https://worker.test/api',
            cookie: 'a1=abc; web_session=s',
        }))!));
        expect(cfg.xhsMcpConfig.cookie).toBe('a1=abc; web_session=s');
        expect(cfg.xhsMcpConfig.bridgeToken).toBeUndefined();
    });
});
