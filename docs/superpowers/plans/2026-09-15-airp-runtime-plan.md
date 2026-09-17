# SullyOS 混合式 AIRP Runtime 实施计划

> 状态：v1.9 阶段五执行完毕（2026-09-17；Tasks 24-30 全绿 + 集成终审关闭；浏览器手验待用户验收）。
> v1.6 修正（阶段二落定）：DB v75（airp_events）+ v76（airp_world）；同批同类事件用 `atMs+index` 单调戳收敛；keep 输家不落盘；事件 source 回填锚点 id；再生语义=新事实按 Task-2 规则自然 supersede，无特殊逻辑；本地无稳定时间戳的重跑去重为已知局限（amsg 路径有 messageTimestamp 则完备）。
> v1.7 修正（阶段三落定）：离线自主生活（调度器自转发任务 + 无工具反刍回合 + 转述闭环）；调度器 claim-first + tick-claim 防双发；推送/凭据 409 前置检查（缺了不扣账）+ 客户端自动补凭据行；自主事件以 runtime_state 物化、重大改道 outbox 待定；云端转述块延期（缺 told 追踪）；kind 路径无工具循环（工具接线留待有 live-fire 验证的阶段）。
> v1.1 修正：基础记忆召回改为**每轮确定性预取**，不进入导演工具面（理由见「设计决策 D1」）。
> v1.2 修正：确定性注入面扩展（记忆/天气/新闻/日程固定注入；仅第三地天气与地图/web_search 工具化）。
> v1.3 修正：Task 2 行为 3 两句写反，已纠正为高权威 incoming 胜（见 D2）。
> v1.4 修正（Task 7 Step-0 发现）：基线3改浅拷贝调用 `injectMemoryPalace`（关 mutation）；基线5改 `realtimeContext.ts` 新增只读 peek + `checkSpecialDates` 纯函数（该文件本无 cache-only 读口）；事件摘要阶段一生产默认空（`world_episodes` 无角色链接）；取消 `factsPartial`（类型冻结）。
> v1.5 修正（终审修复波）：场景时钟改角色本地 wall-clock（Intl）；能力渲染带工具名与参数 schema；空知识边界整节省略；快照按白名单/writable 过滤能力；导演 apiKey 加 `sk-none` 回退。
> 目标读者：弱执行模型。每个 Task 自带文件路径、代码形状、验收命令，按序执行，不需要回看对话历史。

---

## Goal

在 SullyOS 中建立混合式 AIRP Runtime：确定性代码维护事实、时间、知识边界与权限；幕后导演 Agent 每轮规划演出；现有角色模型只负责表演；回复后校验并提交世界事件；角色离线时按事件驱动自主生活；聊天、主动消息、朋友圈、日记、见面、通话、查手机最终共享同一事实来源。

## Architecture

```text
确定性状态系统（事实/时间/权限/知识边界，含每轮确定性记忆预取）
→ AIRP 幕后导演 Agent（检索补充信息、按需调工具、输出结构化演出指令）
→ 角色表演模型（现有链路，只负责表演）
→ 回复事实校验（确定性代码为主）
→ 世界事件提交（统一事件流）
→ 跨 App 投影（分阶段接入）
```

**Tech Stack:** React / TypeScript / Vite / IndexedDB / Cloudflare Workers / D1 / 主动消息 2.0 / MCP / OpenAI-compatible Chat Completions。

**Related Spec:** `plans/autonomy-round.md`（离线自主生活阶段直接以其 Phase A–D 为蓝本）。

---

## 全局约束（每个 Task 隐含遵守）

- 包管理器只用 `corepack pnpm@9.15.9`；测试 `corepack pnpm@9.15.9 vitest run`。
- AIRP 默认关闭，按角色开启；未开启角色的行为与调用数量必须逐字节不变。
- AIRP 开启后，允许每轮**额外一次**导演调用（含至多一轮工具补充轮，总计 ≤2 次 LLM 调用）。
- 默认自治等级 L2；重大关系变化、主线节点、不可逆行为不得后台自动完成。
- 不修改 `@rei-standard/*` 上游包；不扩展 D1 `scheduled_messages.message_type` 枚举。
- 不复活 `utils/brainAgent.ts` / `utils/toolbox.ts`（死代码）。
- 不建立第三套工具协议；前台复用 `utils/agenticTools.ts` 分派、worker 复用 fire 循环。
- Worker 纯逻辑模块零浏览器依赖（不 import React/DOM/IndexedDB/window/localStorage；`pnpm build:workers` 有守卫）。
- 凭据不进推送、结果信封、日志、世界事件。
- 不用设备时间替代角色时区接口（`utils/timezone.ts` `resolveCharTimeZone`）。
- 导演计划不得直接成为世界事实；只有正文正式发生或工具确认成功的事项可提交。
- Agent 不替用户角色说话、不决定用户内心、不覆盖 `locked` 设定。
- 外部服务失败不得伪造成功结果。
- 含中文文件改动后跑 `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`。
- 外部请求一律走 `utils/externalRequest.ts` 的 `externalFetch` / 现有代理入口，不新增裸 fetch（避开域名迁移冲突面）。
- 动 UI 前读 `docs/design-system.md`；动时间逻辑前读 `docs/character-timezone.md`；动记忆前读 `docs/memory-system-overview.md`。

---

## 设计决策（D 编号，执行时不得偏离）

### D1 确定性注入面（v1.2 核心，v1.1"记忆预取"的扩展）

**问题**：若"每轮都该在场"的信息做成导演工具（capability），模型可能跳过调用，导致该在场的没在场——相对现状的回归。现有系统里这些信息**已经是确定性每轮注入**：基础记忆（`injectMemoryPalace`，`utils/chatRequestPayload.ts:286`）、实时世界天气/节假日/新闻（fire 链路 `worker/amsg/src/index.ts:1933-1945` 每轮注入 `realtimeWorld` 块，快照+TTL 缓存在 `worker/amsg/src/realtimeWorld.ts`；浏览器侧 `utils/realtimeContext.ts` 同款 Manager）、时间/时区（`buildTimeAwarenessBlock`）、日程（`scheduleInjection`）、关系/情绪（`buildVolatileCoreState`）。AIRP 把它们挪进工具面 = 重复造轮子 + 引入漏查。

**划分标准不是信息类型，是获取成本结构**：

| 判断 | 归属 | 例子 |
|---|---|---|
| 每轮都要 + 内容收敛（就是"眼前这一份"） | **固定注入快照，绝不工具化** | 记忆基线、时间/时区、**角色当前城市天气**、节假日、新闻快照、地点、当前日程、关系状态、情绪 |
| 查询空间无限 / 依赖对话上下文 | 导演按需工具 | 定向补检索、**第三地**天气、周边/路线、web_search |
| 改变世界状态 | 写入类工具（分级） | 自管排程、日记、MCP 白名单 |

**决定**：

1. 快照构建（`buildAirpRuntimeSnapshot`）**无条件**执行基础记忆检索：调用现有检索管线（`utils/memoryPalace/pipeline.ts` 检索入口，与 `injectMemoryPalace` 同源），以 `memory_summary` 权威进 `facts`。
2. 快照构建**同时消费现有 realtimeWorld 缓存**（天气/新闻）：浏览器侧经 Task 7 在 `utils/realtimeContext.ts` 新增的只读 peek 读缓存（加法，不改既有行为；沿用同 TTL，过期视为缺席），不重复 fetch；节假日经 `checkSpecialDates` 纯函数；转 `tool_verified` 权威 facts，带 `observedAt`，过期不进快照。
3. 角色主链路的 `injectMemoryPalace` / realtimeWorld 块 / 时间块**全部原样保留**，角色模型继续拿自己那份——导演与角色各自消费，互不替代。
4. 天气工具仅保留 `weather_elsewhere`：查**指定地点**（≠ 已注入的当前地，如用户提到自己在别的城市、角色计划跨城）的天气，复用 `fetchWeatherWithFallback` 逻辑。当前地天气不是工具；第三地漏查才是合理降级。
5. `memory_deep_dive` 是基线之上的**定向补充检索**：导演认为基线召回不足（换关键词、追溯更早）才追加。没有它，基线已在场——最差等于现状。
6. 地图（周边/路线）与 web_search 属真正的按需查询型，保留工具化。

### D2 事实权威顺序（固定）

```text
user_canon > confirmed_scene > tool_verified > runtime_state > memory_summary > director_inference
```

- `locked: true` 的 `user_canon` 永不被 Agent 覆盖。
- 旧记忆摘要与近期正式剧情冲突：正式剧情胜，旧记忆标 `superseded`（留痕不删）。
- 工具结果只对其实际验证的字段有权威；天气/新闻/路线必须带时效，过期即不进当前快照。
- 同权威同 predicate：`updatedAt` 新者胜；同时且矛盾 → `dispute`，不自动裁决。

### D3 自治等级与风险门

```text
L0 冻结（只响应用户）
L1 生活痕迹（日程/情绪/动态/日记/轻量主动消息）
L2 受控剧情（日常事件+轻量支线可自主；重大节点悬置给用户）——默认
L3 高自治（明显世界变化；仍不替用户决定）
```

风险门：`read` L1+ 自动；`low_write` L2+；`confirm` 仅前台用户确认（worker 永拒）；`forbidden` 全拒。真实支付、转账、对外发帖评论、删数据、改凭据、破坏性 MCP 工具至少 `confirm`。

### D4 额外 LLM 调用例外

项目历史有"零额外 LLM 调用"纪律。本功能的例外：**仅 AIRP 开启角色**允许每轮 +1 次导演调用（工具补充轮至多再 +1）。回复后事实校验用确定性代码，不默认加第三次调用；只有确定性检查发现不可局部修复的高置信冲突才允许一次回复重写。落地时在本文件与 `notes/ethernet-branch-context.md` 记一句，防后续被误判为回归。

### D5 导演降级不改变回复产出路径

导演失败（网络/解析/超时）→ 聊天照常继续，演出指令块整块不注入，`console.warn` 留诊断。不触发本地生成的回退路径切换（不碰"绝不静默回退本地生成"红线）。

---

# 阶段一：AIRP 纯逻辑内核 + 私聊端到端导演闭环

> 阶段一结束时：开启 AIRP 的角色每轮先跑导演、指令块注入 volatileTail，工具面只有仓库已有实现的 read 类；关闭的角色零变化。不做：离线生活、事件永久提交、朋友圈/查手机生成、DB 版本变更、worker 侧改动。

## Task 1：AIRP 基础类型

**Files**
- Create: `utils/airp/types.ts`
- Create: `utils/airp/types.test.ts`

**Produces**（完整形状，字段名不得改动）

```ts
export type AirpAutonomyLevel = 0 | 1 | 2 | 3;

export type AirpFactAuthority =
  | 'user_canon' | 'confirmed_scene' | 'tool_verified'
  | 'runtime_state' | 'memory_summary' | 'director_inference';

export type AirpFactStatus = 'active' | 'superseded' | 'disputed' | 'expired';

export type AirpKnowledgeState = 'known' | 'suspected' | 'unknown' | 'misunderstood';

export type AirpCapabilityRisk = 'read' | 'low_write' | 'confirm' | 'forbidden';

export type AirpExecutionEnvironment = 'shared' | 'browser' | 'worker';

export interface AirpSourceRef {
  kind: 'user_message' | 'assistant_message' | 'room_plate' | 'worldbook'
      | 'memory' | 'schedule' | 'relationship' | 'tool' | 'runtime';
  id?: string; label?: string; observedAt?: number;
}

export interface AirpFact {
  id: string; charId: string; subjectId: string; predicate: string;
  value: string | number | boolean | null;
  authority: AirpFactAuthority; status: AirpFactStatus;
  validFrom: number; validUntil?: number; updatedAt: number;
  source: AirpSourceRef; locked: boolean;
}

export interface AirpKnowledge {
  factId: string; knowerId: string; state: AirpKnowledgeState;
  learnedAt?: number; sourceFactId?: string;
}

export interface AirpCapability {
  id: string; title: string;
  environment: AirpExecutionEnvironment; risk: AirpCapabilityRisk;
  category: 'memory' | 'time' | 'location' | 'weather' | 'news' | 'schedule'
          | 'relationship' | 'social' | 'communication' | 'external';
  toolNames: string[];
}

export interface AirpSceneState {
  now: number; tzId: string; locationLabel?: string;
  activity?: string; energy?: number; mood?: string;
}

export interface AirpRuntimeSnapshot {
  v: 1; charId: string; builtAt: number; autonomyLevel: AirpAutonomyLevel;
  scene: AirpSceneState; facts: AirpFact[]; knowledge: AirpKnowledge[];
  recentEventSummaries: string[]; unresolvedThreads: string[];
  capabilities: AirpCapability[];
}

export interface AirpDirectorBeat {
  actorId: string; intent: string;
  visibleEmotion?: string; hiddenEmotion?: string;
  referencedFactIds: string[];
}

export interface AirpProposedEvent {
  type: 'conversation' | 'activity' | 'movement' | 'schedule'
      | 'relationship' | 'discovery' | 'social_trace';
  summary: string; participants: string[]; locationLabel?: string;
  proposedAt: number; impact: 'trace' | 'minor' | 'major';
}

export interface AirpToolIntent {
  capabilityId: string; toolName: string; reason: string;
  arguments: Record<string, unknown>;
}

export interface AirpDirectorOutput {
  v: 1; sceneGoal: string; replyIntent: string;
  beats: AirpDirectorBeat[]; allowedDisclosures: string[];
  forbiddenAssumptions: string[]; toolIntents: AirpToolIntent[];
  proposedEvents: AirpProposedEvent[]; commitCandidates: string[];
}
```

**步骤**
- [ ] 创建 `utils/airp/types.ts`（仅类型，零 import）。
- [ ] 测试：构造完整 `AirpRuntimeSnapshot` 与 `AirpDirectorOutput`；`rg "AirpFact|AirpDirectorOutput" utils/` 确认无重名冲突。
- [ ] 验收：`corepack pnpm@9.15.9 vitest run utils/airp/types.test.ts` PASS。

## Task 2：事实权威与冲突解决

**Files**
- Create: `utils/airp/facts.ts` / `utils/airp/facts.test.ts`

**Produces**

```ts
export const AIRP_AUTHORITY_ORDER: readonly AirpFactAuthority[];

export function compareFactAuthority(left: AirpFactAuthority, right: AirpFactAuthority): number;

export interface AirpConflictResolution {
  winner: AirpFact; loser: AirpFact;
  action: 'keep' | 'replace' | 'dispute';
}

export function resolveFactConflict(current: AirpFact, incoming: AirpFact): AirpConflictResolution;

export function selectActiveFacts(facts: AirpFact[], now: number): AirpFact[];

export function filterKnownBy(knowledge: AirpKnowledge[], knowerId: string): string[];
```

**固定行为（每条写成测试）**
1. 权威顺序 = D2；`compareFactAuthority` 全 15 组组合断言传递性。
2. `current.locked === true && incoming.authority !== 'user_canon'` → 永远 `keep`，不改 current。
3. 高进低在 → `replace`（winner=incoming，loser=current 标 `superseded`）；低进高在 → `keep`（winner=current，incoming 丢弃）。v1.3 修正：此前版本两句写反（高权威 incoming 必须胜，见 D2），已纠正。
4. 同权威：`incoming.updatedAt > current.updatedAt` → `replace`；`<=` → `keep`；相互矛盾且 `updatedAt` 相同 → `dispute`（winner=current，都不标 superseded）。
5. `replace`/`dispute` 返回**新对象**，纯函数不改入参。
6. `selectActiveFacts` 剔除 `validUntil < now` 与 `status !== 'active'`。
7. 零依赖（无浏览器/Node 专属 import）。

**步骤**
- [ ] 写失败测试（上述 7 条）→ 确认红 → 实现 → 绿 → `git add utils/airp/facts.ts utils/airp/facts.test.ts && git commit -m "feat(airp): fact authority and conflict resolution"`。

## Task 3：能力风险门

**Files**
- Create: `utils/airp/capabilities.ts` / `.test.ts`

**Produces**

```ts
export interface AirpCapabilityDecision {
  allowed: boolean; requiresConfirmation: boolean;
  reason: 'allowed_read' | 'allowed_low_write' | 'confirmation_required'
        | 'wrong_environment' | 'autonomy_too_low' | 'forbidden';
}

export function decideAirpCapability(
  capability: AirpCapability,
  autonomyLevel: AirpAutonomyLevel,
  environment: 'browser' | 'worker',
): AirpCapabilityDecision;
```

**矩阵（全组合测试 4 risk × 4 level × 2 env）**

| risk | browser | worker |
|---|---|---|
| read | L1+ 自动 | L1+ 自动 |
| low_write | L2+ 自动 | L2+ 自动 |
| confirm | 需确认（requiresConfirmation=true） | 永拒（reason=forbidden，allowed=false） |
| forbidden | 拒 | 拒 |

- 环境不匹配（environment 为 'browser' 却在 worker，或反之）→ `wrong_environment`；'shared' 两边可。
- 等级不足 → `autonomy_too_low`。

## Task 4：导演输出两层容错解析

**Files**
- Create: `utils/airp/directorCore.ts` / `.test.ts`

```ts
export function validateAirpDirectorOutput(value: unknown): value is AirpDirectorOutput;
export function parseAirpDirectorOutput(raw: unknown): AirpDirectorOutput | null;
```

**行为**
1. 对象直接 validate；字符串依次试：整体 `JSON.parse` → 首个 ```json fenced block → 首个 `{` 到末个 `}`。
2. 拒绝：`v !== 1`、空 `sceneGoal`/`replyIntent`、`beats` 非数组或元素缺 `actorId`/`intent`、event `type`/`impact` 越枚举、toolIntent 空 `toolName`。
3. 数组字段缺失容错补 `[]`，不因此拒绝。
4. 失败返回 `null`；绝不抛异常、绝不返回空壳冒充成功。
5. 测试含：原生对象 / fenced / 前后带闲话的 JSON / `v:2` 拒 / 缺 `replyIntent` 拒 / 未知 type 拒 / 纯散文 null。

## Task 5：导演提示词与指令渲染

**Files**
- Create: `utils/airp/directorPrompt.ts` / `.test.ts`

```ts
export function buildDirectorSystemPrompt(snapshot: AirpRuntimeSnapshot): string;
export function buildDirectorUserPrompt(
  snapshot: AirpRuntimeSnapshot,
  latestUserMessage: string,
  recentDialogueTail: string[],
): string;
export function renderDirectorInstruction(output: AirpDirectorOutput): string;
```

**SystemPrompt 段落（按序）**：导演身份（只规划不表演、不替用户说话）→ 事实纪律（D2 + 自身推断最低权威）→ 场景（scene 有则写无则省整行，禁 "undefined"）→ 相关事实（`- [权威] 文本`，>20 条截前 20）→ 角色知识边界（仅 `filterKnownBy` 已知项）→ 未解决线索 → 可用能力（`id(risk) - title`）→ 输出契约（必须单个 JSON，字段清单 + 说明；`forbiddenAssumptions` 必列）。

**Instruction 块**：

```text
[System: 演出指令]
场景目标：{sceneGoal}
本轮意图：{replyIntent}
可透露：{allowedDisclosures 逐行}
禁止假设：{forbiddenAssumptions 逐行}
角色行动：{beats 每条一行 "actorId：intent（表露 visibleEmotion，内里 hiddenEmotion）"}
分寸：只依据以上约束演绎你的人格，禁止编造未列出的既成事实；触碰"禁止假设"中的内容必须转为不确定语气。
```

空数组 → 对应小节省略；`renderDirectorInstruction` 空输出返回 `''`（没查与查了没有不共用出口的既有纪律）。

## Task 6：AIRP 设置 + 分享卡剥离

**Files**
- Modify: `utils/types.ts`（角色类型真身，rg `memoryPalaceWaterline?:` 定位加 `airp?`）
- Create: `utils/airp/settings.ts` / `.test.ts`
- Modify: `utils/characterCard.ts` `CARD_STRIPPED_FIELDS`（第 3 类加 `'airp'`）+ `utils/characterCard.test.ts`

```ts
export interface AirpSettings {
  enabled: boolean;                // 默认 false
  autonomyLevel: AirpAutonomyLevel;  // 默认 2
  directorModel?: string;          // 缺省角色主模型
  capabilities: string[];          // 允许的 capability id 白名单；空 = 按 risk 门判
  mcpAllow: string[];             // serverId 白名单
  writable: boolean;              // 默认 false，low_write 总闸
  version: 1;
}
export function mergeAirpSettings(raw: unknown): AirpSettings;  // 非法回落默认
```

测试：三态（缺省/覆盖/非法）；分享卡断言 airp 剥离；backupRoundtrip 不炸。验收命令：`corepack pnpm@9.15.9 vitest run utils/airp/settings.test.ts utils/characterCard.test.ts`。

## Task 7：快照构建（含 D1 确定性记忆预取——本 Task 是 D1 的落地）

**Files**
- Create: `utils/airp/snapshot.ts` / `.test.ts`

```ts
export async function buildAirpRuntimeSnapshot(
  char: Char_,   // 以仓库实际角色类型名为准（rg "memoryPalaceWaterline" 的宿主类型）
  opts: {
    now?: number;
    recentDialogueTail?: string[];
    additionalFacts?: AirpFact[];       // 世界书等自愿转换来源
    loadEpisodes?: () => Promise<Array<{ summary: string; threadOpen?: boolean }>>;
    recallMemories?: (query: string) => Promise<AirpFact[]>;
  },
): Promise<AirpRuntimeSnapshot>;
```

**数据映射（全部只读现有字段，本 Task 禁建任何存储）**

| 快照字段 | 来源 | 失败策略 |
|---|---|---|
| `scene.tzId` | `resolveCharTimeZone(char)` | 必成 |
| `scene.now` | `opts.now ?? Date.now()` | 必成 |
| `scene.locationLabel` | `char.location.city/district` 拼接 | 缺省略 |
| `scene.activity` | `utils/scheduleInjection.ts` 当前时段 | 查不到省略 |
| `facts`（基线1） | `char.roomPlatesInjection` → runtime_state（须同时满足 `char.memoryPalaceEnabled`，与 `context.ts` 同门） | 缺 → 跳过 |
| `facts`（基线2） | `char.location` → runtime_state | 缺 → 跳过 |
| **`facts`（基线3，D1）** | **无条件调用记忆检索：优先进 `opts.recallMemories` 注入桩；未注入时调 `injectMemoryPalace`——传浅拷贝 `{...char}`（该函数会 mutation char 写入 `memoryPalaceInjection`，拷贝把副作用关在快照内部），读回拷贝的 `memoryPalaceInjection` 非空字符串，转 ONE 条 `memory_summary` 权威 fact；query 用 `opts.recentDialogueTail` 末 3 条拼接** | **检索失败/空 → 跳过该来源，绝不抛异常（v1.4：Statge-1 接受与随后 `buildChatRequestPayload` 的检索重复一次，优化延后；`factsPartial` 标记取消，类型冻结）** |
| **`facts`（基线5，D1）** | **消费 realtime 缓存：天气经 Task 7 新增的 `realtimeContext.ts` 只读 peek（加法，不改既有行为；沿用 fetch 方法的同一 TTL，过期视为缺席）；新闻 peek 未命中时经 `DB.getLatestHotNewsSnapshot()` 补（纯 IndexedDB 读，`fetchedAt` 距 builtAt 超 24h 视为过期）；节假日经 `realtimeWorldCore.checkSpecialDates` 纯函数（无 IO）。命中项 → `tool_verified` 权威 facts。`observedAt` = 所含缓存项中最旧的时间戳；仅有节假日时 = 快照 builtAt** | **缺席/过期 → 跳过；快照绝不自行 fetch 补位** |
| **`scene.weather` 等（D1）** | 同基线5 来源，天气同时更新 `scene`（当前地天气属于场景状态，不是工具） | 同上 |
| `facts`（基线4） | `opts.additionalFacts`（世界书等） | 缺 → 跳过 |
| `recentEventSummaries` | `opts.loadEpisodes?.()` 注入；**阶段一生产默认返回 `[]`**（v1.4：`world_episodes` 是叙事章节存储，无角色链接，硬读属于编造关联；真事件流在阶段二 `airp_events` 落地） | 失败 → `[]` |
| `unresolvedThreads` | 同源，上限 5；阶段一生产默认 `[]`，同上 | 失败 → `[]` |
| `capabilities` | Task 8 `AIRP_CAPABILITIES` | 静态 |
| `autonomyLevel` | `mergeAirpSettings(char.airp).autonomyLevel` | 必成 |

**D1 断言（测试里必须写死）**：`buildAirpRuntimeSnapshot` 的 facts 中 `authority === 'memory_summary'` 的条目**永远存在一档来源**（桩返回固定 2 条时快照必含这 2 条）——即基线记忆召回不依赖导演、不依赖工具、每轮必达。测试中 `db` 级来源全部经 `opts` 注入桩，测试文件不触碰真实 IndexedDB。

每个来源 try/catch 独立包裹：任何单来源失败 → 该字段省略，快照宁可薄不可炸。

## Task 8：能力清单

**Files**
- Create: `utils/airp/capabilityCatalog.ts` / `.test.ts`

```ts
export const AIRP_CAPABILITIES: readonly AirpCapability[] = [
  { id: 'memory_deep_dive', title: '定向深挖记忆（基线召回之上补检索）', environment: 'shared', risk: 'read', category: 'memory', toolNames: ['recall_deep'] },
  { id: 'web_search',  title: '网页搜索', environment: 'shared', risk: 'read', category: 'external', toolNames: ['web_search'] },
  { id: 'read_note',   title: '读笔记',   environment: 'shared', risk: 'read', category: 'memory', toolNames: ['read_note'] },
  { id: 'weather_elsewhere', title: '查第三地天气（当前地已固定注入，此工具只查其他地点）', environment: 'shared', risk: 'read', category: 'weather', toolNames: ['weather_lookup_place'] },
  { id: 'amap_nearby', title: '查周边地点', environment: 'shared', risk: 'read', category: 'location', toolNames: ['amap_search_places'] },
  { id: 'amap_route',  title: '查路线耗时', environment: 'shared', risk: 'read', category: 'location', toolNames: ['amap_route'] },
  { id: 'schedule_write', title: '自管排程', environment: 'browser', risk: 'low_write', category: 'schedule', toolNames: ['schedule_now', 'schedule_cancel', 'schedule_renew'] },
  { id: 'diary_write',    title: '写日记', environment: 'browser', risk: 'low_write', category: 'memory', toolNames: ['save_diary'] },
  { id: 'mcp_passthrough', title: 'MCP 工具（白名单展开）', environment: 'shared', risk: 'confirm', category: 'external', toolNames: [] },
];
```

**v1.2 删项**：`weather_now`（当前地天气）、`news_hot`、`schedule_read` 已从工具面移除——三者由快照确定性注入覆盖（D1 基线5：realtimeWorld 缓存 / 日程从 `scene.activity` 与基线 facts 进场）。角色当前日程、当前天气、热搜就是"眼前这一份"，不存在"该不该查"的判断空间，工具化它们只会引入漏查与重复请求。

**注意**：`memory_deep_dive` 是基线之上的补充（D1），不是基础召回入口。阶段一实际接线的只有仓库已有 read 工具（`recall_deep`→复用 `dispatchAgenticTool` 的 recall 换 query、`web_search`、`read_note`，见 `utils/agenticTools.ts:841` 分发）。`weather_elsewhere`/`amap_*`/`low_write` 各项**只注册不接线**：导演请求未接线能力时执行器返回「该能力暂不可用」确定性工具结果（不伪造成功、不静默吞掉）。测试断言：id 唯一；`mcp_passthrough.toolNames` 空数组合法。

## Task 9：导演客户端

**Files**
- Create: `utils/airp/directorClient.ts` / `.test.ts`

```ts
export interface AirpDirectorRunResult {
  ok: boolean;
  output?: AirpDirectorOutput;
  error?: string;   // 诊断只进 console/dev 面
  usage?: { promptTokens?: number; completionTokens?: number };
}

export async function runAirpDirector(
  char: Char_,
  api: { baseUrl: string; apiKey: string; model: string },
  snapshot: AirpRuntimeSnapshot,
  latestUserMessage: string,
  recentDialogueTail: string[],
): Promise<AirpDirectorRunResult>;
```

**行为**
1. `buildDirectorSystemPrompt` + `buildDirectorUserPrompt` → `${api.baseUrl}/chat/completions`，必须走 `utils/safeApi.ts` 的 `safeFetchJson`（禁裸 fetch）。
2. 参数：`temperature: 0.3`、`max_tokens: 1600`；`response_format: {type:'json_object'}` 仅当模型名含 `gpt` 或 `deepseek` 时附带，否则省略。
3. 解析用 Task 4；失败 → `ok:false, error:'parse_failed'`（附原文前 200 字，仅 console）。
4. 工具补充轮：`toolIntents` 非空且 Task 3 判 allowed → 执行（阶段一仅 recall_deep/web_search/read_note，经 `dispatchAgenticTool`），结果追加进 user prompt 再给导演**至多 1 轮**；第二轮仍带 toolIntents → 丢弃余下 intents 采用该轮其余字段。工具执行结果就是执行结果：失败/不可用按原样回给导演，`tool_verified` 权威只授予成功字段。
5. AbortController 45s 超时；网络失败 → `ok:false`。
6. 测试 mock `safeFetchJson`：成功解析 / 双层解析失败 / 超时 / 第二轮仍 toolIntents 的丢弃行为 / 未接线能力返回「暂不可用」。

## Task 10：接进私聊主链（端到端）

**Files**
- Modify: `hooks/useChatAI.ts`（插入点：`buildChatRequestPayload(...)` 调用前，当前约 `:795`；执行时 rg `buildChatRequestPayload` 重新定位）
- Modify: `utils/chatRequestPayload.ts`（`BuildChatPayloadInput` 加 `airpInstruction?: string`）
- Modify: `utils/chatRequestPayload.test.ts`

**接线规则**
1. `airpInstruction` 非空 → 在 `volatileTail` 组装中、**钢印归位（`volatileTail += parts.recencyTail`，当前约 `:494`）之前**追加 `\n\n` + 指令块；`volatileTailIndex` 计算不动。空字符串 → 输出与现状逐字节一致。
2. `useChatAI.ts` 在构建 payload 前插入（伪码）：
   ```text
   let airpInstruction: string | undefined;
   let airpDirectorOutput: AirpDirectorOutput | undefined;
   if (char.airp?.enabled) {
     try {
       const snapshot = await buildAirpRuntimeSnapshot(char, { recentDialogueTail: tail });
       const run = await runAirpDirector(char, api, snapshot, latestUserMessage, tail);
       if (run.ok && run.output) {
         airpInstruction = renderDirectorInstruction(run.output);
         airpDirectorOutput = run.output;   // 存本轮 ref，阶段一不消费（阶段二提交用）
       } else { console.warn('[airp] director degraded:', run.error); }
     } catch (e) { console.warn('[airp] snapshot/导演异常降级', e); }
   }
   ```
3. 整个 AIRP 段 try/catch，异常时 `airpInstruction` 保持 undefined，聊天不受影响（D5）。
4. 模型选择：`char.airp?.directorModel || 角色主模型`。
5. `utils/devDebug.ts` 加 dev-only 开关 `airpDirectorTrace`：开启时 console 输出导演 JSON 与快照摘要（按 `docs/dev-debug.md` 既有模式）。
6. 测试：`chatRequestPayload.test.ts` 三例——带指令块时 volatileTail 含 `[System: 演出指令]` 且位于钢印之前；空指令输出与现状逐字节一致；无 airp 字段输出与现状逐字节一致。
7. 手验（必须执行并记录）：开 AIRP 的测试角色连聊 5 轮（指令生效、无"undefined"、导演降级时聊天照常）；关 AIRP 角色回复与改动前无差异；导演填错 baseUrl 时聊天仍正常出话且 console 有 `[airp] director degraded`。

**阶段一收口**
- `corepack pnpm@9.15.9 vitest run`（全绿，基线 434 文件/5191 用例只增不减）
- `corepack pnpm@9.15.9 build:workers`（防误伤）
- `corepack pnpm@9.15.9 tsc --noEmit`（触碰文件零新增错误；存量 45 不处理）
- `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`
- `notes/ethernet-features.md` 补记 AIRP 导演闭环条目
- `notes/ethernet-branch-context.md` 记 D4 例外一句话
- 视情 bump `utils/buildInfo.ts` `APP_VERSION`

---

# 阶段二：事实校验与提交（开工前按本节骨架展开为同级粒度 Task）

1. **`utils/airp/commit.ts`**（纯叶子）：`extractCommittedEvents(directorOutput, finalReplyText): CommittedEvent[]`——只认两类：正文明确叙述发生的 `proposedEvents`（摘要关键词在正文命中）+ 工具实际成功的副作用；纯函数 + 单测。
2. **`utils/airp/eventStore.ts`**（浏览器）：IndexedDB 新 store `airp_events`（`utils/db.ts` `DB_VERSION + 1`；必须同步登记 `utils/backupCoverage.ts` `KNOWN` 与导入 case，漏一处护栏红）。事件带 `factId 引用、at、impact、disclosedToUser`。
3. **接入 `utils/applyAssistantPostProcessing.ts`**：Step 3（`ChatParser.parseAndExecuteActions` 调用点旁）之后消费本轮 directorOutput ref → `extractCommittedEvents` → 落 `airp_events` → 权威标 `confirmed_scene`。幂等：消息 metadata 记 `airpCommittedIds`（重生成同轮不重落）。
4. 冲突走 Task 2 `resolveFactConflict`；被替换 fact 标 `superseded` 留痕不删。
5. 世界事实库载体：角色级 `airp_world`（facts + knowledge，IndexedDB，随角色数据备份走）；worker 侧不建（离线阶段只出 events 结果信封）。

# 阶段三：离线自主生活

以 `plans/autonomy-round.md` Phase A–D 为蓝本照做（行号开工时重新 rg 核对），仅三处偏离：

1. `AutonomySettings` 并入 `AirpSettings`：`enabled` 统一语义，`autonomyLevel >= 1` 兼任原 autonomy 开关（L0 即关闭）。
2. 调度器判据加闸：原清单（距 lastUserMsgAt 窗口/每日上限/静默段/冷却/token 预算/熔断）之上要求 `autonomyLevel >= 1`；L2 下 major impact 事件自动降级悬置线索。
3. 自主回合产物：experiences 落 outbox 照旧；同时产 `AirpProposedEvent`（限定 trace/minor）共享阶段二事件流。

# 阶段四：现实信息工具接线

1. ~~`weather_now`~~ / ~~`news_hot`~~ 已在 v1.2 删除（D1）：当前地天气与新闻由快照消费 realtimeWorld 缓存确定性注入（Task 7 基线5），不经过导演工具面。本阶段仅接线真正的按需型：
2. `weather_elsewhere` → `utils/realtimeWorldCore.ts` `fetchWeatherWithFallback` 包执行器（按参数地点查，非当前地）。
3. `amap_*` → 前台走 `${getProxyWorkerUrl()}/amap/*` 既有代理。**已知缺口：`AmsgToolConfig` 无 `amapApiKey`、worker 无高德通道**——云端离线回合对 amap 能力返回 `wrong_environment` 降级（D3），上云通道单独立项评估，本阶段不做。
4. 新闻**过滤**（不是获取——获取走既有缓存）：快照基线5 的新闻进导演 prompt 前按角色 city/职业/兴趣匹配过滤，每轮上限 3 条。过滤是确定性代码，不是工具。
5. `schedule_write`/`diary_write` 接 `writable` 总闸 + `low_write` 风险门（默认关）。

# 阶段五：跨 App 投影与管理面板

1. 朋友圈/日记生成改为消费 `airp_events`：`disclosedToUser=false` 的事件不得进朋友圈正文；日记可写但标私密。
2. 查手机浏览/消费/搜索记录从 `social_trace` 类事件投影生成（不临时编造证据）。
3. `components/character/AirpPanel.tsx`：复用 `apps/Settings.tsx` 折叠外壳与控件形态；暴露 enabled/autonomyLevel/capabilities 白名单/mcpAllow/writable + 活动记录只读列表（`airp_events` 最近 50 条）。动 UI 前对照 `docs/design-system.md` 全文。
4. 见面/通话的导演约束注入（场景块），不接管正文生成。

---

# 测试与验收总表

| 阶段 | 命令 | 预期 |
|---|---|---|
| 每任务 | `corepack pnpm@9.15.9 vitest run utils/airp/<file>.test.ts` | 新增全绿 |
| 阶段关口 | `corepack pnpm@9.15.9 vitest run` | 全绿（基线只增不减） |
| Worker 构建 | `corepack pnpm@9.15.9 build:workers` | 成功 |
| 类型 | `corepack pnpm@9.15.9 tsc --noEmit` | 触碰文件零新增错误 |
| 乱码 | `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts` | 绿、无新增 U+FFFD |

# 需实测回填的参数（初值不得拍死）

| 参数 | 初值 | 说明 |
|---|---|---|
| 导演 max_tokens | 1600 | 上线后按分布调 |
| 导演 temperature | 0.3 | 同上 |
| 工具补充轮上限 | 1 | 失败率实测后评估 |
| 快照事实上限 | 20 | 按 token 实测调 |
| 离线 cadence/budget | autonomy-round 原值 | 该计划自述"数值自己量" |
| 新闻过滤领域表 | 空 | 按角色实测配置 |

# 本次会触碰的文件清单（多窗口协调用）

**新增（阶段一）**：`utils/airp/types.ts`、`facts.ts`、`capabilities.ts`、`capabilityCatalog.ts`、`directorCore.ts`、`directorPrompt.ts`、`settings.ts`、`snapshot.ts`、`directorClient.ts` + 各自 `.test.ts`。

**修改（阶段一）**：`utils/types.ts`、`utils/characterCard.ts`(+test)、`utils/chatRequestPayload.ts`(+test)、`hooks/useChatAI.ts`、`utils/devDebug.ts`。

**后续阶段追加**：`utils/applyAssistantPostProcessing.ts`、`utils/db.ts`、`utils/backupCoverage.ts`、worker 侧 autonomy 三件 + `fireKinds.ts`/`index.ts`、`components/character/AirpPanel.tsx` 等。

**不碰**：现有排程/expire/推送默认行为、`utils/amsgInstantChat.ts`、记忆提取管线水位、采样参数体系、其他窗口的域名迁移涉及文件（`plans/2026-09-15-domain-migration.md`）。

# 禁止事项（执行红线）

1. 不修改上游 `@rei-standard/*`。
2. 不给 D1 `message_type` 加枚举；不改上游 D1 schema。
3. 不复活 `utils/brainAgent.ts` / `utils/toolbox.ts`。
4. 不建平行聊天链 / 第三套工具协议。
5. Worker 叶子模块零浏览器依赖。
6. 凭据不进推送/信封/日志/事件。
7. 基础记忆召回不得做成"导演可选工具"（D1）。
8. 导演计划不得直接提交为世界事实。
9. Agent 不替用户说话/决定内心/覆盖 locked 设定。
10. 后台不执行支付/转账/发布/评论/删数据/凭据变更。
11. 外部失败不伪造成功。
12. AIRP 关闭角色行为与调用数量逐字节不变。
13. 含中文文件改动后跑乱码护栏。
14. 不动其他窗口的在改文件。
