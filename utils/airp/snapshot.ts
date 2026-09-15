import type { CharacterProfile, RealtimeConfig } from '../../types';
import type {
  AirpAutonomyLevel,
  AirpFact,
  AirpFactAuthority,
  AirpRuntimeSnapshot,
  AirpSourceRef,
} from './types';
import { AIRP_CAPABILITIES } from './capabilityCatalog';
import { mergeAirpSettings } from './settings';
import { resolveCharTimeZone } from '../timezone';
import { injectMemoryPalace } from '../memoryPalace/pipeline';
import { getDailyScheduleForChar } from '../dailySchedule';
import { resolveScheduleSlots } from '../scheduleInjection';
import { checkSpecialDates } from '../realtimeWorldCore';
import { RealtimeContextManager, defaultRealtimeConfig, resolveCharCity } from '../realtimeContext';
import { DB } from '../db';

export interface AirpRealtimeDigest {
  weatherText?: string;
  holidayText?: string;
  newsItems?: string[];
  observedAt: number;
}

export interface AirpEpisodeSummary {
  summary: string;
  threadOpen?: boolean;
}

export interface BuildSnapshotOpts {
  now?: number;
  recentDialogueTail?: string[];
  additionalFacts?: AirpFact[];
  recallMemories?: (query: string) => Promise<AirpFact[]>;
  loadEpisodes?: () => Promise<AirpEpisodeSummary[]>;
  loadRealtime?: () => Promise<AirpRealtimeDigest | null>;
  loadSchedule?: () => Promise<string | null>;
}

const FALLBACK_TZ = 'Asia/Shanghai';
const ROOM_PLATE_MAX_LEN = 2000;
const MAX_NEWS_FACTS = 3;
const MAX_EPISODES = 5;
const NEWS_SNAPSHOT_MAX_AGE_MS = 24 * 3600 * 1000;

const REALTIME_SOURCE_LABEL = 'realtime_cache';

/** 单条 fact 的构造草稿：内置来源按最终位置派生 id，注入来源原样透传。 */
type FactDraft =
  | {
      kind: 'built';
      predicate: string;
      value: AirpFact['value'];
      authority: AirpFactAuthority;
      source: AirpSourceRef;
    }
  | { kind: 'given'; fact: AirpFact };

function resolveTzId(char: CharacterProfile): string {
  try {
    const tz = resolveCharTimeZone(char);
    if (typeof tz === 'string' && tz.trim().length > 0) return tz.trim();
  } catch {
    /* 取不到就回落固定时区 */
  }
  return FALLBACK_TZ;
}

function readLocationLabel(char: CharacterProfile): string | undefined {
  try {
    const loc = char?.location;
    if (!loc) return undefined;
    const parts = [loc.province, loc.city, loc.district]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.trim());
    return parts.length > 0 ? parts.join('') : undefined;
  } catch {
    return undefined;
  }
}

async function readActivity(
  char: CharacterProfile,
  opts: BuildSnapshotOpts,
  builtAt: number,
): Promise<string | undefined> {
  try {
    let label: string | null | undefined;
    if (opts.loadSchedule) {
      label = await opts.loadSchedule();
    } else {
      const schedule = await getDailyScheduleForChar(char, new Date(builtAt));
      label = resolveScheduleSlots(schedule, new Date(builtAt)).current?.activity ?? null;
    }
    return typeof label === 'string' && label.trim().length > 0 ? label.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readAutonomyLevel(char: CharacterProfile): AirpAutonomyLevel {
  try {
    return mergeAirpSettings(char?.airp).autonomyLevel;
  } catch {
    return 2;
  }
}

/** 浏览器侧实时配置：沿用 os_realtime_config 口径，读不到/读坏就用内置默认。 */
function readRealtimeConfig(): RealtimeConfig {
  try {
    const raw = localStorage.getItem('os_realtime_config');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...defaultRealtimeConfig, ...(parsed as Partial<RealtimeConfig>) };
      }
    }
  } catch {
    /* 存储不可用或内容损坏 → 内置默认 */
  }
  return defaultRealtimeConfig;
}

/**
 * 运行时的实时摘要（生产默认）：只读 peek 缓存 + 纯函数节日，绝不 fetch。
 * peek 没有新闻时补一份 IndexedDB 热点快照（同样是纯读取）；缓存为空且当天无节日时返回 null。
 * 注意：DB 读取放在内层 try/catch，IDB 不可用（worker/无索引环境）时降级为跳过新闻补充。
 */
async function loadRealtimeFromCache(
  char: CharacterProfile,
  tzId: string,
  builtAt: number,
): Promise<AirpRealtimeDigest | null> {
  const config = readRealtimeConfig();
  const city = resolveCharCity(char, config);
  const peek = RealtimeContextManager.peekRealtimeCache(config, city);
  const holidays = checkSpecialDates(tzId, builtAt);
  const holidayText = holidays.length > 0 ? holidays.join('、') : undefined;

  const peekWeather =
    typeof peek?.weatherText === 'string' && peek.weatherText.trim().length > 0
      ? peek.weatherText
      : undefined;
  const peekNewsItems =
    peek?.newsItems && peek.newsItems.length > 0 ? peek.newsItems : undefined;

  let newsItems = peekNewsItems;
  let newsFetchedAt: number | undefined;
  if (!newsItems) {
    try {
      const snap = await DB.getLatestHotNewsSnapshot();
      if (snap && Number.isFinite(snap.fetchedAt) && snap.fetchedAt <= builtAt) {
        if (builtAt - snap.fetchedAt <= NEWS_SNAPSHOT_MAX_AGE_MS && Array.isArray(snap.items)) {
          const titles = snap.items
            .map((item) => item?.title)
            .filter(
              (title): title is string => typeof title === 'string' && title.trim().length > 0,
            )
            .slice(0, MAX_NEWS_FACTS);
          if (titles.length > 0) {
            newsItems = titles;
            newsFetchedAt = snap.fetchedAt;
          }
        }
      }
    } catch {
      /* IDB 不可用 → 跳过新闻补充，绝不抛 */
    }
  }

  if (!peekWeather && !newsItems && !holidayText) return null;

  const observedCandidates: number[] = [];
  const peekObservedAt = peek?.observedAt;
  if (
    (peekWeather || peekNewsItems) &&
    typeof peekObservedAt === 'number' &&
    Number.isFinite(peekObservedAt)
  ) {
    observedCandidates.push(peekObservedAt);
  }
  if (typeof newsFetchedAt === 'number' && Number.isFinite(newsFetchedAt)) {
    observedCandidates.push(newsFetchedAt);
  }

  const digest: AirpRealtimeDigest = {
    observedAt: observedCandidates.length > 0 ? Math.min(...observedCandidates) : builtAt,
  };
  if (peekWeather) digest.weatherText = peekWeather;
  if (holidayText) digest.holidayText = holidayText;
  if (newsItems) digest.newsItems = newsItems;
  return digest;
}

function appendRealtimeFacts(
  digest: AirpRealtimeDigest,
  builtAt: number,
  drafts: FactDraft[],
): void {
  const observedAt =
    typeof digest.observedAt === 'number' && Number.isFinite(digest.observedAt)
      ? digest.observedAt
      : builtAt;
  // 每条 fact 独立构造 source，避免共享引用被下游就地改写时互相污染。
  const makeSource = (): AirpSourceRef => ({
    kind: 'tool',
    label: REALTIME_SOURCE_LABEL,
    observedAt,
  });

  if (typeof digest.weatherText === 'string' && digest.weatherText.trim().length > 0) {
    drafts.push({
      kind: 'built',
      predicate: 'weather_now',
      value: digest.weatherText,
      authority: 'tool_verified',
      source: makeSource(),
    });
  }
  if (typeof digest.holidayText === 'string' && digest.holidayText.trim().length > 0) {
    drafts.push({
      kind: 'built',
      predicate: 'holiday_today',
      value: digest.holidayText,
      authority: 'tool_verified',
      source: makeSource(),
    });
  }
  if (Array.isArray(digest.newsItems)) {
    for (const title of digest.newsItems.slice(0, MAX_NEWS_FACTS)) {
      if (typeof title === 'string' && title.trim().length > 0) {
        drafts.push({
          kind: 'built',
          predicate: 'news_hot',
          value: title,
          authority: 'tool_verified',
          source: makeSource(),
        });
      }
    }
  }
}

async function readEpisodes(
  opts: BuildSnapshotOpts,
): Promise<{ recentEventSummaries: string[]; unresolvedThreads: string[] }> {
  try {
    const episodes = opts.loadEpisodes ? await opts.loadEpisodes() : [];
    if (!Array.isArray(episodes)) return { recentEventSummaries: [], unresolvedThreads: [] };

    const recentEventSummaries = episodes
      .slice(-MAX_EPISODES)
      .map((episode) => episode?.summary)
      .filter((summary): summary is string => typeof summary === 'string' && summary.trim().length > 0);

    const unresolvedThreads = episodes
      .filter((episode) => episode?.threadOpen === true)
      .slice(-MAX_EPISODES)
      .map((episode) => episode?.summary)
      .filter((summary): summary is string => typeof summary === 'string' && summary.trim().length > 0);

    return { recentEventSummaries, unresolvedThreads };
  } catch {
    return { recentEventSummaries: [], unresolvedThreads: [] };
  }
}

async function assembleSnapshot(
  char: CharacterProfile,
  opts: BuildSnapshotOpts,
): Promise<AirpRuntimeSnapshot> {
  const builtAt = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const charId = typeof char?.id === 'string' ? char.id : '';
  const tzId = resolveTzId(char);
  const locationLabel = readLocationLabel(char);
  const activity = await readActivity(char, opts, builtAt);

  const drafts: FactDraft[] = [];

  // 基线 A：记忆宫殿门牌摘要（与 context.ts 同一条 memoryPalaceEnabled 闸门）。
  if (
    char?.memoryPalaceEnabled &&
    typeof char.roomPlatesInjection === 'string' &&
    char.roomPlatesInjection.trim().length > 0
  ) {
    drafts.push({
      kind: 'built',
      predicate: 'room_plate_digest',
      value: char.roomPlatesInjection.slice(0, ROOM_PLATE_MAX_LEN),
      authority: 'runtime_state',
      source: { kind: 'room_plate' },
    });
  }

  // 基线 B：角色当前地点。
  if (locationLabel) {
    drafts.push({
      kind: 'built',
      predicate: 'current_location',
      value: locationLabel,
      authority: 'runtime_state',
      source: { kind: 'runtime' },
    });
  }

  // 基线 C（D1）：无条件记忆召回。注入桩原样透传；生产默认走记忆管线，
  // 在浅拷贝上运行以隔离 injectMemoryPalace 的 mutation。
  try {
    const tail = Array.isArray(opts.recentDialogueTail) ? opts.recentDialogueTail : [];
    const query = tail.slice(-3).join('\n');
    if (opts.recallMemories) {
      const recalled = await opts.recallMemories(query);
      if (Array.isArray(recalled)) {
        for (const fact of recalled) {
          if (fact) drafts.push({ kind: 'given', fact });
        }
      }
    } else {
      const copy = { ...char };
      await injectMemoryPalace(copy, undefined, query);
      const injection = copy.memoryPalaceInjection;
      if (typeof injection === 'string' && injection.trim().length > 0) {
        drafts.push({
          kind: 'built',
          predicate: 'memory_digest',
          value: injection,
          authority: 'memory_summary',
          source: { kind: 'memory' },
        });
      }
    }
  } catch {
    /* 记忆召回失败 → 跳过该来源，绝不抛 */
  }

  // 基线 D：调用方补充的事实。
  for (const fact of opts.additionalFacts ?? []) {
    if (fact) drafts.push({ kind: 'given', fact });
  }

  // 基线 E（D1）：实时缓存 + 节日。
  try {
    const digest = opts.loadRealtime
      ? await opts.loadRealtime()
      : await loadRealtimeFromCache(char, tzId, builtAt);
    if (digest) appendRealtimeFacts(digest, builtAt, drafts);
  } catch {
    /* 实时来源失败 → 跳过 */
  }

  const facts: AirpFact[] = drafts.map((draft, index) => {
    if (draft.kind === 'given') return draft.fact;
    return {
      id: `airp-${builtAt}-${index}`,
      charId,
      subjectId: charId,
      predicate: draft.predicate,
      value: draft.value,
      authority: draft.authority,
      status: 'active',
      validFrom: builtAt,
      updatedAt: builtAt,
      source: draft.source,
      locked: false,
    };
  });

  const { recentEventSummaries, unresolvedThreads } = await readEpisodes(opts);

  const scene: AirpRuntimeSnapshot['scene'] = { now: builtAt, tzId };
  if (locationLabel) scene.locationLabel = locationLabel;
  if (activity) scene.activity = activity;

  return {
    v: 1,
    charId,
    builtAt,
    autonomyLevel: readAutonomyLevel(char),
    scene,
    facts,
    knowledge: [],
    recentEventSummaries,
    unresolvedThreads,
    capabilities: [...AIRP_CAPABILITIES],
  };
}

/**
 * 组装 AIRP 运行时快照（浏览器侧）。每个来源独立 try/catch，失败即省略该来源；
 * 本函数永不抛异常——最外层再兜一层，任何意外都回落成最小可用快照。
 */
export async function buildAirpRuntimeSnapshot(
  char: CharacterProfile,
  opts: BuildSnapshotOpts = {},
): Promise<AirpRuntimeSnapshot> {
  try {
    return await assembleSnapshot(char, opts);
  } catch (error) {
    console.warn('[airp] runtime snapshot assembly failed; returning minimal snapshot', error);
    const builtAt =
      typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
    return {
      v: 1,
      charId: typeof char?.id === 'string' ? char.id : '',
      builtAt,
      autonomyLevel: 2,
      scene: { now: builtAt, tzId: FALLBACK_TZ },
      facts: [],
      knowledge: [],
      recentEventSummaries: [],
      unresolvedThreads: [],
      capabilities: [...AIRP_CAPABILITIES],
    };
  }
}
