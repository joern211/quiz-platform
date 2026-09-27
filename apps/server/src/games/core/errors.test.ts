import { describe, expect, it } from 'vitest';
import { GameStateConflictError } from './state.js';
import { gameErrorCode } from './errors.js';

describe('game error mapping', () => {
  it('returns a revision conflict without leaking internal details', () => {
    expect(gameErrorCode(new GameStateConflictError('private-room-id'))).toBe('STATE_CONFLICT');
    expect(gameErrorCode(new Error('database credentials or internal path'))).toBe('INTERNAL_ERROR');
  });

  it('keeps the existing buzzer client code', () => {
    expect(gameErrorCode(new Error('ALREADY_CLAIMED'))).toBe('BUZZER_ALREADY_WON');
    expect(gameErrorCode(new Error('PLAYER_EXCLUDED'))).toBe('ALREADY_ANSWERED');
  });
});
