// ============================================================
// N10 — Bidding phase (domain building block, SERVER-PRIVATE)
//
// A small, validated, serialisable ascending-bid process between TEAMS, bound to ONE N8 turn sequence (unit TEAM): every team acts through ONE pinned bidder; the
// pinned PERFORMER of the team never bids and never sees the bids. Free start bids, strictly higher follow-up bids (jumps allowed), passing = leaving THIS bidding for
// good, a regular end when exactly one team is left, an explicit abort without any result. It is a building block for the later partner-challenge engine. It is NOT
// an engine: it books no points, starts no challenge, reveals no task, opens no route, socket event, table or setup UI and sets no game to AVAILABLE.
//
// What it does NOT do (the later real consumer must supply it): authentication, admission, team assignment, rights, pause, phase, the N6 participation status,
// persistence, CAS, receipts, state events, audit. `placeBid` / `passBidding` call the N8 `authorizeTurnAction` FIRST (turn identity, sequence version, holder,
// eligibility, gate) and only ADD the bidding checks; a known participant id, a pinned bidder id or a team id in a payload is no authorisation. Host rights give no
// bid: the host acts as a PLAYER of this check or not at all.
//
// WHO IS UP is ONE truth: the N8 sequence. The bidding state keeps NO holder pointer. Every accepted bid or pass hands the turn over in the SAME call with the N8
// `overrideTurnSequence` (the SERVER names the target; no member rotation, no completed turn, no cursor change — a bid is not a finished team turn, so `COMPLETE`
// is never used and the bidder never rotates inside a bidding). Which team is next is the documented SCHEDULING CONTRACT (`nextBiddingTeamId`, a technical policy,
// NOT a confirmed master rule): the next team after the actor in the prepared order that is still in and is not the leader. A leader therefore never has to
// outbid or pass against himself and waits for competition. A pass that ends the bidding closes the N8 sequence in the same call. The caller persists the new
// bidding state AND the new sequence in ONE commit (state event + CAS + receipt); alone this module guarantees no exactly-once processing.
//
// The pure semantic layer (`applyBid`, `applyPass`) knows no schedule: it checks the mechanics for an explicitly named team (in, not passed, not the leader, value
// valid and strictly higher). The literal example of the game description (T1 3, T2 5, T1 passes, T3 8, T2 passes) is a semantic sequence; whether it is also a
// legal schedule is a separate question answered only by the full path.
//
// Pass evidence: every accepted bid or pass appends one entry to a bounded, server-private history with a monotone `step` (stored counter, never a clock), the
// N8 turn it was made in and — for a pass — the team that LED at that moment and its bid. "The team that left last AGAINST THE FINAL WINNER" is derived from
// exactly this evidence and stored with the regular result; load re-derives it and rejects a state whose result differs. Nothing here books points.
//
// Edge-case policy (ours, labelled as such — the master does not fix these):
//   - Pass before the first accepted bid: REJECTED (`BIDDING_PASS_BEFORE_FIRST_BID`); a bidding never ends without a valid bid, nobody is guessed as winner.
//   - Disconnect, kick, leave, missing role: no automatic pass, no winner, no defeat. A bidder who is no longer eligible blocks the bidding (N8: `TURN_SEQ_ACTOR_NOT_ELIGIBLE`
//     / `HELD`); the next bidder being unavailable refuses the handover and therefore the bid; state unchanged. Only an explicit authorised abort ends it.
//   - Abort: `ABORTED` with an end reason, NO result, no winner, no target; the last standing is kept server-private and is not projected.
//
// Versions (kept apart; see design.md §3): `version` is the LOCAL counter of THIS bidding (+1 per real change: open, bid, pass, abort); `stepCount` counts only accepted
// bids and passes (their history index); the bid VALUE is neither; `turnNumber` is the N8 action identity. None of them is the global `stateVersion`.
// ============================================================

import { z } from 'zod';
import {
  BIDDING_ABORT_REASONS, BIDDING_END_REASONS, BIDDING_MAX_COUNTER, BIDDING_MAX_STEPS, BIDDING_MAX_TEAMS, BIDDING_MIN_TEAMS, BIDDING_RELEASES, BIDDING_SCHEMA_VERSION, BIDDING_CONTRACT,
  BiddingActionBindingSchema, BiddingActorIdSchema, BiddingBidIntentSchema, BiddingCategorySchema, BiddingCounterSchema, BiddingError, BiddingNumericConfigSchema, BiddingPassIntentSchema,
  BiddingPhaseSchema, BiddingProjectionSchema, BiddingRefSchema, BiddingRoundIdSchema, BiddingRunIndexSchema, BiddingScopeSchema, BiddingStateVersionSchema,
  type BiddingAbortReason, type BiddingBidIntent, type BiddingIssueCode, type BiddingPassIntent, type BiddingPhase, type BiddingProjection, type BiddingScope,
} from '@quiz/shared/bidding';
import { projectNumericPublicInput, validateNumericValue, type NumericValue } from '@quiz/shared/numeric';
import { TURN_SEQUENCE_MAX_COUNTER } from '@quiz/shared/turnSequence';
import {
  authorizeTurnAction, closeTurnSequence, currentTurnHolder, overrideTurnSequence, parseTurnSequenceState, refreshEligibilityBasis, withholdCurrentHolder,
  type PrepareTurnSequenceInput, type TurnActionCaller, type TurnActionGate, type TurnEligibility, type TurnSequenceScope, type TurnSequenceState, type TurnTransition,
} from './turnSequence.js';
import { type ProjectionAudience } from './visibility.js';

export { BiddingError };
export type { BiddingProjection, BiddingScope };

// ── Helpers ──────────────────────────────────────────────────

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
/** Exact key set: every required key present, no key outside required ∪ optional. */
const keysWithin = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
function args_(condition: boolean): asserts condition { if (!condition) throw new BiddingError('BIDDING_ARGS_INVALID'); }

// ── Server-private state ─────────────────────────────────────

const TeamSchema = z.object({ teamId: BiddingActorIdSchema, bidderId: BiddingActorIdSchema, performerId: BiddingActorIdSchema }).strict();
const UnitsSchema = z.number().int().safe().min(1);
const BidEntrySchema = z.object({ step: BiddingCounterSchema.min(1), kind: z.literal('BID'), turnNumber: BiddingCounterSchema.min(1), teamId: BiddingActorIdSchema, playerId: BiddingActorIdSchema, units: UnitsSchema }).strict();
/** A pass remembers WHO LED at that moment (`againstTeamId`) and its bid — the reference for "left last against the final winner". */
const PassEntrySchema = z.object({
  step: BiddingCounterSchema.min(1), kind: z.literal('PASS'), turnNumber: BiddingCounterSchema.min(1), teamId: BiddingActorIdSchema, playerId: BiddingActorIdSchema,
  againstTeamId: BiddingActorIdSchema, againstUnits: UnitsSchema,
}).strict();
const HistoryEntrySchema = z.discriminatedUnion('kind', [BidEntrySchema, PassEntrySchema]);
const LeaderSchema = z.object({ teamId: BiddingActorIdSchema, units: UnitsSchema }).strict();
const ResultSchema = z.object({
  winnerTeamId: BiddingActorIdSchema, winningUnits: UnitsSchema, bidderId: BiddingActorIdSchema, performerId: BiddingActorIdSchema,
  /** the team that left LAST against the final winner, and the step of that pass */
  lastPassTeamId: BiddingActorIdSchema, lastPassStep: BiddingCounterSchema.min(1),
}).strict();

export const BiddingStateSchema = z.object({
  kind: z.literal('BIDDING_PHASE'),
  schemaVersion: z.literal(BIDDING_SCHEMA_VERSION),
  runIndex: BiddingRunIndexSchema,
  roundId: BiddingRoundIdSchema,
  biddingId: BiddingRefSchema,
  /** label of the pinned bidder/performer assignment (with an N5 deal as source: the deal's revision) */
  rolesRevision: BiddingRefSchema,
  /** the pinned N8 sequence (unit TEAM): id and roster revision */
  binding: z.object({ sequenceId: BiddingRefSchema, rosterRevision: BiddingRefSchema }).strict(),
  category: BiddingCategorySchema.nullable(),
  /** the effective numeric profile of THIS bidding — never changed after preparation */
  numeric: BiddingNumericConfigSchema,
  /** the pinned teams in SCHEDULING order: the first team starts */
  teams: z.array(TeamSchema).min(BIDDING_MIN_TEAMS).max(BIDDING_MAX_TEAMS),
  phase: BiddingPhaseSchema,
  version: BiddingCounterSchema,
  stepCount: BiddingCounterSchema,
  leader: LeaderSchema.nullable(),
  /** team ids in the order they passed */
  passedTeamIds: z.array(BiddingActorIdSchema).max(BIDDING_MAX_TEAMS),
  history: z.array(HistoryEntrySchema).max(BIDDING_MAX_STEPS),
  result: ResultSchema.nullable(),
  endReason: z.enum(BIDDING_END_REASONS).nullable(),
}).strict();
export type BiddingState = z.infer<typeof BiddingStateSchema>;
type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
type Result = z.infer<typeof ResultSchema>;

interface Replay { leader: { teamId: string; units: number } | null; passed: string[]; ok: boolean }
/** Replays the evidence from scratch. `ok:false` = the history breaks a mechanic (a team acts twice after passing, a bid that is not higher, a pass against the wrong leader …). */
function replay(state: BiddingState): Replay {
  const teamIds = new Set(state.teams.map(team => team.teamId));
  const bidderOf = new Map(state.teams.map(team => [team.teamId, team.bidderId]));
  const min = state.numeric.min.units, max = state.numeric.max.units;
  let leader: Replay['leader'] = null;
  const passed: string[] = [];
  let lastTurn = 0;
  for (const [index, entry] of state.history.entries()) {
    if (entry.step !== index + 1 || entry.turnNumber <= lastTurn || !teamIds.has(entry.teamId) || bidderOf.get(entry.teamId) !== entry.playerId || passed.includes(entry.teamId)) return { leader, passed, ok: false };
    if (state.teams.length - passed.length < 2) return { leader, passed, ok: false }; // nothing may happen after the regular end
    lastTurn = entry.turnNumber;
    if (entry.kind === 'BID') {
      if (leader !== null && (leader.teamId === entry.teamId || entry.units <= leader.units)) return { leader, passed, ok: false };
      if (entry.units < min || entry.units > max) return { leader, passed, ok: false };
      leader = { teamId: entry.teamId, units: entry.units };
    } else {
      if (leader === null || leader.teamId === entry.teamId || entry.againstTeamId !== leader.teamId || entry.againstUnits !== leader.units) return { leader, passed, ok: false };
      passed.push(entry.teamId);
    }
  }
  return { leader, passed, ok: true };
}

/** The result basis derived from the evidence ONLY (independent of the stored `result`). null if there is no regular end. */
function deriveResult(state: BiddingState): Result | null {
  const stillIn = state.teams.filter(team => !state.passedTeamIds.includes(team.teamId));
  if (stillIn.length !== 1 || state.leader === null || state.leader.teamId !== stillIn[0].teamId) return null;
  const winner = stillIn[0];
  for (let index = state.history.length - 1; index >= 0; index--) {
    const entry = state.history[index];
    if (entry.kind === 'PASS' && entry.againstTeamId === winner.teamId) {
      return { winnerTeamId: winner.teamId, winningUnits: state.leader.units, bidderId: winner.bidderId, performerId: winner.performerId, lastPassTeamId: entry.teamId, lastPassStep: entry.step };
    }
  }
  return null;
}

/** Cross-field invariants of a structurally valid state (bounds were checked first). Code-only issues. */
function stateIssues(state: BiddingState): BiddingIssueCode[] {
  const issues = new Set<BiddingIssueCode>();
  const add = (code: BiddingIssueCode, condition: boolean) => { if (condition) issues.add(code); };
  const teamIds = state.teams.map(team => team.teamId);
  const people = state.teams.flatMap(team => [team.bidderId, team.performerId]);
  add('TEAM_CONFLICT', new Set(teamIds).size !== teamIds.length || new Set(people).size !== people.length);
  add('CONFIG_CONFLICT', state.numeric.max.units < state.numeric.min.units);
  const steps = state.history.length;
  add('COUNTER_CONFLICT', state.stepCount !== steps || state.version < state.stepCount);
  const opened = state.phase !== 'PREPARED';
  if (state.phase === 'PREPARED') add('PHASE_CONFLICT', state.version !== 0 || steps !== 0);
  else if (state.phase === 'ABORTED') add('COUNTER_CONFLICT', !(state.version === steps + 2 || (steps === 0 && state.version === 1)));
  else add('COUNTER_CONFLICT', state.version !== steps + 1);
  const run = replay(state);
  add('HISTORY_CONFLICT', !run.ok);
  if (run.ok) {
    add('STANDING_CONFLICT', JSON.stringify(run.leader) !== JSON.stringify(state.leader));
    add('PASSED_CONFLICT', JSON.stringify(run.passed) !== JSON.stringify(state.passedTeamIds));
  }
  add('PASSED_CONFLICT', state.passedTeamIds.some(id => !teamIds.includes(id)) || new Set(state.passedTeamIds).size !== state.passedTeamIds.length);
  add('STANDING_CONFLICT', state.leader !== null && !teamIds.includes(state.leader.teamId));
  const inCount = state.teams.length - state.passedTeamIds.length;
  if (state.phase === 'CLOSED') {
    const derived = deriveResult(state);
    add('RESULT_CONFLICT', derived === null || state.result === null || JSON.stringify(derived) !== JSON.stringify(state.result) || state.endReason !== 'COMPLETED');
    add('PHASE_CONFLICT', inCount !== 1);
  } else {
    add('RESULT_CONFLICT', state.result !== null);
    add('PHASE_CONFLICT', inCount < 2);
    if (state.phase === 'ABORTED') add('PHASE_CONFLICT', state.endReason !== 'HOST_ABORTED' && state.endReason !== 'TECHNICAL_ABORT');
    else add('PHASE_CONFLICT', state.endReason !== null);
  }
  add('PHASE_CONFLICT', !opened && (state.leader !== null || state.passedTeamIds.length > 0));
  return [...issues];
}

/**
 * Loading and every returned state go through here: strict structure first (bounds before cross-comparison), then the invariants (including a full replay of the
 * evidence). A damaged state is rejected as a whole (BIDDING_STATE_INVALID with code-only issues) — never sorted, repaired, clamped or reset to an empty bidding.
 */
export function parseBiddingState(raw: unknown): BiddingState {
  if (isPlain(raw)) { // cheap bound check on the arrays BEFORE the element-wise parse
    const big = (value: unknown, limit: number) => Array.isArray(value) && value.length > limit;
    if (big(raw.teams, BIDDING_MAX_TEAMS) || big(raw.history, BIDDING_MAX_STEPS) || big(raw.passedTeamIds, BIDDING_MAX_TEAMS)) throw new BiddingError('BIDDING_STATE_INVALID', ['LIMIT_EXCEEDED']);
  }
  const parsed = BiddingStateSchema.safeParse(raw);
  if (!parsed.success) throw new BiddingError('BIDDING_STATE_INVALID', ['SHAPE_INVALID']);
  const issues = stateIssues(parsed.data);
  if (issues.length) throw new BiddingError('BIDDING_STATE_INVALID', issues);
  return parsed.data;
}

// ── Preparation ──────────────────────────────────────────────

export interface PrepareBiddingInput {
  runIndex: number; roundId: string; biddingId: string; rolesRevision: string; sequenceId: string; rosterRevision: string;
  category: string | null; numeric: unknown;
  /** the pinned teams IN SCHEDULING ORDER (the first team starts); one bidder and one performer per team, nobody twice */
  teams: ReadonlyArray<{ teamId: string; bidderId: string; performerId: string }>;
}
/**
 * Builds the PREPARED state from an already decided assignment. No randomness, no clock, no sorting: the given team order IS the schedule. Invalid input is
 * rejected (BIDDING_CONFIG_INVALID with code-only issues), nothing is repaired or defaulted.
 */
export function prepareBiddingPhase(input: PrepareBiddingInput): BiddingState {
  args_(isPlain(input) && keysWithin(input as unknown as Record<string, unknown>, ['runIndex', 'roundId', 'biddingId', 'rolesRevision', 'sequenceId', 'rosterRevision', 'category', 'numeric', 'teams']));
  const bad = (issues: BiddingIssueCode[]) => new BiddingError('BIDDING_CONFIG_INVALID', issues);
  if (!Array.isArray(input.teams) || input.teams.length > BIDDING_MAX_TEAMS) throw bad(['LIMIT_EXCEEDED']);
  if (!BiddingNumericConfigSchema.safeParse(input.numeric).success) throw bad(['CONFIG_CONFLICT']);
  const candidate = {
    kind: 'BIDDING_PHASE', schemaVersion: BIDDING_SCHEMA_VERSION, runIndex: input.runIndex, roundId: input.roundId, biddingId: input.biddingId, rolesRevision: input.rolesRevision,
    binding: { sequenceId: input.sequenceId, rosterRevision: input.rosterRevision }, category: input.category, numeric: input.numeric,
    teams: (input.teams as unknown[]).map(team => (isPlain(team) ? { ...team } : team)), phase: 'PREPARED', version: 0, stepCount: 0, leader: null, passedTeamIds: [], history: [], result: null, endReason: null,
  };
  try { return parseBiddingState(candidate); } catch (error) {
    throw bad(error instanceof BiddingError && error.issues.length ? [...error.issues] : ['SHAPE_INVALID']);
  }
}

/** The N8 preparation input that fits this bidding exactly (unit TEAM, one member per team: the pinned bidder). Pure; the consumer prepares and starts the sequence. */
export function biddingTurnSequenceInput(rawState: unknown): PrepareTurnSequenceInput {
  const state = parseBiddingState(rawState);
  return {
    runIndex: state.runIndex, sequenceId: state.binding.sequenceId, rosterRevision: state.binding.rosterRevision, unit: 'TEAM', mode: 'FIXED',
    order: state.teams.map(team => team.teamId), teams: state.teams.map(team => ({ teamId: team.teamId, members: [team.bidderId] })),
  };
}

export function biddingScopeOf(state: BiddingState): BiddingScope {
  return { runIndex: state.runIndex, roundId: state.roundId, biddingId: state.biddingId, sequenceId: state.binding.sequenceId, rosterRevision: state.binding.rosterRevision, rolesRevision: state.rolesRevision };
}
/** The N8 scope of the bidding's sequence (unit TEAM is part of the identity). */
export function biddingSequenceScopeOf(state: BiddingState): TurnSequenceScope {
  return { runIndex: state.runIndex, sequenceId: state.binding.sequenceId, rosterRevision: state.binding.rosterRevision, unit: 'TEAM' };
}

function readScope(raw: unknown): BiddingScope {
  const scope = BiddingScopeSchema.safeParse(raw);
  if (!scope.success) throw new BiddingError('BIDDING_ARGS_INVALID');
  return scope.data;
}
/** A malformed scope is an argument error; a well-formed scope of another run / round / bidding / sequence / roster revision / roles revision is STALE. */
function assertScope(state: BiddingState, raw: unknown): BiddingScope {
  const scope = readScope(raw);
  const own = biddingScopeOf(state);
  if (own.runIndex !== scope.runIndex || own.roundId !== scope.roundId || own.biddingId !== scope.biddingId || own.sequenceId !== scope.sequenceId
    || own.rosterRevision !== scope.rosterRevision || own.rolesRevision !== scope.rolesRevision) throw new BiddingError('BIDDING_SCOPE_STALE');
  return scope;
}
function assertVersion(state: BiddingState, expected: unknown): void {
  // a malformed expectedVersion can never equal the stored counter: rejected with the same code (fail closed)
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected !== state.version) throw new BiddingError('BIDDING_VERSION_STALE');
}
function requireOpenPhase(state: BiddingState): void {
  if (state.phase === 'PREPARED') throw new BiddingError('BIDDING_NOT_OPEN');
  if (state.phase !== 'OPEN') throw new BiddingError('BIDDING_ENDED');
}

// ── Scheduling contract (a technical policy, labelled as such) ─────────────

const isIn = (state: BiddingState, teamId: string): boolean => !state.passedTeamIds.includes(teamId);
/**
 * SCHEDULING CONTRACT `CYCLIC_SKIP_LEFT_AND_LEADER`: the next team after `afterTeamId` in the prepared order — cyclically, at most one full round — that is still IN and
 * is not the current leader. Passed teams stay out; the leader waits for competition and is never made to outbid or pass against himself. This is not a master rule;
 * a different order is a different, explicitly prepared contract. `null` if no team qualifies (only the leader is left: the regular end).
 */
export function nextBiddingTeamId(rawState: unknown, afterTeamId: string): string | null {
  const state = parseBiddingState(rawState);
  const start = state.teams.findIndex(team => team.teamId === afterTeamId);
  args_(start >= 0);
  for (let step = 1; step <= state.teams.length; step++) {
    const team = state.teams[(start + step) % state.teams.length];
    if (isIn(state, team.teamId) && state.leader?.teamId !== team.teamId) return team.teamId;
  }
  return null;
}
/** The team that is up according to the schedule: the first team before the first action, then the successor of the last actor. null outside OPEN. */
export function expectedBiddingTeamId(rawState: unknown): string | null {
  const state = parseBiddingState(rawState);
  if (state.phase !== 'OPEN') return null;
  if (state.history.length === 0) return state.teams[0].teamId;
  return nextBiddingTeamId(state, state.history[state.history.length - 1].teamId);
}
const lastTurnNumber = (state: BiddingState): number => (state.history.length === 0 ? 0 : state.history[state.history.length - 1].turnNumber);

// ── Pure transitions ─────────────────────────────────────────

export type BiddingTransitionKind = 'OPEN' | 'BID' | 'PASS' | 'ABORT';
/** The small SERVER-PRIVATE before/after record of one real change, so the later consumer can build its existing SDK state event and audit. Never send it to a client as such. */
export interface BiddingTransition {
  kind: BiddingTransitionKind;
  versionBefore: number; versionAfter: number; stepBefore: number; stepAfter: number;
  phaseBefore: BiddingPhase; phaseAfter: BiddingPhase;
  teamId: string | null; turnNumber: number | null; value: NumericValue | null;
  /** a pass that reached the regular result */
  closed: boolean;
}
export interface BiddingChange { state: BiddingState; changed: boolean; transition: BiddingTransition | null }

function commit(before: BiddingState, kind: BiddingTransitionKind, patch: Partial<BiddingState>, info: { teamId: string | null; turnNumber: number | null; units: number | null }): BiddingChange {
  const leader = patch.leader !== undefined ? patch.leader : before.leader;
  const result = patch.result !== undefined ? patch.result : before.result;
  const after: BiddingState = {
    ...before, ...patch, binding: { ...before.binding }, numeric: { ...before.numeric, min: { ...before.numeric.min }, max: { ...before.numeric.max }, unit: before.numeric.unit === null ? null : { ...before.numeric.unit } },
    teams: before.teams.map(team => ({ ...team })), passedTeamIds: (patch.passedTeamIds ?? before.passedTeamIds).slice(), history: (patch.history ?? before.history).map(entry => ({ ...entry })),
    leader: leader === null ? null : { ...leader }, result: result === null ? null : { ...result },
  };
  after.version = before.version + 1;
  after.stepCount = after.history.length;
  const state = parseBiddingState(after); // validated once more: a transition can never produce an invalid state
  return {
    state, changed: true,
    transition: {
      kind, versionBefore: before.version, versionAfter: state.version, stepBefore: before.stepCount, stepAfter: state.stepCount, phaseBefore: before.phase, phaseAfter: state.phase,
      teamId: info.teamId, turnNumber: info.turnNumber, value: info.units === null ? null : { units: info.units, scale: state.numeric.scale }, closed: kind === 'PASS' && state.phase === 'CLOSED',
    },
  };
}

/**
 * PREPARED → OPEN against the N8 sequence that fits this bidding (unit TEAM, same run / sequence / roster revision, team order and one member (the pinned bidder) per
 * team, phase ACTIVE with the FIRST team's bidder as holder). Nothing is repaired: a sequence that started at another team (the first team was not eligible) is a
 * BIDDING_SEQUENCE_MISMATCH. No bid is invented: no leader, no highest bid 0.
 */
export function openBidding(rawState: unknown, args: { scope: BiddingScope; expectedVersion: number; sequence: unknown }): BiddingChange {
  const state = parseBiddingState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion', 'sequence']));
  assertScope(state, args.scope);
  if (state.phase === 'OPEN') throw new BiddingError('BIDDING_ALREADY_OPEN');
  if (state.phase !== 'PREPARED') throw new BiddingError('BIDDING_ENDED');
  assertVersion(state, args.expectedVersion);
  const sequence = parseTurnSequenceState(args.sequence);
  assertSequenceFits(state, sequence);
  const holder = currentTurnHolder(sequence);
  if (sequence.phase !== 'ACTIVE' || holder === null || holder.teamId !== state.teams[0].teamId || holder.playerId !== state.teams[0].bidderId) throw new BiddingError('BIDDING_SEQUENCE_MISMATCH');
  return commit(state, 'OPEN', { phase: 'OPEN' }, { teamId: null, turnNumber: sequence.turnNumber, units: null });
}

/** The loaded N8 sequence must be the one this bidding is pinned to: run, sequence, roster revision, unit TEAM, team order and exactly the pinned bidder as the only member. */
function assertSequenceFits(state: BiddingState, sequence: TurnSequenceState): void {
  const fits = sequence.runIndex === state.runIndex && sequence.sequenceId === state.binding.sequenceId && sequence.rosterRevision === state.binding.rosterRevision && sequence.unit === 'TEAM'
    && sequence.teams !== null && sequence.teams.length === state.teams.length
    && state.teams.every((team, index) => sequence.order[index] === team.teamId && sequence.teams![index].teamId === team.teamId && sequence.teams![index].members.length === 1 && sequence.teams![index].members[0] === team.bidderId);
  if (!fits) throw new BiddingError('BIDDING_SEQUENCE_MISMATCH');
}

function mapValueError(code: string): BiddingError {
  return new BiddingError(code === 'NUMERIC_OUT_OF_RANGE' ? 'BIDDING_VALUE_OUT_OF_RANGE' : 'BIDDING_VALUE_INVALID');
}

/** Checks shared by bid and pass for an explicitly named team: OPEN, version, known team, increasing turn identity, still in, not the leader. */
function readActor(state: BiddingState, args: Record<string, unknown>): { team: BiddingState['teams'][number]; turnNumber: number } {
  requireOpenPhase(state);
  assertVersion(state, args.expectedVersion);
  const team = typeof args.teamId === 'string' ? state.teams.find(entry => entry.teamId === args.teamId) : undefined;
  if (team === undefined) throw new BiddingError('BIDDING_TEAM_MISMATCH');
  const turnNumber = args.turnNumber;
  args_(typeof turnNumber === 'number' && Number.isSafeInteger(turnNumber) && turnNumber >= 1 && turnNumber <= BIDDING_MAX_COUNTER);
  if (turnNumber <= lastTurnNumber(state)) throw new BiddingError('BIDDING_TURN_STALE');
  if (!isIn(state, team.teamId)) throw new BiddingError('BIDDING_TEAM_PASSED');
  if (state.leader?.teamId === team.teamId) throw new BiddingError('BIDDING_LEADER_CANNOT_ACT');
  return { team, turnNumber };
}

/**
 * The semantic bid for an explicitly named team (no schedule, no N8): OPEN, version, team known / still in / not the leader, the value a canonical N1 value of the right
 * scale inside the profile's range (rejected, never rounded or clamped), and STRICTLY higher than the leader's (jumps allowed; equal or lower is rejected, never
 * raised automatically). The first bid needs only the range. The team becomes the leader with the value: exactly one state change. A bid never ends the bidding.
 */
export function applyBid(rawState: unknown, args: { expectedVersion: number; teamId: string; turnNumber: number; value: unknown }): BiddingChange {
  const state = parseBiddingState(rawState);
  args_(isPlain(args) && keysWithin(args, ['expectedVersion', 'teamId', 'turnNumber', 'value']));
  const { team, turnNumber } = readActor(state, args);
  const checked = validateNumericValue(state.numeric, args.value);
  if (!checked.ok) throw mapValueError(checked.code);
  if (state.leader !== null && checked.value.units <= state.leader.units) throw new BiddingError('BIDDING_VALUE_NOT_HIGHER');
  const inCount = state.teams.length - state.passedTeamIds.length;
  // reservation: after this bid every team still in except the leader must still be able to pass (the bidding can always be finished)
  if (state.stepCount + 1 + (inCount - 1) > BIDDING_MAX_STEPS) throw new BiddingError('BIDDING_STEP_LIMIT');
  if (state.version + 1 + (inCount - 1) > BIDDING_MAX_COUNTER) throw new BiddingError('BIDDING_COUNTER_LIMIT');
  const entry: HistoryEntry = { step: state.stepCount + 1, kind: 'BID', turnNumber, teamId: team.teamId, playerId: team.bidderId, units: checked.value.units };
  return commit(state, 'BID', { history: [...state.history, entry], leader: { teamId: team.teamId, units: checked.value.units } }, { teamId: team.teamId, turnNumber, units: checked.value.units });
}

/**
 * The semantic pass for an explicitly named team: OPEN, version, team known / still in / not the leader, and at least ONE accepted bid exists (a pass before the first
 * bid is rejected: BIDDING_PASS_BEFORE_FIRST_BID — our edge-case policy). The team leaves for good; the evidence records the leader at that moment. With exactly ONE team
 * left the same change ends the bidding regularly (phase CLOSED, the result basis derived from the evidence). With more teams left nothing ends and nobody is
 * re-activated. Two teams: the pass of the non-leader ends it.
 */
export function applyPass(rawState: unknown, args: { expectedVersion: number; teamId: string; turnNumber: number }): BiddingChange {
  const state = parseBiddingState(rawState);
  args_(isPlain(args) && keysWithin(args, ['expectedVersion', 'teamId', 'turnNumber']));
  const { team, turnNumber } = readActor(state, args);
  if (state.leader === null) throw new BiddingError('BIDDING_PASS_BEFORE_FIRST_BID');
  if (state.stepCount + 1 > BIDDING_MAX_STEPS || state.version + 1 > BIDDING_MAX_COUNTER) throw new BiddingError(state.version + 1 > BIDDING_MAX_COUNTER ? 'BIDDING_COUNTER_LIMIT' : 'BIDDING_STEP_LIMIT');
  const entry: HistoryEntry = { step: state.stepCount + 1, kind: 'PASS', turnNumber, teamId: team.teamId, playerId: team.bidderId, againstTeamId: state.leader.teamId, againstUnits: state.leader.units };
  const passedTeamIds = [...state.passedTeamIds, team.teamId];
  const history = [...state.history, entry];
  const closing = state.teams.length - passedTeamIds.length === 1;
  const interim: BiddingState = { ...state, passedTeamIds, history };
  const result = closing ? deriveResult(interim) : null;
  if (closing && result === null) throw new BiddingError('BIDDING_RESULT_INVALID');
  return commit(state, 'PASS', { history, passedTeamIds, ...(closing ? { phase: 'CLOSED' as const, result, endReason: 'COMPLETED' as const } : {}) }, { teamId: team.teamId, turnNumber, units: null });
}

/**
 * Terminal abort without any result: only an explicitly AUTHORISED server decision (`gate.abortAuthorized` is the consumer's own current rights fact, e.g. GAME_ABORT —
 * never a payload field). Allowed from PREPARED and OPEN → ABORTED with an end reason; NO winner, NO target. The last standing stays server-private evidence and is not a
 * result. The N8 sequence is closed in the same call (a closed sequence authorises nothing). Repeating it at the current version is `changed:false`; an older version is
 * stale; a regularly closed bidding is never aborted (BIDDING_ENDED). Disconnect, kick or a missing role never call this by themselves.
 */
export function abortBidding(rawState: unknown, args: { scope: BiddingScope; expectedVersion: number; expectedSequenceVersion: number; sequence: unknown; reason: BiddingAbortReason; gate: { abortAuthorized: boolean } }): { state: BiddingState; sequence: TurnSequenceState; changed: boolean; transition: BiddingTransition | null; sequenceTransition: TurnTransition | null } {
  const state = parseBiddingState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'expectedVersion', 'expectedSequenceVersion', 'sequence', 'reason', 'gate']));
  assertScope(state, args.scope);
  const gate: unknown = args.gate;
  args_(isPlain(gate) && keysWithin(gate, ['abortAuthorized']) && typeof gate.abortAuthorized === 'boolean');
  if (gate.abortAuthorized !== true) throw new BiddingError('BIDDING_ABORT_NOT_AUTHORIZED');
  args_(typeof args.reason === 'string' && (BIDDING_ABORT_REASONS as readonly string[]).includes(args.reason));
  const sequence = parseTurnSequenceState(args.sequence);
  assertSequenceFits(state, sequence);
  assertVersion(state, args.expectedVersion);
  if (state.phase === 'CLOSED') throw new BiddingError('BIDDING_ENDED');
  if (state.phase === 'ABORTED') return { state, sequence, changed: false, transition: null, sequenceTransition: null };
  assertSequenceCapacity(sequence, { version: 1, entitlement: 1 });
  const closed = closeTurnSequence(sequence, { scope: biddingSequenceScopeOf(state), expectedVersion: args.expectedSequenceVersion });
  const change = commit(state, 'ABORT', { phase: 'ABORTED', endReason: args.reason }, { teamId: null, turnNumber: null, units: null });
  return { state: change.state, sequence: closed.state, changed: true, transition: change.transition, sequenceTransition: closed.transition };
}

// ── Full path: N8 turn authorisation + bidding mechanics + atomic handover ─────────

export interface BiddingActionArgs {
  /**
   * The TARGET the client prepared the action for (run, round, bidding, N8 sequence, roster and roles revision) — taken from the client's intent
   * (`biddingActionArgsFromIntent`), NEVER from the state the consumer happens to load now. Filling it from the loaded state would turn every comparison into a
   * tautology and let a late intent of an old bidding act on a new one.
   */
  scope: BiddingScope;
  /** the team the client believes it acts for (an expectation; compared with the team of the authenticated session) */
  teamId: string;
  /** the CURRENT N8 state (the result carries its successor) */
  sequence: unknown;
  /** from the CLIENT's intent: what it saw. All three are compared with the loaded state; none is taken from it. */
  expectedTurnNumber: number; expectedSequenceVersion: number; expectedVersion: number;
  /** from the CURRENTLY admitted session and team assignment, never from a payload */
  caller: TurnActionCaller; gate: TurnActionGate; eligibility: TurnEligibility;
  /** server time for the N8 handover evidence (`lastOverride.atMs`) only — never an ordering source */
  nowMs: number;
}
/** The ONLY intended way to turn a validated client intent into the origin part of the action arguments: target, team expectation and the three counters all come from the intent. */
export function biddingActionArgsFromIntent(intent: BiddingBidIntent | BiddingPassIntent): Pick<BiddingActionArgs, 'scope' | 'teamId' | 'expectedTurnNumber' | 'expectedSequenceVersion' | 'expectedVersion'> {
  const parsed = BiddingActionBindingSchema.safeParse({ scope: intent?.scope, teamId: intent?.teamId, turnNumber: intent?.turnNumber, sequenceVersion: intent?.sequenceVersion, biddingVersion: intent?.biddingVersion });
  if (!parsed.success) throw new BiddingError('BIDDING_ARGS_INVALID');
  const b = parsed.data;
  return { scope: b.scope, teamId: b.teamId, expectedTurnNumber: b.turnNumber, expectedSequenceVersion: b.sequenceVersion, expectedVersion: b.biddingVersion };
}

/** The result of a bid or a pass: the new bidding state AND the new N8 state — to be persisted together in ONE commit. */
export interface BiddingActionResult { state: BiddingState; sequence: TurnSequenceState; changed: true; transition: BiddingTransition; sequenceTransition: TurnTransition | null }

const ACTION_KEYS = ['scope', 'teamId', 'sequence', 'expectedTurnNumber', 'expectedSequenceVersion', 'expectedVersion', 'caller', 'gate', 'eligibility', 'nowMs'];

/** N8 counter capacity, checked BEFORE any change: a handover needs one local version step and one new turn and must leave room for the closing (version, entitlement). */
function assertSequenceCapacity(sequence: TurnSequenceState, need: { version: number; turns?: number; entitlement?: number }): void {
  if (sequence.version + need.version > TURN_SEQUENCE_MAX_COUNTER || sequence.turnNumber + (need.turns ?? 0) > TURN_SEQUENCE_MAX_COUNTER
    || sequence.entitlementRevision + (need.entitlement ?? 0) > TURN_SEQUENCE_MAX_COUNTER) throw new BiddingError('BIDDING_COUNTER_LIMIT');
}

/**
 * Shared prefix of bid and pass. Order: bidding state → shape → bidding scope (stale target) → phase (not open / ended) → N8 sequence fits the pinned one → N8 turn
 * authorisation (state, scope, closed, sequence version, turn number, sequence phase, gate, role, holder, eligibility) → bidding version → the N8 holder is exactly the
 * team the schedule says is up (ONE truth for "who is up") → team expectation = session team and the caller is that team's pinned bidder. Nothing here changes anything.
 */
function authorizeAction(rawState: unknown, args: BiddingActionArgs, extraKeys: readonly string[]): { state: BiddingState; sequence: TurnSequenceState; team: BiddingState['teams'][number] } {
  const state = parseBiddingState(rawState);
  args_(isPlain(args) && keysWithin(args as unknown as Record<string, unknown>, [...ACTION_KEYS, ...extraKeys]));
  assertScope(state, args.scope);
  requireOpenPhase(state);
  const sequence = parseTurnSequenceState(args.sequence);
  assertSequenceFits(state, sequence);
  authorizeTurnAction(sequence, { scope: biddingSequenceScopeOf(state), expectedVersion: args.expectedSequenceVersion, expectedTurnNumber: args.expectedTurnNumber, caller: args.caller, gate: args.gate, eligibility: args.eligibility });
  assertVersion(state, args.expectedVersion);
  const holder = currentTurnHolder(sequence);
  const expectedTeam = expectedBiddingTeamId(state);
  if (holder === null || expectedTeam === null || holder.teamId !== expectedTeam || (state.history.length > 0 && sequence.turnNumber !== lastTurnNumber(state) + 1)) throw new BiddingError('BIDDING_SEQUENCE_MISMATCH');
  const team = state.teams.find(entry => entry.teamId === holder.teamId);
  if (team === undefined || holder.playerId !== team.bidderId) throw new BiddingError('BIDDING_SEQUENCE_MISMATCH');
  if (typeof args.teamId !== 'string' || args.teamId !== args.caller.teamId) throw new BiddingError('BIDDING_TEAM_MISMATCH');
  return { state, sequence, team };
}

/** The handover (or the close) after an accepted semantic change, applied to the N8 sequence in the same call. */
function handOver(change: BiddingChange, sequence: TurnSequenceState, args: BiddingActionArgs): BiddingActionResult {
  const state = change.state;
  const scope = biddingSequenceScopeOf(state);
  if (state.phase === 'CLOSED') {
    const closed = closeTurnSequence(sequence, { scope, expectedVersion: sequence.version });
    return { state, sequence: closed.state, changed: true, transition: change.transition as BiddingTransition, sequenceTransition: closed.transition };
  }
  const nextTeamId = nextBiddingTeamId(state, (change.transition as BiddingTransition).teamId as string);
  const next = state.teams.find(team => team.teamId === nextTeamId);
  if (next === undefined) throw new BiddingError('BIDDING_RESULT_INVALID');
  const handed = overrideTurnSequence(sequence, {
    scope, expectedVersion: sequence.version, expectedTurnNumber: sequence.turnNumber, target: { playerId: next.bidderId, teamId: next.teamId }, eligibility: args.eligibility, now: args.nowMs,
  });
  return { state, sequence: handed.state, changed: true, transition: change.transition as BiddingTransition, sequenceTransition: handed.transition };
}

/**
 * The ONLY full path for a bid. The N8 authorisation runs first, then the bidding mechanics (`applyBid`) for the team the schedule says is up, then — in the same call —
 * the N8 handover to the next team's pinned bidder (`overrideTurnSequence`: one new turn, version +1, the newer eligibility basis committed, no member rotation).
 * N8 and bidding counters are checked for capacity BEFORE any change. If the next bidder is not eligible the handover and therefore the bid is refused
 * (TURN_SEQ_ACTOR_NOT_ELIGIBLE); nothing is persisted by this function either way — the consumer commits state AND sequence together or nothing.
 */
export function placeBid(rawState: unknown, args: BiddingActionArgs & { value: unknown }): BiddingActionResult {
  const { state, sequence, team } = authorizeAction(rawState, args, ['value']);
  assertSequenceCapacity(sequence, { version: 2, turns: 1, entitlement: 1 });
  const change = applyBid(state, { expectedVersion: state.version, teamId: team.teamId, turnNumber: sequence.turnNumber, value: args.value });
  return handOver(change, sequence, args);
}

/** The ONLY full path for a pass. The closing pass ends the bidding regularly and closes the N8 sequence in the same call; every other pass hands the turn on. */
export function passBidding(rawState: unknown, args: BiddingActionArgs): BiddingActionResult {
  const { state, sequence, team } = authorizeAction(rawState, args, []);
  const closing = state.teams.length - state.passedTeamIds.length === 2; // this pass leaves exactly one team: it closes (no new turn), otherwise it hands over
  assertSequenceCapacity(sequence, closing ? { version: 1, entitlement: 1 } : { version: 2, turns: 1, entitlement: 1 });
  const change = applyPass(state, { expectedVersion: state.version, teamId: team.teamId, turnNumber: sequence.turnNumber });
  return handOver(change, sequence, args);
}

// ── Eligibility knowledge and role failure (explicit N8 operations; the bids are untouched) ─────────

function loadFor(rawState: unknown, args: Record<string, unknown>, required: readonly string[]): { state: BiddingState; sequence: TurnSequenceState } {
  const state = parseBiddingState(rawState);
  args_(isPlain(args) && keysWithin(args, required));
  assertScope(state, args.scope);
  requireOpenPhase(state);
  const sequence = parseTurnSequenceState(args.sequence);
  assertSequenceFits(state, sequence);
  assertVersion(state, args.expectedVersion);
  return { state, sequence };
}
/**
 * Records a NEWER N6 eligibility basis in the N8 sequence without any bidding change (N8 `refreshEligibilityBasis`: a BASIS step, no turn, no handover, no bid). An equal
 * basis is a true no-op, an older one stale. The bidding state is returned unchanged — the consumer persists the new sequence.
 */
export function refreshBiddingBasis(rawState: unknown, args: { scope: BiddingScope; expectedVersion: number; expectedSequenceVersion: number; sequence: unknown; eligibility: TurnEligibility }): { state: BiddingState; sequence: TurnSequenceState; sequenceChanged: boolean; sequenceTransition: TurnTransition | null } {
  const { state, sequence } = loadFor(rawState, args as unknown as Record<string, unknown>, ['scope', 'expectedVersion', 'expectedSequenceVersion', 'sequence', 'eligibility']);
  const refreshed = refreshEligibilityBasis(sequence, { scope: biddingSequenceScopeOf(state), expectedVersion: args.expectedSequenceVersion, eligibility: args.eligibility });
  return { state, sequence: refreshed.state, sequenceChanged: refreshed.changed, sequenceTransition: refreshed.transition };
}
/**
 * Makes "the bidder on turn is no longer eligible" explicit (N8 `withholdCurrentHolder` → HELD): nobody acts, no automatic pass, no winner, no defeat. The bidding stays
 * OPEN; it can only continue if the SAME pinned bidder is eligible again by a newer N6 stand and the consumer resolves HELD, or it is aborted by an authorised abort. The bidding state is unchanged.
 */
export function withholdBiddingHolder(rawState: unknown, args: { scope: BiddingScope; expectedVersion: number; expectedSequenceVersion: number; expectedTurnNumber: number; sequence: unknown; eligibility: TurnEligibility }): { state: BiddingState; sequence: TurnSequenceState; sequenceChanged: boolean; sequenceTransition: TurnTransition | null } {
  const { state, sequence } = loadFor(rawState, args as unknown as Record<string, unknown>, ['scope', 'expectedVersion', 'expectedSequenceVersion', 'expectedTurnNumber', 'sequence', 'eligibility']);
  const held = withholdCurrentHolder(sequence, { scope: biddingSequenceScopeOf(state), expectedVersion: args.expectedSequenceVersion, expectedTurnNumber: args.expectedTurnNumber, eligibility: args.eligibility });
  return { state, sequence: held.state, sequenceChanged: held.changed, sequenceTransition: held.transition };
}

// ── Result basis for the later consumer ──────────────────────

/** The result basis a later challenge consumer needs to read — derived again from the evidence, never from a global history. No points. */
export interface BiddingResultBasis {
  winnerTeamId: string; winningValue: NumericValue; bidderId: string; performerId: string;
  /** the team that left LAST against the final winner (the reference for the later fixed scoring; nothing is booked here) */
  lastPassAgainstWinnerTeamId: string; lastPassStep: number;
  /** every other team that left, in pass order, with the team it left against — for the later scoring check "earlier teams get nothing" */
  earlierPasses: ReadonlyArray<{ teamId: string; againstTeamId: string; step: number }>;
}
/** null without a regular result: NOT_OPEN / OPEN / ABORTED never yield a winner or a target. */
export function biddingResultBasisOf(rawState: unknown): BiddingResultBasis | null {
  const state = parseBiddingState(rawState);
  if (state.phase !== 'CLOSED') return null;
  const derived = deriveResult(state);
  if (derived === null) throw new BiddingError('BIDDING_RESULT_INVALID');
  return {
    winnerTeamId: derived.winnerTeamId, winningValue: { units: derived.winningUnits, scale: state.numeric.scale }, bidderId: derived.bidderId, performerId: derived.performerId,
    lastPassAgainstWinnerTeamId: derived.lastPassTeamId, lastPassStep: derived.lastPassStep,
    earlierPasses: state.history.flatMap(entry => (entry.kind === 'PASS' && entry.step !== derived.lastPassStep ? [{ teamId: entry.teamId, againstTeamId: entry.againstTeamId, step: entry.step }] : [])),
  };
}

// ── Client intents at the server boundary ────────────────────

/** Parses a bid intent strictly (unknown keys such as `leader`, `winner`, `highest` or `history` are rejected). The ORIGIN is required; failure is BIDDING_ARGS_INVALID. Returns a fresh copy. */
export function readBiddingBidIntent(raw: unknown): BiddingBidIntent {
  const parsed = BiddingBidIntentSchema.safeParse(raw);
  if (!parsed.success) throw new BiddingError('BIDDING_ARGS_INVALID');
  return parsed.data;
}
export function readBiddingPassIntent(raw: unknown): BiddingPassIntent {
  const parsed = BiddingPassIntentSchema.safeParse(raw);
  if (!parsed.success) throw new BiddingError('BIDDING_ARGS_INVALID');
  return parsed.data;
}
// ── Projection ───────────────────────────────────────────────

const INFORMATION_ROLES = ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'];

/**
 * Projection for ONE caller through a small allowlist (no spread of the private state); re-checked against the strict client schema (`safeParse`, never a ZodError).
 * `audience` must come from the server's admission/session path. The information role is the CURRENT game role: a playing host or administrator is projected as PLAYER; as a
 * defence a HOST audience whose participant id is one of the pinned bidders or performers is treated as that PLAYER (the host's role gives no extra view).
 * `release` is REQUIRED (no default):
 *   - NEUTRAL is allowed for everybody and carries no category, bid, team list, counter or result (see shared/bidding.ts);
 *   - STANDING is allowed only for a pinned BIDDER (as PLAYER), a non-blind HOST, a VIEWER or a DISPLAY (the server's explicit choice). A PLAYER who is not a pinned bidder — a
 *     performer, a third team member, a host who plays as performer — asking for STANDING gets BIDDING_RELEASE_FORBIDDEN; there is no package with the forbidden fields.
 * `you` exists only for a PLAYER audience. `onTurn`, `canBid`, `canPass` come from the CURRENT N8 sequence and only while it agrees with the bidding schedule; otherwise they
 * are absent / false. An ABORTED bidding projects no standing and no outcome (no result exists). The pass order and the evidence are never projected.
 */
export function projectBidding(audience: ProjectionAudience, rawState: unknown, args: { scope: BiddingScope; sequence: unknown; release: 'NEUTRAL' | 'STANDING'; stateVersion: number }): BiddingProjection {
  const state = parseBiddingState(rawState);
  args_(isPlain(args) && keysWithin(args, ['scope', 'sequence', 'release', 'stateVersion']));
  assertScope(state, args.scope);
  const sequence = parseTurnSequenceState(args.sequence);
  assertSequenceFits(state, sequence);
  if (typeof args.release !== 'string' || !(BIDDING_RELEASES as readonly string[]).includes(args.release)) throw new BiddingError('BIDDING_RELEASE_INVALID');
  args_(BiddingStateVersionSchema.safeParse(args.stateVersion).success);
  const bad = () => new BiddingError('BIDDING_AUDIENCE_INVALID');
  if (!isPlain(audience) || typeof audience.role !== 'string' || !INFORMATION_ROLES.includes(audience.role)) throw bad();
  for (const id of [audience.participantId, audience.teamId] as unknown[]) {
    if (id !== undefined && id !== null && !BiddingActorIdSchema.safeParse(id).success) throw bad();
  }
  const participantId = typeof audience.participantId === 'string' && audience.participantId !== '' ? audience.participantId : null;
  const pinned = participantId !== null && state.teams.some(team => team.bidderId === participantId || team.performerId === participantId);
  const effectiveRole = audience.role === 'HOST' && pinned ? 'PLAYER' : audience.role; // a pinned participant is judged by the game role
  const recipientId = effectiveRole === 'PLAYER' ? participantId : null;
  const ownTeam = recipientId === null ? undefined : state.teams.find(team => team.bidderId === recipientId);
  const performer = recipientId !== null && state.teams.some(team => team.performerId === recipientId);
  const base = { contract: BIDDING_CONTRACT, scope: biddingScopeOf(state), recipientId, stateVersion: args.stateVersion };
  let projection: Record<string, unknown>;
  if (args.release === 'NEUTRAL') {
    projection = { ...base, release: 'NEUTRAL', phase: state.phase === 'CLOSED' || state.phase === 'ABORTED' ? 'ENDED' : state.phase, you: recipientId === null ? null : { performer } };
  } else {
    const allowed = (effectiveRole === 'PLAYER' && ownTeam !== undefined) || (effectiveRole === 'HOST' && audience.blindHost !== true) || effectiveRole === 'VIEWER' || effectiveRole === 'DISPLAY';
    if (!allowed) throw new BiddingError('BIDDING_RELEASE_FORBIDDEN');
    const aborted = state.phase === 'ABORTED';
    const leader = aborted ? null : state.leader;
    const holder = currentTurnHolder(sequence);
    const scheduled = expectedBiddingTeamId(state);
    const live = state.phase === 'OPEN' && sequence.phase === 'ACTIVE' && holder !== null && scheduled !== null && holder.teamId === scheduled
      && (state.history.length === 0 || sequence.turnNumber === lastTurnNumber(state) + 1);
    const holdsTurn = live && ownTeam !== undefined && holder !== null && holder.playerId === ownTeam.bidderId && holder.teamId === ownTeam.teamId;
    const canBid = holdsTurn;
    projection = {
      ...base, release: 'STANDING', phase: state.phase, biddingVersion: state.version, sequenceVersion: sequence.version, turnNumber: sequence.turnNumber,
      category: state.category, numeric: projectNumericPublicInput(state.numeric),
      teams: state.teams.map(team => ({ teamId: team.teamId, status: isIn(state, team.teamId) ? 'IN' : 'PASSED', leading: leader !== null && leader.teamId === team.teamId })),
      standing: leader === null ? null : { teamId: leader.teamId, value: { units: leader.units, scale: state.numeric.scale } },
      onTurn: live && holder !== null ? { teamId: holder.teamId as string, playerId: holder.playerId } : null,
      outcome: state.phase === 'CLOSED' && state.result !== null
        ? { winnerTeamId: state.result.winnerTeamId, winningValue: { units: state.result.winningUnits, scale: state.numeric.scale }, bidderId: state.result.bidderId, performerId: state.result.performerId } : null,
      endReason: state.endReason,
      you: recipientId === null ? null : { teamId: ownTeam?.teamId ?? null, holdsTurn, canBid, canPass: canBid && leader !== null },
    };
  }
  const checked = BiddingProjectionSchema.safeParse(projection);
  if (!checked.success) throw new BiddingError('BIDDING_PROJECTION_INVALID'); // never a ZodError: its message could echo values
  return checked.data;
}
