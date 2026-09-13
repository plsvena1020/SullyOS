/**
 * instantToolRunner — Phase 2 Round 2 客户端 tool runner
 *
 * 消费 SW 写到 `pending_tool_calls` store 的 ToolRequestPush, 用 agenticTools 跑本地工具,
 * 把 OpenAI-shape tool result 拼好 POST /continue 让 worker 续跑下一轮 LLM. final push
 * 由 SW 像首轮一样写 inbox, ActiveMsgRuntime.flushInboxToChat 跑 applyAssistantPostProcessing.
 *
 * 触发时机:
 *   - ActiveMsgRuntime.init 启动时排空一次 (兜底冷启动 / swipe-kill 重启)
 *   - SW 收到 tool_request push + 当前 window visible 时 postMessage('instant-tool-request'),
 *     ActiveMsgRuntime 收到后立刻调用 runPendingToolCalls()
 *
  * 失败语义:
  *   - dispatch 抛错 (DB / 网络) → 这条 pending 已被 atomic claim 走, 重试需要用户重新触发推送
  *   - POST /continue 终态以 deliver() observed 结论为准 (SW 广播 active-msg-received);
  *     SSE 中断只 absorb, 不直接判死, 后续补收 / 点名兜底. 详见 docs/instant-push-dual-channel.md
  *   - 走"先 ack 后处理"是为了不让重投 push 把 toolCalls 跑两遍 (LLM 费用 + UI 重复)
 */

import { ActiveMsgStore } from './activeMsgStore';
import { DB } from './db';
import { dispatchAgenticTool, type AgenticToolCtx } from './agenticTools';
import {
  loadInstantConfig,
  isInstantConfigReady,
  getOrCreateInstantSubscription,
  getInstantOversizeTransport,
  postSsePayloadToServiceWorker,
} from './instantPushClient';
import { pushXhsCaches, pushLastXhsNotesRef } from './activeMsgRuntime';
import { PERSPECTIVE_QUERY_FIRE_TOOL, PERSPECTIVE_SUMMARY_FIRE_TOOL } from './amsgFirePerspective';
import { resolvePerspectiveToolConfig } from './perspectiveTokens';
import { describeToolForUser } from './amsgToolTrace';
import { ReiClient } from '@rei-standard/amsg-client';
import type { APIConfig, RealtimeConfig, UserProfile, InstantPushPendingToolCall } from '../types';

type InstantToolStatusPhase = 'running' | 'continuing' | 'done' | 'failed';

function getToolStatusLabel(toolCalls: InstantPushPendingToolCall['toolCalls']): string {
  const names = toolCalls.map((call) => call.function.name);
  // 优先级只管「一批混着跑时挑哪个说」，说法本身从共享词表取（amsgToolTrace 的
  // TOOL_DISPLAY_LABELS）——状态条和气泡底下的事后灰字必须同词，改词表两处一起变。
  const pick = names.find((name) => name.startsWith('xhs_'))
    ?? names.find((name) => name === 'notion_read_diary' || name === 'read_note')
    ?? names.find((name) => name === 'feishu_read_diary')
    ?? names.find((name) => name === 'web_search')
    ?? names.find((name) => name === 'recall');
  if (!pick) return '调用工具';
  const label = describeToolForUser(pick);
  return label && label !== pick ? label : '调用工具';
}

function emitToolStatus(
  charId: string,
  phase: InstantToolStatusPhase,
  text: string,
  sessionId?: string,
): void {
  const detail = { charId, phase, text, sessionId, updatedAt: Date.now() };
  try {
    localStorage.setItem(`instant_tool_status_${charId}`, JSON.stringify(detail));
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent('instant-tool-status', {
      detail,
    }));
  } catch { /* ignore */ }
}

/** 跑一轮 ToolRequest → POST /continue. 失败时返回 false (上层决定要不要 toast). */
async function runOnePendingToolCall(item: InstantPushPendingToolCall): Promise<boolean> {
  const toolLabel = getToolStatusLabel(item.toolCalls);
  emitToolStatus(
    item.charId,
    'running',
    `正在${toolLabel}，请先停留在此页，完成后会自动继续回复。`,
    item.sessionId,
  );

  const session = await ActiveMsgStore.getOutboundSession(item.sessionId);
  if (!session) {
    console.warn('[instant-tool-runner] outbound session not found, skipping', item.sessionId);
    emitToolStatus(item.charId, 'failed', `${toolLabel}中断了，请重新触发这次回复。`, item.sessionId);
    return false;
  }

  const characters = await DB.getAllCharacters();
  const char = characters.find((c) => c.id === item.charId);
  if (!char) {
    console.warn('[instant-tool-runner] character not found', item.charId);
    emitToolStatus(item.charId, 'failed', `${toolLabel}中断了，请重新触发这次回复。`, item.sessionId);
    return false;
  }

  const userProfile: UserProfile =
    (await DB.getUserProfile()) ?? { name: 'User', avatar: '', bio: '' };
  const realtimeConfig = loadRealtimeConfigFromLocalStorage();

  // tool runner 用的 ctx 跟 applyAssistantPostProcessing 本地 fetch 路径用的是同一个形状.
  //
  // xhsCaches / lastXhsNotesRef 直接复用 activeMsgRuntime 的模块级单例 — 不再每次新建空 Map.
  // 这样 round 1 在这里 runXhsBrowse 填充的 notes + xsecToken 能被 round 2 (worker 发回 push
  // 后 applyAssistantPostProcessing 处理 [[XHS_SHARE: 序号]] / [[XHS_COMMENT: ...]]) 读到.
  //
  // 生命周期 = 主进程打开期间. 刷页面 / 关浏览器清空, 跟本地 fetch 路径 useChatAI useRef 等价.
  const ctx: AgenticToolCtx = {
    char,
    userProfile,
    realtimeConfig,
    xhsCaches: pushXhsCaches,
    lastXhsNotesRef: pushLastXhsNotesRef,
    onProgress: (_channel, text) => {
      console.log('[instant-tool-runner:progress]', text);
      emitToolStatus(item.charId, 'running', `${text}，请先停留在此页。`, item.sessionId);
    },
  };

  // 透视窗凭据按需解析：本批含 perspective 工具调用时才读令牌，其余工具路径不增加等待。
  if (item.toolCalls.some((call) => call.function.name === PERSPECTIVE_QUERY_FIRE_TOOL || call.function.name === PERSPECTIVE_SUMMARY_FIRE_TOOL)) {
    const perspCfg = await resolvePerspectiveToolConfig(char, realtimeConfig);
    if (perspCfg) ctx.perspective = perspCfg;
  }

  // 1. 跑所有 tool, 串行 — agenticTools 内部多步 (XHS retry / DIARY fallback) 不能并发.
  const toolResults: Array<{ tool_call_id: string; role: 'tool'; content: string }> = [];
  for (const call of item.toolCalls) {
    let result: unknown;
    try {
      const args = JSON.parse(call.function.arguments || '{}');
      result = await dispatchAgenticTool(call.function.name, args, ctx);
    } catch (e) {
      console.error('[instant-tool-runner] tool failed', call.function.name, e);
      result = { ok: false, reason: 'tool_threw', message: (e as Error)?.message ?? String(e) };
    }
    toolResults.push({
      tool_call_id: call.id,
      role: 'tool',
      // OpenAI 兼容端点要求 tool result content 是字符串; agenticTools 返结构化 result, JSON 化.
      content: JSON.stringify(result),
    });
  }

  // 把这一轮 XHS 工具抓到的笔记 + xsecToken 落库 (按 sessionId). round 2 worker 发回
  // [[XHS_SHARE: 序号]] / 评论 / 点赞 时, applyAssistantPostProcessing 要靠这份笔记取卡片;
  // 内存单例 pushLastXhsNotesRef 跨 SW 唤醒 / 页面回收会清空, 不持久化就会静默掉卡片.
  if (pushLastXhsNotesRef.current.length > 0) {
    try {
      await ActiveMsgStore.saveXhsSessionNotes(item.sessionId, {
        notes: pushLastXhsNotesRef.current,
        xsecTokens: Array.from(pushXhsCaches.xsecTokenCache.entries()),
      });
    } catch (e) {
      console.warn('[instant-tool-runner] persist xhs notes failed', item.sessionId, e);
    }
  }

  // 2. 拼下一轮 LLM 看到的 messages: outbound history + assistant tool_call message + tool results.
  //    这是 OpenAI tool-call 协议的标准形状; worker 拿到后会直接转发给 LLM.
  const assistantMsg = {
    role: 'assistant' as const,
    content: item.llmOutputText || '',
    tool_calls: item.toolCalls,
  };
  const nextMessages = [...session.messages, assistantMsg, ...toolResults];

  // 3. 找到 push subscription + worker 凭据.
  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    console.warn('[instant-tool-runner] instant config not ready, cannot continue');
    emitToolStatus(item.charId, 'failed', `${toolLabel}完成了，但 Instant Push 配置不可用，没法继续回复。`, item.sessionId);
    return false;
  }
  const { sub } = await getOrCreateInstantSubscription();
  if (!sub) {
    console.warn('[instant-tool-runner] no push subscription, cannot continue');
    emitToolStatus(item.charId, 'failed', `${toolLabel}完成了，但推送订阅不可用，没法继续回复。`, item.sessionId);
    return false;
  }

  // 4. POST /continue. payload 形状 = /instant + sessionId + iteration. apiCredentials 从
  //    outbound_session 取 (sendInstantPush 时记下的, 跨 round 用同一组).
  const apiConfig = loadApiConfigFromLocalStorage();

  // iteration: SW 在 savePendingToolCall 时持久化了上一轮 worker hook 看到的 iteration
  // (从 push.metadata.iteration 透传). /continue 必须严格递增, worker 端 fail-fast 400 守.
  const nextIteration = (item.iteration ?? 0) + 1;

  // amsg-instant 0.6.0+ 强校验 avatarUrl: 仅接受 http(s), data: URI 直接 INVALID_PAYLOAD_FORMAT.
  // SullyOS 角色头像基本是 base64 存的, 直传会被包侧拒. 没有公网 URL 就干脆不传 — 通知端
  // 用 worker 自己的默认图标. 同 useChatAI.ts:693 的处理.
  const safeAvatarUrl = /^https?:\/\//i.test(char.avatar || '') ? char.avatar : undefined;

  const continuePayload = {
    sessionId: item.sessionId,
    iteration: nextIteration,
    messages: nextMessages,
    pushSubscription: sub,
    apiUrl: session.apiCredentials.baseUrl || apiConfig.baseUrl,
    apiKey: session.apiCredentials.apiKey || apiConfig.apiKey,
    primaryModel: session.apiCredentials.model || apiConfig.model,
    contactName: char.name,
    avatarUrl: safeAvatarUrl,
    charId: item.charId,
    metadata: { charId: item.charId, charName: char.name },
    temperature: 0.8,
    oversizeTransport: getInstantOversizeTransport(cfg),
  };

  // 双通道终态判定 (docs/instant-push-dual-channel.md): 唯一可信的送达信号是 SW
  // 广播的 active-msg-received, 不是 SSE 流的 resolve / reject. 这里照抄
  // sendInstantPushAndAwaitReply 的 deliver({ delivery: { mode: 'observed', observed } })
  // 口径, 只是 endpointPath 换成 '/continue'. SSE 中断只 absorb 记 trace, 不判死;
  // 最终结论只看 deliver() 的 observed 结论, 后续补收 / 点名兜底.
  let sseDeliveryFailed = false;
  let sseBusinessError: string | undefined;
  let observedHandler: ((e: Event) => void) | null = null;
  const observed = new Promise<{ sessionId: string; channel: string }>((resolve) => {
    observedHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // sessionId 严格匹配: 杜绝同 char 多轮并发 / 上一轮延迟到达的旧 push 误判.
      if (detail?.sessionId && detail.sessionId === item.sessionId) {
        if (observedHandler) {
          try { window.removeEventListener('active-msg-received', observedHandler); } catch { /* ignore */ }
          observedHandler = null;
        }
        resolve({ sessionId: item.sessionId, channel: 'sw' });
      }
    };
    window.addEventListener('active-msg-received', observedHandler);
  });

  const abortController = new AbortController();
  let abortedByCaller = false;
  const abortOnPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    abortedByCaller = true;
    abortController.abort();
  };

  try {
    emitToolStatus(item.charId, 'continuing', `${toolLabel}完成了，正在让角色继续回复。`, item.sessionId);
    const reiClient = new ReiClient({
      baseUrl: cfg.workerUrl,
      instantEncryption: false,
      instantClientToken: cfg.clientToken || '',
    });
    window.addEventListener('pagehide', abortOnPageHide, { once: true });

    try {
      const result = await reiClient.deliver(continuePayload, {
        delivery: { mode: 'observed', observed },
        // 与 instantPushClient.DEFAULT_INSTANT_TIMEOUT_MS (300s) 同档: transport + grace 总预算.
        timeoutMs: 300_000,
        // transport 落定后最多再等 8s 观察通道 (双通道文档口径).
        postTransportGraceMs: 8_000,
        signal: abortController.signal,
        endpointPath: '/continue',
        onChunk: async (p: any) => {
          const ack = await postSsePayloadToServiceWorker(p, item.sessionId);
          if (!ack.ok) sseDeliveryFailed = true;
          if (ack.businessError) sseBusinessError = ack.businessError;
        },
        compressRequest: true,
      });

      if (result.outcome === 'delivered') {
        emitToolStatus(item.charId, 'done', `${toolLabel}完成了，角色回复已送达。`, item.sessionId);
        return true;
      }
      // 主动 abort (pagehide) 触发的 cancelled 不算 SSE 错, 不置 failed; 终态留给补收 / 点名.
      if (result.outcome === 'cancelled' || abortController.signal.aborted) {
        console.warn('[instant-tool-runner] /continue cancelled, leaving verdict to catch-up/polling', item.sessionId);
        return false;
      }
      // timeout / send-failed / completed-unconfirmed (observed 下理论不可达, 防御性同 failed 处理):
      // deliver() 已把 SSE reject 吸收集并等过 grace, 这里的 failed 是终态结论, 不是 SSE 直判.
      // SW 自报错只穿插进文案给排查线索, 不覆盖 outcome.
      const detail = (result.detail ?? {}) as { transportError?: any; waitedMs?: number };
      const transportError = detail.transportError as any;
      const sseMsg = transportError?.message || String(transportError ?? result.outcome);
      const swHint = sseBusinessError
        ? ` (SW 自报落库错: ${sseBusinessError})`
        : sseDeliveryFailed
          ? ' (SW 未确认收下任何 chunk)'
          : '';
      console.warn('[instant-tool-runner] /continue not delivered:', result.outcome, sseMsg, swHint, item.sessionId);
      const failText = result.outcome === 'timeout'
        ? `${toolLabel}完成了，但角色回复超时未确认送达。${swHint}`
        : `${toolLabel}完成了，但续写传输中断。${swHint}`;
      emitToolStatus(item.charId, 'failed', failText, item.sessionId);
      return false;
    } finally {
      try { window.removeEventListener('pagehide', abortOnPageHide); } catch { /* ignore */ }
      if (observedHandler) {
        try { window.removeEventListener('active-msg-received', observedHandler); } catch { /* ignore */ }
        observedHandler = null;
      }
    }
  } catch (e) {
    // deliver() 内部已把 SSE 网络 reject 收编, 不会进这里; 能进这里的是入参校验 /
    // 构造等编程错误. 主动 abort 触发的不算 SSE 错, 不置 failed, 终态留给补收 / 点名.
    if (abortedByCaller || abortController.signal.aborted) {
      console.warn('[instant-tool-runner] /continue aborted, leaving verdict to catch-up/polling', item.sessionId);
      return false;
    }
    console.error('[instant-tool-runner] /continue deliver threw', e);
    emitToolStatus(item.charId, 'failed', `${toolLabel}完成了，但续写请求没有发出去。`, item.sessionId);
    return false;
  }
}

/** 排空 pending_tool_calls store; 调用前后都是原子, 失败的不重投 (见 module 顶 doc). */
export async function runPendingToolCalls(): Promise<{ processed: number; ok: number }> {
  const pending = await ActiveMsgStore.consumePendingToolCalls();
  let ok = 0;
  for (const item of pending) {
    const success = await runOnePendingToolCall(item);
    if (success) ok += 1;
  }
  if (pending.length > 0) {
    console.log(`[instant-tool-runner] processed ${pending.length} pending tool call(s), ${ok} ok`);
  }
  return { processed: pending.length, ok };
}

// ── private helpers ─────────────────────────────────────────────────────────

function loadApiConfigFromLocalStorage(): APIConfig {
  const fallback: APIConfig = { baseUrl: '', apiKey: '', model: '' };
  try {
    const raw = localStorage.getItem('os_api_config');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || '',
      apiKey: parsed.apiKey || '',
      model: parsed.model || '',
      ...parsed,
    };
  } catch {
    return fallback;
  }
}

function loadRealtimeConfigFromLocalStorage(): RealtimeConfig | undefined {
  try {
    const raw = localStorage.getItem('os_realtime_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as RealtimeConfig;
  } catch {
    return undefined;
  }
}
