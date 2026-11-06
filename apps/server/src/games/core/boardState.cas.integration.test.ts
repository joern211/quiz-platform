// ============================================================
// N11 — bounded integration proof for figure moves on the EXISTING persistence stack
//
// What is REAL here: a SQLite file created from the real migrations, the real shared CAS primitive `saveGameStateIfRevision` on the real `RoomGameState`
// row (revision column), the real state-event path (`materializeGameEvent` → `GameDomainEvent` rows), the real command receipts (`runReceipted`, table
// `CommandReceipt`), the real single-connection SQLite URL of the server, and a second operating-system process that reads the stored state.
// (`saveGameStateIfRevision` writes its event only together with `persistRoundResult`, which needs one of three registered engine slugs; the stand-in
// therefore calls `materializeGameEvent` — the very function the primitive uses — in the SAME transaction right before the CAS write, as N9/N10 do.)
// What is NOT real: there is NO game engine. The state row holds a stand-in JSON blob `{ phase, standIn, turnSequence, dice, board }` that only this test
// writes; the "handler" below is a test-only stand-in for a future engine handler (load → pure domain calls → ONE commit). No route, no socket, no engine
// contract, no admission/session check (caller and gate are table entries here), no setup snapshot. The geometry is an EXPLICIT TEST GEOMETRY.
// Every claim is read back from the database; a function called twice in JavaScript would prove nothing.
//
// The roll is spent by the board state itself, so board change, roll consumption and the N8 basis step are ONE JSON blob in ONE CAS commit with ONE state event.
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
import { createTestDatabase } from '../../test-helpers.js';
import { singleConnectionSqliteUrl } from '../../persistence/sqliteUrl.js';
import { runReceipted } from './commands.js';
import { materializeGameEvent } from './events.js';
import { gameErrorCode } from './errors.js';
import { GameStateConflictError, saveGameStateIfRevision } from './state.js';
import { boardActionArgsFromIntent, moveFigure, parseBoardState, prepareBoard, projectBoard, readBoardMoveIntent, type BoardPolicy, type BoardState } from './boardState.js';
import { closeDiceTurn, diceTurnScopeOf, openDiceTurn, parseDiceTurnState, rollDice, type DiceTurnState } from './diceTurn.js';
import {
  advanceTurnSequence, currentTurnHolder, parseTurnSequenceState, prepareTurnSequence, refreshEligibilityBasis, startTurnSequence, turnSequenceScopeOf, type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';
import { DICE_CONFIG_SINGLE_D6 } from '@quiz/shared/dice';
import { type BoardGeometry, type BoardMoveIntent } from '@quiz/shared/board';

const run = promisify(execFile);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SLUG = 'n11-stand-in';
/** A STAND-IN action name: `CRITICAL_COMMAND_ACTIONS` is a closed whitelist and N11 introduces no new command kind. The real consumer adds its own board action there. */
const STAND_IN_ACTION = 'ROUND_ADVANCE' as const;
const PLAYERS = ['a', 'b', 'c'];
const ALLOW: BoardPolicy = { capture: 'ALLOWED' };
let db: PrismaClient, dir: string, url: string, previousGlobal: PrismaClient | undefined, sequence = 0, hostId: string, definitionId: string;

// EXPLICIT TEST GEOMETRY (not a platform default): a: sa t1 t2 t3 t4 ha — b: sb t3 t4 t5 t6 hb
const GEOMETRY: BoardGeometry = {
  fields: [
    { id: 'sa', capacity: 2 }, { id: 'sb', capacity: 2 }, { id: 't1', capacity: 1 }, { id: 't2', capacity: 1 }, { id: 't3', capacity: 1 }, { id: 't4', capacity: 1 },
    { id: 't5', capacity: 1 }, { id: 't6', capacity: 1 }, { id: 'ha', capacity: 2 }, { id: 'hb', capacity: 2 },
  ],
  routes: [{ ownerId: 'a', route: ['sa', 't1', 't2', 't3', 't4', 'ha'] }, { ownerId: 'b', route: ['sb', 't3', 't4', 't5', 't6', 'hb'] }],
};
const FIGURES = [{ id: 'a1', ownerId: 'a' }, { id: 'a2', ownerId: 'a' }, { id: 'b1', ownerId: 'b' }, { id: 'b2', ownerId: 'b' }];

const level = (ids: string[], version: number, runIndex = 1) => ({ runIndex, trackId: 'players-track', rosterRevision: 'track-roster-1', version, knownIds: ids, activeIds: ids });
const eligibility = (version = 1, runIndex = 1): TurnEligibility => ({ actors: level(PLAYERS, version, runIndex), members: null });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-n11-cas-'));
  url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: singleConnectionSqliteUrl(url) }); // the same single connection the server uses
  await db.$connect();
  previousGlobal = (globalThis as { __prisma?: PrismaClient }).__prisma;
  (globalThis as { __prisma?: PrismaClient }).__prisma = db;
  hostId = (await db.user.create({ data: { displayName: 'N11 host', role: 'HOST', passwordHash: 'unused' } })).id;
  definitionId = (await db.gameDefinition.create({ data: { slug: SLUG, name: 'n11 stand-in', category: 'test', status: 'BETA', minPlayers: 2 } })).id;
});
afterAll(async () => {
  (globalThis as { __prisma?: PrismaClient }).__prisma = previousGlobal;
  await db?.$disconnect();
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface StandInState { phase: string; standIn: boolean; turnSequence: unknown; dice: unknown; board: unknown }
interface Stored { revision: number; phase: string; state: StandInState }
interface WorldOver { runIndex?: number; sequenceId?: string; rosterRevision?: string; diceId?: string; boardId?: string; face?: number; maxRolls?: number }

/** A started player sequence (a, b, c; turn 1 = a), a dice process of that turn ROLLED with `face`, and a fresh board. Every world has the SAME counters. */
function buildWorld(over: WorldOver = {}): { seq: TurnSequenceState; dice: DiceTurnState; board: BoardState } {
  const runIndex = over.runIndex ?? 1;
  const prepared = prepareTurnSequence({ runIndex, sequenceId: over.sequenceId ?? 'seq-n11', rosterRevision: over.rosterRevision ?? 'roster-1', unit: 'PLAYER', mode: 'FIXED', order: PLAYERS });
  const seq = startTurnSequence(prepared, { scope: turnSequenceScopeOf(prepared), expectedVersion: 0, eligibility: eligibility(1, runIndex) }).state;
  const opened = openDiceTurn({ scope: turnSequenceScopeOf(seq), diceId: over.diceId ?? 'dice-t1', config: over.maxRolls === undefined ? DICE_CONFIG_SINGLE_D6 : { ...DICE_CONFIG_SINGLE_D6, maxRolls: over.maxRolls }, sequence: seq, expectedTurnNumber: 1 });
  const dice = rollDice(opened, {
    scope: turnSequenceScopeOf(seq), diceId: opened.diceId, sequence: seq, expectedTurnNumber: 1, expectedSequenceVersion: seq.version, expectedVersion: 0, expectedRollCount: 0,
    caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: OPEN, eligibility: eligibility(1, runIndex), source: () => over.face ?? 3,
  }).state;
  const board = prepareBoard({ scope: turnSequenceScopeOf(seq), boardId: over.boardId ?? 'board-n11', geometry: GEOMETRY, figures: FIGURES, sequence: seq });
  return { seq, dice, board };
}
const OPEN = { admitted: true, phaseOpen: true, paused: false };

async function fixture(over: WorldOver = {}, at: Record<string, string> = {}): Promise<{ roomId: string }> {
  const code = String(950000 + sequence++).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'N11 stand-in', hostUserId: hostId, gameDefinitionId: definitionId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE', viewerRequiresPin: false } });
  const { seq, dice, board } = buildWorld(over);
  const placed = parseBoardState({ ...board, figures: board.figures.map(f => ({ ...f, at: at[f.id] ?? f.at })) });
  await db.roomGameState.create({ data: { roomId: room.id, engineVersion: 1, phase: 'ROUND_ACTIVE', revision: 4, stateJson: JSON.stringify({ phase: 'ROUND_ACTIVE', standIn: true, turnSequence: seq, dice, board: placed }) } });
  return { roomId: room.id };
}
async function load(roomId: string): Promise<Stored> {
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } });
  return { revision: row.revision, phase: row.phase, state: JSON.parse(row.stateJson) as StandInState };
}
/** The stand-in's commit: ONE transaction with the state event (real SDK path) and the shared CAS write on the revision that was LOADED. No own pre-check. */
async function persist(roomId: string, loaded: Stored, state: StandInState, type: string, crashBeforeCas = false): Promise<void> {
  await db.$transaction(async tx => {
    const before = await tx.roomGameState.findUniqueOrThrow({ where: { roomId } });
    await materializeGameEvent(tx, { roomId, gameSlug: SLUG, engineVersion: before.engineVersion, before, nextState: state, type });
    if (crashBeforeCas) throw new Error('CRASH_BEFORE_COMMIT');
    await saveGameStateIfRevision(tx, { roomId, expectedRevision: loaded.revision, phase: loaded.phase, state });
  });
}
const seqOf = (s: Stored) => parseTurnSequenceState(s.state.turnSequence);
const diceOf = (s: Stored) => parseDiceTurnState(s.state.dice);
const boardOf = (s: Stored) => parseBoardState(s.state.board);
const positions = (state: BoardState) => Object.fromEntries(state.figures.map(f => [f.id, f.at]));
const caller = (participantId: string) => ({ role: 'PLAYER' as const, participantId, teamId: null });

/** The ORIGIN of an intent as the client was shown it, built from the stored state of ITS time — never from "now" at delivery. */
const intentOf = (s: Stored, figureId: string, to: string, over: Record<string, unknown> = {}): BoardMoveIntent => ({
  scope: turnSequenceScopeOf(seqOf(s)), boardId: boardOf(s).boardId, turnNumber: seqOf(s).turnNumber, sequenceVersion: seqOf(s).version, boardVersion: boardOf(s).version,
  diceId: diceOf(s).diceId, diceVersion: diceOf(s).version, rollCount: diceOf(s).rollCount, figureId, to, ...over,
}) as BoardMoveIntent;

/**
 * TEST-ONLY stand-in for an engine handler's last steps: parse the stored state, validate the intent at the server boundary, call the pure domain (N8
 * authorisation first), persist what N8-02 demands in the SAME commit, then ONE commit (event + CAS on the REVISION THAT WAS LOADED). No retry: a lost CAS is the answer.
 */
async function handle(loaded: Stored, roomId: string, who: string, intent: unknown, over: { stand?: TurnEligibility; crashBeforeCas?: boolean; policy?: BoardPolicy } = {}) {
  const seq = seqOf(loaded), dice = diceOf(loaded), board = boardOf(loaded);
  const trusted = over.stand ?? eligibility(1, seq.runIndex);
  const parsed = readBoardMoveIntent(intent);
  // the ORIGIN comes from the INTENT; only the trusted facts come from the loaded state and the server session
  const result = moveFigure(board, { ...boardActionArgsFromIntent(parsed), sequence: seq, dice, caller: caller(who), gate: OPEN, eligibility: trusted, policy: over.policy ?? ALLOW });
  const nextSeq = result.sequenceBasisAdvanced ? refreshEligibilityBasis(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, eligibility: trusted }).state : seq;
  await persist(roomId, loaded, { ...loaded.state, turnSequence: nextSeq, board: result.state }, 'BOARD_MOVED', over.crashBeforeCas === true);
  return { version: result.state.version, positions: positions(result.state), captured: result.transition.captured };
}
/** The consumer's turn change: ONE commit with the N8 transition, the close of the old dice process, the opening of the new one; the board is untouched. */
async function endTurn(loaded: Stored, roomId: string, face: number) {
  const seq = seqOf(loaded), dice = diceOf(loaded);
  const next = advanceTurnSequence(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: eligibility() }).state;
  closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version });
  const holder = currentTurnHolder(next)!;
  const opened = openDiceTurn({ scope: turnSequenceScopeOf(next), diceId: `dice-t${next.turnNumber}`, config: DICE_CONFIG_SINGLE_D6, sequence: next, expectedTurnNumber: next.turnNumber });
  const rolled = rollDice(opened, {
    scope: turnSequenceScopeOf(next), diceId: opened.diceId, sequence: next, expectedTurnNumber: next.turnNumber, expectedSequenceVersion: next.version, expectedVersion: 0, expectedRollCount: 0,
    caller: caller(holder.playerId), gate: OPEN, eligibility: eligibility(), source: () => face,
  }).state;
  await persist(roomId, loaded, { ...loaded.state, turnSequence: next, dice: rolled }, 'TURN_CHANGED');
}

type Settled = PromiseSettledResult<unknown>;
const outcome = (result: Settled): string => (result.status === 'fulfilled' ? 'OK' : String((result.reason as Error).message ?? result.reason));
const ok = (results: Settled[]) => results.filter(r => r.status === 'fulfilled').length;
const sendReceipted = (roomId: string, commandId: string, intent: unknown, run: () => Promise<unknown>, onEffect?: () => void) => runReceipted(db, {
  roomId, commandId, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: STAND_IN_ACTION, payload: { kind: 'BOARD_MOVE', intent },
  mutate: async () => { onEffect?.(); return run() as Promise<{ version: number }>; }, toResponse: data => ({ success: true, ...(data as object) }),
});

describe('N11 integration: figure moves on the real CAS / receipt / state-event stack (SQLite)', () => {
  it('a move, read back from the database: board, spent roll, revision and ONE event move exactly once; dice and sequence are untouched; the stored events replay to the stored state', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    const result = await handle(stored0, roomId, 'a', intentOf(stored0, 'a1', 't3'));
    expect(result).toMatchObject({ version: 1, captured: [] });
    const stored = await load(roomId);
    expect(stored.revision).toBe(5);
    expect(positions(boardOf(stored))).toEqual({ a1: 't3', a2: 'sa', b1: 'sb', b2: 'sb' });
    expect(boardOf(stored).lastMove).toMatchObject({ figureId: 'a1', diceId: 'dice-t1', rollCount: 1, steps: 3 });
    expect(diceOf(stored)).toEqual(diceOf(stored0)); // the dice state was not touched: the roll is spent INSIDE the board state
    expect(seqOf(stored)).toEqual(seqOf(stored0));
    const room = await db.room.findUniqueOrThrow({ where: { id: roomId } });
    const rows = await db.gameDomainEvent.findMany({ where: { roomId }, orderBy: { stateVersion: 'asc' } });
    expect(rows.map(r => r.type)).toEqual(['BOARD_MOVED']);
    const start: EngineStateSnapshot = { roomId, runIndex: room.runIndex, gameSlug: SLUG, engineVersion: 1, stateVersion: 4, state: {} };
    const rebuilt = rows.reduce<EngineStateSnapshot>((snapshot, row) => applyStateEvent(snapshot, JSON.parse(row.payloadJson)), start);
    expect(rebuilt.stateVersion).toBe(5);
    expect(rebuilt.state).toEqual(stored.state);
  });

  it('a capture is ONE persisted state change: mover on the target, victim back on its start, spent roll, one revision step, one event', async () => {
    const { roomId } = await fixture({}, { b1: 't3' });
    const stored0 = await load(roomId);
    const result = await handle(stored0, roomId, 'a', intentOf(stored0, 'a1', 't3'));
    expect(result.captured).toEqual(['b1']);
    const stored = await load(roomId);
    expect(positions(boardOf(stored))).toEqual({ a1: 't3', a2: 'sa', b1: 'sb', b2: 'sb' });
    expect(boardOf(stored).lastMove).toMatchObject({ captured: ['b1'] });
    expect([stored.revision, await db.gameDomainEvent.count({ where: { roomId } })]).toEqual([5, 1]);
  });

  it('the SAME roll cannot move a second figure: refused from the database state, no event, no revision step; a refused move does not spend the roll', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    // a refused move first (illegal target): the roll stays usable
    await expect(handle(stored, roomId, 'a', intentOf(stored, 'a1', 't4'))).rejects.toThrow('BOARD_TARGET_ILLEGAL');
    expect(await load(roomId)).toEqual(stored);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(0);
    await handle(stored, roomId, 'a', intentOf(stored, 'a1', 't3'));
    stored = await load(roomId);
    const eventsBefore = await db.gameDomainEvent.count({ where: { roomId } });
    await expect(handle(stored, roomId, 'a', intentOf(stored, 'a2', 't3'))).rejects.toThrow('BOARD_ROLL_SPENT'); // bound to the NEW board version: only the spent roll can refuse it
    expect(await load(roomId)).toEqual(stored);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(eventsBefore);
  });

  it('two DIFFERENT target intents from the same revision: the CAS lets at most one through; exactly one figure moved, one event, never both', async () => {
    for (let round = 0; round < 3; round++) {
      const { roomId } = await fixture();
      const [l1, l2] = await Promise.all([load(roomId), load(roomId)]);
      const results = await Promise.allSettled([handle(l1, roomId, 'a', intentOf(l1, 'a1', 't3')), handle(l2, roomId, 'a', intentOf(l2, 'a2', 't3'))]);
      expect(ok(results), results.map(outcome).join(' | ')).toBe(1);
      expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(GameStateConflictError);
      const stored = await load(roomId);
      expect(stored.revision).toBe(5);
      expect(boardOf(stored).version).toBe(1);
      expect(Object.values(positions(boardOf(stored))).filter(at => at === 't3')).toHaveLength(1); // one figure moved, not both
      expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(1); // the loser's event went down with its transaction
    }
  });

  it('the same commandId with the identical intent, sent in parallel and again after the confirmation was lost: ONE move, the stored answer is replayed, the body does not run again', async () => {
    const { roomId } = await fixture();
    const commandId = `cmd-${randomUUID()}`;
    const stored0 = await load(roomId);
    const intent = intentOf(stored0, 'a1', 't3');
    let effects = 0;
    const send = () => sendReceipted(roomId, commandId, intent, async () => handle(await load(roomId), roomId, 'a', intent), () => { effects++; });
    const parallel = await Promise.all([send(), send()]);
    expect(effects).toBe(1);
    expect(parallel.filter(r => r.replayed)).toHaveLength(1);
    const afterFirst = await load(roomId);
    expect(boardOf(afterFirst).version).toBe(1);
    expect(await send()).toMatchObject({ success: true, replayed: true }); // the answer was "lost": same intent, same commandId
    expect(effects).toBe(1);
    expect(await load(roomId)).toEqual(afterFirst);
    const receipts = await db.commandReceipt.findMany({ where: { roomId, commandId } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('COMPLETED');
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(1);
  });

  it('the same commandId with a CHANGED content (other figure, other target, other origin part) is a conflict, never a replay of the first answer', async () => {
    const { roomId } = await fixture();
    const commandId = `cmd-${randomUUID()}`;
    const stored0 = await load(roomId);
    const intent = intentOf(stored0, 'a1', 't3');
    const send = (i: BoardMoveIntent) => sendReceipted(roomId, commandId, i, async () => handle(await load(roomId), roomId, 'a', i));
    expect((await send(intent)).success).toBe(true);
    expect(await send(intent)).toMatchObject({ success: true, replayed: true }); // positive control
    const changed: Array<Partial<BoardMoveIntent>> = [
      { figureId: 'a2' }, { to: 't4' }, { boardId: 'board-other' }, { diceId: 'dice-other' }, { boardVersion: 7 }, { diceVersion: 7 }, { rollCount: 2 }, { sequenceVersion: 9 }, { turnNumber: 2 },
      { scope: { ...intent.scope, rosterRevision: 'roster-other' } }, { scope: { ...intent.scope, runIndex: 2 } },
    ];
    for (const part of changed) expect(await send({ ...intent, ...part } as BoardMoveIntent), JSON.stringify(part)).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
    expect(boardOf(await load(roomId)).version).toBe(1);
  });

  it('three different commandIds for the same bound move racing through the receipt path: one stored move; every loser is refused with a known code, never a second move', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    const intent = intentOf(stored0, 'a1', 't3');
    const send = () => sendReceipted(roomId, `cmd-${randomUUID()}`, intent, async () => handle(await load(roomId), roomId, 'a', intent));
    const results = await Promise.allSettled([send(), send(), send()]);
    const description = results.map(r => (r.status === 'fulfilled' ? (r.value.success ? 'OK' : `REFUSED:${r.value.error}`) : `THROWN:${(r.reason as Error).message}`));
    expect(description.filter(d => d === 'OK'), description.join(' | ')).toHaveLength(1);
    for (const d of description.filter(x => x !== 'OK')) expect(d).toMatch(/^(REFUSED:(COMMAND_STATE_ADVANCED|STATE_CONFLICT|REVISION_CONFLICT)|THROWN:(BOARD_VERSION_STALE|BOARD_ROLL_SPENT|Game state revision conflict.*))$/);
    const stored = await load(roomId);
    expect(stored.revision).toBe(5);
    expect(boardOf(stored).version).toBe(1);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(1);
  });

  it('an error BEFORE the commit (inside the transaction, after the event was written) leaves NOTHING behind; the retry with the same commandId then moves exactly once', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    const intent = intentOf(stored0, 'a1', 't3');
    const commandId = `cmd-${randomUUID()}`;
    let crash = true, effects = 0;
    const send = () => sendReceipted(roomId, commandId, intent, async () => handle(await load(roomId), roomId, 'a', intent, { crashBeforeCas: crash }), () => { effects++; });
    await expect(send()).rejects.toThrow('CRASH_BEFORE_COMMIT');
    expect(await load(roomId)).toEqual(stored0); // board, roll, revision
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(0); // the event rolled back with the transaction
    crash = false;
    const retry = await send();
    expect(retry.success).toBe(true);
    const stored = await load(roomId);
    expect(boardOf(stored).version).toBe(1);
    expect(stored.revision).toBe(5);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(1);
    expect(effects).toBe(2); // the failed first body and the successful retry — one stored move
  });

  it('the process dies AFTER the commit but BEFORE the receipt is completed: the retry with the same commandId is told to resync — the body does not run again, nothing moves twice', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    const intent = intentOf(stored0, 'a1', 't3');
    const commandId = `cmd-${randomUUID()}`;
    let effects = 0, crash = true;
    const send = () => runReceipted(db, {
      roomId, commandId, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: STAND_IN_ACTION, payload: { kind: 'BOARD_MOVE', intent },
      mutate: async () => { effects++; return handle(await load(roomId), roomId, 'a', intent); },
      toResponse: data => { if (crash) throw new Error('PROCESS_DIED_BEFORE_THE_RECEIPT'); return { success: true, ...data }; },
    });
    await expect(send()).rejects.toThrow('PROCESS_DIED_BEFORE_THE_RECEIPT');
    const stored = await load(roomId);
    expect(boardOf(stored).version).toBe(1); // the move IS committed, only its receipt is not
    crash = false;
    expect(await send()).toMatchObject({ success: false, error: 'COMMAND_STATE_ADVANCED', resyncRequired: true });
    expect(effects).toBe(1);
    expect(await load(roomId)).toEqual(stored);
    // a client that gave up and built a NEW id for the same OLD intent gets no second move
    await expect(sendReceipted(roomId, `cmd-${randomUUID()}`, intent, async () => handle(await load(roomId), roomId, 'a', intent))).rejects.toThrow('BOARD_VERSION_STALE');
    expect(await load(roomId)).toEqual(stored);
  });

  /** The consumer replaces the room's state by another world (a rematch, a new sequence, a new roster, a new board): ONE commit, a NEW global revision. */
  async function replaceWorld(roomId: string, over: WorldOver): Promise<Stored> {
    const loaded = await load(roomId);
    const world = buildWorld(over);
    await persist(roomId, loaded, { ...loaded.state, turnSequence: world.seq, dice: world.dice, board: world.board }, 'WORLD_REPLACED');
    return load(roomId);
  }
  const TARGET_CASES: Array<[string, WorldOver, RegExp]> = [
    ['another run (same player ids, valid NEW N6 track)', { runIndex: 2 }, /TURN_SEQ_RUN_STALE/],
    ['another sequence of the same run', { sequenceId: 'seq-n11-next' }, /TURN_SEQ_SEQUENCE_STALE/],
    ['another pinned roster revision', { rosterRevision: 'roster-2' }, /TURN_SEQ_ROSTER_STALE/],
    ['another board of the same sequence', { boardId: 'board-other' }, /BOARD_SCOPE_STALE/],
    ['another dice process of the same sequence and turn', { diceId: 'dice-t1-other' }, /BOARD_SCOPE_STALE/],
  ];
  it.each(TARGET_CASES)('a late intent of an OLD target, delivered for the FIRST time (no receipt yet) after %s: refused on the real DB path — no event, no revision step, no stored effect; the fresh intent works', async (name, over, expected) => {
    const { roomId } = await fixture();
    const old = await load(roomId);
    const delayed = intentOf(old, 'a1', 't3'); // prepared against the old target; it did NOT reach the server then
    const current = await replaceWorld(roomId, over); // same player, same roll face, same local counters, a NEW global revision
    const fresh = intentOf(current, 'a1', 't3');
    const counters = (i: BoardMoveIntent) => [i.turnNumber, i.sequenceVersion, i.boardVersion, i.diceVersion, i.rollCount];
    expect(counters(delayed)).toEqual(counters(fresh)); // the precondition of the failure: only the origin differs
    expect(current.revision).toBeGreaterThan(old.revision);
    const eventsBefore = await db.gameDomainEvent.count({ where: { roomId } });
    const commandId = `cmd-${randomUUID()}`;
    await expect(sendReceipted(roomId, commandId, delayed, async () => handle(await load(roomId), roomId, 'a', delayed)), name).rejects.toThrow(expected);
    expect(await load(roomId)).toEqual(current);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(eventsBefore);
    expect((await db.commandReceipt.findUniqueOrThrow({ where: { roomId_commandId: { roomId, commandId } } })).status).not.toBe('COMPLETED');
    expect((await handle(current, roomId, 'a', fresh)).version).toBe(1); // positive control: the fresh intent of the NEW target
  });

  it('turn change, then an OLD roll: the old process and the old intent stay refused although the loaded revision is current; the new turn moves with its own roll; the board kept its figures', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    const turnOne = intentOf(stored, 'a2', 't3');
    await handle(stored, roomId, 'a', intentOf(stored, 'a1', 't3'));
    for (let i = 0; i < 3; i++) await endTurn(await load(roomId), roomId, 1); // a → b → c → a, the board is untouched
    stored = await load(roomId);
    expect(seqOf(stored).turnNumber).toBe(4);
    expect(diceOf(stored)).toMatchObject({ diceId: 'dice-t4', rollCount: 1 });
    expect(positions(boardOf(stored)).a1).toBe('t3');
    const eventsBefore = await db.gameDomainEvent.count({ where: { roomId } });
    await expect(handle(stored, roomId, 'a', turnOne)).rejects.toThrow('TURN_SEQ_VERSION_STALE');
    await expect(handle(stored, roomId, 'a', { ...intentOf(stored, 'a2', 't1'), turnNumber: 1 })).rejects.toThrow('TURN_SEQ_TURN_STALE');
    await expect(handle(stored, roomId, 'a', { ...intentOf(stored, 'a2', 't1'), diceId: 'dice-t1' })).rejects.toThrow('BOARD_SCOPE_STALE');
    expect(await load(roomId)).toEqual(stored);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(eventsBefore);
    await handle(stored, roomId, 'a', intentOf(stored, 'a2', 't1'));
    expect(positions(boardOf(await load(roomId)))).toMatchObject({ a1: 't3', a2: 't1' });
  });

  it('a consumer that moves the N8 turn on but forgets the dice: the stored process of the OLD turn is refused from the database state, also for the SAME player', async () => {
    const { roomId } = await fixture();
    for (let i = 0; i < 3; i++) { // a → b → c → a, the sequence only
      const loaded = await load(roomId);
      const seq = seqOf(loaded);
      const next = advanceTurnSequence(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: eligibility() }).state;
      await persist(roomId, loaded, { ...loaded.state, turnSequence: next }, 'TURN_CHANGED_WITHOUT_DICE');
    }
    const stored = await load(roomId);
    expect(diceOf(stored).binding.turnNumber).toBe(1);
    await expect(handle(stored, roomId, 'a', intentOf(stored, 'a1', 't3'))).rejects.toThrow('BOARD_TURN_STALE');
    expect(await load(roomId)).toEqual(stored);
  });

  it('N8-02: a move that saw a NEWER N6 stand persists the basis in the SAME commit; a BASIS update alone moves no figure, spends no roll and fences the old binding', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    await handle(stored0, roomId, 'a', intentOf(stored0, 'a1', 't3'), { stand: eligibility(7) });
    const stored = await load(roomId);
    expect(stored.revision).toBe(5); // ONE commit carried the move and the basis
    expect(seqOf(stored)).toMatchObject({ turnNumber: 1, version: seqOf(stored0).version + 1, completedTurns: 0 });
    expect(seqOf(stored).eligibility!.actors.version).toBe(7);
    expect(boardOf(stored).version).toBe(1);
    // older stand: fenced
    await expect(handle(stored, roomId, 'a', intentOf(stored, 'a2', 't2'), { stand: eligibility(1) })).rejects.toThrow(/TURN_SEQ_ELIGIBILITY_STALE|BOARD_ROLL_SPENT/);
    // BASIS alone (a second world): no figure moves, the roll stays unspent, the old binding is stale, the new binding moves
    const { roomId: room2 } = await fixture();
    const s0 = await load(room2);
    const oldIntent = intentOf(s0, 'a1', 't3');
    const seq = seqOf(s0);
    const basis = refreshEligibilityBasis(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, eligibility: eligibility(9) });
    await persist(room2, s0, { ...s0.state, turnSequence: basis.state }, 'BASIS');
    const s1 = await load(room2);
    expect(boardOf(s1)).toEqual(boardOf(s0));
    expect(diceOf(s1)).toEqual(diceOf(s0));
    await expect(handle(s1, room2, 'a', oldIntent, { stand: eligibility(9) })).rejects.toThrow('TURN_SEQ_VERSION_STALE');
    expect((await handle(s1, room2, 'a', intentOf(s1, 'a1', 't3'), { stand: eligibility(9) })).version).toBe(1);
  });

  it('rights from the database facts: a foreign figure, a non-holder, a viewer role and a withdrawn participation change nothing', async () => {
    const { roomId } = await fixture();
    const stored = await load(roomId);
    await expect(handle(stored, roomId, 'a', intentOf(stored, 'b1', 't3'))).rejects.toThrow('BOARD_FIGURE_NOT_OWNED');
    await expect(handle(stored, roomId, 'b', intentOf(stored, 'b1', 't3'))).rejects.toThrow('TURN_SEQ_NOT_CURRENT_ACTOR');
    await expect(handle(stored, roomId, 'a', intentOf(stored, 'a1', 't3'), { stand: { actors: { ...level(PLAYERS, 2), activeIds: ['b', 'c'] }, members: null } })).rejects.toThrow('TURN_SEQ_ACTOR_NOT_ELIGIBLE');
    expect(await load(roomId)).toEqual(stored);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(0);
  });

  it('a damaged stored board is refused as a whole through the existing code path (no repair, no move, no event); the public error code is the whitelisted one', async () => {
    const { roomId } = await fixture();
    const stored = await load(roomId);
    const damaged = { ...stored.state, board: { ...(stored.state.board as object), figures: [{ id: 'a1', ownerId: 'a', at: 't6' }, ...(stored.state.board as { figures: unknown[] }).figures.slice(1)] } };
    await db.roomGameState.update({ where: { roomId }, data: { stateJson: JSON.stringify(damaged) } });
    const loaded = await load(roomId);
    let error: unknown;
    try { await handle(loaded, roomId, 'a', intentOf(stored, 'a1', 't3')); } catch (caught) { error = caught; }
    expect((error as Error).message).toBe('BOARD_STATE_INVALID');
    expect(gameErrorCode(error)).toBe('BOARD_STATE_INVALID'); // the existing wire-code whitelist, not INTERNAL_ERROR
    expect(gameErrorCode(new Error('SOMETHING_ELSE'))).toBe('INTERNAL_ERROR');
    expect(await load(roomId)).toEqual(loaded);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(0);
  });

  // ── N11-01 (independent review PR #41): a contradictory persisted last move must not survive recovery ────────────────────────────────────────────────
  /** Writes a damaged board into the stored row (a damaged snapshot) and returns what was read back. */
  async function damage(roomId: string, patch: (board: BoardState) => unknown): Promise<Stored> {
    const committed = await load(roomId);
    await db.roomGameState.update({ where: { roomId }, data: { stateJson: JSON.stringify({ ...committed.state, board: patch(boardOf(committed)) }) } });
    return load(roomId);
  }
  const snapshot = async (roomId: string) => ({ stored: await load(roomId), events: await db.gameDomainEvent.count({ where: { roomId } }), receipts: await db.commandReceipt.findMany({ where: { roomId }, select: { commandId: true, status: true } }) });

  it.each([
    ['a consumed-roll marker for a roll the stored process has not made yet', (b: BoardState) => ({ ...b, lastMove: { ...b.lastMove!, rollCount: 2 } })],
    ['a last move from a turn the stored sequence has not reached', (b: BoardState) => ({ ...b, lastMove: { ...b.lastMove!, turnNumber: 2 } })],
    ['a last move whose steps contradict the route distance', (b: BoardState) => ({ ...b, lastMove: { ...b.lastMove!, steps: 2 } })],
  ])('SQLite: %s is refused after reloading — no second move, no revision step, no event, no receipt success; projection and recovery refuse it too', async (_name, corrupt) => {
    const { roomId } = await fixture({ face: 1 });
    const initial = await load(roomId);
    await handle(initial, roomId, 'a', intentOf(initial, 'a1', 't1'));
    const committed = await load(roomId);
    expect(committed.revision).toBe(5);
    await damage(roomId, corrupt); // ONLY the board's last move is changed; N8 and N9 stay as committed
    const before = await snapshot(roomId);
    const commandId = `cmd-${randomUUID()}`;
    const intent = intentOf(committed, 'a1', 't2'); // what the client was shown BEFORE the damage (a locally damaged board cannot even be parsed to build it)
    let failure: unknown = null;
    try { await sendReceipted(roomId, commandId, intent, async () => handle(await load(roomId), roomId, 'a', intent)); } catch (error) { failure = error; }
    expect((failure as Error | null)?.message).toBe('BOARD_STATE_INVALID');
    expect(gameErrorCode(failure)).toBe('BOARD_STATE_INVALID'); // the existing recovery / wire-code path, not INTERNAL_ERROR
    const after = await snapshot(roomId);
    expect(after.stored).toEqual(before.stored); // revision, positions (a1 still on t1), the stored roll, the sequence: bit for bit
    expect((after.stored.state.board as { figures: Array<{ id: string; at: string }> }).figures.find(f => f.id === 'a1')?.at).toBe('t1'); // raw rows: a locally damaged board is not parseable by design
    expect(diceOf(after.stored).rollCount).toBe(1);
    expect(after.events).toBe(before.events);
    expect(after.receipts.filter(r => r.status === 'COMPLETED')).toHaveLength(before.receipts.filter(r => r.status === 'COMPLETED').length); // the refused command never became a success
    expect((await db.commandReceipt.findUnique({ where: { roomId_commandId: { roomId, commandId } } }))?.status).not.toBe('COMPLETED');
    // the recovery / projection path refuses the same combination before anything is shown or sent
    for (const release of ['FIGURES', 'NONE'] as const) {
      expect(() => projectBoard(caller('a'), boardOf(after.stored), { scope: turnSequenceScopeOf(seqOf(after.stored)), sequence: seqOf(after.stored), dice: diceOf(after.stored), policy: ALLOW, release, stateVersion: after.stored.revision })).toThrow('BOARD_STATE_INVALID');
    }
  });

  it('SQLite positive control: an UNDAMAGED history proceeds — a newer roll of the same process after an older spent one is usable, and the confirmed command stays a receipt replay', async () => {
    const { roomId } = await fixture({ face: 1, maxRolls: 2 });
    const stored0 = await load(roomId);
    const commandId = `cmd-${randomUUID()}`;
    const first = intentOf(stored0, 'a1', 't1');
    let effects = 0;
    const send = () => sendReceipted(roomId, commandId, first, async () => handle(await load(roomId), roomId, 'a', first), () => { effects++; });
    expect((await send()).success).toBe(true);
    const afterFirst = await load(roomId);
    expect(boardOf(afterFirst).lastMove).toMatchObject({ diceId: 'dice-t1', rollCount: 1 });
    // the holder rolls AGAIN inside the same process (the engine decides that this is allowed): a NEW, unspent roll
    const dice = diceOf(afterFirst);
    const seq = seqOf(afterFirst);
    const rolled = rollDice(dice, { scope: turnSequenceScopeOf(seq), diceId: dice.diceId, sequence: seq, expectedTurnNumber: 1, expectedSequenceVersion: seq.version, expectedVersion: dice.version, expectedRollCount: dice.rollCount, caller: caller('a'), gate: OPEN, eligibility: eligibility(), source: () => 2 }).state;
    await persist(roomId, afterFirst, { ...afterFirst.state, dice: rolled }, 'DICE_ROLLED');
    const afterRoll = await load(roomId);
    expect(diceOf(afterRoll)).toMatchObject({ rollCount: 2, diceId: 'dice-t1' });
    expect((await handle(afterRoll, roomId, 'a', intentOf(afterRoll, 'a2', 't2'))).positions).toMatchObject({ a1: 't1', a2: 't2' });
    const done = await load(roomId);
    expect(boardOf(done).lastMove).toMatchObject({ rollCount: 2, figureId: 'a2' });
    // the OLD confirmed command is still a replay of its stored answer — no second move, no new event
    const events = await db.gameDomainEvent.count({ where: { roomId } });
    expect(await send()).toMatchObject({ success: true, replayed: true });
    expect(effects).toBe(1);
    expect(await load(roomId)).toEqual(done);
    expect(await db.gameDomainEvent.count({ where: { roomId } })).toBe(events);
    // the stored history round-trips through JSON and projects for the holder with the roll spent
    expect(parseBoardState(JSON.parse(JSON.stringify(boardOf(done))))).toEqual(boardOf(done));
    expect(projectBoard(caller('a'), boardOf(done), { scope: turnSequenceScopeOf(seqOf(done)), sequence: seqOf(done), dice: diceOf(done), policy: ALLOW, release: 'FIGURES', stateVersion: done.revision })).toMatchObject({ roll: { rollCount: 2, spent: true }, targets: [] });
  });

  it('recovery in a SECOND process: the stored board is read back exactly (no move, no capture, no roll), projects for a viewer and the holder, and the next authorised move continues from it', async () => {
    const { roomId } = await fixture({}, { b1: 't3' });
    const stored0 = await load(roomId);
    await handle(stored0, roomId, 'a', intentOf(stored0, 'a1', 't3')); // a capture, persisted
    const stored = await load(roomId);
    const before = boardOf(stored);
    const script = `
      const { PrismaClient } = require('@prisma/client');
      (async () => {
        const board = await import(${JSON.stringify(join(serverRoot, 'src/games/core/boardState.ts'))});
        const turn = await import(${JSON.stringify(join(serverRoot, 'src/games/core/turnSequence.ts'))});
        const client = new PrismaClient({ datasourceUrl: process.env.CHILD_DB });
        const row = await client.roomGameState.findUniqueOrThrow({ where: { roomId: process.env.CHILD_ROOM } });
        const stored = JSON.parse(row.stateJson);
        const state = board.parseBoardState(stored.board);
        const seq = turn.parseTurnSequenceState(stored.turnSequence);
        const scope = turn.turnSequenceScopeOf(seq);
        const args = { scope, sequence: seq, dice: stored.dice, policy: { capture: 'ALLOWED' }, release: 'FIGURES', stateVersion: row.revision };
        const viewer = board.projectBoard({ role: 'VIEWER' }, state, args);
        const mine = board.projectBoard({ role: 'PLAYER', participantId: 'a', teamId: null }, state, args);
        console.log(JSON.stringify({ revision: row.revision, state, viewer, mine }));
        await client.$disconnect();
      })().catch(error => { console.error(error); process.exit(1); });
    `;
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '-e', script], { cwd: serverRoot, env: { ...process.env, CHILD_DB: singleConnectionSqliteUrl(url), CHILD_ROOM: roomId }, timeout: 60000 });
    const seen = JSON.parse(stdout.trim().split('\n').pop()!) as { revision: number; state: unknown; viewer: { figures: unknown[]; you: unknown; targets: unknown[]; roll: { spent: boolean } }; mine: { you: unknown; targets: unknown[]; roll: { spent: boolean } } };
    expect(seen.revision).toBe(5);
    expect(seen.state).toEqual(before); // identical figures, last move, counters
    expect(seen.viewer).toMatchObject({ you: null, targets: [], roll: { spent: true } });
    expect(seen.mine).toMatchObject({ targets: [], roll: { spent: true } }); // the roll is spent: no target is offered even to the holder
    // the parent's own projection and a continued turn are consistent with what the child read
    expect(await load(roomId)).toEqual(stored);
    await endTurn(stored, roomId, 2);
    await endTurn(await load(roomId), roomId, 2);
    await endTurn(await load(roomId), roomId, 1);
    const later = await load(roomId);
    const fresh = intentOf(later, 'a2', 't1');
    expect((await handle(later, roomId, 'a', fresh)).positions).toMatchObject({ a1: 't3', a2: 't1', b1: 'sb' });
    const holderView = projectBoard(caller('a'), boardOf(await load(roomId)), { scope: turnSequenceScopeOf(seqOf(later)), sequence: seqOf(later), dice: diceOf(later), policy: ALLOW, release: 'FIGURES', stateVersion: 9 });
    expect(holderView.release).toBe('FIGURES');
  });
});
