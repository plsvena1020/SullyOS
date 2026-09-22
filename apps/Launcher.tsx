import React, { useMemo, useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { isPaperWallpaper, useOS } from '../context/OSContext';
import { INSTALLED_APPS } from '../constants';
import AppIcon from '../components/os/AppIcon';
import { DesktopAppGrid } from '../components/desktop/DesktopAppGrid';
import TokenImg from '../components/os/TokenImg';
import { useBlobRefUrl } from '../utils/blobRef';
import { DB } from '../utils/db';
import { CharacterProfile, Anniversary, AppID, DailySchedule } from '../types';
import { ScheduleHomeWidget, ScheduleFullscreenViewer } from '../components/schedule/ScheduleHomeWidget';
import NowPlayingSquareWidget from '../components/os/NowPlayingSquareWidget';
import MobileGameHome from '../components/os/MobileGameHome';
import TamagotchiHome from '../components/os/TamagotchiHome';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { useLocalDateKey } from '../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../utils/timezone';
import { useWheelPager } from '../utils/wheelPager';
import { useLauncherLayout } from '../context/LauncherLayoutContext';
import { useLauncherDrag } from '../hooks/useLauncherDrag';
import { reorderIds } from '../utils/launcherLayout';

const CompanionHome = React.lazy(() => import('../components/os/CompanionHome'));

// --- Isolated Components to prevent full re-renders ---

// 1. Clock Component (Consumes virtualTime)
const DesktopClock = React.memo(({ compact = false }: { compact?: boolean }) => {
    const { virtualTime, theme } = useOS();
    const contentColor = theme.contentColor || '#ffffff';
    const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);

    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const now = new Date();
    const dayName = days[now.getDay()];
    const monthName = months[now.getMonth()];
    const dateNum = now.getDate().toString().padStart(2, '0');
    const yearNum = now.getFullYear();

    // 简单问候（基于虚拟时间）
    const greeting = virtualTime.hours < 5 ? 'Good Night'
        : virtualTime.hours < 12 ? 'Good Morning'
        : virtualTime.hours < 18 ? 'Good Afternoon'
        : 'Good Evening';

    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');

    // 动森彩蛋：NookPhone 主屏时钟 —— 问候 + 大号时间(主角) + 星期·日期
    if (theme.skin === 'animalcrossing') {
        const weekdayTitle = dayName.charAt(0) + dayName.slice(1).toLowerCase();
        const monthTitle = monthName.charAt(0) + monthName.slice(1).toLowerCase();
        return (
            <div className={`text-center animate-fade-in select-none ${compact ? 'mt-3 mb-3' : 'mt-7 mb-5'}`}>
                <div className="text-[13px] font-extrabold tracking-wide" style={{ color: '#8a7a5c' }}>
                    🍃 {greeting}, Resident
                </div>
                <div className={`${compact ? 'text-[2.5rem]' : 'text-[3.5rem]'} font-extrabold leading-none mt-1.5 tracking-[2px]`} style={{ color: '#8b7355' }}>
                    {hh}<span className="animate-pulse" style={{ color: '#cfcab2' }}>:</span>{mm}
                </div>
                <div className="text-[15px] font-bold mt-1.5" style={{ color: '#725C4E' }}>
                    {weekdayTitle} · {monthTitle} {Number(dateNum)}
                </div>
            </div>
        );
    }

    return (
        <div className={`flex flex-col relative animate-fade-in ${compact ? 'mb-3 mt-2' : 'mb-5 mt-5'}`} style={{ color: contentColor }}>
            {/* 顶部装饰 — 状态胶囊 + 细线 */}
            <div className={`flex items-center gap-2 opacity-90 ${compact ? 'mb-2' : 'mb-3'}`}>
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                    style={{
                        background: paper ? 'rgba(224,221,215,0.30)' : 'rgba(255,255,255,0.28)',
                        border: paper ? '1px solid rgba(91,72,51,0.07)' : '1px solid rgba(255,255,255,0.18)',
                    }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: paper ? '#788369' : '#4ade80', boxShadow: paper ? 'none' : '0 0 6px #4ade80' }} />
                    <span className="text-[9px] font-bold tracking-[0.2em] uppercase">System Online</span>
                </div>
                <div className="h-[1px] flex-1 bg-gradient-to-r from-current to-transparent opacity-30" />
                <span className="text-[9px] tracking-[0.2em] uppercase opacity-60">{yearNum}</span>
            </div>

            {/* 问候 */}
            <div className={`text-[11px] tracking-[0.25em] uppercase opacity-55 font-semibold ${compact ? 'mb-0.5' : 'mb-1'}`}>
                {greeting}
            </div>

            {/* 主时钟 */}
            <div className="flex items-end gap-4">
                <div className="relative">
                    <div className={`${paper ? `${compact ? 'text-[3.75rem]' : 'text-[5.65rem]'} font-semibold tracking-[-0.055em] drop-shadow-[0_2px_0_rgba(255,255,255,0.34)]` : `${compact ? 'text-[4.25rem]' : 'text-[6.25rem]'} font-black tracking-tighter drop-shadow-2xl`} leading-[0.84]`}
                        style={{ fontFamily: paper ? `'Iowan Old Style', 'Baskerville', 'Times New Roman', serif` : `'Space Grotesk', 'SF Pro Display', sans-serif`, fontFeatureSettings: '"tnum"' }}>
                        <span>{virtualTime.hours.toString().padStart(2, '0')}</span>
                        <span className="opacity-35 font-thin mx-0.5 animate-pulse">:</span>
                        <span>{virtualTime.minutes.toString().padStart(2, '0')}</span>
                    </div>
                    {/* 细光斑 */}
                    {!paper && <div className="absolute -top-2 -right-3 w-8 h-8 rounded-full pointer-events-none"
                        style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.4), transparent 70%)' }} />}
                </div>

                <div className="flex flex-col justify-end pb-2.5 gap-0.5">
                    <div className="text-[10px] font-bold tracking-[0.22em] opacity-85">{dayName}</div>
                    <div className="flex items-baseline gap-1">
                        <div className={`${compact ? 'text-xl' : 'text-2xl'} font-black leading-none`} style={{ fontFamily: `'Space Grotesk', sans-serif` }}>{dateNum}</div>
                        <div className="text-[10px] font-bold tracking-[0.2em] opacity-70">{monthName}</div>
                    </div>
                </div>
            </div>
        </div>
    );
});

// 2. Character Widget (Consumes Character Data & Messages)
const CharacterWidget = React.memo(({ 
    char, 
    unreadCount, 
    lastMessage, 
    onClick, 
    contentColor,
    paper = false,
    compact = false,
}: { 
    char: CharacterProfile | null, 
    unreadCount: number, 
    lastMessage: string, 
    onClick: () => void,
    contentColor: string,
    paper?: boolean,
    compact?: boolean,
}) => {
    const { theme } = useOS();
    const acnh = theme.skin === 'animalcrossing'; // 动森彩蛋：会"说话"的村民卡
    // 卡片底的虚化头像画在 CSS background-image 上，吃不到 TokenImg 的解析，这里自己解析一次。
    const avatarUrl = useBlobRefUrl(char?.avatar);

    // 动森：村民头像 + AC 对话气泡（显示最近消息，点开聊天）
    if (acnh) {
        return (
            <div className="mb-4 animate-fade-in" onClick={onClick}>
                <div className="flex items-end gap-2.5 cursor-pointer active:scale-[0.98] transition-transform">
                    {/* 村民头像（圆角方块 + 白边） */}
                    <div className={`relative shrink-0 rounded-[26%] overflow-hidden bg-[#e8e2d6] ${compact ? 'w-[48px] h-[48px]' : 'w-[60px] h-[60px]'}`}
                        style={{ border: '3px solid #ffffff', boxShadow: '0 4px 10px -2px rgba(61,52,40,0.28)' }}>
                        {char?.avatar
                            ? <TokenImg value={char.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                            : <div className="w-full h-full flex items-center justify-center text-2xl">🍃</div>}
                        {unreadCount > 0 && (
                            <div className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-[#fc736d] rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                                style={{ border: '2px solid #fff' }}>
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </div>
                        )}
                    </div>
                    {/* AC 对话气泡 */}
                    <div className="relative flex-1 min-w-0 mb-1">
                        <div className="absolute -left-1.5 bottom-3 w-3 h-3 rotate-45"
                            style={{ background: '#FFFBF2', borderLeft: '2px solid #ece0c8', borderBottom: '2px solid #ece0c8' }} />
                        <div className="relative rounded-2xl px-3.5 py-2.5"
                            style={{ background: '#FFFBF2', border: '2px solid #ece0c8', boxShadow: '0 4px 12px -5px rgba(120,90,40,0.25)' }}>
                            <div className="flex items-center gap-1.5 mb-0.5">
                                <span className="text-[13px] font-extrabold truncate" style={{ color: '#725d42' }}>{char?.name || 'Resident'}</span>
                                <span className="text-[11px] leading-none">{unreadCount > 0 ? '💬' : '🍃'}</span>
                            </div>
                            <div className="text-[11px] leading-snug line-clamp-2" style={{ color: '#9f8b68' }}>{lastMessage}</div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="mb-3 group animate-fade-in">
             <div
                className={`relative w-full overflow-hidden rounded-3xl cursor-pointer transition-transform duration-300 active:scale-[0.98] ${compact ? 'h-20' : 'h-24'}`}
                onClick={onClick}
                style={paper ? {
                    background: 'rgba(224,221,215,0.40)',
                    border: '1px solid rgba(91,72,51,0.07)',
                    boxShadow: '0 5px 16px rgba(91,72,51,0.055)',
                } : acnh ? {
                    background: 'rgb(247,243,223)',
                    border: '2px solid #e8e2d6',
                    boxShadow: '0 8px 24px 0 rgba(61,52,40,0.14)',
                } : {
                    background: 'rgba(255,255,255,0.08)',
                    backdropFilter: 'blur(24px) saturate(1.4)',
                    WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.08)',
                }}
             >
                 {/* 背景虚化角色头像（动森模式下省略，避免糊在奶油底上） */}
                 {!acnh && !paper && avatarUrl && (
                     <div className="absolute inset-0 opacity-25 pointer-events-none"
                         style={{
                             backgroundImage: `url(${avatarUrl})`,
                             backgroundSize: 'cover',
                             backgroundPosition: 'center',
                             filter: 'blur(30px) saturate(1.6)',
                             transform: 'scale(1.3)',
                         }} />
                 )}

                 <div className="relative flex items-center p-3 gap-3 h-full">
                     {/* 头像 */}
                     <div className={`shrink-0 rounded-2xl overflow-hidden relative ${compact ? 'w-[56px] h-[56px]' : 'w-[68px] h-[68px]'} ${paper ? 'bg-[#ded2c1]' : 'bg-slate-800'}`}
                         style={{
                             border: paper ? '1px solid rgba(91,72,51,0.14)' : acnh ? '2px solid #e8e2d6' : '1.5px solid rgba(255,255,255,0.25)',
                             boxShadow: paper ? '0 5px 14px rgba(91,72,51,0.13)' : acnh ? '0 4px 12px -4px rgba(61,52,40,0.25)' : '0 4px 14px rgba(0,0,0,0.25)',
                         }}>
                         {char ? (
                             <TokenImg value={char.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                         ) : <div className="w-full h-full bg-white/10 animate-pulse" />}
                         {unreadCount > 0 ? (
                            <div className="absolute bottom-0.5 right-0.5 min-w-[16px] h-[16px] px-1 bg-red-500 rounded-full border border-white/30 shadow-sm flex items-center justify-center text-[9px] font-bold text-white">
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </div>
                         ) : (
                            <div className="absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-white/60" style={{ background: paper ? '#788369' : '#4ade80', boxShadow: paper ? 'none' : '0 0 6px #4ade80' }}></div>
                         )}
                     </div>

                     {/* 文本 */}
                     <div className="flex-1 min-w-0 flex flex-col justify-center gap-1" style={{ color: contentColor }}>
                         <div className="flex items-center gap-1.5">
                             <h3 className={`text-[15px] font-bold tracking-wide truncate ${paper ? '' : 'drop-shadow-md'}`}>
                                 {char?.name || 'NO SIGNAL'}
                             </h3>
                             {unreadCount > 0 ? (
                                 <div className="px-1.5 py-px rounded-full text-[8px] font-bold uppercase tracking-[0.15em]"
                                     style={{ background: 'rgba(239,68,68,0.9)', color: 'white' }}>NEW</div>
                             ) : (
                                 <div className="px-1.5 py-px rounded-full text-[8px] font-bold uppercase tracking-[0.15em]"
                                     style={paper ? { background: 'rgba(120,131,105,0.16)', color: '#68725b' } : acnh ? { background: '#7cba4c', color: 'white' } : { background: 'rgba(255,255,255,0.18)' }}>Online</div>
                             )}
                         </div>
                         <div className="text-xs font-medium leading-relaxed opacity-85 flex items-start gap-1.5">
                            <span
                                aria-hidden="true"
                                className="shrink-0 mt-[0.42em] opacity-45"
                                style={{ width: 0, height: 0, borderTop: '3px solid transparent', borderBottom: '3px solid transparent', borderLeft: '4px solid currentColor' }}
                            />
                            <span className="line-clamp-2">{lastMessage}</span>
                         </div>
                     </div>
                 </div>
             </div>
        </div>
    );
});

// 3. Grid Page Component
const AppGridPage = React.memo(({
    apps,
    openApp,
    acnh = false,
    editing = false,
    columns = 4,
    compact = false,
}: {
    apps: typeof INSTALLED_APPS,
    openApp: (id: AppID) => void,
    acnh?: boolean,
    editing?: boolean,
    columns?: 4 | 6,
    compact?: boolean,
}) => {
    const gapClass = (apps.length > 8)
        ? (compact ? 'gap-y-3.5 gap-x-2 content-center' : 'gap-y-5 gap-x-2 content-center')
        : (compact ? 'gap-y-4 gap-x-2' : 'gap-y-6 gap-x-2');
    return (
        <div
            className={`grid place-items-center animate-fade-in relative ${columns === 6 ? 'grid-cols-6' : 'grid-cols-4'} ${gapClass}`}
            style={compact ? ({ '--app-icon-size': 'clamp(2.5rem, calc((100vw - 6.5rem) / 4), 2.875rem)' } as React.CSSProperties) : undefined}
        >
             {apps.map(app => (
                 <div
                    key={app.id}
                    data-launcher-item={app.id}
                    data-launcher-kind="app"
                    className={`relative transition-transform duration-200 active:scale-95 ${editing ? 'launcher-edit-item' : ''}`}
                 >
                     <AppIcon
                        app={app}
                        onClick={() => { if (!editing) openApp(app.id); }}
                        size="md"
                     />
                 </div>
             ))}
        </div>
    );
});

// 3d. 手机版页适配容器：内容装不下时整页等比缩小到一屏内（scale = 1 时零变化）。
// 正常手机尺寸一定装得下、永远 scale=1；宽而矮的窗口也不再出现「内容被裁 / 需要滚动」。
const FitPage = ({ active, className, style, children }: {
    active: boolean;
    className?: string;
    style?: React.CSSProperties;
    children: React.ReactNode;
}) => {
    const pageRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [scale, setScale] = useState(1);

    const measure = useCallback(() => {
        const content = contentRef.current;
        if (!content) return;
        const available = content.clientHeight;
        const natural = content.scrollHeight;
        const next = available > 1 && natural > available + 1 ? available / natural : 1;
        setScale(prev => (Math.abs(prev - next) > 0.002 ? next : prev));
    }, []);

    useEffect(() => {
        const page = pageRef.current;
        if (!page) return;
        let raf = 0;
        const schedule = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; measure(); });
        };
        measure();
        const ro = new ResizeObserver(schedule);
        ro.observe(page);
        // 内容变化（数据加载、文案更新、图片挂载）也要重量：只监听尺寸变化会漏。
        const mo = new MutationObserver(schedule);
        mo.observe(page, { childList: true, subtree: true, characterData: true });
        return () => {
            ro.disconnect();
            mo.disconnect();
            if (raf) cancelAnimationFrame(raf);
        };
    }, [measure]);

    // 离屏页被 content-visibility 跳过，滚到当前页后补量一次（等渲染完成）。
    useEffect(() => {
        if (!active) return;
        measure();
        const raf = requestAnimationFrame(measure);
        const timer = window.setTimeout(measure, 180);
        return () => {
            cancelAnimationFrame(raf);
            window.clearTimeout(timer);
        };
    }, [active, measure]);

    return (
        <div ref={pageRef} className={className} style={style}>
            <div
                ref={contentRef}
                className="w-full h-full flex flex-col"
                style={scale < 1 ? { transform: `scale(${scale})`, transformOrigin: 'top center' } : undefined}
            >
                {children}
            </div>
        </div>
    );
};

// 3b. Small 2x2 app grid for pinwheel cells
const AppQuadGrid = React.memo(({ apps, openApp, editing = false }: { apps: typeof INSTALLED_APPS, openApp: (id: AppID) => void, editing?: boolean }) => {
    return (
        <div className="w-full h-full grid grid-cols-2 grid-rows-2 place-items-center gap-x-2 gap-y-3">
            {apps.map(app => (
                <div key={app.id} data-launcher-item={app.id} data-launcher-kind="app" className={`relative transition-transform duration-200 active:scale-95 ${editing ? 'launcher-edit-item' : ''}`}>
                    <AppIcon app={app} onClick={() => { if (!editing) openApp(app.id); }} />
                </div>
            ))}
        </div>
    );
});

// 3c. Square image slot for pinwheel (bottom-right)
const DesktopSquareImage = React.memo(({ image, contentColor, onClick, acnh = false }: {
    image?: string,
    contentColor: string,
    onClick: () => void,
    acnh?: boolean,
}) => {
    const { theme } = useOS();
    const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
    return (
        <div
            onClick={onClick}
            className="relative w-full h-full rounded-[1.75rem] overflow-hidden cursor-pointer animate-fade-in transition-transform active:scale-[0.98]"
            style={paper ? {
                background: image ? 'rgba(224,221,215,0.26)' : 'rgba(224,221,215,0.38)',
                border: '1px solid rgba(91,72,51,0.07)',
                boxShadow: '0 5px 16px rgba(91,72,51,0.055)',
                color: contentColor,
            } : acnh ? {
                background: image ? 'rgb(247,243,223)' : 'rgb(247,243,223)',
                border: '2px solid #e8e2d6',
                boxShadow: '0 6px 18px rgba(61,52,40,0.12)',
                color: contentColor,
            } : {
                background: image ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.28)',
                border: '1px solid rgba(255,255,255,0.18)',
                boxShadow: '0 8px 30px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.07)',
                color: contentColor,
            }}
        >
            {image ? (
                <TokenImg value={image} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center"
                        style={{ background: paper ? 'rgba(120,131,105,0.10)' : 'rgba(255,255,255,0.1)', border: paper ? '1px solid rgba(91,72,51,0.12)' : '1px solid rgba(255,255,255,0.16)' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" className="w-4 h-4 opacity-70">
                            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                        </svg>
                    </div>
                    <div className="text-[8.5px] uppercase font-bold tracking-[0.22em] opacity-55">Add Image</div>
                    <div className="text-[8.5px] opacity-40 leading-tight">从 外观 · 启动器组件<br/>设置一张方图</div>
                </div>
            )}
        </div>
    );
});

const CALENDAR_WEEKDAYS = [
    { key: 'sun', label: 'S' },
    { key: 'mon', label: 'M' },
    { key: 'tue', label: 'T' },
    { key: 'wed', label: 'W' },
    { key: 'thu', label: 'T' },
    { key: 'fri', label: 'F' },
    { key: 'sat', label: 'S' },
] as const;

// 4. Widget Page Component (Calendar + Events)
const WidgetsPage = React.memo(({ contentColor, openApp, anniversaries, characters, acnh = false, paper = false, compact = false }: any) => {
    // 动森：奶油卡片样式（替代暗色玻璃）
    const acCard = acnh ? { background: 'rgb(247,243,223)', border: '2px solid #e8e2d6', boxShadow: '0 6px 18px rgba(61,52,40,0.12)' } : undefined;
    const acDot = acnh ? '#6fba2c' : undefined;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const monthName = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][currentMonth];
    
    const getDaysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
    const getFirstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();
    
    const totalDays = getDaysInMonth(currentYear, currentMonth);
    const startOffset = getFirstDayOfMonth(currentYear, currentMonth);
    
    const calendarDays = Array.from({ length: totalDays }, (_, i) => i + 1);
    const paddingDays = Array.from({ length: startOffset }, () => null);

    // --- Upcoming events: only today + future, soonest first (non-mutating), paginated ---
    const todayStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const upcomingEvents = useMemo(
        () => [...(anniversaries as any[])]
            .filter((a: any) => a.date >= todayStr)
            .sort((a: any, b: any) => a.date.localeCompare(b.date)),
        [anniversaries, todayStr]
    );
    const EVENTS_PER_PAGE = compact ? 3 : 4;
    const eventPageCount = Math.max(1, Math.ceil(upcomingEvents.length / EVENTS_PER_PAGE));
    const [eventPage, setEventPage] = useState(0);
    // Clamp the page if the list shrinks (e.g. an event passes / is removed)
    useEffect(() => {
        if (eventPage > eventPageCount - 1) setEventPage(eventPageCount - 1);
    }, [eventPageCount, eventPage]);
    const pagedEvents = upcomingEvents.slice(eventPage * EVENTS_PER_PAGE, eventPage * EVENTS_PER_PAGE + EVENTS_PER_PAGE);

    return (
        <div className={`w-full flex flex-col ${compact ? 'px-0 pt-0 pb-0 space-y-4 h-auto' : 'px-6 pt-24 pb-8 space-y-6 h-full'}`}>
              <div className={`rounded-3xl ${compact ? 'p-4' : 'p-6'} ${acnh ? 'shadow-sm' : paper ? '' : 'bg-white/25 border border-white/25 shadow-xl'}`} style={paper ? { background: 'rgba(224,221,215,0.36)', border: '1px solid rgba(91,72,51,0.07)', boxShadow: '0 5px 16px rgba(91,72,51,0.05)' } : acCard}>
                  <div className="flex justify-between items-center mb-4" style={{ color: contentColor }}>
                      <h3 className="text-xl font-bold tracking-widest">{monthName} {currentYear}</h3>
                      <div onClick={() => openApp('schedule')} className={`p-2 rounded-full cursor-pointer transition-colors ${acnh ? 'bg-[#82D5BB]/30 hover:bg-[#82D5BB]/50' : paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/20 hover:bg-white/40'}`}>
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                      </div>
                  </div>
                  
                  <div className="grid grid-cols-7 gap-y-3 gap-x-1 text-center mb-2">
                      {CALENDAR_WEEKDAYS.map(day => <div key={day.key} className="text-[10px] font-bold opacity-40" style={{ color: contentColor }}>{day.label}</div>)}
                  </div>
                  
                  <div className="grid grid-cols-7 gap-y-2 gap-x-1 text-center">
                      {paddingDays.map((_, i) => <div key={`pad-${i}`} />)}
                      {calendarDays.map(day => {
                          const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                          const isToday = day === now.getDate();
                          const hasEvent = anniversaries.some((a: any) => a.date === dateStr);
                          
                          return (
                              <div key={day} className={`flex flex-col items-center justify-center relative ${compact ? 'h-7' : 'h-8'}`}>
                                  <div
                                    className={`${compact ? 'w-7 h-7 text-[13px]' : 'w-8 h-8 text-sm'} flex items-center justify-center rounded-full font-medium ${isToday ? (acnh ? 'text-white font-bold' : paper ? 'text-white font-bold' : 'bg-white text-black font-bold shadow-lg') : 'opacity-80'}`}
                                    style={isToday ? (acnh ? { background: '#19c8b9' } : paper ? { background: '#788369', boxShadow: '0 4px 10px rgba(91,72,51,0.14)' } : {}) : { color: contentColor }}
                                  >
                                      {day}
                                  </div>
                                  {hasEvent && <div className="w-1.5 h-1.5 rounded-full absolute bottom-0 shadow-sm border border-black/10" style={{ background: acDot || (paper ? '#a66f52' : '#c084fc') }}></div>}
                              </div>
                          );
                      })}
                  </div>
              </div>

              <div className={`rounded-3xl ${compact ? 'p-4 flex flex-col min-h-0' : 'p-5 flex flex-col flex-1 min-h-[200px]'} ${acnh ? 'shadow-sm' : paper ? '' : 'bg-white/25 border border-white/25 shadow-xl'}`} style={paper ? { background: 'rgba(224,221,215,0.36)', border: '1px solid rgba(91,72,51,0.07)', boxShadow: '0 5px 16px rgba(91,72,51,0.05)' } : acCard}>
                  <div className="flex items-center justify-between mb-4">
                      <h3 className="text-xs font-bold opacity-60 uppercase tracking-widest flex items-center gap-2" style={{ color: contentColor }}>
                          <span className="w-2 h-2 rounded-full" style={{ background: acDot || (paper ? '#a66f52' : '#c084fc') }}></span> Upcoming Events
                      </h3>
                      {eventPageCount > 1 && (
                          <div className="flex items-center gap-2 shrink-0" style={{ color: contentColor }}>
                              <button
                                  onClick={(e) => { e.stopPropagation(); setEventPage(p => Math.max(0, p - 1)); }}
                                  disabled={eventPage === 0}
                                  className={`w-6 h-6 rounded-full flex items-center justify-center disabled:opacity-25 transition-colors active:scale-90 ${paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/15 hover:bg-white/30'}`}
                                  aria-label="Previous events"
                              >
                                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
                              </button>
                              <span className="text-[10px] font-mono opacity-60 tabular-nums">{eventPage + 1}/{eventPageCount}</span>
                              <button
                                  onClick={(e) => { e.stopPropagation(); setEventPage(p => Math.min(eventPageCount - 1, p + 1)); }}
                                  disabled={eventPage >= eventPageCount - 1}
                                  className={`w-6 h-6 rounded-full flex items-center justify-center disabled:opacity-25 transition-colors active:scale-90 ${paper ? 'bg-[#788369]/10 hover:bg-[#788369]/20' : 'bg-white/15 hover:bg-white/30'}`}
                                  aria-label="Next events"
                              >
                                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                              </button>
                          </div>
                      )}
                  </div>
                  <div className="space-y-3">
                      {upcomingEvents.length > 0 ? pagedEvents.map((anni: any) => (
                          <div key={anni.id} className={`flex items-center gap-3 p-3 rounded-xl ${acnh ? 'bg-[#efe7d4] border border-[#e0d6c0]' : paper ? 'bg-[#f3ecdf]/70 border border-[#5b4833]/10' : 'bg-white/5 border border-white/10'}`}>
                              <div className={`w-10 h-10 shrink-0 rounded-lg flex flex-col items-center justify-center ${acnh ? 'bg-[#82D5BB] text-white border border-[#6cc0a6]' : paper ? 'bg-[#a66f52]/12 text-[#8c5d46] border border-[#a66f52]/15' : 'bg-purple-500/20 text-purple-200 border border-purple-500/30'}`}>
                                  <span className="text-[9px] opacity-70">{anni.date.split('-')[1]}</span>
                                  <span className="text-sm font-bold leading-none">{anni.date.split('-')[2]}</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                  <div className="text-sm font-bold truncate" style={{ color: contentColor }}>{anni.title}</div>
                                  <div className="text-[10px] opacity-50 truncate" style={{ color: contentColor }}>{characters.find((c: any) => c.id === anni.charId)?.name || 'Unknown'}</div>
                              </div>
                          </div>
                      )) : (
                          <div className="text-center opacity-30 text-xs py-8" style={{ color: contentColor }}>No upcoming events</div>
                      )}
                  </div>
              </div>
        </div>
    );
});

// --- Persist scroll page across remounts (e.g. returning from apps) ---
let _lastPageIndex = 0;

// 手机版页面可视区（横向翻页容器）高度低于此值 → 启动紧凑档：
// 缩小时钟/组件/图标并收紧页面留白；仍装不下时页面自身可纵向滚动（见页容器 class）。
const PHONE_COMPACT_MAX_HEIGHT = 540;

// --- Main Launcher ---

const Launcher: React.FC<{ desktop?: boolean }> = ({ desktop = false }) => {
  const { openApp, characters, activeCharacterId, theme, updateTheme, lastMsgTimestamp, isDataLoaded, unreadMessages } = useOS();

  // Local state for widget data to prevent context trashing
  const [widgetChar, setWidgetChar] = useState<CharacterProfile | null>(null);
  const [lastMessage, setLastMessage] = useState<string>('');
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([]);
  const [scheduleData, setScheduleData] = useState<DailySchedule | null>(null);
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null);
  const [scheduleViewerOpen, setScheduleViewerOpen] = useState(false);
  const layoutPageTurnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutPageTurnDirection = useRef<-1 | 0 | 1>(0);

  const [activePageIndex, setActivePageIndex] = useState(_lastPageIndex);
  const activePageIndexRef = useRef(_lastPageIndex);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 量出页面可视区高度（桌面分支没有这个容器，切回手机形态时再挂观察器）。
  const [pageViewportHeight, setPageViewportHeight] = useState(0);
  useEffect(() => {
      if (desktop) {
          setPageViewportHeight(0);
          return;
      }
      const el = scrollContainerRef.current;
      if (!el) return;
      const measure = () => setPageViewportHeight(el.clientHeight);
      measure();
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
  }, [desktop]);
  const phoneCompact = !desktop && pageViewportHeight > 0 && pageViewportHeight < PHONE_COMPACT_MAX_HEIGHT;

  // Mouse Drag Logic refs
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeftRef = useRef(0);
  const dragMoved = useRef(0);

  // Pagination Logic
  // 网格/Dock 的成员与顺序由 LauncherLayoutProvider 统一持有（手机与电脑共用同一份）。
  const { gridApps, dockApps: dockAppsConfig, editing: layoutEditing, beginEdit, finishEdit, drop: dropLauncherLayout } = useLauncherLayout();
  const [pinwheelOrder, setPinwheelOrder] = useState<Array<'music' | 'appsA' | 'appsB' | 'image'>>(() => {
      const available = ['music', 'appsA', 'appsB', 'image'] as const;
      const saved = theme.launcherPinwheelOrder || [];
      return [...saved.filter((id, index) => available.includes(id) && saved.indexOf(id) === index), ...available.filter(id => !saved.includes(id))];
  });
  const pinwheelOrderRef = useRef(pinwheelOrder);
  useEffect(() => { pinwheelOrderRef.current = pinwheelOrder; }, [pinwheelOrder]);
  useEffect(() => {
      if (layoutEditing) return;
      const available = ['music', 'appsA', 'appsB', 'image'] as const;
      const saved = theme.launcherPinwheelOrder || [];
      const next = [...saved.filter((id, index) => available.includes(id) && saved.indexOf(id) === index), ...available.filter(id => !saved.includes(id))];
      pinwheelOrderRef.current = next;
      setPinwheelOrder(next);
  }, [layoutEditing, theme.launcherPinwheelOrder]);

  // gridApps / dockAppsConfig 由 LauncherLayoutProvider 提供。

  // Split apps: pages with widgets keep 4x2 (8), pure grid pages use 4x4 (16).
  // Pages: 0 = clock+chat+grid (8, original), 1 = pinwheel (8),
  //        2 = widget images + grid (8) ONLY when launcherWidgets has tl/tr/wide,
  //            otherwise pure 4x4 (16). 3+ = plain grid only -> 16 per page.
  // Pad to at least 3 slots so pinwheel/widget pages exist.
  const FIRST_PAGE_SIZE = 8;
  const PINWHEEL_PAGE_SIZE = 8;
  const WIDGET_PAGE_SIZE = 8;
  const PURE_PAGE_SIZE = 16;
  const hasPage3Widgets = useMemo(() => {
      const w = (theme.launcherWidgets || {}) as Record<string, unknown>;
      return Boolean(w['tl'] || w['tr'] || w['wide']);
  }, [theme.launcherWidgets]);
  const appPages = useMemo(() => {
      const pages: typeof INSTALLED_APPS[] = [];
      if (gridApps.length === 0) {
          while (pages.length < 3) pages.push([]);
          return pages;
      }
      pages.push(gridApps.slice(0, FIRST_PAGE_SIZE));
      if (gridApps.length > FIRST_PAGE_SIZE) {
          pages.push(gridApps.slice(FIRST_PAGE_SIZE, FIRST_PAGE_SIZE + PINWHEEL_PAGE_SIZE));
          const widgetStart = FIRST_PAGE_SIZE + PINWHEEL_PAGE_SIZE;
          if (gridApps.length > widgetStart) {
              let pureStart = widgetStart;
              if (hasPage3Widgets) {
                  pages.push(gridApps.slice(widgetStart, widgetStart + WIDGET_PAGE_SIZE));
                  pureStart = widgetStart + WIDGET_PAGE_SIZE;
              }
              for (let i = pureStart; i < gridApps.length; i += PURE_PAGE_SIZE) {
                  pages.push(gridApps.slice(i, i + PURE_PAGE_SIZE));
              }
          }
      }
      while (pages.length < 3) pages.push([]);
      return pages;
  }, [gridApps, hasPage3Widgets]);

  // Page 2 (pinwheel) uses appPages[1]: split into two 2x2 quads
  const page2Apps = appPages[1] || [];
  const page2QuadA = useMemo(() => page2Apps.slice(0, 4), [page2Apps]);
  const page2QuadB = useMemo(() => page2Apps.slice(4, 8), [page2Apps]);

  // Total pages = App Pages + 1 Widget Page
  const totalPages = appPages.length + 1;

  useEffect(() => { activePageIndexRef.current = activePageIndex; }, [activePageIndex]);

  useEffect(() => {
      const loadData = async () => {
          // SAFEGUARD: If characters array is empty, reset widget char
          if (!characters || characters.length === 0) {
              setWidgetChar(null);
              setLastMessage('No Character Connected');
              setAnniversaries([]);
              return;
          }

          const targetChar = characters.find(c => c.id === activeCharacterId) || characters[0];
          setWidgetChar(targetChar);

          try {
              const [msgs, annis] = await Promise.all([
                  DB.getMessagesByCharId(targetChar.id),
                  DB.getAllAnniversaries()
              ]);
              
              if (msgs.length > 0) {
                  const visibleMsgs = msgs.filter(m => m.role !== 'system');
                  if (visibleMsgs.length > 0) {
                      const last = visibleMsgs[visibleMsgs.length - 1];
                      const cleanContent = last.content.replace(/\[.*?\]/g, '').trim();
                      setLastMessage(cleanContent || (last.type === 'image' ? '[图片]' : '[消息]'));
                  } else {
                      setLastMessage(targetChar.description || "System Ready.");
                  }
              } else {
                  setLastMessage(targetChar.description || "System Ready.");
              }
              setAnniversaries(annis);
          } catch (e) {
              console.error(e);
          }
      };
      
      if (isDataLoaded) {
          loadData();
      }
  }, [activeCharacterId, lastMsgTimestamp, isDataLoaded, characters]); // Trigger on characters change

  // Schedule widget data loading (shown below SpecialMoments icon)
  const scheduleChar = useMemo(() => {
      if (!characters || characters.length === 0) return null;
      if (scheduleCharId) return characters.find(c => c.id === scheduleCharId) || characters[0];
      return characters.find(c => c.id === activeCharacterId) || characters[0];
  }, [characters, scheduleCharId, activeCharacterId]);
  const scheduleDateKey = useLocalDateKey(resolveCharTimeZone(scheduleChar));

  useEffect(() => {
      if (!scheduleChar || !isDataLoaded) return;
      getDailyScheduleForChar(scheduleChar).then(s => setScheduleData(s)).catch(() => {});
  }, [scheduleChar, isDataLoaded, scheduleDateKey]);

  // Restore scroll position BEFORE paint to avoid visible flash/slide
  useLayoutEffect(() => {
      const el = scrollContainerRef.current;
      if (el && _lastPageIndex > 0) {
          // Temporarily disable smooth scroll so jump is instant
          el.style.scrollBehavior = 'auto';
          el.scrollLeft = el.clientWidth * _lastPageIndex;
          // Re-enable on next frame
          requestAnimationFrame(() => { el.style.scrollBehavior = 'smooth'; });
      }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 滚轮翻页（桌面鼠标）：纵向滚轮 → 上一页/下一页；触控板横滑走原生 snap。
  const onWheelPage = useWheelPager((delta: 1 | -1) => {
      const scroller = scrollContainerRef.current;
      if (!scroller || layoutEditing) return;
      const next = Math.max(0, Math.min(totalPages - 1, activePageIndexRef.current + delta));
      if (next === activePageIndexRef.current) return;
      activePageIndexRef.current = next;
      setActivePageIndex(next);
      _lastPageIndex = next;
      scroller.scrollTo({ left: scroller.clientWidth * next, behavior: 'smooth' });
  });

  const handleScroll = () => {
      if (scrollContainerRef.current) {
          const width = scrollContainerRef.current.clientWidth;
          const scrollLeft = scrollContainerRef.current.scrollLeft;
          const index = Math.round(scrollLeft / width);
          setActivePageIndex(index);
          activePageIndexRef.current = index;
          _lastPageIndex = index; // Persist across remounts
      }
  };

  // --- Mouse Drag Handlers ---
  const handleMouseDown = (e: React.MouseEvent) => {
      if (!scrollContainerRef.current || layoutEditing) return;
      isDragging.current = true;
      dragMoved.current = 0;
      startX.current = e.pageX - scrollContainerRef.current.offsetLeft;
      scrollLeftRef.current = scrollContainerRef.current.scrollLeft;
      
      // Disable snap and smooth scroll for direct control
      scrollContainerRef.current.style.scrollBehavior = 'auto';
      scrollContainerRef.current.style.scrollSnapType = 'none';
      scrollContainerRef.current.style.cursor = 'grabbing';
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (layoutEditing || !isDragging.current || !scrollContainerRef.current) return;
      e.preventDefault();
      const x = e.pageX - scrollContainerRef.current.offsetLeft;
      const walk = (x - startX.current);
      scrollContainerRef.current.scrollLeft = scrollLeftRef.current - walk;
      
      dragMoved.current = Math.abs(x - (startX.current + scrollContainerRef.current.offsetLeft)); 
  };

  const handleMouseUp = () => {
      if (!isDragging.current || !scrollContainerRef.current) return;
      isDragging.current = false;
      
      // Restore styles
      scrollContainerRef.current.style.scrollBehavior = 'smooth';
      scrollContainerRef.current.style.scrollSnapType = 'x mandatory';
      scrollContainerRef.current.style.cursor = 'grab';
  };

  const handleMouseLeave = () => {
      if (isDragging.current) handleMouseUp();
  };

  const handleClickCapture = (e: React.MouseEvent) => {
      if (dragMoved.current > 5 || Date.now() < drag.suppressClickUntil.current) {
          e.stopPropagation();
          e.preventDefault();
      }
  };

  const clearLayoutPageTurn = useCallback(() => {
      if (layoutPageTurnTimer.current) clearTimeout(layoutPageTurnTimer.current);
      layoutPageTurnTimer.current = null;
      layoutPageTurnDirection.current = 0;
  }, []);

  const clearDropTargetRef = useRef<() => void>(() => {});

  const queueLayoutPageTurn = useCallback((direction: -1 | 1) => {
      if (layoutPageTurnDirection.current === direction && layoutPageTurnTimer.current) return;
      clearLayoutPageTurn();
      layoutPageTurnDirection.current = direction;
      const turn = () => {
          const scroller = scrollContainerRef.current;
          if (!scroller || layoutPageTurnDirection.current !== direction) {
              clearLayoutPageTurn();
              return;
          }
          const maxAppPage = Math.max(0, appPages.length - 1);
          const nextPage = Math.max(0, Math.min(maxAppPage, activePageIndexRef.current + direction));
          if (nextPage === activePageIndexRef.current) {
              clearLayoutPageTurn();
              return;
          }
          clearDropTargetRef.current();
          activePageIndexRef.current = nextPage;
          setActivePageIndex(nextPage);
          _lastPageIndex = nextPage;
          scroller.scrollTo({ left: scroller.clientWidth * nextPage, behavior: 'smooth' });
          layoutPageTurnTimer.current = setTimeout(turn, 760);
      };
      layoutPageTurnTimer.current = setTimeout(turn, 560);
  }, [appPages.length, clearLayoutPageTurn]);

  const reorderByTarget = useCallback((kind: string, source: string, target: string) => {
      if (source === target) return;
      if (kind === 'widget') {
          const next = reorderIds(
              pinwheelOrderRef.current,
              source as 'music' | 'appsA' | 'appsB' | 'image',
              target as 'music' | 'appsA' | 'appsB' | 'image',
          );
          if (next === pinwheelOrderRef.current) return;
          pinwheelOrderRef.current = next;
          setPinwheelOrder(next);
          void updateTheme({ launcherPinwheelOrder: next });
          return;
      }
      dropLauncherLayout(
          { id: source, kind: kind as 'app' | 'dock' },
          { id: target, kind: kind as 'app' | 'dock' },
      );
  }, [dropLauncherLayout, updateTheme]);

  const drag = useLauncherDrag({
      editing: layoutEditing,
      beginEdit: () => {
          isDragging.current = false;
          beginEdit();
      },
      onDrop: (source, target) => reorderByTarget(source.kind, source.id, target.id),
      onPageTurn: queueLayoutPageTurn,
      onPageTurnEnd: clearLayoutPageTurn,
  });
  clearDropTargetRef.current = drag.clearDropTarget;

  useEffect(() => () => clearLayoutPageTurn(), [clearLayoutPageTurn]);

  const finishLayoutEditing = () => {
      drag.cancelDrag();
      finishEdit();
  };

  const contentColor = theme.contentColor || '#ffffff';
  const acnh = theme.skin === 'animalcrossing'; // 动森彩蛋：Dock 换奶油木质底
  const paper = theme.skin !== 'animalcrossing' && theme.skin !== 'mobilegame' && theme.skin !== 'tamagotchi' && isPaperWallpaper(theme.wallpaper);
  // 已迁移 App 外壳已收回到可见 viewport 底边，dock 仅需自留视觉间距，无需再 + safe-bottom
  // （否则会比 home 条上方多让 34px，dock 看起来悬空）。
  const launcherBottomInset = '1.25rem';
  
  const totalUnread = Object.values(unreadMessages).reduce((a, b) => a + b, 0);
  const widgetUnread = widgetChar && unreadMessages[widgetChar.id] ? unreadMessages[widgetChar.id] : 0;

  // 手游主题：整页换成二次元手游首页布局（独立组件自渲染），不走下面的默认/动森启动器。
  if (theme.skin === 'mobilegame') {
    return <MobileGameHome />;
  }

  // 电子宠物主题：桌面即养成机——角色真实小屋做舞台 + 四颗糖果实体键（独立组件自渲染）。
  if (theme.skin === 'tamagotchi') {
    return <TamagotchiHome />;
  }

  if (theme.skin === 'companion') {
    return (
      <React.Suspense fallback={<div className="h-full w-full bg-[#100d1c]" />}>
        <CompanionHome />
      </React.Suspense>
    );
  }

  // 桌面形态：左列紧凑小组件 + 右侧自适应应用网格，整页固定一屏（不滚动）；
  // 底部 dock 交给左侧 DesktopDock，横向分页、滚轮翻页一并跳过。
  if (desktop) {
    return (
      <div className="relative flex h-full w-full gap-5 overflow-hidden px-5 py-5" {...drag.handlers}>
        {layoutEditing && (
          <div className="fixed top-[calc(var(--safe-top)+0.65rem)] left-[84px] z-50 flex items-center gap-3 rounded-full px-3 py-2"
              style={{ background: 'rgba(75,65,54,0.88)', color: '#fffdf8', boxShadow: '0 8px 24px rgba(75,65,54,0.20)' }}>
              <span className="text-[10px] font-semibold tracking-wide">按住拖动，松手交换位置</span>
              <button onClick={finishLayoutEditing} className="px-3 py-1 rounded-full text-[10px] font-bold bg-white/15 active:scale-95">完成</button>
          </div>
        )}
        {/* 左列：小部件（compact；极端小窗允许列内滚动，整页不滚） */}
        <div className="flex w-[clamp(280px,22vw,340px)] shrink-0 flex-col gap-4 overflow-y-auto no-scrollbar pr-1">
            <DesktopClock compact />
            <CharacterWidget
              char={widgetChar}
              unreadCount={widgetUnread}
              lastMessage={lastMessage}
              onClick={() => openApp(AppID.Chat)}
              contentColor={contentColor}
              paper={paper}
              compact
            />
            <WidgetsPage
              contentColor={contentColor}
              openApp={openApp}
              anniversaries={anniversaries}
              characters={characters}
              acnh={acnh}
              paper={paper}
              compact
            />
            {scheduleChar && (
              <ScheduleHomeWidget
                schedule={scheduleData}
                character={scheduleChar}
                contentColor={contentColor}
                onOpen={() => setScheduleViewerOpen(true)}
                acnh={acnh}
                paper={paper}
              />
            )}
        </div>
        {/* 右列：自适应应用网格（全部 App 一屏装下，顺序与手机端一致） */}
        <div className="min-w-0 flex-1">
            <DesktopAppGrid apps={gridApps} openApp={openApp} editing={layoutEditing} />
        </div>

        <ScheduleFullscreenViewer
          open={scheduleViewerOpen}
          onClose={() => setScheduleViewerOpen(false)}
          characters={characters}
          activeCharId={scheduleChar?.id || null}
          onSwitchCharacter={(id) => setScheduleCharId(id)}
          schedule={scheduleData}
          activeCharacter={scheduleChar}
          contentColor={contentColor}
        />
      </div>
    );
  }

  return (
    <div
      className="h-full w-full flex flex-col relative z-10 overflow-hidden font-sans select-none"
      {...drag.handlers}
    >

      {layoutEditing && (
          <div className="absolute top-[calc(var(--safe-top)+0.65rem)] left-4 right-4 z-50 flex items-center justify-between rounded-full px-3 py-2"
              style={{ background: 'rgba(75,65,54,0.88)', color: '#fffdf8', boxShadow: '0 8px 24px rgba(75,65,54,0.20)' }}>
              <span className="text-[10px] font-semibold tracking-wide">按住拖动，松手交换位置</span>
              <button onClick={finishLayoutEditing} className="ml-3 px-3 py-1 rounded-full text-[10px] font-bold bg-white/15 active:scale-95">完成</button>
          </div>
      )}
      
      {/* Visual Elements (Decorative Background - Static, low-cost gradients instead of blur) */}
      {/* 动森模式跳过：这层冷蓝光斑会污染奶油底 */}
      {!acnh && (
      <div className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full" style={{ background: paper ? 'radial-gradient(circle, rgba(255,255,255,0.22) 0%, transparent 68%)' : 'radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%)' }}></div>
          <div className="absolute -bottom-20 -left-20 w-80 h-80 rounded-full" style={{ background: paper ? 'radial-gradient(circle, rgba(123,104,78,0.06) 0%, transparent 68%)' : 'radial-gradient(circle, rgba(59,130,246,0.08) 0%, transparent 70%)' }}></div>
      </div>
      )}

      {/* Scrollable Content Layer */}
      {/* UPDATE: Added snap-always to children to ensure one-page-at-a-time scrolling on mobile swipe */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        onWheel={onWheelPage}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClickCapture={handleClickCapture}
        className="flex-1 flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory no-scrollbar cursor-grab active:cursor-grabbing"
        style={{
            scrollBehavior: 'smooth',
            overscrollBehaviorX: 'contain',
            overscrollBehaviorY: 'none',
            touchAction: layoutEditing ? 'none' : 'pan-x pan-y',
            willChange: 'scroll-position',
            contain: 'layout paint',
            transform: 'translateZ(0)',
            WebkitOverflowScrolling: 'touch',
        }}
      >
          {/* Render App Pages */}
          {appPages.map((pageApps, idx) => (
              <FitPage
                key={idx}
                active={activePageIndex === idx}
                className={`w-full flex-shrink-0 snap-center snap-always flex flex-col h-full overflow-hidden ${phoneCompact ? 'px-4 pt-7 pb-6' : 'px-6 pt-12 pb-8'}`}
                style={{ contentVisibility: 'auto', contain: 'layout paint', transform: 'translateZ(0)' }}
              >
                  {idx === 0 ? (
                      // Page 1 (original): Clock + Chat + 4x2 App Grid (keep)
                      <>
                        <DesktopClock compact={phoneCompact} />
                        <CharacterWidget
                            char={widgetChar}
                            unreadCount={widgetUnread}
                            lastMessage={lastMessage}
                            onClick={() => openApp(AppID.Chat)}
                            contentColor={contentColor}
                            paper={paper}
                            compact={phoneCompact}
                        />
                        <div className="flex-1">
                            <AppGridPage apps={pageApps} openApp={openApp} acnh={acnh} editing={layoutEditing} compact={phoneCompact} />
                        </div>
                      </>
                  ) : idx === 1 ? (
                      // Page 2: Schedule 4x2 widget on top + Pinwheel (Music / 2x2 icons / 2x2 icons / Image) below
                      // 安全居中：装得下时内容居中，溢出时从顶部开始（justify-center 会让顶部溢出部分滚不到）。
                      <div className="flex-1 min-h-0 w-full flex flex-col">
                        <div className="w-full my-auto flex flex-col gap-5">
                          {scheduleChar && (
                              <ScheduleHomeWidget
                                  schedule={scheduleData}
                                  character={scheduleChar}
                                  contentColor={contentColor}
                                  onOpen={() => { setScheduleViewerOpen(true);  }}
                                  acnh={acnh}
                                  paper={paper}
                              />
                          )}
                          <div className={`grid grid-cols-2 gap-x-3 w-full mx-auto ${phoneCompact ? 'gap-y-4 max-w-[19rem]' : 'gap-y-5 max-w-[24.75rem]'}`}>
                              {pinwheelOrder.map(cell => (
                                  <div
                                      key={cell}
                                      data-launcher-item={cell}
                                      data-launcher-kind="widget"
                                      className={`aspect-square min-w-0 ${layoutEditing ? 'launcher-edit-item' : ''}`}
                                  >
                                      {cell === 'music' ? (
                                          <NowPlayingSquareWidget contentColor={contentColor} />
                                      ) : cell === 'appsA' ? (
                                          <AppQuadGrid apps={page2QuadA} openApp={openApp} editing={layoutEditing} />
                                      ) : cell === 'appsB' ? (
                                          <AppQuadGrid apps={page2QuadB} openApp={openApp} editing={layoutEditing} />
                                      ) : (
                                          <DesktopSquareImage
                                              image={theme.launcherWidgets?.['dsq']}
                                              contentColor={contentColor}
                                              onClick={() => { if (!layoutEditing) openApp(AppID.Appearance); }}
                                              acnh={acnh}
                                          />
                                      )}
                                  </div>
                              ))}
                          </div>
                        </div>
                      </div>
                  ) : (
                      // Page 3+: Widget Images (idx===2 only) + Free Decorations + Apps
                      <div className={`flex-1 flex flex-col relative ${phoneCompact ? 'pt-6' : 'pt-10'}`}>
                          {idx === 2 && (() => {
                            const raw = theme.launcherWidgets || {};
                            const w = { ...raw };
                            const hasAny = w['tl'] || w['tr'] || w['wide'];
                            const hasTopRow = w['tl'] || w['tr'];
                            return (
                              <>
                                {hasAny && (
                                  <div className={`mb-3 space-y-2 relative z-10 ${phoneCompact ? 'mx-auto w-full max-w-[22rem]' : ''}`}>
                                    {hasTopRow && (
                                      <div className="flex justify-center gap-2">
                                        {['tl', 'tr'].map(key => w[key] ? (
                                          <div key={key} className="flex-1 max-w-[11rem] aspect-square rounded-2xl overflow-hidden shadow-md border border-white/20">
                                            <TokenImg value={w[key]} className="w-full h-full object-cover" alt="" loading="lazy" />
                                          </div>
                                        ) : <div key={key} className="flex-1 max-w-[11rem]"></div>)}
                                      </div>
                                    )}
                                    {w['wide'] && (
                                      <div className={`w-full rounded-2xl overflow-hidden shadow-md border border-white/20 ${phoneCompact ? 'h-24' : 'h-32'}`}>
                                        <TokenImg value={w['wide']} className="w-full h-full object-cover" alt="" loading="lazy" />
                                      </div>
                                    )}
                                  </div>
                                )}
                                {/* Free-positioned Desktop Decorations (z-20 to float above widgets z-10) */}
                                {theme.desktopDecorations && theme.desktopDecorations.length > 0 && (
                                  <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
                                    {theme.desktopDecorations.map(deco => (
                                      <img
                                        key={deco.id}
                                        src={deco.content}
                                        alt=""
                                        loading="lazy"
                                        className="absolute w-16 h-16 object-contain select-none"
                                        style={{
                                          left: `${deco.x}%`,
                                          top: `${deco.y}%`,
                                          transform: `translate(-50%, -50%) scale(${deco.scale}) rotate(${deco.rotation}deg)${deco.flip ? ' scaleX(-1)' : ''}`,
                                          opacity: deco.opacity,
                                          zIndex: deco.zIndex,
                                          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.15))',
                                        }}
                                      />
                                    ))}
                                  </div>
                                )}
                              </>
                            );
                          })()}

                          <AppGridPage
                                apps={pageApps}
                                openApp={openApp}
                                acnh={acnh}
                                editing={layoutEditing}
                                compact={phoneCompact}
                            />
                          <div className="flex-1"></div>
                      </div>
                  )}
              </FitPage>
          ))}

          {/* Final Page: Widgets */}
          <FitPage
            active={activePageIndex === totalPages - 1}
            className="w-full flex-shrink-0 snap-center snap-always h-full overflow-hidden"
          >
            <WidgetsPage
              contentColor={contentColor}
              openApp={openApp}
              anniversaries={anniversaries}
              characters={characters}
              acnh={acnh}
              paper={paper}
            />
          </FitPage>

      </div>

      {/* Page Indicators */}
      <div
          className="absolute left-0 w-full flex justify-center gap-1 pointer-events-none z-20"
          style={{ bottom: `calc(${launcherBottomInset} + 5.5rem)` }}
          aria-hidden="true"
      >
          {Array.from({ length: totalPages }).map((_, i) => (
              // 每个页码占固定 16px 槽位，只动画内部圆点。旧版直接动画 flex child 的宽度，
              // 快速划过多页时 WebKit 会一边改宽一边重算整行居中，几个过渡态就会挤成方块串。
              <div key={i} className="flex h-1.5 w-4 shrink-0 items-center justify-center">
                  <div
                    className={`h-1.5 rounded-full transform-gpu transition-[width,opacity] duration-300 ${activePageIndex === i ? 'w-4 opacity-100' : 'w-1.5 opacity-40'}`}
                    style={{ backgroundColor: contentColor }}
                  />
              </div>
          ))}
      </div>

      {/* Floating Dock - Updated Margin and Safe Area handling */}
      <div
           className="mt-auto flex justify-center w-full px-4 relative z-30"
           style={{ paddingBottom: launcherBottomInset }}
      >
           <div
              className={`rounded-[1.75rem] px-4 py-3 flex gap-3 items-center mx-auto max-w-full justify-between overflow-x-auto no-scrollbar transform-gpu ${acnh || paper ? '' : 'bg-white/30 border border-white/25 shadow-[0_8px_40px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.08)]'}`}
              style={{
                  '--app-icon-size': 'clamp(2.75rem, calc((100vw - 6.5rem) / 4), 3.5rem)',
                  ...(acnh ? { background: 'transparent' } as React.CSSProperties : paper ? {
                      background: 'rgba(224,221,215,0.42)',
                      border: '1px solid rgba(91,72,51,0.07)',
                      boxShadow: '0 6px 18px rgba(91,72,51,0.065)',
                  } as React.CSSProperties : {}),
              } as React.CSSProperties}
           >
               {dockAppsConfig.map(app => (
                   <div key={app.id} data-launcher-item={app.id} data-launcher-kind="dock" className={`relative ${layoutEditing ? 'launcher-edit-item' : ''}`}>
                        <AppIcon app={app} onClick={() => { if (!layoutEditing) openApp(app.id); }} variant="dock" size="md" />
                        {app.id === 'chat' && totalUnread > 0 && (
                            <div className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-white text-[9px] flex items-center justify-center border-2 border-white/20 shadow-sm font-bold pointer-events-none animate-pop-in">
                                {totalUnread > 9 ? '9+' : totalUnread}
                            </div>
                        )}
                   </div>
               ))}
           </div>
      </div>

      <ScheduleFullscreenViewer
          open={scheduleViewerOpen}
          onClose={() => setScheduleViewerOpen(false)}
          characters={characters}
          activeCharId={scheduleChar?.id || null}
          onSwitchCharacter={(id) => setScheduleCharId(id)}
          schedule={scheduleData}
          activeCharacter={scheduleChar}
          contentColor={contentColor}
      />

    </div>
  );
};

export default Launcher;