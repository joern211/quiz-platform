import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import { createApp } from '../../app.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { cancelGeoTimer, handleGeoGame } from '../geo/index.js';
import { socketIdentityMap } from '../../http/middleware/auth.js';
import { CoreRuntimeProjectionSchema } from '@quiz/shared';
import { saveGameStateIfRevision } from './state.js';
import { createTurn } from './roundFlow.js';
import { applyStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';

let db: PrismaClient, app: ReturnType<typeof createApp>, origin: string, cookie: string, questionId: string, packId: string;
const hostId = `runtime-${randomUUID()}`, rooms: string[] = [], sockets: Socket[] = [];
async function connect(auth?: string) { const socket = await connectGameClient(origin, auth); sockets.push(socket); return socket; }
async function runtime(socket: Socket) {
  const response = await gameAck(socket, 'game:core:read', {});
  expect(response.success).toBe(true);
  return CoreRuntimeProjectionSchema.parse(response.projection);
}
async function assertEventReplay(roomId: string) {
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } });
  const events = await db.gameDomainEvent.findMany({ where: { roomId, runIndex: 1 }, orderBy: { stateVersion: 'asc' } });
  expect(events[0]).toMatchObject({ type: 'GAME_INITIALIZED', baseStateVersion: 0, stateVersion: 1 });
  let snapshot: EngineStateSnapshot = { roomId, runIndex: 1, gameSlug: events[0].gameSlug, engineVersion: events[0].engineVersion, stateVersion: 0, state: {} };
  for (const event of events) snapshot = applyStateEvent(snapshot, JSON.parse(event.payloadJson));
  expect(snapshot.stateVersion).toBe(row.revision);
  expect(snapshot.state).toEqual(JSON.parse(row.stateJson));
}
beforeAll(async () => {
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL }); await db.$connect(); globalThis.__prisma = db;
  await db.user.create({ data: { id: hostId, displayName: 'Runtime Host', passwordHash: 'unused', role: 'HOST' } });
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 86400000) } });
  cookie = createSessionCookie(session.id, config.sessionSecret);
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'Runtime integration', status: 'PUBLISHED' } }); packId = pack.id;
  const question = await db.geoQuestion.create({ data: { packId, prompt: 'Runtime question', category: 'Test', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]), correctOptionId: 'a', points: 100 } }); questionId = question.id;
  app = createApp(); await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address(); if (!address || typeof address === 'string') throw Error('NO_PORT'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const id of rooms) cancelGeoTimer(id);
  for (const socket of sockets) socket.disconnect();
  await new Promise<void>(resolve => app.io.close(() => app.httpServer.close(() => resolve())));
  await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(identity => identity.roomId && rooms.includes(identity.roomId))).toHaveLength(0), { timeout: 10000 });
  await db.room.deleteMany({ where: { id: { in: rooms } } }); await db.questionPack.delete({ where: { id: packId } });
  await db.user.delete({ where: { id: hostId } }); await db.$disconnect(); globalThis.__prisma = undefined;
});
async function start(slug: 'wissensduell' | 'jeopardy') {
  const game = await db.gameDefinition.findUniqueOrThrow({ where: { slug } });
  const code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'Runtime proof', hostUserId: hostId, gameDefinitionId: game.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false,
    setupSnapshotJson: JSON.stringify(slug === 'wissensduell' ? { selectedQuestionIds: [questionId] } : { board1: { categories: [{ name: 'Test', clues: [{ value: 100, question: 'Question', answer: 'RUNTIME_SECRET' }] }] } }),
  } }); rooms.push(room.id);
  const host = await connect(cookie); expect((await gameAck(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
  const players = [];
  for (let i = 0; i < 2; i++) {
    const p = await db.participation.create({ data: { roomId: room.id, displayName: `Player ${i}`, normalizedName: `player-${i}`, rejoinToken: randomUUID(), role: 'PLAYER', ready: true } });
    const socket = await connect(); expect((await gameAck(socket, 'room:subscribe', { roomCode: code, rejoinToken: p.rejoinToken })).success).toBe(true);
    expect((await gameAck(socket, 'player:ready:set', { roomCode: code, ready: true })).success).toBe(true);
    players.push({ ...p, socket });
  }
  expect((await gameAck(host, 'game:start', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  return { room, code, host, players };
}

it('Wissensduell uses shared timer/submission/judge through real commands, pause and rejoin', async () => {
  const { room, code, host, players } = await start('wissensduell'); const [player] = players;
  cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, code);
  const playerRuntime = await runtime(player.socket);
  expect(playerRuntime.availableActions).toContainEqual(expect.objectContaining({ key: 'answer' }));
  expect(playerRuntime.progress).toMatchObject({ currentRound: 1, totalRounds: 1, remainingRounds: 1 });
  expect((await gameAck(host, 'game:pause', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  let state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(state.roundStates[0].timer.status).toBe('PAUSED');
  expect((await gameAck(player.socket, 'geo:answer', { optionId: 'a', commandId: randomUUID() })).success).toBe(false);
  state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(state.roundStates[0].playerStates[player.id].submission).toBeUndefined();
  expect((await gameAck(host, 'game:resume', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(player.socket, 'geo:answer', { optionId: 'a', commandId: randomUUID() })).success).toBe(true);
  expect((await runtime(player.socket)).availableActions).not.toContainEqual(expect.objectContaining({ key: 'answer' }));
  expect((await gameAck(player.socket, 'geo:answer', { optionId: 'b', commandId: randomUUID() })).error).toBe('ALREADY_ANSWERED');
  const replacement = await connect(); expect((await gameAck(replacement, 'room:subscribe', { roomCode: code, rejoinToken: player.rejoinToken })).success).toBe(true);
  expect(await gameAck(replacement, 'geo:resync', {})).toMatchObject({ ownAnswered: true, ownAnswer: 'a' });
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: code });
  expect((await runtime(viewer)).availableActions).toEqual([]);
  expect(await gameAck(viewer, 'geo:resync', {})).toMatchObject({ ownAnswer: null, ownAnswered: false });
  const commandId = randomUUID();
  expect((await gameAck(host, 'geo:reveal', { roomCode: code, commandId })).success).toBe(true);
  expect((await gameAck(host, 'geo:reveal', { roomCode: code, commandId })).replayed).toBe(true);
  state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(state.roundStates[0].playerStates[player.id].submission).toMatchObject({ participantId: player.id, roundId: '0', value: 'a', status: 'JUDGED', decision: 'CORRECT', matchStatus: 'MATCH' });
  expect(await db.scoreEvent.count({ where: { roomId: room.id, participationId: player.id } })).toBe(1);
  expect(state.scores[player.id]).toBe(100);
  const end = new Promise<{ finalScores: Array<{ participationId: string; score: number; rank: number }> }>(resolve => host.once('game:end', resolve));
  expect((await gameAck(host, 'geo:next', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  expect((await end).finalScores).toEqual(expect.arrayContaining([
    expect.objectContaining({ participationId: player.id, score: 100, rank: 1 }),
  ]));
  expect((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).phase).toBe('GAME_END');
  await assertEventReplay(room.id);
  expect(await db.gameDomainEvent.count({ where: { roomId: room.id, commandId } })).toBe(1);
});
it('Jeopardy uses the same durable submission/judge with unlimited time and no fabricated oral text', async () => {
  const { room, code, host, players } = await start('jeopardy'); const [player] = players;
  expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
  expect((await runtime(player.socket)).availableActions).toContainEqual(expect.objectContaining({ key: 'buzz' }));
  expect((await gameAck(player.socket, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true);
  let state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(state.timer).toMatchObject({ mode: 'UNLIMITED', status: 'RUNNING', endsAtMs: null });
  expect(Object.values(state.submissions)).toEqual([expect.objectContaining({ participantId: player.id, value: null, status: 'SUBMITTED', decision: null, matchStatus: 'NEEDS_JUDGE' })]);
  expect(state.answerTurn).toMatchObject({ mode: 'FIXED', order: [player.id], index: 0 });
  const persistedTurn = state.answerTurn;
  const replacement = await connect();
  expect((await gameAck(replacement, 'room:subscribe', { roomCode: code, rejoinToken: player.rejoinToken })).success).toBe(true);
  expect(JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson).answerTurn).toEqual(persistedTurn);
  expect((await runtime(host)).availableActions).toContainEqual(expect.objectContaining({ key: 'judge' }));
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: code });
  const publicRuntime = await runtime(viewer);
  expect(publicRuntime.availableActions).toEqual([]);
  expect(JSON.stringify(publicRuntime)).not.toContain('RUNTIME_SECRET');
  expect((await gameAck(host, 'game:pause', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(host, 'jeopardy:judge', { correct: true, commandId: randomUUID() })).success).toBe(false);
  expect((await gameAck(host, 'game:resume', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  const commandId = randomUUID();
  expect((await gameAck(host, 'jeopardy:judge', { correct: true, commandId })).success).toBe(true);
  expect((await gameAck(host, 'jeopardy:judge', { correct: true, commandId })).replayed).toBe(true);
  state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(Object.values(state.submissions)).toEqual([expect.objectContaining({ participantId: player.id, value: null, status: 'JUDGED', decision: 'CORRECT' })]);
  expect(await db.scoreEvent.count({ where: { roomId: room.id, participationId: player.id } })).toBe(1);
  expect(state.scores[player.id]).toBe(100);
  await assertEventReplay(room.id);
  const judgedEvents = await db.gameDomainEvent.findMany({ where: { roomId: room.id, commandId } });
  expect(judgedEvents).toHaveLength(1);
  expect(judgedEvents[0]).toMatchObject({ type: 'JUDGE' });
  await expect(db.gameDomainEvent.update({ where: { id: judgedEvents[0].id }, data: { type: 'FORGED' } })).rejects.toThrow();
});

it.each(['wissensduell', 'jeopardy'] as const)('%s rejects unsafe writes and freezes corrupted persisted state before scoring', async slug => {
  const { room, code, host, players } = await start(slug);
  if (slug === 'wissensduell') {
    cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, code); cancelGeoTimer(room.id);
  } else {
    expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(players[0].socket, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true);
  }
  const before = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  const corrupted = JSON.parse(before.stateJson);
  if (slug === 'wissensduell') corrupted.currentRoundIndex = 999;
  else corrupted.answerTurn = createTurn([players[1].id]);
  await expect(db.$transaction(tx => saveGameStateIfRevision(tx, {
    roomId: room.id, expectedRevision: before.revision, state: corrupted, phase: before.phase, gameSlug: slug,
  }))).rejects.toThrow('STATE_INVARIANT_FAILED');
  expect(await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).toEqual(before);
  // Simulated on-disk corruption/legacy import bypasses the normal guarded writer.
  await db.roomGameState.update({ where: { roomId: room.id }, data: { stateJson: JSON.stringify(corrupted) } });
  const result = slug === 'wissensduell'
    ? await gameAck(host, 'geo:reveal', { roomCode: code, commandId: randomUUID() })
    : await gameAck(host, 'jeopardy:judge', { correct: true, commandId: randomUUID() });
  expect(result).toMatchObject({ success: false, error: 'STATE_INVARIANT_FAILED', code: 'RECOVERY_REQUIRED' });
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  expect(frozen.phase).toBe('ERROR_RECOVERY');
  expect(JSON.parse(frozen.stateJson).recoverySnapshotJson).toBe(JSON.stringify(corrupted));
  expect((await db.room.findUniqueOrThrow({ where: { id: room.id } })).runPhase).toBe('ERROR_RECOVERY');
  expect(await db.scoreEvent.count({ where: { roomId: room.id } })).toBe(0);
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: code });
  expect(await runtime(viewer)).toMatchObject({ enginePhase: 'ERROR_RECOVERY', recoveryRequired: true, timer: null, availableActions: [] });
  expect(JSON.stringify(await runtime(viewer))).not.toMatch(/recoverySnapshotJson|RUNTIME_SECRET|SOLUTION|answerTurn/);
  expect((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).revision).toBe(frozen.revision);
});

it('a read freezes malformed persisted JSON and returns only recovery metadata', async () => {
  const { room, code, players } = await start('wissensduell');
  cancelGeoTimer(room.id);
  const invalid = '{MALFORMED_PRIVATE_STATE';
  await db.roomGameState.update({ where: { roomId: room.id }, data: { stateJson: invalid } });
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: code });
  expect(await runtime(viewer)).toMatchObject({ enginePhase: 'ERROR_RECOVERY', recoveryRequired: true, timer: null, availableActions: [] });
  expect(await gameAck(players[0].socket, 'geo:resync', {})).toMatchObject({ success: true, phase: 'ERROR_RECOVERY', question: null });
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  expect(JSON.parse(frozen.stateJson).recoverySnapshotJson).toBe(invalid);
  expect(JSON.stringify(await runtime(viewer))).not.toContain('MALFORMED_PRIVATE_STATE');
});
