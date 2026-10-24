import { GameStateConflictError } from './state.js';

// Wire codes kept stable for existing clients; internal messages are never returned.
const PUBLIC_CODES = new Set([
  'ALREADY_ANSWERED', 'BUZZ_CLOSED', 'GAME_NOT_FOUND', 'INVALID_OPTION',
  'NO_QUESTIONS', 'NO_STEAL_WINNER', 'PHASE_NOT_BUZZ_LOCKED',
  'PHASE_NOT_BUZZ_OPEN', 'PHASE_NOT_FIELD_DONE', 'PHASE_NOT_STEAL_LOCKED',
  'PHASE_NOT_STEAL_OPEN', 'PLAYER_NOT_IN_GAME', 'STATE_CONFLICT',
  'TIME_EXPIRED', 'INVALID_PHASE', 'INVALID_TIMER_STATE', 'TIMER_NOT_RUNNING',
  'TIMER_NOT_PAUSED', 'INVALID_TIMER_DURATION', 'INVALID_TIMER_CHANGE',
  'SUBMISSION_NOT_JUDGEABLE', 'JUDGE_DECISION_UNSUPPORTED',
  'INVALID_GAME_STATE', 'COMMAND_UNSUPPORTED', 'GAME_NOT_RUNNING',
  'PLAYER_NOT_IN_ROUND', 'JOKER_ALREADY_USED', 'NOT_ALL_ANSWERED',
  'PHASE_NOT_SELECTING', 'PHASE_NOT_BOARD_COMPLETE', 'FORBIDDEN', 'WRONG_GAME',
  'TURN_OWNER_CONFLICT', 'INVALID_ROUND_INDEX', 'INVALID_SCORE', 'ANSWER_TOO_LONG',
  'STATE_INVARIANT_FAILED',
  'INVALID_SETUP',
  // PR11-Nacharbeit D: persistierter State von einer Engine-Version, die
  // dieser Reader nicht exakt versteht → kontrollierte Ablehnung (kein
  // falscher State, kein crash).
  'UNSUPPORTED_ENGINE_VERSION',
  'COMMAND_OWNERSHIP_LOST', 'REVISION_CONFLICT', 'CONFIG_SNAPSHOT_INVALID', 'COMMAND_STATE_ADVANCED',
]);

export function gameErrorCode(error: unknown): string {
  if (error instanceof GameStateConflictError) return 'STATE_CONFLICT';
  if (!(error instanceof Error)) return 'INTERNAL_ERROR';
  if (error.message === 'ALREADY_CLAIMED') return 'BUZZER_ALREADY_WON';
  if (error.message === 'PLAYER_EXCLUDED') return 'ALREADY_ANSWERED';
  return PUBLIC_CODES.has(error.message) ? error.message : 'INTERNAL_ERROR';
}
