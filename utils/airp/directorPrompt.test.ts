import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildDirectorSystemPrompt,
  buildDirectorUserPrompt,
  renderDirectorInstruction,
} from './directorPrompt';
import type {
  AirpCapability,
  AirpDirectorOutput,
  AirpFact,
  AirpKnowledge,
  AirpRuntimeSnapshot,
} from './types';

function makeFact(overrides: Partial<AirpFact> = {}): AirpFact {
  return {
    id: 'fact-1',
    charId: 'char-1',
    subjectId: 'user-1',
    predicate: 'likes',
    value: 'coffee',
    authority: 'memory_summary',
    status: 'active',
    validFrom: 0,
    updatedAt: 100,
    source: { kind: 'memory', id: 'mem-1' },
    locked: false,
    ...overrides,
  };
}

function makeCapability(overrides: Partial<AirpCapability> = {}): AirpCapability {
  return {
    id: 'cap-1',
    title: '读取记忆',
    environment: 'shared',
    risk: 'read',
    category: 'memory',
    toolNames: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<AirpRuntimeSnapshot> = {}): AirpRuntimeSnapshot {
  return {
    v: 1,
    charId: 'char-1',
    builtAt: 1000,
    autonomyLevel: 2,
    scene: { now: 1000, tzId: 'Asia/Shanghai' },
    facts: [],
    knowledge: [],
    recentEventSummaries: [],
    unresolvedThreads: [],
    capabilities: [],
    ...overrides,
  };
}

function makeOutput(overrides: Partial<AirpDirectorOutput> = {}): AirpDirectorOutput {
  return {
    v: 1,
    sceneGoal: '',
    replyIntent: '',
    beats: [],
    allowedDisclosures: [],
    forbiddenAssumptions: [],
    toolIntents: [],
    proposedEvents: [],
    commitCandidates: [],
    ...overrides,
  };
}

const SECTION_MARKERS = [
  '幕后导演',
  '事实纪律：',
  '当前场景：',
  '相关事实：',
  '角色知识边界：',
  '未解决线索：',
  '可用能力：',
  '输出契约：',
];

describe('buildDirectorSystemPrompt — section order (behavior 1)', () => {
  const snapshot = makeSnapshot({
    scene: {
      now: 1000,
      tzId: 'Asia/Shanghai',
      locationLabel: '家中书房',
      activity: '写代码',
      energy: 3,
      mood: '平静',
    },
    facts: [
      makeFact({ id: 'f1', authority: 'user_canon', predicate: 'hasPet', value: 'cat' }),
    ],
    knowledge: [{ factId: 'f1', knowerId: 'char-1', state: 'known' }],
    unresolvedThreads: ['周末的约定还没定'],
    capabilities: [makeCapability({ id: 'memory.read', title: '读取记忆', risk: 'read' })],
  });

  it('renders all 8 sections in order', () => {
    const output = buildDirectorSystemPrompt(snapshot);

    let previous = -1;
    for (const marker of SECTION_MARKERS) {
      const index = output.indexOf(marker);
      expect(index, `missing section marker: ${marker}`).toBeGreaterThanOrEqual(0);
      expect(index, `section out of order: ${marker}`).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it('renders scene fields, fact lines, thread lines and capabilities', () => {
    const output = buildDirectorSystemPrompt(snapshot);

    expect(output).toContain('地点：家中书房');
    expect(output).toContain('活动：写代码');
    expect(output).toContain('精力：3');
    expect(output).toContain('情绪：平静');
    expect(output).toContain('- [user_canon] user-1 hasPet: cat');
    expect(output).toContain('- 周末的约定还没定');
    expect(output).toContain('- memory.read(read) - 读取记忆');
    expect(output).not.toContain('undefined');
  });
});

describe('buildDirectorSystemPrompt — minimal snapshot (behavior 2)', () => {
  it('omits scene / fact / thread lines gracefully without "undefined"', () => {
    const output = buildDirectorSystemPrompt(makeSnapshot());

    expect(output).not.toContain('undefined');
    expect(output).not.toContain('地点：');
    expect(output).not.toContain('活动：');
    expect(output).not.toContain('精力：');
    expect(output).not.toContain('情绪：');
    expect(output).toContain('相关事实：\n角色知识边界：');
    expect(output).toContain('未解决线索：\n可用能力：');
    expect(output).toContain('可用能力：\n输出契约：');
  });

  it('renders each present scene field independently', () => {
    const output = buildDirectorSystemPrompt(
      makeSnapshot({ scene: { now: 1, tzId: 'UTC', mood: '低落' } }),
    );

    expect(output).toContain('情绪：低落');
    expect(output).not.toContain('地点：');
    expect(output).not.toContain('精力：');
  });
});

describe('buildDirectorSystemPrompt — fact truncation (behavior 3)', () => {
  it('truncates to the first 20 facts', () => {
    const facts = Array.from({ length: 25 }, (_, i) =>
      makeFact({ id: `fact-${i}`, predicate: `p${i}`, value: `v${i}` }),
    );
    const output = buildDirectorSystemPrompt(makeSnapshot({ facts }));

    expect(output).toContain('p0:');
    expect(output).toContain('p19:');
    expect(output).not.toContain('p20:');
    expect(output).not.toContain('p24:');
  });
});

describe('buildDirectorSystemPrompt — knowledge boundary (behavior 4)', () => {
  it('lists only facts known by the snapshot character', () => {
    const facts = [
      makeFact({ id: 'known-1', predicate: 'knownThing', value: 'knownValue' }),
      makeFact({ id: 'secret-1', predicate: 'secretThing', value: 'secretValue' }),
    ];
    const knowledge: AirpKnowledge[] = [
      { factId: 'known-1', knowerId: 'char-1', state: 'known' },
      { factId: 'secret-1', knowerId: 'char-2', state: 'known' },
    ];
    const output = buildDirectorSystemPrompt(
      makeSnapshot({ charId: 'char-1', facts, knowledge }),
    );

    const knownSection = output.split('角色知识边界：')[1].split('未解决线索：')[0];
    expect(knownSection).toContain('knownValue');
    expect(knownSection).not.toContain('secretValue');
    expect(output).toContain('secretValue');
  });

  it('excludes suspected facts from the known section', () => {
    const facts = [makeFact({ id: 'suspect-1', predicate: 'maybe', value: 'suspectValue' })];
    const output = buildDirectorSystemPrompt(
      makeSnapshot({
        facts,
        knowledge: [{ factId: 'suspect-1', knowerId: 'char-1', state: 'suspected' }],
      }),
    );

    const knownSection = output.split('角色知识边界：')[1].split('未解决线索：')[0];
    expect(knownSection).not.toContain('suspectValue');
  });
});

describe('renderDirectorInstruction (behavior 5)', () => {
  it('renders the exact instruction block shape', () => {
    const output = makeOutput({
      sceneGoal: '让用户说出咖啡口味偏好',
      replyIntent: '引导话题到咖啡',
      allowedDisclosures: ['我最近在学手冲'],
      forbiddenAssumptions: ['用户已经喝过这家的咖啡'],
      beats: [
        { actorId: 'char-1', intent: '主动搭话', visibleEmotion: '好奇', hiddenEmotion: '紧张', referencedFactIds: [] },
      ],
    });

    expect(renderDirectorInstruction(output)).toBe(
      '[System: 演出指令]\n' +
        '场景目标：让用户说出咖啡口味偏好\n' +
        '本轮意图：引导话题到咖啡\n' +
        '可透露：\n' +
        '我最近在学手冲\n' +
        '禁止假设：\n' +
        '用户已经喝过这家的咖啡\n' +
        '角色行动：\n' +
        'char-1：主动搭话（表露 好奇，内里 紧张）\n' +
        '分寸：只依据以上约束演绎你的人格，禁止编造未列出的既成事实；触碰"禁止假设"中的内容必须转为不确定语气。',
    );
  });

  it('omits empty subsections', () => {
    const output = renderDirectorInstruction(
      makeOutput({ sceneGoal: '目标', replyIntent: '意图' }),
    );

    expect(output).toContain('[System: 演出指令]');
    expect(output).toContain('场景目标：目标');
    expect(output).toContain('本轮意图：意图');
    expect(output).not.toContain('可透露：');
    expect(output).not.toContain('禁止假设：');
    expect(output).not.toContain('角色行动：');
    expect(output).toContain('分寸：');
  });

  it('returns an empty string for a fully empty output', () => {
    expect(renderDirectorInstruction(makeOutput())).toBe('');
  });

  it('returns an empty string when only unrendered lists are populated', () => {
    const output = makeOutput({
      toolIntents: [{ capabilityId: 'c', toolName: 't', reason: 'r', arguments: {} }],
      proposedEvents: [],
      commitCandidates: ['x'],
    });

    expect(renderDirectorInstruction(output)).toBe('');
  });

  it('omits absent beat emotion parts', () => {
    const output = renderDirectorInstruction(
      makeOutput({
        sceneGoal: 'g',
        replyIntent: 'r',
        beats: [
          { actorId: 'char-1', intent: 'i1', visibleEmotion: '开心', hiddenEmotion: '不安', referencedFactIds: [] },
          { actorId: 'char-1', intent: 'i2', visibleEmotion: '好奇', referencedFactIds: [] },
          { actorId: 'char-1', intent: 'i3', hiddenEmotion: '失落', referencedFactIds: [] },
          { actorId: 'char-1', intent: 'i4', referencedFactIds: [] },
        ],
      }),
    );

    expect(output).toContain('角色行动：\nchar-1：i1（表露 开心，内里 不安）');
    expect(output).toContain('char-1：i2（表露 好奇）');
    expect(output).toContain('char-1：i3（内里 失落）');
    expect(output).toContain('char-1：i4');
    expect(output).not.toContain('i4（');
  });
});

describe('buildDirectorUserPrompt (behavior 6)', () => {
  it('contains the latest message and every tail line', () => {
    const prompt = buildDirectorUserPrompt(
      makeSnapshot(),
      '你好，今天想聊咖啡',
      ['角色：我最近在学手冲', '用户：那你喜欢什么豆子'],
    );

    expect(prompt).toContain('你好，今天想聊咖啡');
    expect(prompt).toContain('我最近在学手冲');
    expect(prompt).toContain('那你喜欢什么豆子');
    expect(prompt).toContain('char-1');
    expect(prompt).not.toContain('undefined');
  });

  it('handles an empty dialogue tail', () => {
    const prompt = buildDirectorUserPrompt(makeSnapshot(), '在吗', []);

    expect(prompt).toContain('在吗');
    expect(prompt).not.toContain('undefined');
  });
});

describe('module purity', () => {
  it('imports only from ./types and ./facts', () => {
    const source = readFileSync(new URL('./directorPrompt.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/import\s+['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((s) => s === './types' || s === './facts')).toBe(true);
  });
});
