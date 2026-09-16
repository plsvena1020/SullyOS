import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChatToolExecutor } from './toolExecutor';
import type { AgenticToolCtx } from '../agenticTools';
import type { AirpToolExecutor } from './directorClient';
import type { CityPlace } from '../amapCore';
import type { WeatherData } from '../realtimeWorldCore';

// 注入桩 dispatch：不 mock 真实工具，只验证「目录名 → 仓库真名」的映射与结果编码。
const ctx = { char: { name: 'Aria' }, userProfile: { name: '小明' } } as unknown as AgenticToolCtx;

function makeExecutor(dispatchImpl: (...args: any[]) => any): {
    executor: AirpToolExecutor;
    dispatch: ReturnType<typeof vi.fn>;
} {
    const dispatch = vi.fn(dispatchImpl);
    return { executor: createChatToolExecutor(dispatch as any, ctx), dispatch };
}

describe('createChatToolExecutor —— AIRP 目录名映射到仓库工具', () => {
    it('recall_deep → recall，实参 / ctx 原样透传', async () => {
        const { executor, dispatch } = makeExecutor(async () => '回忆文本');
        const args = { year: '2026', month: '06' };

        const result = await executor.executeTool('recall_deep', args);

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith('recall', args, ctx);
        expect(result).toEqual({ ok: true, text: '回忆文本' });
    });

    it('web_search / read_note 走同名真工具', async () => {
        const web = makeExecutor(async () => '搜索结果');
        expect(await web.executor.executeTool('web_search', { q: 'x' }))
            .toEqual({ ok: true, text: '搜索结果' });
        expect(web.dispatch).toHaveBeenCalledWith('web_search', { q: 'x' }, ctx);

        const note = makeExecutor(async () => '笔记');
        expect(await note.executor.executeTool('read_note', { id: 'n1' }))
            .toEqual({ ok: true, text: '笔记' });
        expect(note.dispatch).toHaveBeenCalledWith('read_note', { id: 'n1' }, ctx);
    });

    it('对象结果序列化成 JSON 字符串', async () => {
        const { executor } = makeExecutor(async () => ({ ok: true, items: [1, 2] }));

        const result = await executor.executeTool('recall_deep', {});

        expect(result).toEqual({ ok: true, text: JSON.stringify({ ok: true, items: [1, 2] }) });
    });

    it('无法序列化的结果回落空串，不抛', async () => {
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        const { executor } = makeExecutor(async () => cycle);

        expect(await executor.executeTool('read_note', {})).toEqual({ ok: true, text: '' });
    });

    it('真工具抛错 → ok:false，text 带「执行失败：」与原因', async () => {
        const { executor } = makeExecutor(async () => { throw new Error('boom'); });

        expect(await executor.executeTool('web_search', {})).toEqual({ ok: false, text: '执行失败：boom' });
    });

    it('非 Error 抛值也编码成失败文本', async () => {
        const { executor } = makeExecutor(async () => { throw 'plain'; });

        expect(await executor.executeTool('web_search', {})).toEqual({ ok: false, text: '执行失败：plain' });
    });

    it('未知目录名直接抛错、不派发（directorClient 的 catch 会落成「执行失败」）', async () => {
        const { executor, dispatch } = makeExecutor(async () => 'never');

        await expect(executor.executeTool('weather_elsewhere', {})).rejects.toThrow(/weather_elsewhere/);
        expect(dispatch).not.toHaveBeenCalled();
    });
});

// 两个新工具没有共享面真工具可派发，executor 分支到专用 runner；第三个参数是测试用注入缝。
const HANGZHOU_WEATHER: WeatherData = {
    temp: 26,
    feelsLike: 28,
    humidity: 60,
    description: '晴',
    icon: '01d',
    city: '杭州',
};

describe('createChatToolExecutor —— weather_lookup_place runner', () => {
    function makeWeatherExecutor(impl: (city: string) => Promise<WeatherData | null>): {
        executor: AirpToolExecutor;
        weatherLookup: ReturnType<typeof vi.fn>;
        dispatch: ReturnType<typeof vi.fn>;
    } {
        const weatherLookup = vi.fn(impl);
        const dispatch = vi.fn(async () => 'never');
        const executor = createChatToolExecutor(dispatch as any, ctx, { weatherLookup });
        return { executor, weatherLookup, dispatch };
    }

    it('命中：渲染 peek 格式那一行 + 建议行，且不派发共享面工具', async () => {
        const { executor, weatherLookup, dispatch } = makeWeatherExecutor(async () => HANGZHOU_WEATHER);

        const result = await executor.executeTool('weather_lookup_place', { city: '杭州' });

        expect(weatherLookup).toHaveBeenCalledTimes(1);
        expect(weatherLookup).toHaveBeenCalledWith('杭州');
        expect(dispatch).not.toHaveBeenCalled();
        expect(result).toEqual({
            ok: true,
            text: '杭州晴，气温 26°C（体感 28°C）\n天气不错，适合出门，阳光明媚',
        });
    });

    it('取数返回 null：报「未查到」而不是抛错', async () => {
        const { executor } = makeWeatherExecutor(async () => null);

        expect(await executor.executeTool('weather_lookup_place', { city: '杭州' }))
            .toEqual({ ok: true, text: '未查到杭州的天气' });
    });

    it('city 缺失或全空白：返回确定性提示，不调取数', async () => {
        const { executor, weatherLookup } = makeWeatherExecutor(async () => HANGZHOU_WEATHER);

        expect(await executor.executeTool('weather_lookup_place', {}))
            .toEqual({ ok: true, text: '缺少地点，无法查询天气' });
        expect(await executor.executeTool('weather_lookup_place', { city: '   ' }))
            .toEqual({ ok: true, text: '缺少地点，无法查询天气' });
        expect(weatherLookup).not.toHaveBeenCalled();
    });

    it('取数抛错：降级成文本，不把异常抛给 directorClient', async () => {
        const { executor } = makeWeatherExecutor(async () => { throw new Error('offline'); });

        expect(await executor.executeTool('weather_lookup_place', { city: '杭州' }))
            .toEqual({ ok: false, text: '天气查询暂不可用' });
    });
});

describe('createChatToolExecutor —— amap_search_places runner', () => {
    const AMAP_CONFIG_KEY = 'os_realtime_config';

    function seedAmapConfig(key: string | null): void {
        if (key === null) localStorage.removeItem(AMAP_CONFIG_KEY);
        else localStorage.setItem(AMAP_CONFIG_KEY, JSON.stringify({ amapApiKey: key }));
    }

    function makeAmapExecutor(impl: (
        keywords: string,
        city: string,
        category: unknown,
        auth: unknown,
    ) => Promise<CityPlace[]>): {
        executor: AirpToolExecutor;
        amapSearch: ReturnType<typeof vi.fn>;
        dispatch: ReturnType<typeof vi.fn>;
    } {
        const amapSearch = vi.fn(impl);
        const dispatch = vi.fn(async () => 'never');
        const executor = createChatToolExecutor(dispatch as any, ctx, { amapSearch });
        return { executor, amapSearch, dispatch };
    }

    function makePlaces(count: number): CityPlace[] {
        return Array.from({ length: count }, (_, i) => ({
            name: `地点${i + 1}`,
            type: '餐饮服务;咖啡厅',
            typeShort: '咖啡厅',
            category: 'cafe',
            address: `街${i + 1}`,
            lat: 30 + i,
            lng: 120 + i,
        }));
    }

    beforeEach(() => { seedAmapConfig(null); });

    it('命中：固定 spot 类别、带真实 auth 调取数，最多渲染 5 行 name — address', async () => {
        seedAmapConfig('test-amap-key');
        const { executor, amapSearch, dispatch } = makeAmapExecutor(async () => makePlaces(6));

        const result = await executor.executeTool('amap_search_places', { keywords: '咖啡馆', city: '杭州' });

        expect(amapSearch).toHaveBeenCalledTimes(1);
        const call = amapSearch.mock.calls[0];
        expect(call[0]).toBe('咖啡馆');
        expect(call[1]).toBe('杭州');
        expect(call[2]).toBe('spot');
        expect(call[3]).toEqual({ proxyUrl: expect.any(String), key: 'test-amap-key' });
        expect(dispatch).not.toHaveBeenCalled();
        expect(result).toEqual({
            ok: true,
            text: '1. 地点1 — 街1\n2. 地点2 — 街2\n3. 地点3 — 街3\n4. 地点4 — 街4\n5. 地点5 — 街5',
        });
    });

    it('结果为空：报「附近没搜到相关地点」', async () => {
        seedAmapConfig('test-amap-key');
        const { executor } = makeAmapExecutor(async () => []);

        expect(await executor.executeTool('amap_search_places', { keywords: '咖啡馆', city: '杭州' }))
            .toEqual({ ok: true, text: '附近没搜到相关地点' });
    });

    it('keywords / city 空白：点名缺的那一项，不调取数（city 无 ctx 回落）', async () => {
        seedAmapConfig('test-amap-key');
        const { executor, amapSearch } = makeAmapExecutor(async () => []);

        expect(await executor.executeTool('amap_search_places', { city: '杭州' }))
            .toEqual({ ok: true, text: '缺少搜索关键词，无法查询地点' });
        expect(await executor.executeTool('amap_search_places', { keywords: '咖啡馆' }))
            .toEqual({ ok: true, text: '缺少城市，无法查询地点' });
        expect(await executor.executeTool('amap_search_places', { keywords: '  ', city: '  ' }))
            .toEqual({ ok: true, text: '缺少搜索关键词，无法查询地点' });
        expect(amapSearch).not.toHaveBeenCalled();
    });

    it('没配 key：报「地图服务未配置」，不让空结果冒充搜过了', async () => {
        seedAmapConfig(null);
        const { executor, amapSearch } = makeAmapExecutor(async () => []);

        expect(await executor.executeTool('amap_search_places', { keywords: '咖啡馆', city: '杭州' }))
            .toEqual({ ok: true, text: '地图服务未配置' });
        expect(amapSearch).not.toHaveBeenCalled();
    });

    it('取数抛错：降级成文本，不把异常抛给 directorClient', async () => {
        seedAmapConfig('test-amap-key');
        const { executor } = makeAmapExecutor(async () => { throw new Error('proxy down'); });

        expect(await executor.executeTool('amap_search_places', { keywords: '咖啡馆', city: '杭州' }))
            .toEqual({ ok: false, text: '地点搜索暂不可用' });
    });

    it('amap_route 保持未接线：目录里没有它，执行直接抛错', async () => {
        seedAmapConfig('test-amap-key');
        const { executor, amapSearch, dispatch } = makeAmapExecutor(async () => []);

        await expect(executor.executeTool('amap_route', { from: 'A', to: 'B' }))
            .rejects.toThrow(/amap_route/);
        expect(amapSearch).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });
});
