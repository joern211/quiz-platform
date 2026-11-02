// TEST-ONLY backend for the N9 dice harness. It binds the REAL server domain (diceTurn.ts, turnSequence.ts) to a tiny HTTP API so that several real Chromium
// contexts receive the projection of ONE dice process, and it keeps the AUTHORITATIVE state in a REAL SQLite file (real migrations, the real receipt table
// through `runReceipted`, the real CAS `saveGameStateIfRevision`, the real state event through `materializeGameEvent`). Every projection is made from what is
// READ BACK from that database; the browser check reads the stored values, roll number and versions from it again. It is not a product endpoint, has no
// authentication and lives outside src/: it is never part of a build. The "recipient" stands in for the admitted session of a later consumer (identity and team
// come from the server-side table below, never from the request body); the real authentication/admission/phase checks are NOT exercised here. It is NOT an
// engine consumer.
//
// `script` (host command) queues dice values for the NEXT draws so that a browser check can assert exact results. It exists ONLY in this test harness: the domain
// has no such API, and without a queued value the REAL crypto source (`randomInt`) draws. Every draw is counted.
// Run: node --import tsx apps/web/harness/n9-dice/server.ts [port]     (HARNESS_DIR=<dir> keeps/reuses the database across restarts)
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createTestDatabase } from '../../../server/src/test-helpers.js';
import { singleConnectionSqliteUrl } from '../../../server/src/persistence/sqliteUrl.js';
import { runReceipted } from '../../../server/src/games/core/commands.js';
import { materializeGameEvent } from '../../../server/src/games/core/events.js';
import { saveGameStateIfRevision } from '../../../server/src/games/core/state.js';
import {
  closeDiceTurn, diceTurnScopeOf, openDiceTurn, parseDiceTurnState, projectDiceTurn, readDiceHoldIntent, readDiceRollIntent, rollDice, setDiceHeld, type DiceIntSource,
} from '../../../server/src/games/core/diceTurn.js';
import {
  advanceTurnSequence, overrideTurnSequence, parseTurnSequenceState, prepareTurnSequence, refreshEligibilityBasis, startTurnSequence, turnSequenceScopeOf, type TurnEligibility,
} from '../../../server/src/games/core/turnSequence.js';
import type { ProjectionAudience } from '../../../server/src/games/core/visibility.js';
import { DICE_CONFIG_FIVE_D6_HOLD, DICE_CONFIG_SINGLE_D6, type DiceRelease } from '@quiz/shared/dice';

const port = Number(process.argv[2] ?? 5196);
const SLUG = 'n9-harness';
const TEAMS = [{ teamId: 'T1', members: ['A', 'B'] }, { teamId: 'T2', members: ['C', 'D', 'E'] }];
const AUDIENCES: Record<string, ProjectionAudience> = {
  A: { role: 'PLAYER', participantId: 'A', teamId: 'T1' }, B: { role: 'PLAYER', participantId: 'B', teamId: 'T1' }, C: { role: 'PLAYER', participantId: 'C', teamId: 'T2' },
  D: { role: 'PLAYER', participantId: 'D', teamId: 'T2' }, E: { role: 'PLAYER', participantId: 'E', teamId: 'T2' }, VIEWER: { role: 'VIEWER' }, DISPLAY: { role: 'DISPLAY' }, HOST: { role: 'HOST' },
};
const DEFAULT_RELEASE: Record<string, DiceRelease> = { A: 'VALUES', B: 'VALUES', C: 'VALUES', D: 'VALUES', E: 'VALUES', VIEWER: 'VALUES', DISPLAY: 'VALUES', HOST: 'VALUES' };

let db: PrismaClient;
let roomId = '';
let hostId = '';
let definitionId = '';
let config = DICE_CONFIG_FIVE_D6_HOLD as typeof DICE_CONFIG_FIVE_D6_HOLD;
let eligibilityVersion = 1;
let release: Record<string, DiceRelease> = { ...DEFAULT_RELEASE };
let paused = false;
let scripted: number[] = [];
let draws = 0;
let log: Array<{ kind: string; recipient: string; ok: boolean; code?: string; replayed?: boolean }> = [];

const source: DiceIntSource = (min, max) => { draws++; return scripted.length > 0 ? (scripted.shift() as number) : randomInt(min, max); };
const elig = (version = eligibilityVersion): TurnEligibility => ({
  actors: { runIndex: 1, trackId: 'teams-track', rosterRevision: 'track-roster-1', version, knownIds: ['T1', 'T2'], activeIds: ['T1', 'T2'] },
  members: { runIndex: 1, trackId: 'members-track', rosterRevision: 'track-roster-1', version, knownIds: ['A', 'B', 'C', 'D', 'E'], activeIds: ['A', 'B', 'C', 'D', 'E'] },
});

interface StandIn { phase: string; standIn: boolean; turnSequence: unknown; dice: unknown }
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

async function createRoom(): Promise<void> {
  const count = await db.room.count();
  const code = String(960000 + count).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'N9 harness', hostUserId: hostId, gameDefinitionId: definitionId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE', viewerRequiresPin: false } });
  roomId = room.id;
  eligibilityVersion = 1;
  const prepared = prepareTurnSequence({ runIndex: 1, sequenceId: `seq-${count + 1}`, rosterRevision: 'roster-1', unit: 'TEAM', mode: 'FIXED', order: ['T1', 'T2'], teams: TEAMS });
  const seq = startTurnSequence(prepared, { scope: turnSequenceScopeOf(prepared), expectedVersion: 0, eligibility: elig() }).state;
  const dice = openDiceTurn({ scope: turnSequenceScopeOf(seq), diceId: `dice-t${seq.turnNumber}-${count + 1}`, config, sequence: seq, expectedTurnNumber: seq.turnNumber });
  await db.roomGameState.create({ data: { roomId, engineVersion: 1, phase: 'ROUND_ACTIVE', revision: 4, stateJson: JSON.stringify({ phase: 'ROUND_ACTIVE', standIn: true, turnSequence: seq, dice }) } });
}

/** What the SERVER really holds, read back from the database (a label or a sent command proves nothing). */
async function view(): Promise<Record<string, unknown>> {
  const stored = await load();
  const seq = parseTurnSequenceState(stored.state.turnSequence);
  const dice = parseDiceTurnState(stored.state.dice);
  const holder = seq.phase === 'ACTIVE' || seq.phase === 'HELD' ? (seq.unit === 'TEAM' ? `${seq.teams![seq.position!].teamId}/${seq.teams![seq.position!].members[seq.memberIndex!]}` : seq.order[seq.position!]) : null;
  return {
    revision: stored.revision, turnNumber: seq.turnNumber, sequenceVersion: seq.version, sequenceId: seq.sequenceId, holder, basisVersion: seq.eligibility?.actors.version ?? null, dice,
    draws, paused, release, scripted: scripted.length, log,
    receipts: await db.commandReceipt.count({ where: { roomId } }), events: await db.gameDomainEvent.count({ where: { roomId } }), rooms: await db.room.count(),
  };
}

/** The recipient's own intent: authorise through the real checks (identity from the server-side table, NOT from the body), draw last, commit atomically. */
async function intent(body: { kind: 'ROLL' | 'HOLD'; recipient: string; commandId: string; intent: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const audience = AUDIENCES[body.recipient];
  if (!audience) throw new Error('unknown recipient');
  const label = body.kind.toLowerCase();
  try {
    const result = await runReceipted(db, {
      roomId, commandId: String(body.commandId), actor: { actorId: body.recipient, actorRole: audience.role }, action: 'ROUND_ADVANCE', // a STAND-IN action name (CRITICAL_COMMAND_ACTIONS is a closed whitelist; the real consumer adds its own dice actions) payload: body.intent,
      mutate: async () => {
        const loaded = await load();
        const seq = parseTurnSequenceState(loaded.state.turnSequence), dice = parseDiceTurnState(loaded.state.dice);
        const parsed = body.kind === 'ROLL' ? readDiceRollIntent(body.intent) : readDiceHoldIntent(body.intent);
        const common = {
          scope: turnSequenceScopeOf(seq), diceId: dice.diceId, sequence: seq, expectedTurnNumber: parsed.turnNumber, expectedSequenceVersion: parsed.sequenceVersion, expectedVersion: parsed.diceVersion, expectedRollCount: parsed.rollCount,
          caller: { role: audience.role as 'PLAYER', participantId: audience.participantId ?? 'none', teamId: audience.teamId ?? null }, gate: { admitted: true, phaseOpen: true, paused }, eligibility: elig(),
        };
        const done = body.kind === 'ROLL' ? rollDice(dice, { ...common, source }) : setDiceHeld(dice, { ...common, held: (parsed as { held: number[] }).held });
        const nextSeq = done.sequenceBasisAdvanced ? refreshEligibilityBasis(seq, { scope: turnSequenceScopeOf(seq), expectedVersion: seq.version, eligibility: elig() }).state : seq;
        if (done.changed || nextSeq !== seq) await persist(loaded, { ...loaded.state, turnSequence: nextSeq, dice: done.state }, body.kind === 'ROLL' ? 'DICE_ROLLED' : 'DICE_HELD');
        return { values: done.state.values, rollCount: done.state.rollCount, diceVersion: done.state.version, changed: done.changed };
      },
      toResponse: data => ({ success: true, ...data }),
    });
    log.push({ kind: label, recipient: body.recipient, ok: result.success, replayed: result.replayed, code: result.success ? undefined : result.error });
    return result.success ? { ok: true, replayed: result.replayed, ...(result.data as object) } : { ok: false, replayed: result.replayed, code: result.error };
  } catch (error) {
    const code = (error as { code?: string }).code ?? String((error as Error).message);
    log.push({ kind: label, recipient: body.recipient, ok: false, code });
    return { ok: false, code };
  }
}

/** Server-side moves of the CONSUMER (turn change, override, N6 basis update): each is ONE commit. Not reachable by a player. */
async function host(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const loaded = await load();
  const seq = parseTurnSequenceState(loaded.state.turnSequence), dice = parseDiceTurnState(loaded.state.dice);
  const scope = turnSequenceScopeOf(seq);
  const closeOld = () => closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version });
  const nextProcess = (next: typeof seq) => openDiceTurn({ scope: turnSequenceScopeOf(next), diceId: `dice-t${next.turnNumber}-${Date.now() % 100000}`, config, sequence: next, expectedTurnNumber: next.turnNumber });
  switch (body.type) {
    case 'reset': if (body.single === true) config = DICE_CONFIG_SINGLE_D6 as never; else config = DICE_CONFIG_FIVE_D6_HOLD; release = { ...DEFAULT_RELEASE }; paused = false; scripted = []; draws = 0; log = []; await createRoom(); return { ok: true, ...(await view()) };
    case 'endTurn': {
      const next = advanceTurnSequence(seq, { scope, expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: elig() }).state;
      closeOld();
      await persist(loaded, { ...loaded.state, turnSequence: next, dice: nextProcess(next) }, 'TURN_CHANGED');
      return { ok: true, ...(await view()) };
    }
    case 'endTurnN8Only': { // a CONSUMER BUG on purpose: the sequence moves on, the stored dice process is NOT closed or replaced — the dice module must still refuse the old process
      const next = advanceTurnSequence(seq, { scope, expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, outcome: 'COMPLETE', eligibility: elig() }).state;
      await persist(loaded, { ...loaded.state, turnSequence: next }, 'TURN_CHANGED_WITHOUT_DICE');
      return { ok: true, ...(await view()) };
    }
    case 'override': {
      const next = overrideTurnSequence(seq, { scope, expectedVersion: seq.version, expectedTurnNumber: seq.turnNumber, target: { teamId: String(body.teamId), playerId: String(body.playerId) }, eligibility: elig(), now: Date.now(), reason: 'harness' }).state;
      closeOld();
      await persist(loaded, { ...loaded.state, turnSequence: next, dice: nextProcess(next) }, 'TURN_OVERRIDDEN');
      return { ok: true, ...(await view()) };
    }
    case 'basis': { // the consumer saw a NEWER N6 stand: the sequence records it (version +1, no new turn); the dice are not part of this step
      eligibilityVersion += 1;
      const next = refreshEligibilityBasis(seq, { scope, expectedVersion: seq.version, eligibility: elig() }).state;
      await persist(loaded, { ...loaded.state, turnSequence: next }, 'TURN_BASIS');
      return { ok: true, ...(await view()) };
    }
    case 'closeDice': { const closed = closeDiceTurn(dice, { scope: diceTurnScopeOf(dice), diceId: dice.diceId, expectedTurnNumber: dice.binding.turnNumber, expectedVersion: dice.version }); await persist(loaded, { ...loaded.state, dice: closed.state }, 'DICE_CLOSED'); return { ok: true, ...(await view()) }; }
    case 'pause': paused = body.on === true; return { ok: true, ...(await view()) };
    case 'release': release[String(body.recipient)] = body.release as DiceRelease; return { ok: true, ...(await view()) };
    case 'script': scripted = (body.values as number[]).slice(); return { ok: true, ...(await view()) };
    default: throw new Error('unknown host command');
  }
}

async function projection(recipient: string): Promise<unknown> {
  const stored = await load();
  const seq = parseTurnSequenceState(stored.state.turnSequence), dice = parseDiceTurnState(stored.state.dice);
  return projectDiceTurn(AUDIENCES[recipient], dice, { scope: turnSequenceScopeOf(seq), sequence: seq, release: release[recipient] ?? 'NONE', stateVersion: stored.revision });
}

const send = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req: http.IncomingMessage) => new Promise<string>(resolve => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); });

async function main(): Promise<void> {
  const dir = process.env.HARNESS_DIR ?? await mkdtemp(join(tmpdir(), 'quiz-n9-harness-'));
  const file = join(dir, 'test.db');
  const fresh = !existsSync(file);
  const url = `file:${file}`;
  if (fresh) await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: singleConnectionSqliteUrl(url) });
  await db.$connect();
  (globalThis as { __prisma?: PrismaClient }).__prisma = db;
  if (fresh) {
    hostId = (await db.user.create({ data: { displayName: 'N9 harness host', role: 'HOST', passwordHash: 'unused' } })).id;
    definitionId = (await db.gameDefinition.create({ data: { slug: SLUG, name: 'n9 harness', category: 'test', status: 'BETA', minPlayers: 2 } })).id;
    await createRoom();
  } else { // a RESTART on the same database: the stored state is all there is; nothing is re-created, re-drawn or invented
    hostId = (await db.user.findFirstOrThrow()).id;
    definitionId = (await db.gameDefinition.findFirstOrThrow({ where: { slug: SLUG } })).id;
    roomId = (await db.room.findFirstOrThrow({ orderBy: { code: 'desc' } })).id;
    const stored = parseTurnSequenceState((await load()).state.turnSequence);
    eligibilityVersion = stored.eligibility?.actors.version ?? 1; // the committed basis, not a freshly minted higher value
    config = parseDiceTurnState((await load()).state.dice).config.maxRolls === 1 ? (DICE_CONFIG_SINGLE_D6 as never) : DICE_CONFIG_FIVE_D6_HOLD;
  }
  http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/api/state') return send(res, 200, await view());
      if (u.pathname === '/api/context') {
        const recipient = u.searchParams.get('recipient') ?? 'VIEWER';
        const stored = await load();
        return send(res, 200, { scope: turnSequenceScopeOf(parseTurnSequenceState(stored.state.turnSequence)), recipientId: AUDIENCES[recipient]?.participantId ?? null });
      }
      if (u.pathname === '/api/projection') return send(res, 200, await projection(u.searchParams.get('recipient') ?? 'VIEWER'));
      if (u.pathname === '/api/host' && req.method === 'POST') return send(res, 200, await host(JSON.parse(await readBody(req))));
      if (u.pathname === '/api/intent' && req.method === 'POST') return send(res, 200, await intent(JSON.parse(await readBody(req))));
      res.writeHead(404); res.end();
    } catch (error) { send(res, 400, { error: String((error as Error).message) }); }
  // eslint-disable-next-line no-console -- test-only harness: the check script waits for this port
  }).listen(port, '127.0.0.1', () => console.log(`n9 harness backend on ${port}`));
}
// eslint-disable-next-line no-console -- test-only harness: a failed start must be visible
main().catch(error => { console.error(error); process.exit(1); });
