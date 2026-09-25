// utils/statusPanel.realtime.test.ts
// 感知计数徽章修复：probeRealtime 以 PERCEPTION_CAPABILITIES 注册表为口径（8 项）。
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

describe('probeRealtime 注册表口径', () => {
    it('全开全配 → 8 项启用', async () => {
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
        expect(entry.detail).toBe('8 项启用');
    });

    it('仅 Google 开且已选日历 → 1 项启用', async () => {
        setGoogle(true, ['cal1']);
        const entry = await probeRealtime({ ...base, bluetoothEnabled: false });
        expect(entry.status).toBe('ok');
        expect(entry.detail).toBe('1 项启用');
    });

    it('蓝牙默认开但无设备 → warn 含蓝牙未配置', async () => {
        setGoogle(false, []);
        const { bluetoothEnabled: _omit, ...rest } = base;
        const entry = await probeRealtime(rest);
        expect(entry.status).toBe('warn');
        expect(entry.detail).toContain('蓝牙设备·未配置');
    });
});
