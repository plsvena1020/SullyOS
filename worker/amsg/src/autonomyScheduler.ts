/**
 * 自主背景生活（autonomy）的到点调度器 —— wrapper 层，cron 每分钟调一次。
 *
 * 这条路解决的是「页面关着的时候角色也该过日子」：cron 扫一遍各角色的 fire_pack，
 * 按角色自己的 cadence / 静默段 / 当日配额 / 熔断逐道闸判定，通过了就**自转发**一条
 * `autonomous_round` 任务给上游（`POST /schedule-message`，见 task-17 brief 的
 * 「Locked enqueue mechanism」）。
 *
 * 三个不显然的设计点：
 *
 * 1. **claim-first**：先写 autonomy_state（last_round_at / rounds_today）再建任务，而且
 *    失败不回滚。CF Cron 与 VPS 的 node-cron 可能同时喂这一跳，扣账在前能把重复触发的
 *    代价压到「多花一次窗口」这一侧，另一个方向（先建任务、写账失败）会变成无限重排。
 *
 * 2. **加密镜像**：上游没有导出 `encryptPayload`（cloudflare.d.ts:10 只有
 *    deriveUserEncryptionKey / decryptPayload / encryptForStorage / decryptFromStorage），
 *    而 `/schedule-message` 强制加密（ENCRYPTION_REQUIRED）。所以这里内联一份 12 行的
 *    AES-256-GCM 镜像——格式与客户端 `encryptPayload` 逐字节相同：iv12 + tag16，
 *    信封 { iv, authTag, encryptedData } 全 base64，明文是 JSON 的 UTF-8 字节。
 *    同一格式在 worker/amsg/src/pushFanout.test.ts:36-56 有先例；
 *    另有 round-trip 测试拿上游导出的 decryptPayload 反过来钉住它。
 *
 * 3. **判定全注入**：nowMs / rand01 / postTask / packs 都是入参，决策层零 Date.now /
 *    Math.random / fetch——所以这一整套能在 vitest 里确定性地钉住。
 */

import { decryptFromStorage, deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';
import { AUTONOMOUS_ROUND_KIND } from '../../../utils/airp/autonomySettings';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_STATE_NAMESPACE_PREFIX,
  parseFirePack,
  unpackStateValue,
  wallClockPartsInZone,
  type AmsgFirePack,
} from '../../../utils/amsgFirePack';
import { AMSG_TOOL_PACK_KEY, parseToolPack } from '../../../utils/amsgToolPack';
import {
  AMSG_BACKGROUND_JOB_SUBTYPE,
  AMSG_JOB_ID_KEY,
  AMSG_TASK_KIND_KEY,
} from '../../../utils/amsgTaskKinds';
import {
  AUTONOMY_EXPERIENCE_TTL_MS,
  cleanupAutonomyExperiences,
  ensureAutonomySchema,
  getAutonomyState,
  setAutonomyState,
  type AutonomyDb,
} from './autonomyStore';

/** 连续失败到几次就熔断（不再排新的一轮，等用户动设置或下一轮成功清账）。 */
export const AUTONOMY_FAIL_LIMIT = 3;

/** 跳过原因只用这一组字面量：日志、测试和（之后的）面板都按它对齐。 */
export const AUTONOMY_SKIP_REASONS = {
  disabled: 'autonomy-disabled',
  cadenceInvalid: 'cadence-invalid',
  tzInvalid: 'tz-invalid',
  spacingWindow: 'spacing-window',
  dailyLimit: 'daily-limit',
  quietHours: 'quiet-hours',
  pushCooldown: 'push-cooldown',
  tokenBudget: 'token-budget',
  failMuted: 'fail-muted',
  postFailed: 'post-failed',
} as const;

export type AutonomySkipReason = (typeof AUTONOMY_SKIP_REASONS)[keyof typeof AUTONOMY_SKIP_REASONS];

// ─── 扫描：上游 client_state 里的 fire_pack ──────────────────────────────

export interface AutonomyTickPack {
  userId: string;
  charId: string;
  /** 角色名（取自同命名空间的 tool_pack；缺了就是空串，转发时回落到 charId）。 */
  charName: string;
  pack: AmsgFirePack;
}

export interface AutonomyScanSkipped {
  charId: string;
  reason: string;
}

export interface AutonomyScanResult {
  packs: AutonomyTickPack[];
  skipped: AutonomyScanSkipped[];
}

const SCAN_UNREADABLE = 'pack-unreadable';

/** `client_state.namespace` → charId；不是角色命名空间就回 null。 */
const charIdFromNamespace = (namespace: unknown): string | null => {
  if (typeof namespace !== 'string') return null;
  if (!namespace.startsWith(AMSG_STATE_NAMESPACE_PREFIX)) return null;
  const charId = namespace.slice(AMSG_STATE_NAMESPACE_PREFIX.length);
  return charId || null;
};

/**
 * 扫出所有带 fire_pack 的角色（cron 侧唯一的「有哪些角色在过自主生活」来源）。
 *
 * 一次查询把 fire_pack 与 tool_pack 两行都捞回来（同一命名空间、同一次解密口径）：
 * tool_pack 只为了拿 charName——fire_pack 里没有角色名字段，而转发的任务载荷需要它。
 *
 * 解不出来 / 版本不认识的角色记一条 skipped 就跳过（**不抛**）：一个角色的坏数据不能
 * 让整轮调度停摆。分块存储（value 是上游的 chunked root marker）落在这一类里——那需要
 * 复刻上游 chunk 行的命名空间与拼接规则，本任务不做，留到有需要时再说。
 */
export async function scanAutonomyPacks(args: {
  db: AutonomyDb;
  masterKey: string;
}): Promise<AutonomyScanResult> {
  const rows = await args.db
    .prepare('SELECT user_id, namespace, key, value FROM client_state WHERE key = ? OR key = ?')
    .bind(AMSG_FIRE_PACK_KEY, AMSG_TOOL_PACK_KEY)
    .all();

  const byNamespace = new Map<string, { userId: string; rows: Array<Record<string, unknown>> }>();
  for (const row of rows.results ?? []) {
    const charId = charIdFromNamespace(row.namespace);
    const userId = row.user_id;
    if (!charId || typeof userId !== 'string' || !userId) continue;
    const bucket = byNamespace.get(charId) ?? { userId, rows: [] };
    bucket.rows.push(row);
    byNamespace.set(charId, bucket);
  }

  const packs: AutonomyTickPack[] = [];
  const skipped: AutonomyScanSkipped[] = [];

  const decrypt = async (userId: string, value: unknown): Promise<string> => {
    if (typeof value !== 'string' || !value) throw new Error('值不是字符串');
    const userKey = await deriveUserEncryptionKey(userId, args.masterKey);
    return unpackStateValue(await decryptFromStorage(value, userKey));
  };

  for (const charId of [...byNamespace.keys()].sort()) {
    const bucket = byNamespace.get(charId)!;
    const packRow = bucket.rows.find((row) => row.key === AMSG_FIRE_PACK_KEY);
    if (!packRow) continue;

    let pack: AmsgFirePack | null = null;
    try {
      pack = parseFirePack(await decrypt(bucket.userId, packRow.value));
    } catch {
      pack = null;
    }
    if (!pack) {
      skipped.push({ charId, reason: SCAN_UNREADABLE });
      continue;
    }

    let charName = '';
    const toolRow = bucket.rows.find((row) => row.key === AMSG_TOOL_PACK_KEY);
    if (toolRow) {
      try {
        charName = parseToolPack(await decrypt(bucket.userId, toolRow.value))?.charName ?? '';
      } catch {
        charName = '';
      }
    }

    packs.push({ userId: bucket.userId, charId, charName, pack });
  }

  return { packs, skipped };
}

// ─── 决策层 ────────────────────────────────────────────────────────────

export interface AutonomyPostTaskArgs {
  userId: string;
  charId: string;
  charName: string;
  pack: AmsgFirePack;
}

export interface AutonomyTickInput {
  nowMs: number;
  /** 采样源；不传用 Math.random。每个角色最多消费一次。 */
  rand01?: () => number;
  db: AutonomyDb;
  packs: AutonomyTickPack[];
  postTask: (args: AutonomyPostTaskArgs) => Promise<unknown>;
}

export interface AutonomyTickResult {
  /** 这一跳真的建出任务的角色。 */
  built: string[];
  skipped: Array<{ charId: string; reason: string }>;
}

/** 角色时区下的日期 key（`YYYY-MM-DD`）。非法 tzId 抛错，调用方按跳过处理。 */
export function autonomyDateKey(nowMs: number, tzId: string): string {
  const p = wallClockPartsInZone(nowMs, { tzId });
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 'HH:MM' → 当日起始的分钟数；形状不对回 null。 */
const parseHHMM = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** 含跨夜区间（start > end 时是「当天 start 到次日 end」）。start === end 视为没有静默段。 */
const inQuietHours = (quiet: { start: string; end: string }, minutes: number): boolean => {
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === null || end === null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
};

/** 稳定的 JSON 串（键排序、递归）：configHash 只跟自己比，只要确定性就够。 */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
};

/**
 * 自主设置的指纹（写进 `autonomy_state.config_hash`）。用户改设置 → 哈希变 → 清熔断，
 * 这就是「重新开始」的全部机制。导出是为了让 Task 18/19 与测试用同一份口径。
 */
export const autonomyConfigHash = (autonomy: unknown): string => stableStringify(autonomy);

/** 每小时毫秒数。 */
const HOUR_MS = 60 * 60 * 1000;

/**
 * 跑一跳。返回这一跳建了哪些角色、各自因为什么被跳过。
 *
 * 闸的顺序见 brief：开关 → configHash → cadence/间隔 → 当日轮数 → 静默段 → 推送冷却
 * → token 预算 → 熔断 → claim-first 建任务。
 */
export async function runAutonomyTick(input: AutonomyTickInput): Promise<AutonomyTickResult> {
  const { db, packs, postTask } = input;
  const rand = input.rand01 ?? Math.random;
  const built: string[] = [];
  const skipped: Array<{ charId: string; reason: string }> = [];

  await ensureAutonomySchema(db);
  // 每跳顺手清一次过期经历（7 天）。清不掉只记日志：它是收尾活儿，不该拖垮这一跳。
  try {
    await cleanupAutonomyExperiences(db, input.nowMs - AUTONOMY_EXPERIENCE_TTL_MS);
  } catch (error) {
    console.warn('[amsg:autonomy] 过期经历没清掉（下一跳再试）', error);
  }

  for (const entry of packs) {
    const { charId, userId, charName, pack } = entry;
    const skip = (reason: string) => { skipped.push({ charId, reason }); };

    const autonomy = pack.autonomy;
    // 闸 1：开关与档位（L0 静默）。老 pack 没有 autonomy 段 = 自主功能没开过。
    if (!autonomy || autonomy.enabled !== true || autonomy.autonomyLevel < 1) {
      skip(AUTONOMY_SKIP_REASONS.disabled);
      continue;
    }

    const state = await getAutonomyState(db, charId);
    const configHash = autonomyConfigHash(autonomy);

    // 闸 2：configHash。用户动了设置 = 重新开始：清熔断并把新口径记下来。
    // 间隔、当日轮数、token 都不动——用户改的是 cadence/静默段，不是「今天还没跑过」。
    if (state.configHash !== configHash) {
      state.failStreak = 0;
      state.configHash = configHash;
      await setAutonomyState(db, state);
    }

    // 闸 3：cadence 先自查（minHours>0 且 min<=max），坏了就没有合法的「窗口」可言。
    const cadence = autonomy.cadence;
    if (!cadence || !(cadence.minHours > 0) || !(cadence.maxHours >= cadence.minHours)) {
      skip(AUTONOMY_SKIP_REASONS.cadenceInvalid);
      continue;
    }
    // 每个角色只消费一次随机数：窗口落在 [min, max] 小时之间。
    const windowMs = (cadence.minHours + rand() * (cadence.maxHours - cadence.minHours)) * HOUR_MS;
    const lastUserMessageAt = pack.lastUserMessageAt;
    const userJustSpoke = typeof lastUserMessageAt === 'number'
      && input.nowMs - lastUserMessageAt <= windowMs;
    const roundDue = state.lastRoundAt === 0 || input.nowMs - state.lastRoundAt > windowMs;
    if (userJustSpoke || !roundDue) {
      skip(AUTONOMY_SKIP_REASONS.spacingWindow);
      continue;
    }

    // 时区读数（日期 key 与静默段都要）。非法 tzId = 数据坏了：跳过并留痕，不猜一个钟。
    let dateKey: string;
    let minutes: number;
    try {
      const parts = wallClockPartsInZone(input.nowMs, { tzId: pack.tzId });
      dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      minutes = parts.hour * 60 + parts.minute;
    } catch {
      skip(AUTONOMY_SKIP_REASONS.tzInvalid);
      continue;
    }

    // 闸 4：当日轮数（按角色时区翻日）。
    if (state.roundsDate !== dateKey) {
      state.roundsDate = dateKey;
      state.roundsToday = 0;
    }
    if (state.roundsToday >= autonomy.maxRoundsPerDay) {
      skip(AUTONOMY_SKIP_REASONS.dailyLimit);
      continue;
    }

    // 闸 5：静默段（含跨夜）。
    if (autonomy.quietHours && inQuietHours(autonomy.quietHours, minutes)) {
      skip(AUTONOMY_SKIP_REASONS.quietHours);
      continue;
    }

    // 闸 6：推送冷却。没推过（0）或冷却为 0 都放行。
    const cooldownMinutes = autonomy.push?.cooldownMinutes ?? 0;
    if (state.lastPushAt > 0 && cooldownMinutes > 0 && input.nowMs - state.lastPushAt <= cooldownMinutes * 60_000) {
      skip(AUTONOMY_SKIP_REASONS.pushCooldown);
      continue;
    }

    // 闸 7：当日 token 预算（与当日轮数同一套翻日）。
    if (state.tokensDate !== dateKey) {
      state.tokensDate = dateKey;
      state.tokensToday = 0;
    }
    const budget = autonomy.dailyTokenBudget;
    if (typeof budget === 'number' && budget > 0 && state.tokensToday >= budget) {
      skip(AUTONOMY_SKIP_REASONS.tokenBudget);
      continue;
    }

    // 闸 8：熔断。
    if (state.failStreak >= AUTONOMY_FAIL_LIMIT) {
      skip(AUTONOMY_SKIP_REASONS.failMuted);
      continue;
    }

    // 闸 9：claim-first。扣账先落地，再建任务；建失败不回滚（见文件头）。
    state.lastRoundAt = input.nowMs;
    state.roundsToday += 1;
    state.roundsDate = dateKey;
    await setAutonomyState(db, state);
    try {
      await postTask({ userId, charId, charName, pack });
      built.push(charId);
    } catch (error) {
      console.warn('[amsg:autonomy] 建任务失败（不回滚，下一次到窗再试）', charId, error);
      skip(AUTONOMY_SKIP_REASONS.postFailed);
    }
  }

  return { built, skipped };
}

// ─── 结果回账（Task 18 的 handler 调） ────────────────────────────────────

export interface AutonomyOutcome {
  ok: boolean;
  /** true = 这一轮其实什么都没做（上游把任务 skip 掉了）：`'skipped'` 不动账。 */
  skipped?: boolean;
  /** 这一轮烧掉的 token（成功才该传）。 */
  tokens?: number;
  /** 这一轮真的推出去了（记推送时间用）。 */
  pushed?: boolean;
}

/**
 * 一轮自主生活的结局回账（语义照 utils/vrWorld/scheduler.ts:215-227 的 VRScheduler）：
 * ok 清熔断、fail 累加（到 AUTONOMY_FAIL_LIMIT 就静默）、skipped 什么都不动。
 *
 * dateKey 必传：token 是「当日」口径，没有角色时区就没法翻日。调用方用
 * autonomyDateKey(nowMs, pack.tzId) 算好传进来。
 */
export async function reportAutonomyOutcome(
  charId: string,
  outcome: AutonomyOutcome,
  args: { db: AutonomyDb; dateKey: string; nowMs?: number },
): Promise<void> {
  if (outcome.skipped) return;
  await ensureAutonomySchema(args.db);

  const state = await getAutonomyState(args.db, charId);
  if (outcome.ok) state.failStreak = 0;
  else state.failStreak += 1;

  if (state.tokensDate !== args.dateKey) {
    state.tokensDate = args.dateKey;
    state.tokensToday = 0;
  }
  if (typeof outcome.tokens === 'number' && outcome.tokens > 0) {
    state.tokensToday += outcome.tokens;
  }
  if (outcome.pushed) state.lastPushAt = args.nowMs ?? Date.now();

  await setAutonomyState(args.db, state);
}

// ─── 自转发：组任务载荷 → 加密 → POST /schedule-message ───────────────────

/**
 * 转发的占位正文。上游要求 `messageType:'auto'` 必须带 completePrompt 或 messages 二选一，
 * 而真正发给 LLM 的 messages 由 kind handler 的返回值覆盖（upstream schedule-message
 * 校验只要求它形状合法）——所以这条内容永远不参与生成，跟客户端
 * activeMsgClient.ts:871 那个占位是同一个用途。
 */
export const AUTONOMY_PLACEHOLDER_PROMPT =
  'AMSG2_PLACEHOLDER_PROMPT（自主生活这一轮的提示词到点由 worker 的 autonomous_round handler 下发；看到这条说明 handler 没接上）';

/** 与 pushFanout.test.ts:29 同款：显式 ArrayBuffer 兜住 lib.dom 里 BufferSource 的窄化。 */
const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * 与库内 encryptPayload 逐字节相同的传输信封（AES-256-GCM、iv12 + tag16、base64）。
 * 包没有导出 encryptPayload（见文件头第 2 点），所以这里内联；格式与客户端一致。
 */
export const encryptPayloadMirror = async (
  payload: unknown,
  hexKey: string,
): Promise<{ iv: string; authTag: string; encryptedData: string }> => {
  const key = await crypto.subtle.importKey('raw', hexToBytes(hexKey), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    new TextEncoder().encode(plaintext),
  ));
  return {
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(sealed.slice(sealed.length - 16)),
    encryptedData: bytesToBase64(sealed.slice(0, sealed.length - 16)),
  };
};

/**
 * 照客户端 scheduleBackgroundJob（utils/activeMsgClient.ts:2463-2487）那份载荷口径组一条
 * `/schedule-message` 请求。上游按 `pathname.endsWith('/schedule-message')` 匹配路由，
 * 所以 cron 里没有挂载路径也能用（内部 URL 随便给一个 host）。
 */
export async function buildAutonomyScheduleRequest(args: {
  userId: string;
  charId: string;
  charName: string;
  masterKey: string;
  clientToken?: string;
}): Promise<Request> {
  const charName = args.charName || args.charId;
  const payload = {
    contactName: charName,
    messageType: 'auto',
    messageSubtype: AMSG_BACKGROUND_JOB_SUBTYPE,
    // 立刻可跑：到期时间由服务端自己盖（跟客户端那条路同一个理由——客户端算出来的
    // 时刻在路上就过去了，服务端一律打回「时间必须在未来」）。
    immediate: true,
    recurrenceType: 'none',
    // 自主经历这一轮的采样：显式 0.4 只动 temperature，top_p 全篇不出现（不动共享采样
    // 体系）。maxTokens = 理想长度 800 字 ×2（B2 的口径），留给 JSON 信封与收笔的余量。
    // 上游请求体的采样参数来自任务 payload（amsg-shared 的 buildLlmRequestBody）。
    temperature: 0.4,
    maxTokens: 1600,
    metadata: {
      charId: args.charId,
      charName,
      source: 'active_msg_2',
      [AMSG_TASK_KIND_KEY]: AUTONOMOUS_ROUND_KIND,
      // Task 18 不需要 amsg:job 的一次性输入（只读 fire_pack + autonomy 表），
      // 这个键照客户端口径带上，handler 不读它。
      [AMSG_JOB_ID_KEY]: crypto.randomUUID(),
    },
    credRefs: { chat: `char:${args.charId}/chat` },
    messages: [{ role: 'user', content: AUTONOMY_PLACEHOLDER_PROMPT }],
  };
  const envelope = await encryptPayloadMirror(
    payload,
    await deriveUserEncryptionKey(args.userId, args.masterKey),
  );
  const token = args.clientToken?.trim();
  return new Request('https://internal/schedule-message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': args.userId,
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      ...(token ? { 'X-Client-Token': token } : {}),
    },
    body: JSON.stringify(envelope),
  });
}

/**
 * 生产用的 postTask：把请求交给上游 worker（index.ts 传 `upstream.fetch` 进来，测试吐 stub）。
 * 非 2xx 直接抛——调度器会把它记成 post-failed，账已经扣掉，下一次到窗再试。
 */
export const createAutonomyPostTask = (deps: {
  forward: (request: Request) => Promise<Response>;
  masterKey: string;
  clientToken?: string;
}): ((args: AutonomyPostTaskArgs) => Promise<{ status: number }>) =>
  async ({ userId, charId, charName }) => {
    const request = await buildAutonomyScheduleRequest({
      userId,
      charId,
      charName,
      masterKey: deps.masterKey,
      clientToken: deps.clientToken,
    });
    const response = await deps.forward(request);
    if (!response.ok) throw new Error(`schedule-message 拒绝（HTTP ${response.status}）`);
    return { status: response.status };
  };
