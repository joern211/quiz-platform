// ============================================================
// N8 — Intake of turn projections: binding, version knowledge per ordering level, withdrawal (pure, no React, no DOM)
//
// Two things are kept apart, as in N6 and N7:
//   seen* — the minimal VERSION KNOWLEDGE of one context, one NUMBER per ordering level: the global snapshot version, the local
//           sequence version, the identity of the current turn and the entitlement revision. Numbers (and the strictest release at that
//           exact stand) only; they survive withdrawal, null, undefined and invalid views.
//   held  — what may be shown and acted on right now (the validated projection). Gone on every withdrawal.
// A projection is only an observation if it is strictly valid, belongs to the expected context (scope AND recipient) and is not older than
// the caller's INDEPENDENT `minStateVersion` (taken from its own snapshot channel, never from the incoming packet). Invalid, foreign or
// too-old input never moves any `seen*` (no poisoning with a huge unchecked number).
//
// Every ordering level protects on its own, not only the snapshot version: a packet older than what was observed in ANY level is stale and
// ignored, so it can restore neither a holder nor an action after a newer withdrawal (turn 9 → null → turn 8), nor after a newer lock
// (HELD v12 → ACTIVE v11), nor after the same player's later turn (A turn 4 → feedback of A's turn 1). A newer valid view WITHOUT a
// visible holder (release NONE, NO_ELIGIBLE, CLOSED) still raises the knowledge. At the very same stand a re-delivery with the same or a
// narrower release is accepted, a WIDER one is not (a withdrawal at this exact stand cannot be undone by its own earlier packet).
// A single context slot: another run, sequence, roster revision, unit or recipient starts with empty knowledge (no archive of old contexts).
// ============================================================

import {
  parseTurnSequenceProjection, turnSequenceContextKey, turnSequenceProjectionMatches,
  type TurnSequenceExpectedContext, type TurnSequenceProjection, type TurnSequenceRelease,
} from '@quiz/shared/turnSequence';

const RANK: Record<TurnSequenceRelease, number> = { NONE: 0, CURRENT: 1, ORDER: 2 };

export interface TurnIntakeMemo {
  key: string;
  seenStateVersion: number;
  seenSequenceVersion: number;
  seenTurnNumber: number;
  seenEntitlement: number;
  /** release of the last accepted projection (null = none yet) */
  seenRelease: TurnSequenceRelease | null;
  held: TurnSequenceProjection | null;
}
export type TurnIntakeOutcome = 'ACCEPTED' | 'RELEASE_NONE' | 'WITHDRAWN' | 'STALE';
export interface TurnIntakeResult { memo: TurnIntakeMemo; held: TurnSequenceProjection | null; outcome: TurnIntakeOutcome }

export const emptyTurnMemo = (key: string): TurnIntakeMemo => ({ key, seenStateVersion: -1, seenSequenceVersion: -1, seenTurnNumber: -1, seenEntitlement: -1, seenRelease: null, held: null });

export function intakeTurnSequence(prev: TurnIntakeMemo | null, expected: TurnSequenceExpectedContext, raw: unknown): TurnIntakeResult {
  const key = turnSequenceContextKey(expected);
  const base = prev !== null && prev.key === key ? prev : emptyTurnMemo(key); // another context starts with empty knowledge
  const parsed = raw === null || raw === undefined ? null : parseTurnSequenceProjection(raw);
  const observed = parsed !== null && parsed.ok && turnSequenceProjectionMatches(parsed.projection, expected) ? parsed.projection : null;
  if (observed === null) {
    // no valid authorisation for THIS context right now: nothing shown or actionable survives, the version knowledge does
    return { memo: { ...base, held: null }, held: null, outcome: 'WITHDRAWN' };
  }
  const older = observed.stateVersion < base.seenStateVersion || observed.sequenceVersion < base.seenSequenceVersion
    || observed.turnNumber < base.seenTurnNumber || observed.entitlementRevision < base.seenEntitlement;
  const samePoint = observed.stateVersion === base.seenStateVersion && observed.sequenceVersion === base.seenSequenceVersion
    && observed.turnNumber === base.seenTurnNumber && observed.entitlementRevision === base.seenEntitlement;
  const wider = samePoint && base.seenRelease !== null && RANK[observed.release] > RANK[base.seenRelease];
  if (older || wider) return { memo: base, held: base.held, outcome: 'STALE' };
  const held = observed.release === 'NONE' ? null : observed;
  return {
    memo: {
      key, seenStateVersion: observed.stateVersion, seenSequenceVersion: observed.sequenceVersion, seenTurnNumber: observed.turnNumber,
      seenEntitlement: observed.entitlementRevision, seenRelease: observed.release, held,
    },
    held,
    outcome: held === null ? 'RELEASE_NONE' : 'ACCEPTED',
  };
}
