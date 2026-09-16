import type { AgenticToolCtx, dispatchAgenticTool as DispatchFn } from '../agenticTools';
import type { AirpToolExecution, AirpToolExecutor } from './directorClient';
import { searchPlaces, type AmapAuth, type CityPlace, type PlaceCategory } from '../amapCore';
import { readAmapAuth } from '../cityPlaces';
import { fetchWeatherWithFallback, generateWeatherAdvice, type WeatherData } from '../realtimeWorldCore';

/**
 * AIRP 能力目录里的工具名 → 真工具名 / 内部 runner 派发键。
 *
 * 真名是 dispatcher 的 case 标签（recall / web_search / read_note）。目录名与真名
 * 分开是故意的：能力目录是给导演看的「能力」语言，两边演化节奏不同。
 *
 * weather_lookup_place / amap_search_places 的值不是共享面真工具名，而是本模块内部
 * 指向专用 runner 的派发键：仓库里没有对应 dispatchAgenticTool case，也不打算新建
 *（保持 AIRP 作用域，别的调用方行为不变），所以 executeTool 对它们分支到 runner，
 * 不走 dispatchAgenticTool。amap_route 故意不在表里——没有路线 helper，保持未接线。
 */
const WEATHER_RUNNER = '__airp_weather_lookup_place__';
const AMAP_SEARCH_RUNNER = '__airp_amap_search_places__';

const CATALOG_TO_REAL: Record<string, string> = {
    recall_deep: 'recall',
    web_search: 'web_search',
    read_note: 'read_note',
    weather_lookup_place: WEATHER_RUNNER,
    amap_search_places: AMAP_SEARCH_RUNNER,
};

const TEXT_WEATHER_NEEDS_CITY = '缺少地点，无法查询天气';
const TEXT_WEATHER_UNAVAILABLE = '天气查询暂不可用';
const TEXT_AMAP_NEEDS_KEYWORDS = '缺少搜索关键词，无法查询地点';
const TEXT_AMAP_NEEDS_CITY = '缺少城市，无法查询地点';
const TEXT_AMAP_UNCONFIGURED = '地图服务未配置';
const TEXT_AMAP_EMPTY = '附近没搜到相关地点';
const TEXT_AMAP_UNAVAILABLE = '地点搜索暂不可用';

/** 返回给导演的地点条数上限：导演只需要「大概有什么」，多了挤占上下文。 */
const AMAP_SEARCH_LIMIT = 5;

/**
 * 新增 runner 的注入缝（测试用）。生产不传，走下面的真实默认实现；
 * 因此 useChatAI 的构造调用无需改动。
 */
export interface AirpToolExecutorExtras {
    weatherLookup?: (city: string) => Promise<WeatherData | null>;
    amapSearch?: (
        keywords: string,
        city: string,
        category: PlaceCategory,
        auth: AmapAuth,
    ) => Promise<CityPlace[]>;
}

function encodeResult(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result === undefined || result === null) return '';
    try {
        const json = JSON.stringify(result);
        return typeof json === 'string' ? json : '';
    } catch {
        return '';
    }
}

function readArgText(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    return typeof value === 'string' ? value : '';
}

/**
 * 查指定地点天气。city 必填（角色当前地已由 snapshot 场景固定注入，这里只查第三地）。
 * 全程不抛：校验不过/查不到/取数失败都回文本，让导演从文本里学。
 */
async function runWeatherLookup(
    args: Record<string, unknown>,
    extra: AirpToolExecutorExtras | undefined,
): Promise<AirpToolExecution> {
    const city = readArgText(args, 'city').trim();
    if (!city) return { ok: true, text: TEXT_WEATHER_NEEDS_CITY };

    // 不传 apiKey：Open-Meteo 回落免 key，工具不该替用户决定用哪把 OWM key。
    const lookup = extra?.weatherLookup ?? fetchWeatherWithFallback;
    let weather: WeatherData | null;
    try {
        weather = await lookup(city);
    } catch {
        return { ok: false, text: TEXT_WEATHER_UNAVAILABLE };
    }
    if (!weather) return { ok: true, text: `未查到${city}的天气` };

    return {
        ok: true,
        text: `${weather.city}${weather.description}，气温 ${weather.temp}°C（体感 ${weather.feelsLike}°C）\n${generateWeatherAdvice(weather)}`,
    };
}

/**
 * 按关键字搜地点。keywords 与 city 都必填——city 无 ctx 回落：导演的 snapshot
 * 场景里已经有角色当前城市，缺了就让它照 schema 重发，而不是猜一个城市搜错地方。
 * 全程不抛：校验不过/没配 key/搜不到/取数失败都回文本。
 */
async function runAmapSearch(
    args: Record<string, unknown>,
    extra: AirpToolExecutorExtras | undefined,
): Promise<AirpToolExecution> {
    const keywords = readArgText(args, 'keywords').trim();
    if (!keywords) return { ok: true, text: TEXT_AMAP_NEEDS_KEYWORDS };
    const city = readArgText(args, 'city').trim();
    if (!city) return { ok: true, text: TEXT_AMAP_NEEDS_CITY };

    // key 检查必须在调用前：searchPlaces 没 key 时静默返回 []，那会被导演误读成
    // 「这里确实没有咖啡馆」，比明说「没配置」糟得多。
    const auth = readAmapAuth();
    if (!auth.key) return { ok: true, text: TEXT_AMAP_UNCONFIGURED };

    // category 只是 App 侧的结果标签（PlaceCategory），从不作为参数进高德请求，
    // 也不在导演契约里；导演的关键字搜索没有类别概念，固定 'spot'。
    const search = extra?.amapSearch ?? searchPlaces;
    let places: CityPlace[];
    try {
        places = await search(keywords, city, 'spot', auth);
    } catch {
        return { ok: false, text: TEXT_AMAP_UNAVAILABLE };
    }
    if (places.length === 0) return { ok: true, text: TEXT_AMAP_EMPTY };

    const lines = places.slice(0, AMAP_SEARCH_LIMIT).map((place, index) => {
        const address = place.address ? ` — ${place.address}` : '';
        return `${index + 1}. ${place.name}${address}`;
    });
    return { ok: true, text: lines.join('\n') };
}

/**
 * 给 `runAirpDirector` 用的工具执行器：把导演请求的工具名翻译真名后交给注入的
 * `dispatchAgenticTool`；新增的天气 / 地点检索没有共享面工具，分支到本模块的
 * runner（真函数默认内置，测试可经第三参数注入假实现）。
 *
 * `dispatch` 仍由调用方注入：本模块对 agenticTools 只做类型引用（import type），
 * 方便测试与后续换实现。
 */
export function createChatToolExecutor(
    dispatch: typeof DispatchFn,
    ctx: AgenticToolCtx,
    extra?: AirpToolExecutorExtras,
): AirpToolExecutor {
    return {
        async executeTool(toolName: string, args: Record<string, unknown>) {
            const real = CATALOG_TO_REAL[toolName];
            // 未接线 / 打错的名字：抛出去。directorClient 的 resolveToolIntentText 会兜成
            // 「执行失败」，正常路径上走不到（它已先按 AIRP_WIRED_TOOLS 过滤过）。
            if (real === undefined) throw new Error(`Unknown airp catalog tool: ${toolName}`);
            if (real === WEATHER_RUNNER) return runWeatherLookup(args, extra);
            if (real === AMAP_SEARCH_RUNNER) return runAmapSearch(args, extra);
            try {
                const result = await dispatch(real, args, ctx);
                return { ok: true, text: encodeResult(result) };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { ok: false, text: `执行失败：${message}` };
            }
        },
    };
}
