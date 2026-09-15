import { describe, it, expect } from 'vitest';
import * as airpTypes from './types';
import type {
  AirpRuntimeSnapshot,
  AirpDirectorOutput,
  AirpFact,
  AirpKnowledge,
  AirpCapability,
  AirpDirectorBeat,
  AirpProposedEvent,
  AirpToolIntent,
} from './types';

const fact: AirpFact = {
  id: 'fact-1',
  charId: 'char-1',
  subjectId: 'user-1',
  predicate: 'likes',
  value: 'coffee',
  authority: 'user_canon',
  status: 'active',
  validFrom: 1000,
  validUntil: 2000,
  updatedAt: 1500,
  source: { kind: 'user_message', id: 'msg-1', label: '今天说的话', observedAt: 1500 },
  locked: true,
};

const knowledge: AirpKnowledge = {
  factId: 'fact-1',
  knowerId: 'char-1',
  state: 'known',
  learnedAt: 1500,
  sourceFactId: 'fact-0',
};

const capability: AirpCapability = {
  id: 'cap-1',
  title: '查天气',
  environment: 'worker',
  risk: 'read',
  category: 'weather',
  toolNames: ['get_weather'],
};

const beat: AirpDirectorBeat = {
  actorId: 'char-1',
  intent: '试探用户心情',
  visibleEmotion: '平静',
  hiddenEmotion: '紧张',
  referencedFactIds: ['fact-1'],
};

const proposedEvent: AirpProposedEvent = {
  type: 'conversation',
  summary: '两人约好周末去咖啡馆',
  participants: ['char-1', 'user-1'],
  locationLabel: '街角咖啡馆',
  proposedAt: 3000,
  impact: 'minor',
};

const toolIntent: AirpToolIntent = {
  capabilityId: 'cap-1',
  toolName: 'get_weather',
  reason: '想确认明天要不要带伞',
  arguments: { city: '上海' },
};

const snapshot: AirpRuntimeSnapshot = {
  v: 1,
  charId: 'char-1',
  builtAt: 4000,
  autonomyLevel: 2,
  scene: { now: 4000, tzId: 'Asia/Shanghai', locationLabel: '家', activity: '休息', energy: 0.8, mood: '放松' },
  facts: [fact],
  knowledge: [knowledge],
  recentEventSummaries: ['刚吃过晚饭'],
  unresolvedThreads: ['周末的约'],
  capabilities: [capability],
};

const directorOutput: AirpDirectorOutput = {
  v: 1,
  sceneGoal: '让用户放松下来',
  replyIntent: '顺着话题继续聊咖啡',
  beats: [beat],
  allowedDisclosures: ['明天自己有空'],
  forbiddenAssumptions: ['用户已经吃过饭'],
  toolIntents: [toolIntent],
  proposedEvents: [proposedEvent],
  commitCandidates: ['fact-1'],
};

describe('airp base types', () => {
  it('loads the type module', () => {
    expect(airpTypes).toBeDefined();
  });

  it('builds a complete runtime snapshot', () => {
    expect(snapshot.v).toBe(1);
    expect(snapshot.charId).toBe('char-1');
    expect(snapshot.facts[0].id).toBe('fact-1');
    expect(snapshot.knowledge[0].state).toBe('known');
    expect(snapshot.capabilities[0].environment).toBe('worker');
  });

  it('builds a complete director output', () => {
    expect(directorOutput.v).toBe(1);
    expect(directorOutput.beats[0].actorId).toBe('char-1');
    expect(directorOutput.toolIntents[0].toolName).toBe('get_weather');
    expect(directorOutput.proposedEvents[0].type).toBe('conversation');
  });
});
