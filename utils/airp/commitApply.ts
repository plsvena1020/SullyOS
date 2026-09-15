import { DB } from '../db';
import type { AirpDirectorOutput } from './types';
import { extractCommittedEvents, type AirpCommittedEvent } from './commit';
import { saveAirpEvents } from './eventStore';
import { materializeCommittedEvents } from './worldStore';

/**
 * 一轮聊天的 AIRP 世界提交编排（阶段二）：导演产出 → 已叙述事件 → 落事件流 + 物化世界 +
 * 锚点气泡记账。挂在 applyAssistantPostProcessing 的 Step 7。
 *
 * 错误契约（锁定）：本函数**绝不为**流水线/存储失败抛异常——整段包在 try/catch 里，
 * 失败只 console.warn 并返回「已保存到哪算哪」的部分结果。这样后处理管线永远不会因为
 * AIRP 存储问题挡住本轮聊天。调用点还额外包了一层（双重保险）。
 *
 * 幂等：锚点可见窗口内所有 assistant 气泡的 metadata.airpCommittedIds 是记账面；
 * 已记账的事件 id 会被跳过（skippedIds），因此重跑同一轮不会重复落库。
 */
export interface CommitAirpRoundInput {
  charId: string;
  output: AirpDirectorOutput;
  replyText: string;
  atMs: number;
  postStartMs: number;
}

export interface CommitAirpRoundResult {
  committed: AirpCommittedEvent[];
  skippedIds: string[];
  anchorMessageId?: number;
}

const RECENT_WINDOW = 5;

export async function commitAirpRound(
  input: CommitAirpRoundInput,
): Promise<CommitAirpRoundResult> {
  const { charId, output, replyText, atMs, postStartMs } = input;
  const skippedIds: string[] = [];
  let committed: AirpCommittedEvent[] = [];
  let anchorMessageId: number | undefined;

  try {
    const extracted = extractCommittedEvents(output, replyText, { charId, atMs });
    if (extracted.length === 0) return { committed: [], skippedIds: [] };

    // 锚点：可见窗口内最新的、时间戳不早于本轮开始的那个 assistant 气泡。
    // getRecentMessagesByCharId 返回按 id 升序的最近 N 条（见 db.ts），故这里按 id 取最大，
    // 不依赖数组顺序。
    const recent = await DB.getRecentMessagesByCharId(charId, RECENT_WINDOW);
    for (const message of recent) {
      if (message.role !== 'assistant') continue;
      if (typeof message.timestamp !== 'number' || message.timestamp < postStartMs) continue;
      if (anchorMessageId === undefined || message.id > anchorMessageId) {
        anchorMessageId = message.id;
      }
    }

    // 已记账 id：窗口内 assistant 气泡的 metadata.airpCommittedIds（只认数组）。
    const recorded = new Set<string>();
    for (const message of recent) {
      const ids = (message as any)?.metadata?.airpCommittedIds;
      if (!Array.isArray(ids)) continue;
      for (const id of ids) if (typeof id === 'string') recorded.add(id);
    }

    const toSave = extracted.filter((event) => !recorded.has(event.id));
    for (const event of extracted) if (recorded.has(event.id)) skippedIds.push(event.id);

    if (toSave.length > 0) {
      await saveAirpEvents(toSave);
      committed = toSave;
      await materializeCommittedEvents(charId, toSave, atMs);
    }

    if (anchorMessageId !== undefined) {
      const savedIds = toSave.map((event) => event.id);
      await DB.updateMessageMetadata(anchorMessageId, (prev: any) => ({
        ...(prev ?? {}),
        airpCommittedIds: [
          ...(Array.isArray(prev?.airpCommittedIds) ? prev.airpCommittedIds : []),
          ...savedIds,
        ],
      }));
    }

    return { committed, skippedIds, anchorMessageId };
  } catch (error) {
    console.warn('[airp] commitAirpRound degraded', error);
    return { committed, skippedIds, anchorMessageId };
  }
}
