// ============================================================
// N10 — Bidding phase contract: CLIENT-SAFE part only (technical foundation, no game rules beyond the fixed bidding mechanics)
//
// A small ascending-bid process between TEAMS: each team acts through ONE pinned bidder (the team's partner, the PERFORMER, never bids and never sees the
// bids). Free start bids, strictly higher follow-up bids (jumps allowed), passing = leaving THIS bidding for good, a regular end when exactly one team is
// left, an explicit abort without any result. It decides nobody's points, starts no challenge and reveals no task. Several layers are kept apart and never
// derived from each other:
//   - the BID VALUE (a canonical N1 scaled integer; the height of a bid is not a version),
//   - the LOCAL bidding version (`biddingVersion`, +1 per real change of this process: opening, bid, pass, abort — the closing pass is ONE change),
//   - the ACTION identity: the N8 TURN (`turnNumber`) in which a bid or pass is made; every handover is a new turn, a team id alone identifies no turn,
//   - the PINNED assignment (`rosterRevision` of the N8 sequence, `rolesRevision` of the bidder/performer assignment) and the current LOCAL N8 sequence
//     version (`sequenceVersion`: a newer N6 eligibility basis raises it without a new turn and without touching the bids),
//   - the global game `stateVersion` of the caller's own snapshot channel.
//
// This file holds what may leave the server: the PROJECTION one caller receives, the bidding configuration, the intents a client may send, bounds, code-only
// errors and the context binding helpers. The server-private state (bids, pass order and evidence, the result basis) lives in
// apps/server/src/games/core/biddingPhase.ts and must never be imported by the browser. There is deliberately NO schema here that lets a client set a winner, a
// leader or a highest bid: an intent carries ONE value for ITS OWN team and nothing else.
//
// Release policy (explicit, no default — chosen by the server per audience):
//   NEUTRAL   binding labels, the recipient, the snapshot version `stateVersion` and a coarse phase (PREPARED | OPEN | ENDED). Nothing else: no category, no bid,
//             no target, no team list, no bidding/turn counters, no result. This is what a PERFORMER (and every player who is not a pinned bidder) receives while
//             bidding — and afterwards ("ended" says nothing about who won). The only ordering information is the global snapshot version; the number of
//             accepted steps is NOT part of it (metadata decision, see design.md §7: still open whether even the global version may leak "something happened").
//   STANDING  additionally the category label, the numeric profile, the teams with their IN/PASSED status, the current leader and highest bid, the team
//             on turn, the end state (and, for a regular end, the winner with ITS bidder/performer pair) and the caller's OWN hints (`you`). For the pinned
//             bidders, a non-blind host and (explicitly chosen by the server) VIEWER / DISPLAY. The pass ORDER and the evidence behind "who left last against
//             the winner" are server-private at every level.
// `you.canBid` / `you.canPass` are DISPLAY AIDS; the server decides on its own with the current session, phase and eligibility.
// DEC-PCH-01 (may a viewer see the TASK prompt?) is open and not touched: no task text exists in any projection here.
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no parameter properties. Imports only zod and the N1 numeric contract.
// ============================================================

import { z } from 'zod';
import { NumericInputConfigSchema, NumericPublicInputSchema, NumericValueSchema, type NumericValue } from '@quiz/shared/numeric';

export const BIDDING_SCHEMA_VERSION = 1 as const;
export const BIDDING_CONTRACT = 'BIDDING_PHASE_STATUS_V1' as const;

/** Protection bounds, not game rules. Counters are small safe integers; bounds are checked BEFORE any cross-comparison. */
export const BIDDING_MIN_TEAMS = 2;
export const BIDDING_MAX_TEAMS = 16;
/** Accepted bids + passes. Reserved: a bid is only accepted while every team still in could still pass afterwards (the bidding can always be finished). */
export const BIDDING_MAX_STEPS = 200;
export const BIDDING_MAX_ID_LENGTH = 200;
export const BIDDING_MAX_REF_LENGTH = 80;
export const BIDDING_MAX_COUNTER = 1_000_000_000;
export const BIDDING_MAX_CATEGORY_LENGTH = 80;

export const BIDDING_PHASES = ['PREPARED', 'OPEN', 'CLOSED', 'ABORTED'] as const;
export const BIDDING_NEUTRAL_PHASES = ['PREPARED', 'OPEN', 'ENDED'] as const;
export const BIDDING_END_REASONS = ['COMPLETED', 'HOST_ABORTED', 'TECHNICAL_ABORT'] as const;
/** Abort reasons use the platform's GameEndReason / RoundEndReason vocabulary (Master §5.10). */
export const BIDDING_ABORT_REASONS = ['HOST_ABORTED', 'TECHNICAL_ABORT'] as const;
export const BIDDING_RELEASES = ['NEUTRAL', 'STANDING'] as const;
export type BiddingPhase = typeof BIDDING_PHASES[number];
export type BiddingNeutralPhase = typeof BIDDING_NEUTRAL_PHASES[number];
export type BiddingEndReason = typeof BIDDING_END_REASONS[number];
export type BiddingAbortReason = typeof BIDDING_ABORT_REASONS[number];
export type BiddingRelease = typeof BIDDING_RELEASES[number];

/** Per-issue codes. They never carry a value, an id or a path — only the kind of violation. */
export const BIDDING_ISSUE_CODES = [
  'SHAPE_INVALID', 'LIMIT_EXCEEDED', 'CONFIG_CONFLICT', 'TEAM_CONFLICT', 'PHASE_CONFLICT', 'COUNTER_CONFLICT', 'HISTORY_CONFLICT', 'STANDING_CONFLICT', 'PASSED_CONFLICT', 'RESULT_CONFLICT',
] as const;
export type BiddingIssueCode = typeof BIDDING_ISSUE_CODES[number];

/**
 * Wire error codes (the message of the thrown error equals the code). They carry no bid, value, bound, roster, team or participant id, role or reason. Errors of
 * the N8 turn check (`TURN_SEQ_*`) pass through unchanged: a bid is first of all a turn action.
 */
export const BIDDING_ERROR_CODES = [
  'BIDDING_ARGS_INVALID', 'BIDDING_CONFIG_INVALID', 'BIDDING_STATE_INVALID',
  'BIDDING_SCOPE_STALE', 'BIDDING_TURN_STALE', 'BIDDING_VERSION_STALE', 'BIDDING_SEQUENCE_MISMATCH',
  'BIDDING_NOT_OPEN', 'BIDDING_ALREADY_OPEN', 'BIDDING_ENDED',
  'BIDDING_TEAM_MISMATCH', 'BIDDING_TEAM_PASSED', 'BIDDING_LEADER_CANNOT_ACT', 'BIDDING_PASS_BEFORE_FIRST_BID',
  'BIDDING_VALUE_INVALID', 'BIDDING_VALUE_OUT_OF_RANGE', 'BIDDING_VALUE_NOT_HIGHER',
  'BIDDING_STEP_LIMIT', 'BIDDING_COUNTER_LIMIT', 'BIDDING_ABORT_NOT_AUTHORIZED', 'BIDDING_RESULT_INVALID',
  'BIDDING_AUDIENCE_INVALID', 'BIDDING_RELEASE_INVALID', 'BIDDING_RELEASE_FORBIDDEN', 'BIDDING_PROJECTION_INVALID',
] as const;
export type BiddingErrorCode = typeof BIDDING_ERROR_CODES[number];

export class BiddingError extends Error {
  readonly code: BiddingErrorCode;
  readonly issues: readonly BiddingIssueCode[];
  constructor(code: BiddingErrorCode, issues: readonly BiddingIssueCode[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'BiddingError';
  }
}

// ── Field schemas (shared by the client projection and the server-private state) ─────────────

export const BiddingActorIdSchema = z.string().min(1).max(BIDDING_MAX_ID_LENGTH);
/** Opaque server-side label (bidding id, sequence id, revisions). Must not encode a category, a bid, a team order or a hash of private data. */
export const BiddingRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(BIDDING_MAX_REF_LENGTH);
export const BiddingRunIndexSchema = z.number().int().safe().positive();
export const BiddingRoundIdSchema = z.string().min(1).max(BIDDING_MAX_ID_LENGTH);
export const BiddingPhaseSchema = z.enum(BIDDING_PHASES);
export const BiddingCounterSchema = z.number().int().safe().min(0).max(BIDDING_MAX_COUNTER);
export const BiddingStateVersionSchema = z.number().int().safe().nonnegative();
export const BiddingCategorySchema = z.string().min(1).max(BIDDING_MAX_CATEGORY_LENGTH)
  .refine(text => text === text.trim() && !/[\p{Cc}\p{Cf}]/u.test(text), 'CATEGORY_INVALID');

/**
 * The effective numeric profile of ONE bidding (the N1 input config, stored unchanged in the state): a bid is a positive scaled integer inside [min, max]. The
 * bounds are PUBLIC (a bidder must know what he may enter). A `suggested min/max` of a task is NO hard limit unless the consumer puts it here explicitly.
 */
export const BiddingNumericConfigSchema = NumericInputConfigSchema.refine(config => config.min.units >= 1, { message: 'BID_MUST_BE_POSITIVE' })
  .refine(config => config.boundsDisclosure === 'PUBLIC', { message: 'BOUNDS_MUST_BE_PUBLIC' });
export type BiddingNumericConfig = z.infer<typeof BiddingNumericConfigSchema>;
/** Profile "positive whole number": 1 … 999, no unit. A later game puts its own explicit range (and unit label) here. */
export const BIDDING_NUMERIC_POSITIVE_INTEGER: Readonly<BiddingNumericConfig> = Object.freeze({
  schemaVersion: 1 as const, scale: 0 as const, min: Object.freeze({ units: 1, scale: 0 as const }), max: Object.freeze({ units: 999, scale: 0 as const }), unit: null, boundsDisclosure: 'PUBLIC' as const,
});

/**
 * The TARGET of a bidding: run, round, the bidding instance, the N8 sequence (unit TEAM) with its pinned roster revision, and the pinned role assignment.
 * All labels. The counters of an action are only unique inside ONE such target (a new bidding starts again at version 0, turn 1, sequence version 1).
 */
export const BiddingScopeSchema = z.object({
  runIndex: BiddingRunIndexSchema,
  roundId: BiddingRoundIdSchema,
  biddingId: BiddingRefSchema,
  sequenceId: BiddingRefSchema,
  rosterRevision: BiddingRefSchema,
  rolesRevision: BiddingRefSchema,
}).strict();
export type BiddingScope = z.infer<typeof BiddingScopeSchema>;

// ── Client intents (one value for the own team — nothing else) ─────────────────────────────

/**
 * What a UI action must carry — the COMPLETE ORIGIN of the action, fixed when the intent is made from what the user was shown:
 *   - the TARGET: `scope` (run, round, bidding, N8 sequence, pinned roster revision, pinned roles revision),
 *   - the TEAM the user believes he acts for (an expectation the server compares with the team of the authenticated session — never a permission),
 *   - the COUNTERS: the concrete N8 turn, the N8 sequence version and the bidding version it was shown for.
 * Every field is REQUIRED (an intent without its origin is invalid, never completed from the server's current state). The server compares the target with the
 * trusted state it loads and never inserts its own current target for a missing or different one.
 */
export const BiddingActionBindingSchema = z.object({
  scope: BiddingScopeSchema,
  teamId: BiddingActorIdSchema,
  turnNumber: BiddingCounterSchema.min(1),
  sequenceVersion: BiddingCounterSchema,
  biddingVersion: BiddingCounterSchema,
}).strict();
export type BiddingActionBinding = z.infer<typeof BiddingActionBindingSchema>;
/** A bid carries ONE canonical value (N1: units + scale). No leader, no highest bid, no winner, no history. */
export const BiddingBidIntentSchema = z.object({
  scope: BiddingScopeSchema,
  teamId: BiddingActorIdSchema,
  turnNumber: BiddingCounterSchema.min(1),
  sequenceVersion: BiddingCounterSchema,
  biddingVersion: BiddingCounterSchema,
  value: NumericValueSchema,
}).strict();
export type BiddingBidIntent = z.infer<typeof BiddingBidIntentSchema>;
export const BiddingPassIntentSchema = BiddingActionBindingSchema;
export type BiddingPassIntent = BiddingActionBinding;

/** Local send-lock key of one binding (target, team AND counters). Labels and numbers only. */
export function biddingActionBindingKey(binding: BiddingActionBinding): string {
  const { scope } = binding;
  return JSON.stringify(['BIDDING_BINDING', scope.runIndex, scope.roundId, scope.biddingId, scope.sequenceId, scope.rosterRevision, scope.rolesRevision, binding.teamId, binding.turnNumber, binding.sequenceVersion, binding.biddingVersion]);
}

// ── Client projection ────────────────────────────────────────

const baseShape = {
  contract: z.literal(BIDDING_CONTRACT),
  scope: BiddingScopeSchema,
  /**
   * WHO this projection was made for: the participant id of a PLAYER audience, null for every other audience. The recipient-specific part (`you`) is only valid for
   * exactly this recipient. A UI compares it with the recipient it expects from its OWN session; a packet made for somebody else is no packet for this UI — at every
   * release level, also NEUTRAL.
   */
  recipientId: BiddingActorIdSchema.nullable(),
  /** version of the authoritative snapshot this projection belongs to (NOT a private counter) */
  stateVersion: BiddingStateVersionSchema,
};

/** Team status as released: IN, or PASSED (left for good). The pass order is NOT released. */
export const BiddingTeamViewSchema = z.object({ teamId: BiddingActorIdSchema, status: z.enum(['IN', 'PASSED']), leading: z.boolean() }).strict();
export type BiddingTeamView = z.infer<typeof BiddingTeamViewSchema>;
export const BiddingStandingViewSchema = z.object({ teamId: BiddingActorIdSchema, value: NumericValueSchema }).strict();
export const BiddingOnTurnViewSchema = z.object({ teamId: BiddingActorIdSchema, playerId: BiddingActorIdSchema }).strict();
/** The regular result as released to the STANDING audiences: the winner with the pair of ITS team and the highest bid. No pass evidence, no opponent reference. */
export const BiddingOutcomeViewSchema = z.object({ winnerTeamId: BiddingActorIdSchema, winningValue: NumericValueSchema, bidderId: BiddingActorIdSchema, performerId: BiddingActorIdSchema }).strict();
export type BiddingOutcomeView = z.infer<typeof BiddingOutcomeViewSchema>;
/** The caller's OWN hints (STANDING, PLAYER audience only). Display aids, never a server permission. */
export const BiddingYouViewSchema = z.object({
  /** the team the caller is the PINNED BIDDER of; null when he is no bidder (a host or a player who is neither) */
  teamId: BiddingActorIdSchema.nullable(),
  holdsTurn: z.boolean(),
  canBid: z.boolean(),
  canPass: z.boolean(),
}).strict();
export type BiddingYouView = z.infer<typeof BiddingYouViewSchema>;

export const BiddingProjectionSchema = z.discriminatedUnion('release', [
  z.object({
    ...baseShape, release: z.literal('NEUTRAL'), phase: z.enum(BIDDING_NEUTRAL_PHASES),
    /** only recipient-bound hint of the neutral packet: is the caller the PERFORMER of a team ("Dein Partner verhandelt gerade") — null for non-players */
    you: z.object({ performer: z.boolean() }).strict().nullable(),
  }).strict(),
  z.object({
    ...baseShape, release: z.literal('STANDING'), phase: BiddingPhaseSchema,
    biddingVersion: BiddingCounterSchema,
    /** the CURRENT local version of the N8 sequence (what an action must be bound to) */
    sequenceVersion: BiddingCounterSchema,
    /** identity of the CURRENT N8 turn (0 = no turn has begun) */
    turnNumber: BiddingCounterSchema,
    category: BiddingCategorySchema.nullable(),
    numeric: NumericPublicInputSchema,
    teams: z.array(BiddingTeamViewSchema).min(BIDDING_MIN_TEAMS).max(BIDDING_MAX_TEAMS),
    standing: BiddingStandingViewSchema.nullable(),
    onTurn: BiddingOnTurnViewSchema.nullable(),
    outcome: BiddingOutcomeViewSchema.nullable(),
    endReason: z.enum(BIDDING_END_REASONS).nullable(),
    you: BiddingYouViewSchema.nullable(),
  }).strict(),
]).superRefine((projection, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (projection.release === 'NEUTRAL') {
    if (projection.you !== null && projection.recipientId === null) bad('YOU_RECIPIENT_MISSING');
    return;
  }
  const { phase, teams, standing, onTurn, outcome, endReason, you } = projection;
  const ids = teams.map(team => team.teamId);
  if (new Set(ids).size !== ids.length) bad('TEAMS_DUPLICATE');
  const leading = teams.filter(team => team.leading);
  if (leading.length > 1) bad('LEADERS_MULTIPLE');
  if ((standing === null) !== (leading.length === 0) || (standing !== null && (leading.length !== 1 || leading[0].teamId !== standing.teamId))) bad('STANDING_LEADER_CONFLICT');
  if (teams.some(team => team.leading && team.status === 'PASSED')) bad('PASSED_LEADER');
  if (standing !== null && standing.value.scale !== projection.numeric.scale) bad('STANDING_SCALE_CONFLICT');
  if (onTurn !== null && (phase !== 'OPEN' || !ids.includes(onTurn.teamId))) bad('ONTURN_CONFLICT');
  if (onTurn !== null && teams.some(team => team.teamId === onTurn.teamId && team.status === 'PASSED')) bad('ONTURN_PASSED');
  if (outcome !== null && (phase !== 'CLOSED' || standing === null || outcome.winnerTeamId !== standing.teamId || outcome.winningValue.units !== standing.value.units || outcome.winningValue.scale !== standing.value.scale)) bad('OUTCOME_CONFLICT');
  if ((phase === 'CLOSED') !== (outcome !== null)) bad('OUTCOME_PHASE_CONFLICT');
  if (phase === 'CLOSED' && teams.filter(team => team.status === 'IN').length !== 1) bad('CLOSED_TEAMS_CONFLICT');
  if (phase === 'CLOSED' && endReason !== 'COMPLETED') bad('ENDREASON_CONFLICT');
  if (phase === 'ABORTED' && (endReason === null || endReason === 'COMPLETED')) bad('ENDREASON_CONFLICT');
  if ((phase === 'PREPARED' || phase === 'OPEN') && endReason !== null) bad('ENDREASON_CONFLICT');
  if (phase === 'PREPARED' && (standing !== null || teams.some(team => team.status === 'PASSED'))) bad('PREPARED_CONFLICT');
  if (you !== null) {
    if (projection.recipientId === null) bad('YOU_RECIPIENT_MISSING');
    if ((you.canBid || you.canPass) && !(you.holdsTurn && phase === 'OPEN' && you.teamId !== null)) bad('YOU_ACT_CONFLICT');
    if (you.holdsTurn && (onTurn === null || you.teamId === null || onTurn.teamId !== you.teamId)) bad('YOU_HOLDS_CONFLICT');
    if (you.canPass && standing === null) bad('YOU_CANPASS_CONFLICT');
    if (you.teamId !== null && !ids.includes(you.teamId)) bad('YOU_TEAM_CONFLICT');
  }
});
export type BiddingProjection = z.infer<typeof BiddingProjectionSchema>;
export type BiddingStandingProjection = Extract<BiddingProjection, { release: 'STANDING' }>;
export type BiddingNeutralProjection = Extract<BiddingProjection, { release: 'NEUTRAL' }>;

export type BiddingProjectionResult = { ok: true; projection: BiddingProjection } | { ok: false; code: 'BIDDING_PROJECTION_INVALID' };
/** Failure carries a code only: no values, no zod paths. Returns a fresh copy. */
export function parseBiddingProjection(raw: unknown): BiddingProjectionResult {
  const parsed = BiddingProjectionSchema.safeParse(raw);
  return parsed.success ? { ok: true, projection: parsed.data } : { ok: false, code: 'BIDDING_PROJECTION_INVALID' };
}

/**
 * What the UI's own authenticated context expects, INDEPENDENTLY of the projection that arrives: the bidding scope, who is looking (`recipientId`: the caller's
 * own participant id, or null for a viewer / display) and `minStateVersion`, the oldest authoritative snapshot version the caller accepts (from its own snapshot
 * channel — never copied out of the incoming projection). The context is ONE bidding instance: a new bidding (new `biddingId`) is a new context.
 */
export interface BiddingExpectedContext extends BiddingScope { recipientId: string | null; minStateVersion: number }

export function biddingProjectionMatches(projection: BiddingProjection, expected: BiddingExpectedContext): boolean {
  const own = projection.scope;
  return own.runIndex === expected.runIndex && own.roundId === expected.roundId && own.biddingId === expected.biddingId && own.sequenceId === expected.sequenceId
    && own.rosterRevision === expected.rosterRevision && own.rolesRevision === expected.rolesRevision
    && projection.recipientId === expected.recipientId
    && Number.isSafeInteger(expected.minStateVersion) && projection.stateVersion >= expected.minStateVersion;
}

/** Public UI context key: the scope and the recipient. Labels only — never a bid, a team list or a counter. */
export function biddingContextKey(expected: BiddingExpectedContext): string {
  return JSON.stringify(['BIDDING', expected.runIndex, expected.roundId, expected.biddingId, expected.sequenceId, expected.rosterRevision, expected.rolesRevision, expected.recipientId]);
}

/** Smallest value that is strictly higher than the standing (or the profile minimum without a standing): one UNIT of the profile's scale. Display aid for the UI. */
export function biddingNextMinimum(numeric: { scale: 0 | 1; bounds: { min: NumericValue } | null }, standing: NumericValue | null): NumericValue | null {
  if (standing !== null) return { units: standing.units + 1, scale: numeric.scale };
  return numeric.bounds === null ? null : { units: numeric.bounds.min.units, scale: numeric.scale };
}
