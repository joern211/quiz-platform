import { expect, it } from 'vitest';
import { coreLifecyclePhase } from './lifecycle.js';
import { prepareRoundRuntime, transitionRoundState } from './roundTransition.js';

it('maps real subphases and preserves the distinction between preparing and reopening a WID round', () => {
  expect(coreLifecyclePhase('geo', { phase: 'INPUT_OPEN' })).toBe('ROUND_ACTIVE');
  expect(coreLifecyclePhase('jeopardy', { phase: 'STEAL_LOCKED' })).toBe('ROUND_RESOLUTION');
  expect(coreLifecyclePhase('wer-ist-das', { phase: 'ROUND_READY', buzzer: prepareRoundRuntime().buzzer })).toBe('ROUND_PREPARE');
  expect(coreLifecyclePhase('wer-ist-das', { phase: 'ROUND_READY', buzzer: { excludedPlayerIds: ['legacy'] } })).toBe('ROUND_ACTIVE');
  expect(coreLifecyclePhase('wer-ist-das', { phase: 'ROUND_READY', buzzer: { eligiblePlayerIds: ['a'] } })).toBe('ROUND_ACTIVE');
  expect(coreLifecyclePhase('jeopardy', { phase: 'PAUSED' })).toBe('PAUSED');
  expect(() => coreLifecyclePhase('jeopardy', { phase: 'invented' })).toThrow('STATE_INVARIANT_FAILED');
});
it('rejects premature transitions and score changes, and records a completed atomic transition', () => {
  const current = { phase: 'REVEAL', scores: { a: 10 } }, prepared = { ...current, phase: 'PROMPT' };
  expect(transitionRoundState({ gameSlug: 'wissensduell', current, prepared, completedRoundId: '0', nextRoundId: '1' })).toMatchObject({
    phase: 'PROMPT', scores: { a: 10 }, lastRoundTransition: { completedRoundId: '0', nextRoundId: '1', sequence: ['ROUND_END', 'ROUND_TRANSITION', 'ROUND_PREPARE'] },
  });
  expect(() => transitionRoundState({ gameSlug: 'wissensduell', current: prepared, prepared, completedRoundId: '0' })).toThrow('INVALID_PHASE');
  expect(() => transitionRoundState({ gameSlug: 'wissensduell', current, prepared: { ...prepared, scores: { a: 20 } }, completedRoundId: '0' })).toThrow('SCORE_CHANGED_DURING_TRANSITION');
  expect(current).toEqual({ phase: 'REVEAL', scores: { a: 10 } });
  const first = prepareRoundRuntime(), second = prepareRoundRuntime();
  first.buzzer.excludedPlayerIds.push('old');
  expect(second.buzzer.excludedPlayerIds).toEqual([]);
});
