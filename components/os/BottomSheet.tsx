/**
 * 公共 BottomSheet 壳（2026-09-24 ADR：唯一公共壳 + 拖拽关闭）。
 *
 * - scrim 走 scrimVariants（只动 opacity，进入 decel 225ms、退出 accel 195ms）。
 * - 面板走 sheetPanelVariants（y 48px + opacity，进入 decel 225ms、退出 sharp 195ms）。
 * - 拖拽只动 transform：drag="y" + top:0 约束 + elastic 0.12；offset.y > 120 或
 *   velocity.y > 800 时 onClose，否则约束弹回。
 * - 把手限定：dragListener={false}，仅自带把手条绑 dragControls；内容区
 *   （含 textarea 的调用方）永远不触发拖拽。
 * - reduced-motion：命中则 drag 禁用；进出跳切由顶层 MotionConfig reducedMotion="user" 兜底。
 * - 本壳不做 portal；调用方保留自己的 portal/定位上下文，只把 open 条件改成 prop。
 */
import React from 'react';
import {
    AnimatePresence,
    isReducedMotion,
    m,
    scrimVariants,
    sheetPanelVariants,
    useDragControls,
    type PanInfo,
} from '../../utils/motion';

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
    overlayClassName = 'z-[80] bg-black/60 backdrop-blur-sm',
    panelClassName = '',
}) => {
    const controls = useDragControls();
    const canDrag = dismissible && !isReducedMotion();

    const handleDragEnd = (_event: PointerEvent, info: PanInfo): void => {
        if (info.offset.y > 120 || info.velocity.y > 800) onClose();
    };

    return (
        <AnimatePresence>
            {open && (
                <m.div
                    key="bottomsheet"
                    className={`absolute inset-0 flex items-end justify-center ${overlayClassName}`}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    data-testid={testId}
                    variants={scrimVariants()}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    onClick={dismissible ? onClose : undefined}
                >
                    <m.section
                        className={`w-full overflow-y-auto overscroll-contain ${panelClassName}`}
                        style={{ maxHeight }}
                        variants={sheetPanelVariants()}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        onClick={event => event.stopPropagation()}
                        drag={canDrag ? 'y' : false}
                        dragListener={false}
                        dragControls={controls}
                        dragConstraints={{ top: 0 }}
                        dragElastic={0.12}
                        dragMomentum={false}
                        onDragEnd={handleDragEnd}
                    >
                        {dismissible && (
                            <div
                                className="flex justify-center pb-1 pt-3"
                                style={{ touchAction: 'none', cursor: 'grab' }}
                                onPointerDown={event => controls.start(event.nativeEvent)}
                                aria-hidden
                            >
                                <div className="h-1 w-10 rounded-full bg-current opacity-20" />
                            </div>
                        )}
                        {children}
                    </m.section>
                </m.div>
            )}
        </AnimatePresence>
    );
};

export default BottomSheet;
