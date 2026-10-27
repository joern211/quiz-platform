import { describe, expect, it } from 'vitest';
import { claimBuzzer, createBuzzerState, openBuzzer, resolveBuzzer, overrideBuzzerWinner, resetBuzzerState } from './buzzer.js';

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

    expect(first.state).toMatchObject({
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
    expect(resetBuzzerState()).toMatchObject({
      open: false,
      winnerId: null,
      excludedPlayerIds: [],
    });
  });
});

it('supports selected participants, team exclusion, reopen and auditable overrides', () => {
  const opened = openBuzzer(createBuzzerState(), { mode: 'TEAM', eligiblePlayerIds: ['a', 'b', 'c'], teamByPlayer: { a: 'red', b: 'red', c: 'blue' } });
  expect(claimBuzzer(opened, 'outsider', 10)).toMatchObject({ accepted: false, error: 'PLAYER_EXCLUDED' });
  const won = claimBuzzer(opened, 'a', 11);
  if (!won.accepted) throw new Error('NO_BUZZ');
  expect(won.state).toMatchObject({ status: 'LOCKED', fairness: 'SERVER_ARRIVAL', winnerTeamId: 'red', claimedAtMs: 11 });
  const corrected = overrideBuzzerWinner(won.state, 'c', { actorId: 'host', reason: 'Falscher Buzzer', atMs: 12 });
  expect(corrected).toMatchObject({ winnerId: 'c', winnerTeamId: 'blue', overrides: [{ actorId: 'host', fromPlayerId: 'a', toPlayerId: 'c', atMs: 12 }] });
  const resolved = resolveBuzzer(won.state, true);
  expect(resolved).toMatchObject({ status: 'RESOLVED', excludedPlayerIds: ['a', 'b'] });
  expect(() => overrideBuzzerWinner(resolved, 'c', { actorId: 'host', atMs: 13 })).toThrow('INVALID_PHASE');
  const reopened = openBuzzer(JSON.parse(JSON.stringify(resolved)), { excludePlayerIds: resolved.excludedPlayerIds });
  expect(claimBuzzer(reopened, 'b', 14)).toMatchObject({ accepted: false, error: 'PLAYER_EXCLUDED' });
  expect(claimBuzzer(reopened, 'c', 15)).toMatchObject({ accepted: true, state: { winnerTeamId: 'blue' } });
});
