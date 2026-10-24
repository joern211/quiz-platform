import { CoreRoundTransitionSchema } from '@quiz/shared';
import { createBuzzerState } from './buzzer.js';
import { coreLifecyclePhase } from './lifecycle.js';
import { CoreRuleError } from './runtimePrimitives.js';

/** Fresh runtime values; old round snapshots remain available in the immutable event history. */
export function prepareRoundRuntime() {
  return { buzzer: createBuzzerState(), stealBuzzer: createBuzzerState(), answerTurn: null, timer: undefined, submissions: {} };
}
/** One atomic transition, recorded with the prepared state rather than leaving a half-reset round. */
export function transitionRoundState<T extends { phase: string; scores: Record<string, number> }>(args: {
  gameSlug: string; current: T; prepared: T; completedRoundId: string; nextRoundId?: string | null;
}): T & { lastRoundTransition: ReturnType<typeof CoreRoundTransitionSchema.parse> } {
  if (coreLifecyclePhase(args.gameSlug, args.current) !== 'ROUND_END') throw new CoreRuleError('INVALID_PHASE');
  const destination = coreLifecyclePhase(args.gameSlug, args.prepared);
  if (destination !== 'ROUND_PREPARE' && destination !== 'GAME_END') throw new CoreRuleError('INVALID_PHASE');
  const ids = Object.keys(args.current.scores);
  if (ids.length !== Object.keys(args.prepared.scores).length || ids.some(id => args.current.scores[id] !== args.prepared.scores[id])) throw new CoreRuleError('SCORE_CHANGED_DURING_TRANSITION');
  return { ...args.prepared, lastRoundTransition: CoreRoundTransitionSchema.parse({ completedRoundId: args.completedRoundId,
    nextRoundId: args.nextRoundId ?? null, sequence: ['ROUND_END', 'ROUND_TRANSITION', destination] }) };
}
