// utils/statusPanel.realtime.test.ts
// 徽章只数已配置项：probeRealtime 只数 enabled && configured（与宫格 on 态同口径）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeRealtime } from './statusPanel';
import { bleEngine } from './bleEngine';
import type { RealtimeConfig } from '../types';

const base: RealtimeConfig = {
    weatherEnabled: false,
    weatherApiKey: '',
    weatherCity: '',
    newsEnabled: false,
    notionEnabled: false,
    notionApiKey: '',
    notionDatabaseId: '',
    feishuEnabled: false,
    feishuAppId: '',
    feishuAppSecret: '',
    feishuBaseId: '',
    feishuTableId: '',
    xhsEnabled: false,
    cacheMinutes: 10,
    perspectiveEnabled: false,
    perspectiveSupabaseUrl: '',
    perspectiveSupabaseAnonKey: '',
    perspectiveDays: 7,
    perspectiveMinIntervalSec: 60,
    perspectiveSummaryEnabled: false,
    perspectiveSummaryThreshold: 500,
    bluetoothEnabled: false,
};

const setGoogle = (enabled: boolean, calendars: string[]) => {
    if (enabled) localStorage.setItem('aetheros.google.enabled', '1');
    else localStorage.removeItem('aetheros.google.enabled');
    localStorage.setItem('aetheros.google.selectedCalendars', JSON.stringify(calendars));
};

beforeEach(() => {
    localStorage.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});

describe('probeRealtime 只数已配置', () => {
    it('全开全配 → 8 项已配置', async () => {
        vi.spyOn(bleEngine, 'hasConnectedDevice').mockReturnValue(true);
        setGoogle(true, ['cal1']);
        const entry = await probeRealtime({
            ...base,
            weatherEnabled: true,
            weatherCity: '北京',
            newsEnabled: true,
            notionEnabled: true,
            notionApiKey: 'k',
            notionDatabaseId: 'db',
            feishuEnabled: true,
            feishuAppId: 'id',
            feishuAppSecret: 'secret',
            feishuBaseId: 'base',
            feishuTableId: 'tbl',
            xhsEnabled: true,
            perspectiveEnabled: true,
            perspectiveSupabaseUrl: 'https://xxx.supabase.co',
            perspectiveSupabaseAnonKey: 'anon',
            bluetoothEnabled: true,
        });
        expect(entry.status).toBe('ok');
        expect(entry.detail).toBe('8 项已配置');
    });

    it('全关 → 未启用', async () => {
        vi.spyOn(bleEngine, 'hasConnectedDevice').mockReturnValue(false);
        setGoogle(false, []);
        const entry = await probeRealtime({ ...base, bluetoothEnabled: false });
        expect(entry.status).toBe('off');
        expect(entry.detail).toBe('未启用');
    });

    it('天气开+有城市、新闻开、其余全关 → 2 项已配置', async () => {
        vi.spyOn(bleEngine, 'hasConnectedDevice').mockReturnValue(false);
        setGoogle(false, []);
        const { bluetoothEnabled: _omit, ...rest } = base;
        const entry = await probeRealtime({
            ...rest,
            weatherEnabled: true,
            weatherCity: '北京',
            newsEnabled: true,
        });
        expect(entry.status).toBe('ok');
        expect(entry.detail).toBe('2 项已配置');
    });

    it('Google 开且已选日历、其余未配 → 1 项已配置', async () => {
        vi.spyOn(bleEngine, 'hasConnectedDevice').mockReturnValue(false);
        setGoogle(true, ['cal1']);
        const { bluetoothEnabled: _omit, ...rest } = base;
        const entry = await probeRealtime(rest);
        expect(entry.status).toBe('ok');
        expect(entry.detail).toBe('1 项已配置');
    });
});
