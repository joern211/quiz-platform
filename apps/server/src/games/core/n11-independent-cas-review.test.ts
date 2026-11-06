// INDEPENDENT REVIEW PROBE (PR #41, 06.11.2026), adopted as a regression test. Test body and expectations are the reviewer's, unchanged; only unused imports/helpers copied from
// boardState.cas.integration.test.ts and the console.log were removed so that `pnpm lint` stays at 0 errors. The header below is the original text of the copied stand-in.
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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../test-helpers.js';
import { singleConnectionSqliteUrl } from '../../persistence/sqliteUrl.js';
import { materializeGameEvent } from './events.js';
import { saveGameStateIfRevision } from './state.js';
import { boardActionArgsFromIntent, moveFigure, parseBoardState, prepareBoard, readBoardMoveIntent, type BoardPolicy, type BoardState } from './boardState.js';
import { openDiceTurn, parseDiceTurnState, rollDice, type DiceTurnState } from './diceTurn.js';
import {
  parseTurnSequenceState, prepareTurnSequence, refreshEligibilityBasis, startTurnSequence, turnSequenceScopeOf, type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';
import { DICE_CONFIG_SINGLE_D6 } from '@quiz/shared/dice';
import { type BoardGeometry, type BoardMoveIntent } from '@quiz/shared/board';

const SLUG = 'n11-stand-in';
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
interface WorldOver { runIndex?: number; sequenceId?: string; rosterRevision?: string; diceId?: string; boardId?: string; face?: number }

/** A started player sequence (a, b, c; turn 1 = a), a dice process of that turn ROLLED with `face`, and a fresh board. Every world has the SAME counters. */
function buildWorld(over: WorldOver = {}): { seq: TurnSequenceState; dice: DiceTurnState; board: BoardState } {
  const runIndex = over.runIndex ?? 1;
  const prepared = prepareTurnSequence({ runIndex, sequenceId: over.sequenceId ?? 'seq-n11', rosterRevision: over.rosterRevision ?? 'roster-1', unit: 'PLAYER', mode: 'FIXED', order: PLAYERS });
  const seq = startTurnSequence(prepared, { scope: turnSequenceScopeOf(prepared), expectedVersion: 0, eligibility: eligibility(1, runIndex) }).state;
  const opened = openDiceTurn({ scope: turnSequenceScopeOf(seq), diceId: over.diceId ?? 'dice-t1', config: DICE_CONFIG_SINGLE_D6, sequence: seq, expectedTurnNumber: 1 });
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
describe('independent N11 persisted corruption probe', () => {
  it('a corrupted consumed-roll marker must stop the next move after reloading SQLite', async () => {
    const { roomId } = await fixture({ face: 1 });
    const initial = await load(roomId);
    await handle(initial, roomId, 'a', intentOf(initial, 'a1', 't1'));
    const committed = await load(roomId);
    const damagedBoard = { ...boardOf(committed), lastMove: { ...boardOf(committed).lastMove!, rollCount: 2 } };
    await db.roomGameState.update({ where: { roomId }, data: { stateJson: JSON.stringify({ ...committed.state, board: damagedBoard }) } });
    const recovered = await load(roomId);
    let failure: unknown = null;
    try { await handle(recovered, roomId, 'a', intentOf(recovered, 'a1', 't2')); } catch (error) { failure = error; }
    const after = await load(roomId);
    // (the reviewer's probe printed {revisionBefore, revisionAfter, positionAfter, persistedRollCount} here; the assertions below carry the same facts)
    expect(failure).toBeInstanceOf(Error);
    expect(after.revision).toBe(committed.revision);
    expect(positions(boardOf(after)).a1).toBe('t1');
  });
});
