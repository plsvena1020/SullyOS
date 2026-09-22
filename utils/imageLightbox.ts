/**
 * imageLightbox — 聊天图片放大查看的纯逻辑（组件在 components/os/ImageLightbox.tsx）。
 *
 * 长图判定：高宽比超过阈值的图（手机截图、条漫）在灯箱里按宽度铺满 + 纵向滚动，
 * 普通图居中完整显示（object-contain）。纯函数、零依赖，方便单测。
 */

/** 高宽比超过这个值视为长图（按宽度铺满、可纵向滚动看全）。 */
export const TALL_IMAGE_RATIO = 1.6;

/** naturalWidth / naturalHeight 还不可用（0 / NaN）时按普通图处理。 */
export function shouldScrollImage(naturalWidth: number, naturalHeight: number): boolean {
    if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight)) return false;
    if (naturalWidth <= 0 || naturalHeight <= 0) return false;
    return naturalHeight / naturalWidth > TALL_IMAGE_RATIO;
}
