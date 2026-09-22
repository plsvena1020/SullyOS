import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from '@phosphor-icons/react';
import { getPortalHost } from '../../utils/portalHost';
import { useOS } from '../../context/OSContext';
import { shouldScrollImage } from '../../utils/imageLightbox';
import TokenImg from './TokenImg';

interface ImageLightboxProps {
    /** 消息里的原始图片值：blobref 令牌 / data: / http(s)，交给 TokenImg 解析。 */
    value: string;
    onClose: () => void;
}

/**
 * 聊天图片全屏预览（点击图片放大）。
 *
 * 为什么要 portal：MessageItem 的气泡外层带 transform（右滑引用手势），直接渲染
 * position: fixed 会被那个 transform 变成 containing block，灯箱困在消息流里被裁。
 *
 * 关闭方式：点遮罩 / 右上角按钮 / Escape / 系统返回键（Android 硬件返回、PWA 边缘滑）。
 * 灯箱注册的 backHandler 只吞自己这一次返回，不关聊天页。
 *
 * 长图（高宽比 > 1.6，见 utils/imageLightbox）按宽度铺满、容器纵向滚动；普通图居中
 * object-contain 完整显示。
 */
const ImageLightbox: React.FC<ImageLightboxProps> = ({ value, onClose }) => {
    const { registerBackHandler } = useOS();
    const [tall, setTall] = useState(false);

    useEffect(() => registerBackHandler(() => {
        onClose();
        return true;
    }), [onClose, registerBackHandler]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onClose]);

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            className="fixed inset-0 z-[300] bg-black/95 animate-fade-in overscroll-contain"
            style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
            onClick={onClose}
        >
            <button
                type="button"
                onClick={onClose}
                aria-label="关闭图片预览"
                className="absolute right-3 z-10 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white active:scale-95"
                style={{ top: 'calc(var(--safe-top) + 10px)' }}
            >
                <X size={22} />
            </button>
            <div className={tall
                ? 'h-full overflow-y-auto overscroll-contain px-2 py-10'
                : 'flex h-full items-center justify-center p-4'}>
                <TokenImg
                    value={value}
                    alt="图片预览"
                    className={tall ? 'mx-auto block h-auto w-full rounded-xl' : 'max-h-full max-w-full object-contain'}
                    onClick={(event) => event.stopPropagation()}
                    onLoad={(event) => setTall(shouldScrollImage(
                        event.currentTarget.naturalWidth,
                        event.currentTarget.naturalHeight,
                    ))}
                />
            </div>
        </div>,
        getPortalHost(),
    );
};

export default ImageLightbox;
