import React, { useEffect, useState } from 'react';
import { Check, ClockCounterClockwise, SlidersHorizontal } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import { buildAirpSettings } from './AutonomyPanel';
import { mergeAirpSettings, type AirpSettings } from '../../utils/airp/settings';
import { AIRP_CAPABILITIES } from '../../utils/airp/capabilityCatalog';
import type { AirpAutonomyLevel, AirpCapabilityRisk } from '../../utils/airp/types';
import type { AirpCommittedEvent } from '../../utils/airp/commit';
import { listAirpEventsByChar } from '../../utils/airp/eventStore';

/**
 * AIRP 运行时的角色管理面板。
 *
 * 字段归属（LOCKED）：本面板只写 char.airp 的 `autonomyLevel` 与 `capabilities`
 * 两个字段，另只读 `airp_events` 展示活动记录。`enabled` / `mcpAllow` / `writable`
 * 归 AutonomyPanel 独占——两边都不碰对方的字段，避免双写打架。
 *
 * 落库走 apps/Character.tsx 的既有自动保存链路（formData 一变 → updateCharacter →
 * DB.saveCharacter + markAmsgStateDirty 重传 fire_pack），这里不新增任何同步代码。
 * 写回复用 AutonomyPanel 的 buildAirpSettings()：默认值打底 → 现有字段 → patch，
 * 面板不管的字段（enabled / directorModel / mcpAllow / writable / autonomy）原样保留。
 *
 * 空白名单语义已核对运行时快照（utils/airp/snapshot.ts:116-132 resolveCapabilities）：
 * `capabilities` 为空 = 全部能力可用（再受档位与 writable 总闸约束）；非空 = 只保留白名单内。
 *
 * 风格：外壳与控件沿用本页既有卡片语言（bg-white rounded-3xl p-4 shadow-sm border-slate-100）
 * 与 AutonomyPanel 的选项卡 / 徽标写法，不引入新视觉语言、不用动画库。
 */

// ── 纯逻辑（无 DOM，单测覆盖 utils/airp/airpPanelLogic.test.ts）──────────

export const AIRP_LEVEL_OPTIONS: readonly { level: AirpAutonomyLevel; label: string; desc: string }[] = [
  { level: 0, label: 'L0 冻结', desc: '全部静默：不主动、不推送、不改数据，只响应用户。' },
  { level: 1, label: 'L1 生活痕迹', desc: '只读能力可用：查资料、读笔记，但不动任何数据。' },
  { level: 2, label: 'L2 受控剧情（默认）', desc: '低风险写入可用：写日记、自管排程；重大节点仍悬置给用户。' },
  { level: 3, label: 'L3 高自治', desc: '允许明显的世界变化；仍不替用户做决定。' },
];

export const AIRP_RISK_LABELS: Record<AirpCapabilityRisk, string> = {
  read: '只读',
  low_write: '低风险写入',
  confirm: '需确认',
  forbidden: '禁用',
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  conversation: '对话',
  activity: '活动',
  movement: '移动',
  schedule: '排程',
  relationship: '关系',
  discovery: '发现',
  social_trace: '社交痕迹',
};

const IMPACT_LABELS: Record<string, string> = {
  trace: '痕迹',
  minor: '小事',
  major: '大事',
};

const CAPABILITY_IDS: readonly string[] = AIRP_CAPABILITIES.map((capability) => capability.id);

/**
 * 空白名单 = 全部能力可用（与 resolveCapabilities 同口径）。
 * UI 的勾选态按「有效状态」显示：数组空 → 全部勾上。
 */
export const isCapabilityEnabled = (ids: readonly string[], id: string): boolean =>
  ids.length === 0 || ids.includes(id);

/**
 * 勾选 / 取消能力 id，返回新的显式白名单：
 * 空数组先展开成「全部」，再增删；若结果覆盖全部目录项则收敛回空数组（空 = 全部可用）。
 */
export const toggleCapability = (
  ids: readonly string[],
  id: string,
  allIds: readonly string[],
): string[] => {
  const base = ids.length === 0 ? allIds.slice() : ids.filter((item) => typeof item === 'string');
  const enabled = base.includes(id);
  const next = enabled ? base.filter((item) => item !== id) : [...base, id];
  const coversAll = allIds.every((candidate) => next.includes(candidate));
  return coversAll && next.length === allIds.length ? [] : next;
};

/** 换档位：只动 autonomyLevel，其余 airp 字段原样保留（复用 AutonomyPanel 的写回形态）。 */
export const applyAutonomyLevel = (
  current: AirpSettings | undefined,
  level: AirpAutonomyLevel,
): AirpSettings => buildAirpSettings(current, { autonomyLevel: level });

/** 事件时间：M/D HH:mm（与 AutonomyPanel formatStamp 同格式）；坏值回落占位符。 */
export const formatAirpEventTime = (ts: unknown): string => {
  const time = Number(ts);
  if (!Number.isFinite(time)) return '—';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export interface AirpEventRow {
  time: string;
  type: string;
  typeLabel: string;
  summary: string;
  impact: string;
  impactLabel: string;
  disclosed: boolean;
  disclosureLabel: string;
}

/** 事件行展示模型：时间 + 类型 + 摘要 + 影响 / 交代标记；脏数据不吐 undefined。 */
export const formatAirpEventRow = (event: {
  at?: unknown;
  type?: unknown;
  summary?: unknown;
  impact?: unknown;
  disclosedToUser?: unknown;
}): AirpEventRow => {
  const type = typeof event.type === 'string' ? event.type : '';
  const impact = typeof event.impact === 'string' ? event.impact : '';
  const rawSummary = typeof event.summary === 'string' ? event.summary.trim() : '';
  const disclosed = event.disclosedToUser === true;
  return {
    time: formatAirpEventTime(event.at),
    type,
    typeLabel: EVENT_TYPE_LABELS[type] ?? '未知',
    summary: rawSummary.length > 0 ? rawSummary : '（无摘要）',
    impact,
    impactLabel: IMPACT_LABELS[impact] ?? '—',
    disclosed,
    disclosureLabel: disclosed ? '已交代' : '未交代',
  };
};

// ── 小控件（与 AutonomyPanel 同形态）──────────────────────────────────────

const Group: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">{label}</p>
    <div className="bg-slate-50/70 rounded-2xl px-3 py-2.5 space-y-2.5">{children}</div>
    {hint && <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">{hint}</p>}
  </div>
);

const RISK_BADGE: Record<AirpCapabilityRisk, string> = {
  read: 'border-slate-200 bg-white text-slate-500',
  low_write: 'border-violet-200 bg-violet-50 text-violet-600',
  confirm: 'border-amber-200 bg-amber-50 text-amber-600',
  forbidden: 'border-red-200 bg-red-50 text-red-500',
};

const IMPACT_BADGE: Record<string, string> = {
  trace: 'border-slate-200 bg-white text-slate-500',
  minor: 'border-violet-200 bg-violet-50 text-violet-600',
  major: 'border-amber-200 bg-amber-50 text-amber-600',
};

// ── 主面板 ────────────────────────────────────────────────────────────────

interface AirpPanelProps {
  char: CharacterProfile;
  /** 写回整块 char.airp（宿主直接 handleChange('airp', next)）。 */
  onChange: (next: AirpSettings) => void;
}

const AirpPanel: React.FC<AirpPanelProps> = ({ char, onChange }) => {
  const airp = char.airp;
  const level = mergeAirpSettings(airp).autonomyLevel;
  const selectedCapabilities = airp?.capabilities ?? [];

  const emit = (patch: Partial<AirpSettings>) => onChange(buildAirpSettings(airp, patch));
  const setLevel = (next: AirpAutonomyLevel) => onChange(applyAutonomyLevel(airp, next));

  // 活动记录（只读；airp_events 最近 50 条，store 排序为 at 倒序）
  const [events, setEvents] = useState<AirpCommittedEvent[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let alive = true;
    setStatus('loading');
    void listAirpEventsByChar(char.id, 50)
      .then((rows) => {
        if (!alive) return;
        setEvents(Array.isArray(rows) ? rows : []);
        setStatus('ready');
      })
      .catch(() => {
        if (!alive) return;
        setEvents([]);
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, [char.id]);

  return (
    <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-4">
      {/* 头部 */}
      <div className="flex items-center gap-2 min-w-0">
        <SlidersHorizontal size={16} weight="bold" className="text-violet-500 shrink-0" />
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-slate-700">AIRP 权限与能力</h3>
          <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
            只管两件事：TA 能自主到什么程度、能用哪些能力。总闸与工具白名单在上面的「自主背景生活」面板里。
          </p>
        </div>
      </div>

      {/* 档位 */}
      <Group
        label="自主度档位"
        hint="L0 等于关闭自主：运行时要求 L1 以上才生效。只读能力需 L1+、低风险写入需 L2+；「需确认」的能力仍要你当面点过。"
      >
        <div className="grid grid-cols-2 gap-2">
          {AIRP_LEVEL_OPTIONS.map((option) => {
            const active = level === option.level;
            return (
              <button
                key={option.level}
                type="button"
                onClick={() => setLevel(option.level)}
                className={`text-left rounded-2xl border px-3 py-2.5 transition-all ${active ? 'border-violet-400 bg-violet-50' : 'border-slate-200 bg-white active:scale-[0.98]'}`}
              >
                <p className={`text-[11px] font-bold ${active ? 'text-violet-700' : 'text-slate-600'}`}>{option.label}</p>
                <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{option.desc}</p>
              </button>
            );
          })}
        </div>
      </Group>

      {/* 能力白名单 */}
      <Group
        label="能力白名单"
        hint="不勾选任何一项 = 全部能力都可用（仍受上面档位与「自主背景生活」里的「自主可写」开关约束）；勾选后只保留勾中的。"
      >
        <div className="space-y-1.5">
          {AIRP_CAPABILITIES.map((capability) => {
            const checked = isCapabilityEnabled(selectedCapabilities, capability.id);
            return (
              <button
                key={capability.id}
                type="button"
                onClick={() => emit({ capabilities: toggleCapability(selectedCapabilities, capability.id, CAPABILITY_IDS) })}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-2xl border text-left transition-all ${checked ? 'border-violet-400 bg-violet-50' : 'border-slate-200 bg-white active:scale-[0.98]'}`}
              >
                <span className="min-w-0 flex items-center gap-2">
                  <span
                    className={`shrink-0 w-4 h-4 rounded-md border grid place-items-center ${checked ? 'bg-violet-500 border-violet-500 text-white' : 'border-slate-300 text-transparent'}`}
                  >
                    <Check size={11} weight="bold" />
                  </span>
                  <span className="text-[11px] font-bold text-slate-700 leading-relaxed">{capability.title}</span>
                </span>
                <span className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border font-bold ${RISK_BADGE[capability.risk]}`}>
                  {AIRP_RISK_LABELS[capability.risk]}
                </span>
              </button>
            );
          })}
        </div>
      </Group>

      {/* 活动记录（只读） */}
      <div className="border-t border-slate-100 pt-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <ClockCounterClockwise size={13} weight="bold" className="text-violet-500 shrink-0" />
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">活动记录</p>
        </div>
        {status === 'loading' ? (
          <p className="text-[11px] text-slate-400">读取中…</p>
        ) : status === 'error' ? (
          <p className="text-[11px] text-red-500">读取失败，稍后再看。</p>
        ) : events.length === 0 ? (
          <p className="text-[11px] text-slate-400">暂无记录——开着的角色在云端活动过后会写在这里。</p>
        ) : (
          <div className="space-y-1.5">
            {events.map((event) => {
              const row = formatAirpEventRow(event);
              return (
                <div
                  key={event.id}
                  className="rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold text-slate-500">{row.typeLabel}</span>
                    <span className="text-[10px] font-mono text-slate-400">{row.time}</span>
                  </div>
                  <p className="text-[11px] text-slate-600 leading-relaxed whitespace-pre-wrap">{row.summary}</p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${IMPACT_BADGE[row.impact] ?? IMPACT_BADGE.trace}`}>
                      {row.impactLabel}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${row.disclosed ? 'border-slate-200 bg-white text-slate-500' : 'border-amber-200 bg-amber-50 text-amber-600'}`}
                    >
                      {row.disclosureLabel}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default AirpPanel;
