/**
 * VPS Home 探针 —— 查手机「家」卡片标题栏徽章的数据源。
 *
 * 冻结签名：probeHome({ agentUrl?, agentToken? }) → { key: 'home', label: 'VPS Home', status, detail }。
 * 两段式：先探 /home/health（不 ok→err），再拉 /home/stats（不 ok→warn；ok 则 detail 拼消息/记忆/事件三数）。
 * 口径同 utils/statusPanel 探针：ok 绿 / warn 黄 / err 红 / off 灰（未配置是合法态）；永不抛错。
 * 注意：这里只做 type-only import，运行时零依赖 statusPanel（无循环导入）。
 */
import type { APIConfig } from '../../types';
import type { StatusEntry } from '../../utils/statusPanel';

export const probeHome = async (apiConfig: APIConfig): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'home', label: 'VPS Home', status: 'off', detail: '未配置' };
    const base = (apiConfig.agentUrl || '').replace(/\/+$/, '');
    if (!base) return entry;
    const token = String(apiConfig.agentToken || '').trim();
    const headers: Record<string, string> = {};
    if (token) headers['x-client-token'] = token;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
        const health = await fetch(`${base}/home/health`, { signal: ctrl.signal, headers });
        if (!health.ok) return { ...entry, status: 'err', detail: `HTTP ${health.status}` };
        const stats = await fetch(`${base}/home/stats`, { signal: ctrl.signal, headers });
        if (!stats.ok) return { ...entry, status: 'warn', detail: `HTTP ${stats.status}` };
        try {
            const s = await stats.json() as { messages?: unknown; memories?: unknown; events?: unknown };
            const m = Number(s.messages) || 0;
            const me = Number(s.memories) || 0;
            const e = Number(s.events) || 0;
            return { ...entry, status: 'ok', detail: `消息 ${m} · 记忆 ${me} · 事件 ${e}` };
        } catch {
            return { ...entry, status: 'warn', detail: '数据异常' };
        }
    } catch (e: any) {
        return { ...entry, status: 'err', detail: e?.name === 'AbortError' ? '超时' : '离线' };
    } finally {
        clearTimeout(timer);
    }
};
