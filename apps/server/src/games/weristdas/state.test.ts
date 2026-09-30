import { describe, expect, it } from 'vitest';
import { activateHint, buzz, createWerIstDasState, judge, nextRound, openRoundBuzzer, revealRound } from './state.js';

describe('Wer ist das? rules', () => {
  const initial = () => createWerIstDasState(2, { alice: 'Alice', bob: 'Bob' });

  it('opens the shared buzzer, locks the first claim and scores both names', () => {
    const ready = initial();
    expect(ready.scores).toEqual({ alice: 0, bob: 0 });
    const open = openRoundBuzzer(ready);
    const claimed = buzz(open, 'alice');
    expect(claimed.buzzer).toMatchObject({ open: false, winnerId: 'alice' });
    expect(() => buzz(claimed, 'bob')).toThrow('INVALID_PHASE');
    const result = judge(claimed, 'BOTH_CORRECT');
    expect(result.delta).toBe(3);
    expect(result.state).toMatchObject({ phase: 'REVEAL', revealed: true, scores: { alice: 3, bob: 0 } });
    const next = nextRound(result.state, 'round1');
    expect(next).toMatchObject({ phase: 'ROUND_READY', roundIndex: 1, hintActive: false,
      revealed: false, playedRoundIds: ['round1'], scores: { alice: 3, bob: 0 } });
    expect(next.buzzer.excludedPlayerIds).toEqual([]);
  });

  it('penalizes and excludes wrong answers until the next round', () => {
    const first = buzz(openRoundBuzzer(initial()), 'alice');
    const wrong = judge(first, 'WRONG').state;
    expect(wrong.scores.alice).toBe(-1);
    expect(wrong.buzzer.excludedPlayerIds).toEqual(['alice']);
    const open = openRoundBuzzer(wrong);
    expect(() => buzz(open, 'alice')).toThrow('PLAYER_EXCLUDED');
    expect(buzz(open, 'bob').buzzer.winnerId).toBe('bob');
  });

  it('requires an active hint for one correct name and reveals after +1', () => {
    const claimed = buzz(openRoundBuzzer(initial()), 'alice');
    expect(() => judge(claimed, 'ONE_CORRECT')).toThrow('HINT_REQUIRED');
    const hinted = activateHint(claimed);
    expect(judge(hinted, 'ONE_CORRECT').state.scores.alice).toBe(1);
    expect(judge(hinted, 'BOTH_CORRECT').state.scores.alice).toBe(3);
  });

  it('allows an unsolved round to be revealed with no winner', () => {
    const result = revealRound(openRoundBuzzer(initial()));
    expect(result).toMatchObject({ phase: 'REVEAL', revealed: true, solvedBy: null });
    expect(result.buzzer.open).toBe(false);
  });
});
