import { CoreTimerSchema, SubmissionRecordSchema, type CoreTimer, type SubmissionRecord, type JudgeDecision } from '@quiz/shared';

export class CoreRuleError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CoreRuleError'; }
}
function clock(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new CoreRuleError('INVALID_TIME');
}
export function createTimer(mode: CoreTimer['mode'], now: number, durationMs?: number): CoreTimer {
  clock(now);
  if (mode === 'COUNTDOWN' && (!Number.isSafeInteger(durationMs) || durationMs! <= 0 || durationMs! > 2147483647)) throw new CoreRuleError('INVALID_TIMER_DURATION');
  return CoreTimerSchema.parse({ mode, status: 'RUNNING', startedAtMs: now,
    endsAtMs: mode === 'COUNTDOWN' ? now + durationMs! : null,
    pausedAtMs: null, elapsedBeforeMs: 0, remainingMs: mode === 'COUNTDOWN' ? durationMs : null });
}
export function timerElapsed(timer: CoreTimer, now: number): number {
  clock(now);
  const observed = timer.mode === 'COUNTDOWN' && timer.endsAtMs !== null ? Math.min(now, timer.endsAtMs) : now;
  return timer.elapsedBeforeMs + (timer.status === 'RUNNING' && timer.startedAtMs !== null ? Math.max(0, observed - timer.startedAtMs) : 0);
}
export function timerRemaining(timer: CoreTimer, now: number): number | null {
  clock(now);
  if (timer.mode !== 'COUNTDOWN') return null;
  return timer.status === 'RUNNING' && timer.endsAtMs !== null ? Math.max(0, timer.endsAtMs - now) : timer.remainingMs;
}
/** The deadline itself is already closed: admission uses the same boundary. */
export function timerAcceptsInput(timer: CoreTimer, now: number): boolean {
  clock(now);
  return timer.status === 'RUNNING' && (timer.mode !== 'COUNTDOWN' || (timer.endsAtMs !== null && now < timer.endsAtMs));
}
export function pauseTimer(timer: CoreTimer, now: number): CoreTimer {
  if (timer.status !== 'RUNNING') throw new CoreRuleError('TIMER_NOT_RUNNING');
  const remainingMs = timerRemaining(timer, now);
  return { ...timer, status: remainingMs === 0 ? 'EXPIRED' : 'PAUSED', elapsedBeforeMs: timerElapsed(timer, now), remainingMs, endsAtMs: null, startedAtMs: null, pausedAtMs: now };
}
export function resumeTimer(timer: CoreTimer, now: number): CoreTimer {
  clock(now);
  if (timer.status !== 'PAUSED') throw new CoreRuleError('TIMER_NOT_PAUSED');
  if (timer.mode === 'COUNTDOWN' && (timer.remainingMs ?? 0) <= 0) throw new CoreRuleError('TIME_EXPIRED');
  return { ...timer, status: 'RUNNING', startedAtMs: now, pausedAtMs: null, endsAtMs: timer.mode === 'COUNTDOWN' ? now + (timer.remainingMs ?? 0) : null };
}
export function extendTimer(timer: CoreTimer, deltaMs: number, now: number): CoreTimer {
  if (timer.mode !== 'COUNTDOWN' || !['RUNNING', 'PAUSED'].includes(timer.status) || !Number.isSafeInteger(deltaMs)) throw new CoreRuleError('INVALID_TIMER_CHANGE');
  const current = timerRemaining(timer, now) ?? 0;
  if (current <= 0) throw new CoreRuleError('TIME_EXPIRED');
  const remainingMs = Math.max(0, current + deltaMs);
  if (remainingMs > 2147483647) throw new CoreRuleError('INVALID_TIMER_DURATION');
  if (remainingMs === 0) return endTimer(timer, now);
  return { ...timer, remainingMs, endsAtMs: timer.status === 'RUNNING' ? now + remainingMs : null };
}
export function endTimer(timer: CoreTimer, now: number): CoreTimer {
  return { ...timer, status: 'EXPIRED', elapsedBeforeMs: timerElapsed(timer, now), remainingMs: timer.mode === 'COUNTDOWN' ? 0 : null, startedAtMs: null, endsAtMs: null, pausedAtMs: null };
}
export function submitOnce(input: { previous?: SubmissionRecord; participantId: string; roundId: string; value: string | null; timer: CoreTimer; now: number }): SubmissionRecord {
  if (!timerAcceptsInput(input.timer, input.now)) throw new CoreRuleError('TIME_EXPIRED');
  if (input.previous && input.previous.roundId === input.roundId && input.previous.participantId === input.participantId && input.previous.status !== 'DRAFT') throw new CoreRuleError('ALREADY_ANSWERED');
  return SubmissionRecordSchema.parse({ participantId: input.participantId, roundId: input.roundId, value: input.value, status: 'SUBMITTED', submittedAtMs: input.now, judgedAtMs: null, decision: null });
}
export function lockSubmission(submission: SubmissionRecord): SubmissionRecord {
  if (submission.status !== 'SUBMITTED' && submission.status !== 'DRAFT') return submission;
  return { ...submission, status: 'LOCKED' };
}
export function judgeSubmission(submission: SubmissionRecord, decision: JudgeDecision, now: number): SubmissionRecord {
  clock(now);
  if (!['SUBMITTED', 'LOCKED'].includes(submission.status)) throw new CoreRuleError('SUBMISSION_NOT_JUDGEABLE');
  return SubmissionRecordSchema.parse({ ...submission, status: 'JUDGED', decision, judgedAtMs: now });
}
export function scoreJudgement(decision: JudgeDecision, points: { correct: number; wrong: number; partial?: number; cancelled?: number }): number {
  const value = decision === 'CORRECT' ? points.correct : decision === 'WRONG' ? points.wrong : decision === 'PARTIAL' ? points.partial : points.cancelled ?? 0;
  if (!Number.isSafeInteger(value)) throw new CoreRuleError('JUDGE_DECISION_UNSUPPORTED');
  return value!;
}

/** Explicit compatibility reader for persisted pre-core Geo rounds. */
export function legacyRoundTimer(round: { timer?: CoreTimer; timerStartMs?: number | null; timerEndMs?: number | null; pauseRemainingMs?: number | null }, phase: string): CoreTimer {
  if (round.timer) return CoreTimerSchema.parse(round.timer);
  if (phase === 'PAUSED' && typeof round.pauseRemainingMs === 'number') return CoreTimerSchema.parse({ mode: 'COUNTDOWN', status: 'PAUSED', startedAtMs: null, endsAtMs: null, remainingMs: round.pauseRemainingMs, elapsedBeforeMs: 0, pausedAtMs: null });
  if (typeof round.timerEndMs !== 'number') throw new CoreRuleError('INVALID_TIMER_STATE');
  return CoreTimerSchema.parse({ mode: 'COUNTDOWN', status: 'RUNNING', startedAtMs: round.timerStartMs ?? null, endsAtMs: round.timerEndMs, remainingMs: null, elapsedBeforeMs: 0, pausedAtMs: null });
}
