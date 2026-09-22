import React from 'react';
import { useOS } from '../../context/OSContext';
import { AppID, type AppConfig } from '../../types';
import AppIcon from '../os/AppIcon';
import { useLauncherLayout } from '../../context/LauncherLayoutContext';
import { useLauncherDrag } from '../../hooks/useLauncherDrag';

/** 「主屏」按钮用的合成 AppConfig（Launcher 不在 INSTALLED_APPS 里）。 */
const HOME_APP: AppConfig = { id: AppID.Launcher, name: '主屏', icon: 'Launcher', color: 'slate' };

const DockItem: React.FC<{ app: AppConfig; active: boolean; blockClick: boolean; onClick: () => void }> = ({ app, active, blockClick, onClick }) => (
    <div className={`relative flex items-center justify-center rounded-2xl transition-colors ${active ? 'bg-white/22' : 'hover:bg-white/12'}`}>
        {active && <span className="pointer-events-none absolute -left-[9px] top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-white/85" />}
        <AppIcon app={app} onClick={() => { if (!blockClick) onClick(); }} size="md" variant="dock" />
    </div>
);

/**
 * 桌面形态的左侧全局 Dock（单 App 全屏，不做多窗口）。
 * 顶部「主屏」回启动器；中部 Dock 与手机端共用同一份顺序（LauncherLayoutProvider），
 * 主页内长按可进编辑态，与桌面网格跨容器对调图标。
 */
export const DesktopDock: React.FC = () => {
    const { activeApp, openApp } = useOS();
    const { dockApps, editing, beginEdit, drop } = useLauncherLayout();
    const editable = activeApp === AppID.Launcher;
    const drag = useLauncherDrag<HTMLElement>({
        editing: editable && editing,
        canBeginEdit: editable,
        beginEdit,
        onDrop: (source, target) => {
            if (source.kind === 'widget' || target.kind === 'widget') return;
            drop(
                { id: source.id, kind: source.kind as 'app' | 'dock' },
                { id: target.id, kind: target.kind as 'app' | 'dock' },
            );
        },
    });

    return (
        <aside
            className="absolute left-0 top-0 z-[30] flex h-full w-[68px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto no-scrollbar border-r border-white/10 bg-black/30 py-4 backdrop-blur-2xl"
            {...drag.handlers}
        >
            <DockItem app={HOME_APP} active={activeApp === AppID.Launcher} blockClick={false} onClick={() => openApp(AppID.Launcher)} />
            <div className="my-1.5 h-px w-8 bg-white/12" />
            {dockApps.map((app) => (
                <div
                    key={app.id}
                    data-launcher-item={app.id}
                    data-launcher-kind="dock"
                    className={`relative ${editable && editing ? 'launcher-edit-item' : ''}`}
                >
                    <DockItem
                        app={app}
                        active={activeApp === app.id}
                        blockClick={editable && editing}
                        onClick={() => openApp(app.id)}
                    />
                </div>
            ))}
        </aside>
    );
};
