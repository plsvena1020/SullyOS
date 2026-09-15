import type { AirpAutonomyLevel } from './types';

/**
 * 自主背景生活的模板 id。模板只增数据不增执行分支：
 * 执行层只认 mergeAutonomySettings() 出的终值，不按 templateId 分支。
 */
export type AirpAutonomyTemplateId = 'night_player' | 'morning_brief' | 'surf_share' | 'custom';

/** 经历转述的语气（7 格 + 自定义，映射集中在执行层）。 */
export type RetellStyle =
  | 'battle' | 'brief' | 'casual' | 'coquettish' | 'diary' | 'teaser' | 'plain' | 'custom';

/**
 * 自主设置里用户可以覆盖的字段，全部可选：缺省字段由模板预填或常量兜底。
 * 它只是「与模板的 diff」，终值一律由 mergeAutonomySettings() 合并得出。
 */
export interface AirpAutonomyOverrides {
  /** 随机窗口（小时）：距用户最后一条消息多久可以醒一次。 */
  cadence?: { minHours: number; maxHours: number };
  /**
   * 静默段，"HH:mm"、按角色时区解释，落在段内不打扰。
   * null 是显式哨兵：明确「不要静默段」（连模板预填也一起清掉）；缺省才是跟随模板。
   */
  quietHours?: { start: string; end: string } | null;
  /** 每日最多醒几轮。 */
  maxRoundsPerDay?: number;
  /** 兴趣词：没有对话尾巴时的兜底选题来源。 */
  interests?: string[];
  /** 禁区词：这些话题不碰。 */
  avoidTopics?: string[];
  /** 转述块参数：语气 / 条数 / 字数 / 是否允许开场主动提起 / 自定义语气提示。 */
  retell?: {
    style: RetellStyle; maxItems: number; maxChars: number;
    opener?: boolean; customHint?: string;
  };
  /** 推送档位（off=不推、big=只推大经历）/ 每日上限 / 冷却分钟。 */
  push?: { mode: 'off' | 'big'; maxPerDay: number; cooldownMinutes: number };
  /** note 语气示例，随模板预填。 */
  noteStyleHint?: string;
  /** 每日 token 预算，超出停醒。缺省用常量 AUTONOMY_DAILY_TOKEN_BUDGET。 */
  dailyTokenBudget?: number;
}

/**
 * 角色的自主背景生活设置。挂在 AirpSettings.autonomy 上，随角色持久化。
 * enabled 是「功能开关」——与 AirpSettings.enabled（AIRP 总闸）、
 * autonomyLevel（权限档位）三层语义各自独立，显式保存让配置在反复开关间不丢。
 */
export interface AirpAutonomyConfig {
  /** 该角色是否开启自主背景生活。默认 false（opt-in）。 */
  enabled: boolean;
  /** 模板 id；未知值回落 'custom'。 */
  templateId: AirpAutonomyTemplateId;
  /** 与模板的 diff；终值由 mergeAutonomySettings() 合并。默认 {}。 */
  overrides: AirpAutonomyOverrides;
  /** 设置结构版本，当前恒为 1。 */
  version: 1;
}

/**
 * 单个角色的 AIRP 运行时设置。整体挂在 CharacterProfile.airp 上，
 * 随角色持久化；缺省（undefined）代表该角色没开 AIRP，一切维持历史行为。
 */
export interface AirpSettings {
  /** 该角色是否启用 AIRP 运行时。默认 false（opt-in）。 */
  enabled: boolean;
  /** 自主度：0 静默 / 1 只读 / 2 低风险写入 / 3 全自动。默认 2。 */
  autonomyLevel: AirpAutonomyLevel;
  /** 导演模型覆盖；缺省代表沿用角色主模型。 */
  directorModel?: string;
  /** 允许的能力 id 白名单；默认空数组。 */
  capabilities: string[];
  /** 允许的 MCP server 白名单；默认空数组。 */
  mcpAllow: string[];
  /** 是否允许写入类能力；默认 false。 */
  writable: boolean;
  /**
   * 自主背景生活设置。缺省代表该角色没配过自主（一切维持历史行为）。
   * mergeAirpSettings 不校验它——它的终值由 mergeAutonomySettings 单独归并，
   * 原始 diff 原样随角色持久化。
   */
  autonomy?: AirpAutonomyConfig;
  /** 设置结构版本，当前恒为 1。 */
  version: 1;
}

const DEFAULT_AUTONOMY_LEVEL: AirpAutonomyLevel = 2;

/** 只接受普通对象；数组、null 与原始值一律视为无设置。 */
function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false;
}

/** 只接受 0|1|2|3 四种字面量，其余回落默认档。 */
function toAutonomyLevel(value: unknown): AirpAutonomyLevel {
  return value === 0 || value === 1 || value === 2 || value === 3
    ? value
    : DEFAULT_AUTONOMY_LEVEL;
}

/** 空白字符串等同缺省；非字符串一律忽略。 */
function toDirectorModel(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value;
}

/** 只保留字符串条目，非数组输入直接回落空数组。 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 把任意来源的原始值（IndexedDB 里读出来的、导入卡里的、调用方手搓的）
 * 合并成一份完整、合法的 AirpSettings。任何输入都不会抛错：
 * 非对象 → 全默认；对象 → 逐字段校验，非法字段各自回落默认值。
 */
export function mergeAirpSettings(raw: unknown = undefined): AirpSettings {
  const source = isSettingsRecord(raw) ? raw : {};

  return {
    enabled: toBoolean(source.enabled),
    autonomyLevel: toAutonomyLevel(source.autonomyLevel),
    directorModel: toDirectorModel(source.directorModel),
    capabilities: toStringArray(source.capabilities),
    mcpAllow: toStringArray(source.mcpAllow),
    writable: toBoolean(source.writable),
    version: 1,
  };
}
