import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import { createApp } from '../../app.js';
import { createTestDatabase } from '../../test-helpers.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { socketIdentityMap } from '../../http/middleware/auth.js';
import { cancelGeoTimer, handleGeoGame } from '../geo/index.js';
import { createCommandIntentClient, type CommandEmitter } from '@quiz/shared';

let db: PrismaClient, previous: PrismaClient | undefined, dir: string, app: ReturnType<typeof createApp>, origin: string, cookie: string, hostId: string, questionIds: string[];
const sockets: Socket[] = [], roomIds: string[] = [];
let nextCode = 750000;
let failEventForRoom: string | undefined;
let failScoreEventNth: { roomId: string; nth: number } | undefined;
let failResultVersionOnce = false;
let questionOverride: string[] | undefined;
// Independent review probes; these are local tests, not product changes.
let reviewReads: string[] | null = null;
let reviewFailure: { model: string; roomId: string; error: Error } | null = null;
afterEach(() => vi.restoreAllMocks());
async function connect(auth?: string) { const s = await connectGameClient(origin, auth); sockets.push(s); return s; }
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-g4-')); const url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url); db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db;
  db.$use(async (params, next) => {
    if (reviewReads && params.action.startsWith('find')) reviewReads.push(`${params.model}.${params.action}`);
    if (reviewFailure && params.model === reviewFailure.model && params.action === 'create' && params.args.data.roomId === reviewFailure.roomId) {
      const failure = reviewFailure.error; reviewFailure = null; throw failure;
    }
    if (params.model === 'GameDomainEvent' && params.action === 'create' && params.args.data.roomId === failEventForRoom) {
      failEventForRoom = undefined; throw Error('G2_INJECTED_EVENT_FAILURE');
    }
    if ((params.model === 'GameResultVersion' || params.model === 'GameResultRecord') && params.action === 'create' && failResultVersionOnce) {
      failResultVersionOnce = false; throw Object.assign(Error('G4_INJECTED_SECRET_sk_live_0123456789abcdef'), { meta: { args: { rejoinToken: 'G4_INJECTED_SECRET_token', answer: 'sk_live_nested' } } });
    }
    if (params.model === 'ScoreEvent' && params.action === 'create' && failScoreEventNth?.roomId === params.args.data.roomId && --failScoreEventNth!.nth === 0) {
      failScoreEventNth = undefined; throw Error('G4_INJECTED_SCORE_FAILURE');
    }
    return next(params);
  });
  const user = await db.user.create({ data: { role: 'HOST', displayName: 'G4 Host', passwordHash: 'unused' } }); hostId = user.id;
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 3600000) } }); cookie = createSessionCookie(session.id, config.sessionSecret);
  for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA', minPlayers: 2 } });
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'G4' } });
  questionIds = [];
  for (let i = 0; i < 2; i++) { const q = await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'G4 question', category: 'G4', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }]), correctOptionId: 'a', durationMs: 600000 } }); questionIds.push(q.id); }
  app = createApp(); await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address(); if (!address || typeof address === 'string') throw Error('NO_PORT'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const id of roomIds) cancelGeoTimer(id); for (const s of sockets) s.disconnect();
  if (app) await new Promise<void>(resolve => app.io.close(() => resolve()));
  await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(i => roomIds.includes(i.roomId ?? ''))).toHaveLength(0), { timeout: 10000 });
  await db?.$disconnect(); globalThis.__prisma = previous; if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(slug: 'wissensduell' | 'jeopardy' | 'wer-ist-das' = 'jeopardy', running = true, openGeo = true, teamMode = false) {
  const game = await db.gameDefinition.findUniqueOrThrow({ where: { slug } });
  const code = String(nextCode++).replace(/(\d{3})(\d{3})/, '$1-$2');
  let setup: object = { selectedQuestionIds: questionOverride ?? questionIds, timerDuration: 600 };
  if (slug === 'jeopardy') setup = { board1: { categories: [{ name: 'G4', clues: [{ value: 100, question: 'Question', answer: 'G4_PRIVATE_SOLUTION' }, { value: 200, question: 'Question 2', answer: 'G4_PRIVATE_SECOND' }] }] } };
  if (slug === 'wer-ist-das') {
    const image = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'g1.png', originalName: 'g1.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/g1.png', uploadedBy: hostId } });
    setup = { rounds: [{ id: 'g1', imageAssetId: image.id, person1: 'G4_PRIVATE_A', person2: 'G4_PRIVATE_B' }, { id: 'g2-next', imageAssetId: image.id, person1: 'G4_PRIVATE_C', person2: 'G4_PRIVATE_D' }] };
  }
  const room = await db.room.create({ data: { code, roomName: 'G4', hostUserId: hostId, gameDefinitionId: game.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(setup) } }); roomIds.push(room.id);
  const host = await connect(cookie); expect((await gameAck(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
  const players = [];
  for (const name of (teamMode ? ['Alice', 'Bob', 'Cara', 'Dan'] : ['Alice', 'Bob'])) {
    const p = await db.participation.create({ data: { roomId: room.id, displayName: name, normalizedName: name.toLowerCase(), role: 'PLAYER', ready: true, rejoinToken: randomUUID() } });
    const client = await connect(); expect((await gameAck(client, 'room:subscribe', { roomCode: code, rejoinToken: p.rejoinToken })).success).toBe(true);
    await gameAck(client, 'player:ready:set', { roomCode: code, ready: true }); players.push({ ...p, client });
  }
  if (teamMode) {
    const teams = await Promise.all(['A', 'B'].map(name => db.roomTeam.create({ data: { roomId: room.id, name, color: '#2563eb', icon: name } })));
    await db.room.update({ where: { id: room.id }, data: { roomPolicyJson: JSON.stringify({ teamMode: 'MANUAL', teamCount: 2, allowTeamReshuffleBetweenRounds: true }) } });
    for (let i = 0; i < players.length; i++) await db.participation.update({ where: { id: players[i].id }, data: { teamId: teams[i < 2 ? 0 : 1].id } });
  }
  if (running) {
    const result = await gameAck(host, 'game:start', { roomCode: code, commandId: randomUUID() }); expect(result.success, JSON.stringify(result)).toBe(true);
    if (slug === 'wissensduell') {
      cancelGeoTimer(room.id);
      if (openGeo) await handleGeoGame.startRound(app.io, code);
    }
  }
  return { room, code, host, players };
}
async function evidence(roomId: string) {
  return { room: await db.room.findUniqueOrThrow({ where: { id: roomId } }), state: await db.roomGameState.findUnique({ where: { roomId } }),
    events: await db.gameDomainEvent.count({ where: { roomId } }), scores: await db.scoreEvent.count({ where: { roomId } }), receipts: await db.commandReceipt.count({ where: { roomId } }) };
}

/** A rejected command stores a failure receipt (replayable); every other persisted effect must stay identical. */
async function effects(roomId: string) { const { receipts: _receipts, ...rest } = await evidence(roomId); void _receipts; return rest; }

async function state(roomId: string) {
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } });
  return { row, value: JSON.parse(row.stateJson) };
}
const intent = (roomCode: string) => ({ roomCode, commandId: randomUUID() });

async function lateJoiner(roomId: string, code: string, role: 'PLAYER' | 'VIEWER', name: string, extra: Record<string, unknown> = {}) {
  const p = await db.participation.create({ data: { roomId, displayName: name, normalizedName: name.toLowerCase(), role, ready: true, rejoinToken: randomUUID(), ...extra } });
  const client = await connect(); expect((await gameAck(client, 'room:subscribe', { roomCode: code, rejoinToken: p.rejoinToken })).success).toBe(true);
  return { ...p, client };
}
async function ledger(roomId: string) { return (await db.scoreEvent.findMany({ where: { roomId }, orderBy: { createdAt: 'asc' } })).map(e => ({ participationId: e.participationId, delta: e.delta, kind: e.kind, runIndex: e.runIndex })); }

// ── G4 D: action limits on the real sockets ──────────────────────────────────
import { actionLimiter, ACTION_LIMITS } from './actionLimits.js';
const resyncOf = (slug: string) => slug === 'wissensduell' ? 'geo:resync' : slug === 'jeopardy' ? 'jeopardy:resync' : 'weristdas:resync';
/** One burst on the wire: all requests arrive before any token can refill. */
const spam = (client: Socket, count: number, make: () => object, event = 'geo:answer') =>
  Promise.all(Array.from({ length: count }, () => gameAck(client, event, make())));

it('Limits: normal fast play stays far below the budget, for every player of a shared connection', async () => {
  const f = await fixture('wissensduell');
  const results = await Promise.all(f.players.flatMap(p => [0, 1, 2, 3, 4].map(() => gameAck(p.client, 'geo:resync', { roomCode: f.code }))));
  expect(results.every(r => r.success === true)).toBe(true);
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
});

/** Puts one identity into the exhausted state without waiting on wall-clock refill (the wiring itself is proven by the burst test). */
const exhaust = (roomId: string, participantId: string, group: 'REQUEST' | 'PLAYER_INPUT' | 'READ' | 'REPLAY' | 'DENIED' = 'PLAYER_INPUT') => { while (actionLimiter.consume(roomId, participantId, group).ok); };

it('Limits: a real burst of fresh command ids is cut off with the contractual refusal, not by the engine', async () => {
  const f = await fixture('wissensduell'), [spammer] = f.players;
  const results = await spam(spammer.client, ACTION_LIMITS.PLAYER_INPUT.capacity + 30, () => ({ optionId: 'b', ...intent(f.code) }));
  const limited = results.filter(r => r.error === 'RATE_LIMITED');
  expect(results.filter(r => r.success === true)).toHaveLength(1);
  expect(limited.length).toBeGreaterThan(0);
  for (const r of limited) expect(r).toMatchObject({ success: false, code: 'RATE_LIMITED', messageKey: 'RATE_LIMITED', retryable: true, traceId: expect.any(String), details: { retryAfterMs: expect.any(Number) } });
  expect((await state(f.room.id)).value.roundStates[0].playerStates[spammer.id]).toMatchObject({ answered: true, selectedOptionId: 'b' });
});

it('Limits: an exhausted player is refused without any effect while the other player, the host and another room keep working', async () => {
  const f = await fixture('wissensduell'), other = await fixture('wissensduell'), [spammer, bystander] = f.players;
  exhaust(f.room.id, spammer.id);
  const before = await effects(f.room.id);
  expect(await gameAck(spammer.client, 'geo:answer', { optionId: 'b', ...intent(f.code) })).toMatchObject({ success: false, error: 'RATE_LIMITED' });
  expect(await effects(f.room.id)).toEqual(before);
  expect((await gameAck(bystander.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  expect((await gameAck(other.players[0].client, 'geo:answer', { optionId: 'a', ...intent(other.code) })).success).toBe(true);
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
});

it('Limits: more tabs, a reconnect or fresh command ids do not create a fresh budget', async () => {
  const f = await fixture('wissensduell'), [spammer] = f.players;
  exhaust(f.room.id, spammer.id);
  const tab = await connect(); expect((await gameAck(tab, 'room:subscribe', { roomCode: f.code, rejoinToken: spammer.rejoinToken })).success).toBe(true);
  expect(await gameAck(tab, 'geo:answer', { optionId: 'c', ...intent(f.code) })).toMatchObject({ success: false, error: 'RATE_LIMITED' });
  // the earlier connection of the same identity is replaced by the new one (device binding), it cannot act either
  expect((await gameAck(spammer.client, 'geo:answer', { optionId: 'c', ...intent(f.code) })).success).toBe(false);
  expect(await gameAck(tab, 'geo:resync', { roomCode: f.code })).toMatchObject({ success: true }); // another group: reading is separate
});

it('Limits: a retry of an accepted command is never refused, even with an empty budget; a refused intent leaves no receipt', async () => {
  const f = await fixture('wissensduell'), [spammer] = f.players, accepted = { optionId: 'b', ...intent(f.code) };
  expect((await gameAck(spammer.client, 'geo:answer', accepted)).success).toBe(true);
  exhaust(f.room.id, spammer.id);
  const refusedId = intent(f.code);
  expect(await gameAck(spammer.client, 'geo:answer', { optionId: 'c', ...refusedId })).toMatchObject({ error: 'RATE_LIMITED' });
  expect(await db.commandReceipt.count({ where: { roomId: f.room.id, commandId: refusedId.commandId } })).toBe(0);
  expect(await gameAck(spammer.client, 'geo:answer', accepted)).toMatchObject({ success: true, replayed: true });
});

it('Limits: refused commands are bounded per identity, malformed ones create no entries, sockets outside any room are not tracked', async () => {
  const f = await fixture('jeopardy'), viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Viewer');
  // a viewer may never judge: after a burst of refusals it is cut off without further database work or log lines
  const refusals = await spam(viewer.client, ACTION_LIMITS.DENIED.capacity + 40, () => ({ correct: true, ...intent(f.code) }), 'jeopardy:judge');
  expect(refusals.filter(r => r.error === 'RATE_LIMITED').length).toBeGreaterThan(0);
  expect(refusals.every(r => r.success === false)).toBe(true);
  // the host and the players are unaffected; a few malformed payloads are rejected before the per-action budgets
  // (they are packets for the admission stage only, so they create no further tracking entries)
  const before = actionLimiter.size();
  for (let i = 0; i < 15; i++) expect((await gameAck(f.host, 'jeopardy:judge', { correct: 'yes', ...intent(f.code) })).error).not.toBe('RATE_LIMITED');
  expect(actionLimiter.size()).toBe(before);
  expect((await gameAck(f.players[0].client, 'jeopardy:judge', { correct: true, ...intent(f.code) })).error).not.toBe('RATE_LIMITED');
  // a connection that never joined a room has no server-resolved identity: nothing is tracked for it
  const stranger = await connect(), tracked = actionLimiter.size();
  for (let i = 0; i < 40; i++) await gameAck(stranger, 'jeopardy:judge', { correct: true, ...intent(f.code) });
  expect(actionLimiter.size()).toBe(tracked);
});

it('Limits: replays of an own known command have their own bounded budget, separate from new intents', async () => {
  const f = await fixture('wissensduell'), [player] = f.players, accepted = { optionId: 'b', ...intent(f.code) };
  expect((await gameAck(player.client, 'geo:answer', accepted)).success).toBe(true);
  exhaust(f.room.id, player.id, 'PLAYER_INPUT');
  expect(await gameAck(player.client, 'geo:answer', accepted)).toMatchObject({ success: true, replayed: true });
  exhaust(f.room.id, player.id, 'REPLAY');
  expect(await gameAck(player.client, 'geo:answer', accepted)).toMatchObject({ success: false, error: 'RATE_LIMITED' });
  expect((await state(f.room.id)).value.roundStates[0].playerStates[player.id]).toMatchObject({ answered: true, selectedOptionId: 'b' });
});

it('Limits: resync reads are bounded per participant and do not touch the other participant', async () => {
  const f = await fixture('wer-ist-das'), [reader, other] = f.players;
  const reads = await spam(reader.client, ACTION_LIMITS.READ.capacity + 40, () => ({ roomCode: f.code }), resyncOf('wer-ist-das'));
  expect(reads.filter(r => r.error === 'RATE_LIMITED').length).toBeGreaterThan(0);
  expect(reads.filter(r => r.success === true).length).toBeGreaterThan(0);
  exhaust(f.room.id, reader.id, 'READ');
  expect(await gameAck(reader.client, 'weristdas:resync', { roomCode: f.code })).toMatchObject({ error: 'RATE_LIMITED' });
  expect((await gameAck(other.client, 'weristdas:resync', { roomCode: f.code })).success).toBe(true);
  expect((await gameAck(f.host, 'weristdas:resync', { roomCode: f.code })).success).toBe(true);
});

it('Limits: buzz spam of a player never stops the host from judging', async () => {
  const f = await fixture('wer-ist-das'), [alice] = f.players;
  expect((await gameAck(f.host, 'weristdas:buzzer:open', intent(f.code))).success).toBe(true);
  expect((await gameAck(alice.client, 'weristdas:buzz', intent(f.code))).success).toBe(true);
  exhaust(f.room.id, alice.id);
  expect(await gameAck(alice.client, 'weristdas:buzz', intent(f.code))).toMatchObject({ error: 'RATE_LIMITED' });
  expect((await gameAck(f.host, 'weristdas:judge', { result: 'WRONG', ...intent(f.code) })).success).toBe(true);
});

// ── G4 E: failure diagnostics ────────────────────────────────────────────────
/** Result commands carry the room code, run, revision and a typed operation. */
const resultCommand = (f: { code: string }, runIndex: number, resultRevision: number, operation: object) =>
  ({ roomCode: f.code, commandId: randomUUID(), protocolVersion: 1, runIndex, resultRevision, operation });
async function finishedGame(slug: 'wissensduell' | 'jeopardy' | 'wer-ist-das') {
  const f = await fixture(slug), [alice] = f.players;
  if (slug === 'wissensduell') {
    expect((await gameAck(alice.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
    expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  } else if (slug === 'jeopardy') {
    expect((await gameAck(f.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, ...intent(f.code) })).success).toBe(true);
    expect((await gameAck(alice.client, 'jeopardy:buzz', intent(f.code))).success).toBe(true);
    expect((await gameAck(f.host, 'jeopardy:judge', { correct: true, ...intent(f.code) })).success).toBe(true);
  } else {
    expect((await gameAck(f.host, 'weristdas:buzzer:open', intent(f.code))).success).toBe(true);
    expect((await gameAck(alice.client, 'weristdas:buzz', intent(f.code))).success).toBe(true);
    expect((await gameAck(f.host, 'weristdas:judge', { result: 'BOTH_CORRECT', ...intent(f.code) })).success).toBe(true);
  }
  expect((await gameAck(f.host, 'game:end', intent(f.code))).success).toBe(true);
  return f;
}
const logSpies: Array<{ mock: { calls: unknown[][] } }> = [];
const spyOnLogs = () => { logSpies.length = 0; for (const level of ['warn', 'error', 'info'] as const) logSpies.push(vi.spyOn(console, level)); };
const logLines = () => logSpies.flatMap(spy => spy.mock.calls).map(c => c.join(' '));

it('Errors: an unexpected result-write failure rolls back, answers with a trace id that finds the diagnostic line, and leaks nothing', async () => {
  const f = await finishedGame('wissensduell');
  const before = await effects(f.room.id), versions = await db.gameResultVersion.count();
  spyOnLogs();
  failResultVersionOnce = true;
  const failed = await gameAck(f.host, 'game:result:command', resultCommand(f, 1, 1, { type: 'REVIEW' }));
  expect(failed).toMatchObject({ success: false, code: 'INTERNAL_ERROR', traceId: expect.any(String) });
  expect(JSON.stringify(failed)).not.toMatch(/G4_INJECTED|sk_live/);
  const lines = logLines();
  expect(lines.filter(l => l.includes(String(failed.traceId))).some(l => l.includes('internalDetail'))).toBe(true); // the detail line carries the same trace id
  expect(lines.join('\n')).not.toMatch(/G4_INJECTED|sk_live/);
  expect(await effects(f.room.id)).toEqual(before);
  expect(await db.gameResultVersion.count()).toBe(versions);
  expect((await gameAck(f.host, 'game:result:command', resultCommand(f, 1, 1, { type: 'REVIEW' }))).success).toBe(true);
});

// ── G4 A/B/C: results, team scoring and corrections with all three consumers ──
/** Loosely typed read of a wire payload; assertions below state the exact shape. */
type ResultField = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Slug = 'wissensduell' | 'jeopardy' | 'wer-ist-das';
const SLUGS: Slug[] = ['wissensduell', 'jeopardy', 'wer-ist-das'];
const SECRET = /G4_PRIVATE_|correctOptionId|G4 question|"answer"/;
const readResult = (client: Socket, f: { code: string }, extra: object = {}) => gameAck(client, 'game:result:read', { roomCode: f.code, ...extra }) as Promise<{ success: boolean; data: Record<string, ResultField> }>;
async function httpResult(f: { code: string }, query = '') {
  const res = await fetch(`${origin}/api/v1/rooms/${f.code}/results${query}`, { headers: { Cookie: cookie } });
  return (await res.json()) as { success: boolean; data: Record<string, ResultField> };
}
async function totals(roomId: string, runIndex: number) {
  const out: Record<string, number> = {};
  for (const e of await db.scoreEvent.findMany({ where: { roomId, runIndex } })) out[e.participationId] = (out[e.participationId] ?? 0) + e.delta;
  return out;
}

/** Plays a game to its regular end (COMPLETED); returns the expected final scores. */
async function completedGame(slug: Slug, scoreless = false, teams = false) {
  const f = await fixture(slug, true, true, teams), [alice, bob] = f.players, ok = async (client: Socket, event: string, payload: object = {}) =>
    expect((await gameAck(client, event, { ...payload, ...intent(f.code) })).success, event).toBe(true);
  if (teams) await db.room.update({ where: { id: f.room.id }, data: { roomPolicyJson: JSON.stringify({ ...JSON.parse((await db.room.findUniqueOrThrow({ where: { id: f.room.id } })).roomPolicyJson!), scoring: 'TEAM_SCORE' }) } });
  let expected: Record<string, number>;
  if (slug === 'wissensduell') {
    if (!scoreless) await ok(alice.client, 'geo:answer', { optionId: 'a' });
    await ok(f.host, 'geo:reveal'); await ok(f.host, 'geo:next');
    if (!scoreless) await ok(bob.client, 'geo:answer', { optionId: 'b' });
    await ok(f.host, 'geo:reveal'); await ok(f.host, 'geo:next');
    expected = { ...Object.fromEntries(f.players.map(p => [p.id, 0])), [alice.id]: scoreless ? 0 : 100 };
  } else if (slug === 'jeopardy') {
    await ok(f.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 }); await ok(alice.client, 'jeopardy:buzz'); await ok(f.host, 'jeopardy:judge', { correct: true }); await ok(f.host, 'jeopardy:next');
    await ok(f.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 200 }); await ok(bob.client, 'jeopardy:buzz'); await ok(f.host, 'jeopardy:judge', { correct: false });
    // a wrong answer closes the whole team for the steal, so with teams the other team steals
    const stealer = teams ? f.players[2] : alice; await ok(stealer.client, 'jeopardy:steal:buzz'); await ok(f.host, 'jeopardy:steal:judge', { correct: true }); await ok(f.host, 'jeopardy:board:switch', { toBoard: 2 }); // last field of the only board ends the game
    expected = { ...Object.fromEntries(f.players.map(p => [p.id, 0])), [alice.id]: teams ? 100 : 200, [bob.id]: -100, ...(teams ? { [f.players[2].id]: 100 } : {}) };
  } else {
    await ok(f.host, 'weristdas:buzzer:open'); if (!scoreless) { await ok(alice.client, 'weristdas:buzz'); await ok(f.host, 'weristdas:judge', { result: 'BOTH_CORRECT' }); } else await ok(f.host, 'weristdas:reveal');
    await ok(f.host, 'weristdas:next');
    await ok(f.host, 'weristdas:buzzer:open'); if (!scoreless) { await ok(bob.client, 'weristdas:buzz'); await ok(f.host, 'weristdas:judge', { result: 'WRONG' }); }
    await ok(f.host, 'weristdas:reveal'); await ok(f.host, 'weristdas:next');
    expected = { ...Object.fromEntries(f.players.map(p => [p.id, 0])), [alice.id]: scoreless ? 0 : 3, [bob.id]: scoreless ? 0 : -1 };
  }
  expect((await db.room.findUniqueOrThrow({ where: { id: f.room.id } })).status).toBe('ENDED');
  return { ...f, expected };
}

it.each(SLUGS)('%s: score map, participant cache, ledger, stored result, rank and winners come from one evidence, over socket and HTTP', async slug => {
  const f = await completedGame(slug), [alice, bob] = f.players;
  expect((await state(f.room.id)).value.scores).toEqual(f.expected);
  expect(await totals(f.room.id, 1)).toMatchObject(Object.fromEntries(Object.entries(f.expected).filter(([, v]) => v !== 0)));
  for (const p of f.players) expect((await db.participation.findUniqueOrThrow({ where: { id: p.id } })).score).toBe(f.expected[p.id]);
  const viaSocket = await readResult(bob.client, f), viaHttp = await httpResult(f);
  expect(viaSocket.success).toBe(true); expect(viaHttp.success).toBe(true);
  const strip = ({ versions: _v, ...rest }: Record<string, unknown>) => JSON.parse(JSON.stringify(rest));
  expect(strip(viaSocket.data)).toEqual(strip(viaHttp.data));
  expect(viaSocket.data.scores.map((x: { participationId: string; rank: number; score: number }) => [x.participationId, x.rank, x.score])).toEqual([[alice.id, 1, f.expected[alice.id]], [bob.id, 2, f.expected[bob.id]]]);
  expect(viaSocket.data).toMatchObject({ winnerIds: [alice.id], resultRevision: 1, resultStatus: 'GAME_END', requiresReview: false, aborted: false, endReason: 'COMPLETED', runIndex: 1 });
  expect(JSON.stringify([viaSocket.data, viaHttp.data])).not.toMatch(SECRET);
});

it.each(['wissensduell', 'wer-ist-das'] as const)('%s: nobody scored — every player shares first place, all are winners, nothing is drawn at random', async slug => {
  const f = await completedGame(slug, true);
  const result = await readResult(f.host, f);
  expect(result.data.scores.map((x: { rank: number; score: number }) => [x.rank, x.score])).toEqual([[1, 0], [1, 0]]);
  expect(new Set(result.data.winnerIds)).toEqual(new Set(f.players.map(p => p.id)));
  expect(result.data).toMatchObject({ aborted: false, endReason: 'COMPLETED' });
});

it.each(SLUGS)('%s: a host abort keeps its end reason and the points, ranks them, and invents no winner', async slug => {
  const f = await fixture(slug), [alice] = f.players;
  if (slug === 'wissensduell') { await gameAck(alice.client, 'geo:answer', { optionId: 'a', ...intent(f.code) }); await gameAck(f.host, 'geo:reveal', intent(f.code)); }
  expect((await gameAck(f.host, 'game:end', intent(f.code))).success).toBe(true);
  const result = await readResult(f.host, f);
  expect(result.data).toMatchObject({ aborted: true, endReason: 'HOST_ABORTED', winnerIds: [], resultStatus: 'GAME_END' });
  expect(result.data.scores.map((x: { participationId: string; score: number }) => [x.participationId, x.score])).toEqual(
    slug === 'wissensduell' ? [[alice.id, 100], [f.players[1].id, 0]] : expect.any(Array));
  expect(await totals(f.room.id, 1)).toEqual(slug === 'wissensduell' ? { [alice.id]: 100 } : {});
});

it.each(SLUGS)('%s: a failing result write ends nothing — no GAME_END, no result row, no partial effect — and the retry ends once', async slug => {
  const f = await fixture(slug);
  const before = await effects(f.room.id);
  failResultVersionOnce = true;
  expect((await gameAck(f.host, 'game:end', intent(f.code))).success).toBe(false);
  expect(failResultVersionOnce).toBe(false); // the injected failure really happened at the result boundary
  expect(await effects(f.room.id)).toEqual(before);
  expect(await db.gameResultRecord.count({ where: { roomId: f.room.id } })).toBe(0);
  expect((await db.room.findUniqueOrThrow({ where: { id: f.room.id } })).status).toBe('RUNNING');
  expect((await gameAck(f.host, 'game:end', intent(f.code))).success).toBe(true);
  expect(await db.gameResultRecord.count({ where: { roomId: f.room.id } })).toBe(1);
  expect(await db.gameResultVersion.count({ where: { result: { roomId: f.room.id } } })).toBe(1);
});

const command = async (client: Socket, f: { code: string }, runIndex: number, resultRevision: number, operation: object) =>
  gameAck(client, 'game:result:command', resultCommand(f, runIndex, resultRevision, operation)) as Promise<Record<string, ResultField>>;
const versions = async (roomId: string, runIndex: number) => (await db.gameResultVersion.findMany({ where: { result: { roomId, runIndex } }, orderBy: { revision: 'asc' } })).map(v => [v.revision, v.kind]);

it.each(SLUGS)('%s TEAM_SCORE: team ranking, winner and caches use the same evidence; a later team change rewrites neither history nor corrections', async slug => {
  const f = await completedGame(slug, false, true), [alice, bob, cara, dan] = f.players;
  const [teamA, teamB] = await db.roomTeam.findMany({ where: { roomId: f.room.id }, orderBy: { name: 'asc' } });
  const a = f.expected[alice.id] + f.expected[bob.id], b = f.expected[cara.id] + f.expected[dan.id];
  expect(a).not.toBe(b);
  const ranked: Array<[string, number]> = ([[teamA.id, a], [teamB.id, b]] as Array<[string, number]>).sort((x, y) => y[1] - x[1]), winner = ranked[0][0];
  const first = await readResult(f.host, f);
  expect(first.data).toMatchObject({ scoring: 'TEAM_SCORE', winnerIds: [winner], aborted: false });
  expect(first.data.teams.map((t: { id: string; score: number; rank: number }) => [t.id, t.score, t.rank])).toEqual([[ranked[0][0], ranked[0][1], 1], [ranked[1][0], ranked[1][1], 2]]);
  expect((await db.roomTeam.findUniqueOrThrow({ where: { id: teamA.id } })).score).toBe(a);
  expect((await db.roomTeam.findUniqueOrThrow({ where: { id: teamB.id } })).score).toBe(b);
  // Alice changes team after the game: the stored result and its ledger rows stay where they were
  await db.participation.update({ where: { id: alice.id }, data: { teamId: teamB.id } });
  const after = await readResult(f.host, f);
  expect(after.data.teams).toEqual(first.data.teams); expect(after.data.scores).toEqual(first.data.scores); expect(after.data.winnerIds).toEqual([winner]);
  expect((await db.scoreEvent.findMany({ where: { roomId: f.room.id, participationId: alice.id } })).every(e => e.teamId === teamA.id)).toBe(true);
  // corrections follow the historical team of the origin / target
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  expect((await command(f.host, f, 1, 2, { type: 'ADJUST', participantId: bob.id, delta: 10, reason: 'Korrektur Bob' })).success).toBe(true);
  const origin = (await db.scoreEvent.findMany({ where: { roomId: f.room.id, participationId: alice.id }, orderBy: { createdAt: 'asc' } }))[0];
  expect((await command(f.host, f, 1, 3, { type: 'ROLLBACK', referenceEventId: origin.id, reason: 'Rücknahme Alice' })).success).toBe(true);
  const rolled = await db.scoreEvent.findFirstOrThrow({ where: { roomId: f.room.id, kind: 'ROLLBACK' } });
  expect(rolled).toMatchObject({ participationId: alice.id, teamId: teamA.id, delta: -origin.delta, referenceEventId: origin.id });
  const final = await readResult(f.host, f);
  expect(final.data.teams.map((t: { id: string; score: number }) => [t.id, t.score])).toEqual(([[teamA.id, a + 10 - origin.delta], [teamB.id, b]] as Array<[string, number]>).sort((x, y) => y[1] - x[1]));
  expect((await db.roomTeam.findUniqueOrThrow({ where: { id: teamA.id } })).score).toBe(a + 10 - origin.delta);
  expect((await db.roomTeam.findUniqueOrThrow({ where: { id: teamB.id } })).score).toBe(b);
  expect(await versions(f.room.id, 1)).toEqual([[1, 'GAME_ENDED'], [2, 'REVIEW'], [3, 'ADJUST'], [4, 'ROLLBACK']]);
  // an older revision stays readable and unchanged
  expect((await readResult(f.host, f, { revision: 1 })).data.teams).toEqual(first.data.teams);
});

it('Corrections: two corrections on one revision cannot both win; the ledger and the versions show exactly one', async () => {
  const f = await completedGame('wer-ist-das'), [, bob] = f.players;
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  const results = await Promise.all([5, 7].map(delta => command(f.host, f, 1, 2, { type: 'ADJUST', participantId: bob.id, delta, reason: `Korrektur ${delta}` })));
  expect(results.filter(r => r.success)).toHaveLength(1);
  expect(results.find(r => !r.success)).toMatchObject({ error: expect.stringMatching(/REVISION_CONFLICT|INVALID_PHASE|STATE_CONFLICT/) });
  expect((await ledger(f.room.id)).filter(e => e.kind === 'HOST_ADJUSTMENT')).toHaveLength(1);
  expect(await versions(f.room.id, 1)).toEqual([[1, 'GAME_ENDED'], [2, 'REVIEW'], [3, 'ADJUST']]);
  const stored = (await readResult(f.host, f)).data.scores.find((x: { participationId: string }) => x.participationId === bob.id).score;
  expect(stored).toBe(f.expected[bob.id] + (results[0].success ? 5 : 7));
});

it('Corrections: the same origin cannot be reversed twice, nor an event of another run or room', async () => {
  const f = await completedGame('jeopardy'), other = await completedGame('wer-ist-das');
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  const origin = (await db.scoreEvent.findMany({ where: { roomId: f.room.id }, orderBy: { createdAt: 'asc' } }))[0];
  expect((await command(f.host, f, 1, 2, { type: 'ROLLBACK', referenceEventId: origin.id, reason: 'zurück' })).success).toBe(true);
  expect(await command(f.host, f, 1, 3, { type: 'ROLLBACK', referenceEventId: origin.id, reason: 'nochmal' })).toMatchObject({ success: false, error: 'SCORE_EVENT_ALREADY_REVERSED' });
  const foreign = (await db.scoreEvent.findMany({ where: { roomId: other.room.id } }))[0];
  expect(await command(f.host, f, 1, 3, { type: 'ROLLBACK', referenceEventId: foreign.id, reason: 'fremd' })).toMatchObject({ success: false, error: 'SCORE_EVENT_NOT_FOUND' });
  expect(await command(f.host, f, 1, 3, { type: 'ADJUST', participantId: other.players[0].id, delta: 1, reason: 'fremder Spieler' })).toMatchObject({ success: false, error: 'PLAYER_NOT_IN_GAME' });
  expect(await versions(f.room.id, 1)).toEqual([[1, 'GAME_ENDED'], [2, 'REVIEW'], [3, 'ROLLBACK']]);
  expect(await totals(other.room.id, 1)).toMatchObject({ [other.players[0].id]: 3 });
});

it('Corrections: a failing write after the score and cache writes leaves points, team cache, state and result exactly as they were', async () => {
  const f = await completedGame('wissensduell', false, true), [alice] = f.players;
  const [teamA] = await db.roomTeam.findMany({ where: { roomId: f.room.id }, orderBy: { name: 'asc' } });
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  const snapshot = async () => ({ state: (await db.roomGameState.findUniqueOrThrow({ where: { roomId: f.room.id } })).stateJson, ledger: await ledger(f.room.id),
    participants: (await db.participation.findMany({ where: { roomId: f.room.id }, orderBy: { id: 'asc' } })).map(p => [p.id, p.score]),
    team: (await db.roomTeam.findUniqueOrThrow({ where: { id: teamA.id } })).score, room: (await db.room.findUniqueOrThrow({ where: { id: f.room.id } })).revision,
    versions: await versions(f.room.id, 1), record: (await db.gameResultRecord.findFirstOrThrow({ where: { roomId: f.room.id } })).revision });
  const before = await snapshot();
  failResultVersionOnce = true;
  const failed = await command(f.host, f, 1, 2, { type: 'ADJUST', participantId: alice.id, delta: 25, reason: 'scheitert' });
  expect(failed).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
  expect(failResultVersionOnce).toBe(false);
  expect(await snapshot()).toEqual(before);
  expect((await command(f.host, f, 1, 2, { type: 'ADJUST', participantId: alice.id, delta: 25, reason: 'zweiter Versuch' })).success).toBe(true);
  expect((await ledger(f.room.id)).filter(e => e.kind === 'HOST_ADJUSTMENT')).toHaveLength(1);
  expect((await db.roomTeam.findUniqueOrThrow({ where: { id: teamA.id } })).score).toBe(before.team + 25);
});

it('Corrections: amending run one while run two is playing, and after it ended, changes nothing of run two', async () => {
  const f = await completedGame('wissensduell'), [alice, bob] = f.players;
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  expect((await command(f.host, f, 1, 2, { type: 'FINALIZE' })).success).toBe(true);
  expect((await gameAck(f.host, 'room:command', { ...intent(f.code), protocolVersion: 1, operation: { type: 'REMATCH' } })).success).toBe(true);
  for (const p of f.players) expect((await gameAck(p.client, 'player:ready:set', { roomCode: f.code, ready: true })).success).toBe(true);
  expect((await gameAck(f.host, 'game:start', intent(f.code))).success).toBe(true);
  cancelGeoTimer(f.room.id); await handleGeoGame.startRound(app.io, f.code);
  expect((await gameAck(bob.client, 'geo:answer', { optionId: 'a', questionIndex: 0, runIndex: 2, ...intent(f.code) })).success).toBe(true);
  const run2 = async () => ({ state: (await db.roomGameState.findUniqueOrThrow({ where: { roomId: f.room.id } })).stateJson,
    room: await db.room.findUniqueOrThrow({ where: { id: f.room.id } }), players: (await db.participation.findMany({ where: { roomId: f.room.id }, orderBy: { id: 'asc' } })).map(p => [p.id, p.score, p.teamId]),
    run2Ledger: (await ledger(f.room.id)).filter(e => e.runIndex === 2) });
  const before = await run2();
  const amended = await command(f.host, f, 1, 3, { type: 'AMEND', participantId: bob.id, delta: 50, reason: 'Nachtrag Partie 1' });
  expect(amended).toMatchObject({ success: true, resultStatus: 'FINALIZED' });
  expect(await run2()).toEqual(before);
  expect((await readResult(f.host, f, { runIndex: 1 })).data.scores.find((x: { participationId: string }) => x.participationId === bob.id).score).toBe(50);
  expect(await versions(f.room.id, 1)).toEqual([[1, 'GAME_ENDED'], [2, 'REVIEW'], [3, 'FINALIZE'], [4, 'RESULT_AMENDMENT']]);
  // run two ends: its result never includes the amendment, run one stays amended, older revisions stay readable
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'game:end', intent(f.code))).success).toBe(true);
  const second = await readResult(f.host, f, { runIndex: 2 });
  expect(second.data.scores.map((x: { participationId: string; score: number }) => [x.participationId, x.score]).sort()).toEqual([[alice.id, 0], [bob.id, 100]].sort());
  expect(await command(f.host, f, 1, 4, { type: 'AMEND', participantId: alice.id, delta: 5, reason: 'noch ein Nachtrag' })).toMatchObject({ success: true });
  expect((await readResult(f.host, f, { runIndex: 2 })).data.scores.find((x: { participationId: string }) => x.participationId === alice.id).score).toBe(0);
  expect((await readResult(f.host, f, { runIndex: 1, revision: 2 })).data.resultStatus).toBe('FINALIZED');
  expect((await readResult(f.host, f, { runIndex: 1, revision: 1 })).data.scores.find((x: { participationId: string }) => x.participationId === bob.id).score).toBe(0);
});

it('Results: the view says what each revision was and which one is current, so history cannot pass for the live status', async () => {
  const f = await completedGame('wissensduell');
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  expect((await command(f.host, f, 1, 2, { type: 'FINALIZE' })).success).toBe(true);
  expect((await command(f.host, f, 1, 3, { type: 'AMEND', participantId: f.players[1].id, delta: 5, reason: 'Nachtrag' })).success).toBe(true);
  const expected: Array<[number, string, string]> = [[1, 'GAME_ENDED', 'GAME_END'], [2, 'REVIEW', 'RESULT_REVIEW'], [3, 'FINALIZE', 'FINALIZED'], [4, 'RESULT_AMENDMENT', 'FINALIZED']];
  for (const [revision, kind, status] of expected) {
    for (const view of [(await readResult(f.host, f, { revision })).data, (await httpResult(f, `?revision=${revision}`)).data]) {
      expect(view).toMatchObject({ resultRevision: revision, revisionKind: kind, statusAtRevision: status, latestRevision: 4, isLatestRevision: revision === 4, resultStatus: 'FINALIZED' });
    }
  }
  expect((await readResult(f.host, f)).data).toMatchObject({ resultRevision: 4, isLatestRevision: true });
});

it('Corrections: if the process dies after the correction committed but before its receipt completed, the intent is never run twice', async () => {
  const f = await completedGame('wer-ist-das'), [, bob] = f.players;
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  const adjust = resultCommand(f, 1, 2, { type: 'ADJUST', participantId: bob.id, delta: 4, reason: 'vor dem Absturz' });
  expect((await gameAck(f.host, 'game:result:command', adjust)).success).toBe(true);
  const committed = { versions: await versions(f.room.id, 1), ledger: await ledger(f.room.id) };
  // what a crash between the committed effect and the stored answer leaves behind: a receipt that never completed
  await db.commandReceipt.updateMany({ where: { roomId: f.room.id, commandId: adjust.commandId }, data: { status: 'PENDING', responseJson: null, leaseExpiresAt: new Date(Date.now() - 1000) } });
  const retry = await gameAck(f.host, 'game:result:command', adjust);
  expect(retry).toMatchObject({ success: false, resyncRequired: true });
  expect(await versions(f.room.id, 1)).toEqual(committed.versions);
  expect(await ledger(f.room.id)).toEqual(committed.ledger);
  expect((await readResult(f.host, f)).data.scores.find((x: { participationId: string }) => x.participationId === bob.id).score).toBe(f.expected[bob.id] + 4);
});

it('Corrections: after a host transfer the new host amends the old run, the old host can neither act nor replay, and the running next run is untouched', async () => {
  const f = await completedGame('wissensduell'), [alice, bob] = f.players;
  const second = await db.user.create({ data: { role: 'HOST', displayName: 'G4 Host 2', passwordHash: 'unused' } });
  const session2 = await db.session.create({ data: { userId: second.id, expiresAt: new Date(Date.now() + 3600000) } });
  const cookie2 = createSessionCookie(session2.id, config.sessionSecret);
  const member = await db.participation.create({ data: { roomId: f.room.id, displayName: 'Host 2', normalizedName: 'host2', role: 'VIEWER', userId: second.id, rejoinToken: randomUUID(), connected: true } });
  const host2 = await connect(cookie2); expect((await gameAck(host2, 'room:subscribe', { roomCode: f.code, rejoinToken: member.rejoinToken })).success).toBe(true);
  const review = resultCommand(f, 1, 1, { type: 'REVIEW' }), finalize = resultCommand(f, 1, 2, { type: 'FINALIZE' });
  expect((await gameAck(f.host, 'game:result:command', review)).success).toBe(true);
  expect((await gameAck(f.host, 'game:result:command', finalize)).success).toBe(true);
  const transfer = await gameAck(f.host, 'room:command', { ...intent(f.code), protocolVersion: 1, operation: { type: 'TRANSFER', userId: second.id, claim: false } });
  expect(transfer.success, JSON.stringify(transfer)).toBe(true);
  const settled = { versions: await versions(f.room.id, 1), ledger: await ledger(f.room.id) };
  // the former host lost the right; neither a new correction nor a replay of an old one is served
  expect((await command(f.host, f, 1, 3, { type: 'AMEND', participantId: bob.id, delta: 1, reason: 'alter Host' })).success).toBe(false);
  expect(await gameAck(f.host, 'game:result:command', finalize)).toMatchObject({ success: false });
  expect(await versions(f.room.id, 1)).toEqual(settled.versions);
  // the new host rematches, starts run two and then amends run one
  expect((await gameAck(host2, 'room:command', { ...intent(f.code), protocolVersion: 1, operation: { type: 'REMATCH' } })).success).toBe(true);
  for (const p of f.players) expect((await gameAck(p.client, 'player:ready:set', { roomCode: f.code, ready: true })).success).toBe(true);
  expect((await gameAck(host2, 'game:start', intent(f.code))).success).toBe(true);
  cancelGeoTimer(f.room.id); await handleGeoGame.startRound(app.io, f.code);
  const run2 = async () => ({ state: (await db.roomGameState.findUniqueOrThrow({ where: { roomId: f.room.id } })).stateJson, players: (await db.participation.findMany({ where: { roomId: f.room.id, role: 'PLAYER' }, orderBy: { id: 'asc' } })).map(p => [p.id, p.score]) });
  const before = await run2();
  expect((await command(host2, f, 1, 3, { type: 'AMEND', participantId: bob.id, delta: 9, reason: 'neuer Host' })).success).toBe(true);
  expect(await run2()).toEqual(before);
  expect((await readResult(host2, f, { runIndex: 1 })).data.scores.find((x: { participationId: string }) => x.participationId === bob.id).score).toBe(9);
  expect((await ledger(f.room.id)).filter(e => e.runIndex === 2)).toEqual([]);
  void alice;
});

it.each(SLUGS)('%s: a player who left or was removed after the game keeps their points and place in the result; a later joiner is not part of it', async slug => {
  const f = await completedGame(slug), [alice, bob] = f.players, before = (await readResult(f.host, f)).data;
  await db.participation.update({ where: { id: alice.id }, data: { kickedAt: new Date(), connected: false } });
  await db.participation.update({ where: { id: bob.id }, data: { leftAt: new Date(), connected: false } });
  const late = await lateJoiner(f.room.id, f.code, 'PLAYER', 'Ersatz');
  const after = (await readResult(f.host, f)).data;
  expect(after.scores).toEqual(before.scores);
  expect(after.winnerIds).toEqual(before.winnerIds);
  expect(after.scores.some((x: { participationId: string }) => x.participationId === late.id)).toBe(false);
  expect((await httpResult(f)).data.scores).toEqual(before.scores);
  expect(await totals(f.room.id, 1)).toMatchObject(Object.fromEntries(Object.entries(f.expected).filter(([, v]) => v !== 0)));
  // the replacement is a new identity: it cannot be corrected into a result it was never part of
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  expect(await command(f.host, f, 1, 2, { type: 'ADJUST', participantId: late.id, delta: 5, reason: 'Ersatz' })).toMatchObject({ success: false, error: 'PLAYER_NOT_IN_GAME' });
  // forged absolute values and unknown fields are no corrections at all
  for (const operation of [{ type: 'ADJUST', participantId: alice.id, delta: 5, reason: 'x', score: 999 }, { type: 'SET_SCORE', participantId: alice.id, score: 999 }, { type: 'ADJUST', participantId: alice.id, delta: 0, reason: 'x' }])
    expect((await command(f.host, f, 1, 2, operation)).success).toBe(false);
  expect(await versions(f.room.id, 1)).toEqual([[1, 'GAME_ENDED'], [2, 'REVIEW']]);
});

it('Errors: values a client sends never come back in the answer or appear in the diagnostic lines, on any of the three engines', async () => {
  const marker = 'ECHO_MARKER_4711_do_not_log';
  const f = await fixture('wer-ist-das'), j = await fixture('jeopardy'), g = await fixture('wissensduell');
  spyOnLogs();
  const answers = [
    await gameAck(f.host, 'weristdas:judge', { result: marker, ...intent(f.code) }),
    await gameAck(j.host, 'jeopardy:judge', { correct: marker, ...intent(j.code) }),
    await gameAck(j.host, 'jeopardy:field:open', { boardIndex: marker, categoryIndex: 0, value: 100, ...intent(j.code) }),
    await gameAck(g.players[0].client, 'geo:answer', { optionId: 'a', questionIndex: marker, runIndex: 1, ...intent(g.code) }),
    await gameAck(g.host, 'game:result:command', { ...resultCommand(g, 1, 1, { type: marker }) }),
    await gameAck(g.host, 'game:result:read', { roomCode: g.code, runIndex: marker }),
  ];
  for (const a of answers) expect(a.success).toBe(false);
  expect(JSON.stringify(answers)).not.toContain(marker);
  expect(logLines().join('\n')).not.toContain(marker);
});

it.each(['DENIED', 'PLAYER_INPUT'] as const)('Independent review: exhausted %s requests stop before repeated database reads', async group => {
  const f = await fixture('wissensduell');
  const actor = group === 'DENIED' ? await lateJoiner(f.room.id, f.code, 'VIEWER', 'ReviewViewer') : f.players[0];
  // Force the already-exhausted admission decision; no wall-clock or refill race.
  const original = actionLimiter.consume.bind(actionLimiter);
  vi.spyOn(actionLimiter, 'consume').mockImplementation((roomId, participantId, selected) =>
    roomId === f.room.id && participantId === actor.id
      ? { ok: false, firstRejection: false, traceId: 'review-exhausted', retryAfterMs: 200 }
      : original(roomId, participantId, selected));
  reviewReads = [];
  let response: Record<string, unknown>;
  try { response = await gameAck(actor.client, 'geo:answer', { optionId: 'a', ...intent(f.code) }); }
  finally { reviewReads = null; }
  expect(response!).toMatchObject({ error: 'RATE_LIMITED' });
  // Admission control must not redo membership/room/receipt database work for every refused packet.
  // Capture a second packet independently of unrelated startup work.
  reviewReads = [];
  await gameAck(actor.client, 'geo:answer', { optionId: 'a', ...intent(f.code) });
  const reads = reviewReads; reviewReads = null;
  expect(reads).toEqual([]);
});

it.each(['GameResultRecord', 'ScoreEvent'])('Independent review: %s failure never logs enumerable nested secrets', async model => {
  const f = await fixture('wissensduell');
  if (model === 'ScoreEvent') expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  const marker = 'G4_REVIEW_PRIVATE_TOKEN';
  reviewFailure = { model, roomId: f.room.id, error: Object.assign(new Error('database failed'), { meta: { args: { rejoinToken: marker, answer: 'G4_REVIEW_PRIVATE_SOLUTION' } } }) };
  spyOnLogs();
  const failed = await gameAck(f.host, model === 'GameResultRecord' ? 'game:end' : 'geo:reveal', intent(f.code));
  expect(reviewFailure).toBe(null);
  expect(failed.success).toBe(false);
  expect(JSON.stringify(failed)).not.toContain(marker);
  expect(logLines().join('\n')).not.toContain(marker);
});

it('Independent review: recovery refusals are bounded rather than producing one log per packet', async () => {
  const f = await fixture('wer-ist-das'), viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'RecoveryViewer');
  spyOnLogs();
  const refused = await spam(viewer.client, 80, () => ({ ...intent(f.code), runIndex: 1, gameStateVersion: 1, operation: 'RESTORE_REPLAY' }), 'game:recovery:command');
  expect(logLines().filter(l => l.includes('recovery:command')).length).toBeLessThanOrEqual(ACTION_LIMITS.REQUEST.capacity + 1);
  expect(refused.every(r => !r.success)).toBe(true);
  expect(refused.some(r => r.error === 'RATE_LIMITED')).toBe(true);
});

// ── G4 D/E after the independent review: early admission, recovery/lifecycle floods, nested secrets ──
/** Database reads performed while `work` runs (Prisma middleware of the review probe). */
async function readsDuring(work: () => Promise<unknown>) {
  reviewReads = [];
  try { await work(); return [...reviewReads]; } finally { reviewReads = null; }
}
const recoveryPayload = (code: string) => ({ ...intent(code), runIndex: 1, gameStateVersion: 1, operation: 'RESTORE_REPLAY' });

it('Admission: once an identity is exhausted, further packets of every game entry point cost no database read and no log line', async () => {
  const f = await completedGame('wer-ist-das'), [alice] = f.players, viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Flooder');
  spyOnLogs();
  for (const who of [alice, viewer]) exhaust(f.room.id, who.id, 'REQUEST');
  const probes: Array<[string, Socket, object]> = [
    ['weristdas:buzz', alice.client, intent(f.code)], ['weristdas:resync', alice.client, { roomCode: f.code }], ['game:core:read', alice.client, { roomCode: f.code }],
    ['game:result:read', alice.client, { roomCode: f.code }], ['game:result:command', viewer.client, resultCommand(f, 1, 1, { type: 'REVIEW' })],
    ['game:recovery:command', viewer.client, recoveryPayload(f.code)], ['game:pause', viewer.client, intent(f.code)], ['game:end', viewer.client, intent(f.code)],
    ['room:command', viewer.client, { ...intent(f.code), protocolVersion: 1, operation: { type: 'LEAVE' } }]];
  await gameAck(alice.client, 'weristdas:resync', { roomCode: f.code }); // streak line (if any) is written once, before measuring
  const linesBefore = logLines().length;
  const reads = await readsDuring(async () => { for (let i = 0; i < 5; i++) for (const [event, client, payload] of probes) expect(await gameAck(client, event, payload)).toMatchObject({ success: false, error: 'RATE_LIMITED' }); });
  expect(reads).toEqual([]);
  expect(logLines().length).toBe(linesBefore);
});

it('Admission: a spectator flooding recovery and lifecycle events is cut off early; the host and the players keep working', async () => {
  const f = await fixture('wer-ist-das'), viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Flooder');
  spyOnLogs();
  const recovery = await spam(viewer.client, 120, () => recoveryPayload(f.code), 'game:recovery:command');
  expect(recovery.every(r => r.success === false)).toBe(true);
  expect(recovery.filter(r => r.error === 'RATE_LIMITED').length).toBeGreaterThanOrEqual(120 - ACTION_LIMITS.REQUEST.capacity - 15);
  const denialLines = logLines().filter(l => l.includes('recovery:command')).length;
  expect(denialLines).toBeLessThanOrEqual(ACTION_LIMITS.REQUEST.capacity + 1);
  const pauses = await spam(viewer.client, 60, () => intent(f.code), 'game:pause');
  expect(pauses.some(r => r.error === 'RATE_LIMITED')).toBe(true);
  // the flooder's own budgets do not touch anyone else
  expect(await gameAck(f.host, 'game:recovery:command', recoveryPayload(f.code))).not.toMatchObject({ error: 'RATE_LIMITED' });
  expect((await gameAck(f.host, 'game:pause', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'game:resume', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.players[0].client, 'weristdas:resync', { roomCode: f.code })).success).toBe(true);
  // after the flood has exhausted it: no more database work and no more log lines for that spectator
  exhaust(f.room.id, viewer.id, 'REQUEST');
  const linesBefore = logLines().length;
  expect(await readsDuring(async () => { for (let i = 0; i < 20; i++) await gameAck(viewer.client, 'game:recovery:command', recoveryPayload(f.code)); })).toEqual([]);
  expect(logLines().length).toBe(linesBefore);
});

it('Admission: refused authorisation attempts exhaust their own budget; after that the identity is turned away without database work', async () => {
  const f = await fixture('jeopardy'), viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Prober');
  for (let i = 0; i < ACTION_LIMITS.DENIED.capacity; i++) {
    expect(await gameAck(viewer.client, 'jeopardy:judge', { correct: true, ...intent(f.code) })).toMatchObject({ success: false, error: expect.not.stringMatching(/RATE_LIMITED/) });
  }
  expect(await gameAck(viewer.client, 'jeopardy:judge', { correct: true, ...intent(f.code) })).toMatchObject({ success: false, error: 'RATE_LIMITED' });
  expect(await readsDuring(() => gameAck(viewer.client, 'jeopardy:judge', { correct: true, ...intent(f.code) }))).toEqual([]);
  expect((await gameAck(f.players[0].client, 'jeopardy:resync', { roomCode: f.code })).success).toBe(true);
  expect(await gameAck(f.host, 'jeopardy:resync', { roomCode: f.code })).toMatchObject({ success: true });
});

it('Admission: more tabs and a reconnect keep the budget; a stored answer stays retrievable once the hinted time has passed', async () => {
  const f = await fixture('wissensduell'), [player] = f.players, accepted = { optionId: 'b', ...intent(f.code) };
  expect((await gameAck(player.client, 'geo:answer', accepted)).success).toBe(true);
  exhaust(f.room.id, player.id, 'REQUEST');
  const tab = await connect(); expect((await gameAck(tab, 'room:subscribe', { roomCode: f.code, rejoinToken: player.rejoinToken })).success).toBe(true);
  const refused = await gameAck(tab, 'geo:answer', accepted);
  expect(refused).toMatchObject({ success: false, error: 'RATE_LIMITED', details: { retryAfterMs: expect.any(Number) } });
  expect(await readsDuring(() => gameAck(tab, 'geo:answer', accepted))).toEqual([]);
  // the success is stored, not lost: after the hint the same intent is answered from the receipt
  await new Promise(resolve => setTimeout(resolve, (refused.details as { retryAfterMs: number }).retryAfterMs + 60));
  expect(await gameAck(tab, 'geo:answer', accepted)).toMatchObject({ success: true, replayed: true });
  expect((await state(f.room.id)).value.roundStates[0].playerStates[player.id]).toMatchObject({ answered: true, selectedOptionId: 'b' });
});

it('Errors: nested enumerable fields of failures never reach any log line, across the result, scoring and lifecycle paths', async () => {
  const marker = 'G4_NESTED_SECRET_value';
  const leaky = () => Object.assign(new Error(`database failed ${marker}`), { meta: { args: { rejoinToken: marker, answer: marker } }, response: { body: marker }, cause: Object.assign(new Error(marker), { meta: { marker } }) });
  const expectClean = (answer: Record<string, unknown>) => { expect(answer.success).toBe(false); expect(JSON.stringify(answer)).not.toContain(marker); expect(logLines().join('\n')).not.toContain(marker); };
  // result command (amendment write): the injected failure carries enumerable nested fields (rejoinToken, answer)
  const finished = await completedGame('wer-ist-das'); spyOnLogs();
  expect((await command(finished.host, finished, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  failResultVersionOnce = true;
  const amend = await command(finished.host, finished, 1, 2, { type: 'ADJUST', participantId: finished.players[1].id, delta: 3, reason: 'scheitert' });
  expect(failResultVersionOnce).toBe(false); expect(amend.success).toBe(false);
  expect(JSON.stringify(amend)).not.toMatch(/G4_INJECTED_SECRET|sk_live/); expect(logLines().join('\n')).not.toMatch(/G4_INJECTED_SECRET|sk_live/);
  // judge writes of the other two engines (ledger write fails)
  for (const slug of ['jeopardy', 'wer-ist-das'] as const) {
    const f = await fixture(slug), alice = f.players[0]; spyOnLogs();
    if (slug === 'jeopardy') { await gameAck(f.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, ...intent(f.code) }); await gameAck(alice.client, 'jeopardy:buzz', intent(f.code)); }
    else { await gameAck(f.host, 'weristdas:buzzer:open', intent(f.code)); await gameAck(alice.client, 'weristdas:buzz', intent(f.code)); }
    reviewFailure = { model: 'ScoreEvent', roomId: f.room.id, error: leaky() };
    expectClean(await gameAck(f.host, slug === 'jeopardy' ? 'jeopardy:judge' : 'weristdas:judge', slug === 'jeopardy' ? { correct: true, ...intent(f.code) } : { result: 'BOTH_CORRECT', ...intent(f.code) }));
    expect(reviewFailure).toBe(null);
  }
});

it('Independent recheck: a throttled retry after a lost success ACK retains its intent and cannot repeat a room mutation', async () => {
  const f = await fixture('wissensduell', false);
  const hostMember = await db.participation.findFirstOrThrow({ where: { roomId: f.room.id, userId: hostId, role: 'HOST' } });
  const client = createCommandIntentClient(), sentIds: string[] = [];
  const message = `review-one-intent-${randomUUID()}`;
  const payload = { roomCode: f.code, operation: { type: 'MESSAGE', message } };
  const key = `${f.code}:room:${JSON.stringify(payload.operation)}`;
  const send = (deliverAck: boolean): Promise<Record<string, unknown>> => new Promise(resolve => {
    const wire: CommandEmitter = { emit: (event, data, ack) => {
      sentIds.push((data as { commandId: string }).commandId);
      f.host.emit(event, data, (response: Record<string, unknown>) => { if (deliverAck) ack(response); resolve(response); });
    } };
    client.emitCommand(wire, 'room:command', payload, key);
  });
  expect(await send(false)).toMatchObject({ success: true }); // the committed success ACK is lost
  exhaust(f.room.id, hostMember.id, 'REQUEST');
  const refused = await send(true);
  expect(refused).toMatchObject({ success: false, error: 'RATE_LIMITED' });
  expect(sentIds[1]).toBe(sentIds[0]);
  await new Promise(resolve => setTimeout(resolve, (refused.details as { retryAfterMs: number }).retryAfterMs + 60));
  const retried = await send(true);
  const entries = await db.roomFeedEntry.count({ where: { roomId: f.room.id, kind: 'MESSAGE' } });
  console.info('RECHECK_LOST_ACK', JSON.stringify({ sentIds, retried, entries }));
  expect(entries).toBe(1);
  expect(retried).toMatchObject({ success: true, replayed: true });
  expect(sentIds[2]).toBe(sentIds[0]);
});

it('Independent recheck: malformed JSON never logs a rejoin token through the HTTP error handler', async () => {
  const marker = 'ZZSECR';
  spyOnLogs();
  const result = await fetch(`${origin}/api/v1/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"rejoinToken":${marker}}`,
  });
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.status).toBeLessThan(600);
  expect(await result.text()).not.toContain(marker);
  expect(logLines().join('\n')).not.toContain(marker);
});

// ── Retry after a throttled attempt keeps the intent (real intent client, real handlers, real DB) ──
/** Sends through the real intent client; `deliverAck=false` drops the answer before the client sees it (lost acknowledgement). */
function intentLink(socket: Socket) {
  const client = createCommandIntentClient(), sentIds: string[] = [];
  const send = (event: string, payload: object, key: string, deliverAck = true): Promise<Record<string, unknown>> => new Promise(resolve => {
    const wire: CommandEmitter = { emit: (name, data, ack) => {
      sentIds.push((data as { commandId: string }).commandId);
      socket.emit(name, data, (response: Record<string, unknown>) => { if (deliverAck) ack(response); resolve(response); });
    } };
    client.emitCommand(wire, event, payload, key);
  });
  return { send, sentIds, client };
}
const afterHint = (refusal: Record<string, unknown>) => new Promise(resolve => setTimeout(resolve, (refusal.details as { retryAfterMs: number }).retryAfterMs + 60));

it('Retry: a lost success acknowledgement followed by a refusal of the REPLAY budget still ends in one effect and a stored answer', async () => {
  const f = await fixture('wissensduell'), [player] = f.players, link = intentLink(player.client);
  const payload = { optionId: 'b', questionIndex: 0, runIndex: 1, roomCode: f.code };
  expect(await link.send('geo:answer', payload, 'answer', false)).toMatchObject({ success: true });
  exhaust(f.room.id, player.id, 'REPLAY');
  const refused = await link.send('geo:answer', payload, 'answer');
  expect(refused).toMatchObject({ success: false, error: 'RATE_LIMITED' });
  await afterHint(refused);
  expect(await link.send('geo:answer', payload, 'answer')).toMatchObject({ success: true, replayed: true });
  expect(new Set(link.sentIds).size).toBe(1);
  expect(await db.commandReceipt.count({ where: { roomId: f.room.id, action: 'ANSWER_SUBMIT' } })).toBe(1);
});

it('Retry: an intent refused by the per-action budget before it ever ran is executed exactly once with the same id', async () => {
  const f = await fixture('wissensduell'), [player] = f.players, link = intentLink(player.client);
  const payload = { optionId: 'c', questionIndex: 0, runIndex: 1, roomCode: f.code };
  exhaust(f.room.id, player.id, 'PLAYER_INPUT');
  const refused = await link.send('geo:answer', payload, 'answer');
  expect(refused).toMatchObject({ success: false, error: 'RATE_LIMITED' });
  expect(await db.commandReceipt.count({ where: { roomId: f.room.id, action: 'ANSWER_SUBMIT' } })).toBe(0);
  await afterHint(refused);
  expect(await link.send('geo:answer', payload, 'answer')).toMatchObject({ success: true });
  expect(new Set(link.sentIds).size).toBe(1);
  expect((await state(f.room.id)).value.roundStates[0].playerStates[player.id]).toMatchObject({ answered: true, selectedOptionId: 'c' });
  // the clarified intent is finished: the next send is a new intent (it cannot act again: answered, or throttled once more)
  expect((await link.send('geo:answer', payload, 'answer')).success).toBe(false);
  expect(new Set(link.sentIds).size).toBe(2);
  expect((await state(f.room.id)).value.roundStates[0].playerStates[player.id]).toMatchObject({ selectedOptionId: 'c' });
});

it('Retry: a lost acknowledgement of a result correction survives an early refusal without a second version', async () => {
  const f = await completedGame('wer-ist-das'), [, bob] = f.players, link = intentLink(f.host);
  expect((await command(f.host, f, 1, 1, { type: 'REVIEW' })).success).toBe(true);
  const hostMember = await db.participation.findFirstOrThrow({ where: { roomId: f.room.id, userId: hostId, role: 'HOST' } });
  const payload = { roomCode: f.code, runIndex: 1, resultRevision: 2, operation: { type: 'ADJUST', participantId: bob.id, delta: 6, reason: 'verlorene Bestätigung' } };
  expect(await link.send('game:result:command', payload, 'adjust', false)).toMatchObject({ success: true });
  exhaust(f.room.id, hostMember.id, 'REQUEST');
  const refused = await link.send('game:result:command', payload, 'adjust');
  expect(refused).toMatchObject({ success: false, error: 'RATE_LIMITED' });
  await afterHint(refused);
  expect(await link.send('game:result:command', payload, 'adjust')).toMatchObject({ success: true, replayed: true });
  expect(new Set(link.sentIds).size).toBe(1);
  expect(await versions(f.room.id, 1)).toEqual([[1, 'GAME_ENDED'], [2, 'REVIEW'], [3, 'ADJUST']]);
});

// ── HTTP error path: no message, no stack, a traceId that finds the diagnostic line ──
it.each([
  ['invalid JSON body', 'POST', '/api/v1/rooms', 'ZZSECR_BODY'],
  ['invalid JSON body on login', 'POST', '/api/v1/auth/login', 'ZZSECR_LOGIN'],
  ['undecodable URL parameter', 'GET', '/api/v1/rooms/%ZZSECR_PATH', ''],
])('HTTP errors: %s is a client error with a trace id and leaks nothing into the log', async (_name, method, path, marker) => {
  spyOnLogs();
  const result = await fetch(`${origin}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: `{"rejoinToken":${marker}}` } : {}) });
  const text = await result.text(), body = JSON.parse(text) as { success: boolean; error: { code: string; message: string; traceId: string } };
  expect(result.status).toBeGreaterThanOrEqual(400); expect(result.status).toBeLessThan(500);
  expect(body).toMatchObject({ success: false, error: { code: 'INVALID_PAYLOAD', traceId: expect.any(String) } });
  const lines = logLines().join('\n');
  for (const secret of ['ZZSECR', 'rejoinToken']) { expect(text).not.toContain(secret); expect(lines).not.toContain(secret); }
  expect(logLines().filter(l => l.includes(body.error.traceId)).some(l => l.includes('internalDetail') && l.includes('"http"'))).toBe(true);
  expect(lines).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
});
