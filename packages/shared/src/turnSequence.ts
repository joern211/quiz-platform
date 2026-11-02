// ============================================================
// N8 — Turn sequence contract: CLIENT-SAFE part only (technical foundation, no game rules)
//
// A sequence of TURNS over players (unit PLAYER) or over teams with one responsible member per turn (unit TEAM). Several layers are kept
// apart and never derived from each other:
//   - the pinned sequence (order, team members) and its LOCAL version,
//   - the identity of the CURRENT turn (`turnNumber`: one counter step per newly begun turn — a player id alone identifies no turn),
//   - the ENTITLEMENT state ("may anybody act right now?", `entitlementRevision`) and the eligibility basis behind it,
//   - the global game `stateVersion` of the caller's own snapshot channel.
// Nothing here decides who wins, who loses a life, how points are given or when a game ends.
//
// This file holds what may leave the server: the PROJECTION one caller receives, bounds, enumerations, code-only errors and the context
// binding helpers. The server-private sequence (full order, team member lists and rotation cursors, eligibility basis, override
// evidence) lives in apps/server/src/games/core/turnSequence.ts and must never be imported by the browser.
//
// Release policy (explicit, no default — chosen by the server per audience):
//   NONE     only the ordering counters. No state, no holder, no order: a withdrawal stays orderable against older knowledge.
//   CURRENT  additionally the state, the current holder (player; in team mode team + player) and the caller's OWN view (`you`).
//   ORDER    additionally the OUTER order (player ids, or team ids) with position and cycle. Team member lists, rotation cursors,
//            eligibility, lives, roles and override reasons are NOT projectable at any level.
// The ordering counters are opaque numbers. They tell nobody who is in the game; the number of participants is never sent.
// `you.canAct` is a DISPLAY AID. The server decides on its own with the current session, phase and eligibility.
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no parameter properties, and a self-contained file without
// relative imports (as participation.ts / audioPlayback.ts).
// ============================================================

import { z } from 'zod';

export const TURN_SEQUENCE_SCHEMA_VERSION = 1 as const;
export const TURN_SEQUENCE_CONTRACT = 'TURN_SEQUENCE_STATUS_V1' as const;

/**
 * Protection bounds, not game rules and not player settings. 100 actors is the upper bound room creation already enforces for
 * `maxPlayers`; a team sequence is bounded by the same number of players in total. Counters are small safe integers far from unsafe
 * arithmetic; bounds are checked BEFORE any cross-comparison.
 */
export const TURN_SEQUENCE_MAX_ACTORS = 100;
export const TURN_SEQUENCE_MAX_ID_LENGTH = 200;
export const TURN_SEQUENCE_MAX_REF_LENGTH = 80;
export const TURN_SEQUENCE_MAX_COUNTER = 1_000_000_000;
export const TURN_SEQUENCE_MAX_REASON_LENGTH = 300;

export const TURN_SEQUENCE_UNITS = ['PLAYER', 'TEAM'] as const;
export const TURN_ORDER_MODES = ['FIXED', 'RANDOM', 'ROTATING_START', 'CUSTOM_HOST_ORDER'] as const;
export const TURN_SEQUENCE_PHASES = ['READY', 'ACTIVE', 'HELD', 'NO_ELIGIBLE', 'CLOSED'] as const;
export const TURN_SEQUENCE_RELEASES = ['NONE', 'CURRENT', 'ORDER'] as const;
export type TurnSequenceUnit = typeof TURN_SEQUENCE_UNITS[number];
export type TurnOrderMode = typeof TURN_ORDER_MODES[number];
export type TurnSequencePhase = typeof TURN_SEQUENCE_PHASES[number];
export type TurnSequenceRelease = typeof TURN_SEQUENCE_RELEASES[number];

/** Per-issue codes. They never carry a value, an id or a path — only the kind of violation. */
export const TURN_SEQUENCE_ISSUE_CODES = [
  'SHAPE_INVALID', 'LIMIT_EXCEEDED', 'ACTOR_DUPLICATE', 'ORDER_EMPTY', 'ORDER_UNKNOWN_ACTOR', 'ORDER_MISSING_ACTOR', 'ORDER_DUPLICATE',
  'TEAM_DUPLICATE', 'MEMBER_DUPLICATE', 'TEAM_EMPTY', 'TEAMS_CONFLICT', 'POSITION_INVALID', 'CURSOR_INVALID', 'PHASE_CONFLICT', 'COUNTER_CONFLICT',
] as const;
export type TurnSequenceIssueCode = typeof TURN_SEQUENCE_ISSUE_CODES[number];

/**
 * Wire error codes (the message of the thrown error equals the code). They carry no order, roster, member list, actor id, cursor or
 * reason. A later consumer reports ONLY the code (plus its own trace id) and keeps the rest server-side. The TURN_SEQ_ prefix keeps
 * them apart from the older TURN_OWNER_CONFLICT of the single-owner CoreTurn.
 */
export const TURN_SEQUENCE_ERROR_CODES = [
  'TURN_SEQ_INVALID', 'TURN_SEQ_STATE_INVALID', 'TURN_SEQ_ARGS_INVALID', 'TURN_SEQ_TIME_INVALID',
  'TURN_SEQ_SCOPE_INVALID', 'TURN_SEQ_RUN_STALE', 'TURN_SEQ_SEQUENCE_STALE', 'TURN_SEQ_ROSTER_STALE', 'TURN_SEQ_UNIT_MISMATCH',
  'TURN_SEQ_VERSION_STALE', 'TURN_SEQ_TURN_STALE',
  'TURN_SEQ_NOT_STARTED', 'TURN_SEQ_ALREADY_STARTED', 'TURN_SEQ_CLOSED', 'TURN_SEQ_HELD', 'TURN_SEQ_NO_CURRENT', 'TURN_SEQ_OUTCOME_INVALID',
  'TURN_SEQ_ELIGIBILITY_INVALID', 'TURN_SEQ_ELIGIBILITY_STALE', 'TURN_SEQ_ELIGIBILITY_MISMATCH', 'TURN_SEQ_HOLDER_STILL_ELIGIBLE',
  'TURN_SEQ_ACTOR_UNKNOWN', 'TURN_SEQ_ACTOR_NOT_ELIGIBLE', 'TURN_SEQ_TEAM_MEMBER_MISMATCH',
  'TURN_SEQ_ORDER_INVALID', 'TURN_SEQ_PREVIOUS_START_INVALID',
  'TURN_SEQ_ROLE_NOT_ALLOWED', 'TURN_SEQ_ACTION_BLOCKED', 'TURN_SEQ_NOT_CURRENT_ACTOR',
  'TURN_SEQ_AUDIENCE_INVALID', 'TURN_SEQ_RELEASE_INVALID', 'TURN_SEQ_PROJECTION_INVALID',
] as const;
export type TurnSequenceErrorCode = typeof TURN_SEQUENCE_ERROR_CODES[number];

export class TurnSequenceError extends Error {
  readonly code: TurnSequenceErrorCode;
  readonly issues: readonly TurnSequenceIssueCode[];
  constructor(code: TurnSequenceErrorCode, issues: readonly TurnSequenceIssueCode[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'TurnSequenceError';
  }
}

// ── Field schemas (shared by the client projection and the server-private state) ─────────────

/** Stable actor identity (participant id or team id). Never a name, a socket id or a list position. */
export const TurnSequenceActorIdSchema = z.string().min(1).max(TURN_SEQUENCE_MAX_ID_LENGTH);
/** Opaque server-side label (sequence id, roster revision). Must not encode a roster, an order or a hash of private data. */
export const TurnSequenceRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(TURN_SEQUENCE_MAX_REF_LENGTH);
export const TurnSequenceRunIndexSchema = z.number().int().safe().positive();
export const TurnSequenceUnitSchema = z.enum(TURN_SEQUENCE_UNITS);
export const TurnSequencePhaseSchema = z.enum(TURN_SEQUENCE_PHASES);
export const TurnSequenceCounterSchema = z.number().int().safe().min(0).max(TURN_SEQUENCE_MAX_COUNTER);
export const TurnSequenceStateVersionSchema = z.number().int().safe().nonnegative();

/** The binding of a sequence: run, sequence, pinned roster revision and unit. The unit is part of the identity. */
export const TurnSequenceScopeSchema = z.object({
  runIndex: TurnSequenceRunIndexSchema,
  sequenceId: TurnSequenceRefSchema,
  rosterRevision: TurnSequenceRefSchema,
  unit: TurnSequenceUnitSchema,
}).strict();
export type TurnSequenceScope = z.infer<typeof TurnSequenceScopeSchema>;

// ── Client projection ────────────────────────────────────────

/** The current holder as released: the player and, in team mode, the team he acts for in THIS turn. No member list, no cursor. */
export const TurnHolderViewSchema = z.object({
  teamId: TurnSequenceActorIdSchema.nullable(),
  playerId: TurnSequenceActorIdSchema,
}).strict();
export type TurnHolderView = z.infer<typeof TurnHolderViewSchema>;

/** The caller's OWN view. `canAct` is a display aid (state ACTIVE and the caller holds the turn), never a server permission. */
export const TurnYouViewSchema = z.object({
  holdsTurn: z.boolean(),
  /** team mode: does the caller's team hold the turn (the caller may only advise); null in player mode */
  teamHoldsTurn: z.boolean().nullable(),
  canAct: z.boolean(),
}).strict();
export type TurnYouView = z.infer<typeof TurnYouViewSchema>;

/** The outer order as released (player ids, or team ids). Never team members, never cursors. */
export const TurnOrderViewSchema = z.object({
  actorIds: z.array(TurnSequenceActorIdSchema).min(1).max(TURN_SEQUENCE_MAX_ACTORS),
  position: TurnSequenceCounterSchema.nullable(),
  cycle: TurnSequenceCounterSchema,
}).strict();
export type TurnOrderView = z.infer<typeof TurnOrderViewSchema>;

const baseShape = {
  contract: z.literal(TURN_SEQUENCE_CONTRACT),
  scope: TurnSequenceScopeSchema,
  /**
   * WHO this projection was made for: the participant id of a PLAYER audience, null for every other audience (host, viewer, display). The
   * recipient-specific part (`you`) is only valid for exactly this recipient. A UI compares it with the recipient it expects from its OWN
   * authenticated session; a packet made for somebody else is no packet for this UI — at every release level, also NONE.
   */
  recipientId: TurnSequenceActorIdSchema.nullable(),
  /** Version of the authoritative snapshot this projection belongs to (NOT the private local counter). */
  stateVersion: TurnSequenceStateVersionSchema,
  /** local sequence version */
  sequenceVersion: TurnSequenceCounterSchema,
  /** identity of the current turn (0 = no turn has begun) */
  turnNumber: TurnSequenceCounterSchema,
  /** counts only the changes of "may anybody act?" */
  entitlementRevision: TurnSequenceCounterSchema,
};
const currentShape = {
  status: TurnSequencePhaseSchema,
  current: TurnHolderViewSchema.nullable(),
  you: TurnYouViewSchema.nullable(),
};

export const TurnSequenceProjectionSchema = z.discriminatedUnion('release', [
  z.object({ ...baseShape, release: z.literal('NONE') }).strict(),
  z.object({ ...baseShape, release: z.literal('CURRENT'), ...currentShape }).strict(),
  z.object({ ...baseShape, release: z.literal('ORDER'), ...currentShape, order: TurnOrderViewSchema }).strict(),
]).superRefine((projection, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (projection.release === 'NONE') return;
  const holder = projection.status === 'ACTIVE' || projection.status === 'HELD';
  if (holder !== (projection.current !== null)) bad('CURRENT_STATUS_CONFLICT');
  if (projection.current !== null && (projection.current.teamId !== null) !== (projection.scope.unit === 'TEAM')) bad('CURRENT_UNIT_CONFLICT');
  if (projection.status === 'READY' && projection.turnNumber !== 0) bad('READY_TURN_CONFLICT');
  if (holder && projection.turnNumber < 1) bad('HOLDER_TURN_CONFLICT');
  if (projection.you !== null) {
    if (projection.recipientId === null) bad('YOU_RECIPIENT_MISSING');
    if ((projection.you.teamHoldsTurn !== null) !== (projection.scope.unit === 'TEAM')) bad('YOU_UNIT_CONFLICT');
    if (projection.you.canAct && !(projection.status === 'ACTIVE' && projection.you.holdsTurn)) bad('YOU_CANACT_CONFLICT');
    if (projection.you.holdsTurn && (projection.current === null || projection.you.teamHoldsTurn === false)) bad('YOU_HOLDS_CONFLICT');
  }
  if (projection.release === 'ORDER') {
    const ids = projection.order.actorIds;
    if (new Set(ids).size !== ids.length) bad('ORDER_DUPLICATE');
    if (projection.order.position !== null && projection.order.position >= ids.length) bad('ORDER_POSITION_INVALID');
    if (projection.order.position === null && projection.turnNumber > 0) bad('ORDER_POSITION_MISSING');
  }
});
export type TurnSequenceProjection = z.infer<typeof TurnSequenceProjectionSchema>;

export type TurnSequenceProjectionResult = { ok: true; projection: TurnSequenceProjection } | { ok: false; code: 'TURN_SEQ_PROJECTION_INVALID' };
/** Failure carries a code only: no values, no zod paths. Returns a fresh copy. */
export function parseTurnSequenceProjection(raw: unknown): TurnSequenceProjectionResult {
  const parsed = TurnSequenceProjectionSchema.safeParse(raw);
  return parsed.success ? { ok: true, projection: parsed.data } : { ok: false, code: 'TURN_SEQ_PROJECTION_INVALID' };
}

/**
 * What the UI's own authenticated context expects, INDEPENDENTLY of the projection that arrives: the scope, who is looking
 * (`recipientId`: the caller's own participant id, or null for a viewer / display — the `you` part belongs to exactly one recipient) and
 * `minStateVersion`, the oldest authoritative snapshot version the caller will accept (from the caller's own snapshot channel — never
 * copied out of the incoming projection, that would make a stale projection vouch for itself).
 */
export interface TurnSequenceExpectedContext extends TurnSequenceScope { recipientId: string | null; minStateVersion: number }

/**
 * True iff the scope of a (valid) projection equals the expected run, sequence, roster revision and unit, it was made for exactly the expected RECIPIENT
 * (a participant id, or null for host / viewer / display), and its snapshot is not older than expected.
 */
export function turnSequenceProjectionMatches(projection: TurnSequenceProjection, expected: TurnSequenceExpectedContext): boolean {
  return projection.scope.runIndex === expected.runIndex && projection.scope.sequenceId === expected.sequenceId
    && projection.scope.rosterRevision === expected.rosterRevision && projection.scope.unit === expected.unit
    && projection.recipientId === expected.recipientId
    && Number.isSafeInteger(expected.minStateVersion) && projection.stateVersion >= expected.minStateVersion;
}

/** Public UI context key: run, sequence, roster revision, unit and recipient. Labels only — never an order, a holder or a counter. */
export function turnSequenceContextKey(expected: TurnSequenceExpectedContext): string {
  return JSON.stringify(['TURN_SEQUENCE', expected.runIndex, expected.sequenceId, expected.rosterRevision, expected.unit, expected.recipientId]);
}

/** The binding a UI action must carry: the concrete turn and the local sequence version it was shown for. The server compares BOTH. */
export interface TurnActionBinding { turnNumber: number; sequenceVersion: number }
export function turnActionBindingKey(binding: TurnActionBinding): string {
  return JSON.stringify(['TURN_BINDING', binding.turnNumber, binding.sequenceVersion]);
}
