/**
 * imageGenPending — 「角色正在生成一张图」的页面会话内存态。
 *
 * 聊天页在生成期间显示一条「正在加载图片…」气泡；生成完（成功 / 失败 / Abort）熄灭。
 * 刻意**不落库**：刷新 / 关页会同时杀掉浏览器里的生图任务，提示跟着一起消失才诚实，
 * 不会留下永远「正在加载」的幽灵气泡。
 *
 * 按角色计数：同一角色同时排队多张时，最后一张收尾才熄灯。
 * 纯内存、零依赖（React 侧用 useSyncExternalStore / 订阅皆可）。
 */

interface PendingEntry {
    count: number;
    startedAt: number;
}

const pending = new Map<string, PendingEntry>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) {
        try {
            listener();
        } catch (e) {
            console.warn('[imageGenPending] listener failed', e);
        }
    }
}

/** 一张图开始生成（Key 检查通过、真正要跑之后才调用；不会生成的路径不要打标记）。 */
export function markImageGenStarted(charId: string): void {
    const key = String(charId || '');
    if (!key) return;
    const cur = pending.get(key);
    pending.set(key, { count: (cur?.count ?? 0) + 1, startedAt: cur?.startedAt ?? Date.now() });
    emit();
}

/** 一张图收尾（成功 / 失败 / Abort 都走这里）。 */
export function markImageGenSettled(charId: string): void {
    const key = String(charId || '');
    if (!key) return;
    const cur = pending.get(key);
    if (!cur) return;
    if (cur.count <= 1) pending.delete(key);
    else pending.set(key, { ...cur, count: cur.count - 1 });
    emit();
}

/** 这个角色名下还有几张图在生成（0 = 不显示提示）。 */
export function getPendingImageGenCount(charId: string): number {
    return pending.get(String(charId || ''))?.count ?? 0;
}

/** 订阅 pending 变化；返回取消订阅函数。 */
export function subscribeImageGenPending(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
