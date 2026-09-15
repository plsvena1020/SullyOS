import type { AirpAutonomyLevel } from './types';

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
