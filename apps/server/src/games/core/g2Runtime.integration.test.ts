import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { CoreRuntimeProjectionSchema } from '@quiz/shared';
import { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import { createApp } from '../../app.js';
import { createTestDatabase } from '../../test-helpers.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { serializeRoom } from '../../rooms/queue.js';
import { socketIdentityMap } from '../../http/middleware/auth.js';
import { cancelGeoTimer, handleGeoGame, restoreActiveTimers, __activeTimerRoomIdsForTest } from '../geo/index.js';

let db: PrismaClient, previous: PrismaClient | undefined, dir: string, app: ReturnType<typeof createApp>, origin: string, cookie: string, hostId: string, questionIds: string[];
const sockets: Socket[] = [], roomIds: string[] = [];
let nextCode = 710000;
let failEventForRoom: string | undefined;
const deadlines = new Map<string, { run: () => Promise<void>; handle: ReturnType<typeof setTimeout> }>();
afterEach(() => vi.restoreAllMocks());
async function connect(auth?: string) { const s = await connectGameClient(origin, auth); sockets.push(s); return s; }
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-g2-')); const url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url); db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db;
  db.$use(async (params, next) => {
    if (params.model === 'GameDomainEvent' && params.action === 'create' && params.args.data.roomId === failEventForRoom) {
      failEventForRoom = undefined; throw Error('G2_INJECTED_EVENT_FAILURE');
    }
    return next(params);
  });
  const user = await db.user.create({ data: { role: 'HOST', displayName: 'G2 Host', passwordHash: 'unused' } }); hostId = user.id;
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 3600000) } }); cookie = createSessionCookie(session.id, config.sessionSecret);
  for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA', minPlayers: 2 } });
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'G2' } });
  questionIds = [];
  for (let i = 0; i < 2; i++) { const q = await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'G2 question', category: 'G2', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }]), correctOptionId: 'a', durationMs: 600000 } }); questionIds.push(q.id); }
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
  let setup: object = { selectedQuestionIds: questionIds, timerDuration: 600 };
  if (slug === 'jeopardy') setup = { board1: { categories: [{ name: 'G2', clues: [{ value: 100, question: 'Question', answer: 'G2_PRIVATE_SOLUTION' }, { value: 200, question: 'Question 2', answer: 'G2_PRIVATE_SECOND' }] }] } };
  if (slug === 'wer-ist-das') {
    const image = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'g1.png', originalName: 'g1.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/g1.png', uploadedBy: hostId } });
    setup = { rounds: [{ id: 'g1', imageAssetId: image.id, person1: 'G2_PRIVATE_A', person2: 'G2_PRIVATE_B' }, { id: 'g2-next', imageAssetId: image.id, person1: 'G2_PRIVATE_C', person2: 'G2_PRIVATE_D' }] };
  }
  const room = await db.room.create({ data: { code, roomName: 'G2', hostUserId: hostId, gameDefinitionId: game.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(setup) } }); roomIds.push(room.id);
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
      if (openGeo) {
        const spy = vi.spyOn(globalThis, 'setTimeout');
        try {
          await handleGeoGame.startRound(app.io, code);
          const index = spy.mock.calls.map(([, delay]) => typeof delay === 'number' && delay > 500000 && delay <= 600000).lastIndexOf(true);
          expect(index).toBeGreaterThanOrEqual(0);
          deadlines.set(room.id, { run: spy.mock.calls[index][0] as () => Promise<void>, handle: spy.mock.results[index].value });
        } finally { spy.mockRestore(); }
      }
    }
  }
  return { room, code, host, players };
}
async function evidence(roomId: string) {
  return { room: await db.room.findUniqueOrThrow({ where: { id: roomId } }), state: await db.roomGameState.findUnique({ where: { roomId } }),
    events: await db.gameDomainEvent.count({ where: { roomId } }), scores: await db.scoreEvent.count({ where: { roomId } }), receipts: await db.commandReceipt.count({ where: { roomId } }) };
}

async function state(roomId: string) {
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } });
  return { row, value: JSON.parse(row.stateJson) };
}
async function fireCaptured(roomId: string) {
  const captured = deadlines.get(roomId)!;
  clearTimeout(captured.handle); // Simulate a callback already dequeued by the event loop.
  await captured.run();
}
const intent = (roomCode: string) => ({ roomCode, commandId: randomUUID() });
it('does not expire a live Geo round when its scheduled callback arrives before the persisted deadline', async () => {
  const f = await fixture('wissensduell'), before = await evidence(f.room.id);
  await fireCaptured(f.room.id);
  expect(await evidence(f.room.id)).toEqual(before);
  expect(__activeTimerRoomIdsForTest()).toContain(f.room.id);
});
it('does not let an old Geo callback consume the timer or reveal after pause/resume', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.host, 'game:pause', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'game:resume', intent(f.code))).success).toBe(true);
  const before = await evidence(f.room.id);
  await fireCaptured(f.room.id);
  expect(await evidence(f.room.id)).toEqual(before);
  expect(__activeTimerRoomIdsForTest()).toContain(f.room.id);
});
it('does not let a prior round callback expire a later round even at the later deadline', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'geo:next', intent(f.code))).success).toBe(true);
  const before = await evidence(f.room.id), current = await state(f.room.id);
  vi.spyOn(Date, 'now').mockReturnValue(current.value.roundStates[1].timer.endsAtMs);
  await fireCaptured(f.room.id);
  expect(await evidence(f.room.id)).toEqual(before);
  expect(__activeTimerRoomIdsForTest()).toContain(f.room.id);
});
it('refuses answers at the Geo deadline and records automatic reveal/points exactly once', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  const active = await state(f.room.id); cancelGeoTimer(f.room.id);
  const round = active.value.roundStates[0];
  round.timerEndMs = round.timer.endsAtMs = Date.now() - 1;
  await db.roomGameState.update({ where: { roomId: f.room.id }, data: { stateJson: JSON.stringify(active.value), revision: { increment: 1 } } });
  expect(await gameAck(f.players[1].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).toMatchObject({ success: false, error: 'TIME_EXPIRED' });
  await handleGeoGame.handleTimerExpired(app.io, f.room);
  const after = await evidence(f.room.id); expect(after.state?.phase).toBe('REVEAL');
  expect((await state(f.room.id)).value.scores[f.players[0].id]).toBe(100);
  await handleGeoGame.handleTimerExpired(app.io, f.room);
  expect(await evidence(f.room.id)).toEqual(after);
});
it('opens the next Geo round in one committed state/event and replays without resetting answers or points', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  const before = await state(f.room.id), payload = intent(f.code);
  expect((await gameAck(f.host, 'geo:next', payload)).success).toBe(true);
  const after = await state(f.room.id);
  expect(after.row.revision).toBe(before.row.revision + 1);
  expect(after.value).toMatchObject({ phase: 'INPUT_OPEN', currentRoundIndex: 1, scores: before.value.scores });
  expect(after.value.roundStates[1].playerStates[f.players[0].id]).toMatchObject({ answered: false, locked: false });
  expect(after.value.roundStates[0]).toEqual(before.value.roundStates[0]);
  const events = await db.gameDomainEvent.findMany({ where: { roomId: f.room.id, stateVersion: { gt: before.row.revision } } });
  expect(events).toHaveLength(1);
  expect(await gameAck(f.host, 'geo:next', payload)).toMatchObject({ success: true, replayed: true });
  expect(await state(f.room.id)).toEqual(after);
});
it('does not restart an already open Geo round or erase an accepted answer', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  const before = await evidence(f.room.id);
  await handleGeoGame.startRound(app.io, f.code);
  expect(await evidence(f.room.id)).toEqual(before);
});
it('restores an interrupted Geo INTRO without waiting for an in-memory intro callback', async () => {
  const f = await fixture('wissensduell', true, false);
  expect((await state(f.room.id)).row.phase).toBe('INTRO');
  await restoreActiveTimers(app.io);
  expect((await state(f.room.id)).row.phase).toBe('INPUT_OPEN');
  expect(__activeTimerRoomIdsForTest()).toContain(f.room.id);
});
it('recovers a legacy Geo PROMPT checkpoint with scores preserved', async () => {
  const f = await fixture('wissensduell'), old = await state(f.room.id); cancelGeoTimer(f.room.id);
  const legacy = { ...old.value, phase: 'PROMPT', currentRoundIndex: 1, scores: { ...old.value.scores, [f.players[0].id]: 100 } };
  await db.roomGameState.update({ where: { roomId: f.room.id }, data: { phase: 'PROMPT', stateJson: JSON.stringify(legacy), revision: { increment: 1 } } });
  await restoreActiveTimers(app.io);
  expect((await state(f.room.id)).value).toMatchObject({ phase: 'INPUT_OPEN', currentRoundIndex: 1, scores: legacy.scores });
});

it.each(['handleJoker5050', 'handleJokerRisk'] as const)('%s rechecks the deadline at its own persistence boundary', async action => {
  const f = await fixture('wissensduell'), active = await state(f.room.id); cancelGeoTimer(f.room.id);
  active.value.roundStates[0].timerEndMs = active.value.roundStates[0].timer.endsAtMs = Date.now() - 1;
  await db.roomGameState.update({ where: { roomId: f.room.id }, data: { stateJson: JSON.stringify(active.value), revision: { increment: 1 } } });
  const before = await evidence(f.room.id), ack = vi.fn();
  const socket = app.io.sockets.sockets.get(f.players[0].client.id!)!;
  await handleGeoGame[action](app.io, socket, { roomCode: f.code }, ack);
  expect(ack).toHaveBeenCalledWith({ success: false, error: 'TIME_EXPIRED' });
  expect(await evidence(f.room.id)).toEqual(before);
});

const openEvent = (slug: string) => slug === 'jeopardy' ? 'jeopardy:field:open' : 'weristdas:buzzer:open';
const buzzEvent = (slug: string) => slug === 'jeopardy' ? 'jeopardy:buzz' : 'weristdas:buzz';
const judgeEvent = (slug: string) => slug === 'jeopardy' ? 'jeopardy:judge' : 'weristdas:judge';
const openPayload = (slug: string) => slug === 'jeopardy' ? { boardIndex: 1, categoryIndex: 0, value: 100 } : {};
it.each(['jeopardy', 'wer-ist-das'] as const)('%s preserves one concurrent buzzer winner and answer turn across rejoin, pause and resume', async slug => {
  const f = await fixture(slug);
  expect((await gameAck(f.host, openEvent(slug), { ...openPayload(slug), ...intent(f.code) })).success).toBe(true);
  const claims = await Promise.all(f.players.map(p => gameAck(p.client, buzzEvent(slug), intent(f.code))));
  expect(claims.filter(r => r.success)).toHaveLength(1);
  const won = await state(f.room.id), winnerId = won.value.buzzer.winnerId;
  expect(won.value.answerTurn).toMatchObject({ order: [winnerId], index: 0, cycle: 0 });
  const winner = f.players.find(p => p.id === winnerId)!, replacement = await connect();
  expect((await gameAck(replacement, 'room:subscribe', { roomCode: f.code, rejoinToken: winner.rejoinToken })).success).toBe(true);
  expect(await state(f.room.id)).toEqual(won);
  const pause = intent(f.code);
  expect((await gameAck(f.host, 'game:pause', pause)).success).toBe(true);
  const paused = await state(f.room.id); expect(paused.row.phase).toBe('PAUSED');
  const core = CoreRuntimeProjectionSchema.parse((await gameAck(f.host, 'game:core:read', {})).projection);
  expect(core.availableActions.map(a => a.key)).toEqual(expect.arrayContaining(['resume', 'end']));
  expect(core.availableActions.some(a => ['buzz', 'judge', 'stealBuzz', 'stealJudge'].includes(a.key))).toBe(false);
  expect(paused.value._roomPause.buzzer).toEqual(won.value.buzzer);
  expect(paused.value._roomPause.answerTurn).toEqual(won.value.answerTurn);
  if (slug === 'jeopardy') expect(paused.value.timer).toMatchObject({ mode: 'UNLIMITED', status: 'PAUSED' });
  expect((await gameAck(replacement, buzzEvent(slug), intent(f.code))).success).toBe(false);
  expect((await gameAck(f.host, judgeEvent(slug), { ...(slug === 'jeopardy' ? { correct: true } : { result: 'BOTH_CORRECT' }), ...intent(f.code) })).success).toBe(false);
  expect(await state(f.room.id)).toEqual(paused);
  const revoke = { roomId: f.room.id, userId: hostId, permission: 'GAME_PAUSE', direction: 'REVOKE' };
  await db.roomPermissionGrant.create({ data: { ...revoke, grantedBy: hostId } });
  expect((await gameAck(f.host, 'game:resume', intent(f.code))).success).toBe(false);
  expect(await state(f.room.id)).toEqual(paused);
  await db.roomPermissionGrant.delete({ where: { roomId_userId_permission_direction: revoke } });
  const resume = intent(f.code);
  expect((await gameAck(f.host, 'game:resume', resume)).success).toBe(true);
  const resumed = await state(f.room.id);
  expect(resumed.value.answerTurn).toEqual(won.value.answerTurn); expect(resumed.value.buzzer).toEqual(won.value.buzzer);
  if (slug === 'jeopardy') expect(resumed.value.timer).toMatchObject({ mode: 'UNLIMITED', status: 'RUNNING', endsAtMs: null });
  expect(await gameAck(f.host, 'game:resume', resume)).toMatchObject({ success: true, replayed: true });
  expect(await state(f.room.id)).toEqual(resumed);
  expect(await db.scoreEvent.count({ where: { roomId: f.room.id } })).toBe(0);
});
it.each(['jeopardy', 'wer-ist-das'] as const)('%s resets round runtime in one commit and retains authoritative scores on duplicate next', async slug => {
  const f = await fixture(slug);
  expect((await gameAck(f.host, openEvent(slug), { ...openPayload(slug), ...intent(f.code) })).success).toBe(true);
  expect((await gameAck(f.players[0].client, buzzEvent(slug), intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, judgeEvent(slug), { ...(slug === 'jeopardy' ? { correct: true } : { result: 'BOTH_CORRECT' }), ...intent(f.code) })).success).toBe(true);
  const before = await state(f.room.id), scores = await db.scoreEvent.count({ where: { roomId: f.room.id } });
  const payload = intent(f.code), next = slug === 'jeopardy' ? 'jeopardy:next' : 'weristdas:next';
  expect((await gameAck(f.host, next, payload)).success).toBe(true);
  const after = await state(f.room.id);
  expect(after.row.revision).toBe(before.row.revision + 1);
  expect(after.value.scores).toEqual(before.value.scores);
  expect(after.value.buzzer).toMatchObject({ winnerId: null, open: false, excludedPlayerIds: [] });
  expect(after.value.answerTurn).toBeNull();
  if (slug === 'jeopardy') { expect(after.value.timer).toBeUndefined(); expect(after.value.submissions).toEqual({}); }
  expect(await gameAck(f.host, next, payload)).toMatchObject({ success: true, replayed: true });
  expect(await state(f.room.id)).toEqual(after);
  expect(await db.scoreEvent.count({ where: { roomId: f.room.id } })).toBe(scores);
});
it.each(['jeopardy', 'wer-ist-das'] as const)('%s pins the team roster and keeps team exclusions through wrong-answer reopening and rejoin', async slug => {
  const f = await fixture(slug, true, true, true);
  expect((await gameAck(f.host, openEvent(slug), { ...openPayload(slug), ...intent(f.code) })).success).toBe(true);
  const roster = (await state(f.room.id)).value.buzzer;
  expect(roster.mode).toBe('TEAM');
  expect((await gameAck(f.players[0].client, buzzEvent(slug), intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, judgeEvent(slug), { ...(slug === 'jeopardy' ? { correct: false } : { result: 'WRONG' }), ...intent(f.code) })).success).toBe(true);
  if (slug === 'wer-ist-das') expect((await gameAck(f.host, openEvent(slug), intent(f.code))).success).toBe(true);
  const active = await state(f.room.id), buzzer = slug === 'jeopardy' ? active.value.stealBuzzer : active.value.buzzer;
  expect(buzzer.eligiblePlayerIds).toEqual(roster.eligiblePlayerIds); expect(buzzer.teamByPlayer).toEqual(roster.teamByPlayer);
  expect(buzzer.excludedPlayerIds).toEqual(expect.arrayContaining([f.players[0].id, f.players[1].id]));
  const replacement = await connect();
  expect((await gameAck(replacement, 'room:subscribe', { roomCode: f.code, rejoinToken: f.players[1].rejoinToken })).success).toBe(true);
  const event = slug === 'jeopardy' ? 'jeopardy:steal:buzz' : 'weristdas:buzz';
  expect((await gameAck(replacement, event, intent(f.code))).success).toBe(false);
  expect((await gameAck(f.players[2].client, event, intent(f.code))).success).toBe(true);
  const won = await state(f.room.id), winner = slug === 'jeopardy' ? won.value.stealBuzzer : won.value.buzzer;
  expect(winner.winnerId).toBe(f.players[2].id); expect(winner.winnerTeamId).toBe(roster.teamByPlayer[f.players[2].id]);
});

it('does not let an already dequeued intro from another run open the current run', async () => {
  const spy = vi.spyOn(globalThis, 'setTimeout');
  const f = await fixture('wissensduell', true, false);
  const index = spy.mock.calls.map(([, delay]) => delay).lastIndexOf(3000);
  expect(index).toBeGreaterThanOrEqual(0);
  const run = spy.mock.calls[index][0] as () => void, handle = spy.mock.results[index].value;
  spy.mockRestore(); clearTimeout(handle);
  await db.room.update({ where: { id: f.room.id }, data: { runIndex: { increment: 1 } } });
  const before = await evidence(f.room.id);
  run(); await serializeRoom(f.room.id, async () => {});
  expect(await evidence(f.room.id)).toEqual(before);
});
it('rolls back the entire next-round opening when its event cannot commit', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  const before = await evidence(f.room.id); failEventForRoom = f.room.id;
  expect((await gameAck(f.host, 'geo:next', intent(f.code))).success).toBe(false);
  const after = await evidence(f.room.id);
  expect(after.room).toEqual(before.room); expect(after.state).toEqual(before.state);
  expect(after.events).toBe(before.events); expect(after.scores).toBe(before.scores);
  expect((await gameAck(f.host, 'geo:next', intent(f.code))).success).toBe(true);
  expect((await state(f.room.id)).row.revision).toBe(before.state!.revision + 1);
});
it('does not let delayed auto-reveal from a completed round reveal the next question', async () => {
  const f = await fixture('wissensduell'), old = await state(f.room.id);
  const expired = { runIndex: f.room.runIndex, roundIndex: 0, endsAtMs: old.value.roundStates[0].timer.endsAtMs };
  expect((await gameAck(f.host, 'geo:reveal', intent(f.code))).success).toBe(true);
  expect((await gameAck(f.host, 'geo:next', intent(f.code))).success).toBe(true);
  const before = await evidence(f.room.id);
  await handleGeoGame.handleReveal(app.io, null as never, { roomCode: f.code }, undefined, expired);
  expect(await evidence(f.room.id)).toEqual(before);
});

it('finishes an expiry checkpoint interrupted between input lock and auto-reveal without double scores', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.players[0].client, 'geo:answer', { optionId: 'a', ...intent(f.code) })).success).toBe(true);
  const active = await state(f.room.id); cancelGeoTimer(f.room.id);
  active.value.roundStates[0].timerEndMs = active.value.roundStates[0].timer.endsAtMs = Date.now() - 1;
  await db.roomGameState.update({ where: { roomId: f.room.id }, data: { stateJson: JSON.stringify(active.value), revision: { increment: 1 } } });
  const reveal = vi.spyOn(handleGeoGame, 'handleReveal').mockResolvedValueOnce(undefined);
  await handleGeoGame.handleTimerExpired(app.io, f.room);
  reveal.mockRestore();
  expect((await state(f.room.id)).row.phase).toBe('INPUT_LOCKED');
  expect(await db.scoreEvent.count({ where: { roomId: f.room.id } })).toBe(0);
  await restoreActiveTimers(app.io);
  expect((await state(f.room.id)).row.phase).toBe('REVEAL');
  expect((await state(f.room.id)).value.scores[f.players[0].id]).toBe(100);
  const after = await evidence(f.room.id); await restoreActiveTimers(app.io);
  expect(await evidence(f.room.id)).toEqual(after);
});
