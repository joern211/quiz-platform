// TEST-ONLY backend for the N10 bidding harness. It binds the REAL server domain (biddingPhase.ts, turnSequence.ts) to a tiny HTTP API so that several real Chromium
// contexts receive the projection of ONE bidding, and it keeps the AUTHORITATIVE state in a REAL SQLite file (real migrations, the real receipt table through
// `runReceipted`, the real CAS `saveGameStateIfRevision`, the real state event through `materializeGameEvent`). Every projection is made from what is READ BACK from that
// database; the browser check reads the stored bids, passes, leader and versions from it again. It is not a product endpoint, has no authentication and lives outside src/:
// it is never part of a build. The "recipient" stands in for the admitted session of a later consumer (identity and team come from the server-side table below, never
// from the request body); the real authentication/admission/phase checks are NOT exercised here. It is NOT an engine consumer.
// Run: node --import tsx apps/web/harness/n10-bidding/server.ts [port]     (HARNESS_DIR=<dir> keeps/reuses the database across restarts)
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
import {
  abortBidding, biddingActionArgsFromIntent, biddingResultBasisOf, biddingScopeOf, biddingTurnSequenceInput, openBidding, parseBiddingState, passBidding, placeBid, prepareBiddingPhase,
  projectBidding, readBiddingBidIntent, readBiddingPassIntent, refreshBiddingBasis, withholdBiddingHolder,
} from '../../../server/src/games/core/biddingPhase.js';
import { currentTurnHolder, parseTurnSequenceState, prepareTurnSequence, startTurnSequence, turnSequenceScopeOf, type TurnEligibility } from '../../../server/src/games/core/turnSequence.js';
import type { ProjectionAudience } from '../../../server/src/games/core/visibility.js';
import { BIDDING_NUMERIC_POSITIVE_INTEGER, type BiddingRelease } from '@quiz/shared/bidding';

const port = Number(process.argv[2] ?? 5206);
const SLUG = 'n10-harness';
const CATEGORY = 'Hauptstädte Europas'; // a distinctive label: the check searches the DOM and the received JSON of every non-bidder for it
const BASE_TEAMS = [{ teamId: 'T1', bidderId: 'b1', performerId: 'p1' }, { teamId: 'T2', bidderId: 'b2', performerId: 'p2' }, { teamId: 'T3', bidderId: 'b3', performerId: 'p3' }];
let teams = BASE_TEAMS.map(t => ({ ...t }));
/** The session table of this harness (who a recipient IS, and the information role). HOSTP = a HOST audience that plays as the performer of T3. */
const audienceOf = (recipient: string): ProjectionAudience | undefined => {
  const t = (id: string) => teams.find(x => x.bidderId === id || x.performerId === id);
  const player = (id: string): ProjectionAudience => ({ role: 'PLAYER', participantId: id, teamId: t(id)?.teamId ?? null });
  const table: Record<string, ProjectionAudience> = {
    B1: player('b1'), B2: player('b2'), B3: player('b3'), P1: player('p1'), P2: player('p2'), P3: player('p3'),
    VIEWER: { role: 'VIEWER' }, DISPLAY: { role: 'DISPLAY' }, HOST: { role: 'HOST', participantId: 'host-1' }, HOSTP: { role: 'HOST', participantId: 'p3', teamId: 'T3' },
  };
  return table[recipient];
};
const RECIPIENTS = ['B1', 'B2', 'B3', 'P1', 'P2', 'P3', 'VIEWER', 'DISPLAY', 'HOST', 'HOSTP'];
/** The server's explicit choice per audience: a pinned bidder (whatever the label of the recipient) gets the standing, any other player — and a host who plays — only the neutral packet. */
const releaseFor = (recipient: string): BiddingRelease => {
  const audience = audienceOf(recipient);
  if (!audience || recipient === 'HOSTP') return 'NEUTRAL';
  if (audience.role === 'PLAYER') return teams.some(t => t.bidderId === audience.participantId) ? 'STANDING' : 'NEUTRAL';
  return 'STANDING';
};

let db: PrismaClient;
let roomId = '';
let hostId = '';
let definitionId = '';
let eligibilityVersion = 1;
let runIndex = 1;
let roundId = 'round-1';
let biddingId = 'bidding-1';
let sequenceId = 'seq-1';
let rosterRevision = 'roster-1';
let rolesRevision = 'roles-1';
let offPeople: string[] = [];
let paused = false;
const log: Array<{ kind: string; recipient: string; ok: boolean; code?: string; replayed?: boolean }> = [];

const elig = (version = eligibilityVersion, off: string[] = offPeople): TurnEligibility => {
  const people = teams.flatMap(t => [t.bidderId, t.performerId]);
  return {
    actors: { runIndex, trackId: 'teams-track', rosterRevision: 'track-roster-1', version, knownIds: teams.map(t => t.teamId), activeIds: teams.map(t => t.teamId) },
    members: { runIndex, trackId: 'members-track', rosterRevision: 'track-roster-1', version, knownIds: people, activeIds: people.filter(id => !off.includes(id)) },
  };
};

interface StandIn { phase: string; standIn: boolean; turnSequence: unknown; bidding: unknown }
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
  const code = String(970000 + count).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'N10 harness', hostUserId: hostId, gameDefinitionId: definitionId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE', viewerRequiresPin: false } });
  roomId = room.id;
  eligibilityVersion = 1; offPeople = []; paused = false;
  const prepared = prepareBiddingPhase({ runIndex, roundId, biddingId, sequenceId, rosterRevision, category: CATEGORY, numeric: { ...BIDDING_NUMERIC_POSITIVE_INTEGER, unit: { label: 'Städte', factor: 1 } }, roles: { source: 'RAW', rolesRevision, teams } }); // RAW: the harness's table is its own source of roles
  const first = prepareTurnSequence(biddingTurnSequenceInput(prepared));
  const seq = startTurnSequence(first, { scope: turnSequenceScopeOf(first), expectedVersion: 0, eligibility: elig() }).state;
  const bidding = openBidding(prepared, { scope: biddingScopeOf(prepared), expectedVersion: 0, sequence: seq }).state;
  await db.roomGameState.create({ data: { roomId, engineVersion: 1, phase: 'ROUND_ACTIVE', revision: 4, stateJson: JSON.stringify({ phase: 'ROUND_ACTIVE', standIn: true, turnSequence: seq, bidding }) } });
}

/** What the SERVER really holds, read back from the database (a label or a sent command proves nothing). */
async function view(): Promise<Record<string, unknown>> {
  const stored = await load();
  const seq = parseTurnSequenceState(stored.state.turnSequence);
  const bidding = parseBiddingState(stored.state.bidding);
  const holder = currentTurnHolder(seq);
  return {
    revision: stored.revision, scope: biddingScopeOf(bidding), sequenceScope: turnSequenceScopeOf(seq), turnNumber: seq.turnNumber, sequenceVersion: seq.version, sequencePhase: seq.phase,
    holder: holder === null ? null : `${holder.teamId}/${holder.playerId}`, basisVersion: seq.eligibility?.actors.version ?? null, completedTurns: seq.completedTurns,
    members: seq.teams?.map(t => t.members) ?? null, cursors: seq.teams?.map(t => t.cursor) ?? null,
    bidding: { phase: bidding.phase, version: bidding.version, stepCount: bidding.stepCount, leader: bidding.leader, passed: bidding.passedTeamIds, endReason: bidding.endReason, result: bidding.result, history: bidding.history },
    resultBasis: biddingResultBasisOf(bidding), teams, paused, release: Object.fromEntries(RECIPIENTS.map(r => [r, releaseFor(r)])), log,
    receipts: await db.commandReceipt.count({ where: { roomId } }), events: await db.gameDomainEvent.count({ where: { roomId } }), rooms: await db.room.count(),
  };
}

/** The recipient's own intent: authorise through the real checks (identity from the server-side table, NOT from the body), commit bidding AND sequence atomically. */
async function intent(body: { kind: 'BID' | 'PASS'; recipient: string; commandId: string; intent: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const audience = audienceOf(body.recipient);
  if (!audience) throw new Error('unknown recipient');
  const label = body.kind.toLowerCase();
  try {
    const result = await runReceipted(db, {
      roomId, commandId: String(body.commandId), actor: { actorId: body.recipient, actorRole: audience.role === 'HOST' ? 'HOST' : 'PLAYER' },
      // a STAND-IN action name (CRITICAL_COMMAND_ACTIONS is a closed whitelist; the real consumer adds its own bidding actions) — bid and pass therefore share it, so the PAYLOAD
      // must tell them apart: the semantic operation and the complete intent (origin + counters + team + value)
      action: 'ROUND_ADVANCE',
      payload: { kind: body.kind, intent: body.intent },
      mutate: async () => {
        const loaded = await load();
        const seq = parseTurnSequenceState(loaded.state.turnSequence), bidding = parseBiddingState(loaded.state.bidding);
        const parsed = body.kind === 'BID' ? readBiddingBidIntent(body.intent) : readBiddingPassIntent(body.intent);
        const bidValue = 'value' in parsed ? parsed.value : undefined;
        // the ORIGIN (target + team + counters) comes from the INTENT; only the trusted facts come from the loaded state and the table of this harness
        const common = {
          ...biddingActionArgsFromIntent(parsed), sequence: seq,
          caller: { role: audience.role as 'PLAYER', participantId: audience.participantId ?? 'none', teamId: audience.teamId ?? null }, gate: { admitted: true, phaseOpen: true, paused }, eligibility: elig(), nowMs: Date.now(),
        };
        const done = body.kind === 'BID' ? placeBid(bidding, { ...common, value: bidValue }) : passBidding(bidding, common);
        await persist(loaded, { ...loaded.state, turnSequence: done.sequence, bidding: done.state }, body.kind === 'BID' ? 'BID_PLACED' : 'BID_PASSED');
        return { version: done.state.version, phase: done.state.phase };
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

/** Server-side moves of the CONSUMER (new bidding, abort, role failure, N6 basis update, pause): each is ONE commit. Not reachable by a player. */
async function host(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const loaded = await load();
  const seq = parseTurnSequenceState(loaded.state.turnSequence), bidding = parseBiddingState(loaded.state.bidding);
  const scope = biddingScopeOf(bidding);
  switch (body.type) {
    case 'reset': { // a NEW bidding (rematch, next round, new roster, rotated roles): a NEW room state, same local counters, same participants
      runIndex = typeof body.runIndex === 'number' ? body.runIndex : 1;
      roundId = typeof body.roundId === 'string' ? body.roundId : 'round-1';
      biddingId = typeof body.biddingId === 'string' ? body.biddingId : 'bidding-1';
      sequenceId = typeof body.sequenceId === 'string' ? body.sequenceId : 'seq-1';
      rosterRevision = typeof body.rosterRevision === 'string' ? body.rosterRevision : 'roster-1';
      rolesRevision = typeof body.rolesRevision === 'string' ? body.rolesRevision : 'roles-1';
      teams = body.rotate === true ? BASE_TEAMS.map(t => (t.teamId === 'T1' ? { teamId: 'T1', bidderId: 'p1', performerId: 'b1' } : { ...t })) : BASE_TEAMS.map(t => ({ ...t })); // the SAME participants, swapped roles in T1
      await createRoom();
      return { ok: true, ...(await view()) };
    }
    case 'abort': {
      const out = abortBidding(bidding, { scope, expectedVersion: bidding.version, expectedSequenceVersion: seq.version, sequence: seq, reason: body.reason === 'TECHNICAL_ABORT' ? 'TECHNICAL_ABORT' : 'HOST_ABORTED', gate: { abortAuthorized: true } });
      await persist(loaded, { ...loaded.state, turnSequence: out.sequence, bidding: out.state }, 'BIDDING_ABORTED');
      return { ok: true, ...(await view()) };
    }
    case 'withhold': { // the bidder on turn is no longer eligible (N6): HELD, nothing else
      const holder = currentTurnHolder(seq);
      offPeople = holder === null ? [] : [holder.playerId];
      eligibilityVersion += 1;
      const out = withholdBiddingHolder(bidding, { scope, expectedVersion: bidding.version, expectedSequenceVersion: seq.version, expectedTurnNumber: seq.turnNumber, sequence: seq, eligibility: elig() });
      await persist(loaded, { ...loaded.state, turnSequence: out.sequence }, 'BIDDER_HELD');
      return { ok: true, ...(await view()) };
    }
    case 'basis': { // the consumer saw a NEWER N6 stand: the sequence records it (version +1, no new turn); the bids are not part of this step
      eligibilityVersion += 1;
      const out = refreshBiddingBasis(bidding, { scope, expectedVersion: bidding.version, expectedSequenceVersion: seq.version, sequence: seq, eligibility: elig() });
      await persist(loaded, { ...loaded.state, turnSequence: out.sequence }, 'BIDDING_BASIS');
      return { ok: true, ...(await view()) };
    }
    case 'pause': paused = body.on === true; return { ok: true, ...(await view()) };
    default: throw new Error('unknown host command');
  }
}

async function projection(recipient: string, override?: BiddingRelease | null): Promise<unknown> {
  const stored = await load();
  const seq = parseTurnSequenceState(stored.state.turnSequence), bidding = parseBiddingState(stored.state.bidding);
  const audience = audienceOf(recipient);
  if (!audience) throw new Error('unknown recipient');
  return projectBidding(audience, bidding, { scope: biddingScopeOf(bidding), sequence: seq, release: override ?? releaseFor(recipient), stateVersion: stored.revision });
}

const send = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req: http.IncomingMessage) => new Promise<string>(resolve => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); });

async function main(): Promise<void> {
  const dir = process.env.HARNESS_DIR ?? await mkdtemp(join(tmpdir(), 'quiz-n10-harness-'));
  const file = join(dir, 'test.db');
  const fresh = !existsSync(file);
  const url = `file:${file}`;
  if (fresh) await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: singleConnectionSqliteUrl(url) });
  await db.$connect();
  (globalThis as { __prisma?: PrismaClient }).__prisma = db;
  if (fresh) {
    hostId = (await db.user.create({ data: { displayName: 'N10 harness host', role: 'HOST', passwordHash: 'unused' } })).id;
    definitionId = (await db.gameDefinition.create({ data: { slug: SLUG, name: 'n10 harness', category: 'test', status: 'BETA', minPlayers: 2 } })).id;
    await createRoom();
  } else { // a RESTART on the same database: the stored state is all there is; nothing is re-created, re-bid or invented
    hostId = (await db.user.findFirstOrThrow()).id;
    definitionId = (await db.gameDefinition.findFirstOrThrow({ where: { slug: SLUG } })).id;
    roomId = (await db.room.findFirstOrThrow({ orderBy: { code: 'desc' } })).id;
    const stored = await load();
    const bidding = parseBiddingState(stored.state.bidding);
    const seq = parseTurnSequenceState(stored.state.turnSequence);
    runIndex = bidding.runIndex; roundId = bidding.roundId; biddingId = bidding.biddingId; sequenceId = bidding.binding.sequenceId; rosterRevision = bidding.binding.rosterRevision; rolesRevision = bidding.rolesRevision;
    teams = bidding.teams.map(t => ({ ...t }));
    eligibilityVersion = seq.eligibility?.actors.version ?? 1; // the committed basis, not a freshly minted higher value
  }
  http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/api/state') return send(res, 200, await view());
      if (u.pathname === '/api/released') return send(res, 200, Object.fromEntries(RECIPIENTS.map(r => [r, releaseFor(r)])));
      if (u.pathname === '/api/context') {
        const recipient = u.searchParams.get('recipient') ?? 'VIEWER';
        const stored = await load();
        return send(res, 200, { scope: biddingScopeOf(parseBiddingState(stored.state.bidding)), recipientId: audienceOf(recipient)?.role === 'PLAYER' || recipient === 'HOSTP' ? audienceOf(recipient)?.participantId ?? null : null, recipients: RECIPIENTS });
      }
      if (u.pathname === '/api/projection') {
        const wanted = u.searchParams.get('release');
        return send(res, 200, await projection(u.searchParams.get('recipient') ?? 'VIEWER', wanted === 'STANDING' || wanted === 'NEUTRAL' ? wanted : null));
      }
      if (u.pathname === '/api/host' && req.method === 'POST') return send(res, 200, await host(JSON.parse(await readBody(req))));
      if (u.pathname === '/api/intent' && req.method === 'POST') return send(res, 200, await intent(JSON.parse(await readBody(req))));
      res.writeHead(404); res.end();
    } catch (error) { send(res, 400, { error: (error as { code?: string }).code ?? String((error as Error).message) }); }
  // eslint-disable-next-line no-console -- test-only harness: the check script waits for this port
  }).listen(port, '127.0.0.1', () => console.log(`n10 harness backend on ${port}`));
}
// eslint-disable-next-line no-console -- test-only harness: a failed start must be visible
main().catch(error => { console.error(error); process.exit(1); });
