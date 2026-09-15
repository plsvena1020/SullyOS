import type { AgenticToolCtx, dispatchAgenticTool as DispatchFn } from '../agenticTools';
import type { AirpToolExecutor } from './directorClient';

/**
 * AIRP 能力目录里的工具名 → 仓库已有的 agentic 真工具名。
 *
 * 目前只接阶段一白名单里的三个只读工具（见 directorClient 的 STAGE1_WIRED_TOOLS）。
 * 目录名与真名分开是故意的：能力目录是给导演看的「能力」语言，真名是 dispatcher 的
 * case 标签，两边演化节奏不同，硬绑成一个字符串迟早会互相拖累。
 */
const CATALOG_TO_REAL: Record<string, string> = {
    recall_deep: 'recall',
    web_search: 'web_search',
    read_note: 'read_note',
};

function encodeResult(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result === undefined || result === null) return '';
    try {
        const json = JSON.stringify(result);
        return typeof json === 'string' ? json : '';
    } catch {
        return '';
    }
}

/**
 * 给 `runAirpDirector` 用的工具执行器：把导演请求的工具名翻译真名后交给注入的
 * `dispatchAgenticTool`。本模块对 agenticTools 只做类型引用（import type），运行时
 * 零耦合——真函数由调用方注入，方便测试与后续换实现。
 */
export function createChatToolExecutor(
    dispatch: typeof DispatchFn,
    ctx: AgenticToolCtx,
): AirpToolExecutor {
    return {
        async executeTool(toolName: string, args: Record<string, unknown>) {
            const real = CATALOG_TO_REAL[toolName];
            // 未接线 / 打错的名字：抛出去。directorClient 的 resolveToolIntentText 会兜成
            // 「执行失败」，正常路径上走不到（它已先按 STAGE1_WIRED_TOOLS 过滤过）。
            if (real === undefined) throw new Error(`Unknown airp catalog tool: ${toolName}`);
            try {
                const result = await dispatch(real, args, ctx);
                return { ok: true, text: encodeResult(result) };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { ok: false, text: `执行失败：${message}` };
            }
        },
    };
}
