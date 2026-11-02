// ============================================================
// N8 — Turn sequence (domain building block, SERVER-PRIVATE)
//
// A small, validated, serialisable sequence of TURNS: over players (unit PLAYER) or over teams with exactly ONE responsible member per
// turn and a stable rotation inside every team (unit TEAM). It is a building block for later engines (Last Man Standing, Yacht, partner
// challenges). It is NOT an engine: it decides nobody's points, winner, lost life or game end, and it opens no route, socket event, table
// or setup UI. Existing single-owner CoreTurn use (Jeopardy, Wer ist das?) is untouched; see design.md §1 for the mapping.
//
// What it does NOT do (the later real consumer must supply it): authentication, admission, team assignment, rights, pause, phase, the
// current participation status (N6 is the source; see eligibilityFromParticipation), persistence, CAS, receipts, events, audit. A known
// player or team id is not an authorisation; `authorizeTurnAction` only ADDS the turn check to the consumer's own current checks.
//
// Preparation and transition are separate. `decideTurnOrder` is the ONLY place with randomness (existing shuffleServer, once, at
// preparation). `prepareTurnSequence` and every transition work on the already decided result and call no random source or clock;
// loading, replay, projection and rendering never re-decide anything.
//
// Versions (kept apart; see design.md §5): `version` is the LOCAL optimistic counter of THIS sequence (+1 per real change). `turnNumber`
// identifies the concrete turn (+1 per newly begun turn; one player id identifies no turn). `entitlementRevision` counts only changes of
// "may anybody act". None of them is the global game `stateVersion` or a database CAS: the consumer commits the new sequence together
// with the global state event in ONE CAS and under the command receipt. Alone this module guarantees no exactly-once processing.
// ============================================================

import { z } from 'zod';
import type { CoreTurn } from '@quiz/shared';
import {
  TURN_ORDER_MODES, TURN_SEQUENCE_MAX_ACTORS, TURN_SEQUENCE_MAX_REASON_LENGTH, TURN_SEQUENCE_RELEASES,
  TURN_SEQUENCE_SCHEMA_VERSION, TURN_SEQUENCE_CONTRACT, TurnSequenceActorIdSchema, TurnSequenceCounterSchema, TurnSequenceError, TurnSequencePhaseSchema,
  TurnSequenceProjectionSchema, TurnSequenceRefSchema, TurnSequenceRunIndexSchema, TurnSequenceScopeSchema, TurnSequenceStateVersionSchema,
  TurnSequenceUnitSchema, TURN_SEQUENCE_UNITS,
  type TurnOrderMode, type TurnSequenceIssueCode, type TurnSequencePhase, type TurnSequenceProjection, type TurnSequenceRelease, type TurnSequenceScope,
  type TurnSequenceUnit,
} from '@quiz/shared/turnSequence';
import { activeActorIds, parseParticipationTrackState, participationScopeOf, type ParticipationScope } from './participationTrack.js';
import { shuffleServer } from './roundFlow.js';
import { canView, type ProjectionAudience } from './visibility.js';

// ── Helpers ──────────────────────────────────────────────────

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
/** Exact key set: every required key present, no key outside required ∪ optional. */
const keysWithin = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
function args_(condition: boolean): asserts condition { if (!condition) throw new TurnSequenceError('TURN_SEQ_ARGS_INVALID'); }

// ── Server-private state ─────────────────────────────────────

const BasisSchema = z.object({ trackId: TurnSequenceRefSchema, rosterRevision: TurnSequenceRefSchema, version: TurnSequenceCounterSchema }).strict();
const TeamSchema = z.object({
  teamId: TurnSequenceActorIdSchema,
  members: z.array(TurnSequenceActorIdSchema).min(1).max(TURN_SEQUENCE_MAX_ACTORS),
  /** index of the member checked FIRST at the team's next turn; moves only when a team turn is COMPLETED */
  cursor: TurnSequenceCounterSchema,
}).strict();
const OverrideEvidenceSchema = z.object({ atMs: z.number().int().safe().nonnegative(), fromTurnNumber: TurnSequenceCounterSchema, toTurnNumber: TurnSequenceCounterSchema }).strict();

export const TurnSequenceStateSchema = z.object({
  kind: z.literal('TURN_SEQUENCE'),
  schemaVersion: z.literal(TURN_SEQUENCE_SCHEMA_VERSION),
  runIndex: TurnSequenceRunIndexSchema,
  sequenceId: TurnSequenceRefSchema,
  rosterRevision: TurnSequenceRefSchema,
  unit: TurnSequenceUnitSchema,
  mode: z.enum(TURN_ORDER_MODES),
  order: z.array(TurnSequenceActorIdSchema).min(1).max(TURN_SEQUENCE_MAX_ACTORS),
  teams: z.array(TeamSchema).min(1).max(TURN_SEQUENCE_MAX_ACTORS).nullable(),
  phase: TurnSequencePhaseSchema,
  version: TurnSequenceCounterSchema,
  turnNumber: TurnSequenceCounterSchema,
  completedTurns: TurnSequenceCounterSchema,
  cycle: TurnSequenceCounterSchema,
  position: TurnSequenceCounterSchema.nullable(),
  memberIndex: TurnSequenceCounterSchema.nullable(),
  entitlementRevision: TurnSequenceCounterSchema,
  eligibility: z.object({ actors: BasisSchema, members: BasisSchema.nullable() }).strict().nullable(),
  lastOverride: OverrideEvidenceSchema.nullable(),
}).strict();
export type TurnSequenceState = z.infer<typeof TurnSequenceStateSchema>;

/** Cross-field invariants of a structurally valid state (bounds were checked first). Code-only issues. */
function stateIssues(state: TurnSequenceState): TurnSequenceIssueCode[] {
  const issues = new Set<TurnSequenceIssueCode>();
  const add = (code: TurnSequenceIssueCode, condition: boolean) => { if (condition) issues.add(code); };
  const n = state.order.length;
  add('ORDER_DUPLICATE', new Set(state.order).size !== n);
  const team = state.teams !== null && state.position !== null ? state.teams[state.position] : undefined;
  if (state.unit === 'PLAYER') {
    add('TEAMS_CONFLICT', state.teams !== null);
    add('POSITION_INVALID', state.memberIndex !== null);
    add('PHASE_CONFLICT', state.eligibility !== null && state.eligibility.members !== null);
  } else {
    add('TEAMS_CONFLICT', state.teams === null);
    add('PHASE_CONFLICT', state.eligibility !== null && state.eligibility.members === null);
    if (state.teams !== null) {
      add('TEAMS_CONFLICT', state.teams.length !== n || state.teams.some((t, i) => t.teamId !== state.order[i]));
      add('TEAM_DUPLICATE', new Set(state.teams.map(t => t.teamId)).size !== state.teams.length);
      const players = state.teams.flatMap(t => t.members);
      add('LIMIT_EXCEEDED', players.length > TURN_SEQUENCE_MAX_ACTORS);
      add('MEMBER_DUPLICATE', new Set(players).size !== players.length);
      add('MEMBER_DUPLICATE', state.teams.some(t => new Set(t.members).size !== t.members.length));
      add('CURSOR_INVALID', state.teams.some(t => t.cursor >= t.members.length));
    }
  }
  const holder = state.phase === 'ACTIVE' || state.phase === 'HELD';
  add('POSITION_INVALID', state.position !== null && state.position >= n);
  add('COUNTER_CONFLICT', state.turnNumber < state.completedTurns);
  add('COUNTER_CONFLICT', state.lastOverride !== null && (state.lastOverride.fromTurnNumber >= state.lastOverride.toTurnNumber || state.lastOverride.toTurnNumber > state.turnNumber));
  if (state.phase === 'READY') {
    add('PHASE_CONFLICT', state.turnNumber !== 0 || state.position !== null || state.memberIndex !== null || state.completedTurns !== 0 || state.cycle !== 0
      || state.version !== 0 || state.entitlementRevision !== 0 || state.eligibility !== null || state.lastOverride !== null);
  } else if (holder) {
    add('POSITION_INVALID', state.position === null);
    add('COUNTER_CONFLICT', state.turnNumber < 1);
    add('POSITION_INVALID', state.unit === 'TEAM' ? state.memberIndex === null || (team !== undefined && state.memberIndex >= team.members.length) : state.memberIndex !== null);
    add('PHASE_CONFLICT', state.eligibility === null);
  } else { // NO_ELIGIBLE and CLOSED: no holder; the position stays only as the continuation reference
    add('POSITION_INVALID', state.memberIndex !== null);
    add('COUNTER_CONFLICT', (state.position === null) !== (state.turnNumber === 0));
    add('PHASE_CONFLICT', state.eligibility === null && !(state.phase === 'CLOSED' && state.turnNumber === 0));
  }
  return [...issues];
}

/**
 * Loading and every returned state go through here: strict structure first (bounds before cross-comparison), then the invariants.
 * A damaged state is rejected as a whole (TURN_SEQ_STATE_INVALID with code-only issues) — never repaired, clamped, reshuffled or restarted.
 */
export function parseTurnSequenceState(raw: unknown): TurnSequenceState {
  if (isPlain(raw)) { // cheap bound check on the arrays BEFORE the element-wise parse
    const big = (value: unknown) => Array.isArray(value) && value.length > TURN_SEQUENCE_MAX_ACTORS;
    if (big(raw.order) || big(raw.teams) || (Array.isArray(raw.teams) && raw.teams.some(t => isPlain(t) && big(t.members)))) throw new TurnSequenceError('TURN_SEQ_STATE_INVALID', ['LIMIT_EXCEEDED']);
  }
  const parsed = TurnSequenceStateSchema.safeParse(raw);
  if (!parsed.success) throw new TurnSequenceError('TURN_SEQ_STATE_INVALID', ['SHAPE_INVALID']);
  const issues = stateIssues(parsed.data);
  if (issues.length) throw new TurnSequenceError('TURN_SEQ_STATE_INVALID', issues);
  return parsed.data;
}

// ── Preparation (explicit, separated from the transitions) ───

const idList = (value: unknown, issues: Set<TurnSequenceIssueCode>): string[] | null => {
  if (!Array.isArray(value)) { issues.add('SHAPE_INVALID'); return null; }
  if (value.length === 0) { issues.add('ORDER_EMPTY'); return null; }
  if (value.length > TURN_SEQUENCE_MAX_ACTORS) { issues.add('LIMIT_EXCEEDED'); return null; }
  if (!value.every(entry => TurnSequenceActorIdSchema.safeParse(entry).success)) { issues.add('SHAPE_INVALID'); return null; }
  if (new Set(value).size !== value.length) issues.add('ORDER_DUPLICATE');
  return value as string[];
};
const orderError = (issues: Set<TurnSequenceIssueCode>) => new TurnSequenceError('TURN_SEQ_ORDER_INVALID', [...issues]);

export interface DecideTurnOrderInput {
  mode: TurnOrderMode;
  /** the candidates in their BASE order (unique ids) */
  ids: readonly string[];
  /** ROTATING_START only, REQUIRED: the start id of the previous run, or null for the explicit first run */
  previousStartId?: string | null;
  /** CUSTOM_HOST_ORDER only: the explicit order, which must be a permutation of `ids` */
  customOrder?: readonly string[];
  /** RANDOM only: injectable permutation source for tests; default = the existing unbiased server randomness (called exactly once) */
  shuffle?: <T>(values: readonly T[]) => T[];
}
/**
 * The ONLY place that decides an order (and the only one that may call randomness). Call it once per level at preparation (outer order,
 * and once per team for its member order) and store the result with `prepareTurnSequence`.
 * - FIXED: the ids as given. RANDOM: one `shuffle`, checked to be a permutation.
 * - ROTATING_START: `previousStartId: null` = explicit first run (order unchanged, `ids[0]` starts); an id = the entry AFTER it starts (the
 *   rotation of createTurn); an unknown or empty id → TURN_SEQ_PREVIOUS_START_INVALID — no guessed replacement, no silent index 0.
 * - CUSTOM_HOST_ORDER: a permutation of `ids`; unknown / missing / duplicated entries are rejected with code-only issues, never sorted or repaired.
 */
export function decideTurnOrder(input: DecideTurnOrderInput): { mode: TurnOrderMode; order: string[] } {
  args_(isPlain(input) && typeof input.mode === 'string' && (TURN_ORDER_MODES as readonly string[]).includes(input.mode));
  const required = { FIXED: ['mode', 'ids'], RANDOM: ['mode', 'ids'], ROTATING_START: ['mode', 'ids', 'previousStartId'], CUSTOM_HOST_ORDER: ['mode', 'ids', 'customOrder'] }[input.mode];
  args_(keysWithin(input as unknown as Record<string, unknown>, required, input.mode === 'RANDOM' ? ['shuffle'] : []));
  const issues = new Set<TurnSequenceIssueCode>();
  const ids = idList(input.ids, issues);
  if (ids === null || issues.size) throw orderError(issues);
  if (input.mode === 'FIXED') return { mode: input.mode, order: [...ids] };
  if (input.mode === 'RANDOM') {
    const shuffle = input.shuffle ?? shuffleServer;
    args_(typeof shuffle === 'function');
    const drawn = shuffle([...ids]);
    if (!Array.isArray(drawn) || drawn.length !== ids.length || new Set(drawn).size !== ids.length || !drawn.every(id => ids.includes(id))) throw orderError(new Set<TurnSequenceIssueCode>(['ORDER_UNKNOWN_ACTOR']));
    return { mode: input.mode, order: [...drawn] };
  }
  if (input.mode === 'ROTATING_START') {
    const previous = input.previousStartId;
    args_(previous !== undefined); // the key is REQUIRED: null says "first run" explicitly, undefined says nothing
    if (previous === null) return { mode: input.mode, order: [...ids] };
    if (typeof previous !== 'string' || previous === '' || !ids.includes(previous)) throw new TurnSequenceError('TURN_SEQ_PREVIOUS_START_INVALID');
    const start = (ids.indexOf(previous) + 1) % ids.length;
    return { mode: input.mode, order: [...ids.slice(start), ...ids.slice(0, start)] };
  }
  const custom = idList(input.customOrder, issues);
  if (custom !== null) {
    if (custom.some(id => !ids.includes(id))) issues.add('ORDER_UNKNOWN_ACTOR');
    if (ids.some(id => !custom.includes(id))) issues.add('ORDER_MISSING_ACTOR');
  }
  if (custom === null || issues.size) throw orderError(issues);
  return { mode: input.mode, order: [...custom] };
}

export interface PrepareTurnSequenceInput {
  runIndex: number;
  sequenceId: string;
  rosterRevision: string;
  unit: TurnSequenceUnit;
  /** how the order was decided (recorded only) */
  mode: TurnOrderMode;
  /** the ALREADY decided outer order: player ids (PLAYER) or team ids (TEAM) */
  order: readonly string[];
  /** TEAM only: the ALREADY decided member order per team; the first member starts, every cursor starts at 0. Required iff unit TEAM. */
  teams?: ReadonlyArray<{ teamId: string; members: readonly string[] }>;
}
/**
 * Builds the initial READY state from an already decided result. No randomness, no clock, no sorting: the given orders ARE the sequence.
 * Unknown / missing / duplicate entries are rejected (TURN_SEQ_INVALID with code-only issues), nothing is repaired. Team lists are matched
 * to the outer order by team id (equal id sets are required); the member order of each team is kept exactly as given.
 */
export function prepareTurnSequence(input: PrepareTurnSequenceInput): TurnSequenceState {
  args_(isPlain(input) && keysWithin(input as unknown as Record<string, unknown>, ['runIndex', 'sequenceId', 'rosterRevision', 'unit', 'mode', 'order'], ['teams']));
  const bad = (issues: TurnSequenceIssueCode[]) => new TurnSequenceError('TURN_SEQ_INVALID', issues);
  if (!(TURN_SEQUENCE_UNITS as readonly string[]).includes(input.unit)) throw bad(['SHAPE_INVALID']);
  const issues = new Set<TurnSequenceIssueCode>();
  const order = idList(input.order, issues);
  if (order === null || issues.size) throw bad([...issues]);
  let teams: z.infer<typeof TeamSchema>[] | null = null;
  if (input.unit === 'TEAM') {
    if (!Array.isArray(input.teams)) throw bad(['TEAMS_CONFLICT']);
    if (input.teams.length > TURN_SEQUENCE_MAX_ACTORS) throw bad(['LIMIT_EXCEEDED']);
    const byId = new Map<string, readonly string[]>();
    for (const entry of input.teams as unknown[]) {
      if (!isPlain(entry) || !keysWithin(entry, ['teamId', 'members']) || typeof entry.teamId !== 'string' || !Array.isArray(entry.members)) throw bad(['SHAPE_INVALID']);
      if (byId.has(entry.teamId)) throw bad(['TEAM_DUPLICATE']);
      if (entry.members.length === 0) throw bad(['TEAM_EMPTY']);
      if (entry.members.length > TURN_SEQUENCE_MAX_ACTORS) throw bad(['LIMIT_EXCEEDED']);
      byId.set(entry.teamId, entry.members as string[]);
    }
    if (byId.size !== order.length || order.some(id => !byId.has(id))) throw bad(['TEAMS_CONFLICT']);
    teams = order.map(teamId => ({ teamId, members: [...(byId.get(teamId) as readonly string[])], cursor: 0 }));
  } else if (input.teams !== undefined) throw bad(['TEAMS_CONFLICT']);
  const candidate = {
    kind: 'TURN_SEQUENCE', schemaVersion: TURN_SEQUENCE_SCHEMA_VERSION, runIndex: input.runIndex, sequenceId: input.sequenceId, rosterRevision: input.rosterRevision,
    unit: input.unit, mode: input.mode, order: [...order], teams, phase: 'READY', version: 0, turnNumber: 0, completedTurns: 0, cycle: 0, position: null,
    memberIndex: null, entitlementRevision: 0, eligibility: null, lastOverride: null,
  };
  try { return parseTurnSequenceState(candidate); } catch (error) {
    throw bad(error instanceof TurnSequenceError && error.issues.length ? [...error.issues] : ['SHAPE_INVALID']);
  }
}

// ── Scope ────────────────────────────────────────────────────

export function turnSequenceScopeOf(state: TurnSequenceState): TurnSequenceScope {
  return { runIndex: state.runIndex, sequenceId: state.sequenceId, rosterRevision: state.rosterRevision, unit: state.unit };
}
/**
 * ONE error semantics for every mutation, query and projection (a stale access is rejected, never answered "empty"): malformed scope →
 * TURN_SEQ_SCOPE_INVALID; another run → RUN_STALE; another sequence of the same run → SEQUENCE_STALE; another pinned roster revision →
 * ROSTER_STALE; another unit → UNIT_MISMATCH. The consumer maps all of them to "stale / resync" without any detail.
 */
function assertScope(state: TurnSequenceState, expected: unknown): void {
  const scope = TurnSequenceScopeSchema.safeParse(expected);
  if (!scope.success) throw new TurnSequenceError('TURN_SEQ_SCOPE_INVALID');
  if (state.runIndex !== scope.data.runIndex) throw new TurnSequenceError('TURN_SEQ_RUN_STALE');
  if (state.sequenceId !== scope.data.sequenceId) throw new TurnSequenceError('TURN_SEQ_SEQUENCE_STALE');
  if (state.rosterRevision !== scope.data.rosterRevision) throw new TurnSequenceError('TURN_SEQ_ROSTER_STALE');
  if (state.unit !== scope.data.unit) throw new TurnSequenceError('TURN_SEQ_UNIT_MISMATCH');
}
function assertVersion(state: TurnSequenceState, expectedVersion: unknown): void {
  // a malformed expectedVersion can never equal the stored counter: rejected with the same code (fail closed)
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion !== state.version) throw new TurnSequenceError('TURN_SEQ_VERSION_STALE');
}
function assertTurn(state: TurnSequenceState, expectedTurnNumber: unknown): void {
  if (typeof expectedTurnNumber !== 'number' || !Number.isSafeInteger(expectedTurnNumber) || expectedTurnNumber !== state.turnNumber) throw new TurnSequenceError('TURN_SEQ_TURN_STALE');
}
function assertTime(now: unknown): number {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) throw new TurnSequenceError('TURN_SEQ_TIME_INVALID');
  return now;
}

// ── Eligibility (layer C), bound to the right track, roster and version ──

const EligibilityLevelSchema = z.object({
  /** the run the track belongs to (N6 scope). REQUIRED and checked against the sequence's own run at every use: a valid track of another run is no track of this sequence. */
  runIndex: TurnSequenceRunIndexSchema,
  trackId: TurnSequenceRefSchema, rosterRevision: TurnSequenceRefSchema, version: TurnSequenceCounterSchema,
  /** every id the track KNOWS on this level (active or not). The sequence must be fully covered: an actor the track does not know is a wrong pairing, never "inactive". */
  knownIds: z.array(TurnSequenceActorIdSchema).max(TURN_SEQUENCE_MAX_ACTORS),
  /** ids that are currently ACTIVE on this level; a subset of `knownIds` (ids of the track that the sequence does not contain are ignored) */
  activeIds: z.array(TurnSequenceActorIdSchema).max(TURN_SEQUENCE_MAX_ACTORS),
}).strict();
export type TurnEligibilityLevel = z.infer<typeof EligibilityLevelSchema>;
/** actors: the track of the OUTER level (players or teams); members: the PARTICIPANT track of the players inside teams (TEAM only). */
export interface TurnEligibility { actors: TurnEligibilityLevel; members: TurnEligibilityLevel | null }

interface Eligible { actors: ReadonlySet<string>; members: ReadonlySet<string> | null; basis: { actors: z.infer<typeof BasisSchema>; members: z.infer<typeof BasisSchema> | null } }

/**
 * Validates the caller-supplied eligibility against the unit, the run of the sequence and the LAST COMMITTED basis of this sequence: another run, track or
 * roster revision → ELIGIBILITY_MISMATCH; an older N6 track version → ELIGIBILITY_STALE (a stale stand can never make an actor who was
 * eliminated meanwhile eligible again). Equal version = the same track stand (N6 versions are strictly monotonic per track).
 */
function readEligibility(state: TurnSequenceState, raw: unknown): Eligible {
  const invalid = () => new TurnSequenceError('TURN_SEQ_ELIGIBILITY_INVALID');
  if (!isPlain(raw) || !keysWithin(raw, ['actors', 'members'])) throw invalid();
  const actors = EligibilityLevelSchema.safeParse(raw.actors);
  const members = raw.members === null ? null : EligibilityLevelSchema.safeParse(raw.members);
  if (!actors.success || (members !== null && !members.success)) throw invalid();
  if ((state.unit === 'TEAM') !== (members !== null)) throw invalid();
  const memberLevel = members !== null && members.success ? members.data : null;
  const levels = [actors.data, ...(memberLevel !== null ? [memberLevel] : [])];
  // Run binding FIRST and against the sequence's own run (never against a stored basis, never invented from the data): every level, so that in team
  // mode the outer team data and the inner member data both belong to this run and therefore to each other. Identities may persist across runs.
  if (levels.some(level => level.runIndex !== state.runIndex)) throw new TurnSequenceError('TURN_SEQ_ELIGIBILITY_MISMATCH');
  if (levels.some(level => new Set(level.activeIds).size !== level.activeIds.length || new Set(level.knownIds).size !== level.knownIds.length)) throw invalid();
  if (levels.some(level => { const known = new Set(level.knownIds); return level.activeIds.some(id => !known.has(id)); })) throw invalid();
  // Coverage: the track of a level must know EVERY id the sequence uses on that level. Otherwise an unknown actor would silently count as "not active".
  const actorKnown = new Set(actors.data.knownIds);
  if (state.order.some(id => !actorKnown.has(id))) throw new TurnSequenceError('TURN_SEQ_ELIGIBILITY_MISMATCH');
  if (state.teams !== null && memberLevel !== null) {
    const memberKnown = new Set(memberLevel.knownIds);
    if (state.teams.some(team => team.members.some(id => !memberKnown.has(id)))) throw new TurnSequenceError('TURN_SEQ_ELIGIBILITY_MISMATCH');
  }
  const stored = state.eligibility;
  if (stored !== null) {
    const pairs: Array<[z.infer<typeof BasisSchema>, TurnEligibilityLevel]> = [[stored.actors, actors.data]];
    if (stored.members !== null && memberLevel !== null) pairs.push([stored.members, memberLevel]);
    for (const [old, current] of pairs) if (old.trackId !== current.trackId || old.rosterRevision !== current.rosterRevision) throw new TurnSequenceError('TURN_SEQ_ELIGIBILITY_MISMATCH');
    for (const [old, current] of pairs) if (current.version < old.version) throw new TurnSequenceError('TURN_SEQ_ELIGIBILITY_STALE');
  }
  const basis = (level: TurnEligibilityLevel) => ({ trackId: level.trackId, rosterRevision: level.rosterRevision, version: level.version });
  return {
    actors: new Set(actors.data.activeIds), members: memberLevel !== null ? new Set(memberLevel.activeIds) : null,
    basis: { actors: basis(actors.data), members: memberLevel !== null ? basis(memberLevel) : null },
  };
}

/**
 * The eligibility of a sequence from N6 participation tracks (the ONLY status source; no second life logic here). PLAYER: `actors` is a
 * PARTICIPANT track. TEAM: `actors` is the TEAM track and `members` the PARTICIPANT track (N6 forbids mixed actor kinds in one track).
 * Each track is read with its own scope, so a track of another run, track id or roster revision is rejected by N6 itself. The output keeps the
 * N6 RUN of each track, which the sequence compares with its own run at the first use (a track with its own valid scope is not yet a track of THIS
 * run). The output also lists
 * every id the track knows, so that a sequence that is not fully covered by its track is rejected instead of silently skipping the unknown actors.
 */
export function eligibilityFromParticipation(args: { unit: TurnSequenceUnit; actors: { track: unknown; scope: ParticipationScope }; members?: { track: unknown; scope: ParticipationScope } }): TurnEligibility {
  args_(isPlain(args) && keysWithin(args, ['unit', 'actors'], ['members']) && (args.unit === 'PLAYER' || args.unit === 'TEAM'));
  const invalid = () => new TurnSequenceError('TURN_SEQ_ELIGIBILITY_INVALID');
  if ((args.unit === 'TEAM') !== (args.members !== undefined)) throw invalid();
  const level = (source: { track: unknown; scope: ParticipationScope }, kind: 'PARTICIPANT' | 'TEAM'): TurnEligibilityLevel => {
    args_(isPlain(source) && keysWithin(source, ['track', 'scope']));
    const track = parseParticipationTrackState(source.track);
    if (track.actorKind !== kind) throw invalid();
    const scope = participationScopeOf(track);
    return { runIndex: scope.runIndex, trackId: scope.trackId, rosterRevision: scope.rosterRevision, version: track.version, knownIds: track.actors.map(actor => actor.actorId), activeIds: activeActorIds(track, source.scope) };
  };
  return { actors: level(args.actors, args.unit === 'TEAM' ? 'TEAM' : 'PARTICIPANT'), members: args.members === undefined ? null : level(args.members, 'PARTICIPANT') };
}

// ── Selection ────────────────────────────────────────────────

interface Pick { position: number; memberIndex: number | null; cycle: number }
/**
 * The next suitable entry: at most ONE full cycle of the outer order. 'START' examines positions 0..n-1; 'AFTER' examines position+1 ..
 * position+n (the current position LAST, so a single suitable entry is found again after a full wrap — a new turn, not a winner), the
 * cycle growing by one per crossed end (the convention of advanceTurn / N6 findNextActiveTurn). A team is suitable only if it is eligible
 * AND has an eligible member; the member is the first eligible one from the team's cursor (at most one inner cycle). No cursor is moved here.
 */
function findNext(state: TurnSequenceState, eligible: Eligible, from: 'START' | 'AFTER'): Pick | null {
  const n = state.order.length;
  const base = from === 'START' ? 0 : (state.position as number) + 1;
  for (let step = 0; step < n; step++) {
    const absolute = base + step;
    const position = absolute % n;
    const cycle = state.cycle + (from === 'START' ? 0 : Math.floor(absolute / n));
    if (state.unit === 'PLAYER') {
      if (eligible.actors.has(state.order[position])) return { position, memberIndex: null, cycle };
      continue;
    }
    const team = (state.teams as NonNullable<TurnSequenceState['teams']>)[position];
    if (!eligible.actors.has(team.teamId)) continue;
    for (let inner = 0; inner < team.members.length; inner++) {
      const member = (team.cursor + inner) % team.members.length;
      if ((eligible.members as ReadonlySet<string>).has(team.members[member])) return { position, memberIndex: member, cycle };
    }
  }
  return null;
}

/** The holder of the current turn (player, and in team mode the team), or null without a holder (READY, NO_ELIGIBLE, CLOSED). */
export function currentTurnHolder(state: TurnSequenceState): { teamId: string | null; playerId: string } | null {
  if ((state.phase !== 'ACTIVE' && state.phase !== 'HELD') || state.position === null) return null;
  if (state.unit === 'PLAYER') return { teamId: null, playerId: state.order[state.position] };
  const team = (state.teams as NonNullable<TurnSequenceState['teams']>)[state.position];
  return { teamId: team.teamId, playerId: team.members[state.memberIndex as number] };
}
function holderEligible(state: TurnSequenceState, eligible: Eligible): boolean {
  const holder = currentTurnHolder(state);
  if (holder === null) return false;
  return state.unit === 'PLAYER' ? eligible.actors.has(holder.playerId)
    : eligible.actors.has(holder.teamId as string) && (eligible.members as ReadonlySet<string>).has(holder.playerId);
}
/**
 * The documented mapping to the existing single-owner structure: for the PLAYER unit with a holder the sequence is exactly a CoreTurn
 * `{ mode, order, index: position, cycle }`. A team sequence has no CoreTurn (two levels). Nothing in this module writes it anywhere.
 */
export function turnSequenceToCoreTurn(rawState: unknown): CoreTurn | null {
  const state = parseTurnSequenceState(rawState);
  if (state.unit !== 'PLAYER' || state.position === null || (state.phase !== 'ACTIVE' && state.phase !== 'HELD')) return null;
  return { mode: state.mode, order: [...state.order], index: state.position, cycle: state.cycle };
}

// ── Transitions ──────────────────────────────────────────────

export type TurnTransitionKind = 'START' | 'COMPLETE' | 'SKIP' | 'WITHHOLD' | 'OVERRIDE' | 'CLOSE' | 'BASIS';
/**
 * The small SERVER-PRIVATE before/after record of one real change, so the later consumer can build its existing SDK state event and audit.
 * `reason` is only the (trimmed) free text an override was given. Never send it to a client, a log or a public history.
 */
export interface TurnTransition {
  kind: TurnTransitionKind;
  versionBefore: number; versionAfter: number;
  turnNumberBefore: number; turnNumberAfter: number;
  phaseBefore: TurnSequencePhase; phaseAfter: TurnSequencePhase;
  holderBefore: { teamId: string | null; playerId: string } | null;
  holderAfter: { teamId: string | null; playerId: string } | null;
  reason: string | null;
}
export interface TurnSequenceChange { state: TurnSequenceState; changed: boolean; transition: TurnTransition | null }

const unchanged = (state: TurnSequenceState): TurnSequenceChange => ({ state, changed: false, transition: null });

/**
 * Is a level of the supplied eligibility NEWER than the last committed basis? (Each level on its own: team/actor level and member level.)
 * A newer valid basis is relevant knowledge about WHO may no longer act, even when nobody's responsibility changes.
 */
function basisAdvanced(state: TurnSequenceState, eligible: Eligible): boolean {
  const stored = state.eligibility;
  if (stored === null) return false;
  return eligible.basis.actors.version > stored.actors.version
    || (eligible.basis.members !== null && stored.members !== null && eligible.basis.members.version > stored.members.version);
}
/**
 * The "nothing else changes" exit of an operation that was valid but needs no new holder (repeated hold, identical override, a repeated search that
 * still finds nobody). If the supplied basis is NEWER it is committed as its own change (`BASIS`: local version +1, new basis, NOTHING else — no turn,
 * no completion, no cursor, no cycle, no entitlement change), so that an older stand in between can never pass the guard later; the consumer
 * persists it like every other change (state event + CAS). An equal basis is a true no-op. Read-only functions never go through here.
 */
function keepOrAdvance(state: TurnSequenceState, eligible: Eligible): TurnSequenceChange {
  return basisAdvanced(state, eligible) ? commit(state, 'BASIS', {}, eligible) : unchanged(state);
}

/** Commits a change: one local version step, the entitlement counter only if "may anybody act" flipped, the eligibility basis moved forward. */
function commit(before: TurnSequenceState, kind: TurnTransitionKind, patch: Partial<TurnSequenceState>, eligible: Eligible | null, reason: string | null = null): TurnSequenceChange {
  const after = { ...before, ...patch, order: [...before.order], teams: (patch.teams ?? before.teams)?.map(team => ({ ...team, members: [...team.members] })) ?? null };
  after.version = before.version + 1;
  if ((before.phase === 'ACTIVE') !== (after.phase === 'ACTIVE')) after.entitlementRevision = before.entitlementRevision + 1;
  if (eligible !== null) after.eligibility = { actors: { ...eligible.basis.actors }, members: eligible.basis.members === null ? null : { ...eligible.basis.members } };
  const state = parseTurnSequenceState(after); // validated once more: a transition can never produce an invalid state
  return {
    state, changed: true,
    transition: {
      kind, versionBefore: before.version, versionAfter: state.version, turnNumberBefore: before.turnNumber, turnNumberAfter: state.turnNumber,
      phaseBefore: before.phase, phaseAfter: state.phase, holderBefore: currentTurnHolder(before), holderAfter: currentTurnHolder(state), reason,
    },
  };
}

/** Phase gate shared by every operation that needs a started, open sequence. */
function requireOpen(state: TurnSequenceState): void {
  if (state.phase === 'CLOSED') throw new TurnSequenceError('TURN_SEQ_CLOSED');
  if (state.phase === 'READY') throw new TurnSequenceError('TURN_SEQ_NOT_STARTED');
}
function beginTurn(before: TurnSequenceState, kind: TurnTransitionKind, base: TurnSequenceState, eligible: Eligible, from: 'START' | 'AFTER'): TurnSequenceChange {
  const found = findNext(base, eligible, from);
  if (found === null) return commit(before, kind, { phase: 'NO_ELIGIBLE', memberIndex: null, teams: base.teams, completedTurns: base.completedTurns }, eligible);
  return commit(before, kind, { phase: 'ACTIVE', turnNumber: before.turnNumber + 1, position: found.position, memberIndex: found.memberIndex, cycle: found.cycle, teams: base.teams, completedTurns: base.completedTurns }, eligible);
}

/**
 * READY → the first turn at the first suitable entry (search from position 0 inclusive, at most one cycle) or NO_ELIGIBLE. One version step,
 * turnNumber 0 → 1 when a turn begins. Starting twice is rejected (ALREADY_STARTED) — a lost confirmation is answered by the consumer's
 * receipt, not by a second start.
 */
export function startTurnSequence(rawState: unknown, args: { scope: TurnSequenceScope; expectedVersion: number; eligibility: TurnEligibility }): TurnSequenceChange {
  const state = parseTurnSequenceState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion', 'eligibility']));
  assertScope(state, args.scope);
  if (state.phase === 'CLOSED') throw new TurnSequenceError('TURN_SEQ_CLOSED');
  assertVersion(state, args.expectedVersion);
  if (state.phase !== 'READY') throw new TurnSequenceError('TURN_SEQ_ALREADY_STARTED');
  const eligible = readEligibility(state, args.eligibility);
  return beginTurn(state, 'START', state, eligible, 'START');
}

export type TurnOutcome = 'COMPLETE' | 'SKIP';
/**
 * Ends the current turn and selects the next one — the ONLY normal way a turn changes.
 * - COMPLETE (phase ACTIVE only): a real finished turn. In team mode the cursor of THIS team moves to (memberIndex + 1) mod size — exactly
 *   once; other teams keep their cursor. `completedTurns` +1. The search for the next suitable entry then starts after the current position.
 * - SKIP (ACTIVE, HELD or NO_ELIGIBLE): NOT a completion — no cursor and no `completedTurns` change (design.md §6); used when the holder lost
 *   eligibility or a host skips. From NO_ELIGIBLE it is a new search; if nobody is suitable it stays NO_ELIGIBLE (`changed:false`).
 * - The next turn gets a new `turnNumber` also when the same single suitable entry is chosen again. NONE suitable → NO_ELIGIBLE: no holder,
 *   no winner, no invented id, no team KO.
 * - Expected: the sequence version AND the turn number the caller saw. Neither a repeated call nor a late one with the old pair is accepted.
 */
export function advanceTurnSequence(rawState: unknown, args: { scope: TurnSequenceScope; expectedVersion: number; expectedTurnNumber: number; outcome: TurnOutcome; eligibility: TurnEligibility }): TurnSequenceChange {
  const state = parseTurnSequenceState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion', 'expectedTurnNumber', 'outcome', 'eligibility']));
  assertScope(state, args.scope);
  if (state.phase === 'CLOSED') throw new TurnSequenceError('TURN_SEQ_CLOSED');
  assertVersion(state, args.expectedVersion);
  assertTurn(state, args.expectedTurnNumber);
  if (args.outcome !== 'COMPLETE' && args.outcome !== 'SKIP') throw new TurnSequenceError('TURN_SEQ_OUTCOME_INVALID');
  if (state.phase === 'READY') throw new TurnSequenceError('TURN_SEQ_NOT_STARTED');
  if (args.outcome === 'COMPLETE') {
    if (state.phase === 'HELD') throw new TurnSequenceError('TURN_SEQ_HELD');
    if (state.phase === 'NO_ELIGIBLE') throw new TurnSequenceError('TURN_SEQ_NO_CURRENT');
  }
  const eligible = readEligibility(state, args.eligibility);
  let base = state;
  if (args.outcome === 'COMPLETE') {
    const teams = state.teams === null ? null : state.teams.map((team, index) => ({ ...team, members: [...team.members], cursor: index === state.position ? ((state.memberIndex as number) + 1) % team.members.length : team.cursor }));
    base = { ...state, teams, completedTurns: state.completedTurns + 1 };
  }
  const from = state.position === null ? 'START' : 'AFTER';
  const result = beginTurn(state, args.outcome, base, eligible, from);
  // a repeated search that again finds nobody changes nobody's responsibility: a true no-op with an equal basis, a BASIS change with a newer one
  if (state.phase === 'NO_ELIGIBLE' && result.state.phase === 'NO_ELIGIBLE') return keepOrAdvance(state, eligible);
  return result;
}

/**
 * Makes the intermediate state explicit: the holder is no longer eligible (N6 elimination, layer-B loss …) → HELD. Nobody acts; the turn and
 * its holder stay for the evidence; version and entitlement revision step, so every open action of the holder is void. Allowed only if the
 * supplied eligibility really shows the holder as NOT eligible (TURN_SEQ_HOLDER_STILL_ELIGIBLE otherwise — no lock without cause).
 * Already HELD at the expected version/turn → `changed:false` with an equal basis, or a `BASIS` change (no turn, no completion, no cursor) when the
 * supplied basis is newer. The next actor is chosen only by an explicit advance(SKIP) or override.
 */
export function withholdCurrentHolder(rawState: unknown, args: { scope: TurnSequenceScope; expectedVersion: number; expectedTurnNumber: number; eligibility: TurnEligibility }): TurnSequenceChange {
  const state = parseTurnSequenceState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion', 'expectedTurnNumber', 'eligibility']));
  assertScope(state, args.scope);
  if (state.phase === 'CLOSED') throw new TurnSequenceError('TURN_SEQ_CLOSED');
  assertVersion(state, args.expectedVersion);
  assertTurn(state, args.expectedTurnNumber);
  requireOpen(state);
  if (state.phase === 'NO_ELIGIBLE') throw new TurnSequenceError('TURN_SEQ_NO_CURRENT');
  const eligible = readEligibility(state, args.eligibility);
  if (state.phase === 'HELD') return keepOrAdvance(state, eligible);
  if (holderEligible(state, eligible)) throw new TurnSequenceError('TURN_SEQ_HOLDER_STILL_ELIGIBLE');
  return commit(state, 'WITHHOLD', { phase: 'HELD' }, eligible);
}

/**
 * Explicit controlled override: the SERVER names a new holder (the caller must have checked the override right and context — no client sets
 * an active id). Changes: holder, position, memberIndex, a NEW turn (all open actions of the previous turn become void), `lastOverride`
 * evidence. Changes NOT: `completedTurns`, any cursor (the displaced holder completed nothing and stays next in line in his team), `cycle`.
 * The sequence continues after the TARGET's position. Targets are checked: unknown → ACTOR_UNKNOWN, a player of another team →
 * TEAM_MEMBER_MISMATCH, not eligible (actor/team or member) → ACTOR_NOT_ELIGIBLE. A target equal to the current holder in ACTIVE is a
 * controlled no-op (`changed:false`, no turn; with a NEWER eligibility basis a `BASIS` change that only advances the version and the basis) — AFTER scope, version and turn were checked. `reason` and `now` go to the
 * server-private transition; the state keeps only the time and the turn numbers.
 */
export function overrideTurnSequence(rawState: unknown, args: {
  scope: TurnSequenceScope; expectedVersion: number; expectedTurnNumber: number; target: { playerId: string; teamId?: string };
  eligibility: TurnEligibility; now: number; reason?: string;
}): TurnSequenceChange {
  const state = parseTurnSequenceState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion', 'expectedTurnNumber', 'target', 'eligibility', 'now'], ['reason']));
  assertScope(state, args.scope);
  if (state.phase === 'CLOSED') throw new TurnSequenceError('TURN_SEQ_CLOSED');
  assertVersion(state, args.expectedVersion);
  assertTurn(state, args.expectedTurnNumber);
  const now = assertTime(args.now);
  let reason: string | null = null;
  if (args.reason !== undefined) {
    args_(typeof args.reason === 'string');
    reason = args.reason.trim();
    args_(reason.length <= TURN_SEQUENCE_MAX_REASON_LENGTH);
    if (reason === '') reason = null;
  }
  const target: unknown = args.target;
  args_(isPlain(target) && typeof target.playerId === 'string' && keysWithin(target, state.unit === 'TEAM' ? ['playerId', 'teamId'] : ['playerId']) && (state.unit === 'PLAYER' || typeof target.teamId === 'string'));
  requireOpen(state);
  const eligible = readEligibility(state, args.eligibility);
  const playerId = target.playerId as string;
  let position: number, memberIndex: number | null = null;
  if (state.unit === 'PLAYER') {
    position = state.order.indexOf(playerId);
    if (position < 0) throw new TurnSequenceError('TURN_SEQ_ACTOR_UNKNOWN');
    if (!eligible.actors.has(playerId)) throw new TurnSequenceError('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
  } else {
    const teams = state.teams as NonNullable<TurnSequenceState['teams']>;
    position = state.order.indexOf(target.teamId as string);
    if (position < 0) throw new TurnSequenceError('TURN_SEQ_ACTOR_UNKNOWN');
    memberIndex = teams[position].members.indexOf(playerId);
    if (memberIndex < 0) throw new TurnSequenceError(teams.some(team => team.members.includes(playerId)) ? 'TURN_SEQ_TEAM_MEMBER_MISMATCH' : 'TURN_SEQ_ACTOR_UNKNOWN');
    if (!eligible.actors.has(target.teamId as string) || !(eligible.members as ReadonlySet<string>).has(playerId)) throw new TurnSequenceError('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
  }
  if (state.phase === 'ACTIVE' && state.position === position && state.memberIndex === memberIndex) return keepOrAdvance(state, eligible);
  const toTurnNumber = state.turnNumber + 1;
  return commit(state, 'OVERRIDE', { phase: 'ACTIVE', turnNumber: toTurnNumber, position, memberIndex, lastOverride: { atMs: now, fromTurnNumber: state.turnNumber, toTurnNumber } }, eligible, reason);
}

/**
 * Records a NEWER eligibility basis without any other change — the explicit connector for "somebody who does not hold the turn was eliminated / left".
 * A newer basis (either level) is committed as a `BASIS` change: local version +1 and the new basis, nothing else (no turn, no completion, no cursor, no
 * cycle, no entitlement change), to be persisted like every other change (state event + CAS). An equal basis is a true no-op (`changed:false`); an older
 * one is `TURN_SEQ_ELIGIBILITY_STALE`. It never selects or withholds anybody: if the HOLDER lost eligibility the consumer calls `withholdCurrentHolder`
 * (or `advanceTurnSequence(SKIP)` / `overrideTurnSequence`) — this function does not decide that. Allowed in every phase except READY and CLOSED.
 */
export function refreshEligibilityBasis(rawState: unknown, args: { scope: TurnSequenceScope; expectedVersion: number; eligibility: TurnEligibility }): TurnSequenceChange {
  const state = parseTurnSequenceState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion', 'eligibility']));
  assertScope(state, args.scope);
  if (state.phase === 'CLOSED') throw new TurnSequenceError('TURN_SEQ_CLOSED');
  assertVersion(state, args.expectedVersion);
  if (state.phase === 'READY') throw new TurnSequenceError('TURN_SEQ_NOT_STARTED');
  return keepOrAdvance(state, readEligibility(state, args.eligibility));
}

/** Terminal close. A closed sequence never restarts; a new pass needs a new instance. Repeating it at the current version is `changed:false`. */
export function closeTurnSequence(rawState: unknown, args: { scope: TurnSequenceScope; expectedVersion: number }): TurnSequenceChange {
  const state = parseTurnSequenceState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion']));
  assertScope(state, args.scope);
  assertVersion(state, args.expectedVersion);
  if (state.phase === 'CLOSED') return unchanged(state);
  return commit(state, 'CLOSE', { phase: 'CLOSED', memberIndex: null }, null);
}

// ── Server-side check of the current responsibility ──────────

export interface TurnActionCaller { role: 'PLAYER'; participantId: string; teamId: string | null }
/** Facts of the consumer's OWN current checks (admission, phase, pause) as explicit booleans — there is no default and no inference here. */
export interface TurnActionGate { admitted: boolean; phaseOpen: boolean; paused: boolean }
/**
 * Read-only check that THIS caller currently holds THIS turn. It ADDS to — and never replaces — the consumer's own current checks: the
 * caller (`role`, `participantId`, `teamId`) must come from the CURRENTLY admitted session and team assignment (never from the payload, a
 * projection or a self-chosen team id), and `gate` states the consumer's own current admission / phase / pause facts.
 * Order: state → shape → scope → closed → version → turn → phase of the sequence → gate → role → holder identity → holder eligibility.
 * Only a PLAYER can act (HOST / VIEWER / DISPLAY / unknown role → ROLE_NOT_ALLOWED; a playing host is a PLAYER of this check). In team mode
 * the caller's team AND the caller himself must be the holder: another member of the team advises only (NOT_CURRENT_ACTOR).
 */
export function authorizeTurnAction(rawState: unknown, args: {
  scope: TurnSequenceScope; expectedVersion: number; expectedTurnNumber: number; caller: TurnActionCaller; gate: TurnActionGate; eligibility: TurnEligibility;
}): { allowed: true; turnNumber: number; sequenceVersion: number } {
  const state = parseTurnSequenceState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion', 'expectedTurnNumber', 'caller', 'gate', 'eligibility']));
  assertScope(state, args.scope);
  if (state.phase === 'CLOSED') throw new TurnSequenceError('TURN_SEQ_CLOSED');
  assertVersion(state, args.expectedVersion);
  assertTurn(state, args.expectedTurnNumber);
  const gate: unknown = args.gate, caller: unknown = args.caller;
  args_(isPlain(gate) && keysWithin(gate, ['admitted', 'phaseOpen', 'paused']) && typeof gate.admitted === 'boolean' && typeof gate.phaseOpen === 'boolean' && typeof gate.paused === 'boolean');
  args_(isPlain(caller) && keysWithin(caller, ['role', 'participantId', 'teamId']) && typeof caller.role === 'string' && typeof caller.participantId === 'string' && caller.participantId !== ''
    && (caller.teamId === null || typeof caller.teamId === 'string'));
  requireOpen(state);
  if (state.phase === 'HELD') throw new TurnSequenceError('TURN_SEQ_HELD');
  if (state.phase === 'NO_ELIGIBLE') throw new TurnSequenceError('TURN_SEQ_NO_CURRENT');
  if (gate.admitted !== true || gate.phaseOpen !== true || gate.paused !== false) throw new TurnSequenceError('TURN_SEQ_ACTION_BLOCKED');
  if (caller.role !== 'PLAYER') throw new TurnSequenceError('TURN_SEQ_ROLE_NOT_ALLOWED');
  const holder = currentTurnHolder(state) as NonNullable<ReturnType<typeof currentTurnHolder>>;
  if (caller.participantId !== holder.playerId || (state.unit === 'TEAM' && caller.teamId !== holder.teamId)) throw new TurnSequenceError('TURN_SEQ_NOT_CURRENT_ACTOR');
  const eligible = readEligibility(state, args.eligibility);
  if (!holderEligible(state, eligible)) throw new TurnSequenceError('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
  return { allowed: true, turnNumber: state.turnNumber, sequenceVersion: state.version };
}

// ── Projection ───────────────────────────────────────────────

const INFORMATION_ROLES = ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'];

/**
 * Projection for ONE caller through a small allowlist (no spread of the private state); re-checked against the strict client schema
 * (`safeParse`, never a ZodError). `audience` must come from the server's admission/session path: the information role is the CURRENT game
 * role — a playing host or administrator is projected as PLAYER; an unknown role or malformed id → TURN_SEQ_AUDIENCE_INVALID. A known player
 * or team id alone is no authentication.
 * - `release` is REQUIRED (no default): NONE → only the ordering counters; CURRENT → state, current holder, the caller's own `you`;
 *   ORDER → additionally the outer order, position and cycle. Team member lists, cursors, eligibility, override evidence are never projected.
 * - `you` exists only for a PLAYER audience (own id via PLAYER_PRIVATE, own team via TEAM_PRIVATE). HOST / VIEWER / DISPLAY get none.
 * - `recipientId` (every release, also NONE) names the recipient the packet was made for: the participant id of a PLAYER audience, null otherwise.
 *   A UI accepts the packet only for exactly the recipient it expects from its own session (turnSequenceProjectionMatches).
 * - `stateVersion` is the authoritative game snapshot version the caller binds this to; it is NOT the private local `version`.
 */
export function projectTurnSequence(audience: ProjectionAudience, rawState: unknown, args: { scope: TurnSequenceScope; release: TurnSequenceRelease; stateVersion: number }): TurnSequenceProjection {
  const state = parseTurnSequenceState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'release', 'stateVersion']));
  assertScope(state, args.scope);
  if (typeof args.release !== 'string' || !(TURN_SEQUENCE_RELEASES as readonly string[]).includes(args.release)) throw new TurnSequenceError('TURN_SEQ_RELEASE_INVALID');
  args_(TurnSequenceStateVersionSchema.safeParse(args.stateVersion).success);
  const bad = () => new TurnSequenceError('TURN_SEQ_AUDIENCE_INVALID');
  if (!isPlain(audience) || typeof audience.role !== 'string' || !INFORMATION_ROLES.includes(audience.role)) throw bad();
  for (const id of [audience.participantId, audience.teamId] as unknown[]) {
    if (id !== undefined && id !== null && !TurnSequenceActorIdSchema.safeParse(id).success) throw bad();
  }
  const recipientId = audience.role === 'PLAYER' && typeof audience.participantId === 'string' && audience.participantId !== '' ? audience.participantId : null;
  const base = {
    contract: TURN_SEQUENCE_CONTRACT, scope: turnSequenceScopeOf(state), recipientId, stateVersion: args.stateVersion, sequenceVersion: state.version,
    turnNumber: state.turnNumber, entitlementRevision: state.entitlementRevision,
  };
  let projection: Record<string, unknown>;
  if (args.release === 'NONE') projection = { ...base, release: 'NONE' };
  else {
    const holder = currentTurnHolder(state);
    let you: { holdsTurn: boolean; teamHoldsTurn: boolean | null; canAct: boolean } | null = null;
    if (recipientId !== null) {
      const playerMatch = holder !== null && canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: holder.playerId });
      const teamMatch = holder !== null && holder.teamId !== null && canView(audience, { scope: 'TEAM_PRIVATE', ownerTeamId: holder.teamId });
      const holdsTurn = state.unit === 'TEAM' ? playerMatch && teamMatch : playerMatch;
      you = { holdsTurn, teamHoldsTurn: state.unit === 'TEAM' ? teamMatch : null, canAct: state.phase === 'ACTIVE' && holdsTurn };
    }
    projection = { ...base, release: args.release, status: state.phase, current: holder === null ? null : { teamId: holder.teamId, playerId: holder.playerId }, you };
    if (args.release === 'ORDER') projection.order = { actorIds: [...state.order], position: state.position, cycle: state.cycle };
  }
  const checked = TurnSequenceProjectionSchema.safeParse(projection);
  if (!checked.success) throw new TurnSequenceError('TURN_SEQ_STATE_INVALID'); // never a ZodError: its message could echo values
  return checked.data;
}

export { TurnSequenceError } from '@quiz/shared/turnSequence';
export type { TurnSequenceProjection, TurnSequenceScope } from '@quiz/shared/turnSequence';
