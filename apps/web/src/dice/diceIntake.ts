// ============================================================
// N9 — Intake of dice projections: binding, version knowledge per ordering level, withdrawal (pure, no React, no DOM)
//
// Two things are kept apart, as in N6, N7 and N8:
//   seen* — the minimal VERSION KNOWLEDGE of one context: one NUMBER per ordering level — the global snapshot version, the current N8 sequence
//           version, the identity of the N8 turn, and (inside one turn) the dice version and the roll number. Numbers only; they survive
//           withdrawal, null, undefined and invalid views.
//   held  — what may be shown and acted on right now (the validated projection). Gone on every withdrawal.
// A projection is only an observation if it is strictly valid, belongs to the expected context (scope AND recipient) and is not older than the
// caller's INDEPENDENT `minStateVersion` (from its own snapshot channel, never from the incoming packet). Invalid, foreign or too-old input never
// moves any `seen*` (no poisoning with a huge unchecked number).
//
// The context is the SEQUENCE (run, sequence, roster revision, unit, recipient), NOT one dice process: every N8 turn brings a NEW process (new
// `diceId`, local counters restart) into the same context, and the knowledge about older turns stays. That is what refuses "A turn 1 → B turn 2 →
// A turn 3 → a late packet of A's turn 1": the turn number is older than what was seen, whatever the local dice counters say.
//   - stateVersion, sequenceVersion, turnNumber: monotonic for the whole context.
//   - diceVersion, rollCount: monotonic WITHIN one turn only (a higher turn is a new process); a packet of the same turn with another `diceId` is
//     foreign (the server runs one process per turn) and is ignored without moving anything.
// A newer valid view WITHOUT visible values (release NONE) still raises the knowledge. At the very same stand a re-delivery with the same or a
// narrower release is accepted, a WIDER one is not (a withdrawal at this exact stand cannot be undone by its own earlier packet).
// A single context slot: another run, sequence, roster revision, unit or recipient starts with empty knowledge (no archive of old contexts).
// ============================================================

import {
  diceContextKey, diceProjectionMatches, parseDiceProjection,
  type DiceExpectedContext, type DiceProjection, type DiceRelease,
} from '@quiz/shared/dice';

const RANK: Record<DiceRelease, number> = { NONE: 0, VALUES: 1 };

export interface DiceIntakeMemo {
  key: string;
  seenStateVersion: number;
  seenSequenceVersion: number;
  seenTurnNumber: number;
  /** the process of the highest observed turn (null = none yet) */
  seenDiceId: string | null;
  seenDiceVersion: number;
  seenRollCount: number;
  /** release of the last accepted projection (null = none yet) */
  seenRelease: DiceRelease | null;
  held: DiceProjection | null;
}
export type DiceIntakeOutcome = 'ACCEPTED' | 'RELEASE_NONE' | 'WITHDRAWN' | 'STALE';
export interface DiceIntakeResult { memo: DiceIntakeMemo; held: DiceProjection | null; outcome: DiceIntakeOutcome }

export const emptyDiceMemo = (key: string): DiceIntakeMemo => ({
  key, seenStateVersion: -1, seenSequenceVersion: -1, seenTurnNumber: -1, seenDiceId: null, seenDiceVersion: -1, seenRollCount: -1, seenRelease: null, held: null,
});

export function intakeDiceProjection(prev: DiceIntakeMemo | null, expected: DiceExpectedContext, raw: unknown): DiceIntakeResult {
  const key = diceContextKey(expected);
  const base = prev !== null && prev.key === key ? prev : emptyDiceMemo(key); // another context starts with empty knowledge
  const parsed = raw === null || raw === undefined ? null : parseDiceProjection(raw);
  const observed = parsed !== null && parsed.ok && diceProjectionMatches(parsed.projection, expected) ? parsed.projection : null;
  if (observed === null) {
    // no valid authorisation for THIS context right now: nothing shown or actionable survives, the version knowledge does
    return { memo: { ...base, held: null }, held: null, outcome: 'WITHDRAWN' };
  }
  const sameTurn = observed.turnNumber === base.seenTurnNumber;
  // the server runs one process per N8 turn: another process id inside a turn we already know is not a newer view of it — ignore it, move nothing
  const foreign = sameTurn && base.seenDiceId !== null && observed.diceId !== base.seenDiceId;
  const older = observed.stateVersion < base.seenStateVersion || observed.sequenceVersion < base.seenSequenceVersion || observed.turnNumber < base.seenTurnNumber
    || (sameTurn && (observed.diceVersion < base.seenDiceVersion || observed.rollCount < base.seenRollCount));
  const samePoint = sameTurn && observed.stateVersion === base.seenStateVersion && observed.sequenceVersion === base.seenSequenceVersion
    && observed.diceVersion === base.seenDiceVersion && observed.rollCount === base.seenRollCount;
  const wider = samePoint && base.seenRelease !== null && RANK[observed.release] > RANK[base.seenRelease];
  if (foreign || older || wider) return { memo: base, held: base.held, outcome: 'STALE' };
  const held = observed.release === 'NONE' ? null : observed;
  return {
    memo: {
      key, seenStateVersion: observed.stateVersion, seenSequenceVersion: observed.sequenceVersion, seenTurnNumber: observed.turnNumber, seenDiceId: observed.diceId,
      seenDiceVersion: observed.diceVersion, seenRollCount: observed.rollCount, seenRelease: observed.release, held,
    },
    held,
    outcome: held === null ? 'RELEASE_NONE' : 'ACCEPTED',
  };
}
