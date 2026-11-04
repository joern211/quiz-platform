import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import * as contract from '@quiz/shared/bidding';
import {
  BIDDING_ERROR_CODES, BIDDING_ISSUE_CODES, BIDDING_MAX_STEPS, BIDDING_MAX_TEAMS, BIDDING_NUMERIC_POSITIVE_INTEGER, BiddingActionBindingSchema, BiddingBidIntentSchema, BiddingError, BiddingProjectionSchema,
  biddingActionBindingKey, biddingContextKey, biddingNextMinimum, biddingProjectionMatches, parseBiddingProjection,
} from '@quiz/shared/bidding';
import { TURN_SEQUENCE_ERROR_CODES, TurnSequenceError } from '@quiz/shared/turnSequence';
import { gameErrorCode } from './errors.js';
import {
  abortBidding, applyBid, applyPass, biddingActionArgsFromIntent, biddingResultBasisOf, biddingScopeOf, biddingTurnSequenceInput, expectedBiddingTeamId, nextBiddingTeamId, openBidding,
  parseBiddingState, passBidding, placeBid, prepareBiddingPhase, projectBidding, readBiddingBidIntent, readBiddingPassIntent, refreshBiddingBasis, withholdBiddingHolder,
  type BiddingActionResult, type BiddingState,
} from './biddingPhase.js';
import { biddingRolesFromRoleDeal, prepareBiddingPhaseFromRoleDeal } from './biddingRoles.js';
import { createSecretRoleDeal } from './secretRoleDeal.js';
import { currentTurnHolder, parseTurnSequenceState, prepareTurnSequence, startTurnSequence, turnSequenceScopeOf, type TurnEligibility, type TurnSequenceState } from './turnSequence.js';
import type { ProjectionAudience } from './visibility.js';

// A mutable view for the deliberate corruption tests (the point is to break the shape).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = any;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── Synthetic fixtures. Ids are not names; the numbers are chosen so that a leak is recognisable in serialised output. ─────────────

const NUMERIC = BIDDING_NUMERIC_POSITIVE_INTEGER;
const CATEGORY = 'Hauptstädte Europas'; // a distinctive category label: must reach only the STANDING audiences
const teamsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ teamId: `T${i + 1}`, bidderId: `b${i + 1}`, performerId: `p${i + 1}` }));
const allPeople = (n: number) => teamsOf(n).flatMap(t => [t.bidderId, t.performerId]);
const lvl = (activeIds: string[], version: number, trackId: string, knownIds: string[], runIndex = 1) => ({ runIndex, trackId, rosterRevision: 'track-roster-1', version, knownIds, activeIds });

interface World { bid: BiddingState; seq: TurnSequenceState; n: number }
interface WorldOver { n?: number; runIndex?: number; roundId?: string; biddingId?: string; sequenceId?: string; rosterRevision?: string; rolesRevision?: string; numeric?: unknown; category?: string | null }
/** Eligibility of ALL teams and ALL pinned people, minus the given inactive ones (an N6 stand: `version` only ever grows within one story). */
const elig = (w: { n: number; seq?: TurnSequenceState }, version = 1, off: { teams?: string[]; people?: string[] } = {}, runIndex = 1): TurnEligibility => ({
  actors: lvl(teamsOf(w.n).map(t => t.teamId).filter(id => !(off.teams ?? []).includes(id)), version, 'teams-track', teamsOf(w.n).map(t => t.teamId), runIndex),
  members: lvl(allPeople(w.n).filter(id => !(off.people ?? []).includes(id)), version, 'members-track', allPeople(w.n), runIndex),
});
function prepared(over: WorldOver = {}): BiddingState {
  return prepareBiddingPhase({
    runIndex: over.runIndex ?? 1, roundId: over.roundId ?? 'round-1', biddingId: over.biddingId ?? 'bidding-1', sequenceId: over.sequenceId ?? 'seq-1',
    rosterRevision: over.rosterRevision ?? 'roster-1', category: over.category === undefined ? CATEGORY : over.category, numeric: over.numeric ?? NUMERIC,
    roles: { source: 'RAW', rolesRevision: over.rolesRevision ?? 'roles-1', teams: teamsOf(over.n ?? 3) }, // RAW = the origin of the assignment is the test's own
  });
}
/** A started N8 team sequence that fits the bidding, a PREPARED bidding and the OPEN bidding against it. Every world has the SAME counters. */
function openWorld(over: WorldOver = {}): World {
  const n = over.n ?? 3;
  const bid = prepared(over);
  const first = prepareTurnSequence(biddingTurnSequenceInput(bid));
  const seq = startTurnSequence(first, { scope: turnSequenceScopeOf(first), expectedVersion: 0, eligibility: elig({ n }, 1, {}, over.runIndex ?? 1) }).state;
  const opened = openBidding(bid, { scope: biddingScopeOf(bid), expectedVersion: 0, sequence: seq });
  return { bid: opened.state, seq, n };
}

const OPEN_GATE = { admitted: true, phaseOpen: true, paused: false };
const holderOf = (w: World) => currentTurnHolder(w.seq) as { teamId: string; playerId: string };
interface ActOver {
  caller?: unknown; gate?: unknown; eligibility?: TurnEligibility; binding?: Record<string, unknown>; value?: unknown; nowMs?: unknown; scopeOver?: Record<string, unknown>;
  sequence?: unknown; stateOverride?: unknown;
}
/** The client's intent: the origin exactly as the client saw it (from ITS last projection — here the world), then the pure domain with the trusted facts. */
function bindingOf(w: World, teamId?: string): Record<string, unknown> {
  return { scope: biddingScopeOf(w.bid), teamId: teamId ?? holderOf(w).teamId, turnNumber: w.seq.turnNumber, sequenceVersion: w.seq.version, biddingVersion: w.bid.version };
}
function actArgs(w: World, kind: 'BID' | 'PASS', over: ActOver = {}) {
  const holder = holderOf(w);
  const binding = { ...bindingOf(w), ...(over.binding ?? {}) } as Record<string, unknown>;
  if (over.scopeOver) binding.scope = { ...(binding.scope as object), ...over.scopeOver };
  const intent = kind === 'BID' ? readBiddingBidIntent({ ...binding, value: over.value }) : readBiddingPassIntent(binding);
  return {
    intent,
    args: {
      ...biddingActionArgsFromIntent(intent), sequence: over.sequence ?? w.seq, caller: over.caller ?? { role: 'PLAYER', participantId: holder.playerId, teamId: holder.teamId },
      gate: over.gate ?? OPEN_GATE, eligibility: over.eligibility ?? elig(w), nowMs: over.nowMs ?? 1000,
    },
  };
}
const num = (units: number) => ({ units, scale: 0 as const });
function bid(w: World, units: unknown, over: ActOver = {}): World & { last: BiddingActionResult } {
  const { args } = actArgs(w, 'BID', { ...over, value: typeof units === 'number' ? num(units) : units });
  const r = placeBid(over.stateOverride ?? w.bid, { ...(args as object), value: typeof units === 'number' ? num(units) : units } as Parameters<typeof placeBid>[1]);
  return { ...w, bid: r.state, seq: r.sequence, last: r };
}
function pass(w: World, over: ActOver = {}): World & { last: BiddingActionResult } {
  const { args } = actArgs(w, 'PASS', over);
  const r = passBidding(over.stateOverride ?? w.bid, args as Parameters<typeof passBidding>[1]);
  return { ...w, bid: r.state, seq: r.sequence, last: r };
}
const codeOf = (fn: () => unknown): string => {
  try { fn(); return 'NO_THROW'; } catch (error) { return error instanceof BiddingError || error instanceof TurnSequenceError ? error.code : `OTHER:${String(error)}`; }
};
const issuesOf = (fn: () => unknown): readonly string[] => { try { fn(); return []; } catch (error) { return error instanceof BiddingError ? error.issues : ['other']; } };
const teamOn = (w: World) => holderOf(w).teamId;

/** The semantic layer for the literal example: named teams, an increasing turn number, no schedule. */
function semantic(state: BiddingState, steps: Array<['BID', string, number] | ['PASS', string]>): BiddingState {
  let current = state;
  steps.forEach((step, i) => {
    const common = { expectedVersion: current.version, teamId: step[1], turnNumber: i + 1 };
    current = step[0] === 'BID' ? applyBid(current, { ...common, value: num(step[2]) }).state : applyPass(current, common).state;
  });
  return current;
}
const openOnly = (n = 3, over: WorldOver = {}) => openWorld({ n, ...over }).bid;

const PLAYER = (participantId: string | null): ProjectionAudience => ({ role: 'PLAYER', participantId });
const VIEWER: ProjectionAudience = { role: 'VIEWER' };
const DISPLAY: ProjectionAudience = { role: 'DISPLAY' };
const HOST: ProjectionAudience = { role: 'HOST', participantId: 'host-1' };
const project = (w: World, audience: ProjectionAudience, release: 'NEUTRAL' | 'STANDING', stateVersion = 7, seq: unknown = w.seq) =>
  projectBidding(audience, w.bid, { scope: biddingScopeOf(w.bid), sequence: seq, release, stateVersion });

// ── A. Preparation and configuration ────────────────────────────────────

describe('A. Preparation: validated, pinned, no invented bid', () => {
  it('prepares a PREPARED bidding: no leader, no highest bid 0, no winner, nobody passed, version 0', () => {
    const state = prepared();
    expect(state).toMatchObject({ kind: 'BIDDING_PHASE', phase: 'PREPARED', version: 0, stepCount: 0, leader: null, passedTeamIds: [], history: [], result: null, endReason: null });
    expect(state.teams.map(t => t.teamId)).toEqual(['T1', 'T2', 'T3']); // the given order IS the schedule
    expect(biddingResultBasisOf(state)).toBeNull();
    expect(expectedBiddingTeamId(state)).toBeNull(); // nobody is up before opening
  });
  it('stores the effective configuration unchanged and keeps no reference to its input', () => {
    const numeric = clone(NUMERIC) as Draft;
    numeric.unit = { label: 'Städte', factor: 1 };
    const input = { runIndex: 1, roundId: 'round-1', biddingId: 'b-1', sequenceId: 's-1', rosterRevision: 'ro-1', category: CATEGORY, numeric, roles: { source: 'RAW' as const, rolesRevision: 'r-1', teams: teamsOf(2) } };
    const snapshot = clone(input);
    const state = prepareBiddingPhase(input);
    expect(state.numeric).toEqual(numeric);
    expect(input).toEqual(snapshot);
    input.roles.teams[0].bidderId = 'changed';
    numeric.max.units = 5;
    expect(state.teams[0].bidderId).toBe('b1');
    expect(state.numeric.max.units).toBe(999);
  });
  it.each([
    ['one team', () => ({ teams: teamsOf(1) })],
    ['more than the maximum number of teams', () => ({ teams: teamsOf(BIDDING_MAX_TEAMS + 1) })],
    ['duplicate team id', () => ({ teams: [teamsOf(2)[0], { ...teamsOf(2)[1], teamId: 'T1' }] })],
    ['a bidder in two teams', () => ({ teams: [teamsOf(2)[0], { ...teamsOf(2)[1], bidderId: 'b1' }] })],
    ['a performer who also bids elsewhere', () => ({ teams: [teamsOf(2)[0], { ...teamsOf(2)[1], performerId: 'b1' }] })],
    ['bidder = performer of the same team', () => ({ teams: [{ teamId: 'T1', bidderId: 'x', performerId: 'x' }, teamsOf(2)[1]] })],
    ['unknown key in a team', () => ({ teams: [{ ...teamsOf(2)[0], captain: 'b1' }, teamsOf(2)[1]] })],
    ['a bid minimum of 0', () => ({ numeric: { ...NUMERIC, min: num(0) } })],
    ['a negative minimum', () => ({ numeric: { ...NUMERIC, min: num(-3) } })],
    ['private bounds', () => ({ numeric: { ...NUMERIC, boundsDisclosure: 'PRIVATE' } })],
    ['maximum below minimum', () => ({ numeric: { ...NUMERIC, min: num(10), max: num(5) } })],
    ['a scale outside the N1 profiles', () => ({ numeric: { ...NUMERIC, scale: 2 } })],
    ['an unknown key in the numeric profile', () => ({ numeric: { ...NUMERIC, step: 5 } })],
    ['a category with control characters', () => ({ category: 'a\u0000b' })],
    ['an empty category (null is the one "no category")', () => ({ category: '' })],
    ['an invalid label (spaces)', () => ({ biddingId: 'has space' })],
  ])('rejects %s with a code-only error and creates nothing', (_name, patch) => {
    const { teams, ...rest } = { teams: teamsOf(3) as unknown, ...patch() } as Record<string, unknown>;
    const input = { runIndex: 1, roundId: 'round-1', biddingId: 'b-1', sequenceId: 's-1', rosterRevision: 'ro-1', category: CATEGORY, numeric: NUMERIC, ...rest, roles: { source: 'RAW', rolesRevision: 'r-1', teams } };
    expect(codeOf(() => prepareBiddingPhase(input as Draft))).toBe('BIDDING_CONFIG_INVALID');
    for (const issue of issuesOf(() => prepareBiddingPhase(input as Draft))) expect(BIDDING_ISSUE_CODES as readonly string[]).toContain(issue);
  });
  it('rejects unknown input keys and a missing key as argument errors', () => {
    expect(codeOf(() => prepareBiddingPhase({ ...({ runIndex: 1 } as Draft) }))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(() => prepareBiddingPhase({ runIndex: 1, roundId: 'r', biddingId: 'b', sequenceId: 's', rosterRevision: 'ro', category: null, numeric: NUMERIC, roles: { source: 'RAW', rolesRevision: 'r', teams: teamsOf(2) }, winner: 'T1' } as Draft))).toBe('BIDDING_ARGS_INVALID');
  });
  it('the one explicit positive profile and an explicit one-decimal profile with a unit are valid; suggested task limits are not limits unless configured', () => {
    expect(codeOf(() => prepared({ numeric: { ...NUMERIC, scale: 1, min: { units: 5, scale: 1 }, max: { units: 500, scale: 1 }, unit: { label: 'kg', factor: 1 } } }))).toBe('NO_THROW');
    const wide = openWorld({ numeric: { ...NUMERIC, max: num(999_999) } });
    expect(codeOf(() => bid(wide, 500_000))).toBe('NO_THROW'); // only the explicit range limits
  });
  it('biddingTurnSequenceInput builds an N8 team sequence that fits exactly (one member per team: the pinned bidder)', () => {
    const input = biddingTurnSequenceInput(prepared());
    expect(input).toMatchObject({ unit: 'TEAM', order: ['T1', 'T2', 'T3'] });
    expect(input.teams).toEqual([{ teamId: 'T1', members: ['b1'] }, { teamId: 'T2', members: ['b2'] }, { teamId: 'T3', members: ['b3'] }]);
  });
});

// ── B. Opening ──────────────────────────────────────────────

describe('B. Opening against the pinned N8 sequence', () => {
  it('PREPARED → OPEN: version 1, still no leader / no winner, the first team is up', () => {
    const w = openWorld();
    expect(w.bid).toMatchObject({ phase: 'OPEN', version: 1, stepCount: 0, leader: null, result: null });
    expect(expectedBiddingTeamId(w.bid)).toBe('T1');
    expect(holderOf(w)).toEqual({ teamId: 'T1', playerId: 'b1' });
  });
  it('opening twice is ALREADY_OPEN; a closed/aborted bidding is ENDED; a stale version is stale', () => {
    const w = openWorld();
    const again = () => openBidding(w.bid, { scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, sequence: w.seq });
    expect(codeOf(again)).toBe('BIDDING_ALREADY_OPEN');
    const p = prepared();
    expect(codeOf(() => openBidding(p, { scope: biddingScopeOf(p), expectedVersion: 3, sequence: w.seq }))).toBe('BIDDING_VERSION_STALE');
  });
  it('rejects a sequence that does not fit — nothing is repaired: PLAYER unit, wrong order, performers as members, other run / sequence / roster, started at another team', () => {
    const p = prepared();
    const fits = prepareTurnSequence(biddingTurnSequenceInput(p));
    const open = (seq: TurnSequenceState) => () => openBidding(p, { scope: biddingScopeOf(p), expectedVersion: 0, sequence: seq });
    const startIt = (s: TurnSequenceState, e: TurnEligibility) => startTurnSequence(s, { scope: turnSequenceScopeOf(s), expectedVersion: 0, eligibility: e }).state;
    const everyone = elig({ n: 3 });
    expect(codeOf(open(startIt(prepareTurnSequence({ runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'PLAYER', mode: 'FIXED', order: ['b1', 'b2', 'b3'] }), { actors: everyone.members as never, members: null })))).toBe('BIDDING_SEQUENCE_MISMATCH');
    const reordered = prepareTurnSequence({ runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM', mode: 'FIXED', order: ['T2', 'T1', 'T3'], teams: [{ teamId: 'T2', members: ['b2'] }, { teamId: 'T1', members: ['b1'] }, { teamId: 'T3', members: ['b3'] }] });
    expect(codeOf(open(startIt(reordered, everyone)))).toBe('BIDDING_SEQUENCE_MISMATCH');
    const withPerformers = prepareTurnSequence({ runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM', mode: 'FIXED', order: ['T1', 'T2', 'T3'], teams: teamsOf(3).map(t => ({ teamId: t.teamId, members: [t.bidderId, t.performerId] })) });
    expect(codeOf(open(startIt(withPerformers, everyone)))).toBe('BIDDING_SEQUENCE_MISMATCH');
    for (const [key, value] of [['runIndex', 2], ['sequenceId', 'seq-other'], ['rosterRevision', 'roster-other']] as const) {
      const other = prepareTurnSequence({ ...biddingTurnSequenceInput(p), [key]: value } as Draft);
      expect(codeOf(open(startIt(other, elig({ n: 3 }, 1, {}, key === 'runIndex' ? 2 : 1))))).toBe('BIDDING_SEQUENCE_MISMATCH');
    }
    // the first team was not eligible, N8 started at T2: a different holder is a mismatch, never "start at T2"
    expect(codeOf(open(startIt(fits, elig({ n: 3 }, 1, { teams: ['T1'] }))))).toBe('BIDDING_SEQUENCE_MISMATCH');
    // not started (READY) is not active
    expect(codeOf(open(fits))).toBe('BIDDING_SEQUENCE_MISMATCH');
  });
  it('every operation in every phase: PREPARED / CLOSED / ABORTED refuse bid, pass, open, basis and hold with the phase codes and change nothing', () => {
    const p = prepared();
    const seqOf = (b: BiddingState) => startTurnSequence(prepareTurnSequence(biddingTurnSequenceInput(b)), { scope: { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM' }, expectedVersion: 0, eligibility: elig({ n: 3 }) }).state;
    const closed = pass(bid(openWorld({ n: 2 }), 3));
    const aborted = (() => { const w = bid(openWorld({ n: 3 }), 3); const out = abortBidding(w.bid, { scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, sequence: w.seq, reason: 'HOST_ABORTED', gate: { abortAuthorized: true } }); return { bid: out.state, seq: out.sequence, n: 3 } as World; })();
    const cases: Array<[string, World, string]> = [['PREPARED', { bid: p, seq: seqOf(p), n: 3 }, 'BIDDING_NOT_OPEN'], ['CLOSED', closed, 'BIDDING_ENDED'], ['ABORTED', aborted, 'BIDDING_ENDED']];
    for (const [name, w, code] of cases) {
      const frozen = [clone(w.bid), clone(w.seq)];
      const scope = biddingScopeOf(w.bid);
      const base = { scope, expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, sequence: w.seq, eligibility: elig(w, 3) };
      expect(codeOf(() => refreshBiddingBasis(w.bid, base)), `${name}: refresh`).toBe(code);
      expect(codeOf(() => withholdBiddingHolder(w.bid, { ...base, expectedTurnNumber: w.seq.turnNumber })), `${name}: withhold`).toBe(code);
      expect(codeOf(() => applyBid(w.bid, { expectedVersion: w.bid.version, teamId: 'T1', turnNumber: 99, value: num(3) })), `${name}: applyBid`).toBe(code);
      expect(codeOf(() => applyPass(w.bid, { expectedVersion: w.bid.version, teamId: 'T1', turnNumber: 99 })), `${name}: applyPass`).toBe(code);
      if (name !== 'PREPARED') expect(codeOf(() => openBidding(w.bid, { scope, expectedVersion: w.bid.version, sequence: w.seq })), `${name}: open`).toBe('BIDDING_ENDED');
      expect([w.bid, w.seq], `${name}: untouched`).toEqual(frozen);
    }
  });
  it('a malformed or foreign scope is stale / invalid, and opening needs the exact argument keys', () => {
    const p = prepared();
    const seq = startTurnSequence(prepareTurnSequence(biddingTurnSequenceInput(p)), { scope: { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM' }, expectedVersion: 0, eligibility: elig({ n: 3 }) }).state;
    expect(codeOf(() => openBidding(p, { scope: { ...biddingScopeOf(p), biddingId: 'other' }, expectedVersion: 0, sequence: seq }))).toBe('BIDDING_SCOPE_STALE');
    expect(codeOf(() => openBidding(p, { scope: { runIndex: 1 } as Draft, expectedVersion: 0, sequence: seq }))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(() => openBidding(p, { scope: biddingScopeOf(p), expectedVersion: 0, sequence: seq, extra: 1 } as Draft))).toBe('BIDDING_ARGS_INVALID');
  });
});

// ── C. Semantic layer: the mechanics without any schedule ────────────────────

describe('C. Bid and pass semantics (named teams, no schedule)', () => {
  it('LITERAL example of the game description: T1 3 → T2 5 → T1 passes against T2 → T3 8 → T2 passes against T3: T3 wins with 8 for its OWN pair; T2 left last against T3; T1 earlier and against T2', () => {
    const done = semantic(openOnly(3), [['BID', 'T1', 3], ['BID', 'T2', 5], ['PASS', 'T1'], ['BID', 'T3', 8], ['PASS', 'T2']]);
    expect(done.phase).toBe('CLOSED');
    const basis = biddingResultBasisOf(done);
    expect(basis).toMatchObject({ winnerTeamId: 'T3', winningValue: num(8), bidderId: 'b3', performerId: 'p3', lastPassAgainstWinnerTeamId: 'T2' });
    expect(basis?.earlierPasses).toEqual([{ teamId: 'T1', againstTeamId: 'T2', step: 3 }]); // earlier, and against T2 (not against the winner): scores nothing later
    expect(done.endReason).toBe('COMPLETED');
    expect(done.history.map(entry => [entry.step, entry.kind, entry.teamId])).toEqual([[1, 'BID', 'T1'], [2, 'BID', 'T2'], [3, 'PASS', 'T1'], [4, 'BID', 'T3'], [5, 'PASS', 'T2']]);
    expect(done.history[2]).toMatchObject({ kind: 'PASS', againstTeamId: 'T2', againstUnits: 5 }); // the pass remembers WHO LED at that moment
    expect(done.history[4]).toMatchObject({ kind: 'PASS', againstTeamId: 'T3', againstUnits: 8 });
  });
  it('two teams: start bid → higher raise → pass: the pass ends the bidding at once with the right result', () => {
    const open = openOnly(2);
    const mid = semantic(open, [['BID', 'T1', 4], ['BID', 'T2', 9]]);
    expect(mid.phase).toBe('OPEN');
    const done = semantic(open, [['BID', 'T1', 4], ['BID', 'T2', 9], ['PASS', 'T1']]);
    expect(done.phase).toBe('CLOSED');
    expect(biddingResultBasisOf(done)).toMatchObject({ winnerTeamId: 'T2', winningValue: num(9), bidderId: 'b2', performerId: 'p2', lastPassAgainstWinnerTeamId: 'T1', earlierPasses: [] });
    const quick = semantic(open, [['BID', 'T1', 4], ['PASS', 'T2']]);
    expect(biddingResultBasisOf(quick)).toMatchObject({ winnerTeamId: 'T1', winningValue: num(4), lastPassAgainstWinnerTeamId: 'T2' });
  });
  it('three teams: the FIRST pass does not end the bidding; the passed team stays out; only the second pass ends it', () => {
    const open = openOnly(3);
    const afterFirst = semantic(open, [['BID', 'T1', 2], ['BID', 'T2', 3], ['PASS', 'T3']]);
    expect(afterFirst.phase).toBe('OPEN');
    expect(afterFirst.passedTeamIds).toEqual(['T3']);
    expect(biddingResultBasisOf(afterFirst)).toBeNull(); // no result before the regular end
    expect(semantic(open, [['BID', 'T1', 2], ['BID', 'T2', 3], ['PASS', 'T3'], ['BID', 'T1', 7]]).phase).toBe('OPEN'); // T1 raised; T2 is still in
    const finished = semantic(open, [['BID', 'T1', 2], ['BID', 'T2', 3], ['PASS', 'T3'], ['BID', 'T1', 7], ['PASS', 'T2']]);
    expect(biddingResultBasisOf(finished)).toMatchObject({ winnerTeamId: 'T1', winningValue: num(7), lastPassAgainstWinnerTeamId: 'T2', earlierPasses: [{ teamId: 'T3', againstTeamId: 'T2', step: 3 }] });
  });
  it('four teams: several raises and passes; the leader changes; the last team to leave AGAINST THE FINAL WINNER is not "the last team that passed" and not an earlier team', () => {
    const open = openOnly(4);
    // T1 3, T2 5, T3 7, T4 9; T1 and T2 pass against T4; T3 raises to 12; T4 passes against T3 → T3 wins.
    const done = semantic(open, [['BID', 'T1', 3], ['BID', 'T2', 5], ['BID', 'T3', 7], ['BID', 'T4', 9], ['PASS', 'T1'], ['PASS', 'T2'], ['BID', 'T3', 12], ['PASS', 'T4']]);
    expect(done.phase).toBe('CLOSED');
    expect(biddingResultBasisOf(done)).toMatchObject({ winnerTeamId: 'T3', winningValue: num(12), bidderId: 'b3', performerId: 'p3', lastPassAgainstWinnerTeamId: 'T4' });
    expect(biddingResultBasisOf(done)?.earlierPasses).toEqual([{ teamId: 'T1', againstTeamId: 'T4', step: 5 }, { teamId: 'T2', againstTeamId: 'T4', step: 6 }]);
    // another ending: the SAME team that passed LAST overall is not the reference if it passed against somebody else.
    const other = semantic(open, [['BID', 'T1', 3], ['BID', 'T2', 5], ['PASS', 'T3'], ['BID', 'T4', 8], ['PASS', 'T1'], ['BID', 'T2', 11], ['PASS', 'T4']]);
    expect(biddingResultBasisOf(other)).toMatchObject({ winnerTeamId: 'T2', winningValue: num(11), lastPassAgainstWinnerTeamId: 'T4' });
    expect(other.history.filter(e => e.kind === 'PASS').map(e => [e.teamId, (e as Draft).againstTeamId])).toEqual([['T3', 'T2'], ['T1', 'T4'], ['T4', 'T2']]);
    // earlier passes against the winner count too: the LAST of them is the reference, not the first
    const both = semantic(open, [['BID', 'T1', 3], ['BID', 'T2', 5], ['PASS', 'T3'], ['PASS', 'T1'], ['PASS', 'T4']]);
    expect(biddingResultBasisOf(both)).toMatchObject({ winnerTeamId: 'T2', lastPassAgainstWinnerTeamId: 'T4', earlierPasses: [{ teamId: 'T3', againstTeamId: 'T2', step: 3 }, { teamId: 'T1', againstTeamId: 'T2', step: 4 }] });
  });
  it('jumps are allowed; equal and lower bids are rejected (not rounded, not raised); the first bid needs only the range; the minimum and the maximum are valid', () => {
    const open = openOnly(3);
    const first = applyBid(open, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value: num(1) }).state; // the minimum
    expect(first.leader).toEqual({ teamId: 'T1', units: 1 });
    const jump = applyBid(first, { expectedVersion: 2, teamId: 'T2', turnNumber: 2, value: num(500) }).state; // a jump
    expect(jump.leader).toEqual({ teamId: 'T2', units: 500 });
    expect(codeOf(() => applyBid(jump, { expectedVersion: 3, teamId: 'T3', turnNumber: 3, value: num(500) }))).toBe('BIDDING_VALUE_NOT_HIGHER'); // equal
    expect(codeOf(() => applyBid(jump, { expectedVersion: 3, teamId: 'T3', turnNumber: 3, value: num(499) }))).toBe('BIDDING_VALUE_NOT_HIGHER'); // lower
    expect(codeOf(() => applyBid(jump, { expectedVersion: 3, teamId: 'T3', turnNumber: 3, value: num(1) }))).toBe('BIDDING_VALUE_NOT_HIGHER');
    const top = applyBid(jump, { expectedVersion: 3, teamId: 'T3', turnNumber: 3, value: num(999) }).state; // the maximum
    expect(top.leader?.units).toBe(999);
    expect(codeOf(() => applyBid(top, { expectedVersion: 4, teamId: 'T1', turnNumber: 4, value: num(1000) }))).toBe('BIDDING_VALUE_OUT_OF_RANGE');
    expect(top.version).toBe(4); // a rejection changed nothing
  });
  it('the first bid is range-checked: below the minimum, above the maximum, zero, negative', () => {
    const open = openOnly(2);
    for (const units of [0, -1, 1000, 999_999]) {
      expect(codeOf(() => applyBid(open, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value: num(units) }))).toBe('BIDDING_VALUE_OUT_OF_RANGE');
    }
    const ranged = openOnly(2, { numeric: { ...NUMERIC, min: num(10), max: num(20) } });
    expect(codeOf(() => applyBid(ranged, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value: num(9) }))).toBe('BIDDING_VALUE_OUT_OF_RANGE');
    expect(codeOf(() => applyBid(ranged, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value: num(21) }))).toBe('BIDDING_VALUE_OUT_OF_RANGE');
    expect(codeOf(() => applyBid(ranged, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value: num(10) }))).toBe('NO_THROW');
  });
  it('the one-decimal profile compares exact scaled integers (no float): 0,3 < 0,4; 1,0 is not 1; a wrong scale is invalid, never converted', () => {
    const dec = { ...NUMERIC, scale: 1, min: { units: 1, scale: 1 }, max: { units: 1000, scale: 1 } };
    const open = openOnly(2, { numeric: dec });
    const a = applyBid(open, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value: { units: 3, scale: 1 } }).state; // 0,3
    expect(codeOf(() => applyBid(a, { expectedVersion: 2, teamId: 'T2', turnNumber: 2, value: { units: 3, scale: 1 } }))).toBe('BIDDING_VALUE_NOT_HIGHER');
    expect(applyBid(a, { expectedVersion: 2, teamId: 'T2', turnNumber: 2, value: { units: 4, scale: 1 } }).state.leader?.units).toBe(4); // 0,4 beats 0,3
    expect(codeOf(() => applyBid(a, { expectedVersion: 2, teamId: 'T2', turnNumber: 2, value: num(1) }))).toBe('BIDDING_VALUE_INVALID'); // scale 0 against a scale-1 profile: no silent ×10
    expect(biddingNextMinimum({ scale: 1, bounds: { min: { units: 1, scale: 1 } } }, { units: 3, scale: 1 })).toEqual({ units: 4, scale: 1 });
    expect(biddingNextMinimum({ scale: 0, bounds: { min: num(1) } }, null)).toEqual(num(1));
  });
  it.each([
    ['NaN', { units: NaN, scale: 0 }], ['Infinity', { units: Infinity, scale: 0 }], ['a fraction', { units: 1.5, scale: 0 }], ['an unsafe integer', { units: 2 ** 53, scale: 0 }],
    ['a string value', '7'], ['a locale string', '1,5'], ['a bare number', 7], ['null', null], ['undefined', undefined], ['a boolean', true], ['an array', [7]],
    ['unknown keys', { units: 7, scale: 0, extra: 1 }], ['missing scale', { units: 7 }], ['missing units', { scale: 0 }], ['negative zero', { units: -0, scale: 0 }], ['a huge value', { units: 10 ** 20, scale: 0 }],
  ])('rejects %s as an invalid value with a code-only error and no change', (_name, value) => {
    const open = openOnly(2);
    expect(codeOf(() => applyBid(open, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value }))).toMatch(/^BIDDING_VALUE_(INVALID|OUT_OF_RANGE)$/);
    try { applyBid(open, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value }); } catch (error) {
      const message = String((error as Error).message);
      expect(message).toBe((error as BiddingError).code); // the message is the code: no raw value in it
    }
  });
  it('a team that passed can neither bid nor pass again; nobody is re-activated', () => {
    const state = semantic(openOnly(3), [['BID', 'T1', 2], ['PASS', 'T2']]);
    expect(codeOf(() => applyBid(state, { expectedVersion: state.version, teamId: 'T2', turnNumber: 9, value: num(50) }))).toBe('BIDDING_TEAM_PASSED');
    expect(codeOf(() => applyPass(state, { expectedVersion: state.version, teamId: 'T2', turnNumber: 9 }))).toBe('BIDDING_TEAM_PASSED');
    expect(state.passedTeamIds).toEqual(['T2']);
  });
  it('the leader cannot outbid or pass against himself', () => {
    const state = semantic(openOnly(3), [['BID', 'T1', 2]]);
    expect(codeOf(() => applyBid(state, { expectedVersion: state.version, teamId: 'T1', turnNumber: 2, value: num(50) }))).toBe('BIDDING_LEADER_CANNOT_ACT');
    expect(codeOf(() => applyPass(state, { expectedVersion: state.version, teamId: 'T1', turnNumber: 2 }))).toBe('BIDDING_LEADER_CANNOT_ACT');
  });
  it('EDGE POLICY: a pass before the first accepted bid is rejected — no result, no winner, nothing changes (2, 3 and 4 teams)', () => {
    for (const n of [2, 3, 4]) {
      const open = openOnly(n);
      expect(codeOf(() => applyPass(open, { expectedVersion: 1, teamId: 'T2', turnNumber: 1 }))).toBe('BIDDING_PASS_BEFORE_FIRST_BID');
      expect(biddingResultBasisOf(open)).toBeNull();
      expect(open.leader).toBeNull();
    }
  });
  it('unknown team, stale version and a non-increasing turn identity are rejected before any effect', () => {
    const open = openOnly(3);
    expect(codeOf(() => applyBid(open, { expectedVersion: 1, teamId: 'T9', turnNumber: 1, value: num(3) }))).toBe('BIDDING_TEAM_MISMATCH');
    expect(codeOf(() => applyBid(open, { expectedVersion: 0, teamId: 'T1', turnNumber: 1, value: num(3) }))).toBe('BIDDING_VERSION_STALE');
    expect(codeOf(() => applyBid(open, { expectedVersion: 2, teamId: 'T1', turnNumber: 1, value: num(3) }))).toBe('BIDDING_VERSION_STALE');
    expect(codeOf(() => applyBid(open, { expectedVersion: 1.5 as number, teamId: 'T1', turnNumber: 1, value: num(3) }))).toBe('BIDDING_VERSION_STALE');
    const one = applyBid(open, { expectedVersion: 1, teamId: 'T1', turnNumber: 5, value: num(3) }).state;
    expect(codeOf(() => applyBid(one, { expectedVersion: 2, teamId: 'T2', turnNumber: 5, value: num(4) }))).toBe('BIDDING_TURN_STALE');
    expect(codeOf(() => applyBid(one, { expectedVersion: 2, teamId: 'T2', turnNumber: 4, value: num(4) }))).toBe('BIDDING_TURN_STALE');
    expect(codeOf(() => applyBid(one, { expectedVersion: 2, teamId: 'T2', turnNumber: 0, value: num(4) }))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(() => applyBid(open, { expectedVersion: 1, teamId: 'T1', turnNumber: 1, value: num(3), winner: 'T1' } as Draft))).toBe('BIDDING_ARGS_INVALID');
  });
  it('not opened → NOT_OPEN; a regularly closed bidding is terminal: a late or duplicate delivery closes nothing twice and creates no second result', () => {
    const p = prepared();
    expect(codeOf(() => applyBid(p, { expectedVersion: 0, teamId: 'T1', turnNumber: 1, value: num(3) }))).toBe('BIDDING_NOT_OPEN');
    expect(codeOf(() => applyPass(p, { expectedVersion: 0, teamId: 'T1', turnNumber: 1 }))).toBe('BIDDING_NOT_OPEN');
    const done = semantic(openOnly(2), [['BID', 'T1', 4], ['PASS', 'T2']]);
    const before = clone(done);
    expect(codeOf(() => applyPass(done, { expectedVersion: done.version, teamId: 'T2', turnNumber: 9 }))).toBe('BIDDING_ENDED');
    expect(codeOf(() => applyBid(done, { expectedVersion: done.version, teamId: 'T2', turnNumber: 9, value: num(9) }))).toBe('BIDDING_ENDED');
    expect(done).toEqual(before);
    expect(biddingResultBasisOf(done)).toMatchObject({ winnerTeamId: 'T1' });
  });
  it('the step limit is a reservation: a bid that would leave no room for the passes is refused (STEP_LIMIT), the bidding can still be finished by passing; nothing is clamped', () => {
    const wide = openOnly(2, { numeric: { ...NUMERIC, max: num(999_999) } });
    let state = wide, turn = 1, next = 'T1';
    while (state.stepCount < BIDDING_MAX_STEPS - 2) {
      state = applyBid(state, { expectedVersion: state.version, teamId: next, turnNumber: turn, value: num(turn) }).state;
      turn++; next = next === 'T1' ? 'T2' : 'T1';
    }
    expect(state.stepCount).toBe(BIDDING_MAX_STEPS - 2);
    const before = clone(state);
    expect(codeOf(() => applyBid(state, { expectedVersion: state.version, teamId: next, turnNumber: turn, value: num(turn) }))).toBe('NO_THROW'); // 198 steps → this one is the 199th, still leaves the pass
    state = applyBid(state, { expectedVersion: state.version, teamId: next, turnNumber: turn, value: num(turn) }).state;
    turn++; next = next === 'T1' ? 'T2' : 'T1';
    expect(state.stepCount).toBe(BIDDING_MAX_STEPS - 1);
    const frozen = clone(state);
    expect(codeOf(() => applyBid(state, { expectedVersion: state.version, teamId: next, turnNumber: turn, value: num(turn) }))).toBe('BIDDING_STEP_LIMIT');
    expect(state).toEqual(frozen);
    const done = applyPass(state, { expectedVersion: state.version, teamId: next, turnNumber: turn }).state; // the passing step 200 ends it
    expect(done.phase).toBe('CLOSED');
    expect(done.stepCount).toBe(BIDDING_MAX_STEPS);
    expect(before.stepCount).toBe(BIDDING_MAX_STEPS - 2);
  });
  it('is pure: no input mutation, deterministic, no clock and no random source', () => {
    const random = vi.spyOn(Math, 'random'), now = vi.spyOn(Date, 'now');
    const open = openOnly(3);
    const frozen = clone(open);
    const a = semantic(open, [['BID', 'T1', 3], ['BID', 'T2', 5], ['PASS', 'T1'], ['BID', 'T3', 8], ['PASS', 'T2']]);
    const b = semantic(open, [['BID', 'T1', 3], ['BID', 'T2', 5], ['PASS', 'T1'], ['BID', 'T3', 8], ['PASS', 'T2']]);
    expect(a).toEqual(b);
    expect(open).toEqual(frozen);
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    random.mockRestore(); now.mockRestore();
  });
});

// ── D. Full path: N8 authorisation, scheduling contract, atomic handover ──────────

describe('D. Full path with N8: schedule, handover, no bidder rotation', () => {
  it('scheduling contract: cyclic order, skipping passed teams and the leader (table)', () => {
    const base = openOnly(4);
    expect(nextBiddingTeamId(base, 'T1')).toBe('T2');
    expect(nextBiddingTeamId(base, 'T4')).toBe('T1'); // cyclic
    const led = semantic(base, [['BID', 'T1', 2]]); // leader T1
    expect(nextBiddingTeamId(led, 'T4')).toBe('T2'); // T1 (the leader) is skipped
    const passed = semantic(base, [['BID', 'T1', 2], ['PASS', 'T2'], ['BID', 'T3', 5]]); // leader T3, T2 out
    expect(nextBiddingTeamId(passed, 'T3')).toBe('T4');
    expect(nextBiddingTeamId(passed, 'T4')).toBe('T1'); // T2 out, T3 leads
    expect(expectedBiddingTeamId(passed)).toBe('T4'); // the successor of the last actor
    expect(expectedBiddingTeamId(base)).toBe('T1');
    expect(codeOf(() => nextBiddingTeamId(base, 'T9'))).toBe('BIDDING_ARGS_INVALID');
  });
  it('three teams on a valid schedule: T1 3 → T2 5 → T3 passes → T1 7 → T2 passes: T1 wins 7, T2 left last against T1, T3 earlier (against T2); the N8 sequence is closed in the same call', () => {
    let w = openWorld();
    expect(teamOn(w)).toBe('T1');
    w = bid(w, 3); expect(teamOn(w)).toBe('T2');
    w = bid(w, 5); expect(teamOn(w)).toBe('T3');
    w = pass(w); expect(w.bid.passedTeamIds).toEqual(['T3']); expect(w.bid.phase).toBe('OPEN'); expect(teamOn(w)).toBe('T1'); // T3 → T1 (T2 leads, cyclic)
    w = bid(w, 7); expect(teamOn(w)).toBe('T2'); // T1 leads now, T3 out
    const closing = pass(w);
    w = closing;
    expect(w.bid.phase).toBe('CLOSED');
    expect(w.seq.phase).toBe('CLOSED'); // closed together with the result: nothing can be authorised any more
    expect(biddingResultBasisOf(w.bid)).toMatchObject({ winnerTeamId: 'T1', winningValue: num(7), bidderId: 'b1', performerId: 'p1', lastPassAgainstWinnerTeamId: 'T2', earlierPasses: [{ teamId: 'T3', againstTeamId: 'T2', step: 3 }] });
    expect(closing.last.transition.closed).toBe(true);
    expect(closing.last.sequenceTransition?.kind).toBe('CLOSE');
  });
  it('four teams on a valid schedule: the first pass ends nothing, passed teams are skipped, the leader waits, the last opponent is reconstructable', () => {
    let w = openWorld({ n: 4 });
    const trail: string[] = [teamOn(w)];
    const step = (next: World) => { w = next; trail.push(w.bid.phase === 'OPEN' ? teamOn(w) : 'END'); };
    step(bid(w, 2));            // T1 leads → T2
    step(bid(w, 4));            // T2 leads → T3
    step(bid(w, 6));            // T3 leads → T4
    step(pass(w));              // T4 passes (against T3) → T1 (T2 not leader but cyclic: after T4 comes T1)
    expect(w.bid.phase).toBe('OPEN');
    step(bid(w, 9));            // T1 leads → T2
    step(pass(w));              // T2 passes (against T1) → T3
    step(pass(w));              // T3 passes (against T1): T1 alone → END
    expect(trail).toEqual(['T1', 'T2', 'T3', 'T4', 'T1', 'T2', 'T3', 'END']);
    expect(biddingResultBasisOf(w.bid)).toMatchObject({ winnerTeamId: 'T1', winningValue: num(9), lastPassAgainstWinnerTeamId: 'T3' });
    expect(biddingResultBasisOf(w.bid)?.earlierPasses).toEqual([{ teamId: 'T4', againstTeamId: 'T3', step: 4 }, { teamId: 'T2', againstTeamId: 'T1', step: 6 }]);
  });
  it('NO bidder rotation: after many actions every N8 team still has exactly the pinned bidder as its only member, cursors are 0 and nothing counts as a completed turn', () => {
    let w = openWorld({ n: 3 });
    for (let units = 1; units <= 12; units++) w = bid(w, units);
    expect(w.seq.completedTurns).toBe(0);
    expect(w.seq.teams?.map(t => [t.teamId, t.members, t.cursor])).toEqual([['T1', ['b1'], 0], ['T2', ['b2'], 0], ['T3', ['b3'], 0]]);
    expect(w.seq.cycle).toBe(0);
    expect(w.seq.turnNumber).toBe(13); // every handover is ONE new turn: the action identity
    expect(w.bid.history.map(e => e.turnNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(w.bid.history.map(e => e.playerId).every(id => ['b1', 'b2', 'b3'].includes(id))).toBe(true); // never a performer
  });
  it('the bid and the handover are ONE result: bidding version, step, N8 turn, N8 sequence version and the newer eligibility basis all move together; the inputs are untouched', () => {
    const w = openWorld();
    const frozenBid = clone(w.bid), frozenSeq = clone(w.seq);
    const next = bid(w, 4, { eligibility: elig(w, 3) });
    expect(w.bid).toEqual(frozenBid);
    expect(w.seq).toEqual(frozenSeq);
    expect(next.bid).toMatchObject({ version: 2, stepCount: 1, leader: { teamId: 'T1', units: 4 } });
    expect(next.seq).toMatchObject({ turnNumber: 2, version: w.seq.version + 1 });
    expect(next.seq.eligibility?.actors.version).toBe(3); // N8-02: the newer N6 stand is not lost on a successful bid
    expect(next.seq.eligibility?.members?.version).toBe(3);
    expect(next.last.transition).toMatchObject({ kind: 'BID', versionBefore: 1, versionAfter: 2, stepAfter: 1, teamId: 'T1', turnNumber: 1, value: num(4), closed: false });
    expect(next.last.sequenceTransition).toMatchObject({ kind: 'OVERRIDE', turnNumberBefore: 1, turnNumberAfter: 2 });
  });
  it('an OLDER N6 stand is stale and changes nothing; an eligibility of another run or track is a mismatch', () => {
    const w = openWorld();
    const v2 = bid(w, 3, { eligibility: elig(w, 2) });
    expect(codeOf(() => bid(v2, 5, { eligibility: elig(v2, 1) }))).toBe('TURN_SEQ_ELIGIBILITY_STALE');
    expect(codeOf(() => bid(v2, 5, { eligibility: elig(v2, 2, {}, 2) }))).toBe('TURN_SEQ_ELIGIBILITY_MISMATCH');
  });
  it('N8 authorisation first: performer, other team bidder, host, viewer, display, an unknown role, blocked gate', () => {
    const w = openWorld();
    const caller = (role: string, participantId: string, teamId: string | null) => ({ role, participantId, teamId });
    expect(codeOf(() => bid(w, 3, { caller: caller('PLAYER', 'p1', 'T1') }))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR'); // the performer of the team on turn
    expect(codeOf(() => bid(w, 3, { caller: caller('PLAYER', 'b2', 'T2') }))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR'); // the opposing bidder
    expect(codeOf(() => bid(w, 3, { caller: caller('PLAYER', 'b1', 'T2') }))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR'); // the right person with a foreign team id
    expect(codeOf(() => bid(w, 3, { caller: caller('HOST', 'host-1', null) }))).toBe('TURN_SEQ_ROLE_NOT_ALLOWED'); // host rights give no bid
    expect(codeOf(() => bid(w, 3, { caller: caller('HOST', 'b1', 'T1') }))).toBe('TURN_SEQ_ROLE_NOT_ALLOWED'); // not even as the bidder's id: the role is HOST
    expect(codeOf(() => bid(w, 3, { caller: caller('VIEWER', 'b1', 'T1') }))).toBe('TURN_SEQ_ROLE_NOT_ALLOWED');
    expect(codeOf(() => bid(w, 3, { caller: caller('DISPLAY', 'b1', 'T1') }))).toBe('TURN_SEQ_ROLE_NOT_ALLOWED');
    expect(codeOf(() => bid(w, 3, { caller: caller('PLAYER', 'p2', 'T2') }))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR'); // a playing host as the performer of another team
    for (const gate of [{ admitted: false, phaseOpen: true, paused: false }, { admitted: true, phaseOpen: false, paused: false }, { admitted: true, phaseOpen: true, paused: true }]) {
      expect(codeOf(() => bid(w, 3, { gate }))).toBe('TURN_SEQ_ACTION_BLOCKED');
      expect(codeOf(() => pass(w, { gate }))).toBe('TURN_SEQ_ACTION_BLOCKED');
    }
  });
  it('the team in the intent is only an EXPECTATION: a different team than the session team is BIDDING_TEAM_MISMATCH', () => {
    const w = openWorld();
    expect(codeOf(() => bid(w, 3, { binding: { teamId: 'T2' } }))).toBe('BIDDING_TEAM_MISMATCH');
    expect(codeOf(() => pass(bid(w, 3), { binding: { teamId: 'T3' } }))).toBe('BIDDING_TEAM_MISMATCH');
  });
  it('the leader never has the turn: N8 refuses his action (he waits); a team that passed is no holder either', () => {
    let w = openWorld();
    w = bid(w, 3);
    // T1 leads; T1 (not the holder) tries to bid again with its own current-looking binding
    expect(codeOf(() => bid(w, 9, { caller: { role: 'PLAYER', participantId: 'b1', teamId: 'T1' }, binding: { teamId: 'T1' } }))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
    w = bid(w, 5); w = pass(w); // T3 passes
    expect(codeOf(() => pass(w, { caller: { role: 'PLAYER', participantId: 'b3', teamId: 'T3' }, binding: { teamId: 'T3' } }))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR');
  });
  it('a bid that is not higher, a value out of range or a pass before the first bid is refused by the full path with NO state or sequence result', () => {
    const w = openWorld();
    expect(codeOf(() => pass(w))).toBe('BIDDING_PASS_BEFORE_FIRST_BID');
    expect(codeOf(() => bid(w, 0))).toBe('BIDDING_VALUE_OUT_OF_RANGE');
    const one = bid(w, 6);
    expect(codeOf(() => bid(one, 6))).toBe('BIDDING_VALUE_NOT_HIGHER');
    expect(codeOf(() => bid(one, 5))).toBe('BIDDING_VALUE_NOT_HIGHER');
    expect(codeOf(() => bid(one, { units: 7, scale: 1 }))).toBe('BIDDING_VALUE_INVALID');
  });
  it('INTENT ORIGIN: every identity level is compared with the trusted state (run, round, bidding, sequence, roster, roles) — a stale intent is refused BEFORE any effect, for bid AND pass, with identical counters', () => {
    const old = openWorld();
    const fresh = openWorld(); // a NEW bidding with the SAME counters and the SAME current player
    const prepOld = bid(old, 3); // so that a pass is possible in the same shape
    const prepFresh = bid(fresh, 3);
    for (const [key, value] of [['runIndex', 2], ['roundId', 'round-2'], ['biddingId', 'bidding-old'], ['sequenceId', 'seq-old'], ['rosterRevision', 'roster-old'], ['rolesRevision', 'roles-old']] as const) {
      const stale = { scopeOver: { [key]: value } };
      expect(codeOf(() => bid(fresh, 9, stale))).toBe('BIDDING_SCOPE_STALE');
      expect(codeOf(() => pass(prepFresh, stale))).toBe('BIDDING_SCOPE_STALE');
      expect(codeOf(() => bid(prepFresh, 9, stale))).toBe('BIDDING_SCOPE_STALE');
    }
    expect(prepOld.bid.version).toBe(prepFresh.bid.version); // the counters really are identical
    // missing / incomplete origin: invalid, never completed from the current state
    const full = { ...bindingOf(fresh), value: num(3) } as Record<string, unknown>;
    for (const key of ['scope', 'teamId', 'turnNumber', 'sequenceVersion', 'biddingVersion', 'value']) {
      const partial = { ...full }; delete partial[key];
      expect(codeOf(() => readBiddingBidIntent(partial))).toBe('BIDDING_ARGS_INVALID');
    }
    for (const key of ['scope', 'teamId', 'turnNumber', 'sequenceVersion', 'biddingVersion']) {
      const partial = { ...bindingOf(fresh) }; delete partial[key];
      expect(codeOf(() => readBiddingPassIntent(partial))).toBe('BIDDING_ARGS_INVALID');
    }
    const scope = biddingScopeOf(fresh.bid) as Record<string, unknown>;
    for (const key of Object.keys(scope)) {
      const partial = { ...scope }; delete partial[key];
      expect(codeOf(() => readBiddingPassIntent({ ...bindingOf(fresh), scope: partial }))).toBe('BIDDING_ARGS_INVALID');
    }
    // the intent cannot set a winner / leader / highest bid / history
    for (const extra of ['winner', 'leader', 'highest', 'history', 'winnerTeamId', 'standing', 'result']) {
      expect(codeOf(() => readBiddingBidIntent({ ...full, [extra]: 'T1' }))).toBe('BIDDING_ARGS_INVALID');
      expect(codeOf(() => readBiddingPassIntent({ ...bindingOf(fresh), [extra]: 'T1' }))).toBe('BIDDING_ARGS_INVALID');
    }
    // the origin comes from the INTENT: the helper only reads the intent's own fields
    const intent = readBiddingBidIntent(full);
    expect(biddingActionArgsFromIntent(intent)).toEqual({ scope: intent.scope, teamId: intent.teamId, expectedTurnNumber: intent.turnNumber, expectedSequenceVersion: intent.sequenceVersion, expectedVersion: intent.biddingVersion });
    expect(codeOf(() => biddingActionArgsFromIntent({} as Draft))).toBe('BIDDING_ARGS_INVALID');
    // positive control: the fresh intent of the right bidding is accepted
    expect(codeOf(() => bid(fresh, 9))).toBe('NO_THROW');
    expect(codeOf(() => pass(prepFresh))).toBe('NO_THROW');
  });
  it('every counter level on its own: bidding version, N8 turn and N8 sequence version — stale in either direction is refused', () => {
    const w = bid(openWorld(), 3);
    expect(codeOf(() => bid(w, 9, { binding: { biddingVersion: w.bid.version - 1 } }))).toBe('BIDDING_VERSION_STALE');
    expect(codeOf(() => bid(w, 9, { binding: { biddingVersion: w.bid.version + 1 } }))).toBe('BIDDING_VERSION_STALE');
    expect(codeOf(() => bid(w, 9, { binding: { turnNumber: w.seq.turnNumber - 1 } }))).toBe('TURN_SEQ_TURN_STALE');
    expect(codeOf(() => bid(w, 9, { binding: { turnNumber: w.seq.turnNumber + 1 } }))).toBe('TURN_SEQ_TURN_STALE');
    expect(codeOf(() => bid(w, 9, { binding: { sequenceVersion: w.seq.version - 1 } }))).toBe('TURN_SEQ_VERSION_STALE');
    expect(codeOf(() => pass(w, { binding: { sequenceVersion: w.seq.version + 1 } }))).toBe('TURN_SEQ_VERSION_STALE');
    expect(codeOf(() => pass(w, { binding: { turnNumber: w.seq.turnNumber - 1 } }))).toBe('TURN_SEQ_TURN_STALE');
  });
  it('A in an old turn → B → A in a new turn: the old intent stays invalid although A is up again and the revisions are current', () => {
    let w = openWorld({ n: 2 });
    const oldIntentBinding = bindingOf(w); // T1, turn 1
    w = bid(w, 3); // T2 up
    w = bid(w, 5); // T1 up again, turn 3
    expect(teamOn(w)).toBe('T1');
    expect(codeOf(() => bid(w, 9, { binding: oldIntentBinding }))).toMatch(/^(TURN_SEQ_TURN_STALE|TURN_SEQ_VERSION_STALE|BIDDING_VERSION_STALE)$/);
    expect(codeOf(() => bid(w, 9, { binding: { turnNumber: oldIntentBinding.turnNumber } }))).toBe('TURN_SEQ_TURN_STALE');
    expect(codeOf(() => bid(w, 9))).toBe('NO_THROW'); // the freshly bound one
  });
  it('the N8 holder must be the team the schedule says: an external override to another team leaves ONE truth — the bidding refuses (SEQUENCE_MISMATCH)', () => {
    const w = openWorld({ n: 3 });
    const overridden = parseTurnSequenceState({ ...clone(w.seq), position: 2, memberIndex: 0, turnNumber: w.seq.turnNumber + 1, version: w.seq.version + 1 });
    const moved = { ...w, seq: overridden };
    expect(currentTurnHolder(moved.seq)).toEqual({ teamId: 'T3', playerId: 'b3' });
    expect(codeOf(() => bid(moved, 3))).toBe('BIDDING_SEQUENCE_MISMATCH');
    expect(codeOf(() => pass(moved))).toMatch(/^BIDDING_(SEQUENCE_MISMATCH|PASS_BEFORE_FIRST_BID)$/);
    // and a sequence that is not the pinned one at all
    const foreign = parseTurnSequenceState({ ...clone(w.seq), sequenceId: 'seq-foreign' });
    expect(codeOf(() => bid(w, 3, { sequence: foreign }))).toBe('BIDDING_SEQUENCE_MISMATCH');
  });
  it('the NEXT bidder is not eligible: the handover and therefore the bid is refused, nothing changes; a bidder who is not eligible himself cannot act', () => {
    const w = openWorld({ n: 3 });
    const before = [clone(w.bid), clone(w.seq)];
    expect(codeOf(() => bid(w, 3, { eligibility: elig(w, 1, { people: ['b2'] }) }))).toBe('TURN_SEQ_ACTOR_NOT_ELIGIBLE'); // T2's bidder is gone
    expect(codeOf(() => bid(w, 3, { eligibility: elig(w, 1, { teams: ['T2'] }) }))).toBe('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
    expect(codeOf(() => bid(w, 3, { eligibility: elig(w, 1, { people: ['b1'] }) }))).toBe('TURN_SEQ_ACTOR_NOT_ELIGIBLE'); // the holder himself
    expect([w.bid, w.seq]).toEqual(before);
    // the performer being gone is no reason to stop (the performer never acts in a bidding)
    expect(codeOf(() => bid(w, 3, { eligibility: elig(w, 1, { people: ['p1', 'p2'] }) }))).toBe('NO_THROW');
  });
  it('a missing / lost bidder role never produces a pass, a winner or a defeat: HELD stops everything, the bids stay, only an authorised abort ends it', () => {
    let w = bid(bid(openWorld({ n: 3 }), 3), 5); // T3 is up
    const held = withholdBiddingHolder(w.bid, { scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, expectedTurnNumber: w.seq.turnNumber, sequence: w.seq, eligibility: elig(w, 2, { people: ['b3'] }) });
    expect(held.sequenceChanged).toBe(true);
    expect(held.sequence.phase).toBe('HELD');
    expect(held.state).toEqual(w.bid); // the bidding is untouched: no pass, no winner, no result
    w = { ...w, seq: held.sequence };
    expect(codeOf(() => bid(w, 9, { caller: { role: 'PLAYER', participantId: 'b3', teamId: 'T3' }, eligibility: elig(w, 2, { people: ['b3'] }) }))).toBe('TURN_SEQ_HELD');
    expect(codeOf(() => pass(w, { caller: { role: 'PLAYER', participantId: 'b3', teamId: 'T3' }, eligibility: elig(w, 2, { people: ['b3'] }) }))).toBe('TURN_SEQ_HELD');
    expect(biddingResultBasisOf(w.bid)).toBeNull();
    expect(w.bid.passedTeamIds).toEqual([]);
    const aborted = abortBidding(w.bid, { scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, sequence: w.seq, reason: 'TECHNICAL_ABORT', gate: { abortAuthorized: true } });
    expect(aborted.state.phase).toBe('ABORTED');
    expect(aborted.sequence.phase).toBe('CLOSED');
  });
  it('a NEWER eligibility basis without any bid: recorded as an explicit BASIS step (no turn, no handover, bids untouched); an equal basis is a true no-op; the old intent is stale afterwards', () => {
    const w = bid(openWorld(), 3);
    const base = { scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, sequence: w.seq };
    const newer = refreshBiddingBasis(w.bid, { ...base, eligibility: elig(w, 4) });
    expect(newer.sequenceChanged).toBe(true);
    expect(newer.sequenceTransition?.kind).toBe('BASIS');
    expect(newer.sequence).toMatchObject({ turnNumber: w.seq.turnNumber, version: w.seq.version + 1 });
    expect(newer.sequence.eligibility?.actors.version).toBe(4);
    expect(newer.state).toEqual(w.bid);
    expect(holderOf({ ...w, seq: newer.sequence })).toEqual(holderOf(w)); // nobody was handed anything
    const equal = refreshBiddingBasis(w.bid, { ...base, eligibility: elig(w, 1) });
    expect(equal.sequenceChanged).toBe(false);
    expect(equal.sequence).toEqual(w.seq);
    expect(codeOf(() => refreshBiddingBasis(w.bid, { ...base, eligibility: elig(w, 0) }))).toBe('TURN_SEQ_ELIGIBILITY_STALE');
    // an intent made before the basis step is stale (sequence version), the SAME bids continue after a new binding
    expect(codeOf(() => bid({ ...w, seq: newer.sequence }, 9, { binding: { sequenceVersion: w.seq.version }, eligibility: elig(w, 4) }))).toBe('TURN_SEQ_VERSION_STALE');
    const resumed = bid({ ...w, seq: newer.sequence }, 9, { eligibility: elig(w, 4) });
    expect(resumed.bid.leader).toEqual({ teamId: 'T2', units: 9 });
    expect(resumed.bid.history.map(e => e.step)).toEqual([1, 2]);
  });
  it('N8 / N6 capacity is checked BEFORE any change: unchanged state at and below the limit, a bid never leaves the sequence unable to close', () => {
    const w = openWorld({ n: 3 });
    const withSeq = (patch: Record<string, number>): World => ({ ...w, seq: parseTurnSequenceState({ ...clone(w.seq), ...patch }) });
    const MAX = 1_000_000_000;
    const tight = withSeq({ version: MAX - 1 }); // a handover needs 2 (one now, one for the closing)
    const frozen = [clone(tight.bid), clone(tight.seq)];
    expect(codeOf(() => bid(tight, 3))).toBe('BIDDING_COUNTER_LIMIT');
    expect([tight.bid, tight.seq]).toEqual(frozen);
    expect(codeOf(() => bid(withSeq({ version: MAX - 2 }), 3))).toBe('NO_THROW'); // exactly enough room
    expect(codeOf(() => bid(withSeq({ turnNumber: MAX }), 3))).toBe('BIDDING_COUNTER_LIMIT');
    expect(codeOf(() => bid(withSeq({ turnNumber: MAX - 1 }), 3))).toBe('NO_THROW');
    expect(codeOf(() => bid(withSeq({ entitlementRevision: MAX }), 3))).toBe('BIDDING_COUNTER_LIMIT');
    // the closing pass needs only one version step and one entitlement step
    const near = (patch: Record<string, number>) => { const two = bid(openWorld({ n: 2 }), 3); return { ...two, seq: parseTurnSequenceState({ ...clone(two.seq), ...patch }) } as World; };
    expect(codeOf(() => pass(near({ version: MAX - 1 })))).toBe('NO_THROW');
    expect(codeOf(() => pass(near({ version: MAX })))).toBe('BIDDING_COUNTER_LIMIT');
    expect(codeOf(() => pass(near({ entitlementRevision: MAX })))).toBe('BIDDING_COUNTER_LIMIT');
    // abort needs one version step and one entitlement step
    const ab = (patch: Record<string, number>) => { const s = parseTurnSequenceState({ ...clone(w.seq), ...patch }); return () => abortBidding(w.bid, { scope: biddingScopeOf(w.bid), expectedVersion: 1, expectedSequenceVersion: s.version, sequence: s, reason: 'HOST_ABORTED', gate: { abortAuthorized: true } }); };
    expect(codeOf(ab({ version: MAX }))).toBe('BIDDING_COUNTER_LIMIT');
    expect(codeOf(ab({ version: MAX - 1 }))).toBe('NO_THROW');
  });
  it('a bad server time for the handover is refused before anything is returned', () => {
    const w = openWorld();
    for (const nowMs of [-1, 1.5, Number.NaN, '5' as unknown as number, Number.MAX_SAFE_INTEGER + 2]) expect(codeOf(() => bid(w, 3, { nowMs }))).toBe('TURN_SEQ_TIME_INVALID');
  });
  it('rejects a phase that is not open for the full path (PREPARED, closed, aborted) with the bidding code before the N8 check', () => {
    const p = prepared();
    const seq = startTurnSequence(prepareTurnSequence(biddingTurnSequenceInput(p)), { scope: { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM' }, expectedVersion: 0, eligibility: elig({ n: 3 }) }).state;
    const w: World = { bid: p, seq, n: 3 };
    const args = { scope: biddingScopeOf(p), teamId: 'T1', sequence: seq, expectedTurnNumber: 1, expectedSequenceVersion: seq.version, expectedVersion: 0, caller: { role: 'PLAYER' as const, participantId: 'b1', teamId: 'T1' }, gate: OPEN_GATE, eligibility: elig(w), nowMs: 1 };
    expect(codeOf(() => placeBid(p, { ...args, value: num(3) }))).toBe('BIDDING_NOT_OPEN');
    expect(codeOf(() => passBidding(p, args))).toBe('BIDDING_NOT_OPEN');
    const done = pass(bid(openWorld({ n: 2 }), 3));
    expect(codeOf(() => passBidding(done.bid, { ...args, expectedVersion: done.bid.version }))).toBe('BIDDING_ENDED');
  });
  it('terminal exits and newer knowledge (N8-02 review): the closing pass and the abort do not commit a newer N6 stand — deliberate, the closed sequence authorises nothing; every NON-terminal success path does', () => {
    const two = bid(openWorld({ n: 2 }), 3);
    const closing = pass(two, { eligibility: elig(two, 9) }); // a closing pass that saw a newer stand
    expect(closing.seq.phase).toBe('CLOSED');
    expect(closing.seq.eligibility?.actors.version).toBe(1); // the last COMMITTED basis stays (nothing acts on a closed sequence any more)
    expect(codeOf(() => applyBid(closing.bid, { expectedVersion: closing.bid.version, teamId: 'T1', turnNumber: 99, value: num(9) }))).toBe('BIDDING_ENDED');
    const three = openWorld({ n: 3 });
    const handover = bid(three, 4, { eligibility: elig(three, 9) }); // a non-terminal success path commits the newer stand
    expect(handover.seq.eligibility?.actors.version).toBe(9);
    const mid = pass(bid(bid(openWorld({ n: 3 }), 3), 5), { eligibility: elig({ n: 3 }, 9) }); // a non-closing pass too
    expect(mid.bid.phase).toBe('OPEN');
    expect(mid.seq.eligibility?.members?.version).toBe(9);
  });
  it('the full path is pure: no clock and no random source (the server time is an explicit argument)', () => {
    const random = vi.spyOn(Math, 'random'), now = vi.spyOn(Date, 'now');
    let w = openWorld({ n: 3 });
    w = bid(w, 2); w = bid(w, 4); w = pass(w); w = bid(w, 8); w = pass(w);
    expect(w.bid.phase).toBe('CLOSED');
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    random.mockRestore(); now.mockRestore();
  });
});

// ── E. Abort ────────────────────────────────────────────────

describe('E. Abort without a result', () => {
  const abortArgs = (w: World, over: Record<string, unknown> = {}) => ({ scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, sequence: w.seq, reason: 'HOST_ABORTED' as const, gate: { abortAuthorized: true }, ...over });
  it('OPEN → ABORTED with an end reason: NO winner, NO target, the N8 sequence is closed in the same call, the last standing stays server-private', () => {
    const w = bid(bid(openWorld({ n: 3 }), 3), 5);
    for (const reason of ['HOST_ABORTED', 'TECHNICAL_ABORT'] as const) {
      const out = abortBidding(w.bid, abortArgs(w, { reason }));
      expect(out.changed).toBe(true);
      expect(out.state).toMatchObject({ phase: 'ABORTED', endReason: reason, result: null, leader: { teamId: 'T2', units: 5 } });
      expect(out.sequence.phase).toBe('CLOSED');
      expect(out.transition).toMatchObject({ kind: 'ABORT', phaseBefore: 'OPEN', phaseAfter: 'ABORTED' });
      expect(biddingResultBasisOf(out.state)).toBeNull();
    }
  });
  it('without the authorisation fact nothing happens; a bad reason or shape is refused; the abort needs the exact keys', () => {
    const w = bid(openWorld(), 3);
    expect(codeOf(() => abortBidding(w.bid, abortArgs(w, { gate: { abortAuthorized: false } })))).toBe('BIDDING_ABORT_NOT_AUTHORIZED');
    expect(codeOf(() => abortBidding(w.bid, abortArgs(w, { gate: {} })))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(() => abortBidding(w.bid, abortArgs(w, { gate: { abortAuthorized: 'yes' } })))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(() => abortBidding(w.bid, abortArgs(w, { reason: 'COMPLETED' })))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(() => abortBidding(w.bid, abortArgs(w, { reason: 'WHATEVER' })))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(() => abortBidding(w.bid, { ...abortArgs(w), extra: 1 } as Draft))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(() => abortBidding(w.bid, abortArgs(w, { scope: { ...biddingScopeOf(w.bid), runIndex: 2 } })))).toBe('BIDDING_SCOPE_STALE');
  });
  it('terminal: afterwards no bid and no pass; a repeat at the current version is a no-op; an older version is stale; a regularly closed bidding is never aborted', () => {
    const w = bid(openWorld({ n: 2 }), 3);
    const out = abortBidding(w.bid, abortArgs(w));
    const ended: World = { ...w, bid: out.state, seq: out.sequence };
    const lateArgs = { scope: biddingScopeOf(w.bid), teamId: 'T2', sequence: w.seq, expectedTurnNumber: w.seq.turnNumber, expectedSequenceVersion: w.seq.version, expectedVersion: w.bid.version, caller: { role: 'PLAYER' as const, participantId: 'b2', teamId: 'T2' }, gate: OPEN_GATE, eligibility: elig(w), nowMs: 1 };
    expect(codeOf(() => placeBid(out.state, { ...lateArgs, value: num(9) }))).toBe('BIDDING_ENDED'); // a late delivery after the abort (the bidding code comes before the N8 check)
    expect(codeOf(() => passBidding(out.state, lateArgs))).toBe('BIDDING_ENDED');
    expect(codeOf(() => applyPass(out.state, { expectedVersion: out.state.version, teamId: 'T2', turnNumber: 9 }))).toBe('BIDDING_ENDED');
    const again = abortBidding(out.state, abortArgs(ended));
    expect(again.changed).toBe(false);
    expect(again.state).toEqual(out.state);
    expect(codeOf(() => abortBidding(out.state, abortArgs(ended, { expectedVersion: out.state.version - 1 })))).toBe('BIDDING_VERSION_STALE');
    const done = pass(w);
    expect(codeOf(() => abortBidding(done.bid, abortArgs(done)))).toBe('BIDDING_ENDED');
  });
  it('abort of a PREPARED bidding (before opening) works with its not yet started N8 sequence; nothing is guessed', () => {
    const p = prepared();
    const seq = prepareTurnSequence(biddingTurnSequenceInput(p));
    const out = abortBidding(p, { scope: biddingScopeOf(p), expectedVersion: 0, expectedSequenceVersion: 0, sequence: seq, reason: 'HOST_ABORTED', gate: { abortAuthorized: true } });
    expect(out.state).toMatchObject({ phase: 'ABORTED', version: 1, leader: null, result: null });
    expect(out.sequence.phase).toBe('CLOSED');
  });
  it('disconnect / kick / leave have no entry point here: loading, projecting and replaying never produce a pass, a winner or an abort', () => {
    const w = bid(bid(openWorld({ n: 3 }), 3), 5);
    const frozen = clone(w.bid);
    for (const audience of [PLAYER('b3'), PLAYER('p3'), VIEWER, DISPLAY, HOST]) {
      const release = audience === VIEWER || audience === DISPLAY || audience === HOST || (audience as Draft).participantId === 'b3' ? 'STANDING' : 'NEUTRAL';
      project(w, audience, release);
      parseBiddingState(JSON.parse(JSON.stringify(w.bid)));
    }
    expect(w.bid).toEqual(frozen);
    expect(w.bid.passedTeamIds).toEqual([]);
    expect(w.bid.result).toBeNull();
  });
});

// ── F. Projections: information matrix per role and phase ──────────────

const SECRET_NEEDLES = ['731', CATEGORY, 'Hauptst', 'history', 'passedTeamIds', 'againstTeamId', 'againstUnits', 'lastPass', 'result', 'leader"', 'standing', 'winner', 'bidderId', 'performerId', 'biddingVersion', 'turnNumber', 'sequenceVersion', 'teams', 'onTurn', 'outcome', 'category', 'numeric', 'T1', 'T2', 'T3', 'b1', 'b2', 'b3'];

describe('F. Projections: strict variants, no leaks', () => {
  const live = () => { let w = openWorld({ n: 3, category: CATEGORY, numeric: { ...NUMERIC, max: num(999) } }); w = bid(w, 3); w = bid(w, 731); return w; }; // T3 is up; T2 leads with 731
  it('PERFORMER (and every non-bidder player): the NEUTRAL packet has exactly the neutral fields and none of the forbidden ones — in the received JSON, not only in the DOM', () => {
    const w = live();
    for (const id of ['p1', 'p2', 'p3']) {
      const packet = project(w, PLAYER(id), 'NEUTRAL');
      expect(Object.keys(packet).sort()).toEqual(['contract', 'phase', 'recipientId', 'release', 'scope', 'stateVersion', 'you']);
      expect(packet).toMatchObject({ release: 'NEUTRAL', phase: 'OPEN', recipientId: id, you: { performer: true } });
      const json = JSON.stringify(packet);
      for (const needle of ['731', CATEGORY, 'category', 'standing', 'leader', 'teams', 'onTurn', 'outcome', 'history', 'passed', 'againstTeamId', 'bidderId', 'performerId', 'biddingVersion', 'turnNumber', 'sequenceVersion', 'numeric', '"T1"', '"T2"', '"T3"', 'b1', 'b2', 'b3', 'p1', 'p2', 'p3'].filter(n => n !== id)) {
        if (needle === id) continue;
        expect(json.includes(needle) ? needle : null).toBeNull();
      }
    }
  });
  it('asking for STANDING for a performer or any non-bidder player is refused — there is no package that contains the forbidden fields', () => {
    const w = live();
    for (const audience of [PLAYER('p1'), PLAYER('p2'), PLAYER('p3'), PLAYER('stranger'), PLAYER(null), { role: 'PLAYER', participantId: 'p1', teamId: 'T1' } as ProjectionAudience]) {
      expect(codeOf(() => project(w, audience, 'STANDING'))).toBe('BIDDING_RELEASE_FORBIDDEN');
    }
  });
  it('a HOST who plays as PERFORMER gets NO extra view: as a PLAYER or as a HOST audience with the pinned participant id — neutral only', () => {
    const w = live();
    const playing: ProjectionAudience = { role: 'HOST', participantId: 'p2', teamId: 'T2' };
    expect(codeOf(() => project(w, playing, 'STANDING'))).toBe('BIDDING_RELEASE_FORBIDDEN');
    expect(project(w, playing, 'NEUTRAL')).toMatchObject({ release: 'NEUTRAL', recipientId: 'p2', you: { performer: true } });
    expect(codeOf(() => project(w, { role: 'PLAYER', participantId: 'p2', teamId: 'T2' }, 'STANDING'))).toBe('BIDDING_RELEASE_FORBIDDEN');
    expect(JSON.stringify(project(w, playing, 'NEUTRAL')).includes('731')).toBe(false);
  });
  it('a pinned BIDDER sees the released standing: category, profile, teams IN/PASSED, leader and highest bid, the team on turn, own hints — but not the pass order, history or evidence', () => {
    const w = live();
    const packet = project(w, PLAYER('b3'), 'STANDING') as contract.BiddingStandingProjection;
    expect(packet).toMatchObject({
      release: 'STANDING', phase: 'OPEN', recipientId: 'b3', category: CATEGORY, standing: { teamId: 'T2', value: num(731) }, onTurn: { teamId: 'T3', playerId: 'b3' },
      you: { teamId: 'T3', holdsTurn: true, canBid: true, canPass: true }, numeric: { scale: 0, bounds: { min: num(1), max: num(999) } },
    });
    expect(packet.teams).toEqual([{ teamId: 'T1', status: 'IN', leading: false }, { teamId: 'T2', status: 'IN', leading: true }, { teamId: 'T3', status: 'IN', leading: false }]);
    const json = JSON.stringify(packet);
    for (const needle of ['history', 'passedTeamIds', 'againstTeamId', 'againstUnits', 'lastPass', 'performerId', 'stepCount', 'p1', 'p2', 'p3']) expect(json.includes(needle) ? needle : null).toBeNull();
    // waiting bidder: sees the same standing, cannot act
    const waiting = project(w, PLAYER('b1'), 'STANDING') as contract.BiddingStandingProjection;
    expect(waiting.you).toEqual({ teamId: 'T1', holdsTurn: false, canBid: false, canPass: false });
    expect(waiting.standing).toEqual(packet.standing);
    // the leader waits for competition: no action offered
    const leader = project(w, PLAYER('b2'), 'STANDING') as contract.BiddingStandingProjection;
    expect(leader.you).toEqual({ teamId: 'T2', holdsTurn: false, canBid: false, canPass: false });
  });
  it('canPass appears only after the first bid; before it a bidder on turn can only bid', () => {
    const w = openWorld({ n: 3 });
    expect((project(w, PLAYER('b1'), 'STANDING') as contract.BiddingStandingProjection).you).toEqual({ teamId: 'T1', holdsTurn: true, canBid: true, canPass: false });
    expect((project(w, PLAYER('b1'), 'STANDING') as contract.BiddingStandingProjection).standing).toBeNull();
  });
  it('VIEWER and DISPLAY see the released standing without any "you" and without mutation hints; a non-blind HOST too; a BLIND host does not', () => {
    const w = live();
    for (const audience of [VIEWER, DISPLAY, HOST]) {
      const packet = project(w, audience, 'STANDING') as contract.BiddingStandingProjection;
      expect(packet).toMatchObject({ recipientId: null, you: null, category: CATEGORY, standing: { teamId: 'T2', value: num(731) } });
    }
    expect(codeOf(() => project(w, { role: 'HOST', blindHost: true, participantId: 'host-1' }, 'STANDING'))).toBe('BIDDING_RELEASE_FORBIDDEN');
    expect(project(w, { role: 'HOST', blindHost: true }, 'NEUTRAL')).toMatchObject({ release: 'NEUTRAL', you: null });
    for (const audience of [VIEWER, DISPLAY, HOST]) expect(project(w, audience, 'NEUTRAL')).toMatchObject({ release: 'NEUTRAL', recipientId: null, you: null });
  });
  it('the pass ORDER does not show: teams are listed in the prepared order whatever order they passed in', () => {
    const a = semantic(openOnly(4), [['BID', 'T1', 2], ['PASS', 'T2'], ['PASS', 'T3']]);
    const b = semantic(openOnly(4), [['BID', 'T1', 2], ['PASS', 'T3'], ['PASS', 'T2']]);
    const ofState = (state: BiddingState) => project({ bid: state, seq: openWorld({ n: 4 }).seq, n: 4 }, VIEWER, 'STANDING') as contract.BiddingStandingProjection;
    expect(ofState(a).teams).toEqual(ofState(b).teams);
    expect(ofState(a).teams.map(t => t.status)).toEqual(['IN', 'PASSED', 'PASSED', 'IN']);
  });
  it('after the regular end: bidders/viewers see the winner with ITS pair and the highest bid — no pass evidence, no opponent reference; the performer sees only "ended"', () => {
    let w = openWorld({ n: 2 });
    w = bid(w, 731); w = pass(w);
    const viewer = project(w, VIEWER, 'STANDING', 9, w.seq) as contract.BiddingStandingProjection;
    expect(viewer).toMatchObject({ phase: 'CLOSED', endReason: 'COMPLETED', outcome: { winnerTeamId: 'T1', winningValue: num(731), bidderId: 'b1', performerId: 'p1' }, onTurn: null });
    expect(JSON.stringify(viewer).includes('lastPass')).toBe(false);
    expect(JSON.stringify(viewer).includes('againstTeamId')).toBe(false);
    const performer = project(w, PLAYER('p1'), 'NEUTRAL', 9, w.seq);
    expect(performer).toMatchObject({ release: 'NEUTRAL', phase: 'ENDED' });
    expect(JSON.stringify(performer).includes('731')).toBe(false);
    expect(codeOf(() => project(w, PLAYER('p1'), 'STANDING'))).toBe('BIDDING_RELEASE_FORBIDDEN'); // a finished result is no blanket reveal
    const bidder = project(w, PLAYER('b2'), 'STANDING') as contract.BiddingStandingProjection;
    expect(bidder.you).toEqual({ teamId: 'T2', holdsTurn: false, canBid: false, canPass: false });
  });
  it('an ABORTED bidding projects no standing, no leader flag and no outcome — nobody can read a guessed winner', () => {
    const w = bid(bid(openWorld({ n: 3 }), 3), 5);
    const out = abortBidding(w.bid, { scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, sequence: w.seq, reason: 'HOST_ABORTED', gate: { abortAuthorized: true } });
    const ended: World = { ...w, bid: out.state, seq: out.sequence };
    const viewer = project(ended, VIEWER, 'STANDING') as contract.BiddingStandingProjection;
    expect(viewer).toMatchObject({ phase: 'ABORTED', endReason: 'HOST_ABORTED', standing: null, outcome: null, onTurn: null });
    expect(viewer.teams.some(t => t.leading)).toBe(false);
    expect(project(ended, PLAYER('p2'), 'NEUTRAL')).toMatchObject({ phase: 'ENDED' });
  });
  it('a PREPARED bidding projects nothing to act on', () => {
    const p = prepared();
    const seq = startTurnSequence(prepareTurnSequence(biddingTurnSequenceInput(p)), { scope: { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM' }, expectedVersion: 0, eligibility: elig({ n: 3 }) }).state;
    const w: World = { bid: p, seq, n: 3 };
    expect(project(w, PLAYER('b1'), 'STANDING')).toMatchObject({ phase: 'PREPARED', standing: null, onTurn: null, you: { holdsTurn: false, canBid: false, canPass: false } });
    expect(project(w, PLAYER('p1'), 'NEUTRAL')).toMatchObject({ phase: 'PREPARED' });
  });
  it('the action hints come from the CURRENT N8 sequence: HELD, a moved holder or a closed sequence withdraw them', () => {
    const w = openWorld({ n: 3 });
    const held = withholdBiddingHolder(w.bid, { scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, expectedTurnNumber: w.seq.turnNumber, sequence: w.seq, eligibility: elig(w, 2, { people: ['b1'] }) }).sequence;
    expect(project(w, PLAYER('b1'), 'STANDING', 7, held)).toMatchObject({ onTurn: null, you: { holdsTurn: false, canBid: false } });
    const moved = parseTurnSequenceState({ ...clone(w.seq), position: 1, memberIndex: 0, turnNumber: 2, version: w.seq.version + 1 });
    expect(project(w, PLAYER('b2'), 'STANDING', 7, moved)).toMatchObject({ onTurn: null, you: { holdsTurn: false, canBid: false } }); // disagrees with the schedule: nobody is offered an action
    expect(project(w, PLAYER('b1'), 'STANDING')).toMatchObject({ you: { canBid: true } }); // positive control
  });
  it('recipient binding and the role change: a package made for A is no package for B (also within a team); a bidding with another roles revision is another context', () => {
    const w = live();
    const packet = project(w, PLAYER('b3'), 'STANDING', 7);
    const ctx = (over: Partial<contract.BiddingExpectedContext> = {}): contract.BiddingExpectedContext => ({ ...biddingScopeOf(w.bid), recipientId: 'b3', minStateVersion: 0, ...over });
    expect(biddingProjectionMatches(packet, ctx())).toBe(true);
    expect(biddingProjectionMatches(packet, ctx({ recipientId: 'p3' }))).toBe(false); // the performer of the SAME team
    expect(biddingProjectionMatches(packet, ctx({ recipientId: 'b1' }))).toBe(false);
    expect(biddingProjectionMatches(packet, ctx({ recipientId: null }))).toBe(false);
    expect(biddingProjectionMatches(packet, ctx({ minStateVersion: 8 }))).toBe(false);
    for (const [key, value] of [['runIndex', 2], ['roundId', 'round-2'], ['biddingId', 'bidding-2'], ['sequenceId', 'seq-2'], ['rosterRevision', 'roster-2'], ['rolesRevision', 'roles-2']] as const) {
      expect(biddingProjectionMatches(packet, ctx({ [key]: value }))).toBe(false);
    }
    // the same participant, bidder → performer in the NEXT bidding (rotated roles): the new context refuses the old bidder packet
    const next = openWorld({ n: 3, biddingId: 'bidding-2', rolesRevision: 'roles-2' });
    expect(biddingProjectionMatches(packet, { ...biddingScopeOf(next.bid), recipientId: 'b3', minStateVersion: 0 })).toBe(false);
    expect(biddingContextKey(ctx())).not.toBe(biddingContextKey({ ...ctx(), recipientId: 'p3' }));
    expect(biddingContextKey(ctx())).not.toContain('731');
  });
  it('invalid audience, release, state version and scope are code-only errors', () => {
    const w = live();
    const call = (audience: unknown, over: Record<string, unknown> = {}) => () => projectBidding(audience as ProjectionAudience, w.bid, { scope: biddingScopeOf(w.bid), sequence: w.seq, release: 'NEUTRAL', stateVersion: 1, ...over } as Draft);
    expect(codeOf(call({ role: 'ADMIN' }))).toBe('BIDDING_AUDIENCE_INVALID');
    expect(codeOf(call(null))).toBe('BIDDING_AUDIENCE_INVALID');
    expect(codeOf(call({ role: 'PLAYER', participantId: 5 }))).toBe('BIDDING_AUDIENCE_INVALID');
    expect(codeOf(call(VIEWER, { release: 'EVERYTHING' }))).toBe('BIDDING_RELEASE_INVALID');
    expect(codeOf(call(VIEWER, { release: undefined }))).toBe('BIDDING_RELEASE_INVALID'); // no default
    expect(codeOf(call(VIEWER, { stateVersion: -1 }))).toBe('BIDDING_ARGS_INVALID');
    expect(codeOf(call(VIEWER, { scope: { ...biddingScopeOf(w.bid), biddingId: 'other' } }))).toBe('BIDDING_SCOPE_STALE');
    expect(codeOf(call(VIEWER, { sequence: parseTurnSequenceState({ ...clone(w.seq), sequenceId: 'seq-x' }) }))).toBe('BIDDING_SEQUENCE_MISMATCH');
  });
  it('the strict client schema rejects extra keys and inconsistent packets; parseBiddingProjection returns a code only', () => {
    const w = live();
    const standing = clone(project(w, PLAYER('b3'), 'STANDING')) as Draft;
    expect(parseBiddingProjection(standing).ok).toBe(true);
    for (const mutate of [
      (p: Draft) => { p.history = []; }, (p: Draft) => { p.winner = 'T1'; }, (p: Draft) => { p.teams[0].leading = true; }, (p: Draft) => { p.standing = null; },
      (p: Draft) => { p.you.canBid = true; p.you.holdsTurn = false; }, (p: Draft) => { p.outcome = { winnerTeamId: 'T2', winningValue: num(731), bidderId: 'b2', performerId: 'p2' }; },
      (p: Draft) => { p.phase = 'CLOSED'; }, (p: Draft) => { p.endReason = 'COMPLETED'; }, (p: Draft) => { p.recipientId = null; },
    ]) {
      const broken = clone(standing); mutate(broken);
      const parsed = parseBiddingProjection(broken);
      expect(parsed).toEqual({ ok: false, code: 'BIDDING_PROJECTION_INVALID' });
    }
    const neutral = clone(project(w, PLAYER('p1'), 'NEUTRAL')) as Draft;
    for (const extra of ['category', 'standing', 'teams', 'biddingVersion']) { const broken = { ...neutral, [extra]: 'x' }; expect(BiddingProjectionSchema.safeParse(broken).success).toBe(false); }
    expect(contract.BiddingProjectionSchema.safeParse({ ...neutral, release: 'STANDING' }).success).toBe(false);
  });
  it('the leak probe over EVERY audience × phase: the NEUTRAL serialisation never contains a needle that only STANDING may carry', () => {
    const states: World[] = [openWorld({ n: 3 }), live(), pass(bid(openWorld({ n: 2 }), 731))];
    for (const w of states) {
      for (const audience of [PLAYER('p1'), PLAYER('p2'), PLAYER('b1'), VIEWER, DISPLAY, HOST, { role: 'HOST', participantId: 'p1' } as ProjectionAudience]) {
        const json = JSON.stringify(project(w, audience, 'NEUTRAL'));
        for (const needle of ['731', 'Hauptst', 'category', 'standing', 'leader', 'onTurn', 'outcome', 'history', 'againstTeamId', 'biddingVersion', 'turnNumber', 'sequenceVersion', 'numeric', 'bidderId', 'performerId', '"teams"']) {
          expect(json.includes(needle) ? `${needle} leaked` : null).toBeNull();
        }
      }
    }
    expect(SECRET_NEEDLES.length).toBeGreaterThan(10);
  });
  it('an ids label never encodes a bid or a category: the scope of a NEUTRAL packet is labels only', () => {
    const packet = project(live(), PLAYER('p1'), 'NEUTRAL');
    expect(packet.scope).toEqual({ runIndex: 1, roundId: 'round-1', biddingId: 'bidding-1', sequenceId: 'seq-1', rosterRevision: 'roster-1', rolesRevision: 'roles-1' });
  });
});

// ── G. Persistence, replay, corruption ───────────────────────

describe('G. Recovery: round trips and corrupted states are rejected, never repaired', () => {
  const finished = () => { let w = openWorld({ n: 4 }); for (const step of ['b2', 'b3', 'b2', 'b3', 'p', 'p', 'p'] as const) { w = step === 'p' ? pass(w) : bid(w, w.bid.leader === null ? 2 : w.bid.leader.units + 3); } return w; };
  it('JSON round trip of every phase keeps the state exactly; load and projection never change it', () => {
    const w0 = openWorld({ n: 4 }); const w1 = bid(w0, 3); const w2 = bid(w1, 8); const w3 = pass(w2);
    for (const state of [prepared({ n: 4 }), w0.bid, w1.bid, w2.bid, w3.bid, finished().bid]) {
      const wire = JSON.parse(JSON.stringify(state));
      expect(parseBiddingState(wire)).toEqual(state);
      expect(parseBiddingState(parseBiddingState(wire))).toEqual(state);
    }
    expect(finished().bid.phase).toBe('CLOSED');
  });
  it('SDK state events: a stored sequence of states replays to exactly the final state with no new bid, pass or handover; a corrupted stored value is refused on read', () => {
    let w = openWorld({ n: 3 });
    const states: Array<{ bidding: BiddingState; sequence: TurnSequenceState }> = [{ bidding: w.bid, sequence: w.seq }];
    for (const next of [bid(w, 3), (w = bid(w, 3), bid(w, 9)), (w = bid(w, 9), pass(w))]) { states.push({ bidding: next.bid, sequence: next.seq }); }
    const snap = (value: unknown, version: number): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 1, gameSlug: 'stand-in', engineVersion: 1, stateVersion: version, state: { phase: 'ROUND_ACTIVE', ...(value as object) } });
    const events = states.slice(1).map((next, i) => createStateEvent(snap(states[i], i + 10), { phase: 'ROUND_ACTIVE', ...next }, { eventId: randomUUID(), type: 'BIDDING_CHANGED', commandId: `c${i}`, actorId: 'b1', occurredAtMs: 1 + i }));
    const wire = JSON.parse(JSON.stringify(events)) as unknown[];
    const rebuilt = wire.reduce<EngineStateSnapshot>((snapshot, event) => applyStateEvent(snapshot, event), snap(states[0], 10));
    const final = states[states.length - 1];
    expect(parseBiddingState((rebuilt.state as Draft).bidding)).toEqual(final.bidding);
    expect(parseTurnSequenceState((rebuilt.state as Draft).sequence)).toEqual(final.sequence);
    expect(rebuilt.stateVersion).toBe(10 + states.length - 1);
    const corrupt = clone((rebuilt.state as Draft).bidding);
    corrupt.leader.units += 1;
    expect(codeOf(() => parseBiddingState(corrupt))).toBe('BIDDING_STATE_INVALID');
  });
  it.each([
    ['an unknown top-level key', (s: Draft) => { s.winner = 'T1'; }],
    ['a missing field', (s: Draft) => { delete s.history; }],
    ['another kind', (s: Draft) => { s.kind = 'DICE_TURN'; }],
    ['another schema version', (s: Draft) => { s.schemaVersion = 2; }],
    ['a leader that the history does not support', (s: Draft) => { s.leader.units += 1; }],
    ['a leader of another team', (s: Draft) => { s.leader.teamId = 'T1'; }],
    ['a leader without any bid', (s: Draft) => { s.history = []; s.stepCount = 0; s.version = 1; s.passedTeamIds = []; }],
    ['a history step gap', (s: Draft) => { s.history[1].step = 5; }],
    ['a history sorted by value (order destroyed)', (s: Draft) => { s.history.reverse(); }],
    ['a turn identity that does not increase', (s: Draft) => { s.history[1].turnNumber = s.history[0].turnNumber; }],
    ['an entry of an unknown team', (s: Draft) => { s.history[0].teamId = 'T9'; }],
    ['an entry whose player is not the pinned bidder', (s: Draft) => { s.history[0].playerId = 'p1'; }],
    ['a bid that is not higher than the leader', (s: Draft) => { s.history[1].units = s.history[0].units; s.leader.units = s.history[0].units; }],
    ['a bid above the maximum', (s: Draft) => { s.history[1].units = 5000; s.leader.units = 5000; }],
    ['a stored step counter that differs from the history', (s: Draft) => { s.stepCount += 1; }],
    ['a version that does not match the steps', (s: Draft) => { s.version += 3; }],
    ['a passed order that is not the history order', (s: Draft) => { s.passedTeamIds = ['T3', 'T1']; }],
    ['a passed team that is unknown', (s: Draft) => { s.passedTeamIds = ['T9']; }],
    ['a phase CLOSED without a result', (s: Draft) => { s.phase = 'CLOSED'; s.endReason = 'COMPLETED'; }],
    ['a result on an OPEN bidding', (s: Draft) => { s.result = { winnerTeamId: 'T1', winningUnits: 3, bidderId: 'b1', performerId: 'p1', lastPassTeamId: 'T2', lastPassStep: 3 }; }],
    ['an end reason on an OPEN bidding', (s: Draft) => { s.endReason = 'HOST_ABORTED'; }],
    ['a numeric profile with private bounds', (s: Draft) => { s.numeric.boundsDisclosure = 'PRIVATE'; }],
    ['a numeric profile with a non-positive minimum', (s: Draft) => { s.numeric.min.units = 0; }],
    ['a negative bid', (s: Draft) => { s.history[0].units = -4; }],
    ['a fractional bid', (s: Draft) => { s.history[0].units = 2.5; }],
    ['a duplicated bidder across teams', (s: Draft) => { s.teams[1].bidderId = s.teams[0].bidderId; }],
    ['a pass entry without its reference', (s: Draft) => { s.history[2] = { step: 3, kind: 'PASS', turnNumber: 9, teamId: 'T3', playerId: 'b3' }; }],
    ['teams beyond the limit', (s: Draft) => { s.teams = Array.from({ length: BIDDING_MAX_TEAMS + 1 }, (_, i) => ({ teamId: `X${i}`, bidderId: `xb${i}`, performerId: `xp${i}` })); }],
    ['a history beyond the limit', (s: Draft) => { s.history = Array.from({ length: BIDDING_MAX_STEPS + 1 }, () => s.history[0]); }],
    ['an OPEN bidding with one team left', (s: Draft) => { s.passedTeamIds = ['T1', 'T2']; }],
  ])('rejects %s as a whole: BIDDING_STATE_INVALID with code-only issues, no repair, no reset', (_name, corrupt) => {
    let w = openWorld({ n: 3 }); w = bid(w, 3); w = bid(w, 5); w = pass(w);
    const damaged = clone(w.bid) as Draft;
    corrupt(damaged);
    const copy = clone(damaged);
    expect(codeOf(() => parseBiddingState(damaged))).toBe('BIDDING_STATE_INVALID');
    for (const issue of issuesOf(() => parseBiddingState(damaged))) expect(BIDDING_ISSUE_CODES as readonly string[]).toContain(issue);
    expect(damaged).toEqual(copy); // not repaired in place
    // every entry point refuses it too — none starts a fresh empty bidding
    expect(codeOf(() => applyBid(damaged, { expectedVersion: damaged.version, teamId: 'T1', turnNumber: 99, value: num(400) }))).toBe('BIDDING_STATE_INVALID');
    expect(codeOf(() => biddingResultBasisOf(damaged))).toBe('BIDDING_STATE_INVALID');
    expect(codeOf(() => project({ ...w, bid: damaged }, VIEWER, 'STANDING'))).toBe('BIDDING_STATE_INVALID');
    try { parseBiddingState(damaged); } catch (error) { expect((error as Error).message).toBe('BIDDING_STATE_INVALID'); }
  });
  it('a closed state whose stored "last opponent" differs from the evidence is rejected (the result is re-derived on every load)', () => {
    const done = finished();
    expect(done.bid.phase).toBe('CLOSED');
    const forged = clone(done.bid) as Draft;
    const other = forged.teams.map((t: Draft) => t.teamId).find((id: string) => id !== forged.result.lastPassTeamId && id !== forged.result.winnerTeamId);
    forged.result.lastPassTeamId = other;
    expect(codeOf(() => parseBiddingState(forged))).toBe('BIDDING_STATE_INVALID');
    expect(issuesOf(() => parseBiddingState(forged))).toContain('RESULT_CONFLICT');
    const wrongWinner = clone(done.bid) as Draft;
    wrongWinner.result.winnerTeamId = wrongWinner.teams.find((t: Draft) => t.teamId !== wrongWinner.result.winnerTeamId).teamId;
    expect(codeOf(() => parseBiddingState(wrongWinner))).toBe('BIDDING_STATE_INVALID');
  });
  it('the wire error codes are whitelisted for the existing error boundary, and every thrown message is the code (no values)', () => {
    for (const code of BIDDING_ERROR_CODES) expect(gameErrorCode(new Error(code))).toBe(code);
    expect(gameErrorCode(new Error('BIDDING_SOMETHING_ELSE'))).toBe('INTERNAL_ERROR');
    for (const code of TURN_SEQUENCE_ERROR_CODES) expect(gameErrorCode(new Error(code))).toBe(code);
    expect(new BiddingError('BIDDING_VALUE_INVALID').message).toBe('BIDDING_VALUE_INVALID');
  });
  it('the shared contract file is client-safe: no node imports, only zod and the N1 contract, no relative imports', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../../../packages/shared/src/bidding.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]);
    expect(imports.sort()).toEqual(['@quiz/shared/numeric', 'zod']);
    expect(/^\s*(export\s+)?(const\s+)?enum\s/m.test(source.replace(/\/\/.*$/gm, ''))).toBe(false); // strip-only TypeScript: no enum declarations
  });
  it('the intent schema carries one value for ONE team and no server-owned field; the binding key labels only', () => {
    const w = openWorld();
    const intent = readBiddingBidIntent({ ...bindingOf(w), value: num(731) });
    expect(Object.keys(BiddingBidIntentSchema.shape).sort()).toEqual(['biddingVersion', 'scope', 'sequenceVersion', 'teamId', 'turnNumber', 'value']);
    expect(Object.keys(BiddingActionBindingSchema.shape).sort()).toEqual(['biddingVersion', 'scope', 'sequenceVersion', 'teamId', 'turnNumber']);
    expect(biddingActionBindingKey(intent)).not.toContain('731');
    const other = { ...intent, scope: { ...intent.scope, biddingId: 'bidding-9' } };
    expect(biddingActionBindingKey(other)).not.toBe(biddingActionBindingKey(intent));
    expect(biddingActionBindingKey({ ...intent, teamId: 'T2' })).not.toBe(biddingActionBindingKey(intent));
  });
});

// ── H. N5 role adapter ───────────────────────────────────────

describe('H. Roles from an N5 deal: origin carried to the bidding, no re-deal', () => {
  const deal = (over: Record<string, unknown> = {}) => createSecretRoleDeal({
    runIndex: 1, roundId: 'round-1', dealId: 'deal-1', revision: 'roles-1',
    participantIds: ['u1', 'u2', 'u3', 'u4', 'u5'], roleIds: ['bidder', 'performer', 'other'],
    assignments: [{ participantId: 'u1', roleId: 'bidder' }, { participantId: 'u2', roleId: 'performer' }, { participantId: 'u3', roleId: 'performer' }, { participantId: 'u4', roleId: 'bidder' }, { participantId: 'u5', roleId: 'other' }],
    fragments: [], ...over,
  });
  const args = (over: Record<string, unknown> = {}) => ({
    deal: deal(), scope: { runIndex: 1, roundId: 'round-1', dealId: 'deal-1', revision: 'roles-1' }, bidderRoleId: 'bidder', performerRoleId: 'performer',
    teams: [{ teamId: 'TA', memberIds: ['u1', 'u2'] }, { teamId: 'TB', memberIds: ['u4', 'u3', 'u5'] }], ...over,
  });
  it('derives ONE bidder and ONE performer per team in the given team order and takes the deal revision as the roles revision', () => {
    expect(biddingRolesFromRoleDeal(args())).toEqual({ rolesRevision: 'roles-1', teams: [{ teamId: 'TA', bidderId: 'u1', performerId: 'u2' }, { teamId: 'TB', bidderId: 'u4', performerId: 'u3' }], origin: { runIndex: 1, roundId: 'round-1', dealId: 'deal-1', revision: 'roles-1' } });
  });
  it('the expected run, round, deal id and revision are compared with the deal that is LOADED (a correct deal of another game/round is no deal for this one)', () => {
    for (const [key, value] of [['runIndex', 2], ['roundId', 'round-2'], ['dealId', 'deal-2'], ['revision', 'roles-2']] as const) {
      expect(codeOf(() => biddingRolesFromRoleDeal(args({ scope: { runIndex: 1, roundId: 'round-1', dealId: 'deal-1', revision: 'roles-1', [key]: value } })))).toBe('BIDDING_CONFIG_INVALID');
    }
    expect(codeOf(() => biddingRolesFromRoleDeal(args({ scope: { runIndex: 1 } })))).toBe('BIDDING_CONFIG_INVALID');
    expect(codeOf(() => biddingRolesFromRoleDeal(args({ deal: { kind: 'x' } })))).toBe('BIDDING_CONFIG_INVALID');
  });
  it('rejects ambiguous or incomplete teams: no bidder, two bidders, no performer, a member of two teams, an unknown member, the same role for both', () => {
    const bad = (teams: unknown) => codeOf(() => biddingRolesFromRoleDeal(args({ teams })));
    expect(bad([{ teamId: 'TA', memberIds: ['u2', 'u3'] }])).toBe('BIDDING_CONFIG_INVALID'); // two performers, no bidder
    expect(bad([{ teamId: 'TA', memberIds: ['u1', 'u4'] }])).toBe('BIDDING_CONFIG_INVALID'); // two bidders
    expect(bad([{ teamId: 'TA', memberIds: ['u1', 'u5'] }])).toBe('BIDDING_CONFIG_INVALID'); // no performer
    expect(bad([{ teamId: 'TA', memberIds: ['u1', 'u2'] }, { teamId: 'TB', memberIds: ['u2', 'u4'] }])).toBe('BIDDING_CONFIG_INVALID');
    expect(bad([{ teamId: 'TA', memberIds: ['u1', 'ghost'] }])).toBe('BIDDING_CONFIG_INVALID');
    expect(codeOf(() => biddingRolesFromRoleDeal(args({ performerRoleId: 'bidder' })))).toBe('BIDDING_CONFIG_INVALID');
  });
  it('a rotated assignment is a NEW deal and a NEW bidding: the same participants, the same counters — the old intent is refused, no bid or right is inherited', () => {
    const rotated = deal({ dealId: 'deal-2', revision: 'roles-2', roundId: 'round-2', assignments: [{ participantId: 'u1', roleId: 'performer' }, { participantId: 'u2', roleId: 'bidder' }, { participantId: 'u3', roleId: 'bidder' }, { participantId: 'u4', roleId: 'performer' }, { participantId: 'u5', roleId: 'other' }] });
    const roles2 = biddingRolesFromRoleDeal(args({ deal: rotated, scope: { runIndex: 1, roundId: 'round-2', dealId: 'deal-2', revision: 'roles-2' } }));
    expect(roles2.teams).toEqual([{ teamId: 'TA', bidderId: 'u2', performerId: 'u1' }, { teamId: 'TB', bidderId: 'u3', performerId: 'u4' }]);
    const make = (roles: ReturnType<typeof biddingRolesFromRoleDeal>, roundId: string, biddingId: string, expected: { dealId: string; revision: string }) => {
      const p = prepareBiddingPhase({ runIndex: 1, roundId, biddingId, sequenceId: 'seq-1', rosterRevision: 'roster-1', category: CATEGORY, numeric: NUMERIC, roles: { source: 'N5_DEAL', derived: roles, expectedDealId: expected.dealId, expectedRevision: expected.revision } });
      const first = prepareTurnSequence(biddingTurnSequenceInput(p));
      const level = (ids: string[]) => lvl(ids, 1, 'x-track', ['TA', 'TB', 'u1', 'u2', 'u3', 'u4', 'u5']);
      const seq = startTurnSequence(first, { scope: turnSequenceScopeOf(first), expectedVersion: 0, eligibility: { actors: level(['TA', 'TB']), members: level(['u1', 'u2', 'u3', 'u4', 'u5']) } }).state;
      return { bid: openBidding(p, { scope: biddingScopeOf(p), expectedVersion: 0, sequence: seq }).state, seq };
    };
    const first = make(biddingRolesFromRoleDeal(args()), 'round-1', 'bidding-1', { dealId: 'deal-1', revision: 'roles-1' });
    const second = make(roles2, 'round-2', 'bidding-2', { dealId: 'deal-2', revision: 'roles-2' });
    expect(holderOf({ ...first, n: 2 } as World)).toEqual({ teamId: 'TA', playerId: 'u1' });
    expect(holderOf({ ...second, n: 2 } as World)).toEqual({ teamId: 'TA', playerId: 'u2' });
    expect(first.bid.version).toBe(second.bid.version);
    expect(first.seq.turnNumber).toBe(second.seq.turnNumber);
    // u1 was the bidder in round 1 and is the PERFORMER in round 2: his old intent (round 1 scope) is refused in the new bidding, whatever the counters
    const oldIntent = readBiddingBidIntent({ scope: biddingScopeOf(first.bid), teamId: 'TA', turnNumber: 1, sequenceVersion: first.seq.version, biddingVersion: 1, value: num(5) });
    const level = (ids: string[]) => lvl(ids, 1, 'x-track', ['TA', 'TB', 'u1', 'u2', 'u3', 'u4', 'u5']);
    const eligibility = { actors: level(['TA', 'TB']), members: level(['u1', 'u2', 'u3', 'u4', 'u5']) };
    const run = (who: string) => () => placeBid(second.bid, { ...biddingActionArgsFromIntent(oldIntent), sequence: second.seq, caller: { role: 'PLAYER', participantId: who, teamId: 'TA' }, gate: OPEN_GATE, eligibility, nowMs: 1, value: oldIntent.value });
    expect(codeOf(run('u1'))).toBe('BIDDING_SCOPE_STALE');
    expect(codeOf(run('u2'))).toBe('BIDDING_SCOPE_STALE');
  });
});

// ── I. N5 → N10: the validated origin survives to the preparation of the bidding (N10-03) ───────────────────

describe('I. N5 → N10 boundary: a derived assignment is bound to ITS run, round and deal', () => {
  const SECRET = 'GEHEIM-TEXT-DES-DEALS';
  const PEOPLE = ['u1', 'u2', 'u3', 'u4', 'u5'];
  // two deals of the SAME run with the SAME participants and the SAME revision LABEL — only the round / deal id / roles differ
  const deal = (over: { roundId: string; dealId: string; swap: boolean; runIndex?: number; revision?: string }) => createSecretRoleDeal({
    runIndex: over.runIndex ?? 1, roundId: over.roundId, dealId: over.dealId, revision: over.revision ?? 'rev-1', participantIds: PEOPLE, roleIds: ['bidder', 'performer', 'beobachter'],
    assignments: [
      { participantId: 'u1', roleId: over.swap ? 'performer' : 'bidder' }, { participantId: 'u2', roleId: over.swap ? 'bidder' : 'performer' },
      { participantId: 'u3', roleId: over.swap ? 'performer' : 'bidder' }, { participantId: 'u4', roleId: over.swap ? 'bidder' : 'performer' }, { participantId: 'u5', roleId: 'beobachter' },
    ],
    fragments: [{ fragmentId: 'secret', title: 'Geheim', text: SECRET, recipientIds: ['u5'] }],
  });
  const R1 = { runIndex: 1, roundId: 'round-1', dealId: 'deal-r1', revision: 'rev-1' };
  const R2 = { runIndex: 1, roundId: 'round-2', dealId: 'deal-r2', revision: 'rev-1' }; // the SAME revision label
  const dealR1 = () => deal({ roundId: 'round-1', dealId: 'deal-r1', swap: false });
  const dealR2 = () => deal({ roundId: 'round-2', dealId: 'deal-r2', swap: true });
  const members = [{ teamId: 'TA', memberIds: ['u1', 'u2', 'u5'] }, { teamId: 'TB', memberIds: ['u3', 'u4'] }];
  const rolesArgs = (d: unknown, scope: typeof R1) => ({ deal: d, scope, bidderRoleId: 'bidder', performerRoleId: 'performer', teams: members });
  const derive = (d: unknown, scope: typeof R1) => biddingRolesFromRoleDeal(rolesArgs(d, scope));
  const prep = (over: Record<string, unknown>) => ({ runIndex: 1, roundId: 'round-2', biddingId: 'b-r2', sequenceId: 'seq-r2', rosterRevision: 'roster-1', category: CATEGORY, numeric: NUMERIC, ...over }) as unknown as Parameters<typeof prepareBiddingPhase>[0];

  it('the adapter result carries its ORIGIN (labels only: run, round, deal id, revision) — no role name, term or fragment', () => {
    const derived = derive(dealR1(), R1);
    expect(derived.origin).toEqual(R1);
    expect(JSON.stringify(derived).includes(SECRET) || JSON.stringify(derived).includes('beobachter')).toBe(false);
  });
  it('POSITIVE control: the derived result of round 2 is accepted for round 2 (two-step and combined path) and pins the rotated assignment', () => {
    const derived = derive(dealR2(), R2);
    const twoStep = prepareBiddingPhase(prep({ roles: { source: 'N5_DEAL', derived, expectedDealId: 'deal-r2', expectedRevision: 'rev-1' } }));
    const combined = prepareBiddingPhaseFromRoleDeal({ ...rolesArgs(dealR2(), R2), biddingId: 'b-r2', sequenceId: 'seq-r2', rosterRevision: 'roster-1', category: CATEGORY, numeric: NUMERIC });
    expect(twoStep.teams[0]).toEqual({ teamId: 'TA', bidderId: 'u2', performerId: 'u1' }); // u1 was the bidder in round 1, he is the PERFORMER now
    expect(combined).toEqual(twoStep);
    expect(twoStep).toMatchObject({ runIndex: 1, roundId: 'round-2', rolesRevision: 'rev-1' });
    expect(JSON.stringify(twoStep).includes('deal-r') || JSON.stringify(twoStep).includes(SECRET)).toBe(false); // the origin is compared, never stored or projected
  });
  it.each([
    ['another RUN', { runIndex: 2 }], ['another ROUND', { roundId: 'round-1' }],
  ])('a derived round-1 result cannot be pinned to %s even with the same participants and the same revision label', (_name, target) => {
    const derived = derive(dealR1(), R1);
    expect(codeOf(() => prepareBiddingPhase(prep({ ...target, roundId: 'round-1', ...target, roles: { source: 'N5_DEAL', derived, expectedDealId: 'deal-r1', expectedRevision: 'rev-1' } })))).toBe(
      (target as { runIndex?: number }).runIndex === 2 ? 'BIDDING_CONFIG_INVALID' : 'NO_THROW'); // run 2 refused; round 1 is the deal's own round (control)
    // the real case of the finding: round-1 roles for a round-2 bidding
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: { source: 'N5_DEAL', derived, expectedDealId: 'deal-r1', expectedRevision: 'rev-1' } })))).toBe('BIDDING_CONFIG_INVALID');
    expect(issuesOf(() => prepareBiddingPhase(prep({ roles: { source: 'N5_DEAL', derived, expectedDealId: 'deal-r1', expectedRevision: 'rev-1' } })))).toContain('CONFIG_CONFLICT');
  });
  it('another deal id with the SAME revision label and the SAME round is refused: the expected deal is independent of the result', () => {
    const other = deal({ roundId: 'round-2', dealId: 'deal-r2-other', swap: false });
    const derived = derive(other, { ...R2, dealId: 'deal-r2-other' }); // a valid result of ANOTHER deal of round 2
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: { source: 'N5_DEAL', derived, expectedDealId: 'deal-r2', expectedRevision: 'rev-1' } })))).toBe('BIDDING_CONFIG_INVALID');
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: { source: 'N5_DEAL', derived, expectedDealId: 'deal-r2-other', expectedRevision: 'rev-1' } })))).toBe('NO_THROW'); // control: its own deal
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: { source: 'N5_DEAL', derived, expectedDealId: 'deal-r2-other', expectedRevision: 'rev-9' } })))).toBe('BIDDING_CONFIG_INVALID'); // another revision
  });
  it('the combined path compares ONE expected scope with the loaded deal AND the target: a deal of another round, run, id or revision is refused', () => {
    const base = { biddingId: 'b-r2', sequenceId: 'seq-r2', rosterRevision: 'roster-1', category: CATEGORY, numeric: NUMERIC };
    expect(codeOf(() => prepareBiddingPhaseFromRoleDeal({ ...rolesArgs(dealR1(), R2), ...base }))).toBe('BIDDING_CONFIG_INVALID'); // round-1 deal under the round-2 scope
    expect(codeOf(() => prepareBiddingPhaseFromRoleDeal({ ...rolesArgs(dealR2(), { ...R2, runIndex: 2 }), ...base }))).toBe('BIDDING_CONFIG_INVALID');
    expect(codeOf(() => prepareBiddingPhaseFromRoleDeal({ ...rolesArgs(dealR2(), { ...R2, revision: 'rev-2' }), ...base }))).toBe('BIDDING_CONFIG_INVALID');
    expect(codeOf(() => prepareBiddingPhaseFromRoleDeal({ ...rolesArgs(dealR2(), R2), ...base }))).toBe('NO_THROW');
  });
  it('RAW roles and checked N5 results are DIFFERENT explicit inputs; an unlabelled or malformed roles input is refused', () => {
    const derived = derive(dealR2(), R2);
    const raw = { source: 'RAW', rolesRevision: 'rev-1', teams: derived.teams };
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: raw })))).toBe('NO_THROW'); // synthetic path: the caller owns the origin
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: derived } as Draft)))).toBe('BIDDING_CONFIG_INVALID'); // the shape alone does not pick a source
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: { source: 'N5_DEAL', derived: { rolesRevision: derived.rolesRevision, teams: derived.teams }, expectedDealId: 'deal-r2', expectedRevision: 'rev-1' } })))).toBe('BIDDING_CONFIG_INVALID'); // no origin
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: { source: 'N5_DEAL', derived, expectedDealId: 'deal-r2', expectedRevision: 'rev-1', extra: 1 } })))).toBe('BIDDING_CONFIG_INVALID');
    expect(codeOf(() => prepareBiddingPhase(prep({ roles: { source: 'RAW', rolesRevision: 'rev-1', teams: derived.teams, origin: R2 } })))).toBe('BIDDING_CONFIG_INVALID');
    expect(codeOf(() => prepareBiddingPhase({ ...prep({}), rolesRevision: 'rev-1', teams: derived.teams } as Draft))).toBe('BIDDING_ARGS_INVALID'); // the old flat shape is gone
  });
  it('the COMPLETE path N5 → N10: round 1 and round 2 with the same participants; the performer of the NEW round gets the neutral packet, the old bidder cannot bid, no secret leaves', () => {
    const e = (ids: string[]) => ({ runIndex: 1, trackId: 'x-track', rosterRevision: 'track-roster-1', version: 1, knownIds: ['TA', 'TB', ...PEOPLE], activeIds: ids });
    const eligibility = { actors: e(['TA', 'TB']), members: e(PEOPLE) };
    const world = (d: unknown, scope: typeof R1, biddingId: string) => {
      const bidding = prepareBiddingPhaseFromRoleDeal({ ...rolesArgs(d, scope), biddingId, sequenceId: `seq-${scope.roundId}`, rosterRevision: 'roster-1', category: CATEGORY, numeric: NUMERIC });
      const first = prepareTurnSequence(biddingTurnSequenceInput(bidding));
      const seq = startTurnSequence(first, { scope: turnSequenceScopeOf(first), expectedVersion: 0, eligibility }).state;
      return { bid: openBidding(bidding, { scope: biddingScopeOf(bidding), expectedVersion: 0, sequence: seq }).state, seq };
    };
    const w1 = world(dealR1(), R1, 'b-r1'), w2 = world(dealR2(), R2, 'b-r2');
    expect(holderOfSeq(w1.seq)).toEqual({ teamId: 'TA', playerId: 'u1' });
    expect(holderOfSeq(w2.seq)).toEqual({ teamId: 'TA', playerId: 'u2' }); // u2 bids in round 2
    const call = (w: typeof w1, who: string, units: number) => () => placeBid(w.bid, {
      ...biddingActionArgsFromIntent(readBiddingBidIntent({ scope: biddingScopeOf(w.bid), teamId: 'TA', turnNumber: w.seq.turnNumber, sequenceVersion: w.seq.version, biddingVersion: w.bid.version, value: num(units) })),
      sequence: w.seq, caller: { role: 'PLAYER', participantId: who, teamId: 'TA' }, gate: OPEN_GATE, eligibility, nowMs: 1, value: num(units),
    });
    expect(codeOf(call(w2, 'u1', 5))).toBe('TURN_SEQ_NOT_CURRENT_ACTOR'); // the OLD bidder, now performer
    expect(codeOf(call(w2, 'u2', 5))).toBe('NO_THROW');
    expect(codeOf(call(w1, 'u1', 5))).toBe('NO_THROW');
    const proj = (audience: ProjectionAudience, release: 'NEUTRAL' | 'STANDING') => projectBidding(audience, w2.bid, { scope: biddingScopeOf(w2.bid), sequence: w2.seq, release, stateVersion: 3 });
    const performer = proj({ role: 'PLAYER', participantId: 'u1', teamId: 'TA' }, 'NEUTRAL');
    expect(performer).toMatchObject({ release: 'NEUTRAL', recipientId: 'u1', you: { performer: true } });
    expect(codeOf(() => proj({ role: 'PLAYER', participantId: 'u1', teamId: 'TA' }, 'STANDING'))).toBe('BIDDING_RELEASE_FORBIDDEN');
    expect(proj({ role: 'PLAYER', participantId: 'u2', teamId: 'TA' }, 'STANDING')).toMatchObject({ you: { teamId: 'TA', holdsTurn: true, canBid: true } });
    expect(proj({ role: 'PLAYER', participantId: 'u5', teamId: 'TA' }, 'NEUTRAL')).toMatchObject({ you: { performer: false } }); // the observer of the deal is no pinned person
    expect(codeOf(() => proj({ role: 'PLAYER', participantId: 'u5', teamId: 'TA' }, 'STANDING'))).toBe('BIDDING_RELEASE_FORBIDDEN');
    for (const audience of [{ role: 'PLAYER', participantId: 'u1' }, { role: 'PLAYER', participantId: 'u2' }, { role: 'PLAYER', participantId: 'u5' }, VIEWER, DISPLAY, HOST] as ProjectionAudience[]) {
      const json = JSON.stringify(proj(audience, audience.role === 'PLAYER' && audience.participantId !== 'u2' ? 'NEUTRAL' : 'STANDING'));
      for (const needle of [SECRET, 'beobachter', 'deal-r1', 'deal-r2', 'Geheim']) expect(json.includes(needle) ? needle : null, `${audience.role}/${audience.participantId}`).toBeNull();
    }
  });
});
const holderOfSeq = (seq: TurnSequenceState) => currentTurnHolder(seq) as { teamId: string; playerId: string };

// ── J. Closing reserve for every write on the N8 sequence (N10-04) ──────────────────────────────────────

describe('J. The closing reserve survives BASIS, HELD and opening', () => {
  const MAX = 1_000_000_000;
  const patchSeq = (w: World, patch: Record<string, number>): World => ({ ...w, seq: parseTurnSequenceState({ ...clone(w.seq), ...patch }) });
  const baseArgs = (w: World) => ({ scope: biddingScopeOf(w.bid), expectedVersion: w.bid.version, expectedSequenceVersion: w.seq.version, sequence: w.seq });
  const refresh = (w: World, version: number) => () => refreshBiddingBasis(w.bid, { ...baseArgs(w), eligibility: elig(w, version) });
  const withhold = (w: World, version = 2) => () => withholdBiddingHolder(w.bid, { ...baseArgs(w), expectedTurnNumber: w.seq.turnNumber, eligibility: elig(w, version, { people: [holderOf(w).playerId] }) });
  const abort = (w: World) => () => abortBidding(w.bid, { ...baseArgs(w), reason: 'HOST_ABORTED', gate: { abortAuthorized: true } });

  it('OPENING: a pair opens only with room to close (one version step, one entitlement step); a pair that cannot be closed is refused, nothing is opened', () => {
    const p = prepared();
    const started = startTurnSequence(prepareTurnSequence(biddingTurnSequenceInput(p)), { scope: { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'TEAM' }, expectedVersion: 0, eligibility: elig({ n: 3 }) }).state;
    const open = (patch: Record<string, number>) => () => openBidding(p, { scope: biddingScopeOf(p), expectedVersion: 0, sequence: parseTurnSequenceState({ ...clone(started), ...patch }) });
    expect(codeOf(open({ version: MAX }))).toBe('BIDDING_COUNTER_LIMIT');
    expect(codeOf(open({ version: MAX - 1 }))).toBe('NO_THROW');
    expect(codeOf(open({ entitlementRevision: MAX }))).toBe('BIDDING_COUNTER_LIMIT');
    expect(codeOf(open({ entitlementRevision: MAX - 1 }))).toBe('NO_THROW');
    expect(p.phase).toBe('PREPARED');
  });
  it('BASIS keeps the closing reserve: below the limit ok and the abort still works; at the limit refused with the state unchanged; the abort remains possible; an equal basis consumes NOTHING', () => {
    const w = openWorld({ n: 3 });
    const below = patchSeq(w, { version: MAX - 2 });
    const stepped = refresh(below, 2)();
    expect(stepped.sequenceChanged).toBe(true);
    expect(stepped.sequence.version).toBe(MAX - 1); // exactly one step left: the close
    expect(abortBidding(stepped.state, { ...baseArgs({ ...below, seq: stepped.sequence }), expectedSequenceVersion: stepped.sequence.version, reason: 'HOST_ABORTED', gate: { abortAuthorized: true } }).sequence.phase).toBe('CLOSED');
    const at = patchSeq(w, { version: MAX - 1 });
    const frozen = [clone(at.bid), clone(at.seq)];
    expect(codeOf(refresh(at, 2))).toBe('BIDDING_COUNTER_LIMIT'); // the review's case: BASIS would take the LAST step
    expect([at.bid, at.seq]).toEqual(frozen);
    expect(abort(at)().sequence.phase).toBe('CLOSED'); // the abort is still possible
    const noop = refresh(at, 1)(); // equal basis = true no-op
    expect(noop.sequenceChanged).toBe(false);
    expect(noop.sequence).toEqual(at.seq);
    const full = patchSeq(w, { version: MAX });
    expect(codeOf(refresh(full, 2))).toBe('BIDDING_COUNTER_LIMIT'); // not the N8 state error
    expect(refresh(full, 1)().sequenceChanged).toBe(false);
    expect(codeOf(refresh(at, 0))).toBe('TURN_SEQ_ELIGIBILITY_STALE'); // the other errors keep their precedence
  });
  it('BASIS in an ACTIVE sequence also keeps the ENTITLEMENT step of the close; a stale expected version keeps its own code at the limit', () => {
    const w = openWorld({ n: 3 });
    expect(codeOf(refresh(patchSeq(w, { entitlementRevision: MAX }), 2))).toBe('BIDDING_COUNTER_LIMIT');
    expect(codeOf(refresh(patchSeq(w, { entitlementRevision: MAX - 1 }), 2))).toBe('NO_THROW');
    const at = patchSeq(w, { version: MAX - 1 });
    expect(codeOf(() => refreshBiddingBasis(at.bid, { ...baseArgs(at), expectedSequenceVersion: at.seq.version - 1, eligibility: elig(at, 2) }))).toBe('TURN_SEQ_VERSION_STALE');
  });
  it('HELD keeps the closing reserve too: its step and the entitlement flip are checked BEFORE it, the abort from HELD stays possible, a no-op consumes nothing', () => {
    const w = openWorld({ n: 3 });
    const below = patchSeq(w, { version: MAX - 2 });
    const held = withhold(below)();
    expect(held.sequence.phase).toBe('HELD');
    expect(held.sequence.version).toBe(MAX - 1);
    expect(abortBidding(held.state, { ...baseArgs({ ...below, seq: held.sequence }), expectedSequenceVersion: held.sequence.version, reason: 'TECHNICAL_ABORT', gate: { abortAuthorized: true } }).sequence.phase).toBe('CLOSED');
    const at = patchSeq(w, { version: MAX - 1 });
    const frozen = [clone(at.bid), clone(at.seq)];
    expect(codeOf(withhold(at))).toBe('BIDDING_COUNTER_LIMIT');
    expect([at.bid, at.seq]).toEqual(frozen);
    expect(abort(at)().sequence.phase).toBe('CLOSED');
    expect(codeOf(withhold(patchSeq(w, { entitlementRevision: MAX })))).toBe('BIDDING_COUNTER_LIMIT'); // the ACTIVE → HELD flip needs an entitlement step
    const lastEntitlement = patchSeq(w, { entitlementRevision: MAX - 1 });
    const flipped = withhold(lastEntitlement)();
    expect(flipped.sequence.entitlementRevision).toBe(MAX);
    expect(abortBidding(flipped.state, { ...baseArgs({ ...lastEntitlement, seq: flipped.sequence }), expectedSequenceVersion: flipped.sequence.version, reason: 'HOST_ABORTED', gate: { abortAuthorized: true } }).sequence.phase).toBe('CLOSED'); // closing from HELD needs none
    // already HELD at the limit: the equal-basis repeat is a no-op, a newer basis would take the last step
    const heldAt = { ...at, seq: parseTurnSequenceState({ ...clone(held.sequence), version: MAX - 1 }) } as World;
    expect(withhold(heldAt)().sequenceChanged).toBe(false);
    expect(codeOf(refresh(heldAt, 3))).toBe('BIDDING_COUNTER_LIMIT');
    // the holder is still eligible → the N8 code, not a capacity code
    expect(codeOf(() => withholdBiddingHolder(at.bid, { ...baseArgs(at), expectedTurnNumber: at.seq.turnNumber, eligibility: elig(at, 2) }))).toBe('TURN_SEQ_HOLDER_STILL_ELIGIBLE');
  });
  it('after BASIS at the last reserve position a bid / pass that needs a handover is refused, the closing pass of a two-team bidding and the abort still work', () => {
    const two = bid(openWorld({ n: 2 }), 3);
    const tight = patchSeq(two, { version: MAX - 2 });
    const stepped = refresh(tight, 2)(); // one step left
    const after: World = { ...tight, bid: stepped.state, seq: stepped.sequence };
    expect(codeOf(() => pass(after, { eligibility: elig(after, 2) }))).toBe('NO_THROW'); // the closing pass needs one version step and one entitlement step
    expect(abort(after)().sequence.phase).toBe('CLOSED');
    const three = bid(openWorld({ n: 3 }), 3);
    const t3 = patchSeq(three, { version: MAX - 1 });
    expect(codeOf(() => bid(t3, 9))).toBe('BIDDING_COUNTER_LIMIT'); // a handover needs two
  });
});
