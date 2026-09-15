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
