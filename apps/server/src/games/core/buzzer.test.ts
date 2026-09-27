import { describe, expect, it } from 'vitest';
import { claimBuzzer, createBuzzerState, openBuzzer, resetBuzzerState } from './buzzer.js';

describe('shared buzzer core', () => {
  it('rejects buzzes while closed', () => {
    const result = claimBuzzer(createBuzzerState(), 'p1');
    expect(result).toMatchObject({ accepted: false, error: 'BUZZ_CLOSED' });
  });

  it('atomically models first valid winner', () => {
    const opened = openBuzzer(createBuzzerState());
    const first = claimBuzzer(opened, 'p1');
    expect(first).toMatchObject({ accepted: true });
    if (!first.accepted) throw new Error('expected accepted buzz');

    expect(first.state).toEqual({
      open: false,
      winnerId: 'p1',
      excludedPlayerIds: [],
    });

    const second = claimBuzzer(first.state, 'p2');
    expect(second).toMatchObject({ accepted: false, error: 'BUZZ_CLOSED' });
  });

  it('rejects excluded players for steal/rebuzz scenarios', () => {
    const opened = openBuzzer(createBuzzerState(), { excludePlayerIds: ['p1'] });
    expect(claimBuzzer(opened, 'p1')).toMatchObject({
      accepted: false,
      error: 'PLAYER_EXCLUDED',
    });
    expect(claimBuzzer(opened, 'p2')).toMatchObject({ accepted: true });
  });

  it('resets all winner and exclusion state', () => {
    const won = claimBuzzer(openBuzzer(createBuzzerState(), { excludePlayerIds: ['p2'] }), 'p1');
    if (!won.accepted) throw new Error('expected accepted buzz');
    expect(resetBuzzerState()).toEqual({
      open: false,
      winnerId: null,
      excludedPlayerIds: [],
    });
  });
});
