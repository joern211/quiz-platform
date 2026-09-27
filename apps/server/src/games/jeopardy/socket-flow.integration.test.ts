import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../../persistence/prisma.js';
import { setupSocketHandlers } from '../../sockets/index.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';

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

  async function ack(socket: ClientSocket, event: string, data: object = {}): Promise<Record<string, unknown>> {
    return socket.timeout(6000).emitWithAck(event, data) as Promise<Record<string, unknown>>;
  }

  async function connect(cookie?: string): Promise<ClientSocket> {
    const socket = clientIo(origin, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: cookie ? { Cookie: cookie } : undefined,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
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
      expect((await ack(host, 'room:subscribe', { roomCode: geoRoom.code })).success).toBe(true);
      expect((await ack(first, 'room:subscribe', { roomCode: geoRoom.code, rejoinToken: parts[0].rejoinToken })).success).toBe(true);
      expect((await ack(second, 'room:subscribe', { roomCode: geoRoom.code, rejoinToken: parts[1].rejoinToken })).success).toBe(true);
      expect((await ack(host, 'game:start', { roomCode: geoRoom.code })).success).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const publicState = await ack(first, 'geo:resync');
      const publicQuestion = publicState.question as Record<string, unknown>;
      expect(publicState.phase).toBe('INPUT_OPEN');
      expect(publicQuestion.correctOptionId).toBeUndefined();
      expect(publicState.questions).toBeUndefined();
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
      expect((await ack(host, 'game:end', { roomCode: geoRoom.code })).success).toBe(true);
    } finally {
      temporaryRoomIds.push(geoRoom.id);
    }
  }, 15000);
});
