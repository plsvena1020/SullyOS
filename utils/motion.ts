/**
 * Motion 试点唯一隔离入口（见 2026-09-23-motion-lib-jank-fix-spec Step 7）。
 *
 * 规则：
 * - 时长与曲线只读 `--m2-*` token：运行时优先读 document 上的 CSS 变量，
 *   读不到（SSR / 单测）时回退到下面的 JS 镜像常量（值与 index.html :root 逐字一致）。
 * - 只许 transform / opacity：本文件导出的所有预设只含 x/y/scale/opacity。
 * - reduced-motion 短路：命中 `prefers-reduced-motion: reduce` 时直接返回跳切配置；
 *   顶层再包一层 `MotionConfig reducedMotion="user"` 做双保险。
 * - 包体积：调用方一律走 `LazyMotion features={motionFeatures}`（domAnimation），
 *   唯一例外是 BottomSheet 内层的可拖拽节点：drag 功能只在全量包里，
 *   m + domAnimation 下拖拽静默失效，故该内层用全量 `motion`（仍只动 transform）。
 * - 不放业务逻辑。PhoneShell 容器与 Launcher morph 禁止引用本文件。
 */
import { domAnimation, type Variants } from 'motion/react';

export {
    AnimatePresence,
    LazyMotion,
    MotionConfig,
    m,
    motion,
    useAnimationControls,
    useDragControls,
    useIsPresent,
} from 'motion/react';
export type { PanInfo } from 'motion/react';

/** Motion easing 用 bezier 数组（motion 不接受 CSS cubic-bezier() 字符串）。 */
export type M2Bezier = [number, number, number, number];

/** LazyMotion 特性集：只加载 DOM 动画，目标 5-17KB。 */
export const motionFeatures = domAnimation;

/** JS 镜像：与 index.html :root 的 --m2-* 逐字一致，CSS 变量不可读时兜底。 */
export const M2_MIRROR = {
    easeStandard: [0.4, 0, 0.2, 1] as M2Bezier,
    easeDecel: [0, 0, 0.2, 1] as M2Bezier,
    easeAccel: [0.4, 0, 1, 1] as M2Bezier,
    easeSharp: [0.4, 0, 0.6, 1] as M2Bezier,
    /** 秒制：mirrors --m2-dur-*（CSS 侧是 ms）。 */
    durEnter: 0.225,
    durLeave: 0.195,
    dur150: 0.15,
} as const;

const readCssVar = (name: string, fallback: string): string => {
    try {
        if (typeof document === 'undefined') return fallback;
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    } catch {
        return fallback;
    }
};

/** "cubic-bezier(0.4, 0, 0.2, 1)" → [0.4, 0, 0.2, 1]；解析失败回退 fallback。 */
const cssEaseToBezier = (raw: string, fallback: M2Bezier): M2Bezier => {
    const m = raw.trim().match(/^cubic-bezier\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/);
    if (!m) return fallback;
    const nums = m.slice(1, 5).map(Number);
    if (nums.some(n => !Number.isFinite(n))) return fallback;
    return [nums[0], nums[1], nums[2], nums[3]];
};
const cssDurToSec = (raw: string, fallback: number): number => {
    const m = raw.trim().match(/^([\d.]+)\s*(ms|s)?$/);
    if (!m) return fallback;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return fallback;
    return m[2] === 's' ? n : n / 1000;
};

/** 与 CSS 同源的曲线（读 --m2-ease-* 并转 bezier 数组，读不到用镜像）。 */
export const m2Easings = () => ({
    standard: cssEaseToBezier(readCssVar('--m2-ease-standard', ''), M2_MIRROR.easeStandard),
    decel: cssEaseToBezier(readCssVar('--m2-ease-decel', ''), M2_MIRROR.easeDecel),
    accel: cssEaseToBezier(readCssVar('--m2-ease-accel', ''), M2_MIRROR.easeAccel),
    sharp: cssEaseToBezier(readCssVar('--m2-ease-sharp', ''), M2_MIRROR.easeSharp),
});

/** 与 CSS 同源的时长（秒，读 --m2-dur-*，读不到用镜像）。 */
export const m2Durations = () => ({
    enter: cssDurToSec(readCssVar('--m2-dur-enter', ''), M2_MIRROR.durEnter),
    leave: cssDurToSec(readCssVar('--m2-dur-leave', ''), M2_MIRROR.durLeave),
    short: cssDurToSec(readCssVar('--m2-dur-150', ''), M2_MIRROR.dur150),
});

/** 是否命中 reduced-motion（与 index.html 名单同一 media 条件）。 */
export const isReducedMotion = (): boolean => {
    try {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
};

export interface M2Transition {
    duration: number;
    ease: M2Bezier | 'linear';
}

/** 进入过渡：decel 225ms；reduced-motion 命中直接跳切。 */
export const enterTransition = (): M2Transition =>
    isReducedMotion() ? { duration: 0.01, ease: 'linear' } : { duration: m2Durations().enter, ease: m2Easings().decel };

/** 临时退出过渡（弹窗关闭、切页退出）：sharp 195ms；命中直接跳切。 */
export const leaveTransition = (): M2Transition =>
    isReducedMotion() ? { duration: 0.01, ease: 'linear' } : { duration: m2Durations().leave, ease: m2Easings().sharp };

/** 永久退出过渡：accel 195ms；命中直接跳切。 */
export const dismissTransition = (): M2Transition =>
    isReducedMotion() ? { duration: 0.01, ease: 'linear' } : { duration: m2Durations().leave, ease: m2Easings().accel };

/** scrim（遮罩）：只动 opacity，进入 decel、退出 accel。 */
export const scrimVariants = (): Variants => ({
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: m2Durations().enter, ease: m2Easings().decel } },
    exit: { opacity: 0, transition: { duration: m2Durations().leave, ease: m2Easings().accel } },
});

/** 横向切页 shared axis X：translateX + opacity，进入 decel 225ms、退出 sharp 195ms。 */
export const pageVariants = (dir: 'l' | 'r'): Variants => ({
    initial: { x: dir === 'l' ? 24 : -24, opacity: 0.35 },
    animate: { x: 0, opacity: 1, transition: { duration: m2Durations().enter, ease: m2Easings().decel } },
    exit: { x: dir === 'l' ? -24 : 24, opacity: 0.35, transition: { duration: m2Durations().leave, ease: m2Easings().sharp } },
});

/** Modal 内容 fade：opacity + 小位移 Y（8px 量级），进入 decel、退出 accel。 */
export const modalPanelVariants = (): Variants => ({
    initial: { y: 12, opacity: 0 },
    animate: { y: 0, opacity: 1, transition: { duration: m2Durations().enter, ease: m2Easings().decel } },
    exit: { y: 8, opacity: 0, transition: { duration: m2Durations().leave, ease: m2Easings().accel } },
});

/** Confirm 面板：opacity + 缩放（不做缩放之外的位移），进入 decel、退出 sharp 195ms。 */
export const confirmPanelVariants = (): Variants => ({
    initial: { scale: 0.96, opacity: 0 },
    animate: { scale: 1, opacity: 1, transition: { duration: m2Durations().enter, ease: m2Easings().decel } },
    exit: { scale: 0.98, opacity: 0, transition: { duration: m2Durations().leave, ease: m2Easings().sharp } },
});

/**
 * BottomSheet 面板：y 48px + opacity，进入 decel 225ms、退出 sharp 195ms（2026-09-24 ADR）。
 * 返回具体目标对象（不用 labels）：壳把 initial/exit 直接挂在全量 motion.section 上，
 * animate 位移改由 useAnimationControls 下发，避免 y 同时被 variants 与 drag 驱动。
 */
export const sheetPanelVariants = (): {
    initial: { y: number; opacity: number };
    animate: { y: number; opacity: number; transition: { duration: number; ease: M2Bezier } };
    exit: { y: number; opacity: number; transition: { duration: number; ease: M2Bezier } };
} => ({
    initial: { y: 48, opacity: 0.6 },
    animate: { y: 0, opacity: 1, transition: { duration: m2Durations().enter, ease: m2Easings().decel } },
    exit: { y: 48, opacity: 0, transition: { duration: m2Durations().leave, ease: m2Easings().sharp } },
});
