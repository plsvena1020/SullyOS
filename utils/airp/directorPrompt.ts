import type {
  AirpDirectorBeat,
  AirpDirectorOutput,
  AirpFact,
  AirpRuntimeSnapshot,
} from './types';
import { filterKnownBy } from './facts';

const MAX_FACTS = 20;

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

function renderScene(snapshot: AirpRuntimeSnapshot): string[] {
  const { scene } = snapshot;
  const lines: string[] = ['当前场景：'];
  lines.push(`- 时间：${new Date(scene.now).toISOString()}（${scene.tzId}）`);
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
  const lines: string[] = [
    '角色知识边界：',
    '（仅以下事实对该角色成立；未列出的一律视为未知，不得当作既成事实。）',
  ];
  const knownIds = new Set(filterKnownBy(snapshot.knowledge, snapshot.charId));
  for (const fact of snapshot.facts) {
    if (knownIds.has(fact.id)) lines.push(`- ${factText(fact)}`);
  }
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
    lines.push(`- ${safeText(capability.id)}(${safeText(capability.risk)}) - ${safeText(capability.title)}`);
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
    '- toolIntents：需要调用的能力与工具及理由。',
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
