// TEST-ONLY backend for the N11 board harness. It binds the REAL server domain (boardState.ts, diceTurn.ts, turnSequence.ts) to a tiny HTTP API so that several
// real Chromium contexts receive the projection of ONE board, and it keeps the AUTHORITATIVE state in a REAL SQLite file (real migrations, the real receipt table
// through `runReceipted`, the real CAS `saveGameStateIfRevision`, the real state event through `materializeGameEvent`). Every projection is made from what is READ
// BACK from that database; the browser check reads positions, versions and the spent roll from it again. It is not a product endpoint, has no authentication and
// lives outside src/: it is never part of a build. The "recipient" stands in for the admitted session of a later consumer (identity comes from the server-side
// table below, never from the request body); the real authentication / admission / phase checks are NOT exercised here. It is NOT an engine consumer.
// The GEOMETRY below is an EXPLICIT TEST GEOMETRY, no platform default. Host commands (reset, roll, place, endTurn …) exist ONLY in this harness.
// Run: node --import tsx apps/web/harness/n11-board/server.ts [port]     (HARNESS_DIR=<dir> keeps/reuses the database across restarts)
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createTestDatabase } from '../../../server/src/test-helpers.js';
import { singleConnectionSqliteUrl } from '../../../server/src/persistence/sqliteUrl.js';
import { runReceipted } from '../../../server/src/games/core/commands.js';
import { materializeGameEvent } from '../../../server/src/games/core/events.js';
import { saveGameStateIfRevision } from '../../../server/src/games/core/state.js';
import { boardActionArgsFromIntent, moveFigure, parseBoardState, prepareBoard, projectBoard, readBoardMoveIntent, type BoardPolicy } from '../../../server/src/games/core/boardState.js';
import { closeDiceTurn, diceTurnScopeOf, openDiceTurn, parseDiceTurnState, rollDice } from '../../../server/src/games/core/diceTurn.js';
import {
  advanceTurnSequence, currentTurnHolder, parseTurnSequenceState, prepareTurnSequence, refreshEligibilityBasis, startTurnSequence, turnSequenceScopeOf, type TurnEligibility,
} from '../../../server/src/games/core/turnSequence.js';
import type { ProjectionAudience } from '../../../server/src/games/core/visibility.js';
import { DICE_CONFIG_SINGLE_D6 } from '@quiz/shared/dice';
import type { BoardGeometry, BoardRelease } from '@quiz/shared/board';

const port = Number(process.argv[2] ?? 5216);
const SLUG = 'n11-harness';
const PLAYERS = ['P1', 'P2', 'P3'];
const AUDIENCES: Record<string, ProjectionAudience> = {
  P1: { role: 'PLAYER', participantId: 'P1', teamId: null }, P2: { role: 'PLAYER', participantId: 'P2', teamId: null }, P3: { role: 'PLAYER', participantId: 'P3', teamId: null },
  VIEWER: { role: 'VIEWER' }, DISPLAY: { role: 'DISPLAY' }, HOST: { role: 'HOST' },
};
const DEFAULT_RELEASE: Record<string, BoardRelease> = { P1: 'FIGURES', P2: 'FIGURES', P3: 'FIGURES', VIEWER: 'FIGURES', DISPLAY: 'FIGURES', HOST: 'FIGURES' };
// EXPLICIT TEST GEOMETRY: P1: sa t1 t2 t3 t4 ha — P2: sb t3 t4 t5 t6 hb (the ring fields t3 and t4 are shared); P3 owns no figure.
const GEOMETRY: BoardGeometry = {
  fields: [
    { id: 'sa', capacity: 2 }, { id: 'sb', capacity: 2 }, { id: 't1', capacity: 1 }, { id: 't2', capacity: 1 }, { id: 't3', capacity: 1 }, { id: 't4', capacity: 1 },
    { id: 't5', capacity: 1 }, { id: 't6', capacity: 1 }, { id: 'ha', capacity: 2 }, { id: 'hb', capacity: 2 },
  ],
  routes: [{ ownerId: 'P1', route: ['sa', 't1', 't2', 't3', 't4', 'ha'] }, { ownerId: 'P2', route: ['sb', 't3', 't4', 't5', 't6', 'hb'] }],
};
const FIGURES = [{ id: 'a1', ownerId: 'P1' }, { id: 'a2', ownerId: 'P1' }, { id: 'b1', ownerId: 'P2' }, { id: 'b2', ownerId: 'P2' }];

let db: PrismaClient;
let roomId = '';
let hostId = '';
let definitionId = '';
let eligibilityVersion = 1;
let runIndex = 1;
let rosterRevision = 'roster-1';
let boardId = 'board-1';
let keepSequenceId: string | null = null;
let release: Record<string, BoardRelease> = { ...DEFAULT_RELEASE };
let policy: BoardPolicy = { capture: 'ALLOWED' };
let paused = false;
let log: Array<{ kind: string; recipient: string; ok: boolean; code?: string; replayed?: boolean }> = [];

const elig = (version = eligibilityVersion): TurnEligibility => ({ actors: { runIndex, trackId: 'players-track', rosterRevision: 'track-roster-1', version, knownIds: PLAYERS, activeIds: PLAYERS }, members: null });

interface StandIn { phase: string; standIn: boolean; turnSequence: unknown; dice: unknown; board: unknown }
interface Stored { revision: number; phase: string; state: StandIn }
async function load(): Promise<Stored> {
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } });
  return { revision: row.revision, phase: row.phase, state: JSON.parse(row.stateJson) as StandIn };
}
/** The stand-in commit: ONE transaction with the state event (real SDK path) and the shared CAS write on the revision that was loaded. */
async function persist(loaded: Stored, state: StandIn, type: string): Promise<void> {
  await db.$transaction(async tx => {
    const before = await tx.roomGameState.findUniqueOrThrow({ where: { roomId } }); // no own pre-check: the conditional UPDATE of the shared primitive is the only guard
    await materializeGameEvent(tx, { roomId, gameSlug: SLUG, engineVersion: before.engineVersion, before, nextState: state, type });
    await saveGameStateIfRevision(tx, { roomId, expectedRevision: loaded.revision, phase: loaded.phase, state });
  });
}
/** The holder of the current turn rolls (the REAL dice domain, a scripted face — harness only). */
function holderRoll(seq: ReturnType<typeof parseTurnSequenceState>, dice: ReturnType<typeof parseDiceTurnState>, face: number) {
  const holder = currentTurnHolder(seq)!;
  return rollDice(dice, {
    scope: turnSequenceScopeOf(seq), diceId: dice.diceId, sequence: seq, expectedTurnNumber: seq.turnNumber, expectedSequenceVersion: seq.version, expectedVersion: dice.version, expectedRollCount: dice.rollCount,
    caller: { role: 'PLAYER', participantId: holder.playerId, teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: elig(), source: () => face,
  }).state;
}

async function createRoom(face: number): Promise<void> {
  const count = await db.room.count();
  const code = String(970000 + count).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'N11 harness', hostUserId: hostId, gameDefinitionId: definitionId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE', viewerRequiresPin: false } });
  roomId = room.id;
  eligibilityVersion = 1;
  const prepared = prepareTurnSequence({ runIndex, sequenceId: keepSequenceId ?? `seq-${count + 1}`, rosterRevision, unit: 'PLAYER', mode: 'FIXED', order: PLAYERS });
  const seq = startTurnSequence(prepared, { scope: turnSequenceScopeOf(prepared), expectedVersion: 0, eligibility: elig() }).state;
  const opened = openDiceTurn({ scope: turnSequenceScopeOf(seq), diceId: `dice-t1`, config: DICE_CONFIG_SINGLE_D6, sequence: seq, expectedTurnNumber: 1 });
  const dice = face > 0 ? holderRoll(seq, opened, face) : opened;
  const board = prepareBoard({ scope: turnSequenceScopeOf(seq), boardId, geometry: GEOMETRY, figures: FIGURES, sequence: seq });
  await db.roomGameState.create({ data: { roomId, engineVersion: 1, phase: 'ROUND_ACTIVE', revision: 4, stateJson: JSON.stringify({ phase: 'ROUND_ACTIVE', standIn: true, turnSequence: seq, dice, board }) } });
}

/** What the SERVER really holds, read back from the database (a label or a sent command proves nothing). */
async function view(): Promise<Record<string, unknown>> {
  const stored = await load();
  const seq = parseTurnSequenceState(stored.state.turnSequence);
  const dice = parseDiceTurnState(stored.state.dice);
  const board = stored.state.board as ReturnType<typeof parseBoardState>; // raw row: /api/state must stay readable after a deliberately damaged snapshot
  return {
    revision: stored.revision, turnNumber: seq.turnNumber, sequenceVersion: seq.version, sequenceId: seq.sequenceId, scope: turnSequenceScopeOf(seq), holder: currentTurnHolder(seq)?.playerId ?? null,
    basisVersion: seq.eligibility?.actors.version ?? null, dice, board, positions: Object.fromEntries(board.figures.map(f => [f.id, f.at])),
    paused, release, policy, log, receipts: await db.commandReceipt.count({ where: { roomId } }), events: await db.gameDomainEvent.count({ where: { roomId } }), rooms: await db.room.count(),
  };
}

/** The recipient's own intent: authorise through the real checks (identity from the server-side table, NOT from the body), commit atomically under the real receipt. */
async function intent(body: { recipient: string; commandId: string; intent: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const audience = AUDIENCES[body.recipient];
  if (!audience) throw new Error('unknown recipient');
  try {
    const result = await runReceipted(db, {
      roomId, commandId: String(body.commandId), actor: { actorId: body.recipient, actorRole: audience.role },
      // a STAND-IN action name (CRITICAL_COMMAND_ACTIONS is a closed whitelist; the real consumer adds its own board action); the PAYLOAD carries the semantic kind and the complete intent
      action: 'ROUND_ADVANCE',
      payload: { kind: 'BOARD_MOVE', intent: body.intent },
      mutate: async () => {
        const loaded = await load();
        const seq = parseTurnSequenceState(loaded.state.turnSequence), dice = parseDiceTurnState(loaded.state.dice), board = parseBoardState(loaded.state.board);
        const parsed = readBoardMoveIntent(body.intent);
        // the ORIGIN (target + counters) comes from the INTENT; only the trusted facts come from the loaded state and the table of this harness
        const done = moveFigure(board, {
          ...boardActionArgsFromIntent(parsed), sequence: seq, dice,
          caller: { role: audience.role as 'PLAYER', participantId: audience.participantId ?? 'none', teamId: null }, gate: { admitted: true, phaseOpen: true, paused }, eligibility: elig(), policy,
        });
        const nextSeq = done.sequenceBasisAdvanced ? refreshEligibilityBasis(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, eligibility: elig() }).state : seq;
        await persist(loaded, { ...loaded.state, turnSequence: nextSeq, board: done.state }, 'BOARD_MOVED');
        return { boardVersion: done.state.version, captured: done.transition.captured };
      },
      toResponse: data => ({ success: true, ...data }),
    });
    log.push({ kind: 'move', recipient: body.recipient, ok: result.success, replayed: result.replayed, code: result.success ? undefined : result.error });
    return result.success ? { ok: true, replayed: result.replayed, ...(result.data as object) } : { ok: false, replayed: result.replayed, code: result.error };
  } catch (error) {
    const code = (error as { code?: string }).code ?? String((error as Error).message);
    log.push({ kind: 'move', recipient: body.recipient, ok: false, code });
    return { ok: false, code };
  }
}

/** Server-side moves of the CONSUMER (turn change, N6 basis update, setup): each is ONE commit. Not reachable by a player. */
async function host(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const loaded = await load();
  const seq = parseTurnSequenceState(loaded.state.turnSequence), dice = parseDiceTurnState(loaded.state.dice);
  const scope = turnSequenceScopeOf(seq);
  const closeOld = () => closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version });
  const nextRolled = (next: typeof seq, face: number) => holderRoll(next, openDiceTurn({ scope: turnSequenceScopeOf(next), diceId: `dice-t${next.turnNumber}-${next.version}`, config: DICE_CONFIG_SINGLE_D6, sequence: next, expectedTurnNumber: next.turnNumber }), face);
  switch (body.type) {
    case 'reset':
      keepSequenceId = typeof body.sequenceId === 'string' ? body.sequenceId : null; runIndex = typeof body.runIndex === 'number' ? body.runIndex : 1;
      rosterRevision = typeof body.rosterRevision === 'string' ? body.rosterRevision : 'roster-1'; boardId = typeof body.boardId === 'string' ? body.boardId : 'board-1';
      release = { ...DEFAULT_RELEASE }; policy = { capture: 'ALLOWED' }; paused = false; log = [];
      await createRoom(typeof body.face === 'number' ? body.face : 3);
      return { ok: true, ...(await view()) };
    case 'place': { // SETUP only: figures are put where the check needs them (the loaded state is validated by the domain like any other)
      const at = body.at as Record<string, string>;
      const board = parseBoardState(loaded.state.board);
      const placed = parseBoardState({ ...board, figures: board.figures.map(f => ({ ...f, at: at[f.id] ?? f.at })) });
      await persist(loaded, { ...loaded.state, board: placed }, 'BOARD_PLACED');
      return { ok: true, ...(await view()) };
    }
    case 'roll': { await persist(loaded, { ...loaded.state, dice: holderRoll(seq, dice, Number(body.face)) }, 'DICE_ROLLED'); return { ok: true, ...(await view()) }; }
    case 'endTurn': {
      const next = advanceTurnSequence(seq, { scope, expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: elig() }).state;
      closeOld();
      await persist(loaded, { ...loaded.state, turnSequence: next, dice: nextRolled(next, Number(body.face ?? 3)) }, 'TURN_CHANGED');
      return { ok: true, ...(await view()) };
    }
    case 'endTurnN8Only': { // a CONSUMER BUG on purpose: the sequence moves on, the stored dice process is NOT closed or replaced — the board module must still refuse the old roll
      const next = advanceTurnSequence(seq, { scope, expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: elig() }).state;
      await persist(loaded, { ...loaded.state, turnSequence: next }, 'TURN_CHANGED_WITHOUT_DICE');
      return { ok: true, ...(await view()) };
    }
    case 'basis': { // the consumer saw a NEWER N6 stand: the sequence records it (version +1, no new turn); board and dice are not part of this step
      eligibilityVersion += 1;
      const next = refreshEligibilityBasis(seq, { scope, expectedVersion: seq.version, eligibility: elig() }).state;
      await persist(loaded, { ...loaded.state, turnSequence: next }, 'TURN_BASIS');
      return { ok: true, ...(await view()) };
    }
    case 'damage': { // a DAMAGED SNAPSHOT, written straight into the row (harness only; no domain call, no revision step): only the board's last move is changed
      const board = parseBoardState(loaded.state.board);
      const patch = body.lastMove as Record<string, unknown>;
      const damaged = { ...board, lastMove: { ...(board.lastMove as object), ...patch } };
      await db.roomGameState.update({ where: { roomId }, data: { stateJson: JSON.stringify({ ...loaded.state, board: damaged }) } });
      return { ok: true };
    }
    case 'policy': policy = { capture: body.capture === 'FORBIDDEN' ? 'FORBIDDEN' : 'ALLOWED' }; await persist(loaded, { ...loaded.state }, 'POLICY_CHANGED'); return { ok: true, ...(await view()) };
    case 'pause': paused = body.on === true; return { ok: true, ...(await view()) };
    case 'release': { // a release change moves the stand (database revision) with it, as in a real system
      release[String(body.recipient)] = body.release as BoardRelease;
      await persist(loaded, { ...loaded.state }, 'RELEASE_CHANGED');
      return { ok: true, ...(await view()) };
    }
    default: throw new Error('unknown host command');
  }
}

async function projection(recipient: string): Promise<unknown> {
  const stored = await load();
  const seq = parseTurnSequenceState(stored.state.turnSequence), board = parseBoardState(stored.state.board);
  return projectBoard(AUDIENCES[recipient], board, { scope: turnSequenceScopeOf(seq), sequence: seq, dice: stored.state.dice, policy, release: release[recipient] ?? 'NONE', stateVersion: stored.revision });
}

const send = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req: http.IncomingMessage) => new Promise<string>(resolve => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); });

async function main(): Promise<void> {
  const dir = process.env.HARNESS_DIR ?? await mkdtemp(join(tmpdir(), 'quiz-n11-harness-'));
  const file = join(dir, 'test.db');
  const fresh = !existsSync(file);
  const url = `file:${file}`;
  if (fresh) await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: singleConnectionSqliteUrl(url) });
  await db.$connect();
  (globalThis as { __prisma?: PrismaClient }).__prisma = db;
  if (fresh) {
    hostId = (await db.user.create({ data: { displayName: 'N11 harness host', role: 'HOST', passwordHash: 'unused' } })).id;
    definitionId = (await db.gameDefinition.create({ data: { slug: SLUG, name: 'n11 harness', category: 'test', status: 'BETA', minPlayers: 2 } })).id;
    await createRoom(3);
  } else { // a RESTART on the same database: the stored state is all there is; nothing is re-created or invented
    hostId = (await db.user.findFirstOrThrow()).id;
    definitionId = (await db.gameDefinition.findFirstOrThrow({ where: { slug: SLUG } })).id;
    roomId = (await db.room.findFirstOrThrow({ orderBy: { code: 'desc' } })).id;
    const stored = await load();
    const seq = parseTurnSequenceState(stored.state.turnSequence);
    runIndex = seq.runIndex; rosterRevision = seq.rosterRevision; boardId = parseBoardState(stored.state.board).boardId;
    eligibilityVersion = seq.eligibility?.actors.version ?? 1; // the committed basis, not a freshly minted higher value
  }
  http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/api/state') return send(res, 200, await view());
      if (u.pathname === '/api/context') {
        const recipient = u.searchParams.get('recipient') ?? 'VIEWER';
        const stored = await load();
        return send(res, 200, { scope: turnSequenceScopeOf(parseTurnSequenceState(stored.state.turnSequence)), boardId: parseBoardState(stored.state.board).boardId, recipientId: AUDIENCES[recipient]?.participantId ?? null });
      }
      if (u.pathname === '/api/projection') return send(res, 200, await projection(u.searchParams.get('recipient') ?? 'VIEWER'));
      if (u.pathname === '/api/host' && req.method === 'POST') return send(res, 200, await host(JSON.parse(await readBody(req))));
      if (u.pathname === '/api/intent' && req.method === 'POST') return send(res, 200, await intent(JSON.parse(await readBody(req))));
      res.writeHead(404); res.end();
    } catch (error) { send(res, 400, { error: String((error as Error).message) }); }
  // eslint-disable-next-line no-console -- test-only harness: the check script waits for this port
  }).listen(port, '127.0.0.1', () => console.log(`n11 harness backend on ${port}`));
}
// eslint-disable-next-line no-console -- test-only harness: a failed start must be visible
main().catch(error => { console.error(error); process.exit(1); });
