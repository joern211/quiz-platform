import { z } from 'zod';
import { CoreTimerSchema, CoreTurnSchema, CoreRoundTransitionSchema, CoreBuzzerSchema, SubmissionRecordSchema, resolveCanonicalSlug } from '@quiz/shared';
import { CoreRuleError } from './runtimePrimitives.js';
import { JEOPARDY_PHASES } from '../jeopardy/contracts.js';
import { WerIstDasPhase } from '../weristdas/contracts.js';

export function assertGameInvariants(slug: string, state: unknown, phase: string): void {
  if (checkGameInvariants(slug, state, phase).length) throw new CoreRuleError('STATE_INVARIANT_FAILED');
}

const scores = z.record(z.number().finite().int());
const base = z.object({ phase: z.string(), scores, tieStrategy: z.literal('ALLOW_TIE').optional(), lastRoundTransition: CoreRoundTransitionSchema.optional() });
const buzzer = CoreBuzzerSchema;
const geo = base.extend({ currentRoundIndex: z.number().int().nonnegative(), questions: z.array(z.unknown()).min(1), roundStates: z.record(z.object({
  revealed: z.boolean(), timer: CoreTimerSchema.optional(), playerStates: z.record(z.object({ submission: SubmissionRecordSchema.optional() })),
})) });
const jeopardy = base.extend({ currentBoard: z.union([z.literal(1), z.literal(2)]), boardCount: z.number().int().min(1).max(2).optional(),
  currentField: z.object({ fieldDef: z.object({ answer: z.string(), question: z.string() }) }).nullable(),
  buzzOpen: z.boolean(), buzzWinner: z.string().nullable(), stealOpen: z.boolean(), stealWinner: z.string().nullable(),
  answerTurn: CoreTurnSchema.nullable().optional(), timer: CoreTimerSchema.optional(), submissions: z.record(SubmissionRecordSchema).optional(),
  buzzer: CoreBuzzerSchema.optional(), stealBuzzer: CoreBuzzerSchema.optional(),
});
const wid = base.extend({ roundIndex: z.number().int().nonnegative(), roundCount: z.number().int().positive(),
  buzzer, answerTurn: CoreTurnSchema.nullable().optional(), revealed: z.boolean(),
});

/** Only diagnostic codes leave this function; never copy content into errors. */
export function checkGameInvariants(slug: string, input: unknown, persistedPhase?: string): string[] {
  const canonical = resolveCanonicalSlug(slug) ?? slug;
  if (!['wissensduell', 'jeopardy', 'wer-ist-das'].includes(canonical)) return [];
  const common = base.safeParse(input);
  if (!common.success) return ['STATE_SHAPE'];
  const state = common.data, issues: string[] = [];
  if (persistedPhase && state.phase !== persistedPhase) issues.push('PHASE_MISMATCH');
  if (state.phase === 'ERROR_RECOVERY') return issues;
  const phases = canonical === 'wissensduell' ? ['INTRO', 'PROMPT', 'INPUT_OPEN', 'INPUT_LOCKED', 'REVEAL', 'GAME_END', 'PAUSED']
    : [...Object.values(canonical === 'jeopardy' ? JEOPARDY_PHASES : WerIstDasPhase), 'PAUSED'];
  if (!phases.includes(state.phase)) issues.push('UNKNOWN_PHASE');
  if (state.phase === 'PAUSED' && canonical !== 'wissensduell') {
    const original = z.object({ _roomPause: base.passthrough() }).safeParse(input);
    if (!original.success || original.data._roomPause.phase === 'PAUSED' || checkGameInvariants(slug, original.data._roomPause).length) issues.push('PAUSE_SNAPSHOT');
  }
  if (canonical === 'wissensduell') {
    const decoded = geo.safeParse(input);
    if (!decoded.success) return [...issues, 'STATE_SHAPE'];
    const s = decoded.data, round = s.roundStates[s.currentRoundIndex];
    if (s.currentRoundIndex > s.questions.length || s.currentRoundIndex === s.questions.length && s.phase !== 'GAME_END') issues.push('ROUND_INDEX');
    if (['INPUT_OPEN', 'INPUT_LOCKED', 'PAUSED', 'REVEAL'].includes(s.phase) && !round) issues.push('ROUND_MISSING');
    if (round) {
      if (s.phase === 'REVEAL' && !round.revealed || ['INPUT_OPEN', 'INPUT_LOCKED'].includes(s.phase) && round.revealed) issues.push('REVEAL_PHASE');
      if (round.timer && (s.phase === 'PAUSED' && round.timer.status !== 'PAUSED' || s.phase === 'INPUT_OPEN' && round.timer.status !== 'RUNNING')) issues.push('TIMER_PHASE');
      for (const [id, own] of Object.entries(round.playerStates)) {
        if (own.submission && (own.submission.participantId !== id || own.submission.roundId !== String(s.currentRoundIndex))) issues.push('SUBMISSION_OWNER');
      }
    }
  } else if (canonical === 'jeopardy') {
    const decoded = jeopardy.safeParse(input);
    if (!decoded.success) return [...issues, 'STATE_SHAPE'];
    const s = decoded.data;
    if (s.boardCount && s.currentBoard > s.boardCount) issues.push('BOARD_INDEX');
    // Paused state intentionally retains buzzer flags; all input gates are closed.
    if (!['PAUSED', 'GAME_END'].includes(s.phase)) {
      if (s.buzzOpen !== (s.phase === 'BUZZ_OPEN') || s.stealOpen !== (s.phase === 'STEAL_OPEN')) issues.push('BUZZER_PHASE');
      if (['BUZZ_OPEN', 'BUZZ_LOCKED', 'STEAL_OPEN', 'STEAL_LOCKED'].includes(s.phase) && !s.currentField) issues.push('FIELD_MISSING');
      const winner = s.phase === 'BUZZ_LOCKED' ? s.buzzWinner : s.phase === 'STEAL_LOCKED' ? s.stealWinner : null;
      if (['BUZZ_LOCKED', 'STEAL_LOCKED'].includes(s.phase) && (!winner || !Object.hasOwn(s.scores, winner))) issues.push('BUZZER_OWNER');
      if (s.answerTurn && winner && s.answerTurn.order[s.answerTurn.index] !== winner) issues.push('TURN_OWNER');
    }
    for (const submission of Object.values(s.submissions ?? {})) if (!Object.hasOwn(s.scores, submission.participantId)) issues.push('SUBMISSION_OWNER');
  } else {
    // The untimed pause adapter retains the entire original state for exact resume.
    const decoded = wid.safeParse(input);
    if (!decoded.success) return [...issues, 'STATE_SHAPE'];
    const s = decoded.data;
    if (s.roundIndex >= s.roundCount) issues.push('ROUND_INDEX');
    if (!['PAUSED', 'GAME_END'].includes(s.phase)) {
      if (s.buzzer.open !== (s.phase === 'BUZZ_OPEN')) issues.push('BUZZER_PHASE');
      if (s.phase === 'ANSWERING' && (!s.buzzer.winnerId || !Object.hasOwn(s.scores, s.buzzer.winnerId))) issues.push('BUZZER_OWNER');
      if (s.answerTurn && s.buzzer.winnerId && s.answerTurn.order[s.answerTurn.index] !== s.buzzer.winnerId) issues.push('TURN_OWNER');
    }
  }
  return [...new Set(issues)];
}
