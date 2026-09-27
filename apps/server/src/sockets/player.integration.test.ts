import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDatabase } from '../test-helpers.js';
import { handlePlayerEvents } from './player.js';
import { roomChannel } from './channel.js';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map(path => rm(path, { recursive: true, force: true })));
});

describe('player socket identity', () => {
  it('ignores forged room and participation data for ready and profile changes', async () => {
    const { PrismaClient } = await import('@prisma/client');
    const directory = await mkdtemp(join(tmpdir(), 'quiz-player-auth-'));
    directories.push(directory);
    const url = `file:${join(directory, 'test.db')}`;
    await createTestDatabase(url);
    const db = new PrismaClient({ datasourceUrl: url });
    await db.$connect();
    globalThis.__prisma = db;
    try {
      const host = await db.user.create({ data: {
        displayName: 'Host', email: 'player-auth@test.local', passwordHash: 'unused', role: 'MODERATOR',
      } });
      const game = await db.gameDefinition.create({ data: {
        slug: 'player-auth', name: 'Game', category: 'GEO', status: 'AVAILABLE',
      } });
      const createRoom = (code: string) => db.room.create({ data: {
        code, roomName: code, hostUserId: host.id, gameDefinitionId: game.id,
      } });
      const ownRoom = await createRoom('111-111');
      const otherRoom = await createRoom('222-222');
      const createPlayer = (roomId: string, name: string) => db.participation.create({ data: {
        roomId, displayName: name, normalizedName: name.toLowerCase(),
        role: 'PLAYER', connected: true, rejoinToken: `${name}-token`,
      } });
      const own = await createPlayer(ownRoom.id, 'Own');
      const other = await createPlayer(otherRoom.id, 'Other');
      const emit = vi.fn();
      const to = vi.fn(() => ({ emit }));
      const io = { to } as unknown as Server;
      const socket = { data: {
        roomId: ownRoom.id, participationId: own.id, role: 'PLAYER',
      }, rooms: new Set([roomChannel(ownRoom.id)]) } as unknown as Socket;
      const readyAck = vi.fn();
      await handlePlayerEvents.setReady(io, socket, {
        roomCode: otherRoom.code, rejoinToken: other.rejoinToken, ready: true,
      }, readyAck);
      expect(readyAck).toHaveBeenCalledWith({ success: true });
      expect((await db.participation.findUniqueOrThrow({ where: { id: own.id } })).ready).toBe(true);
      expect((await db.participation.findUniqueOrThrow({ where: { id: other.id } })).ready).toBe(false);
      expect(to).toHaveBeenCalledWith(roomChannel(ownRoom.id));
      const profileAck = vi.fn();
      await handlePlayerEvents.updateProfile(io, socket, {
        roomCode: otherRoom.code, rejoinToken: other.rejoinToken, avatarMode: 'custom',
      }, profileAck);
      expect(profileAck).toHaveBeenCalledWith({ success: true });
      expect((await db.participation.findUniqueOrThrow({ where: { id: other.id } })).avatarMode).toBe('none');

      // An evicted socket has no room membership, even if it still holds old identity data.
      socket.rooms.delete(roomChannel(ownRoom.id));
      const staleAck = vi.fn();
      await handlePlayerEvents.setReady(io, socket, { roomCode: ownRoom.code, ready: false }, staleAck);
      expect(staleAck).toHaveBeenCalledWith({ success: false, error: 'NOT_IN_ROOM' });
    } finally {
      await db.$disconnect();
    }
  });
});
