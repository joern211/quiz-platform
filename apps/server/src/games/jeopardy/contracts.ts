// ============================================================
// Jeopardy Game — Shared Contracts (Types & Events)
// Phase 3: State machine and shared types
// ============================================================

// ============================================================
// Phase enum
// ============================================================

export const JEOPARDY_PHASES = {
  INTRO: 'INTRO',
  SELECTING: 'SELECTING',
  BUZZ_OPEN: 'BUZZ_OPEN',
  BUZZ_LOCKED: 'BUZZ_LOCKED',
  STEAL_OPEN: 'STEAL_OPEN',
  STEAL_LOCKED: 'STEAL_LOCKED',
  FIELD_DONE: 'FIELD_DONE',
  BOARD_COMPLETE: 'BOARD_COMPLETE',
  GAME_END: 'GAME_END',
} as const;

export type JeopardyPhase = (typeof JEOPARDY_PHASES)[keyof typeof JEOPARDY_PHASES];

// ============================================================
// Valid phase transitions
// ============================================================

export const JEOPARDY_PHASE_TRANSITIONS: Record<JeopardyPhase, JeopardyPhase[]> = {
  [JEOPARDY_PHASES.INTRO]: [JEOPARDY_PHASES.SELECTING],
  [JEOPARDY_PHASES.SELECTING]: [JEOPARDY_PHASES.BUZZ_OPEN],
  [JEOPARDY_PHASES.BUZZ_OPEN]: [JEOPARDY_PHASES.BUZZ_LOCKED],
  [JEOPARDY_PHASES.BUZZ_LOCKED]: [
    JEOPARDY_PHASES.FIELD_DONE,    // correct → field done
    JEOPARDY_PHASES.STEAL_OPEN,    // wrong → steal round
    JEOPARDY_PHASES.FIELD_DONE,    // wrong + board complete → field done
  ],
  [JEOPARDY_PHASES.STEAL_OPEN]: [JEOPARDY_PHASES.STEAL_LOCKED],
  [JEOPARDY_PHASES.STEAL_LOCKED]: [JEOPARDY_PHASES.FIELD_DONE],
  [JEOPARDY_PHASES.FIELD_DONE]: [
    JEOPARDY_PHASES.SELECTING,       // more fields available
    JEOPARDY_PHASES.BOARD_COMPLETE,  // board exhausted
  ],
  [JEOPARDY_PHASES.BOARD_COMPLETE]: [JEOPARDY_PHASES.GAME_END],
  [JEOPARDY_PHASES.GAME_END]: [],
};

/**
 * Check if transitioning from `from` to `to` is valid.
 * Used in tests and guards; actual engine enforces transitions.
 */
export function isValidPhaseTransition(from: JeopardyPhase, to: JeopardyPhase): boolean {
  return JEOPARDY_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================================
// Point calculations (server-side, never client-side)
// ============================================================

/**
 * Full points for a correct first-answer.
 */
export function pointsForCorrect(value: number): number {
  return value;
}

/**
 * Penalty for a wrong first-answer: 50% of field value, rounded.
 */
export function pointsForWrongFirst(value: number): number {
  return -Math.round(value / 2);
}

/**
 * Points for a correct steal: 50% of field value, rounded.
 */
export function pointsForCorrectSteal(value: number): number {
  return Math.round(value / 2);
}

/**
 * Penalty for a wrong steal: 50% of field value, rounded (no further steal).
 */
export function pointsForWrongSteal(value: number): number {
  return -Math.round(value / 2);
}

// ============================================================
// Event types (socket.io payload shapes)
// ============================================================

// --- Server → Client events ---

/** Emitted after game start; opens the board. */
export interface JeopardyInitEvent {
  boardNumber: 1 | 2;
  categories: Array<{ name: string; clueCount: number }>;
  values: number[];
  scores: Record<string, number>;
}

/** A field on the board is now selectable. */
export interface JeopardyFieldOpenEvent {
  categoryIndex: number; // 0-based within current board (0–5)
  value: number;
  question: string;        // the clue (not the answer)
  mediaType?: string;
  mediaAssetId?: string;
}

/** A field is permanently unavailable (answered or board exhausted). */
export interface JeopardyFieldUnavailableEvent {
  categoryIndex: number;
  value: number;
}

/** Buzzer is now open — players may buzz. */
export interface JeopardyBuzzOpenEvent {
  /** True if this player was the first to buzz. */
  winnerId?: string;
}

/** A player buzzed first and is now locked in. */
export interface JeopardyBuzzLockedEvent {
  playerId: string;
  playerName: string;
}

/** Steal buzzer is now open. */
export interface JeopardyStealOpenEvent {
  // steal opens silently; winnerId sent on buzz
}

/** Steal buzzer winner is locked in. */
export interface JeopardyStealLockedEvent {
  playerId: string;
  playerName: string;
}

/** Reveal: answer and updated scores are broadcast after judgment. */
export interface JeopardyRevealEvent {
  answer: string;                              // only to moderator; players get masked
  correct: boolean;
  playerId: string;
  playerName: string;
  fieldValue: number;
  delta: number;
  scores: Record<string, number>;
}

/** Scores have changed (periodic or after a steal). */
export interface JeopardyScoresUpdateEvent {
  scores: Record<string, number>;
}

/** The field is done; board re-selectable. */
export interface JeopardyFieldDoneEvent {
  categoryIndex: number;
  value: number;
}

/** A board is complete; may switch to the other board or end. */
export interface JeopardyBoardCompleteEvent {
  boardNumber: 1 | 2;
  nextBoard: 1 | 2 | null; // null if game ends
}

/** Game has ended; final scores sent. */
export interface JeopardyGameEndEvent {
  finalScores: Array<{ playerId: string; playerName: string; score: number }>;
  winnerIds: string[];
}

// --- Client → Server events (payloads) ---

export interface JeopardyBuzzPayload {
  fieldCategoryIndex: number;
  fieldValue: number;
}

export interface JeopardyJudgePayload {
  correct: boolean;
  playerId: string;
}

export interface JeopardyStealBuzzPayload {
  fieldCategoryIndex: number;
  fieldValue: number;
}

export interface JeopardyStealJudgePayload {
  correct: boolean;
  playerId: string;
}
