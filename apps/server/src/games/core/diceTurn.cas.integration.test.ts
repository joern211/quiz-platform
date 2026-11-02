// ============================================================
// N9 — bounded integration proof for dice rolls and holds on the EXISTING persistence stack
//
// What is REAL here: a SQLite file created from the real migrations, the real shared CAS primitive `saveGameStateIfRevision` on the real
// `RoomGameState` row (revision column), the real state-event path of that primitive (`GameDomainEvent` rows written through
// `materializeGameEvent` / game-sdk `createStateEvent`, through `materializeGameEvent`), the real command receipts (`runReceipted`, table
// `CommandReceipt`), the real single-connection SQLite URL of the server, and a second operating-system process that reads the stored state.
// (`saveGameStateIfRevision` itself writes the event only together with `persistRoundResult`, which needs one of the three registered engine slugs
// — `coreLifecyclePhase` throws WRONG_GAME for any other. The stand-in therefore calls `materializeGameEvent`, the very function the primitive
// uses, in the SAME transaction and right before the primitive's CAS write; a lost CAS rolls the event back with it.)
// What is NOT real: there is NO game engine. The state row holds a stand-in JSON blob `{ phase, standIn, turnSequence, dice }` that only this
// test writes; the "handler" below is a test-only stand-in for a future engine handler (load → pure domain calls → CAS write). No route, no
// socket, no engine contract, no admission/session check (the caller and the gate are table entries of this test), no setup snapshot.
// A function called twice in JavaScript would prove nothing; every claim below is read back from the database.
//
// Random draws are COUNTED honestly. A competing, later discarded computation has already drawn: "one applied roll" is NOT "one random
// call globally". What the tests pin down is: one committed result, no redraw to confirm a committed command, no extra chance from retries.
// ============================================================

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { createTestDatabase } from '../../test-helpers.js';
import { singleConnectionSqliteUrl } from '../../persistence/sqliteUrl.js';
import { runReceipted } from './commands.js';
import { materializeGameEvent } from './events.js';
import { GameStateConflictError, saveGameStateIfRevision } from './state.js';
import {
  closeDiceTurn, diceTurnScopeOf, openDiceTurn, parseDiceTurnState, projectDiceTurn, readDiceHoldIntent, readDiceRollIntent, rollDice, setDiceHeld, type DiceIntSource, type DiceTurnState,
} from './diceTurn.js';
import {
  advanceTurnSequence, parseTurnSequenceState, prepareTurnSequence, refreshEligibilityBasis, startTurnSequence, turnSequenceScopeOf, type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';
import { DICE_CONFIG_FIVE_D6_HOLD } from '@quiz/shared/dice';

const run = promisify(execFile);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SLUG = 'n9-stand-in';
const PLAYERS = ['a', 'b', 'c'];
let db: PrismaClient, dir: string, url: string, previousGlobal: PrismaClient | undefined, sequence = 0, hostId: string, definitionId: string;

const level = (ids: string[], version: number) => ({ runIndex: 1, trackId: 'players-track', rosterRevision: 'track-roster-1', version, knownIds: ids, activeIds: ids });
const eligibility = (version = 1): TurnEligibility => ({ actors: level(PLAYERS, version), members: null });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-n9-cas-'));
  url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: singleConnectionSqliteUrl(url) }); // the same single connection the server uses
  await db.$connect();
  previousGlobal = (globalThis as { __prisma?: PrismaClient }).__prisma;
  (globalThis as { __prisma?: PrismaClient }).__prisma = db; // other modules of the stack read the lazily created global
  hostId = (await db.user.create({ data: { displayName: 'N9 host', role: 'HOST', passwordHash: 'unused' } })).id;
  definitionId = (await db.gameDefinition.create({ data: { slug: SLUG, name: 'n9 stand-in', category: 'test', status: 'BETA', minPlayers: 2 } })).id;
});
afterAll(async () => {
  (globalThis as { __prisma?: PrismaClient }).__prisma = previousGlobal;
  await db?.$disconnect();
  if (dir) await rm(dir, { recursive: true, force: true });
});

interface StandInState { phase: string; standIn: boolean; turnSequence: unknown; dice: unknown }
interface Stored { revision: number; phase: string; state: StandInState }

/** A fresh room whose stand-in state holds a started player sequence (a, b, c; turn 1 = a) and a PREPARED five-dice process for that turn. */
async function fixture(): Promise<{ roomId: string; seq: TurnSequenceState; dice: DiceTurnState }> {
  const code = String(940000 + sequence++).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'N9 stand-in', hostUserId: hostId, gameDefinitionId: definitionId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE', viewerRequiresPin: false } });
  const prepared = prepareTurnSequence({ runIndex: 1, sequenceId: 'seq-n9', rosterRevision: 'roster-1', unit: 'PLAYER', mode: 'FIXED', order: PLAYERS });
  const seq = startTurnSequence(prepared, { scope: turnSequenceScopeOf(prepared), expectedVersion: 0, eligibility: eligibility() }).state;
  const dice = openDiceTurn({ scope: turnSequenceScopeOf(seq), diceId: 'dice-t1', config: DICE_CONFIG_FIVE_D6_HOLD, sequence: seq, expectedTurnNumber: seq.turnNumber });
  await db.roomGameState.create({ data: { roomId: room.id, engineVersion: 1, phase: 'ROUND_ACTIVE', revision: 4, stateJson: JSON.stringify({ phase: 'ROUND_ACTIVE', standIn: true, turnSequence: seq, dice }) } });
  return { roomId: room.id, seq, dice };
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
const diceOf = (stored: Stored) => parseDiceTurnState(stored.state.dice);

/** Counts every draw. `values` makes the draw deterministic when a test needs a specific result; without it the REAL crypto source is used. */
function counted(values?: number[]) {
  const state = { draws: 0 };
  let index = 0;
  const source: DiceIntSource = (min, max) => { state.draws++; return values ? values[index++] : randomInt(min, max); };
  return { state, source };
}

/** The client's intent: the four numbers it saw (from ITS last projection — never from the stored state). */
interface Binding { turnNumber: number; sequenceVersion: number; diceVersion: number; rollCount: number }
type Intent = { kind: 'ROLL'; binding: Binding } | { kind: 'HOLD'; binding: Binding; held: number[] };
const bindingOf = (stored: Stored): Binding => ({ turnNumber: seqOf(stored).turnNumber, sequenceVersion: seqOf(stored).version, diceVersion: diceOf(stored).version, rollCount: diceOf(stored).rollCount });
const CALLER = (participantId: string) => ({ role: 'PLAYER' as const, participantId, teamId: null });
const OPEN = { admitted: true, phaseOpen: true, paused: false };

/**
 * TEST-ONLY stand-in for an engine handler's last steps: parse the stored state, validate the client intent at the server boundary, call the pure domain
 * (N8 authorisation first, draw last), persist what N8-02 demands, then the commit (state event + shared CAS write on the REVISION THAT WAS LOADED). There is NO retry here: a lost CAS is the answer.
 */
async function handle(loaded: Stored, roomId: string, who: string, intent: Intent, rng: DiceIntSource, stand: TurnEligibility = eligibility()) {
  const seq = seqOf(loaded), dice = diceOf(loaded);
  const parsed = intent.kind === 'ROLL' ? readDiceRollIntent(intent.binding) : readDiceHoldIntent({ ...intent.binding, held: intent.held });
  const common = {
    scope: turnSequenceScopeOf(seq), diceId: dice.diceId, sequence: seq, expectedTurnNumber: parsed.turnNumber, expectedSequenceVersion: parsed.sequenceVersion,
    expectedVersion: parsed.diceVersion, expectedRollCount: parsed.rollCount, caller: CALLER(who), gate: OPEN, eligibility: stand,
  };
  const result = intent.kind === 'ROLL' ? rollDice(dice, { ...common, source: rng }) : setDiceHeld(dice, { ...common, held: (parsed as { held: number[] }).held });
  // N8-02: a newer N6 stand that the action saw is persisted in the SAME commit (version +1 of the sequence, no new turn)
  const nextSeq = result.sequenceBasisAdvanced ? refreshEligibilityBasis(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, eligibility: stand }).state : seq;
  if (result.changed || nextSeq !== seq) {
    await persist(roomId, loaded, { ...loaded.state, turnSequence: nextSeq, dice: result.state }, 'DICE_CHANGED');
  }
  return { values: result.state.values, rollCount: result.state.rollCount, version: result.state.version, changed: result.changed };
}
/** The consumer's turn change: ONE commit with the N8 transition, the close of the old process and the opening of the new one. */
async function endTurn(loaded: Stored, roomId: string) {
  const seq = seqOf(loaded), dice = diceOf(loaded);
  const next = advanceTurnSequence(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: eligibility() }).state;
  closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version }); // the old process ends with its turn
  const fresh = openDiceTurn({ scope: turnSequenceScopeOf(next), diceId: `dice-t${next.turnNumber}`, config: DICE_CONFIG_FIVE_D6_HOLD, sequence: next, expectedTurnNumber: next.turnNumber });
  await persist(roomId, loaded, { ...loaded.state, turnSequence: next, dice: fresh }, 'TURN_CHANGED');
  return next.turnNumber;
}
const roll = (binding: Binding): Intent => ({ kind: 'ROLL', binding });
const holdIntent = (binding: Binding, held: number[]): Intent => ({ kind: 'HOLD', binding, held });

type Settled = PromiseSettledResult<unknown>;
const outcome = (result: Settled): string => (result.status === 'fulfilled' ? 'OK' : String((result.reason as Error).message ?? result.reason));
const ok = (results: Settled[]) => results.filter(r => r.status === 'fulfilled').length;

describe('N9 integration: dice rolls and holds on the real CAS / receipt / state-event stack (SQLite)', () => {
  it('roll, hold, roll: every step is read back from the database — values, held assignment, roll number and counters move exactly once; the stored events replay to the same state', async () => {
    const { roomId } = await fixture();
    const r1 = counted([1, 2, 3, 4, 5]);
    let stored = await load(roomId);
    await handle(stored, roomId, 'a', roll(bindingOf(stored)), r1.source);
    stored = await load(roomId);
    expect(stored.revision).toBe(5);
    expect(diceOf(stored)).toMatchObject({ values: [1, 2, 3, 4, 5], rollCount: 1, version: 1, phase: 'IN_PROGRESS' });
    await handle(stored, roomId, 'a', holdIntent(bindingOf(stored), [1, 3]), counted().source);
    stored = await load(roomId);
    expect(stored.revision).toBe(6);
    expect(diceOf(stored)).toMatchObject({ values: [1, 2, 3, 4, 5], rollCount: 1, version: 2, held: [false, true, false, true, false] });
    const r2 = counted([6, 6, 6]);
    await handle(stored, roomId, 'a', roll(bindingOf(stored)), r2.source);
    stored = await load(roomId);
    expect(stored.revision).toBe(7);
    expect(diceOf(stored)).toMatchObject({ values: [6, 2, 6, 4, 6], rollCount: 2, version: 3, lastRolled: [0, 2, 4] });
    expect([r1.state.draws, r2.state.draws]).toEqual([5, 3]); // exactly the not held positions were drawn
    expect(seqOf(stored)).toMatchObject({ turnNumber: 1, version: 1 }); // the sequence was not touched by dice actions
    // the real event path wrote one GameDomainEvent per commit; replaying them from the start rebuilds exactly the stored state — no draw anywhere
    const room = await db.room.findUniqueOrThrow({ where: { id: roomId } });
    const rows = await db.gameDomainEvent.findMany({ where: { roomId }, orderBy: { stateVersion: 'asc' } });
    expect(rows.map(r => r.type)).toEqual(['DICE_CHANGED', 'DICE_CHANGED', 'DICE_CHANGED']);
    const start: EngineStateSnapshot = { roomId, runIndex: room.runIndex, gameSlug: SLUG, engineVersion: 1, stateVersion: 4, state: {} };
    const rebuilt = rows.reduce<EngineStateSnapshot>((snapshot, row) => applyStateEvent(snapshot, JSON.parse(row.payloadJson)), start);
    expect(rebuilt.stateVersion).toBe(7);
    expect(rebuilt.state).toEqual(stored.state);
  });

  it('the same commandId, sent in parallel and again after the confirmation was lost: ONE roll, the stored answer is replayed, the handler body and the random source do not run again', async () => {
    const { roomId } = await fixture();
    const commandId = `cmd-${randomUUID()}`;
    const stored0 = await load(roomId);
    const intent = roll(bindingOf(stored0));
    const draws = counted([3, 1, 4, 1, 5]);
    let effects = 0;
    const send = () => runReceipted(db, {
      roomId, commandId, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: 'DICE_ROLL', payload: intent,
      mutate: async () => { effects++; return handle(await load(roomId), roomId, 'a', intent, draws.source); },
      toResponse: data => ({ success: true, ...data }),
    });
    const parallel = await Promise.all([send(), send()]);
    expect(effects).toBe(1);
    expect(draws.state.draws).toBe(5); // one execution, five dice
    expect(parallel.filter(r => r.replayed)).toHaveLength(1);
    expect(parallel.every(r => r.success)).toBe(true);
    const afterFirst = await load(roomId);
    expect(afterFirst.revision).toBe(5);
    expect(diceOf(afterFirst)).toMatchObject({ values: [3, 1, 4, 1, 5], rollCount: 1, version: 1 });
    // the answer was "lost": the client sends the SAME intent with the SAME commandId later
    const again = await send();
    expect(again).toMatchObject({ success: true, replayed: true });
    expect((again as { data: { values: number[] } }).data.values).toEqual([3, 1, 4, 1, 5]); // the stored answer, not a new roll
    expect(effects).toBe(1);
    expect(draws.state.draws).toBe(5);
    expect(await load(roomId)).toEqual(afterFirst);
    const receipts = await db.commandReceipt.findMany({ where: { roomId, commandId } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('COMPLETED');
  });

  it('two DIFFERENT roll intents on the same expected stand: the CAS lets at most one through; BOTH computed a result (10 draws), exactly ONE is stored — and it is the winner\'s', async () => {
    for (let round = 0; round < 3; round++) {
      const { roomId } = await fixture();
      const [l1, l2] = await Promise.all([load(roomId), load(roomId)]);
      const binding = bindingOf(l1);
      const s1 = counted([1, 1, 1, 1, 1]), s2 = counted([2, 2, 2, 2, 2]);
      const results = await Promise.allSettled([handle(l1, roomId, 'a', roll(binding), s1.source), handle(l2, roomId, 'a', roll(binding), s2.source)]);
      expect(ok(results), results.map(outcome).join(' | ')).toBe(1);
      expect(s1.state.draws + s2.state.draws).toBe(10); // the loser had already drawn when its CAS failed: "one applied roll" is not "one random call"
      const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(GameStateConflictError);
      const stored = await load(roomId);
      expect(stored.revision).toBe(5);
      expect(diceOf(stored)).toMatchObject({ rollCount: 1, version: 1 });
      const winner = results[0].status === 'fulfilled' ? [1, 1, 1, 1, 1] : [2, 2, 2, 2, 2];
      expect(diceOf(stored).values).toEqual(winner); // never a mixture of the two draws
    }
  });

  it('two different commandIds for the same bound roll racing through the receipt path: one stored roll; every loser is refused with a known code, never a second roll', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    const intent = roll(bindingOf(stored0));
    const draws = counted();
    const send = () => runReceipted(db, {
      roomId, commandId: `cmd-${randomUUID()}`, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: 'DICE_ROLL', payload: intent,
      mutate: async () => handle(await load(roomId), roomId, 'a', intent, draws.source), toResponse: data => ({ success: true, ...data }),
    });
    const results = await Promise.allSettled([send(), send(), send()]);
    const description = results.map(r => (r.status === 'fulfilled' ? (r.value.success ? 'OK' : `REFUSED:${r.value.error}`) : `THROWN:${(r.reason as Error).message}`));
    expect(description.filter(d => d === 'OK'), description.join(' | ')).toHaveLength(1);
    for (const d of description.filter(x => x !== 'OK')) expect(d).toMatch(/^(REFUSED:(COMMAND_STATE_ADVANCED|STATE_CONFLICT|REVISION_CONFLICT)|THROWN:(DICE_VERSION_STALE|Game state revision conflict.*))$/);
    const stored = await load(roomId);
    expect(stored.revision).toBe(5);
    expect(diceOf(stored)).toMatchObject({ rollCount: 1, version: 1 });
    expect(draws.state.draws % 5).toBe(0); // whole computations only; at least the winner's
    expect(draws.state.draws).toBeGreaterThanOrEqual(5);
    expect(draws.state.draws).toBeLessThanOrEqual(15);
  });

  it('hold against roll from the SAME stored stand: exactly one order wins — never an old hold set mixed with a new result, never a roll that ignored a hold the client had saw', async () => {
    for (const order of ['hold-first', 'roll-first'] as const) {
      const { roomId } = await fixture();
      let stored = await load(roomId);
      await handle(stored, roomId, 'a', roll(bindingOf(stored)), counted([1, 2, 3, 4, 5]).source);
      stored = await load(roomId);
      const before = diceOf(stored);
      const revisionBefore = stored.revision;
      const [l1, l2] = await Promise.all([load(roomId), load(roomId)]);
      const binding = bindingOf(l1);
      const attempts = order === 'hold-first'
        ? [handle(l1, roomId, 'a', holdIntent(binding, [0, 1]), counted().source), handle(l2, roomId, 'a', roll(binding), counted([6, 6, 6, 6, 6]).source)]
        : [handle(l1, roomId, 'a', roll(binding), counted([6, 6, 6, 6, 6]).source), handle(l2, roomId, 'a', holdIntent(binding, [0, 1]), counted().source)];
      const results = await Promise.allSettled(attempts);
      expect(ok(results), results.map(outcome).join(' | ')).toBe(1);
      const after = diceOf(await load(roomId));
      const holdWon = after.held[0] === true;
      if (holdWon) expect(after).toMatchObject({ values: before.values, rollCount: 1, held: [true, true, false, false, false] }); // the hold happened, nothing was rolled
      else expect(after).toMatchObject({ values: [6, 6, 6, 6, 6], rollCount: 2, held: [false, false, false, false, false] }); // the roll happened with the OLD (empty) hold set
      expect((await load(roomId)).revision).toBe(revisionBefore + 1); // exactly one CAS step on top of the stored stand
    }
  });

  it('hold and roll one after the other: whichever is bound to the OLDER dice version is refused at the domain, before any draw, and changes nothing', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    await handle(stored, roomId, 'a', roll(bindingOf(stored)), counted([1, 2, 3, 4, 5]).source);
    stored = await load(roomId);
    const old = bindingOf(stored); // what the client saw after roll 1
    await handle(stored, roomId, 'a', holdIntent(old, [0, 1]), counted().source);
    const afterHold = await load(roomId);
    const late = counted([6, 6, 6, 6, 6]);
    await expect(handle(afterHold, roomId, 'a', roll(old), late.source)).rejects.toThrow('DICE_VERSION_STALE'); // a roll prepared against the hold set before the hold
    expect(late.state.draws).toBe(0);
    expect(await load(roomId)).toEqual(afterHold);
    const fresh = counted([6, 6, 6]);
    await handle(afterHold, roomId, 'a', roll(bindingOf(afterHold)), fresh.source);
    const afterRoll = await load(roomId);
    expect(diceOf(afterRoll).values).toEqual([1, 2, 6, 6, 6]); // exactly the hold set the client had seen
    await expect(handle(afterRoll, roomId, 'a', holdIntent(bindingOf(afterHold), [4]), counted().source)).rejects.toThrow('DICE_VERSION_STALE');
    expect(await load(roomId)).toEqual(afterRoll);
  });

  it('the SAME player in a LATER turn: the old intent stays refused although the global revision it reads is current; turn change, close and reopen are ONE commit', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    await handle(stored, roomId, 'a', roll(bindingOf(stored)), counted([1, 2, 3, 4, 5]).source);
    stored = await load(roomId);
    const turnOne = bindingOf(stored); // the numbers a saw in turn 1
    for (let i = 0; i < 3; i++) await endTurn(await load(roomId), roomId); // a → b → c → a
    stored = await load(roomId);
    expect(seqOf(stored)).toMatchObject({ turnNumber: 4 });
    expect(diceOf(stored)).toMatchObject({ phase: 'PREPARED', rollCount: 0, values: null, diceId: 'dice-t4' });
    expect(diceOf(stored).binding).toMatchObject({ turnNumber: 4, playerId: 'a' }); // the same player — a different turn, a different process
    expect(stored.revision).toBe(5 + 3);
    const late = counted([6, 6, 6, 6, 6]);
    await expect(handle(stored, roomId, 'a', roll(turnOne), late.source)).rejects.toThrow('TURN_SEQ_VERSION_STALE'); // the loaded revision IS current — the binding is not
    await expect(handle(stored, roomId, 'a', holdIntent(turnOne, [0]), late.source)).rejects.toThrow('TURN_SEQ_VERSION_STALE');
    await expect(handle(stored, roomId, 'a', roll({ ...bindingOf(stored), turnNumber: 1 }), late.source)).rejects.toThrow('TURN_SEQ_TURN_STALE'); // right version, old turn
    expect(late.state.draws).toBe(0);
    expect(await load(roomId)).toEqual(stored);
    // the new turn's own binding works
    await handle(stored, roomId, 'a', roll(bindingOf(stored)), counted([6, 6, 6, 6, 6]).source);
    expect(diceOf(await load(roomId))).toMatchObject({ rollCount: 1, values: [6, 6, 6, 6, 6], diceId: 'dice-t4' });
  });

  it('a consumer that moves the N8 turn on but forgets the dice: the stored process of the OLD turn is refused from the database state, even for the SAME player and with the current sequence numbers', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    await handle(stored, roomId, 'a', roll(bindingOf(stored)), counted([1, 2, 3, 4, 5]).source);
    for (let i = 0; i < 3; i++) { // a → b → c → a, the sequence only: the dice process is neither closed nor replaced (a consumer bug on purpose)
      const loaded = await load(roomId);
      const seq = seqOf(loaded);
      const next = advanceTurnSequence(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: eligibility() }).state;
      await persist(roomId, loaded, { ...loaded.state, turnSequence: next }, 'TURN_CHANGED_WITHOUT_DICE');
    }
    stored = await load(roomId);
    expect(seqOf(stored).turnNumber).toBe(4);
    expect(diceOf(stored).binding.turnNumber).toBe(1);
    const late = counted([6, 6, 6, 6, 6]);
    const current = { turnNumber: 4, sequenceVersion: seqOf(stored).version, diceVersion: diceOf(stored).version, rollCount: diceOf(stored).rollCount }; // the numbers the client WOULD have seen for the current sequence
    await expect(handle(stored, roomId, 'a', roll(current), late.source)).rejects.toThrow('DICE_TURN_STALE');
    await expect(handle(stored, roomId, 'a', holdIntent(current, [0]), late.source)).rejects.toThrow('DICE_TURN_STALE');
    expect(late.state.draws).toBe(0);
    expect(await load(roomId)).toEqual(stored);
  });

  it('two competing turn changes from the same stand: one commit; the stored sequence and the stored dice process always belong to the same turn', async () => {
    const { roomId } = await fixture();
    const [l1, l2] = await Promise.all([load(roomId), load(roomId)]);
    const results = await Promise.allSettled([endTurn(l1, roomId), endTurn(l2, roomId)]);
    expect(ok(results), results.map(outcome).join(' | ')).toBe(1);
    const stored = await load(roomId);
    expect(seqOf(stored).turnNumber).toBe(2);
    expect(diceOf(stored).binding.turnNumber).toBe(2); // never turn 2 with the process of turn 1 or the other way round
    expect(diceOf(stored).diceId).toBe('dice-t2');
    expect(stored.revision).toBe(5);
  });

  it('recovery after commit but before the answer arrived: the same command is replayed (no new roll); a NEW commandId with the old binding is refused; the next authorised roll continues from the stored state', async () => {
    const { roomId } = await fixture();
    const first = await load(roomId);
    const intent = roll(bindingOf(first));
    const commandId = `cmd-${randomUUID()}`;
    const draws = counted([2, 4, 6, 1, 3]);
    let effects = 0;
    const send = (id: string, i: Intent, source: DiceIntSource) => runReceipted(db, {
      roomId, commandId: id, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: 'DICE_ROLL', payload: i,
      mutate: async () => { effects++; return handle(await load(roomId), roomId, 'a', i, source); }, toResponse: data => ({ success: true, ...data }),
    });
    expect((await send(commandId, intent, draws.source)).success).toBe(true); // committed; the answer is "lost" on the way
    const stored = await load(roomId);
    expect(diceOf(stored)).toMatchObject({ values: [2, 4, 6, 1, 3], rollCount: 1 });
    // the retry with the same id: the stored answer
    const replay = await send(commandId, intent, draws.source);
    expect(replay).toMatchObject({ success: true, replayed: true });
    expect(effects).toBe(1);
    expect(draws.state.draws).toBe(5);
    // a client that gave up and built a NEW id for the same old intent gets no second roll
    const second = counted([6, 6, 6, 6, 6]);
    await expect(send(`cmd-${randomUUID()}`, intent, second.source)).rejects.toThrow('DICE_VERSION_STALE');
    expect(second.state.draws).toBe(0);
    expect(await load(roomId)).toEqual(stored);
    // re-synchronised, the client's next intent carries the stored numbers and continues from them
    const next = counted([5, 5, 5, 5, 5]);
    await handle(await load(roomId), roomId, 'a', roll(bindingOf(stored)), next.source);
    expect(diceOf(await load(roomId))).toMatchObject({ values: [5, 5, 5, 5, 5], rollCount: 2, version: 2 });
  });

  it('the process dies AFTER the commit but BEFORE the receipt is completed: the retry with the SAME commandId is told to resync — the handler and the random source do not run again, nothing is rolled twice', async () => {
    const { roomId } = await fixture();
    const first = await load(roomId);
    const intent = roll(bindingOf(first));
    const commandId = `cmd-${randomUUID()}`;
    const draws = counted([2, 4, 6, 1, 3]);
    let effects = 0, crash = true;
    const send = () => runReceipted(db, {
      roomId, commandId, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: 'DICE_ROLL', payload: intent,
      mutate: async () => { effects++; return handle(await load(roomId), roomId, 'a', intent, draws.source); },
      toResponse: data => { if (crash) throw new Error('PROCESS_DIED_BEFORE_THE_RECEIPT'); return { success: true, ...data }; },
    });
    await expect(send()).rejects.toThrow('PROCESS_DIED_BEFORE_THE_RECEIPT');
    const stored = await load(roomId); // the roll IS committed, only its receipt is not
    expect(diceOf(stored)).toMatchObject({ values: [2, 4, 6, 1, 3], rollCount: 1, version: 1 });
    expect((await db.commandReceipt.findUniqueOrThrow({ where: { roomId_commandId: { roomId, commandId } } })).mutationStartedAt).not.toBeNull(); // the mutation marker is what forbids a rerun
    crash = false;
    const retry = await send();
    expect(retry).toMatchObject({ success: false, error: 'COMMAND_STATE_ADVANCED', resyncRequired: true });
    expect(effects).toBe(1);
    expect(draws.state.draws).toBe(5); // no second draw "to confirm" the committed command
    expect(await load(roomId)).toEqual(stored);
    // after the resync the client's next intent carries the stored numbers and continues from them
    await handle(await load(roomId), roomId, 'a', roll(bindingOf(stored)), counted([5, 5, 5, 5, 5]).source);
    expect(diceOf(await load(roomId))).toMatchObject({ values: [5, 5, 5, 5, 5], rollCount: 2 });
  });

  it('a roll that fails BEFORE any commit (stale binding) draws nothing, leaves the state alone and, retried with the same commandId, fails the same way — it is never turned into a roll by the retry', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    await handle(stored0, roomId, 'a', roll(bindingOf(stored0)), counted([1, 2, 3, 4, 5]).source);
    const stored = await load(roomId);
    const stale = roll(bindingOf(stored0)); // the numbers from BEFORE the roll
    const commandId = `cmd-${randomUUID()}`;
    const draws = counted([6, 6, 6, 6, 6]);
    let effects = 0;
    const send = () => runReceipted(db, {
      roomId, commandId, actor: { actorId: 'a', actorRole: 'PLAYER' }, action: 'DICE_ROLL', payload: stale,
      mutate: async () => { effects++; return handle(await load(roomId), roomId, 'a', stale, draws.source); }, toResponse: data => ({ success: true, ...data }),
    });
    await expect(send()).rejects.toThrow('DICE_VERSION_STALE');
    await expect(send()).rejects.toThrow('DICE_VERSION_STALE'); // the handler may run again (nothing was mutated) — and fails again
    expect(effects).toBe(2); // the receipt allowed the retry of a command that failed before any mutation: the body ran again and failed the same way
    expect(draws.state.draws).toBe(0);
    expect(await load(roomId)).toEqual(stored);
    expect(diceOf(stored).values).toEqual([1, 2, 3, 4, 5]);
  });

  it('a newer N6 stand seen by a roll is persisted in the SAME commit (N8-02): one revision step, sequence version +1, no new turn, dice untouched by it — and the old stand and the old binding are fenced afterwards', async () => {
    const { roomId } = await fixture();
    const stored0 = await load(roomId);
    const binding = bindingOf(stored0);
    const newer = eligibility(7);
    await handle(stored0, roomId, 'a', roll(binding), counted([1, 2, 3, 4, 5]).source, newer);
    const stored = await load(roomId);
    expect(stored.revision).toBe(5); // ONE commit carried the roll and the basis
    expect(seqOf(stored)).toMatchObject({ turnNumber: 1, version: seqOf(stored0).version + 1, completedTurns: 0 });
    expect(seqOf(stored).eligibility!.actors.version).toBe(7);
    expect(diceOf(stored)).toMatchObject({ rollCount: 1, values: [1, 2, 3, 4, 5] });
    // read back from the database: the older stand is fenced, the old binding too, the dice are unchanged by the rejected attempts
    const late = counted([6, 6, 6, 6, 6]);
    await expect(handle(stored, roomId, 'a', roll(bindingOf(stored)), late.source, eligibility(1))).rejects.toThrow('TURN_SEQ_ELIGIBILITY_STALE');
    await expect(handle(stored, roomId, 'a', roll(binding), late.source, newer)).rejects.toThrow('TURN_SEQ_VERSION_STALE'); // the binding from before the basis step
    expect(late.state.draws).toBe(0); // both refusals happened before the random source
    expect(await load(roomId)).toEqual(stored);
    // the same turn continues with the SAME dice under the new binding
    const current = await load(roomId);
    await handle(current, roomId, 'a', holdIntent(bindingOf(current), [0]), counted().source, newer);
    expect(diceOf(await load(roomId))).toMatchObject({ rollCount: 1, held: [true, false, false, false, false], values: [1, 2, 3, 4, 5] });
  });

  it('a hold that changes NOTHING but saw a newer N6 stand still persists the basis (N8-02): one revision step, sequence version +1, no new turn, the dice are bit for bit the same', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    await handle(stored, roomId, 'a', roll(bindingOf(stored)), counted([1, 2, 3, 4, 5]).source);
    stored = await load(roomId);
    await handle(stored, roomId, 'a', holdIntent(bindingOf(stored), [0]), counted().source);
    stored = await load(roomId);
    const diceBefore = diceOf(stored);
    const seqBefore = seqOf(stored);
    const result = await handle(stored, roomId, 'a', holdIntent(bindingOf(stored), [0]), counted().source, eligibility(8)); // the SAME assignment again, with a newer stand
    expect(result.changed).toBe(false); // the dice did not change ...
    const after = await load(roomId);
    expect(after.revision).toBe(stored.revision + 1); // ... but the commit that carried the newer knowledge happened
    expect(seqOf(after)).toMatchObject({ turnNumber: seqBefore.turnNumber, version: seqBefore.version + 1 });
    expect(seqOf(after).eligibility!.actors.version).toBe(8);
    expect(diceOf(after)).toEqual(diceBefore);
    await expect(handle(after, roomId, 'a', holdIntent(bindingOf(after), [0, 1]), counted().source, eligibility(1))).rejects.toThrow('TURN_SEQ_ELIGIBILITY_STALE'); // the older stand can not pass any more
  });

  it('the roll limit and the closing survive in the database: the third roll exhausts, a fourth is refused without a draw or a revision step, closing is terminal', async () => {
    const { roomId } = await fixture();
    for (const values of [[1, 1, 1, 1, 1], [2, 2, 2, 2, 2], [3, 3, 3, 3, 3]]) {
      const stored = await load(roomId);
      await handle(stored, roomId, 'a', roll(bindingOf(stored)), counted(values).source);
    }
    let stored = await load(roomId);
    expect(diceOf(stored)).toMatchObject({ phase: 'EXHAUSTED', rollCount: 3, values: [3, 3, 3, 3, 3] });
    const fourth = counted([4, 4, 4, 4, 4]);
    await expect(handle(stored, roomId, 'a', roll(bindingOf(stored)), fourth.source)).rejects.toThrow('DICE_ROLLS_EXHAUSTED');
    expect(fourth.state.draws).toBe(0);
    expect(await load(roomId)).toEqual(stored);
    // the consumer closes the process (it scored, say); no points, no N8 change
    const dice = diceOf(stored);
    const closed = closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version });
    await persist(roomId, stored, { ...stored.state, dice: closed.state }, 'DICE_CLOSED');
    stored = await load(roomId);
    expect(diceOf(stored)).toMatchObject({ phase: 'CLOSED', rollCount: 3, values: [3, 3, 3, 3, 3] });
    expect(seqOf(stored).turnNumber).toBe(1); // closing the dice did not advance N8
    await expect(handle(stored, roomId, 'a', roll(bindingOf(stored)), counted([1, 1, 1, 1, 1]).source)).rejects.toThrow('DICE_CLOSED');
  });

  it('recovery in a SECOND process: the stored process is read back unchanged (no draw), projects for a viewer, and the next authorised roll continues from it with the held dice kept', async () => {
    const { roomId } = await fixture();
    let stored = await load(roomId);
    await handle(stored, roomId, 'a', roll(bindingOf(stored)), counted([1, 2, 3, 4, 5]).source);
    stored = await load(roomId);
    await handle(stored, roomId, 'a', holdIntent(bindingOf(stored), [1, 3]), counted().source);
    stored = await load(roomId);
    const before = diceOf(stored);
    expect(stored.revision).toBe(6);
    // a separate Node process: its own module instances and its own Prisma client. It only READS and computes in memory. The random source of the
    // process is replaced by one that throws BEFORE the domain is loaded — if reading, parsing or projecting drew anything, the process would fail.
    const script = `
      const { PrismaClient } = require('@prisma/client');
      (async () => {
        const crypto = require('node:crypto');
        crypto.randomInt = () => { throw new Error('RNG_CALLED_IN_SECOND_PROCESS'); };
        require('node:module').syncBuiltinESMExports();
        let positiveControl = 'NOT_BLOCKED';
        try { (await import('node:crypto')).randomInt(1, 7); } catch (error) { positiveControl = error.message; }
        const dice = await import(${JSON.stringify(join(serverRoot, 'src/games/core/diceTurn.ts'))});
        const turn = await import(${JSON.stringify(join(serverRoot, 'src/games/core/turnSequence.ts'))});
        const client = new PrismaClient({ datasourceUrl: process.env.CHILD_DB });
        const row = await client.roomGameState.findUniqueOrThrow({ where: { roomId: process.env.CHILD_ROOM } });
        const stored = JSON.parse(row.stateJson);
        const state = dice.parseDiceTurnState(stored.dice);
        const seq = turn.parseTurnSequenceState(stored.turnSequence);
        const level = ids => ({ runIndex: 1, trackId: 'players-track', rosterRevision: 'track-roster-1', version: 1, knownIds: ids, activeIds: ids });
        const scope = turn.turnSequenceScopeOf(seq);
        const viewer = dice.projectDiceTurn({ role: 'VIEWER' }, state, { scope, sequence: seq, release: 'VALUES', stateVersion: row.revision });
        const mine = dice.projectDiceTurn({ role: 'PLAYER', participantId: 'a', teamId: null }, state, { scope, sequence: seq, release: 'VALUES', stateVersion: row.revision });
        const next = dice.rollDice(state, { scope, diceId: state.diceId, sequence: seq, expectedTurnNumber: seq.turnNumber, expectedSequenceVersion: seq.version, expectedVersion: state.version, expectedRollCount: state.rollCount,
          caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: { actors: level(['a', 'b', 'c']), members: null }, source: () => 6 });
        console.log(JSON.stringify({ positiveControl, revision: row.revision, state, viewer, mine, next: next.state }));
        await client.$disconnect();
      })().catch(error => { console.error(error); process.exit(1); });
    `;
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '-e', script], { cwd: serverRoot, env: { ...process.env, CHILD_DB: singleConnectionSqliteUrl(url), CHILD_ROOM: roomId }, timeout: 60000 });
    const seen = JSON.parse(stdout.trim().split('\n').pop()!) as { positiveControl: string; revision: number; state: unknown; viewer: { values: number[]; you: unknown; held: boolean[] }; mine: { you: { canRoll: boolean; canHold: boolean } }; next: DiceTurnState };
    expect(seen.positiveControl).toBe('RNG_CALLED_IN_SECOND_PROCESS'); // the block is visible to the domain's own import: the process really could not draw
    expect(seen.revision).toBe(6);
    expect(seen.state).toEqual(before); // identical values, hold assignment, counters
    expect(seen.viewer).toMatchObject({ values: [1, 2, 3, 4, 5], held: [false, true, false, true, false], you: null });
    expect(seen.mine.you).toMatchObject({ canRoll: true, canHold: true });
    expect(seen.next.values).toEqual([6, 2, 6, 4, 6]); // continued from the stored stand: held dice kept, three positions drawn by the stand-in source
    expect(seen.next).toMatchObject({ rollCount: 2, version: before.version + 1 });
    // the child computed in memory only: the stored state is untouched, and the parent continuing from it reaches the same state
    expect(await load(roomId)).toEqual(stored);
    const mine = rollDice(before, {
      scope: turnSequenceScopeOf(seqOf(stored)), diceId: before.diceId, sequence: seqOf(stored), expectedTurnNumber: 1, expectedSequenceVersion: seqOf(stored).version, expectedVersion: before.version, expectedRollCount: before.rollCount,
      caller: CALLER('a'), gate: OPEN, eligibility: eligibility(), source: () => 6,
    });
    expect(seen.next).toEqual(mine.state);
    // sanity for the projection API the child used
    expect(projectDiceTurn({ role: 'VIEWER' }, before, { scope: turnSequenceScopeOf(seqOf(stored)), sequence: seqOf(stored), release: 'NONE', stateVersion: 6 }).rollCount).toBe(1);
  });
});
