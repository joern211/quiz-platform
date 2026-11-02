// ============================================================
// N8 — bounded integration proof for concurrent turn changes on the EXISTING persistence stack
//
// What is REAL here: a SQLite file created from the real migrations, the real shared CAS primitive `saveGameStateIfRevision` on the real
// `RoomGameState` row (revision column), the real command receipts (`runReceipted`, table `CommandReceipt`), the real single-connection
// SQLite URL of the server, and a second operating-system process that reads the stored state back.
// What is NOT real: there is NO game engine. The state row holds a stand-in JSON blob `{ phase, turnSequence }` that only this test
// writes; the "handler" below is a test-only stand-in for a future engine handler (load → pure domain call → CAS write). No route, no
// socket, no engine contract, no event table (`gameSlug` is not passed, so no GameDomainEvent is materialised). A function called twice
// in JavaScript would prove nothing; every concurrency claim below goes through the database.
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
import { createTestDatabase } from '../../test-helpers.js';
import { singleConnectionSqliteUrl } from '../../persistence/sqliteUrl.js';
import { runReceipted } from './commands.js';
import { GameStateConflictError, saveGameStateIfRevision } from './state.js';
import {
  advanceTurn, currentTurnHolder, parseTurnSequenceState, prepareTurnSequence, startTurnSequence, turnSequenceScopeOf, type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';

const run = promisify(execFile);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let db: PrismaClient, dir: string, url: string, previousGlobal: PrismaClient | undefined, sequence = 0, hostId: string, definitionId: string;

const TEAMS = [{ teamId: 'T1', members: ['A', 'B'] }, { teamId: 'T2', members: ['C', 'D', 'E'] }];
const level = (ids: string[], trackId: string) => ({ trackId, rosterRevision: 'track-roster-1', version: 1, activeIds: ids });
const everyone: TurnEligibility = { actors: level(['T1', 'T2'], 'teams-track'), members: level(['A', 'B', 'C', 'D', 'E'], 'members-track') };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-n8-cas-'));
  url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: singleConnectionSqliteUrl(url) }); // the same single connection the server uses
  await db.$connect();
  previousGlobal = (globalThis as { __prisma?: PrismaClient }).__prisma;
  (globalThis as { __prisma?: PrismaClient }).__prisma = db; // other modules of the stack read the lazily created global
  hostId = (await db.user.create({ data: { displayName: 'N8 host', role: 'HOST', passwordHash: 'unused' } })).id;
  definitionId = (await db.gameDefinition.create({ data: { slug: 'n8-stand-in', name: 'n8 stand-in', category: 'test', status: 'BETA', minPlayers: 2 } })).id;
});
afterAll(async () => {
  (globalThis as { __prisma?: PrismaClient }).__prisma = previousGlobal;
  await db?.$disconnect();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** A fresh room with a stored stand-in state: a started two-team sequence (T1/A, turn 1, version 1). */
async function fixture(): Promise<{ roomId: string; initial: TurnSequenceState }> {
  const code = String(930000 + sequence++).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'N8 stand-in', hostUserId: hostId, gameDefinitionId: definitionId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE', viewerRequiresPin: false } });
  const prepared = prepareTurnSequence({ runIndex: 1, sequenceId: 'seq-n8', rosterRevision: 'roster-1', unit: 'TEAM', mode: 'FIXED', order: ['T1', 'T2'], teams: TEAMS });
  const initial = startTurnSequence(prepared, { scope: turnSequenceScopeOf(prepared), expectedVersion: 0, eligibility: everyone }).state;
  await db.roomGameState.create({ data: { roomId: room.id, engineVersion: 1, phase: 'ROUND_ACTIVE', revision: 4, stateJson: JSON.stringify({ phase: 'ROUND_ACTIVE', standIn: true, turnSequence: initial }) } });
  return { roomId: room.id, initial };
}
interface Stored { revision: number; phase: string; state: { phase: string; standIn: boolean; turnSequence: unknown } }
async function load(roomId: string): Promise<Stored> {
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } });
  return { revision: row.revision, phase: row.phase, state: JSON.parse(row.stateJson) as Stored['state'] };
}
const sequenceOf = (stored: Stored) => parseTurnSequenceState(stored.state.turnSequence);

/** The client's intent: the turn and sequence version it saw. Both come from the CLIENT's last snapshot, never from the stored state. */
interface Intent { expectedVersion: number; expectedTurnNumber: number; outcome: 'COMPLETE' | 'SKIP' }
/** TEST-ONLY stand-in for an engine handler's last two steps: the pure domain call on the loaded state, then the shared CAS write on the loaded revision. */
async function commit(loaded: Stored, roomId: string, intent: Intent): Promise<{ turnNumber: number; version: number }> {
  const current = sequenceOf(loaded);
  const change = advanceTurn(current, { scope: turnSequenceScopeOf(current), ...intent, eligibility: everyone });
  await db.$transaction(tx => saveGameStateIfRevision(tx, { roomId, expectedRevision: loaded.revision, phase: loaded.phase, state: { ...loaded.state, turnSequence: change.state } }));
  return { turnNumber: change.state.turnNumber, version: change.state.version };
}
type Settled = PromiseSettledResult<unknown>;
const outcome = (result: Settled): string => (result.status === 'fulfilled' ? 'OK' : String((result.reason as Error).message ?? result.reason));
const ok = (results: Settled[]) => results.filter(r => r.status === 'fulfilled').length;

describe('N8 integration: concurrent turn changes on the real CAS / receipt stack (SQLite)', () => {
  it('two competing intents loaded from the SAME stored state: the shared CAS lets at most one through; revision, version, turn and cursors move exactly once', async () => {
    for (const [first, second] of [['COMPLETE', 'COMPLETE'], ['COMPLETE', 'SKIP'], ['SKIP', 'COMPLETE']] as const) {
      const { roomId, initial } = await fixture();
      const [l1, l2] = await Promise.all([load(roomId), load(roomId)]); // both see revision 4, version 1, turn 1
      expect(l1.revision).toBe(4); expect(l2.revision).toBe(4);
      const bind = { expectedVersion: initial.version, expectedTurnNumber: initial.turnNumber };
      const results = await Promise.allSettled([commit(l1, roomId, { ...bind, outcome: first }), commit(l2, roomId, { ...bind, outcome: second })]);
      expect(ok(results), `${first}/${second}: ${results.map(outcome).join(' | ')}`).toBe(1);
      const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(GameStateConflictError);
      expect((loser.reason as GameStateConflictError).code).toBe('STATE_CONFLICT');
      // what is PERSISTED, read back from the database
      const stored = await load(roomId);
      const seq = sequenceOf(stored);
      expect(stored.revision).toBe(5); // exactly one CAS step
      expect(seq.version).toBe(initial.version + 1); // exactly one local step
      expect(seq.turnNumber).toBe(initial.turnNumber + 1); // exactly one new turn
      const winner = (results[0].status === 'fulfilled' ? first : second);
      expect(seq.completedTurns).toBe(winner === 'COMPLETE' ? 1 : 0);
      expect(seq.teams!.map(t => t.cursor)).toEqual(winner === 'COMPLETE' ? [1, 0] : [0, 0]); // the inner cursor moved exactly once — or, for a skip, not at all
      expect(currentTurnHolder(seq)).toEqual({ teamId: 'T2', playerId: 'C' });
    }
  });

  it('many parallel intents bound to the same turn and version: exactly one changes the stored state, all others fail with a known conflict code', async () => {
    const { roomId, initial } = await fixture();
    const bind = { expectedVersion: initial.version, expectedTurnNumber: initial.turnNumber, outcome: 'COMPLETE' as const };
    const results = await Promise.allSettled(Array.from({ length: 8 }, async () => commit(await load(roomId), roomId, bind))); // each loads on its own: some see the new state, some the old
    expect(ok(results), results.map(outcome).join(' | ')).toBe(1);
    for (const r of results) if (r.status === 'rejected') expect(['TURN_SEQ_VERSION_STALE', 'Game state revision conflict for room ' + roomId]).toContain((r.reason as Error).message);
    const stored = await load(roomId);
    expect(stored.revision).toBe(5);
    expect(sequenceOf(stored)).toMatchObject({ version: initial.version + 1, turnNumber: initial.turnNumber + 1, completedTurns: 1 });
    expect(sequenceOf(stored).teams!.map(t => t.cursor)).toEqual([1, 0]);
  });

  it('a late intent from an earlier turn of the SAME holder is rejected by the domain even though the CAS revision it read is current', async () => {
    const { roomId, initial } = await fixture();
    // T1/A (turn 1) → T2/C (2) → T1/B (3) → T2/D (4) → T1/A again (5): the same player is current again
    let binding = { expectedVersion: initial.version, expectedTurnNumber: initial.turnNumber };
    for (let i = 0; i < 4; i++) { const done = await commit(await load(roomId), roomId, { ...binding, outcome: 'COMPLETE' }); binding = { expectedVersion: done.version, expectedTurnNumber: done.turnNumber }; }
    const stored = await load(roomId);
    expect(currentTurnHolder(sequenceOf(stored))).toEqual({ teamId: 'T1', playerId: 'A' });
    expect(sequenceOf(stored).turnNumber).toBe(5);
    const stale = { expectedVersion: initial.version, expectedTurnNumber: initial.turnNumber, outcome: 'COMPLETE' as const }; // bound to A's FIRST turn
    await expect(commit(stored, roomId, stale)).rejects.toThrow('TURN_SEQ_VERSION_STALE');
    expect(await load(roomId)).toEqual(stored); // nothing changed, no revision step
  });

  it('receipt: the SAME intent (same commandId) sent in parallel and again after the confirmation produces ONE turn change; the replay changes nothing', async () => {
    const { roomId, initial } = await fixture();
    const commandId = `cmd-${randomUUID()}`;
    const intent: Intent = { expectedVersion: initial.version, expectedTurnNumber: initial.turnNumber, outcome: 'COMPLETE' };
    let effects = 0;
    const send = () => runReceipted(db, {
      roomId, commandId, actor: { actorId: 'host', actorRole: 'HOST' }, action: 'ROUND_ADVANCE', payload: intent,
      mutate: async () => { effects++; return commit(await load(roomId), roomId, intent); },
      toResponse: data => ({ success: true, ...data }),
    });
    const parallel = await Promise.all([send(), send()]);
    expect(effects).toBe(1);
    expect(parallel.filter(r => r.replayed)).toHaveLength(1);
    expect(parallel.every(r => r.success)).toBe(true);
    const afterFirst = await load(roomId);
    expect(afterFirst.revision).toBe(5);
    expect(sequenceOf(afterFirst)).toMatchObject({ turnNumber: 2, version: 2, completedTurns: 1 });
    // the confirmation was "lost": the client sends the SAME intent again with the SAME commandId later
    const again = await send();
    expect(again).toMatchObject({ success: true, replayed: true });
    expect(effects).toBe(1); // the handler body did not run again
    const afterReplay = await load(roomId);
    expect(afterReplay).toEqual(afterFirst); // same revision, same state: no second turn
    const receipts = await db.commandReceipt.findMany({ where: { roomId, commandId } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('COMPLETED');
  });

  it('receipt: a NEW commandId carrying the OLD binding is not a second turn change (the replacement of an id is not a licence); a new binding is', async () => {
    const { roomId, initial } = await fixture();
    const first: Intent = { expectedVersion: initial.version, expectedTurnNumber: initial.turnNumber, outcome: 'COMPLETE' };
    const send = (commandId: string, intent: Intent) => runReceipted(db, {
      roomId, commandId, actor: { actorId: 'host', actorRole: 'HOST' }, action: 'ROUND_ADVANCE', payload: intent,
      mutate: async () => commit(await load(roomId), roomId, intent), toResponse: data => ({ success: true, ...data }),
    });
    expect((await send(`cmd-${randomUUID()}`, first)).success).toBe(true);
    const afterFirst = await load(roomId);
    await expect(send(`cmd-${randomUUID()}`, first)).rejects.toThrow('TURN_SEQ_VERSION_STALE'); // same old binding, brand-new id
    expect(await load(roomId)).toEqual(afterFirst);
    const current = sequenceOf(afterFirst);
    const fresh: Intent = { expectedVersion: current.version, expectedTurnNumber: current.turnNumber, outcome: 'COMPLETE' };
    expect((await send(`cmd-${randomUUID()}`, fresh)).success).toBe(true);
    expect(sequenceOf(await load(roomId))).toMatchObject({ turnNumber: 3, completedTurns: 2 });
  });

  it('receipt: two DIFFERENT commandIds for the same bound turn racing through the receipt path: one effect in the database, the other is refused', async () => {
    const { roomId, initial } = await fixture();
    const intent: Intent = { expectedVersion: initial.version, expectedTurnNumber: initial.turnNumber, outcome: 'COMPLETE' };
    const send = () => runReceipted(db, {
      roomId, commandId: `cmd-${randomUUID()}`, actor: { actorId: 'host', actorRole: 'HOST' }, action: 'ROUND_ADVANCE', payload: intent,
      mutate: async () => commit(await load(roomId), roomId, intent), toResponse: data => ({ success: true, ...data }),
    });
    const results = await Promise.allSettled([send(), send()]);
    const description = results.map(r => (r.status === 'fulfilled' ? (r.value.success ? 'OK' : `REFUSED:${r.value.error}`) : `THROWN:${(r.reason as Error).message}`));
    expect(description.filter(d => d === 'OK'), description.join(' | ')).toHaveLength(1);
    const other = description.find(d => d !== 'OK')!;
    expect(other).toMatch(/^(REFUSED:(COMMAND_STATE_ADVANCED|STATE_CONFLICT|REVISION_CONFLICT)|THROWN:(TURN_SEQ_VERSION_STALE|Game state revision conflict.*))$/);
    const stored = await load(roomId);
    expect(stored.revision).toBe(5);
    expect(sequenceOf(stored)).toMatchObject({ turnNumber: 2, version: 2, completedTurns: 1 });
    expect(sequenceOf(stored).teams!.map(t => t.cursor)).toEqual([1, 0]);
  });

  it('recovery in a SECOND process: the stored state is read back with the same holder, cursors and counters, and the next step continues from them (no re-draw, no reset, no extra step)', async () => {
    const { roomId, initial } = await fixture();
    let binding = { expectedVersion: initial.version, expectedTurnNumber: initial.turnNumber };
    for (let i = 0; i < 3; i++) { const done = await commit(await load(roomId), roomId, { ...binding, outcome: 'COMPLETE' }); binding = { expectedVersion: done.version, expectedTurnNumber: done.turnNumber }; }
    const stored = await load(roomId);
    expect(stored.revision).toBe(7);
    const before = sequenceOf(stored);
    expect(currentTurnHolder(before)).toEqual({ teamId: 'T2', playerId: 'D' });
    // a separate Node process: its own module instances and its own Prisma client; it only READS and computes the next step in memory
    const script = `
      const { PrismaClient } = require('@prisma/client');
      (async () => {
        const { parseTurnSequenceState, advanceTurn, turnSequenceScopeOf, currentTurnHolder } = await import(${JSON.stringify(join(serverRoot, 'src/games/core/turnSequence.ts'))});
        const client = new PrismaClient({ datasourceUrl: process.env.CHILD_DB });
        const row = await client.roomGameState.findUniqueOrThrow({ where: { roomId: process.env.CHILD_ROOM } });
        const state = parseTurnSequenceState(JSON.parse(row.stateJson).turnSequence);
        const level = (ids, trackId) => ({ trackId, rosterRevision: 'track-roster-1', version: 1, activeIds: ids });
        const everyone = { actors: level(['T1', 'T2'], 'teams-track'), members: level(['A', 'B', 'C', 'D', 'E'], 'members-track') };
        const next = advanceTurn(state, { scope: turnSequenceScopeOf(state), expectedVersion: state.version, expectedTurnNumber: state.turnNumber, outcome: 'COMPLETE', eligibility: everyone });
        console.log(JSON.stringify({ revision: row.revision, state, holder: currentTurnHolder(state), nextHolder: currentTurnHolder(next.state), next: next.state }));
        await client.$disconnect();
      })().catch(error => { console.error(error); process.exit(1); });
    `;
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '-e', script], { cwd: serverRoot, env: { ...process.env, CHILD_DB: singleConnectionSqliteUrl(url), CHILD_ROOM: roomId }, timeout: 60000 });
    const seen = JSON.parse(stdout.trim().split('\n').pop()!) as { revision: number; state: unknown; holder: unknown; nextHolder: unknown; next: unknown };
    expect(seen.revision).toBe(7);
    expect(seen.state).toEqual(before); // identical order, holder, cursors, counters
    expect(seen.holder).toEqual({ teamId: 'T2', playerId: 'D' });
    expect(seen.nextHolder).toEqual({ teamId: 'T1', playerId: 'A' }); // T1's cursor was after B → wrapped to A; no reset to the first player, no skipped step
    // the child computed on the stored stand only; the stored state is untouched by it
    expect(await load(roomId)).toEqual(stored);
    // and the parent, continuing from the stored stand, reaches exactly the same next state
    const mine = advanceTurn(before, { scope: turnSequenceScopeOf(before), expectedVersion: before.version, expectedTurnNumber: before.turnNumber, outcome: 'COMPLETE', eligibility: everyone });
    expect(seen.next).toEqual(mine.state);
  });
});
