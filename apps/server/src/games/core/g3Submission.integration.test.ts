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

let db: PrismaClient, previous: PrismaClient | undefined, dir: string, app: ReturnType<typeof createApp>, origin: string, cookie: string, hostId: string, questionIds: string[];
const sockets: Socket[] = [], roomIds: string[] = [];
let nextCode = 730000;
let failEventForRoom: string | undefined;
let failScoreEventNth: { roomId: string; nth: number } | undefined;
let questionOverride: string[] | undefined, roomExtras: Record<string, unknown> = {};
afterEach(() => vi.restoreAllMocks());
async function connect(auth?: string) { const s = await connectGameClient(origin, auth); sockets.push(s); return s; }
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-g3-')); const url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url); db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db;
  db.$use(async (params, next) => {
    if (params.model === 'GameDomainEvent' && params.action === 'create' && params.args.data.roomId === failEventForRoom) {
      failEventForRoom = undefined; throw Error('G2_INJECTED_EVENT_FAILURE');
    }
    if (params.model === 'ScoreEvent' && params.action === 'create' && failScoreEventNth?.roomId === params.args.data.roomId && --failScoreEventNth!.nth === 0) {
      failScoreEventNth = undefined; throw Error('G3_INJECTED_SCORE_FAILURE');
    }
    return next(params);
  });
  const user = await db.user.create({ data: { role: 'HOST', displayName: 'G3 Host', passwordHash: 'unused' } }); hostId = user.id;
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 3600000) } }); cookie = createSessionCookie(session.id, config.sessionSecret);
  for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA', minPlayers: 2 } });
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'G3' } });
  questionIds = [];
  for (let i = 0; i < 2; i++) { const q = await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'G3 question', category: 'G3', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }]), correctOptionId: 'a', durationMs: 600000 } }); questionIds.push(q.id); }
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
  if (slug === 'jeopardy') setup = { board1: { categories: [{ name: 'G3', clues: [{ value: 100, question: 'Question', answer: 'G3_PRIVATE_SOLUTION' }, { value: 200, question: 'Question 2', answer: 'G3_PRIVATE_SECOND' }] }] } };
  if (slug === 'wer-ist-das') {
    const image = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'g1.png', originalName: 'g1.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/g1.png', uploadedBy: hostId } });
    setup = { rounds: [{ id: 'g1', imageAssetId: image.id, person1: 'G3_PRIVATE_A', person2: 'G3_PRIVATE_B' }, { id: 'g2-next', imageAssetId: image.id, person1: 'G3_PRIVATE_C', person2: 'G3_PRIVATE_D' }] };
  }
  const room = await db.room.create({ data: { code, roomName: 'G3', hostUserId: hostId, gameDefinitionId: game.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(setup), ...roomExtras } }); roomIds.push(room.id);
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

// ── G3: Abgaben, Matching, Bewertung, Sichtbarkeit ───────────────────────────
// Echte Verbraucher: Wissensduell (Auswahlabgabe, EXACT, Auto-Judge), Jeopardy
// (verbal, MANUAL_ONLY, boolesche Bewertung), Wer ist das? (BOTH/ONE/WRONG).
async function questions(points: number, wrongPoints: number) {
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: `G3 ${points}/${wrongPoints}` } });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) ids.push((await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'G3 scored', category: 'G3', points, wrongPoints,
    options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }]), correctOptionId: 'a', durationMs: 600000 } })).id);
  return ids;
}
async function ledger(roomId: string) { return (await db.scoreEvent.findMany({ where: { roomId }, orderBy: { createdAt: 'asc' } })).map(e => ({ participationId: e.participationId, delta: e.delta, roundKey: e.roundKey })); }
async function lateJoiner(roomId: string, code: string, role: 'PLAYER' | 'VIEWER', name: string, extra: Record<string, unknown> = {}) {
  const p = await db.participation.create({ data: { roomId, displayName: name, normalizedName: name.toLowerCase(), role, ready: true, rejoinToken: randomUUID(), ...extra } });
  const client = await connect(); expect((await gameAck(client, 'room:subscribe', { roomCode: code, rejoinToken: p.rejoinToken })).success).toBe(true);
  return { ...p, client };
}
function record(socket: Socket) { const seen: unknown[] = []; socket.onAny((event, ...args) => seen.push([event, ...args])); return seen; }

it('Geo: rejects an answer addressed to an older round and still accepts the current one', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'geo:next', intent(f.code))).success).toBe(true);
  const before = await effects(f.room.id);
  expect(await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', questionIndex: 0, runIndex: 1, ...intent(f.code) })).toMatchObject({ success: false, error: 'STALE_ROUND' });
  expect(await effects(f.room.id)).toEqual(before);
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', questionIndex: 1, runIndex: 1, ...intent(f.code) })).success).toBe(true);
  expect((await state(f.room.id)).value.roundStates[1].playerStates[f.players[0].id]).toMatchObject({ answered: true, selectedOptionId: 'a' });
});

it('Geo: ignores a player who was admitted after the round opened until the next round', async () => {
  const f = await fixture('wissensduell');
  const late = await lateJoiner(f.room.id, f.code, 'PLAYER', 'Late');
  const before = await effects(f.room.id);
  expect(await gameAck(late.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).toMatchObject({ success: false, error: 'PLAYER_NOT_IN_ROUND' });
  expect(await effects(f.room.id)).toEqual(before);
  expect((await state(f.room.id)).value.roundStates[0].playerStates[late.id]).toBeUndefined();
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'geo:next', intent(f.code))).success).toBe(true);
  expect((await gameAck(late.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
});

it('Geo: viewers, the host, removed players and foreign rooms cannot submit for anyone', async () => {
  const f = await fixture('wissensduell'), other = await fixture('wissensduell');
  const viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Viewer');
  const before = await effects(f.room.id);
  expect((await gameAck(viewer.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(false);
  expect((await gameAck(f.host, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(false);
  // a participant of another room cannot address this room's code
  expect(await gameAck(other.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).toMatchObject({ success: false });
  expect(await effects(f.room.id)).toEqual(before);
  // a removed player's still-connected socket loses the ability immediately
  await db.participation.update({ where: { id: f.players[1].id }, data: { kickedAt: new Date() } });
  expect((await gameAck(f.players[1].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(false);
  await db.participation.update({ where: { id: f.players[0].id }, data: { leftAt: new Date() } });
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(false);
  const after = await state(f.room.id);
  expect(Object.values(after.value.roundStates[0].playerStates).some(p => (p as { answered: boolean }).answered)).toBe(false);
  expect(Object.values((await state(other.room.id)).value.roundStates[0].playerStates).some(p => (p as { answered: boolean }).answered)).toBe(false);
});

it('Geo: one intent has one effect; the same id with another option conflicts; a new id sees the closed submission', async () => {
  const f = await fixture('wissensduell'), p = f.players[0], payload = { optionId: 'b', ...intent(f.code) };
  expect((await gameAck(p.client, 'geo:answer', payload)).success).toBe(true);
  const once = await evidence(f.room.id);
  expect(await gameAck(p.client, 'geo:answer', payload)).toMatchObject({ success: true, replayed: true });
  expect(await gameAck(p.client, 'geo:answer', { ...payload, optionId: 'a' })).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
  expect(await gameAck(p.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).toMatchObject({ success: false, error: 'ALREADY_ANSWERED' });
  expect((await evidence(f.room.id)).state?.revision).toBe(once.state?.revision);
  expect((await state(f.room.id)).value.roundStates[0].playerStates[p.id]).toMatchObject({ answered: true, selectedOptionId: 'b',
    submission: { status: 'SUBMITTED', value: 'b', decision: null } });
});

it('Geo: parallel different submissions of one player store exactly one option and never a second effect', async () => {
  const f = await fixture('wissensduell'), p = f.players[0];
  const results = await Promise.all(['a', 'b', 'c', 'd'].map(optionId => gameAck(p.client, 'geo:answer', { optionId, ...intent(f.code) })));
  expect(results.filter(r => r.success)).toHaveLength(1);
  const stored = (await state(f.room.id)).value.roundStates[0].playerStates[p.id];
  expect(stored.selectedOptionId).toBe(stored.submission.value);
  expect(['a', 'b', 'c', 'd']).toContain(stored.selectedOptionId);
});

it('Geo: no answer while paused; after resume the answer is accepted and the deadline still closes it', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.host, 'game:pause', intent(f.code))).success).toBe(true);
  const paused = await effects(f.room.id);
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(false);
  expect(await effects(f.room.id)).toEqual(paused);
  expect((await gameAck(f.host, 'game:resume', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  const current = await state(f.room.id); cancelGeoTimer(f.room.id);
  const budget = current.value.roundStates[0].timer.endsAtMs - Date.now();
  expect(budget).toBeLessThanOrEqual(600000); // pause did not add time
  current.value.roundStates[0].timerEndMs = current.value.roundStates[0].timer.endsAtMs = Date.now() - 1;
  await db.roomGameState.update({ where: { roomId: f.room.id }, data: { stateJson: JSON.stringify(current.value), revision: { increment: 1 } } });
  expect(await gameAck(f.players[1].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).toMatchObject({ success: false, error: 'TIME_EXPIRED' });
});

it.each([
  ['0 points / 0 wrong points', 0, 0, { correct: 0, wrong: 0 }],
  ['100 points / -25 wrong points', 100, -25, { correct: 100, wrong: -25 }],
] as const)('Geo: %s are judged by EXACT matching and written to state, score and ledger together', async (_label, points, wrongPoints, expected) => {
  questionOverride = await questions(points, wrongPoints);
  try {
    const f = await fixture('wissensduell'), [alice, bob] = f.players;
    expect((await gameAck(alice.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
    expect((await gameAck(bob.client, 'geo:answer', { optionId: 'b', ...intent(f.code) })).success).toBe(true);
    expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
    const revealed = (await state(f.room.id)).value;
    expect(revealed.scores).toMatchObject({ [alice.id]: expected.correct, [bob.id]: expected.wrong });
    const round = revealed.roundStates[0].playerStates;
    expect(round[alice.id].submission).toMatchObject({ status: 'JUDGED', decision: 'CORRECT', matchStatus: 'MATCH' });
    expect(round[bob.id].submission).toMatchObject({ status: 'JUDGED', decision: 'WRONG', matchStatus: 'NO_MATCH' });
    // 0 is a real outcome: one ledger row per answered player, delta 0 not dropped
    expect(await ledger(f.room.id)).toEqual(expect.arrayContaining([
      { participationId: alice.id, delta: expected.correct, roundKey: 'question:0' }, { participationId: bob.id, delta: expected.wrong, roundKey: 'question:0' }]));
    expect(await ledger(f.room.id)).toHaveLength(2);
    expect((await db.participation.findUniqueOrThrow({ where: { id: bob.id } })).score).toBe(expected.wrong);
    expect(await gameAck(f.host, 'geo:reveal', intent(f.code))).toMatchObject({ success: false });
    expect(await ledger(f.room.id)).toHaveLength(2);
  } finally { questionOverride = undefined; }
});

it('Geo: a failing ledger write rolls the whole reveal back; the retry scores exactly once', async () => {
  const f = await fixture('wissensduell'), [alice, bob] = f.players;
  expect((await gameAck(alice.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  expect((await gameAck(bob.client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  const before = await evidence(f.room.id), beforeState = await state(f.room.id);
  failScoreEventNth = { roomId: f.room.id, nth: 2 };
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(false);
  const after = await state(f.room.id);
  expect(after.row.revision).toBe(beforeState.row.revision);
  expect(after.value.phase).not.toBe('REVEAL');
  expect(after.value.scores).toEqual(beforeState.value.scores);
  expect((await evidence(f.room.id)).scores).toBe(before.scores);
  for (const p of f.players) expect((await db.participation.findUniqueOrThrow({ where: { id: p.id } })).score).toBe(0);
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  expect(await ledger(f.room.id)).toHaveLength(2);
  expect((await state(f.room.id)).value.scores).toMatchObject({ [alice.id]: 100, [bob.id]: 100 });
});

it('Geo: selections and the solution reach only their audience before the reveal; rejoin keeps the own submission', async () => {
  const f = await fixture('wissensduell'), [alice, bob] = f.players;
  const viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Viewer');
  const bobSeen = record(bob.client), viewerSeen = record(viewer.client), hostSeen = record(f.host);
  expect((await gameAck(alice.client, 'geo:answer', { optionId: 'b', ...intent(f.code) })).success).toBe(true);
  await vi.waitFor(() => expect(hostSeen.some(e => (e as unknown[])[0] === 'geo:answered:moderator')).toBe(true));
  const resync = (c: Socket) => gameAck(c, 'geo:resync', { roomCode: f.code });
  expect(await resync(alice.client)).toMatchObject({ ownAnswer: 'b', ownAnswered: true });
  const bobView = await resync(bob.client), viewerView = await resync(viewer.client), hostView = await resync(f.host);
  expect(bobView).toMatchObject({ ownAnswer: null, ownAnswered: false });
  for (const view of [bobView, viewerView]) { expect(JSON.stringify(view)).not.toContain('correctOptionId'); expect(view).not.toHaveProperty('answerStats'); }
  expect(viewerView).toMatchObject({ ownAnswer: null, ownAnswered: false });
  expect(hostView).toMatchObject({ answerStats: { b: 1 }, question: { correctOptionId: 'a' } });
  expect(JSON.stringify([bobSeen, viewerSeen])).not.toMatch(/optionId|selectedOptionId|correctOptionId/);
  expect(hostSeen.find(e => (e as unknown[])[0] === 'geo:answered:moderator')).toEqual(['geo:answered:moderator', { questionIndex: 0, participantId: alice.id, optionId: 'b' }]);
  // pause and rejoin on a fresh socket keep the same audience rules
  expect((await gameAck(f.host, 'game:pause', intent(f.code))).success).toBe(true);
  const again = await connect(); expect((await gameAck(again, 'room:subscribe', { roomCode: f.code, rejoinToken: alice.rejoinToken })).success).toBe(true);
  expect(await resync(again)).toMatchObject({ phase: 'PAUSED', ownAnswer: 'b' });
  expect(JSON.stringify(await resync(viewer.client))).not.toContain('correctOptionId');
  expect((await gameAck(f.host, 'game:resume', intent(f.code))).success).toBe(true);
  // a removed player's old device gets no private data any more
  await db.participation.update({ where: { id: alice.id }, data: { kickedAt: new Date() } });
  expect((await resync(alice.client)).success).not.toBe(true);
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  expect(await resync(viewer.client)).toMatchObject({ revealed: true, question: { correctOptionId: 'a' } });
  expect(await resync(bob.client)).toMatchObject({ ownAnswer: null });
});

it('Geo: a blind host sees neither selections nor the solution before the reveal', async () => {
  roomExtras = { contentVisibility: 'BLIND_HOST' };
  try {
    const f = await fixture('wissensduell'), hostSeen = record(f.host);
    expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'b', ...intent(f.code) })).success).toBe(true);
    await vi.waitFor(() => expect(hostSeen.some(e => (e as unknown[])[0] === 'geo:answered')).toBe(true));
    const view = await gameAck(f.host, 'geo:resync', { roomCode: f.code });
    expect(JSON.stringify(view)).not.toContain('correctOptionId'); expect(view).not.toHaveProperty('answerStats');
    expect(hostSeen.some(e => (e as unknown[])[0] === 'geo:answered:moderator')).toBe(false);
    expect(JSON.stringify(hostSeen)).not.toMatch(/optionId|correctOptionId/);
    expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
    expect(await gameAck(f.host, 'geo:resync', { roomCode: f.code })).toMatchObject({ revealed: true, question: { correctOptionId: 'a' } });
  } finally { roomExtras = {}; }
});

// ── Jeopardy: verbal answer, MANUAL_ONLY, boolean judgement ──────────────────
async function jeopardyField(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await gameAck(f.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, ...intent(f.code) })).success).toBe(true);
}
const submissions = async (roomId: string) => Object.values((await state(roomId)).value.submissions ?? {}) as Array<{ participantId: string; status: string; decision: string | null; value: string | null; matchStatus?: string }>;

it('Jeopardy: only the host judges, only booleans are accepted, and a refusal changes nothing', async () => {
  const f = await fixture('jeopardy'), [alice] = f.players, viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Viewer');
  await jeopardyField(f);
  expect((await gameAck(alice.client, 'jeopardy:buzz', intent(f.code))).success).toBe(true);
  const before = await effects(f.room.id);
  for (const [who, payload] of [[alice.client, { correct: true }], [viewer.client, { correct: true }], [f.host, { correct: 'true' }], [f.host, { decision: 'PARTIAL' }], [f.host, { correct: 1 }], [f.host, {}]] as const)
    expect((await gameAck(who, 'jeopardy:judge', { ...payload, ...intent(f.code) })).success).toBe(false);
  expect(await effects(f.room.id)).toEqual(before);
  expect(await submissions(f.room.id)).toMatchObject([{ participantId: alice.id, status: 'SUBMITTED', decision: null, value: null, matchStatus: 'NEEDS_JUDGE' }]);
});

it('Jeopardy: a judgement has one effect, wrong opens the steal, each judged submission stays on its own record', async () => {
  const f = await fixture('jeopardy'), [alice, bob] = f.players;
  await jeopardyField(f);
  expect((await gameAck(alice.client, 'jeopardy:buzz', intent(f.code))).success).toBe(true);
  const wrong = { correct: false, ...intent(f.code) };
  expect((await gameAck(f.host, 'jeopardy:judge', wrong)).success).toBe(true);
  const once = await effects(f.room.id);
  expect(await gameAck(f.host, 'jeopardy:judge', wrong)).toMatchObject({ success: true, replayed: true });
  expect(await gameAck(f.host, 'jeopardy:judge', { ...wrong, correct: true })).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
  expect((await gameAck(f.host, 'jeopardy:judge', { correct: false, ...intent(f.code) })).success).toBe(false);
  expect(await effects(f.room.id)).toEqual(once);
  expect(await ledger(f.room.id)).toEqual([{ participationId: alice.id, delta: -50, roundKey: 'field:1-0-100' }]);
  expect((await gameAck(bob.client, 'jeopardy:steal:buzz', intent(f.code))).success).toBe(true);
  const steal = { correct: true, ...intent(f.code) };
  expect((await gameAck(f.host, 'jeopardy:steal:judge', steal)).success).toBe(true);
  expect(await gameAck(f.host, 'jeopardy:steal:judge', steal)).toMatchObject({ success: true, replayed: true });
  expect(await ledger(f.room.id)).toEqual([{ participationId: alice.id, delta: -50, roundKey: 'field:1-0-100' }, { participationId: bob.id, delta: 50, roundKey: 'field:1-0-100' }]);
  expect((await state(f.room.id)).value.scores).toMatchObject({ [alice.id]: -50, [bob.id]: 50 });
  expect(await submissions(f.room.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ participantId: alice.id, status: 'JUDGED', decision: 'WRONG', value: null }),
    expect.objectContaining({ participantId: bob.id, status: 'JUDGED', decision: 'CORRECT', value: null, matchStatus: 'NEEDS_JUDGE' })]));
});

it('Jeopardy: the solution never reaches players or viewers, and a blind host only gets it once the field is resolved', async () => {
  for (const blind of [false, true]) {
    roomExtras = blind ? { contentVisibility: 'BLIND_HOST' } : {};
    try {
      const f = await fixture('jeopardy'), [alice, bob] = f.players, viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Viewer');
      const seen = [record(alice.client), record(bob.client), record(viewer.client)], hostSeen = record(f.host);
      const views = async () => Promise.all([alice.client, bob.client, viewer.client, f.host].map(c => gameAck(c, 'jeopardy:resync', { roomCode: f.code })));
      await jeopardyField(f);
      expect((await gameAck(alice.client, 'jeopardy:buzz', intent(f.code))).success).toBe(true);
      expect((await gameAck(f.host, 'game:pause', intent(f.code))).success).toBe(true);
      let [a, b, v, h] = await views();
      for (const view of [a, b, v]) expect(JSON.stringify(view)).not.toContain('G3_PRIVATE_SOLUTION');
      expect(JSON.stringify(h).includes('G3_PRIVATE_SOLUTION')).toBe(!blind);
      expect((await gameAck(f.host, 'game:resume', intent(f.code))).success).toBe(true);
      expect((await gameAck(f.host, 'jeopardy:judge', { correct: false, ...intent(f.code) })).success).toBe(true);
      [a, b, v, h] = await views();
      for (const view of [a, b, v]) expect(JSON.stringify(view)).not.toContain('G3_PRIVATE_SOLUTION');
      expect(JSON.stringify(h).includes('G3_PRIVATE_SOLUTION')).toBe(!blind);
      expect((await gameAck(bob.client, 'jeopardy:steal:buzz', intent(f.code))).success).toBe(true);
      expect(JSON.stringify(hostSeen).includes('G3_PRIVATE_SOLUTION')).toBe(!blind); // blind host: nothing before resolution
      expect((await gameAck(f.host, 'jeopardy:steal:judge', { correct: true, ...intent(f.code) })).success).toBe(true);
      [a, b, v, h] = await views();
      for (const view of [a, b, v]) expect(JSON.stringify(view)).not.toContain('G3_PRIVATE_SOLUTION');
      expect(JSON.stringify(seen)).not.toContain('G3_PRIVATE_SOLUTION');
      expect(JSON.stringify(hostSeen)).toContain('G3_PRIVATE_SOLUTION'); // resolved: released to the judging host, also a blind one
    } finally { roomExtras = {}; }
  }
});

// ── Wer ist das?: BOTH_CORRECT / ONE_CORRECT (partial) / WRONG ───────────────
async function widOpen(f: Awaited<ReturnType<typeof fixture>>) { expect((await gameAck(f.host, 'weristdas:buzzer:open', intent(f.code))).success).toBe(true); }

it('Wer ist das?: partial needs the hint, 0/unsupported verdicts are refused untouched, each verdict scores and logs once', async () => {
  const f = await fixture('wer-ist-das'), [alice, bob] = f.players;
  await widOpen(f);
  expect((await gameAck(alice.client, 'weristdas:buzz', intent(f.code))).success).toBe(true);
  const before = await effects(f.room.id);
  expect(await gameAck(f.host, 'weristdas:judge', { result: 'ONE_CORRECT', ...intent(f.code) })).toMatchObject({ success: false, error: 'HINT_REQUIRED' });
  for (const [who, payload] of [[f.host, { result: 'PARTIAL' }], [f.host, { result: 'CORRECT' }], [f.host, { result: 0 }], [f.host, {}], [bob.client, { result: 'WRONG' }]] as const)
    expect((await gameAck(who, 'weristdas:judge', { ...payload, ...intent(f.code) })).success).toBe(false);
  expect(await effects(f.room.id)).toEqual(before);
  // wrong: -1, round reopens without the loser; then a full solve scores 3
  const wrong = { result: 'WRONG', ...intent(f.code) };
  expect((await gameAck(f.host, 'weristdas:judge', wrong)).success).toBe(true);
  expect(await gameAck(f.host, 'weristdas:judge', wrong)).toMatchObject({ success: true, replayed: true });
  expect(await gameAck(f.host, 'weristdas:judge', { ...wrong, result: 'BOTH_CORRECT' })).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
  expect((await state(f.room.id)).value.scores[alice.id]).toBe(-1);
  await widOpen(f);
  expect((await gameAck(alice.client, 'weristdas:buzz', intent(f.code))).success).toBe(false);
  expect((await gameAck(bob.client, 'weristdas:buzz', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'weristdas:hint', intent(f.code))).success).toBe(true);
  const partial = { result: 'ONE_CORRECT', ...intent(f.code) };
  expect((await gameAck(f.host, 'weristdas:judge', partial)).success).toBe(true);
  expect(await gameAck(f.host, 'weristdas:judge', partial)).toMatchObject({ success: true, replayed: true });
  expect((await gameAck(f.host, 'weristdas:judge', { result: 'BOTH_CORRECT', ...intent(f.code) })).success).toBe(false);
  expect((await state(f.room.id)).value).toMatchObject({ phase: 'REVEAL', scores: { [alice.id]: -1, [bob.id]: 1 } });
  expect(await ledger(f.room.id)).toEqual([{ participationId: alice.id, delta: -1, roundKey: 'round:0' }, { participationId: bob.id, delta: 1, roundKey: 'round:0' }]);
});

it('Wer ist das?: the persons stay with the host until the reveal on every projection path', async () => {
  const f = await fixture('wer-ist-das'), [alice, bob] = f.players, viewer = await lateJoiner(f.room.id, f.code, 'VIEWER', 'Viewer');
  const seen = [record(alice.client), record(bob.client), record(viewer.client)];
  await widOpen(f);
  expect((await gameAck(alice.client, 'weristdas:buzz', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'game:pause', intent(f.code))).success).toBe(true);
  const rejoined = await connect(); expect((await gameAck(rejoined, 'room:subscribe', { roomCode: f.code, rejoinToken: alice.rejoinToken })).success).toBe(true);
  const views = await Promise.all([alice.client, bob.client, viewer.client, rejoined].map(c => gameAck(c, 'weristdas:resync', { roomCode: f.code })));
  expect(JSON.stringify([views, seen])).not.toMatch(/G3_PRIVATE_[AB]/);
  expect((await gameAck(f.host, 'game:resume', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'weristdas:judge', { result: 'WRONG', ...intent(f.code) })).success).toBe(true);
  expect(JSON.stringify(seen)).not.toMatch(/G3_PRIVATE_[AB]/);
  expect((await gameAck(f.host, 'weristdas:reveal', intent(f.code))).success).toBe(true);
  expect(JSON.stringify(await gameAck(viewer.client, 'weristdas:resync', { roomCode: f.code }))).toMatch(/G3_PRIVATE_A/);
});

it('Wer ist das?: a stored host receipt is not replayed to a host whose judging right was withdrawn', async () => {
  const f = await fixture('wer-ist-das'), [alice] = f.players;
  await widOpen(f);
  expect((await gameAck(alice.client, 'weristdas:buzz', intent(f.code))).success).toBe(true);
  const wrong = { result: 'WRONG', ...intent(f.code) }, first = await gameAck(f.host, 'weristdas:judge', wrong);
  expect(first.success).toBe(true);
  expect(JSON.stringify(first)).toMatch(/G3_PRIVATE_A/); // the host's own view: the receipt really holds host-private data
  const revoke = { roomId: f.room.id, userId: hostId, permission: 'JUDGE_ANSWER', direction: 'REVOKE' };
  await db.roomPermissionGrant.create({ data: { ...revoke, grantedBy: hostId } });
  try {
    const replay = await gameAck(f.host, 'weristdas:judge', wrong);
    expect(replay.success).toBe(false); expect(JSON.stringify(replay)).not.toMatch(/G3_PRIVATE_[AB]|"state"/);
    expect((await state(f.room.id)).value.scores[alice.id]).toBe(-1);
  } finally { await db.roomPermissionGrant.delete({ where: { roomId_userId_permission_direction: revoke } }); }
  expect(await gameAck(f.host, 'weristdas:judge', wrong)).toMatchObject({ success: true, replayed: true });
});

it.each(['wissensduell', 'jeopardy'] as const)('%s: a display sees only the public projection and cannot submit or judge', async slug => {
  const f = await fixture(slug), [alice] = f.players;
  const link = await gameAck(f.host, 'media:display-link'); expect(link.success).toBe(true);
  const display = await connect(); expect((await gameAck(display, 'room:display:subscribe', { roomCode: f.code, token: (link.data as { path: string }).path.split('#')[1] })).success).toBe(true);
  const seen = record(display);
  if (slug === 'jeopardy') { await jeopardyField(f); expect((await gameAck(alice.client, 'jeopardy:buzz', intent(f.code))).success).toBe(true); }
  else expect((await gameAck(alice.client, 'geo:answer', { optionId: 'b', ...intent(f.code) })).success).toBe(true);
  const before = await effects(f.room.id);
  const resync = await gameAck(display, slug === 'jeopardy' ? 'jeopardy:resync' : 'geo:resync', { roomCode: f.code });
  expect(resync.success).toBe(true);
  expect(JSON.stringify([resync, seen])).not.toMatch(/G3_PRIVATE_SOLUTION|correctOptionId|selectedOptionId|"optionId"/);
  if (slug === 'wissensduell') expect(resync).toMatchObject({ ownAnswer: null, ownAnswered: false });
  const attempts = slug === 'jeopardy' ? [['jeopardy:judge', { correct: true }], ['jeopardy:buzz', {}]] as const : [['geo:answer', { optionId: 'a' }], ['geo:reveal', {}]] as const;
  for (const [event, payload] of attempts) expect((await gameAck(display, event, { ...payload, ...intent(f.code) })).success).toBe(false);
  expect(await effects(f.room.id)).toEqual(before);
});

it("REVIEW Geo: an answer created during run one cannot answer run two; old receipts never turn into a false success", async () => {
  const f = await fixture('wissensduell');
  const oldAnswer = { optionId: 'b', questionIndex: 0, runIndex: 1, ...intent(f.code) };
  expect((await gameAck(f.host, 'game:end', intent(f.code))).success).toBe(true);
  const rematch = await gameAck(f.host, 'room:command', { ...intent(f.code), protocolVersion: 1, operation: { type: 'REMATCH' } });
  expect(rematch.success, JSON.stringify(rematch)).toBe(true);
  for (const p of f.players) expect((await gameAck(p.client, 'player:ready:set', { roomCode: f.code, ready: true })).success).toBe(true);
  expect((await gameAck(f.host, 'game:start', intent(f.code))).success).toBe(true);
  cancelGeoTimer(f.room.id); await handleGeoGame.startRound(app.io, f.code);
  expect((await db.room.findUniqueOrThrow({ where: { id: f.room.id } })).runIndex).toBe(2);
  const saved = async () => (await state(f.room.id)).value.roundStates[0].playerStates[f.players[0].id];
  const before = await effects(f.room.id);
  expect(await gameAck(f.players[0].client, 'geo:answer', oldAnswer)).toMatchObject({ success: false, error: 'STALE_ROUND' });
  expect((await saved()).answered).toBe(false);
  expect(await effects(f.room.id)).toEqual(before);
  // an incomplete locator is malformed, never read as "legacy"
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'b', questionIndex: 0, ...intent(f.code) })).success).toBe(false);
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'b', runIndex: 2, ...intent(f.code) })).success).toBe(false);
  expect((await saved()).answered).toBe(false);
  // an id already used in run one is not accepted as a run-two intent either
  expect(await gameAck(f.players[0].client, 'geo:answer', { ...oldAnswer, runIndex: 2 })).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
  expect((await saved()).answered).toBe(false);
  // the current run works and its retry acts once
  const current = { optionId: 'b', questionIndex: 0, runIndex: 2, ...intent(f.code) };
  expect((await gameAck(f.players[0].client, 'geo:answer', current)).success).toBe(true);
  expect(await gameAck(f.players[0].client, 'geo:answer', current)).toMatchObject({ success: true, replayed: true });
  expect(await saved()).toMatchObject({ answered: true, selectedOptionId: 'b' });
  // an unrelated player's answer in the same run is not a conflict
  expect((await gameAck(f.players[1].client, 'geo:answer', { optionId: 'a', questionIndex: 0, runIndex: 2, ...intent(f.code) })).success).toBe(true);
});

async function attemptOf(f: Awaited<ReturnType<typeof fixture>>, slug: 'jeopardy' | 'wer-ist-das') {
  const view = await gameAck(f.host, slug === 'jeopardy' ? 'jeopardy:resync' : 'weristdas:resync', { roomCode: f.code }) as { currentField?: { attemptId?: string | null }; state?: { attemptId?: string | null }; attemptId?: string | null };
  return slug === 'jeopardy' ? view.currentField?.attemptId : (view.state ?? view).attemptId;
}
const judgeEvent = (slug: string) => slug === 'jeopardy' ? 'jeopardy:judge' : 'weristdas:judge';
const verdict = (slug: string, good: boolean) => slug === 'jeopardy' ? { correct: good } : { result: good ? 'BOTH_CORRECT' : 'WRONG' };
async function startAttempt(slug: 'jeopardy' | 'wer-ist-das', f: Awaited<ReturnType<typeof fixture>>, who: { client: Socket }) {
  if (slug === 'jeopardy') expect((await gameAck(f.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, ...intent(f.code) })).success).toBe(true);
  else expect((await gameAck(f.host, 'weristdas:buzzer:open', intent(f.code))).success).toBe(true);
  expect((await gameAck(who.client, slug === 'jeopardy' ? 'jeopardy:buzz' : 'weristdas:buzz', intent(f.code))).success).toBe(true);
}

it.each(['jeopardy', 'wer-ist-das'] as const)("REVIEW %s: an old judge intent must not judge a replacement answer owner", async slug => {
  const f = await fixture(slug), [alice, bob] = f.players;
  await startAttempt(slug, f, alice);
  const attemptId = await attemptOf(f, slug);
  expect(attemptId).toEqual(expect.any(String));
  const oldJudge = { ...verdict(slug, true), attemptId, ...intent(f.code) };
  const loaded = await state(f.room.id);
  const room = await db.room.findUniqueOrThrow({ where: { id: f.room.id } });
  const override = await gameAck(f.host, 'game:buzzer:override', { participantId: bob.id, gameStateVersion: loaded.row.revision, runIndex: room.runIndex, ...intent(f.code) });
  expect(override.success, JSON.stringify(override)).toBe(true);
  const before = await effects(f.room.id);
  expect(await gameAck(f.host, judgeEvent(slug), oldJudge)).toMatchObject({ success: false, error: 'STALE_ATTEMPT' });
  expect(await effects(f.room.id)).toEqual(before);
  expect((await state(f.room.id)).value.scores[bob.id]).toBe(0);
  // a judgement created for Bob's attempt stays possible
  const fresh = await attemptOf(f, slug);
  expect(fresh).not.toBe(attemptId);
  expect((await gameAck(f.host, judgeEvent(slug), { ...verdict(slug, true), attemptId: fresh, ...intent(f.code) })).success).toBe(true);
  expect((await state(f.room.id)).value.scores[bob.id]).toBe(slug === 'jeopardy' ? 100 : 3);
  expect((await state(f.room.id)).value.scores[alice.id]).toBe(0);
});

it.each(['jeopardy', 'wer-ist-das'] as const)("%s: a judgement bound to a finished attempt, a malformed context and a foreign owner never take effect", async slug => {
  const f = await fixture(slug), [alice, bob] = f.players;
  await startAttempt(slug, f, alice);
  const first = await attemptOf(f, slug);
  const wrong = { ...verdict(slug, false), attemptId: first, ...intent(f.code) };
  expect((await gameAck(f.host, judgeEvent(slug), wrong)).success).toBe(true);
  // the executed intent stays idempotent, a new id for the finished attempt is stale
  expect(await gameAck(f.host, judgeEvent(slug), wrong)).toMatchObject({ success: true, replayed: true });
  if (slug === 'jeopardy') expect((await gameAck(bob.client, 'jeopardy:steal:buzz', intent(f.code))).success).toBe(true);
  else { expect((await gameAck(f.host, 'weristdas:buzzer:open', intent(f.code))).success).toBe(true); expect((await gameAck(bob.client, 'weristdas:buzz', intent(f.code))).success).toBe(true); }
  const second = await attemptOf(f, slug);
  expect(second).not.toBe(first);
  const event = slug === 'jeopardy' ? 'jeopardy:steal:judge' : 'weristdas:judge';
  const before = await effects(f.room.id);
  expect(await gameAck(f.host, event, { ...verdict(slug, true), attemptId: first, ...intent(f.code) })).toMatchObject({ success: false, error: 'STALE_ATTEMPT' });
  expect(await gameAck(f.host, event, { ...verdict(slug, true), attemptId: `${first}|x`, ...intent(f.code) })).toMatchObject({ success: false, error: 'STALE_ATTEMPT' });
  for (const bad of [5, '', null, {}]) expect(await gameAck(f.host, event, { ...verdict(slug, true), attemptId: bad, ...intent(f.code) })).toMatchObject({ success: false, error: expect.stringMatching(/INVALID_PAYLOAD|VALIDATION_ERROR/) });
  expect(await effects(f.room.id)).toEqual(before);
  // the same id with a different attempt is a conflict, not a second judgement
  expect(await gameAck(f.host, judgeEvent(slug), { ...wrong, attemptId: second })).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
  expect((await gameAck(f.host, event, { ...verdict(slug, true), attemptId: second, ...intent(f.code) })).success).toBe(true);
  expect((await state(f.room.id)).value.scores[bob.id]).toBe(slug === 'jeopardy' ? 50 : 3);
});

it("Jeopardy: a judgement bound to the previous field cannot judge the next field", async () => {
  const f = await fixture('jeopardy'), [alice, bob] = f.players;
  await startAttempt('jeopardy', f, alice);
  const first = await attemptOf(f, 'jeopardy');
  expect((await gameAck(f.host, 'jeopardy:judge', { correct: true, attemptId: first, ...intent(f.code) })).success).toBe(true);
  expect((await gameAck(f.host, 'jeopardy:next', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 200, ...intent(f.code) })).success).toBe(true);
  expect((await gameAck(bob.client, 'jeopardy:buzz', intent(f.code))).success).toBe(true);
  const before = await effects(f.room.id);
  expect(await gameAck(f.host, 'jeopardy:judge', { correct: true, attemptId: first, ...intent(f.code) })).toMatchObject({ success: false, error: 'STALE_ATTEMPT' });
  expect(await effects(f.room.id)).toEqual(before);
});

it("REVIEW Geo: a revoked host session must not receive private answer broadcasts", async () => {
  const f = await fixture('wissensduell');
  const seen = record(f.host);
  const session = await db.session.findFirstOrThrow({where:{userId:hostId,revokedAt:null}});
  await db.session.update({where:{id:session.id},data:{revokedAt:new Date()}});
  try {
    expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'b', questionIndex: 0, runIndex: 1, ...intent(f.code) })).success).toBe(true);
    // A public event follows the private event on this connection and fences delivery.
    await vi.waitFor(() => expect(seen.some(e => (e as unknown[])[0] === 'game:core:changed')).toBe(true));
    const leaked = seen.filter(e => (e as unknown[])[0] === 'geo:answered:moderator');
    expect(leaked).toEqual([]);
  } finally { await db.session.update({where:{id:session.id},data:{revokedAt:null}}); }
});

it("Wer ist das?: a revoked host session and a removed player stop receiving projections while valid recipients keep them", async () => {
  const f = await fixture('wer-ist-das'), [alice, bob] = f.players;
  await widOpen(f);
  const hostSeen = record(f.host), aliceSeen = record(alice.client), bobSeen = record(bob.client);
  const session = await db.session.findFirstOrThrow({ where: { userId: hostId, revokedAt: null } });
  await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  await db.participation.update({ where: { id: alice.id }, data: { kickedAt: new Date() } });
  try {
    expect((await gameAck(bob.client, 'weristdas:buzz', intent(f.code))).success).toBe(true);
    // public events follow the private projection on every connection and fence its delivery
    await vi.waitFor(() => expect(hostSeen.some(e => (e as unknown[])[0] === 'game:core:changed')).toBe(true));
    await vi.waitFor(() => expect(aliceSeen.some(e => (e as unknown[])[0] === 'game:core:changed')).toBe(true));
    expect(bobSeen.filter(e => (e as unknown[])[0] === 'weristdas:update')).toHaveLength(1);
    for (const seen of [hostSeen, aliceSeen]) expect(seen.filter(e => (e as unknown[])[0] === 'weristdas:update')).toEqual([]);
  } finally { await db.session.update({ where: { id: session.id }, data: { revokedAt: null } }); }
});

it("Jeopardy: the buzz events carry exactly the attempt the projection and the judgement use", async () => {
  const f = await fixture('jeopardy'), [alice, bob] = f.players, hostSeen = record(f.host);
  await jeopardyField(f);
  expect((await gameAck(alice.client, 'jeopardy:buzz', intent(f.code))).success).toBe(true);
  const won = await vi.waitFor(() => { const e = hostSeen.find(x => (x as unknown[])[0] === 'jeopardy:buzz:won'); expect(e).toBeDefined(); return (e as [string, { attemptId: string }])[1]; });
  expect(won.attemptId).toBe(await attemptOf(f, 'jeopardy'));
  expect((await gameAck(f.host, 'jeopardy:judge', { correct: false, attemptId: won.attemptId, ...intent(f.code) })).success).toBe(true);
  expect((await gameAck(bob.client, 'jeopardy:steal:buzz', intent(f.code))).success).toBe(true);
  const stolen = await vi.waitFor(() => { const e = hostSeen.find(x => (x as unknown[])[0] === 'jeopardy:steal:buzz:won'); expect(e).toBeDefined(); return (e as [string, { attemptId: string }])[1]; });
  expect(stolen.attemptId).toBe(await attemptOf(f, 'jeopardy'));
  expect(stolen.attemptId).not.toBe(won.attemptId);
  expect((await gameAck(f.host, 'jeopardy:steal:judge', { correct: true, attemptId: stolen.attemptId, ...intent(f.code) })).success).toBe(true);
});
