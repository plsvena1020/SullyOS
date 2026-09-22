import React from 'react';
import { useOS } from '../../context/OSContext';
import { useLayoutMode } from '../../utils/layoutMode';
import { DesktopBackdrop } from './DesktopBackdrop';

/**
 * 桌面外壳两态：
 *   1. desktop（电脑屏幕上宽于半屏或 >= 900，或用户强制）→ 全屏电脑版 UI（左侧 Dock 由 PhoneShell 内部渲染）；
 *   2. 其余（手机/平板竖屏/窄窗）→ 透传，手机 UI 铺满窗口。
 * 2026-09-11 起移除「窗口化手机框」仿真层，不再有居中金属外框。
 */
export const DesktopHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { theme } = useOS();
    const layoutMode = useLayoutMode(theme.desktopMode);

    if (layoutMode === 'desktop') {
        return (
            <div className="fixed inset-0 z-0 overflow-hidden bg-black">
                <DesktopBackdrop wallpaper={theme.wallpaper ?? ''} mode={theme.desktopBackdrop ?? 'blur'} />
                <div className="relative z-10 h-full w-full">{children}</div>
            </div>
        );
    }
    return <>{children}</>;
};
