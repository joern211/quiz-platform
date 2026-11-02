import { describe, expect, it, vi } from 'vitest';
import { DICE_CONFIG_FIVE_D6_HOLD, DICE_MAX_COUNTER } from '@quiz/shared/dice';
import { diceActionArgsFromIntent, openDiceTurn, readDiceRollIntent, rollDice, type DiceTurnState } from './diceTurn.js';
import { prepareTurnSequence, startTurnSequence, turnSequenceScopeOf, type TurnEligibility } from './turnSequence.js';

function fixture(runIndex: number, sequenceId: string, diceId: string) {
  const eligibility: TurnEligibility = { actors: { runIndex, trackId: 'track', rosterRevision: 'track-roster', version: 1, knownIds: ['a', 'b'], activeIds: ['a', 'b'] }, members: null };
  const p = prepareTurnSequence({ runIndex, sequenceId, rosterRevision: 'roster', unit: 'PLAYER', mode: 'FIXED', order: ['a', 'b'] });
  const sequence = startTurnSequence(p, { scope: turnSequenceScopeOf(p), expectedVersion: 0, eligibility }).state;
  const dice = openDiceTurn({ scope: turnSequenceScopeOf(sequence), diceId, config: DICE_CONFIG_FIVE_D6_HOLD, sequence, expectedTurnNumber: sequence.turnNumber });
  return { sequence, dice, eligibility };
}
// N9-01 FIX (independent reproductions adapted to the extended contract — expectations unchanged): the intent now carries the ORIGIN it was made for (target + counters),
// taken from the world the user LOOKED AT; the adapter derives the origin arguments from the INTENT, never from the loaded state.
const intentOf = (r: ReturnType<typeof fixture>) => readDiceRollIntent({
  scope: turnSequenceScopeOf(r.sequence), diceId: r.dice.diceId,
  turnNumber: r.sequence.turnNumber, sequenceVersion: r.sequence.version, diceVersion: r.dice.version, rollCount: r.dice.rollCount,
});

// Adapter wiring: origin from the parsed client intent; sequence, caller, gate and eligibility from the loaded / trusted state.
function deliver(r: ReturnType<typeof fixture>, intent: ReturnType<typeof intentOf>, source = vi.fn(() => 4)) {
  return rollDice(r.dice, {
    ...diceActionArgsFromIntent(intent), sequence: r.sequence,
    caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: r.eligibility, source,
  });
}

describe('Independent N9 review', () => {
  it.each([
    ['another run', 2, 'seq-new'],
    ['another sequence within the same run', 1, 'seq-new'],
  ] as const)('a delayed, never-applied roll of an old process must not roll a new process in %s', (_name, runIndex, sequenceId) => {
    const old = fixture(1, 'seq-old', 'dice-old');
    const current = fixture(runIndex, sequenceId, 'dice-new');
    const delayed = intentOf(old); // request was prepared, but did NOT reach the server or get a receipt
    expect(delayed.turnNumber).toBe(intentOf(current).turnNumber); // identical local counters: only the origin tells the two apart
    const fresh = intentOf(current);
    expect(deliver(current, fresh).state.rollCount).toBe(1); // positive control: current recipient may roll
    const draws = vi.fn(() => 4);
    expect(() => deliver(current, delayed, draws)).toThrow(/TURN_SEQ_(RUN|SEQUENCE)_STALE/);
    expect(draws).not.toHaveBeenCalled();
  });

  it('the current counter limit is rejected before any random draw (N9-03)', () => {
    const r = fixture(1, 'seq-limit', 'dice-limit');
    const rolled = deliver(r, intentOf(r)).state;
    // Reachable through repeated hold/unhold changes; parsing explicitly accepts this counter value.
    const atLimit: DiceTurnState = { ...rolled, version: DICE_MAX_COUNTER };
    const source = vi.fn(() => 2);
    expect(() => deliver({ ...r, dice: atLimit }, intentOf({ ...r, dice: atLimit }), source)).toThrow('DICE_COUNTER_LIMIT');
    expect(source).not.toHaveBeenCalled();
  });
});
