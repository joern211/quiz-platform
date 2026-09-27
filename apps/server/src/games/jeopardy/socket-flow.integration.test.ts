import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../../persistence/prisma.js';
import { setupSocketHandlers } from '../../sockets/index.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { cancelGeoTimer, handleGeoGame, restoreActiveTimers } from '../geo/index.js';

// Runs against the freshly migrated, seeded SQLite test database from the server test command.
// The actions below go through real Socket.IO connections and production event handlers.
describe('Jeopardy multiplayer socket integration', () => {
  let httpServer: HttpServer;
  let io: Server;
  let origin: string;
  let code: string;
  let roomId: string;
  let moderator: ClientSocket;
  let alice: ClientSocket;
  let bob: ClientSocket;
  let viewer: ClientSocket;
  const sockets: ClientSocket[] = [];
  const temporaryRoomIds: string[] = [];
  const secret = 'INTEGRATION_SECRET_DO_NOT_LEAK';
  let aliceId: string;
  let bobId: string;

  const ack = gameAck;

  async function connect(cookie?: string): Promise<ClientSocket> {
    const socket = await connectGameClient(origin, cookie);
    sockets.push(socket);
    return socket;
  }

  beforeAll(async () => {
    const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'jeopardy' } });
    const session = await prisma.session.create({
      data: { userId: 'mod-1', expiresAt: new Date(Date.now() + 60000) },
    });
    code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
    const room = await prisma.room.create({
      data: {
        code, roomName: 'Socket Jeopardy', gameDefinitionId: game.id, hostUserId: 'mod-1',
        status: 'LOBBY', runPhase: 'LOBBY', viewerRequiresPin: false,
        setupSnapshotJson: JSON.stringify({
          board1: { categories: [{ name: 'Erstes Board', clues: [{ value: 100, question: 'Erste Frage?', answer: secret }] }] },
          board2: { categories: [{ name: 'Zweites Board', clues: [{ value: 200, question: 'Zweite Frage?', answer: secret }] }] },
        }),
      },
    });
    roomId = room.id;
    const players = await Promise.all(['Alice', 'Bob'].map((displayName) => prisma.participation.create({
      data: { roomId, role: 'PLAYER', displayName, normalizedName: displayName.toLowerCase(),
        rejoinToken: randomUUID(), connected: true, ready: true },
    })));
    aliceId = players[0].id;
    bobId = players[1].id;

    httpServer = createServer();
    io = new Server(httpServer);
    setupSocketHandlers(io);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('No test server port');
    origin = `http://127.0.0.1:${address.port}`;
    moderator = await connect(createSessionCookie(session.id, config.sessionSecret));
    alice = await connect();
    bob = await connect();
    viewer = await connect();
    expect((await ack(moderator, 'room:subscribe', { roomCode: code })).success).toBe(true);
    expect((await ack(alice, 'room:subscribe', { roomCode: code, rejoinToken: players[0].rejoinToken })).success).toBe(true);
    expect((await ack(bob, 'room:subscribe', { roomCode: code, rejoinToken: players[1].rejoinToken })).success).toBe(true);
    expect((await ack(viewer, 'room:subscribe', { roomCode: code })).success).toBe(true);
  }, 15000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    if (io) await new Promise<void>((resolve) => io.close(() => resolve()));
    if (httpServer?.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    for (const id of temporaryRoomIds) await prisma.room.delete({ where: { id } });
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
  });

  it('starts via real game:start, enforces roles, races buzzers, judges once, switches boards and ends', async () => {
    const outsiderBeforeSubscribe = await connect();
    expect((await ack(outsiderBeforeSubscribe, 'room:resync', { roomCode: code })).success).toBe(false);
    expect((await ack(alice, 'room:resync', { roomCode: '999-999' })).success).toBe(false);
    expect((await ack(alice, 'room:resync', { roomCode: code })).success).toBe(true);
    const received: string[] = [];
    alice.onAny((_event, payload: unknown) => received.push(JSON.stringify(payload)));
    viewer.onAny((_event, payload: unknown) => received.push(JSON.stringify(payload)));

    expect((await ack(moderator, 'game:start', { roomCode: code })).success).toBe(true);
    expect((await ack(moderator, 'game:start', { roomCode: code })).success).toBe(false);
    const initial = await ack(alice, 'jeopardy:resync');
    expect(initial.phase).toBe('SELECTING');
    expect(JSON.stringify(initial)).not.toContain(secret);
    expect((await ack(viewer, 'jeopardy:resync')).phase).toBe('SELECTING');
    expect((await ack(viewer, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(false);
    expect((await ack(alice, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(false);
    expect((await ack(moderator, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: -1, value: 100 })).success).toBe(false);
    expect((await ack(moderator, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(true);
    expect(JSON.stringify(await ack(moderator, 'jeopardy:resync'))).toContain(secret);
    expect(JSON.stringify(await ack(viewer, 'jeopardy:resync'))).not.toContain(secret);
    expect((await ack(viewer, 'jeopardy:buzz')).success).toBe(false);
    expect((await ack(moderator, 'jeopardy:buzz')).success).toBe(false);

    const buzzes = await Promise.all([ack(alice, 'jeopardy:buzz'), ack(bob, 'jeopardy:buzz')]);
    expect(buzzes.filter((result) => result.success)).toHaveLength(1);
    const winnerId = buzzes[0].success ? aliceId : bobId;
    const winner = buzzes[0].success ? alice : bob;
    expect((await ack(winner, 'jeopardy:resync')).currentField).toMatchObject({ buzzWinnerId: winnerId });
    expect((await ack(viewer, 'jeopardy:judge', { correct: true })).success).toBe(false);
    expect((await ack(moderator, 'jeopardy:judge', { correct: true })).success).toBe(true);
    expect((await ack(moderator, 'jeopardy:judge', { correct: true })).success).toBe(false);
    const completed = await ack(alice, 'jeopardy:resync');
    expect(completed.phase).toBe('BOARD_COMPLETE');
    expect(completed.playedFields).toContain('1-0-100');
    expect((completed.scores as Array<{ playerId: string; score: number }>).find((p) => p.playerId === winnerId)?.score).toBe(100);
    expect((await ack(moderator, 'jeopardy:next')).success).toBe(false);
    expect((await ack(alice, 'jeopardy:board:switch', { toBoard: 2 })).success).toBe(false);
    expect((await ack(moderator, 'jeopardy:board:switch', { toBoard: 2 })).success).toBe(true);
    expect((await ack(alice, 'jeopardy:resync')).currentBoard).toBe(2);
    expect((await ack(moderator, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(false);
    expect((await ack(moderator, 'jeopardy:field:open', { boardIndex: 2, categoryIndex: 0, value: 200 })).success).toBe(true);
    expect((await ack(winner, 'jeopardy:buzz')).success).toBe(true);
    expect((await ack(moderator, 'jeopardy:judge', { correct: false })).success).toBe(true);
    expect((await ack(winner, 'jeopardy:steal:buzz')).success).toBe(false);
    const thief = winner === alice ? bob : alice;
    expect((await ack(thief, 'jeopardy:steal:buzz')).success).toBe(true);
    expect((await ack(moderator, 'jeopardy:steal:judge', { correct: true })).success).toBe(true);
    expect((await ack(moderator, 'jeopardy:steal:judge', { correct: true })).success).toBe(false);
    const board2 = await ack(viewer, 'jeopardy:resync');
    expect(board2.phase).toBe('BOARD_COMPLETE');
    expect(board2.playedFields).toContain('2-0-200');
    expect((await ack(moderator, 'jeopardy:board:switch', { toBoard: 1 })).success).toBe(true);
    const ended = await ack(alice, 'jeopardy:resync');
    expect(ended.phase).toBe('GAME_END');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).status).toBe('ENDED');
    expect((await prisma.roomGameState.findUniqueOrThrow({ where: { roomId } })).phase).toBe('GAME_END');
    expect(ended.finalScores).toHaveLength(2);
    const scoreEvents = await prisma.scoreEvent.findMany({ where: { roomId } });
    expect(scoreEvents.map((event) => event.delta).sort((a, b) => a - b)).toEqual([-100, 100, 100]);
    for (const participation of await prisma.participation.findMany({ where: { roomId, role: 'PLAYER' } })) {
      expect(participation.score).toBe(
        scoreEvents.filter((event) => event.participationId === participation.id)
          .reduce((sum, event) => sum + event.delta, 0)
      );
    }
    expect(JSON.stringify(ended)).not.toContain(secret);
    expect(received.join(' ')).not.toContain(secret);

    const aliceToken = (await prisma.participation.findUniqueOrThrow({ where: { id: aliceId } })).rejoinToken;
    const rejoined = await connect();
    expect((await ack(rejoined, 'room:subscribe', { roomCode: code, rejoinToken: aliceToken })).success).toBe(true);
    const restored = await ack(rejoined, 'jeopardy:resync');
    expect(restored.phase).toBe('GAME_END');
    expect(restored.playedFields).toEqual(expect.arrayContaining(['1-0-100', '2-0-200']));
    expect(JSON.stringify(restored)).not.toContain(secret);
    expect((await ack(alice, 'jeopardy:resync')).success).toBe(false);

    const otherRoom = await prisma.room.create({
      data: { code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'Other room', gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'jeopardy' } })).id,
        hostUserId: 'mod-1', status: 'LOBBY' },
    });
    try {
      const outsider = await connect();
      expect((await ack(outsider, 'room:subscribe', { roomCode: otherRoom.code, rejoinToken: aliceToken })).success).toBe(false);
      expect((await ack(outsider, 'jeopardy:resync')).success).toBe(false);
      expect((await ack(viewer, 'room:subscribe', { roomCode: otherRoom.code })).success).toBe(true);
      expect((await ack(viewer, 'room:resync', { roomCode: code })).success).toBe(false);
      expect((await ack(viewer, 'jeopardy:resync')).success).toBe(false);
    } finally {
      temporaryRoomIds.push(otherRoom.id);
    }
  }, 30000);

  it('restores the lobby when game initialization fails', async () => {
    const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'jeopardy' } });
    const failedRoom = await prisma.room.create({
      data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'Invalid setup', gameDefinitionId: game.id, hostUserId: 'mod-1',
        status: 'LOBBY', setupSnapshotJson: '{}',
      },
    });
    try {
      await Promise.all(['First', 'Second'].map((name) => prisma.participation.create({
        data: { roomId: failedRoom.id, role: 'PLAYER', displayName: name,
          normalizedName: name.toLowerCase(), rejoinToken: randomUUID(), connected: true, ready: true },
      })));
      const otherModerator = await connect(createSessionCookie(
        (await prisma.session.findFirstOrThrow({ where: { userId: 'mod-1' } })).id,
        config.sessionSecret
      ));
      expect((await ack(otherModerator, 'room:subscribe', { roomCode: failedRoom.code })).success).toBe(true);
      expect((await ack(otherModerator, 'game:start', { roomCode: failedRoom.code })).success).toBe(false);
      const restored = await prisma.room.findUniqueOrThrow({ where: { id: failedRoom.id } });
      expect(restored.status).toBe('LOBBY');
      expect(restored.startedAt).toBeNull();
      expect(await prisma.roomGameState.findUnique({ where: { roomId: failedRoom.id } })).toBeNull();
    } finally {
      temporaryRoomIds.push(failedRoom.id);
    }
  });

  it('ends Jeopardy during a running round once and persists the terminal state', async () => {
    const original = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    const gameRoom = await prisma.room.create({ data: {
      code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
      roomName: 'Manual Jeopardy end', gameDefinitionId: original.gameDefinitionId,
      hostUserId: 'mod-1', status: 'LOBBY', runPhase: 'LOBBY', setupSnapshotJson: original.setupSnapshotJson,
    } });
    temporaryRoomIds.push(gameRoom.id);
    await Promise.all(['First', 'Second'].map((name) => prisma.participation.create({ data: {
      roomId: gameRoom.id, role: 'PLAYER', displayName: name,
      normalizedName: name.toLowerCase(), rejoinToken: randomUUID(), connected: true, ready: true,
    } })));
    const host = await connect(createSessionCookie(
      (await prisma.session.findFirstOrThrow({ where: { userId: 'mod-1' } })).id, config.sessionSecret
    ));
    const spectator = await connect();
    expect((await ack(host, 'room:subscribe', { roomCode: gameRoom.code })).success).toBe(true);
    expect((await ack(spectator, 'room:subscribe', { roomCode: gameRoom.code })).success).toBe(true);
    expect((await ack(host, 'game:start', { roomCode: gameRoom.code })).success).toBe(true);
    expect((await ack(spectator, 'jeopardy:resync')).phase).toBe('SELECTING');
    const endEvents: unknown[] = [];
    spectator.on('jeopardy:game:end', payload => endEvents.push(payload));
    expect((await ack(spectator, 'game:end', { roomCode: gameRoom.code })).success).toBe(false);
    expect((await ack(host, 'game:end', { roomCode: gameRoom.code })).success).toBe(true);
    expect((await ack(host, 'game:end', { roomCode: gameRoom.code })).success).toBe(true);
    const room = await prisma.room.findUniqueOrThrow({ where: { id: gameRoom.id } });
    const state = await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: gameRoom.id } });
    expect(room.status).toBe('ENDED');
    expect(room.runPhase).toBe('RESULTS');
    expect(state.phase).toBe('GAME_END');
    expect(JSON.parse(state.stateJson).phase).toBe('GAME_END');
    expect((await ack(spectator, 'jeopardy:resync')).phase).toBe('GAME_END');
    expect(endEvents).toHaveLength(1);
  });

  it('restores only active Geo timers and continues after malformed state', async () => {
    const geo = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } });
    const jeopardy = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'jeopardy' } });
    const createRoom = async (slug: 'geo' | 'jeopardy', json: string, status = 'RUNNING', runPhase = 'ROUND_ACTIVE') => {
      const room = await prisma.room.create({ data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'Timer restore', gameDefinitionId: slug === 'geo' ? geo.id : jeopardy.id,
        hostUserId: 'mod-1', status, runPhase,
      } });
      temporaryRoomIds.push(room.id);
      await prisma.roomGameState.create({ data: {
        roomId: room.id, phase: 'INPUT_OPEN', stateJson: json,
      } });
      return room;
    };
    const expired = JSON.stringify({ phase: 'INPUT_OPEN', currentRoundIndex: 0,
      roundStates: { 0: { timerEndMs: Date.now() - 1000 } } });
    await createRoom('geo', '{invalid-json');
    await createRoom('jeopardy', expired);
    await createRoom('geo', expired, 'RUNNING', 'PAUSED');
    await createRoom('geo', expired, 'ENDED');
    await createRoom('geo', JSON.stringify({ phase: 'REVEAL', currentRoundIndex: 0,
      roundStates: { 0: { timerEndMs: Date.now() - 1000 } } }));
    const valid = await createRoom('geo', expired);
    const future = await createRoom('geo', JSON.stringify({ phase: 'INPUT_OPEN', currentRoundIndex: 0,
      roundStates: { 0: { timerEndMs: Date.now() + 60000 } } }));
    const expire = vi.spyOn(handleGeoGame, 'handleTimerExpired').mockResolvedValue(undefined);
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    try {
      await restoreActiveTimers(io);
      expect(expire).toHaveBeenCalledTimes(1);
      expect(expire.mock.calls[0][1].id).toBe(valid.id);
      expect(schedule.mock.calls.some(([, milliseconds]) => typeof milliseconds === 'number' && milliseconds > 59000)).toBe(true);
    } finally {
      cancelGeoTimer(future.id);
      schedule.mockRestore();
      expire.mockRestore();
    }
  });

  it('binds Geo joker actions to the subscribed player even with another player token', async () => {
    const geo = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } });
    const question = await prisma.geoQuestion.findFirstOrThrow({ where: { enabled: true } });
    const geoRoom = await prisma.room.create({
      data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'Geo identity', gameDefinitionId: geo.id, hostUserId: 'mod-1',
        status: 'LOBBY', setupSnapshotJson: JSON.stringify({ selectedQuestionIds: [question.id], timerDuration: 30 }),
      },
    });
    try {
      const parts = await Promise.all(['Geo Alice', 'Geo Bob'].map((displayName) => prisma.participation.create({
        data: { roomId: geoRoom.id, role: 'PLAYER', displayName,
          normalizedName: displayName.toLowerCase(), rejoinToken: randomUUID(), connected: true, ready: true },
      })));
      const host = await connect(createSessionCookie(
        (await prisma.session.findFirstOrThrow({ where: { userId: 'mod-1' } })).id,
        config.sessionSecret
      ));
      const first = await connect();
      const second = await connect();
      const spectator = await connect();
      expect((await ack(host, 'room:subscribe', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await ack(first, 'room:subscribe', { roomCode: geoRoom.code, rejoinToken: parts[0].rejoinToken })).success).toBe(true);
      expect((await ack(second, 'room:subscribe', { roomCode: geoRoom.code, rejoinToken: parts[1].rejoinToken })).success).toBe(true);
      expect((await ack(spectator, 'room:subscribe', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await ack(host, 'game:start', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await ack(first, 'jeopardy:buzz')).error).toBe('WRONG_GAME');
      expect((await ack(host, 'jeopardy:judge', { correct: true })).error).toBe('WRONG_GAME');
      expect((await ack(first, 'geo:answer', { optionId: 17 })).error).toBe('INVALID_PAYLOAD');
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const publicState = await ack(first, 'geo:resync');
      const publicQuestion = publicState.question as Record<string, unknown>;
      expect(publicState.phase).toBe('INPUT_OPEN');
      expect(publicQuestion.correctOptionId).toBeUndefined();
      expect(publicState.questions).toBeUndefined();
      const spectatorState = await ack(spectator, 'geo:resync');
      expect((spectatorState.question as Record<string, unknown>).correctOptionId).toBeUndefined();
      expect(spectatorState.ownJokers).toBeNull();
      expect((await ack(spectator, 'geo:joker:risk', { roomCode: geoRoom.code, rejoinToken: parts[0].rejoinToken })).success).toBe(false);
      expect(((await ack(host, 'geo:resync')).question as Record<string, unknown>).correctOptionId).toBe(question.correctOptionId);
      expect((await ack(first, 'geo:joker:risk', {
        roomCode: geoRoom.code, rejoinToken: parts[1].rejoinToken,
      })).success).toBe(true);
      const row = await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: geoRoom.id } });
      const state = JSON.parse(row.stateJson) as {
        currentRoundIndex: number;
        roundStates: Record<string, { playerStates: Record<string, { jokers: { usedRisk: boolean } }> }>;
      };
      const players = state.roundStates[state.currentRoundIndex].playerStates;
      expect(players[parts[0].id].jokers.usedRisk).toBe(true);
      expect(players[parts[1].id].jokers.usedRisk).toBe(false);
      expect(((await ack(first, 'geo:resync')).ownJokers as Record<string, unknown>).usedRisk).toBe(true);
      expect(((await ack(second, 'geo:resync')).ownJokers as Record<string, unknown>).usedRisk).toBe(false);
      expect((await ack(first, 'geo:joker:5050', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await ack(first, 'geo:resync')).ownEliminatedOptions).toHaveLength(2);
      expect((await ack(second, 'geo:resync')).ownEliminatedOptions).toEqual([]);
      const options = JSON.parse(question.options) as Array<{ id: string }>;
      const firstAnswer = options[0].id;
      const secondAnswer = options[2].id;
      const secondEvent = new Promise<Record<string, unknown>>(resolve => second.once('geo:answered', resolve));
      const viewerEvent = new Promise<Record<string, unknown>>(resolve => spectator.once('geo:answered', resolve));
      const moderatorEvent = new Promise<Record<string, unknown>>(resolve => host.once('geo:answered:moderator', resolve));
      expect((await ack(first, 'geo:answer', { optionId: firstAnswer })).success).toBe(true);
      expect(await secondEvent).toEqual({ questionIndex: 0, participantId: parts[0].id, answered: true });
      expect(await viewerEvent).toEqual({ questionIndex: 0, participantId: parts[0].id, answered: true });
      expect(await moderatorEvent).toMatchObject({ participantId: parts[0].id, optionId: firstAnswer });
      expect((await ack(second, 'geo:resync')).ownAnswer).toBeNull();
      expect((await ack(spectator, 'geo:resync')).ownAnswer).toBeNull();
      expect(JSON.stringify(await ack(second, 'geo:resync'))).not.toContain('selectedOptionId');
      expect(JSON.stringify(await ack(spectator, 'geo:resync'))).not.toContain('spyDistribution');
      const roomSnapshot = new Promise<Record<string, unknown>>(resolve => spectator.once('room:snapshot', resolve));
      expect((await ack(spectator, 'room:resync', { roomCode: geoRoom.code })).success).toBe(true);
      const snapshot = await roomSnapshot;
      expect(JSON.stringify(snapshot)).not.toContain('selectedOptionId');
      expect(JSON.stringify(snapshot)).not.toContain('correctOptionId');
      expect(JSON.stringify(snapshot)).not.toContain('spyDistribution');
      const spyEvent = new Promise<Record<string, unknown>>(resolve => second.once('geo:joker:spy:result', resolve));
      expect((await ack(second, 'geo:joker:spy', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await spyEvent).distribution).toEqual({ [firstAnswer]: 100 });
      expect((await ack(second, 'geo:resync')).ownSpyDistribution).toEqual({ [firstAnswer]: 100 });
      expect((await ack(first, 'geo:resync')).ownSpyDistribution).toBeNull();
      expect((await ack(spectator, 'geo:resync')).ownSpyDistribution).toBeNull();
      expect((await ack(second, 'geo:answer', { optionId: secondAnswer })).success).toBe(true);
      expect((await ack(first, 'geo:joker:spy', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await ack(first, 'geo:resync')).ownSpyDistribution).toEqual({ [secondAnswer]: 100 });
      expect((await ack(second, 'geo:resync')).ownSpyDistribution).toEqual({ [firstAnswer]: 100 });
      const moderatorStats = await ack(host, 'geo:resync');
      expect(moderatorStats.answerStats).toEqual({ [firstAnswer]: 1, [secondAnswer]: 1 });
      expect((await ack(first, 'geo:resync')).answerStats).toBeUndefined();
      expect((await ack(second, 'geo:resync')).answerStats).toBeUndefined();
      expect((await ack(spectator, 'geo:resync')).answerStats).toBeUndefined();
      const rejoinedSecond = await connect();
      expect((await ack(rejoinedSecond, 'room:subscribe', {
        roomCode: geoRoom.code, rejoinToken: parts[1].rejoinToken,
      })).success).toBe(true);
      expect((await ack(rejoinedSecond, 'geo:resync')).ownSpyDistribution).toEqual({ [firstAnswer]: 100 });
      expect((await ack(rejoinedSecond, 'geo:resync')).ownAnswer).toBe(secondAnswer);
      expect((await ack(second, 'geo:joker:risk', { roomCode: code, rejoinToken: parts[1].rejoinToken })).success).toBe(false);
      expect((await ack(host, 'game:pause', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: geoRoom.id } })).runPhase).toBe('PAUSED');
      expect((await ack(host, 'game:resume', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: geoRoom.id } })).runPhase).toBe('ROUND_ACTIVE');
      const resumed = JSON.parse((await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: geoRoom.id } })).stateJson) as {
        phase: string; currentRoundIndex: number;
        roundStates: Record<string, { timerEndMs: number | null; pauseRemainingMs: number | null }>;
      };
      expect(resumed.phase).toBe('INPUT_OPEN');
      expect(resumed.roundStates[resumed.currentRoundIndex].timerEndMs).toBeGreaterThan(Date.now());
      expect(resumed.roundStates[resumed.currentRoundIndex].pauseRemainingMs).toBeNull();
      expect((await ack(host, 'geo:reveal', { roomCode: geoRoom.code })).success).toBe(true);
      expect(((await ack(spectator, 'geo:resync')).question as Record<string, unknown>).correctOptionId).toBe(question.correctOptionId);
      expect((await ack(host, 'geo:next', { roomCode: geoRoom.code })).ended).toBe(true);
      expect((await ack(host, 'game:end', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await prisma.room.findUniqueOrThrow({ where: { id: geoRoom.id } })).status).toBe('ENDED');
      const endedGeoState = await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: geoRoom.id } });
      expect(endedGeoState.phase).toBe('GAME_END');
      for (const client of [host, first, spectator]) {
        const endedResync = await ack(client, 'geo:resync');
        expect(endedResync.phase).toBe('GAME_END');
        expect(endedResync.gameEnded).toBe(true);
        expect(endedResync.timerEndMs).toBeNull();
        expect(endedResync.question).toBeNull();
        expect(endedResync.answerStats).toBeUndefined();
      }
    } finally {
      temporaryRoomIds.push(geoRoom.id);
    }
  }, 15000);

  it('ends Geo during INPUT_OPEN and PAUSED without restarting either timer', async () => {
    const geo = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } });
    const question = await prisma.geoQuestion.findFirstOrThrow({ where: { enabled: true } });
    for (const pauseBeforeEnd of [false, true]) {
      const room = await prisma.room.create({ data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'Geo manual end', gameDefinitionId: geo.id, hostUserId: 'mod-1',
        status: 'LOBBY', setupSnapshotJson: JSON.stringify({ selectedQuestionIds: [question.id], timerDuration: 30 }),
      } });
      temporaryRoomIds.push(room.id);
      const player = await prisma.participation.create({ data: {
        roomId: room.id, role: 'PLAYER', displayName: 'Player', normalizedName: 'player',
        rejoinToken: randomUUID(), connected: true, ready: true,
      } });
      await prisma.participation.create({ data: {
        roomId: room.id, role: 'PLAYER', displayName: 'Second', normalizedName: 'second',
        rejoinToken: randomUUID(), connected: true, ready: true,
      } });
      const host = await connect(createSessionCookie(
        (await prisma.session.findFirstOrThrow({ where: { userId: 'mod-1' } })).id, config.sessionSecret
      ));
      const client = await connect();
      expect((await ack(host, 'room:subscribe', { roomCode: room.code })).success).toBe(true);
      expect((await ack(client, 'room:subscribe', { roomCode: room.code, rejoinToken: player.rejoinToken })).success).toBe(true);
      expect((await ack(host, 'game:start', { roomCode: room.code })).success).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 3200));
      expect((await ack(client, 'geo:resync')).phase).toBe('INPUT_OPEN');
      if (pauseBeforeEnd) {
        expect((await ack(host, 'game:pause', { roomCode: room.code })).success).toBe(true);
        expect((await ack(client, 'geo:resync')).phase).toBe('PAUSED');
      }
      const endEvents: unknown[] = [];
      client.on('game:end', payload => endEvents.push(payload));
      expect((await ack(host, 'game:end', { roomCode: room.code })).success).toBe(true);
      expect((await ack(host, 'game:end', { roomCode: room.code })).success).toBe(true);
      expect(endEvents).toHaveLength(1);
      const endedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
      const gameState = await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
      expect(endedRoom.status).toBe('ENDED');
      expect(endedRoom.runPhase).toBe('RESULTS');
      expect(gameState.phase).toBe('GAME_END');
      expect(JSON.parse(gameState.stateJson).phase).toBe('GAME_END');
      const endedResync = await ack(client, 'geo:resync');
      expect(endedResync.phase).toBe('GAME_END');
      expect(endedResync.timerEndMs).toBeNull();
      expect(endedResync.question).toBeNull();
      expect((await ack(host, 'game:resume', { roomCode: room.code })).success).toBe(false);
    }
  }, 20000);

  it('keeps two simultaneous Jeopardy rooms and their buzzer winners isolated', async () => {
    const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'jeopardy' } });
    const session = await prisma.session.findFirstOrThrow({ where: { userId: 'mod-1' } });
    const rooms = [];
    const clients = [];
    for (const label of ['Parallel A', 'Parallel B']) {
      const parallel = await prisma.room.create({
        data: {
          code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
          roomName: label, gameDefinitionId: game.id, hostUserId: 'mod-1', status: 'LOBBY',
          setupSnapshotJson: JSON.stringify({
            board1: { categories: [{ name: label, clues: [{ value: 100, question: `${label}?`, answer: `${label} SECRET` }] }] },
          }),
        },
      });
      temporaryRoomIds.push(parallel.id);
      const players = await Promise.all([0, 1].map((index) => prisma.participation.create({
        data: {
          roomId: parallel.id, role: 'PLAYER', displayName: `${label} ${index}`,
          normalizedName: `${label.toLowerCase()} ${index}`, rejoinToken: randomUUID(),
          connected: true, ready: true,
        },
      })));
      const host = await connect(createSessionCookie(session.id, config.sessionSecret));
      const player = await connect();
      const other = await connect();
      expect((await ack(host, 'room:subscribe', { roomCode: parallel.code })).success).toBe(true);
      expect((await ack(player, 'room:subscribe', { roomCode: parallel.code, rejoinToken: players[0].rejoinToken })).success).toBe(true);
      expect((await ack(other, 'room:subscribe', { roomCode: parallel.code, rejoinToken: players[1].rejoinToken })).success).toBe(true);
      rooms.push(parallel);
      clients.push({ host, player, other, playerId: players[0].id });
    }
    expect((await ack(clients[0].host, 'game:start', { roomCode: rooms[0].code })).success).toBe(true);
    expect((await ack(clients[1].host, 'game:start', { roomCode: rooms[1].code })).success).toBe(true);
    expect((await ack(clients[0].host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(true);
    expect((await ack(clients[1].host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(true);
    expect((await ack(clients[0].player, 'jeopardy:buzz')).success).toBe(true);
    expect((await ack(clients[1].player, 'jeopardy:buzz')).success).toBe(true);
    expect((await ack(clients[0].other, 'jeopardy:buzz')).success).toBe(false);
    expect((await ack(clients[1].other, 'jeopardy:buzz')).success).toBe(false);
    expect((await ack(clients[0].player, 'room:resync', { roomCode: rooms[1].code })).success).toBe(false);
    expect((await ack(clients[0].player, 'jeopardy:resync')).buzzWinnerId).toBe(clients[0].playerId);
    expect((await ack(clients[1].player, 'jeopardy:resync')).buzzWinnerId).toBe(clients[1].playerId);
    expect(JSON.stringify(await ack(clients[0].player, 'jeopardy:resync'))).not.toContain('Parallel B SECRET');
    expect(JSON.stringify(await ack(clients[1].player, 'jeopardy:resync'))).not.toContain('Parallel A SECRET');
  }, 15000);
});
