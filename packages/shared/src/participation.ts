// ============================================================
// N6 — Participation contract: CLIENT-SAFE part only (technical foundation, no game rules)
//
// Four layers are kept apart and never derived from each other:
//   A) platform / information role (HOST, PLAYER, VIEWER, DISPLAY, administrative ADMIN)
//   B) room / admission / connection state (connected, admission, leftAt, kickedAt, bannedAt …)
//   C) GAMEPLAY status inside one specific run: ACTIVE or ELIMINATED
//   D) lives: an optional number model — NOT a replacement for C
// ELIMINATED is not VIEWER, LEFT, KICKED or disconnected; a disconnect is no life loss and no elimination; a rejoin
// resets no life and revives nobody. Nothing here decides why a game removes a life or an actor.
//
// This file holds what may leave the server: the PROJECTION one caller receives, bounds, enumerations, code-only errors
// and the context binding helpers. The server-private track (full roster, life configuration, elimination causes and
// times, the local change counter) lives in apps/server/src/games/core/participationTrack.ts and must never be imported by
// the browser.
//
// Projection parts (each released explicitly by the server, never a default):
//   own     — the caller's OWN participant (or own TEAM) record: status and lives. Visible only through the existing
//             PLAYER_PRIVATE / TEAM_PRIVATE rules; no team membership list, no self-supplied team id as proof.
//   public  — the explicitly released view of ALL actors: NONE (empty), STATUS (status only, lives HIDDEN) or
//             STATUS_AND_LIVES. There is no "lives public, status secret": a public zero could reveal an elimination under a
//             zero-lives KO policy, so lives are released together with status.
// `stateVersion` is the version of the authoritative game snapshot the caller bound this projection to. It is NOT the
// private local track counter (which would count hidden life losses) and is not shown as game information.
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no parameter properties, and a self-contained
// file without relative imports (as voting.ts / secretInfo.ts).
// ============================================================

import { z } from 'zod';

export const PARTICIPATION_SCHEMA_VERSION = 1 as const;
export const PARTICIPATION_CONTRACT = 'PARTICIPATION_STATUS_V1' as const;

/**
 * Protection bounds, not game rules and not player settings. 100 actors is the upper bound room creation already enforces
 * for `maxPlayers` (http/validators.ts); a team track is bounded by the same number. 1000 lives keeps every value a small
 * integer far from unsafe arithmetic. Bounds are checked BEFORE any cross-comparison.
 */
export const PARTICIPATION_MAX_ACTORS = 100;
export const PARTICIPATION_MAX_ID_LENGTH = 200;
export const PARTICIPATION_MAX_REF_LENGTH = 80;
export const PARTICIPATION_MAX_LIVES = 1000;

export const PARTICIPATION_ACTOR_KINDS = ['PARTICIPANT', 'TEAM'] as const;
export const PARTICIPATION_STATUSES = ['ACTIVE', 'ELIMINATED'] as const;
export const PARTICIPATION_ZERO_LIVES_POLICIES = ['ELIMINATE', 'KEEP_ACTIVE'] as const;
export const PARTICIPATION_RELEASES = ['NONE', 'STATUS', 'STATUS_AND_LIVES'] as const;
/** Small TECHNICAL cause codes (not game reasons, no free text). Server-private; never projected. */
export const PARTICIPATION_ELIMINATION_CAUSES = ['EXPLICIT', 'ZERO_LIVES'] as const;
export type ParticipationActorKind = typeof PARTICIPATION_ACTOR_KINDS[number];
export type ParticipationStatus = typeof PARTICIPATION_STATUSES[number];
export type ParticipationZeroLivesPolicy = typeof PARTICIPATION_ZERO_LIVES_POLICIES[number];
export type ParticipationRelease = typeof PARTICIPATION_RELEASES[number];
export type ParticipationEliminationCause = typeof PARTICIPATION_ELIMINATION_CAUSES[number];

/** Per-issue codes. They never carry a value, an id or a path — only the kind of violation. */
export const PARTICIPATION_ISSUE_CODES = [
  'SHAPE_INVALID', 'LIMIT_EXCEEDED', 'ACTOR_DUPLICATE',
  'LIVES_MODEL_CONFLICT', 'LIVES_OUT_OF_RANGE', 'ZERO_LIVES_CONFLICT', 'ELIMINATION_CONFLICT',
  'ORDER_DUPLICATE', 'ORDER_UNKNOWN_ACTOR', 'ORDER_EMPTY',
] as const;
export type ParticipationIssueCode = typeof PARTICIPATION_ISSUE_CODES[number];

/**
 * Wire error codes (the message of the thrown error equals the code). They carry no life value, bound, roster, actor id or
 * cause. A later consumer reports ONLY the code (plus its own trace id) and keeps the rest server-side.
 */
export const PARTICIPATION_ERROR_CODES = [
  'PARTICIPATION_TRACK_INVALID', 'PARTICIPATION_STATE_INVALID', 'PARTICIPATION_SCOPE_INVALID',
  'PARTICIPATION_RUN_STALE', 'PARTICIPATION_TRACK_STALE', 'PARTICIPATION_ROSTER_STALE', 'PARTICIPATION_KIND_MISMATCH',
  'PARTICIPATION_VERSION_STALE', 'PARTICIPATION_ACTOR_UNKNOWN', 'PARTICIPATION_ACTOR_ELIMINATED',
  'PARTICIPATION_LIVES_DISABLED', 'PARTICIPATION_DELTA_INVALID', 'PARTICIPATION_LIVES_OUT_OF_RANGE',
  'PARTICIPATION_TIME_INVALID', 'PARTICIPATION_ARGS_INVALID', 'PARTICIPATION_ORDER_INVALID',
  'PARTICIPATION_AUDIENCE_INVALID', 'PARTICIPATION_RELEASE_INVALID', 'PARTICIPATION_PROJECTION_INVALID',
] as const;
export type ParticipationErrorCode = typeof PARTICIPATION_ERROR_CODES[number];

export class ParticipationError extends Error {
  readonly code: ParticipationErrorCode;
  readonly issues: readonly ParticipationIssueCode[];
  constructor(code: ParticipationErrorCode, issues: readonly ParticipationIssueCode[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'ParticipationError';
  }
}

// ── Field schemas (shared by the client projection and the server-private state) ─────────────

/** Stable actor identity (participant id or team id). Never a name, a socket id or a list position. */
export const ParticipationActorIdSchema = z.string().min(1).max(PARTICIPATION_MAX_ID_LENGTH);
/** Opaque server-side label (track id, roster revision). Must not encode a roster, a life value or a hash of secret data. */
export const ParticipationRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(PARTICIPATION_MAX_REF_LENGTH);
export const ParticipationRunIndexSchema = z.number().int().safe().positive();
export const ParticipationActorKindSchema = z.enum(PARTICIPATION_ACTOR_KINDS);
export const ParticipationStatusSchema = z.enum(PARTICIPATION_STATUSES);
export const ParticipationLivesSchema = z.number().int().safe().min(0).max(PARTICIPATION_MAX_LIVES);
export const ParticipationStateVersionSchema = z.number().int().safe().nonnegative();

/** The binding of a track: run, track, pinned roster revision and the actor kind. The kind is part of the identity. */
export const ParticipationScopeSchema = z.object({
  runIndex: ParticipationRunIndexSchema,
  trackId: ParticipationRefSchema,
  rosterRevision: ParticipationRefSchema,
  actorKind: ParticipationActorKindSchema,
}).strict();
export type ParticipationScope = z.infer<typeof ParticipationScopeSchema>;

// ── Client projection ────────────────────────────────────────

/**
 * What the caller may know about the lives of one actor. HIDDEN: not released (never to be shown as 0). NO_MODEL: the
 * track has no life model (the explicit null — not an invented 0). VALUE: a released number; 0 is a real value.
 */
export const ParticipationLivesViewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('HIDDEN') }).strict(),
  z.object({ state: z.literal('NO_MODEL') }).strict(),
  z.object({ state: z.literal('VALUE'), value: ParticipationLivesSchema }).strict(),
]);
export type ParticipationLivesView = z.infer<typeof ParticipationLivesViewSchema>;

/** One actor as released to THIS caller: id, status, lives view. No cause, no time, no bound, no start value, no policy. */
export const ParticipationActorViewSchema = z.object({
  actorId: ParticipationActorIdSchema,
  status: ParticipationStatusSchema,
  lives: ParticipationLivesViewSchema,
}).strict();
export type ParticipationActorView = z.infer<typeof ParticipationActorViewSchema>;

export const ParticipationProjectionSchema = z.object({
  contract: z.literal(PARTICIPATION_CONTRACT),
  scope: ParticipationScopeSchema,
  /** Version of the authoritative snapshot this projection belongs to (NOT the private track counter). */
  stateVersion: ParticipationStateVersionSchema,
  /** The caller's own record; its lives are never HIDDEN (own data). null for anybody without an own actor. */
  own: ParticipationActorViewSchema.nullable(),
  /** The explicitly released public part, in the fixed roster order. Empty when nothing is released. */
  public: z.array(ParticipationActorViewSchema).max(PARTICIPATION_MAX_ACTORS),
}).strict().superRefine((projection, ctx) => {
  if (projection.own !== null && projection.own.lives.state === 'HIDDEN') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'OWN_LIVES_HIDDEN' });
  if (new Set(projection.public.map(actor => actor.actorId)).size !== projection.public.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PUBLIC_ACTOR_DUPLICATE' });
});
export type ParticipationProjection = z.infer<typeof ParticipationProjectionSchema>;

export type ParticipationProjectionResult = { ok: true; projection: ParticipationProjection } | { ok: false; code: 'PARTICIPATION_PROJECTION_INVALID' };
/** Failure carries a code only: no values, no zod paths. Returns a fresh copy. */
export function parseParticipationProjection(raw: unknown): ParticipationProjectionResult {
  const parsed = ParticipationProjectionSchema.safeParse(raw);
  return parsed.success ? { ok: true, projection: parsed.data } : { ok: false, code: 'PARTICIPATION_PROJECTION_INVALID' };
}

/**
 * What the UI's own authenticated context expects, INDEPENDENTLY of the projection that arrives: the scope, the actor to
 * show and `minStateVersion`, the oldest authoritative snapshot version the caller will accept (it comes from the caller's
 * own snapshot channel — never copy it out of the incoming projection, that would make a stale projection vouch for itself).
 */
export interface ParticipationExpectedContext extends ParticipationScope { actorId: string; minStateVersion: number }

/** True iff the scope of a (valid) projection equals the expected run, track, roster revision and actor kind, and its snapshot is not older than expected. */
export function participationProjectionMatches(projection: ParticipationProjection, expected: ParticipationExpectedContext): boolean {
  return projection.scope.runIndex === expected.runIndex && projection.scope.trackId === expected.trackId
    && projection.scope.rosterRevision === expected.rosterRevision && projection.scope.actorKind === expected.actorKind
    && Number.isSafeInteger(expected.minStateVersion) && projection.stateVersion >= expected.minStateVersion;
}

export interface ParticipationActorLookup { view: ParticipationActorView; own: boolean }
/**
 * The record of ONE actor in a projection: the own record first (private, with lives), else the explicitly released public
 * entry. null when the projection holds nothing for that actor (a stranger, an unreleased actor, a viewer-like projection).
 */
export function participationActorView(projection: ParticipationProjection, actorId: string): ParticipationActorLookup | null {
  if (projection.own !== null && projection.own.actorId === actorId) return { view: projection.own, own: true };
  const entry = projection.public.find(actor => actor.actorId === actorId);
  return entry ? { view: entry, own: false } : null;
}

/** Public UI context key: run, track, roster revision, actor kind and actor. Labels only — never a life value or a status. */
export function participationContextKey(expected: ParticipationExpectedContext): string {
  return JSON.stringify(['PARTICIPATION', expected.runIndex, expected.trackId, expected.rosterRevision, expected.actorKind, expected.actorId]);
}
