import type { AirpDirectorOutput, AirpProposedEvent, AirpSourceRef } from './types';

export interface AirpCommittedEvent {
  id: string;
  charId: string;
  type: AirpProposedEvent['type'];
  summary: string;
  participants: string[];
  locationLabel?: string;
  impact: 'trace' | 'minor' | 'major';
  at: number;
  authority: 'confirmed_scene';
  disclosedToUser: boolean;
  source: AirpSourceRef;
}

export interface ExtractCommitOpts {
  charId: string;
  atMs?: number;
  messageId?: number;
}

// BMP-only, no \p{} escapes and no lookbehind (see utils/noLookbehind.test.ts).
const norm = (s: string): string =>
  (s ?? '').toLowerCase().replace(/[\s\u3000-\u303f\uff00-\uffef\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '');

function pushUnique(out: string[], value: string): void {
  if (!out.includes(value)) out.push(value);
}

const keywordsOf = (normSummary: string): string[] => {
  const out: string[] = [];
  for (const m of normSummary.matchAll(/[a-z0-9]{2,}/g)) pushUnique(out, m[0]);
  const cjk = normSummary.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of cjk) for (let i = 0; i + 1 < run.length; i++) pushUnique(out, run.slice(i, i + 2));
  return out;
};

function wasNarrated(normSummary: string, replyNorm: string): boolean {
  if (normSummary.length < 2) return false;
  const keywords = keywordsOf(normSummary);
  const hits = keywords.filter((keyword) => replyNorm.includes(keyword)).length;
  return (
    replyNorm.includes(normSummary) ||
    hits >= 2 ||
    (keywords.length >= 1 && keywords.length <= 2 && hits === keywords.length)
  );
}

export function extractCommittedEvents(
  directorOutput: AirpDirectorOutput,
  finalReplyText: string,
  opts: ExtractCommitOpts,
): AirpCommittedEvent[] {
  const proposals = directorOutput?.proposedEvents;
  if (!Array.isArray(proposals)) return [];
  if (typeof finalReplyText !== 'string' || finalReplyText.length === 0) return [];

  const charId = opts?.charId ?? '';
  const atMs = opts?.atMs ?? Date.now();
  const replyNorm = norm(finalReplyText);

  const committed: AirpCommittedEvent[] = [];
  for (const proposal of proposals) {
    if (proposal === null || typeof proposal !== 'object') continue;
    const { summary } = proposal as AirpProposedEvent;
    if (typeof summary !== 'string' || summary.length === 0) continue;

    const normSummary = norm(summary);
    if (!wasNarrated(normSummary, replyNorm)) continue;

    const source: AirpSourceRef = { kind: 'assistant_message' };
    if (opts?.messageId !== undefined) source.id = String(opts.messageId);

    const event: AirpCommittedEvent = {
      id: `airp-${charId}-${atMs}-${committed.length}`,
      charId,
      type: proposal.type,
      summary,
      participants: Array.isArray(proposal.participants) ? [...proposal.participants] : [],
      impact: proposal.impact,
      at: atMs,
      authority: 'confirmed_scene',
      disclosedToUser: true,
      source,
    };
    if (proposal.locationLabel !== undefined && proposal.locationLabel !== null) {
      event.locationLabel = proposal.locationLabel;
    }
    committed.push(event);
  }

  return committed;
}
