import { GameStateConflictError } from './state.js';

// Wire codes kept stable for existing clients; internal messages are never returned.
const PUBLIC_CODES = new Set([
  'ALREADY_ANSWERED', 'BUZZ_CLOSED', 'GAME_NOT_FOUND', 'INVALID_OPTION',
  'NO_QUESTIONS', 'NO_STEAL_WINNER', 'PHASE_NOT_BUZZ_LOCKED',
  'PHASE_NOT_BUZZ_OPEN', 'PHASE_NOT_FIELD_DONE', 'PHASE_NOT_STEAL_LOCKED',
  'PHASE_NOT_STEAL_OPEN', 'PLAYER_NOT_IN_GAME', 'STATE_CONFLICT',
  'TIME_EXPIRED',
  'INVALID_SETUP',
]);

export function gameErrorCode(error: unknown): string {
  if (error instanceof GameStateConflictError) return 'STATE_CONFLICT';
  if (!(error instanceof Error)) return 'INTERNAL_ERROR';
  if (error.message === 'ALREADY_CLAIMED') return 'BUZZER_ALREADY_WON';
  if (error.message === 'PLAYER_EXCLUDED') return 'ALREADY_ANSWERED';
  return PUBLIC_CODES.has(error.message) ? error.message : 'INTERNAL_ERROR';
}
