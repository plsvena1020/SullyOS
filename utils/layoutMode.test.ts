import { describe, it, expect } from 'vitest';
import {
  resolveLayoutMode,
  isDesktopLayoutViewport,
  LAYOUT_MIN_WIDTH,
  LAYOUT_MIN_SCREEN,
  LAYOUT_TABLET_MIN_WIDTH,
} from './layoutMode';

describe('resolveLayoutMode', () => {
  it('手机竖屏 / 平板竖屏 / 手机横屏 → phone（屏幕不是电脑级，不参与半屏比例）', () => {
    expect(resolveLayoutMode('auto', 393, 393)).toBe('phone');   // 手机竖屏
    expect(resolveLayoutMode('auto', 768, 820)).toBe('phone');   // 平板竖屏
    expect(resolveLayoutMode('auto', 852, 932)).toBe('phone');   // 手机横屏
  });

  it('电脑屏幕：超过半屏即 desktop（含正好贴靠半屏）', () => {
    expect(resolveLayoutMode('auto', 768, 1536)).toBe('desktop');   // 1920 屏 @125% 贴靠半屏
    expect(resolveLayoutMode('auto', 1017, 1536)).toBe('desktop');  // 用户实测窗口
    expect(resolveLayoutMode('auto', 970, 1920)).toBe('desktop');   // 超过 1920 的一半
  });

  it('电脑屏幕：不到半屏且不足绝对下限 → phone', () => {
    expect(resolveLayoutMode('auto', 700, 1536)).toBe('phone');    // 700 < 768（半屏）
    expect(resolveLayoutMode('auto', 880, 1920)).toBe('phone');    // 880 < 960（半屏）且 < 900
  });

  it('电脑屏幕：半屏比例小于 900 时仍有 900 绝对下限', () => {
    expect(resolveLayoutMode('auto', LAYOUT_MIN_WIDTH, 2560)).toBe('desktop');
    expect(resolveLayoutMode('auto', LAYOUT_MIN_WIDTH - 1, 2560)).toBe('phone');
  });

  it('手机/平板屏幕沿用旧口径（宽度 >= 1024）', () => {
    expect(resolveLayoutMode('auto', LAYOUT_TABLET_MIN_WIDTH - 1, 820)).toBe('phone');
    expect(resolveLayoutMode('auto', LAYOUT_TABLET_MIN_WIDTH, 1024)).toBe('desktop');  // 平板横屏
  });

  it('desktopMode 手动覆盖优先于尺寸', () => {
    expect(resolveLayoutMode('on', 393, 393)).toBe('desktop');
    expect(resolveLayoutMode('off', 1920, 1920)).toBe('phone');
  });
});

describe('isDesktopLayoutViewport', () => {
  it('边界值：半屏与绝对下限', () => {
    expect(isDesktopLayoutViewport(768, 1536)).toBe(true);          // 正好半屏
    expect(isDesktopLayoutViewport(767, 1536)).toBe(false);
    expect(isDesktopLayoutViewport(LAYOUT_MIN_WIDTH, 2560)).toBe(true);
    expect(isDesktopLayoutViewport(LAYOUT_MIN_WIDTH - 1, 2560)).toBe(false);
  });

  it('屏幕不足电脑级时退回 1024 口径', () => {
    expect(isDesktopLayoutViewport(1023, LAYOUT_MIN_SCREEN - 1)).toBe(false);
    expect(isDesktopLayoutViewport(1024, LAYOUT_MIN_SCREEN)).toBe(true);
  });
});
