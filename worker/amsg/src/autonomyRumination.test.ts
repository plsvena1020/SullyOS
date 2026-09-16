// worker/amsg/src/autonomyRumination.test.ts
// 反刍闸（autonomy B2）的纯函数回归守卫。
//
// 这个闸守的是「同一件小事被翻来覆去写」——判定必须只看候选选题与最近 96h 里写过的
// 页，任何时间/随机/IO 都不该进这层（窗口与页数上限都要能被单测钉死）。
import { describe, expect, it } from 'vitest';

import {
  REPICK_ONCE,
  RUMIN_HIT_PAGES,
  RUMIN_PAGES,
  RUMIN_WINDOW_H,
  buildRuminationBanLine,
  resolveRumination,
  ruminationVerdict,
  tokenizeRumination,
  type RuminationPage,
} from './autonomyRumination';

const NOW = Date.parse('2026-09-16T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const page = (q: string, hoursAgo: number): RuminationPage => ({ q, createdAt: NOW - hoursAgo * HOUR });
const unreadablePage = (createdAt: number): RuminationPage => ({ q: null, createdAt });

describe('autonomyRumination 分词', () => {
  it('中文连续段拆二元组，拉丁只收 ≥3 个字符的词', () => {
    const tokens = tokenizeRumination('深海 潜水装备 abc A2 xy');
    expect(tokens).toContain('深海');
    expect(tokens).toContain('潜水');
    expect(tokens).toContain('水装');
    expect(tokens).toContain('abc');
    // 两个字符的拉丁词与单个中文字都不算「可命中的词」——它们太容易误撞。
    expect(tokens).not.toContain('a2');
    expect(tokens).not.toContain('xy');
  });

  it('没有可命中的词时永不拦（空串 / 纯标点）', () => {
    expect(ruminationVerdict('', [page('深海潜水装备', 1), page('深海潜水 装备清单', 2)], NOW).blocked).toBe(false);
    expect(ruminationVerdict('。。。 ！', [page('深海潜水装备', 1), page('深海潜水 装备清单', 2)], NOW).blocked).toBe(false);
  });
});

describe('autonomyRumination 闸的判定', () => {
  it('同一个选题第二回放行、第三回拦住（撞 ≥2 页）', () => {
    const once = [page('深海潜水装备', 2)];
    expect(ruminationVerdict('想看看深海的潜水装备', once, NOW).blocked).toBe(false);

    const twice = [...once, page('深海潜水 装备清单', 1)];
    const third = ruminationVerdict('想看看深海的潜水装备', twice, NOW);
    expect(third.blocked).toBe(true);
    expect(RUMIN_HIT_PAGES).toBe(2);
  });

  it('只比最近 96 小时里的页', () => {
    const stale = [
      page('深海潜水装备', RUMIN_WINDOW_H + 1),
      page('深海潜水 装备清单', RUMIN_WINDOW_H + 2),
    ];
    expect(ruminationVerdict('深海潜水装备', stale, NOW).blocked).toBe(false);
    expect(RUMIN_WINDOW_H).toBe(96);
    // 窗口边缘内（95h）仍算。
    expect(ruminationVerdict('深海潜水装备', [page('深海潜水装备', 95), page('深海潜水 装备清单', 1)], NOW).blocked)
      .toBe(true);
  });

  it('只比最近 12 页，更旧的被挤出窗口', () => {
    const filler: RuminationPage[] = [
      page('深海潜水装备', 40),
      page('深海潜水装备', 41),
      ...Array.from({ length: RUMIN_PAGES }, (_, i) => page(`无关主题${i}`, i + 1)),
    ];
    // 两条撞得上的页是第 13、14 新 → 都被上限挤出去。
    expect(ruminationVerdict('深海潜水装备', filler, NOW).blocked).toBe(false);
    expect(RUMIN_PAGES).toBe(12);
  });

  it('q 缺失 / 时间戳坏掉的页直接忽略（不误判、不抛）', () => {
    const pages = [
      unreadablePage(NOW - 1 * HOUR),
      { q: '深海潜水装备', createdAt: Number.NaN },
      page('深海潜水装备', 1),
      page('深海潜水 装备清单', 2),
    ];
    const verdict = ruminationVerdict('深海潜水装备', pages, NOW);
    expect(verdict.blocked).toBe(true);
    // 坏页不进 burnt lines。
    expect(verdict.burntLines).not.toContain(null);
  });

  it('burnt lines 取命中页的最新搜索词、去重、最新在前', () => {
    const pages = [
      page('深海潜水装备', 5),
      page('深海潜水 装备清单', 1),
      page('深海潜水 装备清单', 3),
    ];
    const verdict = ruminationVerdict('深海潜水装备', pages, NOW);
    expect(verdict.blocked).toBe(true);
    expect(verdict.burntLines).toEqual(['深海潜水 装备清单', '深海潜水装备']);
  });
});

describe('autonomyRumination 换题收敛', () => {
  const blocked = { blocked: true, burntLines: ['深海潜水装备'] };
  const clear = { blocked: false, burntLines: [] };

  it('换题一次成功 → ok', () => {
    expect(REPICK_ONCE).toBe(1);
    expect(resolveRumination([blocked, clear])).toBe('ok');
    expect(resolveRumination([clear])).toBe('ok');
  });

  it('换题仍撞 → rest（不再多试）', () => {
    expect(resolveRumination([blocked, blocked])).toBe('rest');
    expect(resolveRumination([blocked])).toBe('rest');
    expect(resolveRumination([])).toBe('rest');
  });
});

describe('autonomyRumination 禁区行', () => {
  it('burnt lines 指名道姓列进禁区行', () => {
    const pages = [page('深海潜水装备', 5), page('深海潜水 装备清单', 1)];
    const verdict = ruminationVerdict('深海潜水装备', pages, NOW);
    expect(verdict.blocked).toBe(true);

    const ban = buildRuminationBanLine(verdict.burntLines);
    for (const line of verdict.burntLines) {
      expect(ban).toContain(`「${line}」`);
    }
  });

  it('没有 burnt lines 就没有禁区行', () => {
    expect(buildRuminationBanLine([])).toBe('');
    expect(buildRuminationBanLine(['  '])).toBe('');
  });
});
