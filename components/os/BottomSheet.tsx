/**
 * 公共 BottomSheet 壳（2026-09-24 ADR：唯一公共壳 + 拖拽关闭）。
 *
 * - scrim 走 scrimVariants（只动 opacity，进入 decel 225ms、退出 accel 195ms）。
 * - 面板走 sheetPanelVariants（y 48px + opacity，进入 decel 225ms、退出 sharp 195ms）。
 * - 拖拽只动 transform：drag="y" + 约束盒 { top: 0, bottom: 320 } + elastic 0.12；
 *   offset.y > 120 或 velocity.y > 800 时 onClose，否则手动弹回。
 * - 把手限定：dragListener={false}，仅自带把手条绑 dragControls；内容区
 *   （含 textarea 的调用方）永远不触发拖拽。
 * - 面板单节点：视觉与 drag 必须在同一节点（拆两层会出现「文字跟手、背景不动」）。
 *   drag 功能只在全量包里，m + domAnimation 下拖拽静默失效，故面板用全量 motion.section；
 *   进场/退场位移由 useAnimationControls 下发，y 只有一个所有者，不与 drag 抢。
 * - reduced-motion：不禁用拖拽（手指 1:1 驱动，非自动晃动），只把回弹降为瞬归位；
 *   进出跳切由顶层 MotionConfig reducedMotion="user" 兜底。
 * - 本壳不做 portal；调用方保留自己的 portal/定位上下文，只把 open 条件改成 prop。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
    AnimatePresence,
    isReducedMotion,
    m,
    motion,
    scrimVariants,
    sheetPanelVariants,
    useAnimationControls,
    useDragControls,
    useIsPresent,
    type PanInfo,
} from '../../utils/motion';

/**
 * presence 守卫：AnimatePresence 在退场 195ms 内保留的是「打开那一刻」的 children 和 props，
 * 所以旧按钮、旧 portal 仍然可点、拖拽也仍能继续。退场开始后统一：
 * - 遮罩层 pointer-events: none（对普通子树生效，跨 React portal 的按钮另由调用方 useIsPresent 处理）；
 * - 通知外层取消拖拽与进行中的面板动画，避免退出过程里继续写 y。
 */
const PresenceGuard: React.FC<{
    children: React.ReactNode;
    overlayClassName: string;
    titleId?: string;
    testId?: string;
    onScrimClick?: () => void;
    onExitStart?: () => void;
}> = ({ children, overlayClassName, titleId, testId, onScrimClick, onExitStart }) => {
    const isPresent = useIsPresent();
    const wasPresent = useRef(true);

    useEffect(() => {
        if (wasPresent.current && !isPresent) onExitStart?.();
        wasPresent.current = isPresent;
    }, [isPresent, onExitStart]);

    return (
        <m.div
            variants={scrimVariants()}
            initial="initial"
            animate="animate"
            exit="exit"
            className={`absolute inset-0 flex items-end justify-center ${overlayClassName}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-testid={testId}
            onClick={onScrimClick}
            style={isPresent ? undefined : { pointerEvents: 'none' }}
        >
            {children}
        </m.div>
    );
};

interface BottomSheetProps {
    open: boolean;
    onClose: () => void;
    children: React.ReactNode;
    titleId?: string;
    /** 默认 true；false 时无把手、不可拖、点外层不关（错误类场景备用）。 */
    dismissible?: boolean;
    /** 默认 '82vh'；调用方迁移时把原 max-h class 换成此 prop，避免与内联样式打架。 */
    maxHeight?: string;
    testId?: string;
    /**
     * 点遮罩是否关闭，默认 true。迁移前个别 sheet 的遮罩没有 onClick（如 CallApp 的通话文字
     * 编辑，点遮罩会丢弃 editingText），这类调用方传 false 保住旧语义；
     * 不要用 dismissible={false} 代替，那会连把手拖拽一起禁掉。
     */
    closeOnScrim?: boolean;
    /** scrim 视觉 + 层级（默认规范源头）；调用方迁移时把原外层 z/bg 搬到这里。 */
    overlayClassName?: string;
    /** 面板视觉（圆角/底色/描边/阴影/内边距）；只收视觉，不收 max-h/overflow（走 maxHeight + 壳内 overflow）。 */
    panelClassName?: string;
}

const BottomSheet: React.FC<BottomSheetProps> = ({
    open,
    onClose,
    children,
    titleId,
    dismissible = true,
    maxHeight = '82vh',
    testId,
    closeOnScrim = true,
    overlayClassName = 'z-[80] bg-black/60 backdrop-blur-sm',
    panelClassName = '',
}) => {
    const controls = useDragControls();
    const panelAnim = useAnimationControls();
    const panelVariants = useMemo(() => sheetPanelVariants(), []);
    // 跟手拖拽不禁用：它是手指 1:1 驱动，不是 reduced-motion 要防的那类自动晃动。
    // 旧实现在这里挂 !isReducedMotion()，导致系统动画关着的机器（Windows MinAnimate=0）
    // 完全拖不动；改为只在回弹时降级（见 handleDragEnd）。
    const canDrag = dismissible;

    // 进场位移由控制器下发（initial 已停在 y 48），确保 y 的唯一所有者是控制器 + 拖拽，
    // 不会和 variants 抢同一个值。用 useLayoutEffect：退场中重开时要在浏览器绘制前接管 y，
    // 避免旧指针会话写完 y 后被 effect 再拉回 0 造成跳变。
    useLayoutEffect(() => {
        if (!open) return;
        void panelAnim.start(panelVariants.animate);
    }, [open, panelAnim, panelVariants]);

    const handleDragEnd = (_event: PointerEvent, info: PanInfo): void => {
        // 回弹交给 dragSnapToOrigin（下面的 prop），这里只判是否请求关闭。
        // 不自己补 y:0 —— 关闭被调用方的 busy guard 拒收时，面板会停在 320px。
        if (info.offset.y > 120 || info.velocity.y > 800) onClose();
    };

    return (
        <AnimatePresence>
            {open && (
                <PresenceGuard
                    overlayClassName={overlayClassName}
                    titleId={titleId}
                    testId={testId}
                    onScrimClick={() => { if (dismissible && closeOnScrim) onClose(); }}
                    onExitStart={() => { controls.cancel(); panelAnim.stop(); }}
                >
                    {/* 面板：视觉（圆角/底色/描边/阴影/内边距）与拖拽必须同在一个节点，
                        否则背景不动、只有内容跟手（2026-09-24 实测症状）。
                        同一个 y 只能有一个所有者，所以进退场的位移改由动画控制器下发，
                        拖拽期间不与它同时运行；进场/退场值仍取 sheetPanelVariants 预设。
                        dragSnapToOrigin 负责松手归位：onClose 被 busy guard 拒收时也必须归零，
                        手写回弹分支会把它留在 320px。 */}
                    <motion.section
                        className={`w-full overflow-y-auto overscroll-contain ${panelClassName}`}
                        style={{ maxHeight }}
                        initial={panelVariants.initial}
                        exit={panelVariants.exit}
                        animate={panelAnim}
                        drag={canDrag ? 'y' : false}
                        dragListener={false}
                        dragControls={controls}
                        dragConstraints={{ top: 0, bottom: 320 }}
                        dragElastic={0.12}
                        dragMomentum={false}
                        dragSnapToOrigin={canDrag}
                        onClick={event => event.stopPropagation()}
                        onDragEnd={handleDragEnd}
                    >
                        {dismissible && (
                            <div
                                className="flex justify-center pb-1 pt-3"
                                style={{ touchAction: 'none', cursor: 'grab' }}
                                onPointerDown={event => controls.start(event)}
                                aria-hidden
                            >
                                <div className="h-1 w-10 rounded-full bg-current opacity-20" />
                            </div>
                        )}
                        {children}
                    </motion.section>
                </PresenceGuard>
            )}
        </AnimatePresence>
    );
};

export default BottomSheet;
