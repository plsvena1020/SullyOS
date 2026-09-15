import { describe, it, expect } from 'vitest';
import {
  applyAutonomyTemplate,
  isAutonomyCustomized,
  autonomyTitle,
  normalizeTemplateId,
  parseNumberField,
  clampCadencePart,
  clampInt,
  isValidHhmm,
  addChip,
  removeChip,
  buildAirpSettings,
  autonomyGateOpen,
} from '../../components/character/AutonomyPanel';
import type { AirpAutonomyOverrides, AirpSettings } from '../../utils/airp/settings';

const CADENCE: AirpAutonomyOverrides = { cadence: { minHours: 3, maxHours: 5 } };

describe('applyAutonomyTemplate', () => {
  it('三套预填模板都把现有 overrides 换成空 diff', () => {
    for (const id of ['night_player', 'morning_brief', 'surf_share'] as const) {
      expect(applyAutonomyTemplate(id, { overrides: CADENCE })).toEqual({ templateId: id, overrides: {} });
    }
  });

  it('换模板是干净 diff：返回的是新对象，不是原 overrides 的引用', () => {
    const current = { overrides: CADENCE };
    const next = applyAutonomyTemplate('night_player', current);
    expect(next.overrides).not.toBe(current.overrides);
    expect(current.overrides).toEqual(CADENCE);
  });

  it('custom 保留现有 overrides（复制一份，不别名）', () => {
    const current = { overrides: CADENCE };
    const next = applyAutonomyTemplate('custom', current);
    expect(next).toEqual({ templateId: 'custom', overrides: CADENCE });
    expect(next.overrides).not.toBe(current.overrides);
  });

  it('custom 在没有现成 overrides 时给空对象；缺 current 同样不抛', () => {
    expect(applyAutonomyTemplate('custom', {})).toEqual({ templateId: 'custom', overrides: {} });
    expect(applyAutonomyTemplate('custom', undefined)).toEqual({ templateId: 'custom', overrides: {} });
    expect(applyAutonomyTemplate('surf_share', null)).toEqual({ templateId: 'surf_share', overrides: {} });
  });
});

describe('isAutonomyCustomized', () => {
  it('缺省与空对象都算「纯模板」', () => {
    expect(isAutonomyCustomized(undefined)).toBe(false);
    expect(isAutonomyCustomized(null)).toBe(false);
    expect(isAutonomyCustomized({})).toBe(false);
  });

  it('任何一项覆盖都算「自定义」——显式空数组也算（清掉模板预填是有效覆盖）', () => {
    expect(isAutonomyCustomized(CADENCE)).toBe(true);
    expect(isAutonomyCustomized({ interests: [] })).toBe(true);
    expect(isAutonomyCustomized({ push: { mode: 'off', maxPerDay: 1, cooldownMinutes: 0 } })).toBe(true);
  });
});

describe('autonomyTitle', () => {
  it('custom 一律显示自定义', () => {
    expect(autonomyTitle('custom', CADENCE)).toBe('自定义');
    expect(autonomyTitle('custom', {})).toBe('自定义');
  });

  it('有覆盖 → 基于 XX 模板的自定义；无覆盖 → 模板预设：XX', () => {
    expect(autonomyTitle('night_player', {})).toBe('模板预设：深夜玩家');
    expect(autonomyTitle('night_player', undefined)).toBe('模板预设：深夜玩家');
    expect(autonomyTitle('night_player', CADENCE)).toBe('基于深夜玩家模板的自定义');
    expect(autonomyTitle('surf_share', CADENCE)).toBe('基于冲浪分享模板的自定义');
  });
});

describe('normalizeTemplateId', () => {
  it('四个合法 id 原样通过', () => {
    for (const id of ['night_player', 'morning_brief', 'surf_share', 'custom'] as const) {
      expect(normalizeTemplateId(id)).toBe(id);
    }
  });

  it('未知值一律回落 custom', () => {
    for (const raw of [undefined, null, '', 'night', 1, {}, []]) {
      expect(normalizeTemplateId(raw)).toBe('custom');
    }
  });
});

describe('parseNumberField（数字输入：空=清覆盖 / 非法=不提交 / 合法=夹紧）', () => {
  it('空串与纯空白 → clear', () => {
    expect(parseNumberField('', 1, 12)).toEqual({ kind: 'clear' });
    expect(parseNumberField('   ', 1, 12)).toEqual({ kind: 'clear' });
  });

  it('非数字 → keep（不提交，保留原值）', () => {
    expect(parseNumberField('abc', 1, 12)).toEqual({ kind: 'keep' });
    expect(parseNumberField('1e', 1, 12)).toEqual({ kind: 'keep' });
    expect(parseNumberField('--3', 1, 12)).toEqual({ kind: 'keep' });
  });

  it('合法值夹到区间内，四舍五入成整数', () => {
    expect(parseNumberField('5', 1, 12)).toEqual({ kind: 'set', value: 5 });
    expect(parseNumberField('0', 1, 12)).toEqual({ kind: 'set', value: 1 });
    expect(parseNumberField('99', 1, 12)).toEqual({ kind: 'set', value: 12 });
    expect(parseNumberField('3.7', 1, 12)).toEqual({ kind: 'set', value: 4 });
    expect(parseNumberField('-4', 0, 1440)).toEqual({ kind: 'set', value: 0 });
  });
});

describe('clampInt', () => {
  it('夹到区间并取整；NaN 落回下限', () => {
    expect(clampInt(7, 1, 12)).toBe(7);
    expect(clampInt(0, 1, 12)).toBe(1);
    expect(clampInt(30, 1, 12)).toBe(12);
    expect(clampInt(2.4, 1, 12)).toBe(2);
    expect(clampInt(Number.NaN, 1, 12)).toBe(1);
  });
});

describe('clampCadencePart（滑杆永不出现 min > max）', () => {
  it('拖动 min 超过 max 时以 max 为界', () => {
    expect(clampCadencePart('minHours', 10, 4)).toBe(4);
    expect(clampCadencePart('minHours', 3, 5)).toBe(3);
  });

  it('拖动 max 低于 min 时以 min 为界', () => {
    expect(clampCadencePart('maxHours', 1, 3)).toBe(3);
    expect(clampCadencePart('maxHours', 8, 3)).toBe(8);
  });

  it('两头都夹在 1–12 小时，脏输入按另一头兜底', () => {
    expect(clampCadencePart('minHours', 0, 4)).toBe(1);
    expect(clampCadencePart('maxHours', 99, 3)).toBe(12);
    expect(clampCadencePart('minHours', 2, Number.NaN)).toBe(1);
    expect(clampCadencePart('maxHours', 9, 0)).toBe(9);
  });
});

describe('isValidHhmm（静默段形状）', () => {
  it('只接受 00:00–23:59 的 HH:mm', () => {
    expect(isValidHhmm('00:00')).toBe(true);
    expect(isValidHhmm('09:05')).toBe(true);
    expect(isValidHhmm('23:59')).toBe(true);
    expect(isValidHhmm('24:00')).toBe(false);
    expect(isValidHhmm('9:00')).toBe(false);
    expect(isValidHhmm('09:60')).toBe(false);
    expect(isValidHhmm('')).toBe(false);
    expect(isValidHhmm('09:00:00')).toBe(false);
  });
});

describe('chip 增删（兴趣词 / 避开词）', () => {
  it('添加去首尾空白、忽略空串与重复项', () => {
    expect(addChip([], '  冲浪  ')).toEqual(['冲浪']);
    expect(addChip(['冲浪'], '   ')).toEqual(['冲浪']);
    expect(addChip(['冲浪'], '冲浪')).toEqual(['冲浪']);
    expect(addChip(['冲浪'], '游戏')).toEqual(['冲浪', '游戏']);
  });

  it('添加不修改原数组（纯函数）', () => {
    const list = ['冲浪'];
    addChip(list, '游戏');
    expect(list).toEqual(['冲浪']);
  });

  it('删除按值精确移除，删不存在的值等于原样', () => {
    expect(removeChip(['冲浪', '游戏'], '冲浪')).toEqual(['游戏']);
    expect(removeChip(['冲浪'], '不存在')).toEqual(['冲浪']);
    expect(removeChip([], '冲浪')).toEqual([]);
  });
});

describe('buildAirpSettings（写回 char.airp 的完整形态）', () => {
  it('没有 airp 时给安全默认（不发明开关）', () => {
    expect(buildAirpSettings(undefined, {})).toEqual({
      enabled: false,
      autonomyLevel: 2,
      capabilities: [],
      mcpAllow: [],
      writable: false,
      version: 1,
    });
  });

  it('保留面板不管的字段（导演模型 / 能力白名单 / 原有 autonomy），只覆盖 patch', () => {
    const airp: AirpSettings = {
      enabled: true,
      autonomyLevel: 3,
      directorModel: 'foo/bar',
      capabilities: ['read'],
      mcpAllow: ['srv-1'],
      writable: true,
      autonomy: { enabled: true, templateId: 'night_player', overrides: {}, version: 1 },
      version: 1,
    };
    const next = buildAirpSettings(airp, { mcpAllow: ['srv-2'], autonomy: { enabled: false, templateId: 'custom', overrides: {}, version: 1 } });
    expect(next.directorModel).toBe('foo/bar');
    expect(next.capabilities).toEqual(['read']);
    expect(next.autonomyLevel).toBe(3);
    expect(next.enabled).toBe(true);
    expect(next.mcpAllow).toEqual(['srv-2']);
    expect(next.autonomy?.templateId).toBe('custom');
    expect(next.version).toBe(1);
  });

  it('patch 里的 autonomy 覆盖整块，不做深合并（面板自己负责 diff 粒度）', () => {
    const airp: AirpSettings = {
      enabled: false, autonomyLevel: 2, capabilities: [], mcpAllow: [], writable: false, version: 1,
      autonomy: { enabled: true, templateId: 'night_player', overrides: {}, version: 1 },
    };
    const next = buildAirpSettings(airp, { autonomy: { enabled: true, templateId: 'night_player', overrides: {}, version: 1 } });
    expect(next.autonomy).toEqual({ enabled: true, templateId: 'night_player', overrides: {}, version: 1 });
  });
});

describe('autonomyGateOpen（主动消息 2.0 是自主功能的门禁）', () => {
  it('只有角色级 2.0 开关真开才放行', () => {
    expect(autonomyGateOpen({ activeMsg2Config: { enabled: true } })).toBe(true);
    expect(autonomyGateOpen({ activeMsg2Config: { enabled: false } })).toBe(false);
    expect(autonomyGateOpen({ activeMsg2Config: undefined })).toBe(false);
    expect(autonomyGateOpen({})).toBe(false);
    expect(autonomyGateOpen(null)).toBe(false);
    expect(autonomyGateOpen(undefined)).toBe(false);
  });
});
