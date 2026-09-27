import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../../persistence/prisma.js';
import { setupSocketHandlers } from '../../sockets/index.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';

describe('Wer ist das? real multiplayer sockets', () => {
  let server: HttpServer;
  let io: Server;
  let origin: string;
  let roomId: string;
  let code: string;
  let imageId: string;
  let moderator: ClientSocket;
  let alice: ClientSocket;
  let bob: ClientSocket;
  let viewer: ClientSocket;
  let aliceId: string;
  let bobId: string;
  let aliceToken: string;
  const sockets: ClientSocket[] = [];
  const otherRooms: string[] = [];
  const secret = 'UNIQUE_PRIVATE_PERSON_12345';
  const ack = gameAck;
  async function connect(cookie?: string) {
    const socket = await connectGameClient(origin, cookie);
    sockets.push(socket);
    return socket;
  }
  beforeAll(async () => {
    const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'weristdas' } });
    const asset = await prisma.mediaAsset.create({ data: {
      type: 'image', mimeType: 'image/png', filename: 'weristdas-test.png', originalName: 'test.png',
      fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/weristdas-test.png', uploadedBy: 'mod-1',
    } });
    imageId = asset.id;
    const session = await prisma.session.create({ data: { userId: 'mod-1', expiresAt: new Date(Date.now() + 60000) } });
    code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
    const setup = JSON.stringify({ rounds: [
      { id: 'one', imageAssetId: imageId, person1: secret, person2: 'Second', aliases1: ['HIDDEN_ALIAS'] },
      { id: 'two', imageAssetId: imageId, person1: 'Third', person2: 'Fourth' },
    ] });
    const room = await prisma.room.create({ data: { code, roomName: 'Wer ist das test',
      gameDefinitionId: game.id, hostUserId: 'mod-1', status: 'LOBBY', runPhase: 'LOBBY',
      viewerRequiresPin: false, setupSnapshotJson: setup } });
    roomId = room.id;
    const players = await Promise.all(['Alice', 'Bob'].map(displayName => prisma.participation.create({
      data: { roomId, role: 'PLAYER', displayName, normalizedName: displayName.toLowerCase(),
        rejoinToken: randomUUID(), connected: true, ready: true },
    })));
    aliceId = players[0].id; bobId = players[1].id; aliceToken = players[0].rejoinToken;
    server = createServer(); io = new Server(server); setupSocketHandlers(io);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    origin = `http://127.0.0.1:${address.port}`;
    moderator = await connect(createSessionCookie(session.id, config.sessionSecret));
    alice = await connect(); bob = await connect(); viewer = await connect();
    expect((await ack(moderator, 'room:subscribe', { roomCode: code })).success).toBe(true);
    expect((await ack(alice, 'room:subscribe', { roomCode: code, rejoinToken: aliceToken })).success).toBe(true);
    expect((await ack(bob, 'room:subscribe', { roomCode: code, rejoinToken: players[1].rejoinToken })).success).toBe(true);
    expect((await ack(viewer, 'room:subscribe', { roomCode: code })).success).toBe(true);
  }, 15000);
  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    if (io) await new Promise<void>(resolve => io.close(() => resolve()));
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const id of otherRooms) await prisma.room.delete({ where: { id } });
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    if (imageId) await prisma.mediaAsset.delete({ where: { id: imageId } });
  });

  it('plays both rounds with CAS buzzes, role security, scores, reload and no early secrets', async () => {
    const received: string[] = [];
    alice.onAny((_event, value: unknown) => received.push(JSON.stringify(value)));
    viewer.onAny((_event, value: unknown) => received.push(JSON.stringify(value)));
    expect((await ack(moderator, 'game:start', { roomCode: code })).success).toBe(true);
    expect((await ack(alice, 'weristdas:resync')).state).toMatchObject({ phase: 'ROUND_READY', imageAssetId: imageId });
    expect(JSON.stringify(await ack(viewer, 'weristdas:resync'))).not.toContain(secret);
    expect(JSON.stringify(await ack(moderator, 'weristdas:resync'))).toContain(secret);
    expect(received.join(' ')).not.toContain(secret);
    expect((await ack(viewer, 'weristdas:buzz')).error).toBe('FORBIDDEN');
    expect((await ack(alice, 'weristdas:judge', { result: 'BOTH_CORRECT' })).error).toBe('FORBIDDEN');
    expect((await ack(alice, 'weristdas:hint')).error).toBe('FORBIDDEN');
    expect((await ack(alice, 'weristdas:next')).error).toBe('FORBIDDEN');
    expect((await ack(moderator, 'weristdas:buzzer:open')).success).toBe(true);
    const races = await Promise.all([ack(alice, 'weristdas:buzz'), ack(bob, 'weristdas:buzz')]);
    expect(races.filter(r => r.success)).toHaveLength(1);
    const loser = races[0].success ? bob : alice;
    const winner = races[0].success ? alice : bob;
    const winnerId = races[0].success ? aliceId : bobId;
    expect((await ack(viewer, 'weristdas:resync')).state).toMatchObject({ phase: 'ANSWERING', winnerId });
    expect((await ack(moderator, 'weristdas:judge', { result: 'WRONG' })).success).toBe(true);
    expect((await ack(moderator, 'weristdas:buzzer:open')).success).toBe(true);
    expect((await ack(winner, 'weristdas:buzz')).error).toBe('PLAYER_EXCLUDED');
    expect((await ack(loser, 'weristdas:buzz')).success).toBe(true);
    expect((await ack(moderator, 'weristdas:judge', { result: 'ONE_CORRECT' })).error).toBe('HINT_REQUIRED');
    expect((await ack(moderator, 'weristdas:hint')).success).toBe(true);
    expect((await ack(moderator, 'weristdas:judge', { result: 'ONE_CORRECT' })).success).toBe(true);
    expect((await ack(moderator, 'weristdas:judge', { result: 'ONE_CORRECT' })).success).toBe(false);
    const reveal = await ack(viewer, 'weristdas:resync');
    expect(JSON.stringify(reveal)).toContain(secret);
    expect(reveal.state).toMatchObject({ phase: 'REVEAL', hintActive: true });
    const events = await prisma.scoreEvent.findMany({ where: { roomId } });
    expect(events.map(e => e.delta).sort()).toEqual([-1, 1]);
    for (const player of await prisma.participation.findMany({ where: { roomId, role: 'PLAYER' } })) {
      const projected = (reveal.state as { scores: Record<string, number> }).scores;
      expect(projected[player.id]).toBe(player.score);
      expect(player.score).toBe(events.filter(e => e.participationId === player.id).reduce((sum, e) => sum + e.delta, 0));
    }
    expect((await ack(moderator, 'weristdas:next')).success).toBe(true);
    const next = await ack(winner, 'weristdas:resync');
    expect(next.state).toMatchObject({ roundIndex: 1, phase: 'ROUND_READY', hintActive: false, excluded: false });
    expect(JSON.stringify(next)).not.toContain('Third');
    expect((await ack(moderator, 'weristdas:buzzer:open')).success).toBe(true);
    expect((await ack(winner, 'weristdas:buzz')).success).toBe(true);
    expect((await ack(moderator, 'weristdas:judge', { result: 'BOTH_CORRECT' })).success).toBe(true);
    expect((await ack(moderator, 'weristdas:next')).success).toBe(true);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).runPhase).toBe('RESULTS');
    expect((await ack(viewer, 'weristdas:resync')).state).toMatchObject({ phase: 'GAME_END' });
    const rejoined = await connect();
    expect((await ack(rejoined, 'room:subscribe', { roomCode: code, rejoinToken: aliceToken })).success).toBe(true);
    expect((await ack(rejoined, 'weristdas:resync')).state).toMatchObject({ phase: 'GAME_END' });
    expect((await ack(alice, 'weristdas:resync')).success).toBe(false);
  }, 30000);

  it('rejects foreign room access and rolls back invalid setup', async () => {
    const source = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    const other = await prisma.room.create({ data: { code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
      roomName: 'Invalid image', gameDefinitionId: source.gameDefinitionId, hostUserId: 'mod-1',
      status: 'LOBBY', setupSnapshotJson: JSON.stringify({ rounds: [{ id: 'bad', imageAssetId: randomUUID(), person1: 'A', person2: 'B' }] }) } });
    otherRooms.push(other.id);
    await Promise.all(['A', 'B'].map(displayName => prisma.participation.create({ data: {
      roomId: other.id, displayName, normalizedName: displayName.toLowerCase(), role: 'PLAYER',
      rejoinToken: randomUUID(), connected: true, ready: true,
    } })));
    const stranger = await connect();
    expect((await ack(stranger, 'room:subscribe', { roomCode: other.code, rejoinToken: aliceToken })).success).toBe(false);
    expect((await ack(stranger, 'weristdas:resync')).success).toBe(false);
    const host = await connect(createSessionCookie((await prisma.session.findFirstOrThrow({ where: { userId: 'mod-1' } })).id, config.sessionSecret));
    expect((await ack(host, 'room:subscribe', { roomCode: other.code })).success).toBe(true);
    expect((await ack(host, 'game:start', { roomCode: other.code })).success).toBe(false);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('LOBBY');
    expect(await prisma.roomGameState.findUnique({ where: { roomId: other.id } })).toBeNull();
  });
});
