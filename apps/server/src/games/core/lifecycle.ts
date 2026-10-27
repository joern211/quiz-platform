import { CoreGamePhaseSchema, resolveCanonicalSlug, type CoreGamePhase } from '@quiz/shared';
import { CoreRuleError } from './runtimePrimitives.js';

const phases: Record<string, Record<string, CoreGamePhase>> = {
  wissensduell: { INTRO: 'READY', PROMPT: 'ROUND_PREPARE', INPUT_OPEN: 'ROUND_ACTIVE', INPUT_LOCKED: 'ROUND_RESOLUTION', REVEAL: 'ROUND_END' },
  jeopardy: { INTRO: 'READY', SELECTING: 'ROUND_PREPARE', BUZZ_OPEN: 'ROUND_ACTIVE', BUZZ_LOCKED: 'ROUND_RESOLUTION',
    STEAL_OPEN: 'ROUND_ACTIVE', STEAL_LOCKED: 'ROUND_RESOLUTION', FIELD_DONE: 'ROUND_END', BOARD_COMPLETE: 'ROUND_END' },
  'wer-ist-das': { ROUND_READY: 'ROUND_PREPARE', BUZZ_OPEN: 'ROUND_ACTIVE', ANSWERING: 'ROUND_RESOLUTION', REVEAL: 'ROUND_END' },
};
/** Derive the common lifecycle from the authoritative subphase; never persist competing phase fields. */
export function coreLifecyclePhase(gameSlug: string, input: unknown): CoreGamePhase {
  if (!input || typeof input !== 'object' || !('phase' in input) || typeof input.phase !== 'string') throw new CoreRuleError('INVALID_GAME_STATE');
  const slug = resolveCanonicalSlug(gameSlug) ?? gameSlug, phase = input.phase;
  if (!phases[slug]) throw new CoreRuleError('WRONG_GAME');
  if (['PAUSED', 'ABORTED', 'ERROR_RECOVERY', 'GAME_END', 'RESULT_REVIEW', 'FINALIZED'].includes(phase)) return CoreGamePhaseSchema.parse(phase);
  if (slug === 'wer-ist-das' && phase === 'ROUND_READY' && 'buzzer' in input) {
    const buzzer = input.buzzer as { eligiblePlayerIds?: unknown; excludedPlayerIds?: unknown } | null;
    // Wrong/reopen continues the same round, including pre-core saved exclusions.
    if (buzzer?.eligiblePlayerIds || Array.isArray(buzzer?.excludedPlayerIds) && buzzer.excludedPlayerIds.length) return 'ROUND_ACTIVE';
  }
  const resolved = phases[slug][phase];
  if (!resolved) throw new CoreRuleError('STATE_INVARIANT_FAILED');
  return resolved;
}
