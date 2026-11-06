// ============================================================
// N11 — Intake of board projections: binding, version knowledge per ordering level, withdrawal (pure, no React, no DOM)
//
// Two things are kept apart, as in N6–N10:
//   seen* — the minimal VERSION KNOWLEDGE of one context: one NUMBER per ordering level — the global snapshot version, the current N8 sequence version, the
//           identity of the N8 turn, the board version and (inside one turn) the dice version and roll number of the shown roll. Numbers only; they survive
//           withdrawal, null, undefined, empty (release NONE) and invalid views.
//   held  — what may be shown and acted on right now (the validated projection). Gone on every withdrawal and on every release NONE.
// A projection is only an observation if it is strictly valid, belongs to the expected context (scope, board AND recipient) and is not older than the caller's
// INDEPENDENT `minStateVersion` (from its own snapshot channel, never from the incoming packet). Invalid, foreign or too-old input never moves any `seen*`.
//
// The context is the BOARD of one sequence (run, sequence, roster revision, unit, board, recipient); the board outlives turns, so every turn brings a new roll
// (new `diceId`) into the same context and the knowledge about older turns stays:
//   - stateVersion, sequenceVersion, turnNumber, boardVersion: monotonic for the whole context.
//   - diceVersion, rollCount: monotonic WITHIN one turn only; a packet of the same turn whose roll names ANOTHER process is foreign (one process per turn) and is
//     ignored without moving anything.
// A newer valid view WITHOUT figures (release NONE) still raises the knowledge. At the very same stand a re-delivery with the same or a narrower release is
// accepted, a WIDER one is not (a withdrawal at this exact stand cannot be undone by its own earlier packet). A single context slot: another run, sequence,
// roster revision, unit, board or recipient starts with empty knowledge.
// ============================================================

import { boardContextKey, boardProjectionMatches, parseBoardProjection, type BoardExpectedContext, type BoardProjection, type BoardRelease } from '@quiz/shared/board';

const RANK: Record<BoardRelease, number> = { NONE: 0, FIGURES: 1 };

export interface BoardIntakeMemo {
  key: string;
  seenStateVersion: number;
  seenSequenceVersion: number;
  seenTurnNumber: number;
  seenBoardVersion: number;
  /** the roll process of the highest observed turn (null = none yet) */
  seenDiceId: string | null;
  seenDiceVersion: number;
  seenRollCount: number;
  /** release of the last accepted projection (null = none yet) */
  seenRelease: BoardRelease | null;
  held: BoardProjection | null;
}
export type BoardIntakeOutcome = 'ACCEPTED' | 'RELEASE_NONE' | 'WITHDRAWN' | 'STALE';
export interface BoardIntakeResult { memo: BoardIntakeMemo; held: BoardProjection | null; outcome: BoardIntakeOutcome }

export const emptyBoardMemo = (key: string): BoardIntakeMemo => ({
  key, seenStateVersion: -1, seenSequenceVersion: -1, seenTurnNumber: -1, seenBoardVersion: -1, seenDiceId: null, seenDiceVersion: -1, seenRollCount: -1, seenRelease: null, held: null,
});

export function intakeBoardProjection(prev: BoardIntakeMemo | null, expected: BoardExpectedContext, raw: unknown): BoardIntakeResult {
  const key = boardContextKey(expected);
  const base = prev !== null && prev.key === key ? prev : emptyBoardMemo(key); // another context starts with empty knowledge
  const parsed = raw === null || raw === undefined ? null : parseBoardProjection(raw);
  const observed = parsed !== null && parsed.ok && boardProjectionMatches(parsed.projection, expected) ? parsed.projection : null;
  if (observed === null) {
    // no valid authorisation for THIS context right now: nothing shown or actionable survives, the version knowledge does
    return { memo: { ...base, held: null }, held: null, outcome: 'WITHDRAWN' };
  }
  const sameTurn = observed.turnNumber === base.seenTurnNumber;
  const roll = observed.release === 'FIGURES' ? observed.roll : null;
  const foreign = sameTurn && roll !== null && base.seenDiceId !== null && roll.diceId !== base.seenDiceId;
  const older = observed.stateVersion < base.seenStateVersion || observed.sequenceVersion < base.seenSequenceVersion || observed.turnNumber < base.seenTurnNumber
    || observed.boardVersion < base.seenBoardVersion
    || (sameTurn && roll !== null && base.seenDiceId === roll.diceId && (roll.diceVersion < base.seenDiceVersion || roll.rollCount < base.seenRollCount));
  const samePoint = sameTurn && observed.stateVersion === base.seenStateVersion && observed.sequenceVersion === base.seenSequenceVersion && observed.boardVersion === base.seenBoardVersion;
  const wider = samePoint && base.seenRelease !== null && RANK[observed.release] > RANK[base.seenRelease];
  if (foreign || older || wider) return { memo: base, held: base.held, outcome: 'STALE' };
  const held = observed.release === 'NONE' ? null : observed;
  const keepRoll = sameTurn && roll === null; // a view without a roll (or without figures) inside a known turn does not forget which process was seen
  return {
    memo: {
      key, seenStateVersion: observed.stateVersion, seenSequenceVersion: observed.sequenceVersion, seenTurnNumber: observed.turnNumber, seenBoardVersion: observed.boardVersion,
      seenDiceId: roll !== null ? roll.diceId : keepRoll ? base.seenDiceId : null,
      seenDiceVersion: roll !== null ? (sameTurn && base.seenDiceId === roll.diceId ? Math.max(base.seenDiceVersion, roll.diceVersion) : roll.diceVersion) : keepRoll ? base.seenDiceVersion : -1,
      seenRollCount: roll !== null ? (sameTurn && base.seenDiceId === roll.diceId ? Math.max(base.seenRollCount, roll.rollCount) : roll.rollCount) : keepRoll ? base.seenRollCount : -1,
      seenRelease: observed.release, held,
    },
    held,
    outcome: held === null ? 'RELEASE_NONE' : 'ACCEPTED',
  };
}
