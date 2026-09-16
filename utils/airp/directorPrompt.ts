import type {
  AirpDirectorBeat,
  AirpDirectorOutput,
  AirpFact,
  AirpRuntimeSnapshot,
} from './types';
import { filterKnownBy } from './facts';

const MAX_FACTS = 20;

const WIRED_TOOL_SCHEMAS: Record<string, string> = {
  recall_deep: '参数 {"year":"YYYY","month":"M"}，例 {"year":"2026","month":"9"}（注意：没有query参数，按年月查）',
  web_search: '参数 {"query":"搜索词"}',
  read_note: '参数 {"keyword":"关键词"}',
  weather_lookup_place: '参数 {"city":"城市名，如 杭州"}（查的是指定地点，不是角色当前地）',
  amap_search_places: '参数 {"keywords":"搜什么，如 咖啡馆", "city":"城市（必填，不确定就用角色所在城市）"}',
  schedule_now: '参数 {"send_at":"你本地墙钟的 YYYY-MM-DDTHH:mm:ss（如 2026-07-20T20:00:00），不带时区后缀，必须晚于当前时间","mode":"auto 或 prompted（可选，默认 auto）","prompt_hint":"仅 mode=prompted 时给的方向","recurrence":"none 或 daily 或 weekly（可选，默认 none）","expire_policy":"expire 或 force（可选）"}，仅 send_at 必填；管理角色自己的定时主动消息排程',
  schedule_cancel: '参数 {"task_id":"要取消的任务短 id（8 位）；当前只有一个待触发任务时可省略"}；取消角色的一个定时主动消息任务',
  schedule_renew: '参数 {"send_at":"新触发时间，写你本地墙钟的 YYYY-MM-DDTHH:mm:ss，不带时区后缀，必须晚于当前时间","task_id":"要续期的任务短 id（8 位）；只有一个任务时可省略"}，仅 send_at 必填；给角色的定时主动消息续期',
  save_diary: '参数 {"text":"要记下的内容"}（以角色身份写进手机日记）',
};

function safeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

function isPresentText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPresentNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function factValueText(value: AirpFact['value']): string {
  if (value === null) return 'null';
  return safeText(value);
}

function factText(fact: AirpFact): string {
  return `${safeText(fact.subjectId)} ${safeText(fact.predicate)}: ${factValueText(fact.value)}`;
}

function renderIdentity(snapshot: AirpRuntimeSnapshot): string[] {
  return [
    `你是 AIRP（Ambient In-character Runtime Protocol）的幕后导演（backstage director）。你只做规划，绝不表演。`,
    `不得输出任何角色台词；不得替用户说话——用户是角色「${safeText(snapshot.charId)}」的对话对象，也不得替用户决定其内心状态。`,
  ];
}

function renderFactDiscipline(): string[] {
  return [
    '事实纪律：',
    '- 最高权威是用户的明确设定（user_canon）。',
    '- 近期已确认的场景（confirmed_scene）优先于旧的记忆摘要（memory_summary）。',
    '- 你自己的推断（director_inference）权威最低，绝不可覆盖任何已确立的事实。',
  ];
}

function wallClockText(tzId: string, now: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch { return null; }
}

function renderScene(snapshot: AirpRuntimeSnapshot): string[] {
  const { scene } = snapshot;
  const lines: string[] = ['当前场景：'];
  const wall = wallClockText(scene.tzId, scene.now);
  lines.push(wall ? `- 时间：${wall}（${scene.tzId}）` : `- 时间：${new Date(scene.now).toISOString()}（UTC）`);
  if (isPresentText(scene.locationLabel)) lines.push(`- 地点：${scene.locationLabel}`);
  if (isPresentText(scene.activity)) lines.push(`- 活动：${scene.activity}`);
  if (isPresentNumber(scene.energy)) lines.push(`- 精力：${scene.energy}`);
  if (isPresentText(scene.mood)) lines.push(`- 情绪：${scene.mood}`);
  return lines;
}

function renderFacts(snapshot: AirpRuntimeSnapshot): string[] {
  const lines: string[] = ['相关事实：'];
  for (const fact of snapshot.facts.slice(0, MAX_FACTS)) {
    lines.push(`- [${safeText(fact.authority)}] ${factText(fact)}`);
  }
  return lines;
}

function renderKnowledgeBoundary(snapshot: AirpRuntimeSnapshot): string[] {
  const knownIds = new Set(filterKnownBy(snapshot.knowledge, snapshot.charId));
  const knownFacts = snapshot.facts.filter((fact) => knownIds.has(fact.id));
  if (knownFacts.length === 0) return [];
  const lines: string[] = [
    '角色知识边界：',
    '（仅以下事实对该角色成立；未列出的一律视为未知，不得当作既成事实。）',
  ];
  for (const fact of knownFacts) lines.push(`- ${factText(fact)}`);
  return lines;
}

function renderUnresolvedThreads(snapshot: AirpRuntimeSnapshot): string[] {
  const lines: string[] = ['未解决线索：'];
  for (const thread of snapshot.unresolvedThreads) {
    lines.push(`- ${safeText(thread)}`);
  }
  return lines;
}

function renderCapabilities(snapshot: AirpRuntimeSnapshot): string[] {
  const lines: string[] = ['可用能力：'];
  for (const capability of snapshot.capabilities) {
    const toolNames = Array.isArray(capability.toolNames) ? capability.toolNames : [];
    let line = `- ${safeText(capability.id)}(${safeText(capability.risk)}) - ${safeText(capability.title)}`;
    if (toolNames.length) line += ` [工具: ${toolNames.join(', ')}]`;
    lines.push(line);
    for (const toolName of toolNames) {
      const schema = WIRED_TOOL_SCHEMAS[toolName];
      lines.push(schema ? `  ${toolName} ${schema}` : `  ${toolName}（尚未接线：不要请求）`);
    }
  }
  return lines;
}

function renderOutputContract(): string[] {
  return [
    '输出契约：',
    '只输出单个 JSON 对象，不得输出 JSON 以外的任何内容。字段如下：',
    '- sceneGoal：本轮场景希望达成的方向。',
    '- replyIntent：角色这一轮回应的意图。',
    '- beats：角色行动列表，每条含 actorId 与 intent，可选 visibleEmotion / hiddenEmotion。',
    '- allowedDisclosures：本轮可以透露给用户的信息。',
    '- forbiddenAssumptions：本轮必须列为禁止假设、不得假定成立的事项。',
    '- toolIntents：需要调用的能力与工具及理由，每条含 capabilityId（能力id）+ toolName（该能力【工具:】中的名字）+ arguments（按该工具的参数格式）。',
    '- proposedEvents：本轮可能发生的世界事件。',
    '- commitCandidates：值得写入长期事实的候选内容。',
  ];
}

export function buildDirectorSystemPrompt(snapshot: AirpRuntimeSnapshot): string {
  return [
    ...renderIdentity(snapshot),
    ...renderFactDiscipline(),
    ...renderScene(snapshot),
    ...renderFacts(snapshot),
    ...renderKnowledgeBoundary(snapshot),
    ...renderUnresolvedThreads(snapshot),
    ...renderCapabilities(snapshot),
    ...renderOutputContract(),
  ].join('\n');
}

export function buildDirectorUserPrompt(
  snapshot: AirpRuntimeSnapshot,
  latestUserMessage: string,
  recentDialogueTail: string[],
): string {
  const lines: string[] = [
    `[最新用户消息]`,
    safeText(latestUserMessage),
    '',
    '[最近对话]',
  ];
  for (const line of recentDialogueTail) {
    lines.push(safeText(line));
  }
  lines.push(
    '',
    `请依据系统提示中的输出契约，规划角色「${safeText(snapshot.charId)}」这一轮的反应，输出单个导演 JSON 对象。`,
  );
  return lines.join('\n');
}

function renderBeat(beat: AirpDirectorBeat): string {
  const visible = isPresentText(beat.visibleEmotion) ? beat.visibleEmotion : '';
  const hidden = isPresentText(beat.hiddenEmotion) ? beat.hiddenEmotion : '';

  let emotion = '';
  if (visible.length > 0 && hidden.length > 0) emotion = `（表露 ${visible}，内里 ${hidden}）`;
  else if (visible.length > 0) emotion = `（表露 ${visible}）`;
  else if (hidden.length > 0) emotion = `（内里 ${hidden}）`;

  return `${safeText(beat.actorId)}：${safeText(beat.intent)}${emotion}`;
}

export function renderDirectorInstruction(output: AirpDirectorOutput): string {
  const sceneGoal = safeText(output.sceneGoal);
  const replyIntent = safeText(output.replyIntent);
  const allowedDisclosures = output.allowedDisclosures ?? [];
  const forbiddenAssumptions = output.forbiddenAssumptions ?? [];
  const beats = output.beats ?? [];

  if (
    sceneGoal.length === 0 &&
    replyIntent.length === 0 &&
    allowedDisclosures.length === 0 &&
    forbiddenAssumptions.length === 0 &&
    beats.length === 0
  ) {
    return '';
  }

  const lines: string[] = ['[System: 演出指令]'];
  lines.push(`场景目标：${sceneGoal}`);
  lines.push(`本轮意图：${replyIntent}`);

  if (allowedDisclosures.length > 0) {
    lines.push('可透露：');
    for (const item of allowedDisclosures) lines.push(safeText(item));
  }

  if (forbiddenAssumptions.length > 0) {
    lines.push('禁止假设：');
    for (const item of forbiddenAssumptions) lines.push(safeText(item));
  }

  if (beats.length > 0) {
    lines.push('角色行动：');
    for (const beat of beats) lines.push(renderBeat(beat));
  }

  lines.push(
    '分寸：只依据以上约束演绎你的人格，禁止编造未列出的既成事实；触碰"禁止假设"中的内容必须转为不确定语气。',
  );

  return lines.join('\n');
}
