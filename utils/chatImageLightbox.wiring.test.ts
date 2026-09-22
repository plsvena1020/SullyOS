import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 聊天图片点击放大是一串跨文件的接线（MessageItem → Chat/GroupChat → ImageLightbox），
// 组件本体在 node 环境跑不了，按仓库惯例用源码断言钉住接线与关键行为。
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('聊天图片放大查看接线', () => {
    it('MessageItem 图片气泡可点击，且不破坏贴底校准与懒加载', () => {
        const source = read('../components/chat/MessageItem.tsx');
        expect(source).toContain('onImageClick?.(m.content)');
        expect(source).toContain('aria-label="查看大图"');
        expect(source).toContain("loading={isLatestMessage ? 'eager' : 'lazy'}");
        expect(source).toContain('onLoad={() => onMediaLoad?.(m.id)}');
        // React.memo 比较器补上新 prop，否则 handler 换了也不重渲染。
        expect(source).toContain('prev.onImageClick === next.onImageClick');
        // 空内容仍是「图片已丢失」占位，不渲染可点按钮。
        expect(source).toContain('[图片已丢失]');
    });

    it('Chat 持有唯一灯箱状态并接到 MessageItem', () => {
        const source = read('../apps/Chat.tsx');
        expect(source).toContain("import ImageLightbox from '../components/os/ImageLightbox'");
        expect(source).toContain('const [previewImage, setPreviewImage] = useState<string | null>(null)');
        expect(source).toContain('const handleMessageImageClick = useCallback');
        expect(source).toContain('onImageClick={handleMessageImageClick}');
        expect(source).toContain('<ImageLightbox value={previewImage}');
    });

    it('群聊同样走灯箱，不再 window.open 新标签页', () => {
        const source = read('../apps/GroupChat.tsx');
        expect(source).toContain("import ImageLightbox from '../components/os/ImageLightbox'");
        expect(source).toContain('<ImageLightbox value={previewImage}');
        expect(source).not.toContain('window.open(objectUrl');
        expect(source).not.toContain("window.open(url, '_blank')");
    });

    it('灯箱本体：portal / 三种关闭 / 返回键 / 长图滚动齐全', () => {
        const source = read('../components/os/ImageLightbox.tsx');
        expect(source).toContain('createPortal');
        expect(source).toContain('registerBackHandler');
        expect(source).toContain("event.key === 'Escape'");
        expect(source).toContain('aria-label="关闭图片预览"');
        expect(source).toContain('object-contain');
        expect(source).toContain('overflow-y-auto');
        expect(source).toContain('z-[300]');
    });
});
