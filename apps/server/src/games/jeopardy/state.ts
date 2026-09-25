// ============================================================
// Jeopardy Game — State Machine
// Phase 3: Immutable-style state + helpers
// ============================================================

import {
  JeopardyPhase,
  JEOPARDY_PHASES,
  isValidPhaseTransition,
  pointsForWrongFirst,
  pointsForCorrectSteal,
  pointsForWrongSteal,
} from './contracts.js';

// ============================================================
// Field key helpers
// ============================================================

/** Unique key for a board field: `${boardNumber}-${categoryIndex}-${value}` */
export function fieldKey(board: 1 | 2, categoryIndex: number, value: number): string {
  return `${board}-${categoryIndex}-${value}`;
}

export function parseFieldKey(key: string): { board: 1 | 2; categoryIndex: number; value: number } {
  const [b, ci, v] = key.split('-').map(Number);
  return { board: b as 1 | 2, categoryIndex: ci, value: v };
}

// ============================================================
// Board structure
// ============================================================

export interface JeopardyFieldState {
  answered: boolean;
  /** Player who answered correctly (null if unanswered or wrong). */
  answeredBy: string | null;
  /** Points delta applied (negative for wrong). */
  pointsDelta: number;
  /** Was this field attempted as a steal? */
  stealAttempted: boolean;
  /** Player who won the steal (null if no steal or wrong steal). */
  stealBy: string | null;
}

export interface JeopardyBoard {
  categories: Array<{
    name: string;
    clues: Array<{ value: number; question: string; answer: string }>;
  }>;
}

export interface JeopardyFieldDef {
  categoryIndex: number; // 0–5
  value: number;
  question: string;
  answer: string;
  mediaType?: string;
  mediaAssetId?: string;
}

// ============================================================
// Full game state
// ============================================================

export interface JeopardyGameState {
  /** Current board (1 or 2). */
  currentBoard: 1 | 2;

  /** Which board has been completed (true = no more open fields). */
  boardsCompleted: [boolean, boolean]; // [board1, board2]

  /**
   * Open fields remaining on each board.
   * Key = `boardNumber-categoryIndex-value` (string).
   * Value = full field metadata (no secrets exposed to client).
   */
  openFields: Record<string, JeopardyFieldState>;

  /**
   * The currently selected (active) field, if any.
   * null when no field is active (e.g. in SELECTING phase).
   */
  currentField: {
    categoryIndex: number;
    value: number;
    fieldDef: JeopardyFieldDef;
  } | null;

  /** Current game phase. */
  phase: JeopardyPhase;

  /** Buzzer state. */
  buzzOpen: boolean;
  buzzWinner: string | null;

  /** Steal buzzer state. */
  stealOpen: boolean;
  stealWinner: string | null;

  /** Player scores keyed by participationId. */
  scores: Record<string, number>;

  /**
   * Player display names (participationId → name).
   * Stored at game init; used for broadcast events.
   */
  playerNames: Record<string, string>;
}

// ============================================================
// State factory
// ============================================================

export function createJeopardyGameState(
  currentBoard: 1 | 2,
  playerIds: string[],
  playerNames: Record<string, string>,
  initialScores: Record<string, number> = {}
): JeopardyGameState {
  const scores: Record<string, number> = { ...initialScores };
  for (const id of playerIds) {
    if (scores[id] === undefined) scores[id] = 0;
  }

  return {
    currentBoard,
    boardsCompleted: [false, false],
    openFields: {},
    currentField: null,
    phase: JEOPARDY_PHASES.INTRO,
    buzzOpen: false,
    buzzWinner: null,
    stealOpen: false,
    stealWinner: null,
    scores,
    playerNames,
  };
}

// ============================================================
// Phase transition helper
// ============================================================

/**
 * Transition the state to a new phase, if the transition is valid.
 * Returns the updated state (new object) or throws on invalid transition.
 */
export function transitionPhase(
  state: JeopardyGameState,
  newPhase: JeopardyPhase
): JeopardyGameState {
  if (!isValidPhaseTransition(state.phase, newPhase)) {
    throw new Error(
      `Invalid phase transition: ${state.phase} → ${newPhase}`
    );
  }
  return { ...state, phase: newPhase };
}

// ============================================================
// Field helpers
// ============================================================

/**
 * Mark a field as answered (correct or wrong).
 * Stores answer metadata but does NOT update scores here;
 * score updates are done via scoreDelta().
 */
export function markFieldAnswered(
  state: JeopardyGameState,
  categoryIndex: number,
  value: number,
  answeredBy: string,
  correct: boolean,
  delta: number
): JeopardyGameState {
  const key = fieldKey(state.currentBoard, categoryIndex, value);
  const field: JeopardyFieldState = {
    answered: true,
    answeredBy: correct ? answeredBy : null,
    pointsDelta: delta,
    stealAttempted: false,
    stealBy: null,
  };

  // Remove from open fields
  const { [key]: _, ...remainingOpenFields } = state.openFields;

  return {
    ...state,
    openFields: remainingOpenFields,
    currentField: null,
    buzzOpen: false,
    buzzWinner: null,
  };
}

/**
 * Mark a field as attempted for steal (answered wrong, steal opened).
 */
export function markStealAttempted(
  state: JeopardyGameState,
  categoryIndex: number,
  value: number,
  stealBy: string | null
): JeopardyGameState {
  const key = fieldKey(state.currentBoard, categoryIndex, value);
  const existing = state.openFields[key];
  if (!existing) return state;

  return {
    ...state,
    openFields: {
      ...state.openFields,
      [key]: {
        ...existing,
        stealAttempted: true,
        stealBy,
      },
    },
  };
}

/**
 * Check how many open fields remain on a given board.
 */
export function countOpenFields(state: JeopardyGameState, board: 1 | 2): number {
  return Object.keys(state.openFields).filter((k) => k.startsWith(`${board}-`)).length;
}

/**
 * Check if a board is fully exhausted.
 */
export function isBoardComplete(state: JeopardyGameState, board: 1 | 2): boolean {
  return countOpenFields(state, board) === 0;
}

/**
 * Add a field to the openFields map.
 * Called at game init when populating the board.
 */
export function registerField(
  state: JeopardyGameState,
  board: 1 | 2,
  categoryIndex: number,
  value: number,
  fieldDef: JeopardyFieldDef
): JeopardyGameState {
  const key = fieldKey(board, categoryIndex, value);
  return {
    ...state,
    openFields: {
      ...state.openFields,
      [key]: {
        answered: false,
        answeredBy: null,
        pointsDelta: 0,
        stealAttempted: false,
        stealBy: null,
      },
    },
  };
}

// ============================================================
// Score helpers
// ============================================================

/**
 * Apply a score delta to a player. Returns new scores object.
 */
export function applyScoreDelta(
  scores: Record<string, number>,
  playerId: string,
  delta: number
): Record<string, number> {
  return {
    ...scores,
    [playerId]: (scores[playerId] ?? 0) + delta,
  };
}

/**
 * Score delta for a wrong first answer (50% penalty).
 */
export function calcWrongFirstDelta(value: number): number {
  return pointsForWrongFirst(value);
}

/**
 * Score delta for a correct steal (50% of value).
 */
export function calcCorrectStealDelta(value: number): number {
  return pointsForCorrectSteal(value);
}

/**
 * Score delta for a wrong steal (50% penalty; no further steal).
 */
export function calcWrongStealDelta(value: number): number {
  return pointsForWrongSteal(value);
}

// ============================================================
// Buzzer helpers
// ============================================================

/**
 * Open buzzer: first to buzz wins.
 */
export function openBuzzer(state: JeopardyGameState): JeopardyGameState {
  return {
    ...state,
    buzzOpen: true,
    buzzWinner: null,
  };
}

/**
 * Lock buzzer: record the winner and close buzzer.
 */
export function lockBuzzer(state: JeopardyGameState, winnerId: string): JeopardyGameState {
  return {
    ...state,
    buzzOpen: false,
    buzzWinner: winnerId,
  };
}

/**
 * Reset buzzer state (for next field).
 */
export function resetBuzzer(state: JeopardyGameState): JeopardyGameState {
  return {
    ...state,
    buzzOpen: false,
    buzzWinner: null,
    stealOpen: false,
    stealWinner: null,
  };
}

/**
 * Open steal buzzer after wrong first answer.
 */
export function openStealBuzzer(state: JeopardyGameState): JeopardyGameState {
  return {
    ...state,
    stealOpen: true,
    stealWinner: null,
    buzzOpen: false,
  };
}

/**
 * Lock steal buzzer.
 */
export function lockStealBuzzer(state: JeopardyGameState, winnerId: string): JeopardyGameState {
  return {
    ...state,
    stealOpen: false,
    stealWinner: winnerId,
  };
}

// ============================================================
// Board switch helpers
// ============================================================

/**
 * Switch to the other board when one is exhausted.
 */
export function switchToBoard(state: JeopardyGameState, newBoard: 1 | 2): JeopardyGameState {
  return {
    ...state,
    currentBoard: newBoard,
    currentField: null,
    ...resetBuzzer({} as JeopardyGameState), // keep buzzer reset
    buzzOpen: false,
    buzzWinner: null,
    stealOpen: false,
    stealWinner: null,
  };
}
