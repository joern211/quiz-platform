// ============================================================
// N10 — Intake of bidding projections: binding, version knowledge per ordering level, withdrawal (pure, no React, no DOM)
//
// Two things are kept apart, as in N6 – N9:
//   seen* — the minimal VERSION KNOWLEDGE of one context: one NUMBER per ordering level — the global snapshot version, the local bidding version, the current N8 sequence
//           version and the identity of the N8 turn. Numbers only; they survive withdrawal, null, undefined and invalid views.
//   held  — what may be shown and acted on right now (the validated projection). Gone on every withdrawal.
// A projection is only an observation if it is strictly valid, belongs to the expected context (scope AND recipient) and is not older than the caller's INDEPENDENT
// `minStateVersion` (from its own snapshot channel, never from the incoming packet). Invalid, foreign or too-old input never moves any `seen*` (no poisoning with a
// huge unchecked number).
//
// The context is ONE bidding instance and one recipient (run, round, bidding, sequence, roster revision, roles revision, recipient). A new bidding, another round, a
// rotated role assignment or another recipient is a NEW context with empty knowledge — a packet of the old bidding is then foreign and shows nothing; there is no archive.
//   - NEUTRAL packets carry only the global snapshot version: they raise `seenStateVersion` and nothing else (they carry no bidding counters on purpose — see
//     shared/bidding.ts). A neutral packet is a version observation like any other: a LATE standing packet of older snapshot is refused after it, so "neutral view →
//     withdrawal → late released bidder packet" shows nothing.
//   - STANDING packets raise all four levels: stateVersion, biddingVersion, sequenceVersion, turnNumber (each monotone for the whole context). That refuses
//     "standing → null → an older standing", "closed → invalid → an old can-bid view", "A in turn 1 → B → A in turn 3 → a late packet of turn 1" and
//     "a newer eligibility basis without any bid → the older stand".
// A newer valid view with the neutral release still raises the knowledge. At the very same stand a re-delivery with the same or a narrower release is accepted, a WIDER
// one is not (a withdrawal at this exact stand cannot be undone by its own earlier packet).
// ============================================================

import {
  biddingContextKey, biddingProjectionMatches, parseBiddingProjection,
  type BiddingExpectedContext, type BiddingProjection, type BiddingRelease,
} from '@quiz/shared/bidding';

const RANK: Record<BiddingRelease, number> = { NEUTRAL: 0, STANDING: 1 };

export interface BiddingIntakeMemo {
  key: string;
  seenStateVersion: number;
  seenBiddingVersion: number;
  seenSequenceVersion: number;
  seenTurnNumber: number;
  /** release of the last accepted projection (null = none yet) */
  seenRelease: BiddingRelease | null;
  held: BiddingProjection | null;
}
export type BiddingIntakeOutcome = 'ACCEPTED' | 'NEUTRAL' | 'WITHDRAWN' | 'STALE';
export interface BiddingIntakeResult { memo: BiddingIntakeMemo; held: BiddingProjection | null; outcome: BiddingIntakeOutcome }

export const emptyBiddingMemo = (key: string): BiddingIntakeMemo => ({
  key, seenStateVersion: -1, seenBiddingVersion: -1, seenSequenceVersion: -1, seenTurnNumber: -1, seenRelease: null, held: null,
});

export function intakeBiddingProjection(prev: BiddingIntakeMemo | null, expected: BiddingExpectedContext, raw: unknown): BiddingIntakeResult {
  const key = biddingContextKey(expected);
  const base = prev !== null && prev.key === key ? prev : emptyBiddingMemo(key); // another context starts with empty knowledge
  const parsed = raw === null || raw === undefined ? null : parseBiddingProjection(raw);
  const observed = parsed !== null && parsed.ok && biddingProjectionMatches(parsed.projection, expected) ? parsed.projection : null;
  if (observed === null) {
    // no valid authorisation for THIS context right now: nothing shown or actionable survives, the version knowledge does
    return { memo: { ...base, held: null }, held: null, outcome: 'WITHDRAWN' };
  }
  const standing = observed.release === 'STANDING' ? observed : null;
  const older = observed.stateVersion < base.seenStateVersion
    || (standing !== null && (standing.biddingVersion < base.seenBiddingVersion || standing.sequenceVersion < base.seenSequenceVersion || standing.turnNumber < base.seenTurnNumber));
  const samePoint = observed.stateVersion === base.seenStateVersion
    && (standing === null || base.seenBiddingVersion < 0 // no standing seen yet: only the snapshot version can be the same point
      || (standing.biddingVersion === base.seenBiddingVersion && standing.sequenceVersion === base.seenSequenceVersion && standing.turnNumber === base.seenTurnNumber));
  const wider = samePoint && base.seenRelease !== null && RANK[observed.release] > RANK[base.seenRelease];
  if (older || wider) return { memo: base, held: base.held, outcome: 'STALE' };
  return {
    memo: {
      key, seenStateVersion: observed.stateVersion,
      seenBiddingVersion: standing === null ? base.seenBiddingVersion : standing.biddingVersion,
      seenSequenceVersion: standing === null ? base.seenSequenceVersion : standing.sequenceVersion,
      seenTurnNumber: standing === null ? base.seenTurnNumber : standing.turnNumber,
      seenRelease: observed.release, held: observed,
    },
    held: observed,
    outcome: observed.release === 'NEUTRAL' ? 'NEUTRAL' : 'ACCEPTED',
  };
}
