import type { AirpDirectorOutput } from './types';

const PROPOSED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'conversation',
  'activity',
  'movement',
  'schedule',
  'relationship',
  'discovery',
  'social_trace',
]);

const PROPOSED_EVENT_IMPACTS: ReadonlySet<string> = new Set(['trace', 'minor', 'major']);

const DEFAULTED_ARRAY_FIELDS = [
  'beats',
  'toolIntents',
  'proposedEvents',
  'allowedDisclosures',
  'forbiddenAssumptions',
  'commitCandidates',
] as const;

type JsonCandidate = { found: true; value: unknown } | { found: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasValidBeats(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (beat) =>
        isPlainObject(beat) && isNonEmptyString(beat.actorId) && isNonEmptyString(beat.intent),
    )
  );
}

function hasValidToolIntents(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((intent) => isPlainObject(intent) && isNonEmptyString(intent.toolName))
  );
}

function hasValidProposedEvents(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (event) =>
        isPlainObject(event) &&
        PROPOSED_EVENT_TYPES.has(event.type as string) &&
        PROPOSED_EVENT_IMPACTS.has(event.impact as string),
    )
  );
}

function normalizeAirpDirectorOutput(value: unknown): AirpDirectorOutput | null {
  if (!isPlainObject(value)) return null;
  if (value.v !== 1) return null;
  if (!isNonEmptyString(value.sceneGoal)) return null;
  if (!isNonEmptyString(value.replyIntent)) return null;

  for (const field of DEFAULTED_ARRAY_FIELDS) {
    const candidate = value[field];
    if (candidate !== undefined && !Array.isArray(candidate)) return null;
  }

  const beats = value.beats ?? [];
  if (!hasValidBeats(beats)) return null;

  const toolIntents = value.toolIntents ?? [];
  if (!hasValidToolIntents(toolIntents)) return null;

  const proposedEvents = value.proposedEvents ?? [];
  if (!hasValidProposedEvents(proposedEvents)) return null;

  return {
    ...value,
    v: 1,
    sceneGoal: value.sceneGoal,
    replyIntent: value.replyIntent,
    beats,
    toolIntents,
    proposedEvents,
    allowedDisclosures: value.allowedDisclosures ?? [],
    forbiddenAssumptions: value.forbiddenAssumptions ?? [],
    commitCandidates: value.commitCandidates ?? [],
  } as AirpDirectorOutput;
}

function tryParseJson(raw: string): JsonCandidate {
  try {
    return { found: true, value: JSON.parse(raw) };
  } catch {
    return { found: false };
  }
}

function extractJsonCandidate(raw: string): JsonCandidate {
  const whole = tryParseJson(raw);
  if (whole.found) return whole;

  const fenced = /```json\s*([\s\S]*?)```/i.exec(raw);
  if (fenced !== null) {
    const fencedResult = tryParseJson(fenced[1]);
    if (fencedResult.found) return fencedResult;
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = tryParseJson(raw.slice(start, end + 1));
    if (sliced.found) return sliced;
  }

  return { found: false };
}

export function validateAirpDirectorOutput(value: unknown): value is AirpDirectorOutput {
  return normalizeAirpDirectorOutput(value) !== null;
}

export function parseAirpDirectorOutput(raw: unknown): AirpDirectorOutput | null {
  if (isPlainObject(raw)) return normalizeAirpDirectorOutput(raw);
  if (typeof raw !== 'string') return null;

  const candidate = extractJsonCandidate(raw);
  if (!candidate.found) return null;
  return normalizeAirpDirectorOutput(candidate.value);
}
