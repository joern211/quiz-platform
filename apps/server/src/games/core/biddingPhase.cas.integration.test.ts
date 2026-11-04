// ============================================================
// N10 — bounded integration proof for bids, passes, the end and the abort on the EXISTING persistence stack
//
// What is REAL here: a SQLite file created from the real migrations, the real shared CAS primitive `saveGameStateIfRevision` on the real `RoomGameState` row
// (revision column), the real state-event path (`GameDomainEvent` rows written through `materializeGameEvent` / game-sdk `createStateEvent`), the real command receipts
// (`runReceipted`, table `CommandReceipt`), the real single-connection SQLite URL of the server, and a second operating-system process that reads the stored state.
// (`saveGameStateIfRevision` writes the event itself only together with `persistRoundResult`, which needs one of the registered engine slugs — `coreLifecyclePhase` throws
// WRONG_GAME for any other. The stand-in therefore calls `materializeGameEvent`, the very function the primitive uses, in the SAME transaction right before the primitive's
// CAS write; a lost CAS rolls the event back with it.)
// What is NOT real: there is NO game engine. The state row holds a stand-in JSON blob `{ phase, standIn, turnSequence, bidding }` that only this test writes; the "handler"
// below is a test-only stand-in for a future engine handler (load → pure domain calls → ONE commit of bidding state AND N8 sequence). No route, no socket, no engine
// contract, no admission/session check (the caller, the gate and the N6 stand are table entries of this test), no setup snapshot, no scoring.
// A function called twice in JavaScript would prove nothing; every claim below is read back from the database.
// ============================================================

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { BIDDING_NUMERIC_POSITIVE_INTEGER } from '@quiz/shared/bidding';
import { createTestDatabase } from '../../test-helpers.js';
import { singleConnectionSqliteUrl } from '../../persistence/sqliteUrl.js';
import { runReceipted } from './commands.js';
import { materializeGameEvent } from './events.js';
import { GameStateConflictError, saveGameStateIfRevision } from './state.js';
import {
  abortBidding, biddingActionArgsFromIntent, biddingResultBasisOf, biddingScopeOf, biddingTurnSequenceInput, openBidding, parseBiddingState, passBidding, placeBid, prepareBiddingPhase, readBiddingBidIntent,
  readBiddingPassIntent, withholdBiddingHolder, type BiddingState,
} from './biddingPhase.js';
import { currentTurnHolder, parseTurnSequenceState, prepareTurnSequence, startTurnSequence, turnSequenceScopeOf, type TurnEligibility, type TurnSequenceState } from './turnSequence.js';

const run = promisify(execFile);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SLUG = 'n10-stand-in';
/** A STAND-IN action name: `CRITICAL_COMMAND_ACTIONS` is a closed whitelist and N10 introduces no new command kind. The real consumer adds its own bidding actions there (handoff). */
const STAND_IN_ACTION = 'ROUND_ADVANCE' as const;
let db: PrismaClient, dir: string, url: string, previousGlobal: PrismaClient | undefined, sequence = 0, hostId: string, definitionId: string;

const TEAM_COUNT = 3;
const teams = Array.from({ length: TEAM_COUNT }, (_, i) => ({ teamId: `T${i + 1}`, bidderId: `b${i + 1}`, performerId: `p${i + 1}` }));
const people = teams.flatMap(t => [t.bidderId, t.performerId]);
const lvl = (activeIds: string[], version: number, trackId: string, knownIds: string[], runIndex: number) => ({ runIndex, trackId, rosterRevision: 'track-roster-1', version, knownIds, activeIds });
/** The server's own N6 stand (a table entry of this test): all teams and all pinned people active. */
const eligibility = (version = 1, runIndex = 1, off: { people?: string[] } = {}): TurnEligibility => ({
  actors: lvl(teams.map(t => t.teamId), version, 'teams-track', teams.map(t => t.teamId), runIndex),
  members: lvl(people.filter(id => !(off.people ?? []).includes(id)), version, 'members-track', people, runIndex),
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-n10-cas-'));
  url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: singleConnectionSqliteUrl(url) }); // the same single connection the server uses
  await db.$connect();
  previousGlobal = (globalThis as { __prisma?: PrismaClient }).__prisma;
  (globalThis as { __prisma?: PrismaClient }).__prisma = db; // other modules of the stack read the lazily created global
  hostId = (await db.user.create({ data: { displayName: 'N10 host', role: 'HOST', passwordHash: 'unused' } })).id;
  definitionId = (await db.gameDefinition.create({ data: { slug: SLUG, name: 'n10 stand-in', category: 'test', status: 'BETA', minPlayers: 2 } })).id;
});
afterAll(async () => {
  (globalThis as { __prisma?: PrismaClient }).__prisma = previousGlobal;
  await db?.$disconnect();
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface StandInState { phase: string; standIn: boolean; turnSequence: unknown; bidding: unknown }
interface Stored { revision: number; phase: string; state: StandInState }
interface WorldOver { runIndex?: number; roundId?: string; biddingId?: string; sequenceId?: string; rosterRevision?: string; rolesRevision?: string }

/** A started N8 team sequence that fits and the OPEN bidding against it; optionally the first bid already made (T1 bids 3, T2 is up). Every world has the SAME counters. */
function buildWorld(over: WorldOver = {}, firstBid = false): { seq: TurnSequenceState; bid: BiddingState } {
  const runIndex = over.runIndex ?? 1;
  const prepared = prepareBiddingPhase({
    runIndex, roundId: over.roundId ?? 'round-1', biddingId: over.biddingId ?? 'bidding-1', sequenceId: over.sequenceId ?? 'seq-n10',
    rosterRevision: over.rosterRevision ?? 'roster-1', category: 'Hauptstädte', numeric: BIDDING_NUMERIC_POSITIVE_INTEGER,
    roles: { source: 'RAW', rolesRevision: over.rolesRevision ?? 'roles-1', teams }, // synthetic stand-in: the origin of the assignment is the test's own (N5 → N10 is proven in biddingPhase.test.ts H)
  });
  const first = prepareTurnSequence(biddingTurnSequenceInput(prepared));
  const seq = startTurnSequence(first, { scope: turnSequenceScopeOf(first), expectedVersion: 0, eligibility: eligibility(1, runIndex) }).state;
  let bid = openBidding(prepared, { scope: biddingScopeOf(prepared), expectedVersion: 0, sequence: seq }).state;
  let current = seq;
  if (firstBid) {
    const holder = currentTurnHolder(current)!;
    const r = placeBid(bid, {
      ...biddingActionArgsFromIntent(readBiddingBidIntent({ scope: biddingScopeOf(bid), teamId: holder.teamId, turnNumber: current.turnNumber, sequenceVersion: current.version, biddingVersion: bid.version, value: { units: 3, scale: 0 } })),
      sequence: current, caller: { role: 'PLAYER', participantId: holder.playerId, teamId: holder.teamId }, gate: OPEN, eligibility: eligibility(1, runIndex), nowMs: 1000, value: { units: 3, scale: 0 },
    });
    bid = r.state; current = r.sequence;
  }
  return { seq: current, bid };
}
/** A fresh room whose stand-in state holds a world. */
async function fixture(over: WorldOver = {}, firstBid = false): Promise<{ roomId: string }> {
  const code = String(950000 + sequence++).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'N10 stand-in', hostUserId: hostId, gameDefinitionId: definitionId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE', viewerRequiresPin: false } });
  const { seq, bid } = buildWorld(over, firstBid);
  await db.roomGameState.create({ data: { roomId: room.id, engineVersion: 1, phase: 'ROUND_ACTIVE', revision: 4, stateJson: JSON.stringify({ phase: 'ROUND_ACTIVE', standIn: true, turnSequence: seq, bidding: bid }) } });
  return { roomId: room.id };
}
async function load(roomId: string): Promise<Stored> {
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } });
  return { revision: row.revision, phase: row.phase, state: JSON.parse(row.stateJson) as StandInState };
}
/** The stand-in's commit: ONE transaction with the state event (real SDK path) and the shared CAS write on the revision that was LOADED. */
async function persist(roomId: string, loaded: Stored, state: StandInState, type: string): Promise<void> {
  await db.$transaction(async tx => {
    // NO own revision pre-check here: the conditional UPDATE of the shared primitive is the ONLY guard (a pre-check would make the primitive's CAS redundant and unproven).
    const before = await tx.roomGameState.findUniqueOrThrow({ where: { roomId } });
    await materializeGameEvent(tx, { roomId, gameSlug: SLUG, engineVersion: before.engineVersion, before, nextState: state, type });
    await saveGameStateIfRevision(tx, { roomId, expectedRevision: loaded.revision, phase: loaded.phase, state });
  });
}
const seqOf = (stored: Stored) => parseTurnSequenceState(stored.state.turnSequence);
const bidOf = (stored: Stored) => parseBiddingState(stored.state.bidding);
const holderOf = (stored: Stored) => currentTurnHolder(seqOf(stored))!;

const OPEN = { admitted: true, phaseOpen: true, paused: false };
type Binding = ReturnType<typeof bindingOf>;
/** The ORIGIN of an intent as the client saw it (from ITS last projection — here the stored stand at that time): target, team and the three counters. */
function bindingOf(stored: Stored, teamId?: string) {
  return { scope: biddingScopeOf(bidOf(stored)), teamId: teamId ?? holderOf(stored).teamId, turnNumber: seqOf(stored).turnNumber, sequenceVersion: seqOf(stored).version, biddingVersion: bidOf(stored).version };
}
type Intent = { kind: 'BID'; binding: Binding; units: number } | { kind: 'PASS'; binding: Binding };
const bidIntent = (binding: Binding, units: number): Intent => ({ kind: 'BID', binding, units });
const passIntent = (binding: Binding): Intent => ({ kind: 'PASS', binding });
const num = (units: number) => ({ units, scale: 0 as const });

/**
 * TEST-ONLY stand-in for an engine handler's last steps: parse the stored state, validate the client intent at the server boundary, call the pure domain (N8 authorisation first),
 * then ONE commit of the bidding state AND the N8 sequence (state event + shared CAS write on the REVISION THAT WAS LOADED). There is NO retry here: a lost CAS is the answer.
 */
async function handle(loaded: Stored, roomId: string, intent: Intent, over: { who?: { participantId: string; teamId: string }; stand?: TurnEligibility; nowMs?: number } = {}) {
  const bidding = bidOf(loaded), seq = seqOf(loaded);
  const holder = holderOf(loaded);
  const who = over.who ?? { participantId: holder.playerId, teamId: holder.teamId as string };
  const trusted = over.stand ?? eligibility(1, seq.runIndex); // the server's own N6 stand
  const parsed = intent.kind === 'BID' ? readBiddingBidIntent({ ...intent.binding, value: num(intent.units) }) : readBiddingPassIntent(intent.binding);
  // the ORIGIN comes from the INTENT (what the client saw); only the trusted facts come from the loaded state and the server session
  const common = { ...biddingActionArgsFromIntent(parsed), sequence: seq, caller: { role: 'PLAYER' as const, participantId: who.participantId, teamId: who.teamId }, gate: OPEN, eligibility: trusted, nowMs: over.nowMs ?? 5000 };
  const result = intent.kind === 'BID' ? placeBid(bidding, { ...common, value: num(intent.units) }) : passBidding(bidding, common);
  await persist(roomId, loaded, { ...loaded.state, turnSequence: result.sequence, bidding: result.state }, 'BIDDING_CHANGED');
  return { version: result.state.version, stepCount: result.state.stepCount, phase: result.state.phase, leader: result.state.leader, turnNumber: result.sequence.turnNumber };
}

type Settled = PromiseSettledResult<unknown>;
const outcome = (result: Settled): string => (result.status === 'fulfilled' ? 'OK' : String((result.reason as Error).message ?? result.reason));
const ok = (results: Settled[]) => results.filter(r => r.status === 'fulfilled').length;
const receiptSend = (roomId: string, commandId: string, intent: Intent, counter?: { effects: number }) => runReceipted(db, {
  roomId, commandId, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: STAND_IN_ACTION, payload: intent,
  mutate: async () => { if (counter) counter.effects++; return handle(await load(roomId), roomId, intent); },
  toResponse: data => ({ success: true, ...data }),
});

describe('N10 integration: bids, passes, the regular end and the abort on the real CAS / receipt / state-event stack (SQLite)', () => {
  it('bid → bid → pass → bid → pass: every step is read back from the database — bidding state AND N8 sequence move in ONE commit; the end closes both; the stored events replay to the same state', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    const steps: Array<[Intent['kind'], number | null, string]> = [['BID', 3, 'T2'], ['BID', 5, 'T3'], ['PASS', null, 'T1'], ['BID', 7, 'T2'], ['PASS', null, 'END']];
    let revision = 4;
    for (const [kind, units, nextUp] of steps) {
      const binding = bindingOf(stored);
      await handle(stored, roomId, kind === 'BID' ? bidIntent(binding, units as number) : passIntent(binding));
      stored = await load(roomId);
      revision++;
      expect(stored.revision).toBe(revision); // exactly ONE commit per action: bidding state and sequence together
      expect(bidOf(stored).version).toBe(bidOf(stored).history.length + 1);
      if (nextUp !== 'END') {
        expect(holderOf(stored).teamId).toBe(nextUp);
        expect(seqOf(stored).turnNumber).toBe(bidOf(stored).history.length + 1); // the sequence and the evidence never disagree about the turn
      }
    }
    // expected schedule: T1 3, T2 5, T3 passes (against T2), T1 7, T2 passes (against T1) → T1 wins 7
    expect(bidOf(stored)).toMatchObject({ phase: 'CLOSED', endReason: 'COMPLETED', leader: { teamId: 'T1', units: 7 }, passedTeamIds: ['T3', 'T2'] });
    expect(seqOf(stored).phase).toBe('CLOSED'); // closed in the SAME commit as the result
    expect(biddingResultBasisOf(stored.state.bidding)).toMatchObject({ winnerTeamId: 'T1', winningValue: num(7), bidderId: 'b1', performerId: 'p1', lastPassAgainstWinnerTeamId: 'T2', earlierPasses: [{ teamId: 'T3', againstTeamId: 'T2', step: 3 }] });
    expect(seqOf(stored)).toMatchObject({ completedTurns: 0, cycle: 0 });
    expect(seqOf(stored).teams?.map(t => [t.members, t.cursor])).toEqual([[['b1'], 0], [['b2'], 0], [['b3'], 0]]); // no bidder rotation
    // the real event path wrote one GameDomainEvent per commit; replaying them rebuilds exactly the stored state — no bid, pass or handover anywhere
    const room = await db.room.findUniqueOrThrow({ where: { id: roomId } });
    const rows = await db.gameDomainEvent.findMany({ where: { roomId }, orderBy: { stateVersion: 'asc' } });
    expect(rows.map(r => r.type)).toEqual(Array(5).fill('BIDDING_CHANGED'));
    const start: EngineStateSnapshot = { roomId, runIndex: room.runIndex, gameSlug: SLUG, engineVersion: 1, stateVersion: 4, state: {} };
    const rebuilt = rows.reduce<EngineStateSnapshot>((snapshot, row) => applyStateEvent(snapshot, JSON.parse(row.payloadJson)), start);
    expect(rebuilt.stateVersion).toBe(9);
    expect(rebuilt.state).toEqual(stored.state);
  });

  it('the same commandId, sent in parallel and again after the confirmation was lost: ONE bid, the stored answer is replayed, the handler body does not run again', async () => {
    const { roomId } = await fixture();
    const commandId = `cmd-${randomUUID()}`;
    const stored0 = await load(roomId);
    const intent = bidIntent(bindingOf(stored0), 4);
    const counter = { effects: 0 };
    const parallel = await Promise.all([receiptSend(roomId, commandId, intent, counter), receiptSend(roomId, commandId, intent, counter)]);
    expect(counter.effects).toBe(1);
    expect(parallel.filter(r => r.replayed)).toHaveLength(1);
    expect(parallel.every(r => r.success)).toBe(true);
    const afterFirst = await load(roomId);
    expect(afterFirst.revision).toBe(5);
    expect(bidOf(afterFirst)).toMatchObject({ leader: { teamId: 'T1', units: 4 }, stepCount: 1 });
    const again = await receiptSend(roomId, commandId, intent, counter); // the answer was "lost": the SAME intent with the SAME commandId later
    expect(again).toMatchObject({ success: true, replayed: true });
    expect((again as { data: { leader: { units: number } } }).data.leader.units).toBe(4); // the stored answer, not a new bid
    expect(counter.effects).toBe(1);
    expect(await load(roomId)).toEqual(afterFirst);
    const receipts = await db.commandReceipt.findMany({ where: { roomId, commandId } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('COMPLETED');
  });

  it('two DIFFERENT bids of the same holder against the same expected stand: the CAS lets at most one through; exactly ONE is stored, never a mixture, and the loser changed nothing', async () => {
    for (let round = 0; round < 3; round++) {
      const { roomId } = await fixture();
      const [l1, l2] = await Promise.all([load(roomId), load(roomId)]);
      const binding = bindingOf(l1);
      const results = await Promise.allSettled([handle(l1, roomId, bidIntent(binding, 10)), handle(l2, roomId, bidIntent(binding, 20))]);
      expect(ok(results), results.map(outcome).join(' | ')).toBe(1);
      const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(GameStateConflictError);
      const stored = await load(roomId);
      expect(stored.revision).toBe(5);
      const winner = results[0].status === 'fulfilled' ? 10 : 20;
      expect(bidOf(stored)).toMatchObject({ stepCount: 1, leader: { teamId: 'T1', units: winner } });
      expect(bidOf(stored).history).toHaveLength(1);
      expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(1); // the loser's event was rolled back with its CAS
    }
  });

  it('a late retry of the loser against the NEWER stand is not silently re-interpreted: its old binding is stale, nothing is applied', async () => {
    const { roomId } = await fixture();
    const loaded = await load(roomId);
    const oldBinding = bindingOf(loaded);
    await handle(loaded, roomId, bidIntent(oldBinding, 10));
    const current = await load(roomId);
    await expect(handle(current, roomId, bidIntent(oldBinding, 20))).rejects.toThrow(/TURN_SEQ_VERSION_STALE|TURN_SEQ_TURN_STALE|BIDDING_VERSION_STALE/);
    expect(await load(roomId)).toEqual(current);
  });

  it('a bid against a pass from the SAME stand: exactly one order wins — no half effect, no re-activated passed team', async () => {
    for (const order of ['bid-first', 'pass-first'] as const) {
      const { roomId } = await fixture({}, true); // T1 led with 3, T2 is up
      const [l1, l2] = await Promise.all([load(roomId), load(roomId)]);
      const binding = bindingOf(l1);
      expect(holderOf(l1).teamId).toBe('T2');
      const attempts = order === 'bid-first'
        ? [handle(l1, roomId, bidIntent(binding, 9)), handle(l2, roomId, passIntent(binding))]
        : [handle(l1, roomId, passIntent(binding)), handle(l2, roomId, bidIntent(binding, 9))];
      const results = await Promise.allSettled(attempts);
      expect(ok(results), results.map(outcome).join(' | ')).toBe(1);
      const stored = await load(roomId);
      expect(stored.revision).toBe(5); // the fixture's world (revision 4) plus exactly ONE commit
      const state = bidOf(stored);
      const bidWon = state.leader?.teamId === 'T2';
      if (bidWon) expect(state).toMatchObject({ stepCount: 2, leader: { teamId: 'T2', units: 9 }, passedTeamIds: [] });
      else expect(state).toMatchObject({ stepCount: 2, leader: { teamId: 'T1', units: 3 }, passedTeamIds: ['T2'] });
      expect(holderOf(stored).teamId).toBe('T3'); // the turn went on exactly once
      expect(seqOf(stored).turnNumber).toBe(3);
      // the team that passed stays out: T2 can not bid any more even with a fresh binding of its own
      if (!bidWon) {
        await expect(handle(stored, roomId, bidIntent(bindingOf(stored, 'T2'), 50), { who: { participantId: 'b2', teamId: 'T2' } })).rejects.toThrow('TURN_SEQ_NOT_CURRENT_ACTOR');
        expect(await load(roomId)).toEqual(stored);
      }
    }
  });

  it('two passes racing at the point of the regular end: exactly ONE valid close and ONE consistent result; a late third delivery changes nothing', async () => {
    for (let round = 0; round < 3; round++) {
      const { roomId } = await fixture({}, true);
      let stored = await load(roomId);
      await handle(stored, roomId, passIntent(bindingOf(stored))); // T2 passes (against T1) → T3 is up
      stored = await load(roomId);
      expect(holderOf(stored).teamId).toBe('T3');
      const [l1, l2] = await Promise.all([load(roomId), load(roomId)]);
      const binding = bindingOf(l1);
      const results = await Promise.allSettled([handle(l1, roomId, passIntent(binding)), handle(l2, roomId, passIntent(binding))]);
      expect(ok(results), results.map(outcome).join(' | ')).toBe(1);
      const closed = await load(roomId);
      expect(bidOf(closed)).toMatchObject({ phase: 'CLOSED', endReason: 'COMPLETED', passedTeamIds: ['T2', 'T3'], stepCount: 3 });
      expect(seqOf(closed).phase).toBe('CLOSED');
      expect(biddingResultBasisOf(closed.state.bidding)).toMatchObject({ winnerTeamId: 'T1', winningValue: num(3), lastPassAgainstWinnerTeamId: 'T3', earlierPasses: [{ teamId: 'T2', againstTeamId: 'T1', step: 2 }] });
      expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(2); // the pass and the closing pass — no second close event
      // a late delivery (new commandId, old binding) after the end: refused, no second result
      await expect(handle(closed, roomId, passIntent(binding), { who: { participantId: 'b3', teamId: 'T3' } })).rejects.toThrow('BIDDING_ENDED');
      expect(await load(roomId)).toEqual(closed);
    }
  });

  it('recovery after commit but before the answer arrived: the same command is replayed (no new bid); a NEW commandId with the old binding is refused; the next authorised bid continues from the stored state', async () => {
    const { roomId } = await fixture();
    const first = await load(roomId);
    const intent = bidIntent(bindingOf(first), 6);
    const commandId = `cmd-${randomUUID()}`;
    const counter = { effects: 0 };
    expect((await receiptSend(roomId, commandId, intent, counter)).success).toBe(true); // committed; the answer is "lost" on the way
    const stored = await load(roomId);
    expect(bidOf(stored)).toMatchObject({ leader: { teamId: 'T1', units: 6 }, stepCount: 1 });
    expect(await receiptSend(roomId, commandId, intent, counter)).toMatchObject({ success: true, replayed: true });
    expect(counter.effects).toBe(1);
    // a client that gave up and built a NEW id for the same old intent gets no second bid
    await expect(receiptSend(roomId, `cmd-${randomUUID()}`, intent, counter)).rejects.toThrow(/TURN_SEQ_VERSION_STALE|TURN_SEQ_TURN_STALE|BIDDING_VERSION_STALE/);
    expect(await load(roomId)).toEqual(stored);
    // re-synchronised, the client's next intent carries the stored numbers and continues from them (the holder is now T2)
    await handle(await load(roomId), roomId, bidIntent(bindingOf(stored), 8));
    expect(bidOf(await load(roomId))).toMatchObject({ leader: { teamId: 'T2', units: 8 }, stepCount: 2 });
  });

  it('the process dies AFTER the commit but BEFORE the receipt is completed: the retry with the SAME commandId is told to resync — the handler does not run again, nothing is bid or passed twice', async () => {
    const { roomId } = await fixture();
    const first = await load(roomId);
    const intent = bidIntent(bindingOf(first), 6);
    const commandId = `cmd-${randomUUID()}`;
    let effects = 0, crash = true;
    const send = () => runReceipted(db, {
      roomId, commandId, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: STAND_IN_ACTION, payload: intent,
      mutate: async () => { effects++; return handle(await load(roomId), roomId, intent); },
      toResponse: data => { if (crash) throw new Error('PROCESS_DIED_BEFORE_THE_RECEIPT'); return { success: true, ...data }; },
    });
    await expect(send()).rejects.toThrow('PROCESS_DIED_BEFORE_THE_RECEIPT');
    const stored = await load(roomId); // the bid IS committed, only its receipt is not
    expect(bidOf(stored)).toMatchObject({ leader: { teamId: 'T1', units: 6 }, stepCount: 1 });
    expect((await db.commandReceipt.findUniqueOrThrow({ where: { roomId_commandId: { roomId, commandId } } })).mutationStartedAt).not.toBeNull();
    crash = false;
    const retry = await send();
    expect(retry).toMatchObject({ success: false, error: 'COMMAND_STATE_ADVANCED', resyncRequired: true });
    expect(effects).toBe(1);
    expect(await load(roomId)).toEqual(stored);
    await handle(await load(roomId), roomId, bidIntent(bindingOf(stored), 9));
    expect(bidOf(await load(roomId))).toMatchObject({ leader: { teamId: 'T2', units: 9 }, stepCount: 2 });
  });

  it('a bid that fails BEFORE any commit (stale binding, not higher) leaves the state alone and, retried with the same commandId, fails the same way — it never becomes a bid by retrying', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    await handle(stored0, roomId, bidIntent(bindingOf(stored0), 6));
    const stored = await load(roomId);
    const stale = bidIntent(bindingOf(stored0), 99); // the numbers from BEFORE the bid
    const commandId = `cmd-${randomUUID()}`;
    const counter = { effects: 0 };
    await expect(receiptSend(roomId, commandId, stale, counter)).rejects.toThrow(/STALE/);
    await expect(receiptSend(roomId, commandId, stale, counter)).rejects.toThrow(/STALE/);
    expect(counter.effects).toBe(2); // nothing was mutated: the body ran again and failed the same way
    expect(await load(roomId)).toEqual(stored);
    // not higher, with the CURRENT binding
    await expect(handle(stored, roomId, bidIntent(bindingOf(stored), 6))).rejects.toThrow('BIDDING_VALUE_NOT_HIGHER');
    expect(await load(roomId)).toEqual(stored);
  });

  /** The consumer replaces the room's state by another world (a rematch, a new sequence, a new roster, a new round): ONE commit, a NEW global revision. */
  async function replaceWorld(roomId: string, over: WorldOver, firstBid: boolean): Promise<Stored> {
    const loaded = await load(roomId);
    const world = buildWorld(over, firstBid);
    await persist(roomId, loaded, { ...loaded.state, turnSequence: world.seq, bidding: world.bid }, 'WORLD_REPLACED');
    return load(roomId);
  }
  const TARGET_CASES: Array<[string, WorldOver]> = [
    ['another run (same player ids, valid NEW N6 track)', { runIndex: 2 }],
    ['another round', { roundId: 'round-2' }],
    ['another bidding of the same round and sequence', { biddingId: 'bidding-2' }],
    ['another N8 sequence of the same run', { sequenceId: 'seq-n10-next' }],
    ['another pinned roster revision', { rosterRevision: 'roster-2' }],
    ['another roles revision (rotated bidder/performer assignment)', { rolesRevision: 'roles-2' }],
  ];
  it.each(TARGET_CASES)('a late intent of an OLD target, delivered for the FIRST time (no receipt yet) after %s: refused on the real DB path — no event, no revision step, no stored effect, no completed receipt; the fresh intent works (N9-01 for bids)', async (_name, over) => {
    for (const kind of ['BID', 'PASS'] as const) {
      const { roomId } = await fixture({}, true); // a leader exists, so a pass is possible in the same shape
      const old = await load(roomId);
      const delayed: Intent = kind === 'BID' ? bidIntent(bindingOf(old), 50) : passIntent(bindingOf(old)); // prepared against the old target; it did NOT reach the server then
      const current = await replaceWorld(roomId, over, true); // same player, same local counters, a NEW global revision
      const fresh: Intent = kind === 'BID' ? bidIntent(bindingOf(current), 50) : passIntent(bindingOf(current));
      const counters = (i: Intent) => [i.binding.teamId, i.binding.turnNumber, i.binding.sequenceVersion, i.binding.biddingVersion];
      expect(counters(delayed)).toEqual(counters(fresh)); // the precondition of the failure: only the origin differs
      expect(current.revision).toBeGreaterThan(old.revision);
      const eventsBefore = await db.gameDomainEvent.count({ where: { roomId } });
      const commandId = `cmd-${randomUUID()}`;
      await expect(receiptSend(roomId, commandId, delayed), `${kind}: ${_name}`).rejects.toThrow('BIDDING_SCOPE_STALE');
      expect(await load(roomId)).toEqual(current);
      expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(eventsBefore);
      expect((await db.commandReceipt.findUniqueOrThrow({ where: { roomId_commandId: { roomId, commandId } } })).status).not.toBe('COMPLETED'); // no success was ever recorded for it
      expect((await handle(current, roomId, fresh)).stepCount).toBeGreaterThan(1); // positive control: the fresh intent of the NEW target
    }
  });

  it('the receipt payload carries operation, origin and value: the same commandId with another operation, another target or another value is a conflict, never a replay of the other answer; the exact same intent replays', async () => {
    const { roomId } = await fixture({}, true);
    const stored = await load(roomId);
    const binding = bindingOf(stored);
    const intent = bidIntent(binding, 9);
    const commandId = `cmd-${randomUUID()}`;
    const counter = { effects: 0 };
    expect((await receiptSend(roomId, commandId, intent, counter)).success).toBe(true);
    expect(await receiptSend(roomId, commandId, intent, counter)).toMatchObject({ success: true, replayed: true }); // positive control
    expect(await receiptSend(roomId, commandId, passIntent(binding), counter)).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' }); // another OPERATION
    expect(await receiptSend(roomId, commandId, bidIntent(binding, 10), counter)).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' }); // another VALUE
    expect(await receiptSend(roomId, commandId, bidIntent({ ...binding, scope: { ...binding.scope, biddingId: 'bidding-other' } }, 9), counter)).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' }); // another TARGET
    expect(await receiptSend(roomId, commandId, bidIntent({ ...binding, teamId: 'T3' }, 9), counter)).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' }); // another team expectation
    expect(await receiptSend(roomId, commandId, bidIntent({ ...binding, biddingVersion: binding.biddingVersion + 1 }, 9), counter)).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' }); // another counter
    expect(counter.effects).toBe(1);
    expect(bidOf(await load(roomId))).toMatchObject({ leader: { teamId: 'T2', units: 9 }, stepCount: 2 });
  });

  it('a newer N6 stand seen by a bid is persisted in the SAME commit (N8-02): one revision step, the handover carries the basis; the old stand and the old binding are fenced afterwards', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    const binding = bindingOf(stored0);
    await handle(stored0, roomId, bidIntent(binding, 4), { stand: eligibility(7) });
    const stored = await load(roomId);
    expect(stored.revision).toBe(5); // ONE commit carried the bid, the handover and the basis
    expect(seqOf(stored).eligibility?.actors.version).toBe(7);
    expect(seqOf(stored).eligibility?.members?.version).toBe(7);
    expect(bidOf(stored)).toMatchObject({ leader: { teamId: 'T1', units: 4 }, stepCount: 1 });
    await expect(handle(stored, roomId, bidIntent(bindingOf(stored), 6), { stand: eligibility(1), who: { participantId: 'b2', teamId: 'T2' } })).rejects.toThrow('TURN_SEQ_ELIGIBILITY_STALE');
    await expect(handle(stored, roomId, bidIntent(binding, 6), { stand: eligibility(7), who: { participantId: 'b2', teamId: 'T2' } })).rejects.toThrow(/TURN_SEQ_VERSION_STALE|TURN_SEQ_TURN_STALE/);
    expect(await load(roomId)).toEqual(stored);
  });

  it('the next bidder is not eligible: the bid is refused as a whole — read back from the database nothing changed (no half bid without its handover)', async () => {
    const { roomId } = await fixture();
    const stored = await load(roomId);
    const eventsBefore = await db.gameDomainEvent.count({ where: { roomId } });
    await expect(handle(stored, roomId, bidIntent(bindingOf(stored), 4), { stand: eligibility(2, 1, { people: ['b2'] }) })).rejects.toThrow('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
    expect(await load(roomId)).toEqual(stored);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(eventsBefore);
  });

  it('a lost bidder role: HELD is persisted (bids stay, no pass, no winner); only the authorised abort ends it, in ONE commit with the sequence close; a late bid afterwards changes nothing', async () => {
    const { roomId } = await fixture({}, true); // T2 is up
    let stored = await load(roomId);
    const bidding = bidOf(stored), seq = seqOf(stored);
    const held = withholdBiddingHolder(bidding, { scope: biddingScopeOf(bidding), expectedVersion: bidding.version, expectedSequenceVersion: seq.version, expectedTurnNumber: seq.turnNumber, sequence: seq, eligibility: eligibility(2, 1, { people: ['b2'] }) });
    await persist(roomId, stored, { ...stored.state, turnSequence: held.sequence }, 'BIDDER_HELD');
    stored = await load(roomId);
    expect(seqOf(stored).phase).toBe('HELD');
    expect(bidOf(stored)).toEqual(bidding); // no pass, no winner, no result
    await expect(handle(stored, roomId, bidIntent(bindingOf(stored), 9), { stand: eligibility(2, 1, { people: ['b2'] }) })).rejects.toThrow('TURN_SEQ_HELD');
    const aborted = abortBidding(bidOf(stored), { scope: biddingScopeOf(bidOf(stored)), expectedVersion: bidOf(stored).version, expectedSequenceVersion: seqOf(stored).version, sequence: seqOf(stored), reason: 'HOST_ABORTED', gate: { abortAuthorized: true } });
    await persist(roomId, stored, { ...stored.state, turnSequence: aborted.sequence, bidding: aborted.state }, 'BIDDING_ABORTED');
    const ended = await load(roomId);
    expect(bidOf(ended)).toMatchObject({ phase: 'ABORTED', endReason: 'HOST_ABORTED', result: null });
    expect(seqOf(ended).phase).toBe('CLOSED');
    expect(biddingResultBasisOf(ended.state.bidding)).toBeNull();
    await expect(handle(ended, roomId, bidIntent(bindingOf(stored), 9), { who: { participantId: 'b2', teamId: 'T2' } })).rejects.toThrow('BIDDING_ENDED');
    expect(await load(roomId)).toEqual(ended);
  });

  it('a damaged stored state is refused when it is read — nothing is repaired, nothing is reset to an empty bidding, nothing is written', async () => {
    const { roomId } = await fixture({}, true);
    const stored = await load(roomId);
    const damaged = JSON.parse(JSON.stringify(stored.state)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    damaged.bidding.leader.units += 1; // the history no longer supports the leader
    await db.roomGameState.update({ where: { roomId }, data: { stateJson: JSON.stringify(damaged) } }); // tampered behind the domain's back (the revision column is unchanged)
    const again = await load(roomId);
    const events = await db.gameDomainEvent.count({ where: { roomId } });
    await expect(handle(again, roomId, bidIntent(bindingOf(stored), 9))).rejects.toThrow('BIDDING_STATE_INVALID');
    expect((await load(roomId)).revision).toBe(again.revision);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(events);
  });

  it('recovery in a SECOND process: the stored bidding is read back unchanged, projects neutral for a performer and standing for a viewer, and the next authorised bid continues from it', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    await handle(stored, roomId, bidIntent(bindingOf(stored), 3));
    stored = await load(roomId);
    await handle(stored, roomId, bidIntent(bindingOf(stored), 5));
    stored = await load(roomId);
    const before = bidOf(stored);
    expect(stored.revision).toBe(6);
    // a separate Node process: its own module instances and its own Prisma client. It only READS and computes in memory.
    const script = `
      const { PrismaClient } = require('@prisma/client');
      (async () => {
        const bidding = await import(${JSON.stringify(join(serverRoot, 'src/games/core/biddingPhase.ts'))});
        const turn = await import(${JSON.stringify(join(serverRoot, 'src/games/core/turnSequence.ts'))});
        const client = new PrismaClient({ datasourceUrl: process.env.CHILD_DB });
        const row = await client.roomGameState.findUniqueOrThrow({ where: { roomId: process.env.CHILD_ROOM } });
        const stored = JSON.parse(row.stateJson);
        const state = bidding.parseBiddingState(stored.bidding);
        const seq = turn.parseTurnSequenceState(stored.turnSequence);
        const scope = bidding.biddingScopeOf(state);
        const viewer = bidding.projectBidding({ role: 'VIEWER' }, state, { scope, sequence: seq, release: 'STANDING', stateVersion: row.revision });
        const performer = bidding.projectBidding({ role: 'PLAYER', participantId: 'p3', teamId: 'T3' }, state, { scope, sequence: seq, release: 'NEUTRAL', stateVersion: row.revision });
        const mine = bidding.projectBidding({ role: 'PLAYER', participantId: 'b3', teamId: 'T3' }, state, { scope, sequence: seq, release: 'STANDING', stateVersion: row.revision });
        const level = (ids, known, track) => ({ runIndex: 1, trackId: track, rosterRevision: 'track-roster-1', version: 1, knownIds: known, activeIds: ids });
        const teams = ['T1', 'T2', 'T3'], people = ['b1', 'p1', 'b2', 'p2', 'b3', 'p3'];
        const next = bidding.placeBid(state, { ...bidding.biddingActionArgsFromIntent({ scope, teamId: 'T3', turnNumber: seq.turnNumber, sequenceVersion: seq.version, biddingVersion: state.version }),
          sequence: seq, caller: { role: 'PLAYER', participantId: 'b3', teamId: 'T3' }, gate: { admitted: true, phaseOpen: true, paused: false },
          eligibility: { actors: level(teams, teams, 'teams-track'), members: level(people, people, 'members-track') }, nowMs: 5000, value: { units: 8, scale: 0 } });
        console.log(JSON.stringify({ revision: row.revision, state, viewer, performer, mine, next: next.state, nextSequence: next.sequence }));
        await client.$disconnect();
      })().catch(error => { console.error(error); process.exit(1); });
    `;
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '-e', script], { cwd: serverRoot, env: { ...process.env, CHILD_DB: singleConnectionSqliteUrl(url), CHILD_ROOM: roomId }, timeout: 60000 });
    const seen = JSON.parse(stdout.trim().split('\n').pop()!) as { revision: number; state: unknown; viewer: { standing: unknown; you: unknown; category: string }; performer: Record<string, unknown>; mine: { you: { canBid: boolean; canPass: boolean } }; next: BiddingState; nextSequence: TurnSequenceState };
    expect(seen.revision).toBe(6);
    expect(seen.state).toEqual(before); // identical leader, history, counters
    expect(seen.viewer).toMatchObject({ standing: { teamId: 'T2', value: num(5) }, you: null, category: 'Hauptstädte' });
    expect(Object.keys(seen.performer).sort()).toEqual(['contract', 'phase', 'recipientId', 'release', 'scope', 'stateVersion', 'you']);
    expect(JSON.stringify(seen.performer).includes('Hauptst')).toBe(false);
    expect(seen.mine.you).toMatchObject({ canBid: true, canPass: true });
    expect(seen.next).toMatchObject({ leader: { teamId: 'T3', units: 8 }, stepCount: 3, version: before.version + 1 }); // continued from the stored stand
    // the child computed in memory only: the stored state is untouched, and the parent continuing from it reaches the same state
    expect(await load(roomId)).toEqual(stored);
    const holder = holderOf(stored);
    const mine = placeBid(before, {
      ...biddingActionArgsFromIntent(readBiddingBidIntent({ ...bindingOf(stored), value: num(8) })), sequence: seqOf(stored), caller: { role: 'PLAYER', participantId: holder.playerId, teamId: holder.teamId as string },
      gate: OPEN, eligibility: eligibility(), nowMs: 5000, value: num(8),
    });
    expect(seen.next).toEqual(mine.state);
    expect(seen.nextSequence).toEqual(mine.sequence);
  });
});
