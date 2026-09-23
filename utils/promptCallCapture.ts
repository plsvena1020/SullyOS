// utils/promptCallCapture.ts
// 真实发送请求的内存抓取：唯一“完整 prompt”来源。不落盘，不估 token。
export interface CaptureMeta { charId: string; label: string; at?: number }
export type CaptureBlock =
    | { kind: 'text'; role: string; text: string }
    | { kind: 'history'; count: number; fromTs?: number; toTs?: number };
export interface CapturedCall { siteId: string; meta: Required<CaptureMeta>; blocks: CaptureBlock[]; charCount: number }

const BUCKETS = new Map<string, CapturedCall[]>();
const MAX_PER_SITE = 3;
const IMG_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

const foldImages = (text: string): string => {
    let n = 0;
    const out = String(text ?? '').replace(IMG_RE, () => { n += 1; return ''; });
    return n > 0 ? `${out}\n[图片 ×${n}]` : out;
};

export function captureCall(siteId: string, messages: Array<{ role?: string; content?: unknown }>, meta: CaptureMeta): void {
    const blocks: CaptureBlock[] = [];
    let pending: Array<{ role: string; content?: unknown }> = [];
    const flushHistory = () => {
        if (pending.length === 0) return;
        blocks.push({ kind: 'history', count: pending.length });
        pending = [];
    };
    for (const m of messages || []) {
        if (m?.role === 'user' || m?.role === 'assistant') { pending.push(m as { role: string }); continue; }
        flushHistory();
        blocks.push({ kind: 'text', role: String(m?.role ?? 'system'), text: foldImages(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')) });
    }
    flushHistory();
    const entry: CapturedCall = {
        siteId, meta: { charId: meta.charId, label: meta.label, at: meta.at ?? Date.now() },
        blocks, charCount: blocks.reduce((a, b) => a + (b.kind === 'text' ? b.text.length : 0), 0),
    };
    const list = BUCKETS.get(siteId) ?? [];
    list.unshift(entry);
    BUCKETS.set(siteId, list.slice(0, MAX_PER_SITE));
}

export function getCaptured(siteId: string): CapturedCall[] { return [...(BUCKETS.get(siteId) ?? [])]; }
export function clearCaptured(siteId?: string): void {
    if (siteId) BUCKETS.delete(siteId); else BUCKETS.clear();
}
export function renderCapturedText(entry: CapturedCall): string {
    return entry.blocks.map(b => b.kind === 'history' ? `[聊天历史 · ${b.count} 条]` : b.text).join('\n\n');
}
