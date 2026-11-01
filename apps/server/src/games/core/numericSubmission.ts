// ============================================================
// N1 — Numeric submission lifecycle (domain building block)
//
// Pure functions over a serializable round state. They authenticate
// nothing: `participantId`, the expected scope and `now` MUST come from
// the server-side admission/command boundary of a future engine, never
// from client claims. No socket, DB, clock, randomness or scoring here.
// Points/results/ledger stay with the engine and the central score path.
// ============================================================

import { z } from 'zod';
import { JudgeDecisionSchema, type CoreTimer, type JudgeDecision } from '@quiz/shared';
import {
  NUMERIC_SCHEMA_VERSION, NumericError, NumericInputConfigSchema, NumericPublicInputSchema, NumericValueSchema,
  numericConfigKey, projectNumericPublicInput, validateNumericValue,
  type NumericInputConfig, type NumericPublicInput, type NumericValue,
} from '@quiz/shared/numeric';
import { CoreRuleError, timerAcceptsInput } from './runtimePrimitives.js';
import { canView, type ProjectionAudience } from './visibility.js';

/** Additive record: strictly different from the legacy string SubmissionRecord (`kind` + object value). */
export const NumericSubmissionRecordSchema = z.object({
  kind: z.literal('NUMERIC'),
  schemaVersion: z.literal(NUMERIC_SCHEMA_VERSION),
  participantId: z.string().min(1).max(200).refine(id => id !== '__proto__', 'RESERVED_ID'),
  value: NumericValueSchema,
  status: z.enum(['SUBMITTED', 'LOCKED', 'JUDGED']),
  submittedAtMs: z.number().int().nonnegative(),
  judgedAtMs: z.number().int().nonnegative().nullable(),
  decision: JudgeDecisionSchema.nullable(),
}).strict().superRefine((record, ctx) => {
  const judged = record.status === 'JUDGED';
  if (judged !== (record.decision !== null) || judged !== (record.judgedAtMs !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'JUDGEMENT_STATE_CONFLICT' });
  }
});
export type NumericSubmissionRecord = z.infer<typeof NumericSubmissionRecordSchema>;

/**
 * Persisted state of ONE numeric round. It pins the effective config (schema version, precision,
 * bounds, unit) so a later config change cannot reinterpret stored values. It is server-private:
 * clients only ever receive `projectNumericRound` output.
 */
export const NumericRoundStateSchema = z.object({
  kind: z.literal('NUMERIC_ROUND'),
  schemaVersion: z.literal(NUMERIC_SCHEMA_VERSION),
  runIndex: z.number().int().positive(),
  roundId: z.string().min(1).max(200),
  config: NumericInputConfigSchema,
  submissions: z.record(NumericSubmissionRecordSchema),
}).strict().superRefine((state, ctx) => {
  for (const [participantId, record] of Object.entries(state.submissions)) {
    if (record.participantId !== participantId || !validateNumericValue(state.config, record.value).ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SUBMISSION_SCOPE_CONFLICT' });
    }
  }
});
export type NumericRoundState = z.infer<typeof NumericRoundStateSchema>;

/** What the caller currently considers authoritative; any difference means the request is stale. */
export interface NumericScope { runIndex: number; roundId: string; configKey: string }

export function parseNumericRoundState(raw: unknown): NumericRoundState {
  const parsed = NumericRoundStateSchema.safeParse(raw);
  if (!parsed.success) throw new NumericError('NUMERIC_STATE_INVALID');
  return parsed.data;
}

export function numericScopeOf(state: NumericRoundState): NumericScope {
  return { runIndex: state.runIndex, roundId: state.roundId, configKey: numericConfigKey(state.config) };
}

function assertScope(state: NumericRoundState, expected: NumericScope): void {
  if (state.runIndex !== expected.runIndex || state.roundId !== expected.roundId) throw new CoreRuleError('STALE_ROUND');
  if (numericConfigKey(state.config) !== expected.configKey) throw new NumericError('NUMERIC_CONFIG_STALE');
}

export function createNumericRound(input: { runIndex: number; roundId: string; config: unknown }): NumericRoundState {
  const config = NumericInputConfigSchema.safeParse(input.config);
  if (!config.success) throw new NumericError('NUMERIC_CONFIG_INVALID');
  return parseNumericRoundState({ kind: 'NUMERIC_ROUND', schemaVersion: NUMERIC_SCHEMA_VERSION,
    runIndex: input.runIndex, roundId: input.roundId, config: config.data, submissions: {} });
}

/** Order: stored data → scope → deadline → duplicate → value. The input state is never mutated. */
export function submitNumeric(rawState: unknown, args: { scope: NumericScope; participantId: string; input: unknown; timer: CoreTimer; now: number }): NumericRoundState {
  const state = parseNumericRoundState(rawState);
  assertScope(state, args.scope);
  if (!Number.isSafeInteger(args.now) || args.now < 0) throw new CoreRuleError('INVALID_TIME');
  if (!timerAcceptsInput(args.timer, args.now)) throw new CoreRuleError('TIME_EXPIRED');
  if (Object.hasOwn(state.submissions, args.participantId)) throw new CoreRuleError('ALREADY_ANSWERED');
  const value = validateNumericValue(state.config, args.input);
  if (!value.ok) throw new NumericError(value.code);
  const record: NumericSubmissionRecord = { kind: 'NUMERIC', schemaVersion: NUMERIC_SCHEMA_VERSION, participantId: args.participantId,
    value: value.value, status: 'SUBMITTED', submittedAtMs: args.now, judgedAtMs: null, decision: null };
  return parseNumericRoundState({ ...state, submissions: { ...state.submissions, [args.participantId]: record } });
}

/** Timer/phase lock: SUBMITTED → LOCKED. Already locked or judged records are left as they are (idempotent). */
export function lockNumericRound(rawState: unknown, scope: NumericScope): NumericRoundState {
  const state = parseNumericRoundState(rawState);
  assertScope(state, scope);
  const submissions = Object.fromEntries(Object.entries(state.submissions).map(([id, record]) =>
    [id, record.status === 'SUBMITTED' ? { ...record, status: 'LOCKED' as const } : record]));
  return parseNumericRoundState({ ...state, submissions });
}

/**
 * Judges one record. `applied` is true only for the transition SUBMITTED/LOCKED → JUDGED: the engine may
 * award points exactly then. Repeating the same decision returns the identical state with `applied: false`
 * (no second score effect, judgedAtMs unchanged). A different decision is rejected: corrections belong to
 * counter/correction events (Master §5.7), not to a silent overwrite.
 */
export function judgeNumeric(rawState: unknown, scope: NumericScope, participantId: string, decision: JudgeDecision, now: number): { state: NumericRoundState; applied: boolean } {
  const state = parseNumericRoundState(rawState);
  assertScope(state, scope);
  if (!Number.isSafeInteger(now) || now < 0) throw new CoreRuleError('INVALID_TIME');
  const record = Object.hasOwn(state.submissions, participantId) ? state.submissions[participantId] : undefined;
  if (!record) throw new CoreRuleError('SUBMISSION_NOT_JUDGEABLE');
  if (record.status === 'JUDGED') {
    if (record.decision === decision) return { state, applied: false };
    throw new NumericError('NUMERIC_ALREADY_JUDGED');
  }
  const judged: NumericSubmissionRecord = { ...record, status: 'JUDGED', decision, judgedAtMs: now };
  return { state: parseNumericRoundState({ ...state, submissions: { ...state.submissions, [participantId]: judged } }), applied: true };
}

export const NumericRoundProjectionSchema = z.object({
  input: NumericPublicInputSchema,
  submissions: z.array(z.object({ participantId: z.string(), status: z.enum(['SUBMITTED', 'LOCKED', 'JUDGED']),
    value: NumericValueSchema, decision: JudgeDecisionSchema.nullable() }).strict()),
}).strict();
export type NumericRoundProjection = { input: NumericPublicInput; submissions: z.infer<typeof NumericRoundProjectionSchema>['submissions'] };

/**
 * Role/audience projection through the existing visibility helper. Submissions are PLAYER_PRIVATE until
 * `revealed`; host rights, blind hosts, other players, viewers and displays see none before the reveal.
 * Config/bounds appear only as public input metadata; the decision only after the reveal.
 */
export function projectNumericRound(audience: ProjectionAudience, rawState: unknown, options: { revealed: boolean }): NumericRoundProjection {
  const state = parseNumericRoundState(rawState);
  const submissions = Object.values(state.submissions)
    .filter(record => canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: record.participantId, publiclyRevealed: options.revealed }))
    .sort((a, b) => (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0))
    .map(record => ({ participantId: record.participantId, status: record.status, value: record.value,
      decision: options.revealed ? record.decision : null }));
  return { input: projectNumericPublicInput(state.config), submissions };
}

export type { NumericInputConfig, NumericValue };
