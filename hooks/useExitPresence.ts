import { useEffect, useRef, useState } from 'react';

/**
 * 关闭退场动效：open 变 false 后先保持挂载 duration 毫秒播退场，再真正卸载。
 * 返回 mounted（是否渲染）与 phase（'in' | 'out'）；调用方按 phase 挂入场/退场 class。
 */
export const useExitPresence = (open: boolean, duration = 195) => {
    const [mounted, setMounted] = useState(open);
    const [phase, setPhase] = useState<'in' | 'out'>(open ? 'in' : 'out');
    const mountedRef = useRef(mounted);
    mountedRef.current = mounted;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearTimer = () => {
        if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    };

    useEffect(() => {
        if (open) {
            clearTimer();
            setMounted(true);
            setPhase('in');
            return;
        }
        if (!mountedRef.current) return;
        setPhase('out');
        timer.current = setTimeout(() => {
            setMounted(false);
            timer.current = null;
        }, duration);
        return clearTimer;
    }, [open, duration]);

    return { mounted, phase };
};
