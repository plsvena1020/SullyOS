import { useEffect, useState } from 'react';

/**
 * 布局形态判定（Web 三端适配的唯一事实来源）。
 *
 * - phone   ：手机/平板竖屏用现有 UI（铺满、底部 dock、手机框语义）
 * - desktop ：电脑宽屏用桌面 UI（左侧 Dock + 全尺寸内容区）
 *
 * 判定规则（2026-09-12 定稿）：
 * - 电脑级屏幕（screen.width >= 1000 CSS px）：窗口宽度「超过屏幕一半」即进桌面形态
 *   （贴靠半屏正好是 screen/2，所以用 >=）；半屏比例小于 900 时仍有 900 绝对下限，
 *   保证电脑版两栏主页（左栏 280 + 网格区域）稳定成立。
 * - 手机/平板（screen.width < 1000）：不参与半屏比例（移动端全屏窗口永远是「长于半屏」，
 *   否则手机会被误判成电脑版），沿用旧口径 width >= 1024（平板横屏）。
 * 高度不参与判定：手机形态是按竖屏比例设计的固定满高布局，宽而矮的窗口掉进去会被
 * 上下裁掉；电脑形态的左栏/网格/Dock 各自可以内部滚动，任意高度都能降级使用。
 * pointer:fine 不参与「是否进桌面」的判定——平板横屏是触屏但也该进桌面；它只影响
 * hover 之类的细腻度。用户的 desktopMode 手动三档（auto/on/off）作为覆盖，保留逃生口。
 */
export type LayoutMode = 'phone' | 'desktop';
export type DesktopModePref = 'auto' | 'on' | 'off' | undefined;

/** 电脑版能成立的最小窗口宽度（电脑屏幕上半屏小于它时兜底）。 */
export const LAYOUT_MIN_WIDTH = 900;
/** 「电脑级屏幕」最小宽度；低于它的屏幕（手机/平板）不参与半屏比例规则。 */
export const LAYOUT_MIN_SCREEN = 1000;
/** 手机/平板屏幕进电脑版需要的宽度（沿用旧口径：平板横屏）。 */
export const LAYOUT_TABLET_MIN_WIDTH = 1024;

export const isDesktopLayoutViewport = (width: number, screenWidth = 0): boolean => {
    if (screenWidth >= LAYOUT_MIN_SCREEN) {
        return width >= LAYOUT_MIN_WIDTH || width * 2 >= screenWidth;
    }
    return width >= LAYOUT_TABLET_MIN_WIDTH;
};

export const resolveLayoutMode = (
    desktopMode: DesktopModePref,
    width: number,
    screenWidth = 0,
): LayoutMode => {
    if (desktopMode === 'on') return 'desktop';
    if (desktopMode === 'off') return 'phone';
    return isDesktopLayoutViewport(width, screenWidth) ? 'desktop' : 'phone';
};

const readSize = (): { width: number; screenWidth: number } => {
    if (typeof window === 'undefined') return { width: 0, screenWidth: 0 };
    return {
        width: window.innerWidth,
        screenWidth: window.screen ? window.screen.width : 0,
    };
};

/** 订阅窗口尺寸变化，返回当前布局形态。 */
export const useLayoutMode = (desktopMode: DesktopModePref): LayoutMode => {
    const [size, setSize] = useState(readSize);
    useEffect(() => {
        const onResize = () => setSize(readSize());
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
        };
    }, []);
    return resolveLayoutMode(desktopMode, size.width, size.screenWidth);
};
