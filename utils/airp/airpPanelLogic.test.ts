import { describe, it, expect } from 'vitest';
import {
  applyAutonomyLevel,
  isCapabilityEnabled,
  toggleCapability,
  formatAirpEventTime,
  formatAirpEventRow,
  AIRP_LEVEL_OPTIONS,
  AIRP_RISK_LABELS,
} from '../../components/character/AirpPanel';
import { AIRP_CAPABILITIES } from '../../utils/airp/capabilityCatalog';
import type { AirpSettings } from '../../utils/airp/settings';

const ALL_IDS = ['a', 'b', 'c'];

const FULL: AirpSettings = {
  enabled: true,
  autonomyLevel: 3,
  directorModel: 'foo/bar',
  capabilities: ['a'],
  mcpAllow: ['srv-1'],
  writable: true,
  autonomy: { enabled: true, templateId: 'night_player', overrides: {}, version: 1 },
  version: 1,
};

describe('AIRP_LEVEL_OPTIONS（L0-L3 档位与一句后果）', () => {
  it('恰好四档 0-3，顺序稳定', () => {
    expect(AIRP_LEVEL_OPTIONS.map((option) => option.level)).toEqual([0, 1, 2, 3]);
  });

  it('每档都有非空 label 与 desc；L0 说明「静默」', () => {
    for (const option of AIRP_LEVEL_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.desc.length).toBeGreaterThan(0);
    }
    expect(AIRP_LEVEL_OPTIONS[0].desc).toContain('静默');
  });
});

describe('AIRP_RISK_LABELS（能力风险档中文标签）', () => {
  it('四种风险档都有标签', () => {
    for (const risk of ['read', 'low_write', 'confirm', 'forbidden'] as const) {
      expect(AIRP_RISK_LABELS[risk].length).toBeGreaterThan(0);
    }
  });

  it('目录里出现的每个风险档都能取到标签', () => {
    for (const capability of AIRP_CAPABILITIES) {
      expect(AIRP_RISK_LABELS[capability.risk]).toBeTruthy();
    }
  });
});

describe('applyAutonomyLevel（换档位只动 autonomyLevel，别的 airp 字段原样保留）', () => {
  it('没有 airp 时给安全默认 + 目标档位', () => {
    expect(applyAutonomyLevel(undefined, 1)).toEqual({
      enabled: false,
      autonomyLevel: 1,
      capabilities: [],
      mcpAllow: [],
      writable: false,
      version: 1,
    });
  });

  it('已有 airp：只改档位，导演模型 / 能力白名单 / MCP 白名单 / 可写 / autonomy 全保留', () => {
    const next = applyAutonomyLevel(FULL, 0);
    expect(next.autonomyLevel).toBe(0);
    expect(next.enabled).toBe(true);
    expect(next.directorModel).toBe('foo/bar');
    expect(next.capabilities).toEqual(['a']);
    expect(next.mcpAllow).toEqual(['srv-1']);
    expect(next.writable).toBe(true);
    expect(next.autonomy?.templateId).toBe('night_player');
    expect(next.version).toBe(1);
  });

  it('不改入参（返回新对象，autonomy 块不别名）', () => {
    const before = JSON.parse(JSON.stringify(FULL));
    const next = applyAutonomyLevel(FULL, 2);
    expect(FULL).toEqual(before);
    expect(next).not.toBe(FULL);
  });

  it('四档都能落盘', () => {
    for (const level of [0, 1, 2, 3] as const) {
      expect(applyAutonomyLevel(FULL, level).autonomyLevel).toBe(level);
    }
  });
});

describe('isCapabilityEnabled（空白名单 = 全部能力可用，与运行时归并同口径）', () => {
  it('空数组对任何 id 都为真', () => {
    expect(isCapabilityEnabled([], 'a')).toBe(true);
    expect(isCapabilityEnabled([], 'not-in-catalog')).toBe(true);
  });

  it('非空白名单按 id 精确匹配', () => {
    expect(isCapabilityEnabled(['a', 'b'], 'a')).toBe(true);
    expect(isCapabilityEnabled(['a', 'b'], 'c')).toBe(false);
  });
});

describe('toggleCapability（勾选 = 显式白名单；勾满收敛回空 = 全部可用）', () => {
  it('从空（全可用）取消一项 → 显式列出其余项', () => {
    expect(toggleCapability([], 'b', ALL_IDS)).toEqual(['a', 'c']);
  });

  it('把刚才取消的项勾回来 → 收敛回空数组（全部可用）', () => {
    expect(toggleCapability(['a', 'c'], 'b', ALL_IDS)).toEqual([]);
  });

  it('显式白名单里取消一项 → 只删该项', () => {
    expect(toggleCapability(['a', 'b'], 'a', ALL_IDS)).toEqual(['b']);
  });

  it('显式白名单里补上最后缺的一项 → 收敛回空数组', () => {
    expect(toggleCapability(['b', 'c'], 'a', ALL_IDS)).toEqual([]);
  });

  it('不修改入参（纯函数）', () => {
    const ids = ['a'];
    toggleCapability(ids, 'b', ALL_IDS);
    expect(ids).toEqual(['a']);
  });

  it('白名单里混进目录外 id 时，不会误判为「勾满」而丢配置', () => {
    expect(toggleCapability(['ghost'], 'a', ALL_IDS)).toEqual(['ghost', 'a']);
  });

  it('在空态勾选目录外 id：目录内仍全勾，不产生多余项', () => {
    expect(toggleCapability([], 'ghost', ALL_IDS)).toEqual(['a', 'b', 'c', 'ghost']);
  });
});

describe('formatAirpEventTime（M/D HH:mm，坏值回落占位）', () => {
  it('有效时间戳按本地时间格式化', () => {
    expect(formatAirpEventTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe('1/2 03:04');
    expect(formatAirpEventTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe('12/31 23:59');
  });

  it('缺值 / 非数字 / 非有限数 → 占位符', () => {
    expect(formatAirpEventTime(undefined)).toBe('—');
    expect(formatAirpEventTime('abc')).toBe('—');
    expect(formatAirpEventTime(Number.NaN)).toBe('—');
    expect(formatAirpEventTime(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatAirpEventRow（时间 + 类型 + 摘要 + 影响 / 交代标记）', () => {
  it('完整事件：字段逐个中文化、摘要去首尾空白', () => {
    const row = formatAirpEventRow({
      at: new Date(2026, 0, 2, 3, 4).getTime(),
      type: 'activity',
      summary: '  去楼下买了杯咖啡  ',
      impact: 'minor',
      disclosedToUser: true,
    });
    expect(row).toEqual({
      time: '1/2 03:04',
      type: 'activity',
      typeLabel: '活动',
      summary: '去楼下买了杯咖啡',
      impact: 'minor',
      impactLabel: '小事',
      disclosed: true,
      disclosureLabel: '已交代',
    });
  });

  it('缺摘要 / 空摘要 / 非字符串摘要 → 占位摘要', () => {
    for (const summary of [undefined, '', '   ', 42, null]) {
      const row = formatAirpEventRow({ at: 0, type: 'discovery', summary, impact: 'trace', disclosedToUser: false });
      expect(row.summary).toBe('（无摘要）');
    }
  });

  it('未交代的事件标记为未交代', () => {
    const row = formatAirpEventRow({ at: 0, type: 'social_trace', summary: '赞了条帖子', impact: 'trace', disclosedToUser: false });
    expect(row.disclosed).toBe(false);
    expect(row.disclosureLabel).toBe('未交代');
    expect(row.typeLabel).toBe('社交痕迹');
  });

  it('未知类型 / 未知影响档走兜底标签，不吐出 undefined', () => {
    const row = formatAirpEventRow({ at: 0, type: 'mystery', summary: 'x', impact: 'huge', disclosedToUser: undefined });
    expect(row.typeLabel).toBe('未知');
    expect(row.impactLabel).toBe('—');
    expect(row.summary).not.toContain('undefined');
    expect(row.typeLabel).not.toContain('undefined');
  });

  it('坏时间戳同样落到占位符', () => {
    const row = formatAirpEventRow({ at: 'nope', type: 'activity', summary: 'x', impact: 'major', disclosedToUser: true });
    expect(row.time).toBe('—');
    expect(row.impactLabel).toBe('大事');
  });
});
