import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleDisconnect } from './lobby.js';
import { handleRoomSubscription } from './room.js';
import { socketIdentityMap } from '../http/middleware/auth.js';
import { createTestDatabase } from '../test-helpers.js';

const tempDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirectories.map(directory => rm(directory, { recursive: true, force: true })));
});

async function createDatabase() {
  const { PrismaClient } = await import('@prisma/client');
  const directory = await mkdtemp(join(tmpdir(), 'quiz-reconnect-'));
  tempDirectories.push(directory);
  const databaseUrl = `file:${join(directory, 'test.db')}`;

  await createTestDatabase(databaseUrl);

  const database = new PrismaClient({ datasourceUrl: databaseUrl });
  await database.$connect();
  globalThis.__prisma = database;
  return database;
}

function createIo(): Server {
  const emit = vi.fn();
  return {
    sockets: { sockets: new Map() },
    to: vi.fn(() => ({ emit })),
  } as unknown as Server;
}

function createSocket(id: string, user: { id: string; displayName: string }): Socket {
  const rooms = new Set<string>([id]);
  return {
    id,
    data: {},
    rooms,
    user,
    join: vi.fn(async (channel: string) => { rooms.add(channel); }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as Socket;
}

describe('Moderator reconnect', () => {
  it('reuses one moderator participation across repeated reconnects', async () => {
    const database = await createDatabase();
    const host = await database.user.create({
      data: {
        id: 'reconnect-host',
        displayName: 'Reconnect Host',
        email: 'reconnect-host@test.local',
        passwordHash: 'unused',
        role: 'MODERATOR',
      },
    });
    const otherUser = await database.user.create({
      data: {
        id: 'reconnect-other',
        displayName: 'Other Moderator',
        email: 'reconnect-other@test.local',
        passwordHash: 'unused',
        role: 'MODERATOR',
      },
    });
    const game = await database.gameDefinition.create({
      data: {
        id: 'reconnect-geo',
        slug: 'reconnect-geo',
        name: 'Geo',
        category: 'GEO',
        status: 'AVAILABLE',
      },
    });
    const room = await database.room.create({
      data: {
        code: '321-654',
        roomName: 'Reconnect Room',
        hostUserId: host.id,
        gameDefinitionId: game.id,
        status: 'LOBBY',
        runPhase: 'OPEN',
        allowViewers: true,
        viewerRequiresPin: false,
      },
    });
    const originalModerator = await database.participation.create({
      data: {
        roomId: room.id,
        displayName: host.displayName,
        normalizedName: host.displayName.toLowerCase(),
        role: 'MODERATOR',
        connected: false,
        ready: true,
        rejoinToken: 'original-moderator-token',
      },
    });
    const io = createIo();

    for (let reconnect = 0; reconnect < 3; reconnect += 1) {
      const socket = createSocket(`host-socket-${reconnect}`, host);
      const acknowledgement = vi.fn();

      await handleRoomSubscription(io, socket, { roomCode: room.code }, acknowledgement);

      expect(acknowledgement).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(socket.data.participationId).toBe(originalModerator.id);
      expect(socket.data.role).toBe('MODERATOR');
      expect(socketIdentityMap.get(socket.id)?.userId).toBe(host.id);

      const moderators = await database.participation.findMany({
        where: { roomId: room.id, role: 'MODERATOR' },
      });
      expect(moderators).toHaveLength(1);
      expect(moderators[0].id).toBe(originalModerator.id);
      expect(moderators[0].connected).toBe(true);

      await handleDisconnect(io, socket);
      expect(socketIdentityMap.has(socket.id)).toBe(false);
    }

    // A reload can establish the new socket before the old socket's delayed
    // disconnect handler runs. The late disconnect must not mark the reused
    // moderator participation as offline.
    const oldSocket = createSocket('host-socket-old', host);
    const replacementSocket = createSocket('host-socket-replacement', host);
    await handleRoomSubscription(io, oldSocket, { roomCode: room.code }, vi.fn());
    await handleRoomSubscription(io, replacementSocket, { roomCode: room.code }, vi.fn());
    await handleDisconnect(io, oldSocket);

    const moderatorAfterRace = await database.participation.findUniqueOrThrow({
      where: { id: originalModerator.id },
    });
    expect(moderatorAfterRace.connected).toBe(true);
    expect(await database.participation.count({ where: { roomId: room.id, role: 'MODERATOR' } })).toBe(1);

    const nonHostSocket = createSocket('non-host-socket', otherUser);
    const nonHostAcknowledgement = vi.fn();
    await handleRoomSubscription(io, nonHostSocket, { roomCode: room.code }, nonHostAcknowledgement);
    expect(nonHostAcknowledgement).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(nonHostSocket.data.role).toBe('VIEWER');
    expect(await database.participation.count({ where: { roomId: room.id, role: 'MODERATOR' } })).toBe(1);

    await handleDisconnect(io, replacementSocket);
    await handleDisconnect(io, nonHostSocket);
    socketIdentityMap.clear();
    await database.$disconnect();
  });
});
