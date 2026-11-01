// ============================================================
// N3 — Ordering submission lifecycle (domain building block)
//
// Pure functions over a serializable round state. They authenticate
// nothing: `participantId`, the expected scope, `timer` and `now` MUST come
// from the server-side admission/command boundary of a future engine, never
// from client claims. No socket, DB, clock, randomness, scoring or ledger
// here: points, results and winners stay with the engine and the central
// score path. `applied`/`changed` are domain information only; exactly-once
// effects need transaction/CAS/receipt at the real consumer.
//
// Lock semantics: the ROUND is the unit that closes. After
// `closeOrderingRound` nobody may submit — also not a participant who has
// no record yet, and also not while an external timer still runs. The status
// of a submission is DERIVED from the round status and the comparison
// (nothing stored twice), so SUBMITTED/LOCKED/COMPARED cannot contradict.
//
// Secrets: the persisted state is SERVER-PRIVATE. It pins the public config
// and only an OPAQUE reference revision — never the reference itself. The
// reference (the correct order) is supplied by the engine at comparison time
// and validated against the pinned config and revision. Everything that
// leaves the server goes through `projectOrderingRound` / `projectOrderingSolution`.
// ============================================================

import { z } from 'zod';
import { type CoreTimer } from '@quiz/shared';
import {
  ORDERING_SCHEMA_VERSION, OrderingComparisonSchema, OrderingConfigSchema, OrderingError, OrderingRevisionSchema,
  OrderingValueSchema, compareOrdering, orderingComparisonMatchesOrder, orderingConfigKey, validateOrdering,
  validateOrderingReference,
  type OrderingComparison, type OrderingConfig, type OrderingValue,
} from '@quiz/shared/ordering';
import { CoreRuleError, timerAcceptsInput } from './runtimePrimitives.js';
import { canView, type ProjectionAudience } from './visibility.js';

const MAX_RECORDS = 500;
const idText = z.string().min(1).max(200);

/** The order is immutable after acceptance; the comparison is separate data and never touches it. */
export const OrderingRecordSchema = z.object({
  participantId: idText,
  order: OrderingValueSchema,
  submittedAtMs: z.number().int().nonnegative(),
  comparison: OrderingComparisonSchema.nullable(),
  comparedAtMs: z.number().int().nonnegative().nullable(),
}).strict();
export type OrderingRecord = z.infer<typeof OrderingRecordSchema>;

/**
 * Persisted state of ONE ordering round. It pins the effective public config (so a later change cannot
 * reinterpret stored orders) and the opaque reference revision (so a comparison cannot silently switch
 * reference). `referenceRevision: null` means "no reference configured": comparing is refused, never guessed.
 */
export const OrderingRoundStateSchema = z.object({
  kind: z.literal('ORDERING_ROUND'),
  schemaVersion: z.literal(ORDERING_SCHEMA_VERSION),
  runIndex: z.number().int().positive(),
  roundId: idText,
  config: OrderingConfigSchema,
  referenceRevision: OrderingRevisionSchema.nullable(),
  status: z.enum(['OPEN', 'CLOSED']),
  closedAtMs: z.number().int().nonnegative().nullable(),
  records: z.array(OrderingRecordSchema).max(MAX_RECORDS),
}).strict().superRefine((state, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if ((state.status === 'CLOSED') !== (state.closedAtMs !== null)) bad('CLOSE_STATE_CONFLICT');
  if (new Set(state.records.map(r => r.participantId)).size !== state.records.length) bad('DUPLICATE_ORDER_OWNER');
  for (const record of state.records) {
    const again = validateOrdering(state.config, record.order);
    if (!again.ok || JSON.stringify(again.order) !== JSON.stringify(record.order)) { bad('ORDER_CONFIG_CONFLICT'); continue; }
    if (state.closedAtMs !== null && record.submittedAtMs > state.closedAtMs) bad('SUBMITTED_AFTER_CLOSE');
    if ((record.comparison === null) !== (record.comparedAtMs === null)) { bad('COMPARISON_STATE_CONFLICT'); continue; }
    if (record.comparison === null || record.comparedAtMs === null) continue;
    if (state.status !== 'CLOSED' || state.closedAtMs === null || record.comparedAtMs < state.closedAtMs) bad('COMPARED_BEFORE_CLOSE');
    if (state.referenceRevision === null || record.comparison.referenceRevision !== state.referenceRevision) bad('COMPARISON_REFERENCE_CONFLICT');
    if (!orderingComparisonMatchesOrder(record.order, record.comparison)) bad('COMPARISON_ORDER_CONFLICT');
  }
});
export type OrderingRoundState = z.infer<typeof OrderingRoundStateSchema>;

/** What the caller currently considers authoritative; any difference means the request is stale. */
export interface OrderingScope { runIndex: number; roundId: string; configKey: string; referenceRevision: string | null }

export function parseOrderingRoundState(raw: unknown): OrderingRoundState {
  const parsed = OrderingRoundStateSchema.safeParse(raw);
  if (!parsed.success) throw new OrderingError('ORDERING_STATE_INVALID');
  return parsed.data;
}
export function orderingScopeOf(state: OrderingRoundState): OrderingScope {
  return { runIndex: state.runIndex, roundId: state.roundId, configKey: orderingConfigKey(state.config), referenceRevision: state.referenceRevision };
}
function assertScope(state: OrderingRoundState, expected: OrderingScope): void {
  if (state.runIndex !== expected.runIndex || state.roundId !== expected.roundId) throw new CoreRuleError('STALE_ROUND');
  if (orderingConfigKey(state.config) !== expected.configKey) throw new OrderingError('ORDERING_CONFIG_STALE');
  if (state.referenceRevision !== expected.referenceRevision) throw new OrderingError('ORDERING_REFERENCE_STALE');
}
function assertTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new CoreRuleError('INVALID_TIME');
}
const findRecord = (state: OrderingRoundState, participantId: string) => state.records.find(r => r.participantId === participantId);

export function createOrderingRound(input: { runIndex: number; roundId: string; config: unknown; referenceRevision: string | null }): OrderingRoundState {
  const config = OrderingConfigSchema.safeParse(input.config);
  if (!config.success) throw new OrderingError('ORDERING_CONFIG_INVALID');
  return parseOrderingRoundState({ kind: 'ORDERING_ROUND', schemaVersion: ORDERING_SCHEMA_VERSION, runIndex: input.runIndex, roundId: input.roundId,
    config: config.data, referenceRevision: input.referenceRevision, status: 'OPEN', closedAtMs: null, records: [] });
}

/**
 * Atomic acceptance of one complete order. Order: stored data → scope → time → round open → deadline → duplicate →
 * order validation. On any failure nothing is stored and the input state is untouched (no partial list, no burnt
 * slot). A second ordinary submission never replaces an accepted order.
 */
export function submitOrdering(rawState: unknown, args: { scope: OrderingScope; participantId: string; input: unknown; timer: CoreTimer; now: number }): OrderingRoundState {
  const state = parseOrderingRoundState(rawState);
  assertScope(state, args.scope);
  assertTime(args.now);
  if (state.status !== 'OPEN') throw new OrderingError('ORDERING_ROUND_CLOSED');
  if (!timerAcceptsInput(args.timer, args.now)) throw new CoreRuleError('TIME_EXPIRED');
  if (findRecord(state, args.participantId)) throw new CoreRuleError('ALREADY_ANSWERED');
  const validation = validateOrdering(state.config, args.input);
  if (!validation.ok) throw new OrderingError('ORDERING_INVALID', validation.issues);
  const record: OrderingRecord = { participantId: args.participantId, order: validation.order, submittedAtMs: args.now, comparison: null, comparedAtMs: null };
  return parseOrderingRoundState({ ...state, records: [...state.records, record] });
}

/**
 * Closes the round for good (OPEN → CLOSED). This is the real lock: afterwards `submitOrdering` rejects every
 * participant — including those who never submitted — regardless of the timer. Idempotent: closing a closed
 * round returns the identical state (closedAtMs unchanged). `now` must not precede an accepted submission.
 */
export function closeOrderingRound(rawState: unknown, scope: OrderingScope, now: number): OrderingRoundState {
  const state = parseOrderingRoundState(rawState);
  assertScope(state, scope);
  assertTime(now);
  if (state.status === 'CLOSED') return state;
  if (state.records.some(r => r.submittedAtMs > now)) throw new CoreRuleError('INVALID_TIME');
  return parseOrderingRoundState({ ...state, status: 'CLOSED', closedAtMs: now });
}

/** Reference of one concrete accepted order (scope + owner + acceptance time). A comparison command must echo it. */
export function orderingRef(state: OrderingRoundState, participantId: string): string | null {
  const record = findRecord(state, participantId);
  return record ? [state.runIndex, state.roundId, record.participantId, record.submittedAtMs].join('|') : null;
}

export type OrderingStatus = 'SUBMITTED' | 'LOCKED' | 'COMPARED';
/**
 * Derived, never stored. COMPARED is deliberately NOT "JUDGED": a comparison records facts, it is no judge
 * decision and writes no points; the engine maps it to judging later.
 */
export function orderingStatus(state: OrderingRoundState, participantId: string): OrderingStatus | null {
  const record = findRecord(state, participantId);
  if (!record) return null;
  if (state.status === 'OPEN') return 'SUBMITTED';
  return record.comparison ? 'COMPARED' : 'LOCKED';
}

export type OrderingOutcome =
  | { kind: 'NO_SUBMISSION' }
  | { kind: 'NOT_CHECKED' }
  | { kind: 'CHECKED'; comparison: OrderingComparison };
/**
 * Server-internal outcome of one participant: no submission, submitted but not (yet) checked, or checked — which
 * may legitimately be 0 matching positions. Never a guess: without a comparison nothing is "right" or "wrong".
 */
export function orderingOutcome(rawState: unknown, participantId: string): OrderingOutcome {
  const state = parseOrderingRoundState(rawState);
  const record = findRecord(state, participantId);
  if (!record) return { kind: 'NO_SUBMISSION' };
  return record.comparison ? { kind: 'CHECKED', comparison: JSON.parse(JSON.stringify(record.comparison)) as OrderingComparison } : { kind: 'NOT_CHECKED' };
}

/**
 * Takes over the comparison of ONE accepted order against the server-side reference, only after the round is
 * closed. The result is computed here from the validated reference — never taken from a client. `submissionRef`
 * must be the reference the caller saw (otherwise ORDERING_STALE_SUBMISSION); the reference must match the
 * pinned config and revision. Repeating the identical takeover returns the identical state with
 * `applied: false, changed: false`; a result that differs from the stored one is rejected (corrections belong to
 * the central correction path, not to a silent overwrite). No points, no ranks, no winner.
 */
export function compareOrderingSubmission(rawState: unknown, scope: OrderingScope, args: { participantId: string; submissionRef: string; reference: unknown; now: number }): { state: OrderingRoundState; applied: boolean; changed: boolean } {
  const state = parseOrderingRoundState(rawState);
  assertScope(state, scope);
  assertTime(args.now);
  if (state.status !== 'CLOSED' || state.closedAtMs === null) throw new OrderingError('ORDERING_NOT_CLOSED');
  if (state.referenceRevision === null || args.reference === null || args.reference === undefined) throw new OrderingError('ORDERING_REFERENCE_MISSING');
  const record = findRecord(state, args.participantId);
  if (!record) throw new OrderingError('ORDERING_NOT_FOUND');
  if (orderingRef(state, args.participantId) !== args.submissionRef) throw new OrderingError('ORDERING_STALE_SUBMISSION');
  const reference = validateOrderingReference(state.config, args.reference);
  if (!reference.ok) throw new OrderingError('ORDERING_REFERENCE_INVALID', reference.issues);
  if (reference.reference.revision !== state.referenceRevision) throw new OrderingError('ORDERING_REFERENCE_STALE');
  const comparison = compareOrdering(state.config, record.order, reference.reference);
  if (record.comparison) {
    if (JSON.stringify(record.comparison) === JSON.stringify(comparison)) return { state, applied: false, changed: false };
    throw new OrderingError('ORDERING_ALREADY_COMPARED');
  }
  if (args.now < state.closedAtMs) throw new CoreRuleError('INVALID_TIME');
  const compared: OrderingRecord = { ...record, comparison, comparedAtMs: args.now };
  const records = state.records.map(r => (r.participantId === record.participantId ? compared : r));
  return { state: parseOrderingRoundState({ ...state, records }), applied: true, changed: true };
}

export const OrderingProjectionSchema = z.object({
  config: OrderingConfigSchema,
  status: z.enum(['OPEN', 'CLOSED']),
  records: z.array(z.object({
    participantId: z.string(),
    status: z.enum(['SUBMITTED', 'LOCKED', 'COMPARED']),
    order: OrderingValueSchema,
    comparison: OrderingComparisonSchema.nullable(),
  }).strict()),
}).strict();
export type OrderingProjection = z.infer<typeof OrderingProjectionSchema>;

/**
 * Role/audience projection through the existing visibility helper. Orders are PLAYER_PRIVATE until `revealed`:
 * team membership grants nothing (TEAM_PRIVATE is deliberately not used), and neither do host rights, a blind
 * host, other players, viewers or displays. BEFORE the reveal not even the owner receives comparison facts, and
 * the status is clamped (COMPARED shows as LOCKED), so the projection is no correctness oracle. A reveal is only
 * possible for a CLOSED round. The reference is not part of the state and therefore cannot leak from here. This
 * is a DOMAIN projection: a playing host must be given the PLAYER information role by the engine to see his own
 * order; nothing here proves socket/rejoin behaviour.
 */
export function projectOrderingRound(audience: ProjectionAudience, rawState: unknown, options: { revealed: boolean }): OrderingProjection {
  const state = parseOrderingRoundState(rawState);
  if (options.revealed && state.status !== 'CLOSED') throw new OrderingError('ORDERING_NOT_CLOSED');
  const records = state.records
    .filter(record => canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: record.participantId, publiclyRevealed: options.revealed }))
    .sort((a, b) => (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0))
    .map(record => {
      const derived = orderingStatus(state, record.participantId) as OrderingStatus;
      return { participantId: record.participantId, status: options.revealed ? derived : (derived === 'COMPARED' ? 'LOCKED' as const : derived),
        order: record.order, comparison: options.revealed ? record.comparison : null };
    });
  return { config: state.config, status: state.status, records: JSON.parse(JSON.stringify(records)) as OrderingProjection['records'] };
}

/**
 * The correct order, only after an explicit reveal and for every audience alike. Before the reveal NOBODY gets it
 * here — not the host, not a co-host, not an admin (administrative rights are no information rights). A pre-reveal
 * preview for a non-playing judge is a separate, later engine decision. Validated against the pinned config.
 */
export function projectOrderingSolution(audience: ProjectionAudience, config: OrderingConfig, reference: unknown, options: { revealed: boolean }): { revision: string; groups: string[][] } | null {
  if (!canView(audience, { scope: 'PLAYER_PRIVATE', publiclyRevealed: options.revealed })) return null;
  const parsed = validateOrderingReference(config, reference);
  if (!parsed.ok) throw new OrderingError('ORDERING_REFERENCE_INVALID', parsed.issues);
  return { revision: parsed.reference.revision, groups: parsed.reference.groups.map(group => [...group]) };
}
