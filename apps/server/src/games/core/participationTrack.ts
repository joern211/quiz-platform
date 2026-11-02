// ============================================================
// N6 — Participation track (domain building block, SERVER-PRIVATE)
//
// A frozen circle of ACTORS (participants OR teams, never mixed) for one run, with an explicit GAMEPLAY status per actor
// (ACTIVE / ELIMINATED) and an optional, explicitly configured LIVES model. It can outlive rounds: it is bound to run + track
// + pinned roster revision + actor kind, NOT to a round id, and is not recreated at a round transition. The consumer checks
// the current round/phase at its own command boundary.
//
// What this is NOT (the later real consumer must supply it): authentication, admission, membership, rights, phase, timers, the
// decision WHY a life is lost or an actor is eliminated, winners, placements, ties, persistence, CAS, receipts, events. Room /
// admission / connection state (connected, leftAt, kickedAt, bannedAt …) is a different layer and is neither read nor written
// here: a disconnect costs no life, a leave/kick may block current actions at the consumer but decides no gameplay loss, a
// rejoin or device change resets no life and revives nobody. There is no revive / reset / reassign / transfer path.
//
// Status is stored, never derived from lives: an actor can be eliminated explicitly with lives left, or without any life
// model, and under KEEP_ACTIVE an actor can stand at 0 lives and remain ACTIVE. Under ELIMINATE the transition to 0 lives and
// the elimination happen in ONE atomic change (one version step, no ACTIVE/0 intermediate state).
//
// Versions: `version` is a LOCAL optimistic counter of THIS track (starts at 0, +1 per real change). It is not the global game
// `stateVersion` and no database CAS. The consumer maps them: it reads the game state at stateVersion S, calls a mutation with
// the track's expectedVersion, and commits the new track together with the global state event in ONE CAS on S. The helper alone
// proves no exactly-once delivery: a repeated client command is answered by the existing receipt/intent path; a deliberate new
// change carries a new valid expectedVersion.
//
// Clock and randomness: none. Server time is passed in by the caller; reading, validating, projecting and replaying never call a
// clock or an RNG and never re-apply a life loss.
//
// Errors: code only (PARTICIPATION_ERROR_CODES). Issues are code-only too. No life value, bound, actor id, cause, time or raw state
// appears in a message, an issue or a zod path.
// ============================================================

import { z } from 'zod';
import { CoreTurnSchema, type CoreTurn } from '@quiz/shared';
import {
  PARTICIPATION_ELIMINATION_CAUSES, PARTICIPATION_ISSUE_CODES, PARTICIPATION_MAX_ACTORS, PARTICIPATION_MAX_LIVES, PARTICIPATION_RELEASES,
  PARTICIPATION_SCHEMA_VERSION, PARTICIPATION_ZERO_LIVES_POLICIES, PARTICIPATION_CONTRACT,
  ParticipationActorIdSchema, ParticipationActorKindSchema, ParticipationError, ParticipationLivesSchema, ParticipationProjectionSchema,
  ParticipationRefSchema, ParticipationRunIndexSchema, ParticipationScopeSchema, ParticipationStateVersionSchema, ParticipationStatusSchema,
  type ParticipationActorKind, type ParticipationActorView, type ParticipationIssueCode, type ParticipationProjection, type ParticipationRelease,
  type ParticipationScope, type ParticipationStatus,
} from '@quiz/shared/participation';
import { canView, type ProjectionAudience } from './visibility.js';

// ── Persisted state (server-private) ─────────────────────────

/** Lives model: OFF carries no number at all; ON needs explicit bounds and an explicit zero-lives policy (no defaults). */
export const ParticipationConfigSchema = z.discriminatedUnion('livesMode', [
  z.object({ livesMode: z.literal('OFF') }).strict(),
  z.object({
    livesMode: z.literal('ON'),
    maxLives: z.number().int().safe().min(1).max(PARTICIPATION_MAX_LIVES),
    zeroLivesPolicy: z.enum(PARTICIPATION_ZERO_LIVES_POLICIES),
  }).strict(),
]);
export type ParticipationConfig = z.infer<typeof ParticipationConfigSchema>;

const EliminationSchema = z.object({
  /** Server time supplied by the caller at the FIRST elimination. Server-private: never projected, never decisive. */
  atMs: z.number().int().safe().nonnegative(),
  cause: z.enum(PARTICIPATION_ELIMINATION_CAUSES),
}).strict();
const ActorSchema = z.object({
  actorId: ParticipationActorIdSchema,
  status: ParticipationStatusSchema,
  /** null ⇔ no life model. A real number (0 included) ⇔ life model. */
  lives: ParticipationLivesSchema.nullable(),
  elimination: EliminationSchema.nullable(),
}).strict();

/**
 * The persisted track. Everything in it is SERVER-PRIVATE. Loading re-validates structure AND invariants; a damaged state is
 * rejected as a whole — nothing is repaired, completed, clamped or reactivated.
 */
export const ParticipationTrackStateSchema = z.object({
  kind: z.literal('PARTICIPATION_TRACK'),
  schemaVersion: z.literal(PARTICIPATION_SCHEMA_VERSION),
  runIndex: ParticipationRunIndexSchema,
  trackId: ParticipationRefSchema,
  /** Opaque revision of the frozen roster AND configuration. */
  rosterRevision: ParticipationRefSchema,
  /** One kind per track; part of the checked scope. */
  actorKind: ParticipationActorKindSchema,
  /** Local optimistic change counter (see header). Starts at 0, +1 per real change. */
  version: ParticipationStateVersionSchema,
  config: ParticipationConfigSchema,
  /** The pinned circle in its fixed order (the order of the creator is kept; it is the public output order). */
  actors: z.array(ActorSchema).min(1).max(PARTICIPATION_MAX_ACTORS),
}).strict().superRefine((state, ctx) => {
  const bad = (code: ParticipationIssueCode) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: code });
  // Refinements also run for "dirty" (e.g. over-long) arrays: bound BEFORE any cross-comparison.
  if (state.actors.length > PARTICIPATION_MAX_ACTORS) { bad('LIMIT_EXCEEDED'); return; }
  if (new Set(state.actors.map(actor => actor.actorId)).size !== state.actors.length) bad('ACTOR_DUPLICATE');
  let eliminated = 0;
  for (const actor of state.actors) {
    const on = state.config.livesMode === 'ON';
    if (!on && actor.lives !== null) bad('LIVES_MODEL_CONFLICT');
    if (on && actor.lives === null) bad('LIVES_MODEL_CONFLICT');
    if (state.config.livesMode === 'ON' && actor.lives !== null) {
      if (actor.lives > state.config.maxLives) bad('LIVES_OUT_OF_RANGE');
      if (actor.status === 'ACTIVE' && actor.lives === 0 && state.config.zeroLivesPolicy === 'ELIMINATE') bad('ZERO_LIVES_CONFLICT'); // never ACTIVE/0 under ELIMINATE
    }
    if ((actor.status === 'ELIMINATED') !== (actor.elimination !== null)) bad('ELIMINATION_CONFLICT');
    if (actor.status === 'ELIMINATED') eliminated++;
    if (actor.elimination?.cause === 'ZERO_LIVES' && !(state.config.livesMode === 'ON' && state.config.zeroLivesPolicy === 'ELIMINATE' && actor.lives === 0)) bad('ELIMINATION_CONFLICT');
  }
  if (state.version < eliminated) bad('ELIMINATION_CONFLICT'); // every elimination is one version step
});
export type ParticipationTrackState = z.infer<typeof ParticipationTrackStateSchema>;

/** Only our own custom codes survive; every structural zod message (which may echo input) becomes SHAPE_INVALID. */
function issueCodesOf(error: z.ZodError): ParticipationIssueCode[] {
  const known = PARTICIPATION_ISSUE_CODES as readonly string[];
  const codes: ParticipationIssueCode[] = [];
  for (const issue of error.issues) {
    const code = (issue.code === 'custom' && known.includes(issue.message) ? issue.message : 'SHAPE_INVALID') as ParticipationIssueCode;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** Validates a stored / loaded track. Damaged or manipulated → PARTICIPATION_STATE_INVALID; nothing is repaired. */
export function parseParticipationTrackState(raw: unknown): ParticipationTrackState {
  const parsed = ParticipationTrackStateSchema.safeParse(raw);
  if (!parsed.success) throw new ParticipationError('PARTICIPATION_STATE_INVALID', issueCodesOf(parsed.error));
  return parsed.data;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => own.includes(key));
};

// ── Creation ─────────────────────────────────────────────────

const TRACK_INPUT_KEYS = ['runIndex', 'trackId', 'rosterRevision', 'actorKind', 'config', 'actors'] as const;

/**
 * Creates a NEW track from an explicit roster and an explicit configuration; everybody starts ACTIVE, version 0, no history.
 * Every actor lists its start lives explicitly (`null` with the life model OFF — never an invented number; a number with it ON).
 * There is no default start value, no default bound and no default zero-lives policy. Under ELIMINATE a start value of 0 is an
 * invalid combination (ACTIVE/0) and is rejected, never repaired; under KEEP_ACTIVE 0 is valid. Anything unknown, duplicated,
 * missing or additional rejects the whole input. A rematch / new run / deliberately new track is created here again from freshly
 * passed data — nothing is taken over from an earlier game. The input is not retained.
 */
export function createParticipationTrack(input: unknown): ParticipationTrackState {
  const invalid = (issues: ParticipationIssueCode[] = ['SHAPE_INVALID']) => new ParticipationError('PARTICIPATION_TRACK_INVALID', issues);
  if (!isPlain(input) || !hasExactKeys(input, TRACK_INPUT_KEYS)) throw invalid();
  const rawActors: unknown = input.actors;
  if (!Array.isArray(rawActors)) throw invalid();
  if (rawActors.length > PARTICIPATION_MAX_ACTORS) throw invalid(['LIMIT_EXCEEDED']); // bound before touching the entries
  const actors: unknown[] = [];
  for (const entry of rawActors as unknown[]) {
    if (!isPlain(entry) || !hasExactKeys(entry, ['actorId', 'lives'])) throw invalid();
    actors.push({ actorId: entry.actorId, status: 'ACTIVE', lives: entry.lives, elimination: null });
  }
  const parsed = ParticipationTrackStateSchema.safeParse({
    kind: 'PARTICIPATION_TRACK', schemaVersion: PARTICIPATION_SCHEMA_VERSION,
    runIndex: input.runIndex, trackId: input.trackId, rosterRevision: input.rosterRevision, actorKind: input.actorKind,
    version: 0, config: input.config, actors,
  });
  if (!parsed.success) throw invalid(issueCodesOf(parsed.error));
  return parsed.data;
}

// ── Scope ────────────────────────────────────────────────────

/** What the caller currently considers authoritative (from its own server-side context); any difference means stale / wrong. */
export type ParticipationTrackScope = ParticipationScope;
export function participationScopeOf(state: ParticipationTrackState): ParticipationTrackScope {
  return { runIndex: state.runIndex, trackId: state.trackId, rosterRevision: state.rosterRevision, actorKind: state.actorKind };
}

/**
 * ONE error semantics for every mutation, query and projection (a stale access is rejected, never answered "empty"):
 * malformed scope → PARTICIPATION_SCOPE_INVALID; another run → PARTICIPATION_RUN_STALE; another track of the same run →
 * PARTICIPATION_TRACK_STALE; another pinned roster/configuration revision → PARTICIPATION_ROSTER_STALE; another actor kind (an
 * equal id text in a PARTICIPANT and a TEAM track is never the same actor) → PARTICIPATION_KIND_MISMATCH. The consumer maps all of
 * them to "stale / resync" without any detail. A historical roster is no authentication.
 */
function assertScope(state: ParticipationTrackState, expected: unknown): void {
  const scope = ParticipationScopeSchema.safeParse(expected);
  if (!scope.success) throw new ParticipationError('PARTICIPATION_SCOPE_INVALID');
  if (state.runIndex !== scope.data.runIndex) throw new ParticipationError('PARTICIPATION_RUN_STALE');
  if (state.trackId !== scope.data.trackId) throw new ParticipationError('PARTICIPATION_TRACK_STALE');
  if (state.rosterRevision !== scope.data.rosterRevision) throw new ParticipationError('PARTICIPATION_ROSTER_STALE');
  if (state.actorKind !== scope.data.actorKind) throw new ParticipationError('PARTICIPATION_KIND_MISMATCH');
}
function assertTime(now: unknown): number {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) throw new ParticipationError('PARTICIPATION_TIME_INVALID');
  return now;
}
function assertVersion(state: ParticipationTrackState, expectedVersion: unknown): void {
  // a malformed expectedVersion can never equal the stored counter: it is rejected with the same code (fail closed)
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion !== state.version) throw new ParticipationError('PARTICIPATION_VERSION_STALE');
}
const indexOfActor = (state: ParticipationTrackState, actorId: unknown): number => typeof actorId === 'string' ? state.actors.findIndex(actor => actor.actorId === actorId) : -1;

// ── Mutations ────────────────────────────────────────────────

/**
 * The small SERVER-PRIVATE before/after record of one real change, so the later consumer can build an existing SDK state
 * event. Never send it to a client, a log or a public history.
 */
export interface ParticipationTransition {
  actorKind: ParticipationActorKind; actorId: string;
  statusBefore: ParticipationStatus; statusAfter: ParticipationStatus;
  livesBefore: number | null; livesAfter: number | null;
  versionBefore: number; versionAfter: number;
}
export interface ParticipationChange { state: ParticipationTrackState; changed: boolean; transition: ParticipationTransition | null }

function applyChange(state: ParticipationTrackState, index: number, next: z.infer<typeof ActorSchema>): ParticipationChange {
  const before = state.actors[index];
  const actors = state.actors.map((actor, i) => (i === index ? next : { ...actor, elimination: actor.elimination === null ? null : { ...actor.elimination } }));
  const committed = parseParticipationTrackState({ ...state, version: state.version + 1, actors }); // validated once more, fresh object
  return {
    state: committed, changed: true,
    transition: {
      actorKind: state.actorKind, actorId: next.actorId, statusBefore: before.status, statusAfter: next.status,
      livesBefore: before.lives, livesAfter: next.lives, versionBefore: state.version, versionAfter: state.version + 1,
    },
  };
}

/**
 * Changes the lives of ONE known, currently ACTIVE actor by an explicit non-zero integer delta. Order of checks: stored data →
 * argument shape → scope → expectedVersion → time → actor → life model → actor status → delta → bounds. On ANY failure nothing
 * changes (no partial state, no version step).
 * - Only with the life model ON. There is no clamping: a result below 0 or above maxLives rejects the whole call; how a later
 *   engine expresses larger damage is its own explicit decision. A positive delta is an explicit change inside the bounds — no
 *   healing mechanic and no revival: an ELIMINATED actor takes no life change at all, not even a positive one.
 * - No unsafe integer arithmetic: overflow is checked against the remaining headroom BEFORE any addition.
 * - Under ELIMINATE a result of 0 sets lives to 0 and the status to ELIMINATED (cause ZERO_LIVES, `now` as time) in the SAME
 *   return: one version step, no ACTIVE/0 intermediate state. Under KEEP_ACTIVE the actor stays ACTIVE at 0 and nothing else
 *   happens (no phase, no winner).
 * - `now` is caller-supplied server time (safe non-negative integer) and is validated on every call, used or not.
 * - A second application with the OLD version on the already updated state is rejected and takes no further life.
 */
export function changeLives(rawState: unknown, args: { scope: ParticipationTrackScope; expectedVersion: number; actorId: string; delta: number; now: number }): ParticipationChange {
  const state = parseParticipationTrackState(rawState);
  if (!isPlain(args) || !hasExactKeys(args, ['scope', 'expectedVersion', 'actorId', 'delta', 'now'])) throw new ParticipationError('PARTICIPATION_ARGS_INVALID');
  assertScope(state, args.scope);
  assertVersion(state, args.expectedVersion);
  const now = assertTime(args.now);
  const index = indexOfActor(state, args.actorId);
  if (index < 0) throw new ParticipationError('PARTICIPATION_ACTOR_UNKNOWN');
  if (state.config.livesMode !== 'ON') throw new ParticipationError('PARTICIPATION_LIVES_DISABLED');
  const actor = state.actors[index];
  if (actor.status !== 'ACTIVE') throw new ParticipationError('PARTICIPATION_ACTOR_ELIMINATED');
  const delta: unknown = args.delta;
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || delta === 0) throw new ParticipationError('PARTICIPATION_DELTA_INVALID');
  const lives = actor.lives as number; // ON ⇒ a number (validated)
  if (delta < -lives || delta > state.config.maxLives - lives) throw new ParticipationError('PARTICIPATION_LIVES_OUT_OF_RANGE'); // no addition, no clamping
  const next = lives + delta;
  const knockedOut = next === 0 && state.config.zeroLivesPolicy === 'ELIMINATE';
  return applyChange(state, index, {
    actorId: actor.actorId, lives: next,
    status: knockedOut ? 'ELIMINATED' : 'ACTIVE',
    elimination: knockedOut ? { atMs: now, cause: 'ZERO_LIVES' } : null,
  });
}

/**
 * Explicitly eliminates ONE known actor. Changes the gameplay status only: positive remaining lives stay, `lives: null` stays
 * null — no life loss is invented. Order of checks as in `changeLives` (stored data → arguments → scope → expectedVersion → time →
 * actor). Eliminating an already ELIMINATED actor in a valid CURRENT context is a no-op: `changed: false`, same version, the FIRST
 * elimination time and cause stay. A stale scope or version is rejected BEFORE that no-op is considered, so a repeat is never
 * accepted merely because it looks harmless. There is no revive; ELIMINATED does not touch role, admission or connection state,
 * N4 eligibility pinned in a poll, or N5 knowledge rights.
 */
export function eliminateActor(rawState: unknown, args: { scope: ParticipationTrackScope; expectedVersion: number; actorId: string; now: number }): ParticipationChange {
  const state = parseParticipationTrackState(rawState);
  if (!isPlain(args) || !hasExactKeys(args, ['scope', 'expectedVersion', 'actorId', 'now'])) throw new ParticipationError('PARTICIPATION_ARGS_INVALID');
  assertScope(state, args.scope);
  assertVersion(state, args.expectedVersion);
  const now = assertTime(args.now);
  const index = indexOfActor(state, args.actorId);
  if (index < 0) throw new ParticipationError('PARTICIPATION_ACTOR_UNKNOWN');
  const actor = state.actors[index];
  if (actor.status === 'ELIMINATED') return { state, changed: false, transition: null };
  return applyChange(state, index, { actorId: actor.actorId, lives: actor.lives, status: 'ELIMINATED', elimination: { atMs: now, cause: 'EXPLICIT' } });
}

// ── Activity queries and turn preparation (H helpers, no authentication) ─────────────

export type ParticipationPlayStatus = ParticipationStatus | 'UNKNOWN';
/**
 * The GAMEPLAY status of one actor in the checked track: ACTIVE, ELIMINATED, or UNKNOWN (not on the track, wrong type of id).
 * It authenticates nobody and grants no platform permission. The consumer must combine it with (1) the current session /
 * membership / team assignment / rights / phase / timer — which includes the room-level `active` flag of `CoreActionContext`
 * (admission, leftAt, kickedAt, bannedAt; layer B) — and (2) this gameplay activity for exactly this action. A kicked or left
 * participant who is still ACTIVE here is NOT an admissible actor; an administratively allowed host action may stay allowed
 * independent of any status here. VIEWER, DISPLAY or a host are not turned into acting players by this helper.
 */
export function actorPlayStatus(rawState: unknown, scope: ParticipationTrackScope, actorId: string): ParticipationPlayStatus {
  const state = parseParticipationTrackState(rawState);
  assertScope(state, scope);
  const index = indexOfActor(state, actorId);
  return index < 0 ? 'UNKNOWN' : state.actors[index].status;
}
/** True only for a known, currently ACTIVE actor. Unknown and eliminated actors are never active. */
export function isActorActive(rawState: unknown, scope: ParticipationTrackScope, actorId: string): boolean {
  return actorPlayStatus(rawState, scope, actorId) === 'ACTIVE';
}
/** The ACTIVE actors in the fixed roster order of the track. One remaining actor is a valid result — never a winner; none is `[]`. */
export function activeActorIds(rawState: unknown, scope: ParticipationTrackScope): string[] {
  const state = parseParticipationTrackState(rawState);
  assertScope(state, scope);
  return state.actors.filter(actor => actor.status === 'ACTIVE').map(actor => actor.actorId);
}

function checkedOrder(state: ParticipationTrackState, order: unknown): string[] {
  const bad = (code: ParticipationIssueCode) => new ParticipationError('PARTICIPATION_ORDER_INVALID', [code]);
  if (!Array.isArray(order)) throw new ParticipationError('PARTICIPATION_ORDER_INVALID', ['SHAPE_INVALID']);
  if (order.length === 0) throw bad('ORDER_EMPTY');
  if (order.length > PARTICIPATION_MAX_ACTORS) throw bad('LIMIT_EXCEEDED'); // bound before building any set
  const known = new Set(state.actors.map(actor => actor.actorId));
  const seen = new Set<string>();
  for (const entry of order as unknown[]) {
    if (typeof entry !== 'string') throw new ParticipationError('PARTICIPATION_ORDER_INVALID', ['SHAPE_INVALID']);
    if (!known.has(entry)) throw bad('ORDER_UNKNOWN_ACTOR'); // an unknown entry (also an id of another actor kind) is never silently a valid turn
    if (seen.has(entry)) throw bad('ORDER_DUPLICATE');
    seen.add(entry);
  }
  return [...(order as string[])];
}

/**
 * Filters an explicitly passed fixed order to the ACTIVE actors, keeping the given order. Eliminated actors are skipped, not
 * removed from any history. The order is validated, never re-sorted or shuffled: empty, duplicated or unknown entries (also ids
 * of another actor kind) reject the call. A single remaining actor is a valid result; no active actor gives `[]`.
 */
export function activeActorsInOrder(rawState: unknown, scope: ParticipationTrackScope, order: readonly string[]): string[] {
  const state = parseParticipationTrackState(rawState);
  assertScope(state, scope);
  const checked = checkedOrder(state, order);
  const active = new Set(state.actors.filter(actor => actor.status === 'ACTIVE').map(actor => actor.actorId));
  return checked.filter(id => active.has(id));
}

export type ParticipationTurnSearch =
  | { kind: 'FOUND'; turn: CoreTurn; skippedActorIds: string[]; wrapped: boolean }
  | { kind: 'NONE' };
/**
 * Finds the next ACTIVE actor in an existing CoreTurn (same `{ mode, order, index, cycle }` convention as `advanceTurn`) and
 * returns a NEW CoreTurn pointing at it. The order and mode are never re-sorted, re-drawn or changed by a disconnect.
 * - `includeCurrent: false` (the usual "advance"): the search starts at `index + 1`; `true`: at `index` itself (e.g. the current
 *   actor was just eliminated, or a turn is being (re)established).
 * - At most ONE full cycle (`order.length` positions) is examined — no endless loop. With `includeCurrent: false` the current
 *   position is examined LAST, so a single remaining active actor who is also the current one is found again after a full wrap.
 * - `cycle` increases by one each time the search passes the end of the order (the same convention as `advanceTurn`); `wrapped`
 *   says so. `skippedActorIds` lists the eliminated actors that were stepped over, in search order.
 * - No active actor → `{ kind: 'NONE' }` (the turn is not touched, no fallback, no `undefined`). One remaining actor is not a winner.
 */
export function findNextActiveTurn(rawState: unknown, scope: ParticipationTrackScope, turn: CoreTurn, options: { includeCurrent: boolean }): ParticipationTurnSearch {
  const state = parseParticipationTrackState(rawState);
  assertScope(state, scope);
  if (!isPlain(options) || !hasExactKeys(options, ['includeCurrent']) || typeof options.includeCurrent !== 'boolean') throw new ParticipationError('PARTICIPATION_ARGS_INVALID');
  const parsedTurn = CoreTurnSchema.safeParse(turn);
  if (!parsedTurn.success) throw new ParticipationError('PARTICIPATION_ORDER_INVALID', ['SHAPE_INVALID']);
  const order = checkedOrder(state, parsedTurn.data.order);
  const active = new Set(state.actors.filter(actor => actor.status === 'ACTIVE').map(actor => actor.actorId));
  const start = parsedTurn.data;
  const skipped: string[] = [];
  let cycle = start.cycle;
  let index = start.index;
  for (let step = options.includeCurrent ? 0 : 1; step <= order.length - (options.includeCurrent ? 1 : 0); step++) {
    const position = start.index + step;
    index = position % order.length;
    cycle = start.cycle + Math.floor(position / order.length);
    const id = order[index];
    if (active.has(id)) return { kind: 'FOUND', turn: { mode: start.mode, order, index, cycle }, skippedActorIds: skipped, wrapped: cycle > start.cycle };
    skipped.push(id);
  }
  return { kind: 'NONE' };
}

// ── Projection ───────────────────────────────────────────────

const INFORMATION_ROLES = ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'];

/**
 * Projection for ONE caller through a small allowlist (no spread of the private state); the result is re-checked against the strict
 * client schema (`safeParse`, never a ZodError). `audience` must come from the server's admission/session path — the information
 * role is the CURRENT game role: a playing host or administrator is projected with PLAYER; `ProjectionAudience` has no ADMIN entry and
 * none is added. An unknown role or malformed id → PARTICIPATION_AUDIENCE_INVALID. A known team id or participant id alone is
 * no authentication: the consumer must have derived `teamId` / `participantId` from the CURRENT admitted session and team assignment.
 * - `own`: the caller's own record (status AND lives, `NO_MODEL` without a life model) through the existing visibility rules —
 *   PLAYER_PRIVATE for a PARTICIPANT track (participantId), TEAM_PRIVATE for a TEAM track (teamId of a PLAYER). A team partner sees
 *   the team's record in a team track and nothing private in a participant track. No membership list is ever included.
 * - `public`: explicitly released by the server for everybody (`release`, REQUIRED, no default): NONE → [] (no derived sums either);
 *   STATUS → status only, lives HIDDEN (no value, bound, start value, cause, time); STATUS_AND_LIVES → status and the current
 *   lives (`NO_MODEL` without a life model, never an invented 0). Actor ids and their order appear only here, only when released.
 * - HOST (blind or not), VIEWER and DISPLAY get no own record, only the released public part. No full host preview in N6.
 * - `stateVersion` is the authoritative game snapshot version the caller binds this to (safe non-negative integer from the
 *   consumer's snapshot); it is NOT the private track `version` and nothing is derived from it.
 * Releases are snapshots of the later engine context; knowledge once seen cannot be taken back.
 */
export function projectParticipation(audience: ProjectionAudience, rawState: unknown, args: { scope: ParticipationTrackScope; release: ParticipationRelease; stateVersion: number }): ParticipationProjection {
  const state = parseParticipationTrackState(rawState);
  if (!isPlain(args) || !hasExactKeys(args, ['scope', 'release', 'stateVersion'])) throw new ParticipationError('PARTICIPATION_ARGS_INVALID');
  assertScope(state, args.scope);
  if (typeof args.release !== 'string' || !(PARTICIPATION_RELEASES as readonly string[]).includes(args.release)) throw new ParticipationError('PARTICIPATION_RELEASE_INVALID');
  if (!ParticipationStateVersionSchema.safeParse(args.stateVersion).success) throw new ParticipationError('PARTICIPATION_ARGS_INVALID');
  const bad = () => new ParticipationError('PARTICIPATION_AUDIENCE_INVALID');
  if (!isPlain(audience) || typeof audience.role !== 'string' || !INFORMATION_ROLES.includes(audience.role)) throw bad();
  for (const id of [audience.participantId, audience.teamId] as unknown[]) {
    if (id !== undefined && id !== null && !ParticipationActorIdSchema.safeParse(id).success) throw bad();
  }

  const ownerRule = (actorId: string) => (state.actorKind === 'PARTICIPANT'
    ? ({ scope: 'PLAYER_PRIVATE', ownerParticipantId: actorId } as const)
    : ({ scope: 'TEAM_PRIVATE', ownerTeamId: actorId } as const));
  const livesOf = (lives: number | null): ParticipationActorView['lives'] => (lives === null ? { state: 'NO_MODEL' } : { state: 'VALUE', value: lives });
  const ownActor = state.actors.find(actor => canView(audience, ownerRule(actor.actorId)));
  const own = ownActor ? { actorId: ownActor.actorId, status: ownActor.status, lives: livesOf(ownActor.lives) } : null;
  const shared: ParticipationActorView[] = args.release === 'NONE' ? []
    : state.actors.map(actor => ({ actorId: actor.actorId, status: actor.status, lives: args.release === 'STATUS' ? { state: 'HIDDEN' as const } : livesOf(actor.lives) }));
  const checked = ParticipationProjectionSchema.safeParse({ contract: PARTICIPATION_CONTRACT, scope: participationScopeOf(state), stateVersion: args.stateVersion, own, public: shared });
  if (!checked.success) throw new ParticipationError('PARTICIPATION_STATE_INVALID'); // never a ZodError: its message could echo values
  return checked.data;
}

export { ParticipationError } from '@quiz/shared/participation';
export type { ParticipationProjection, ParticipationScope } from '@quiz/shared/participation';
