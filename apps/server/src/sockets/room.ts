// ============================================================
// Room Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';

export function handleRoomSubscription(
  io: Server,
  socket: Socket,
  data: { roomCode: string; rejoinToken?: string },
  callback?: (result: any) => void
) {
  const { roomCode, rejoinToken } = data;

  // Find room
  const room = prisma.room.findUnique({
    where: { code: roomCode },
    include: {
      gameDefinition: true,
      participations: { where: { role: { not: 'VIEWER' } } },
      viewerSessions: true,
    },
  }).then(async (room) => {
    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    // Join socket room
    socket.join(roomCode);

    // Get or create participation
    let participation = null;
    if (rejoinToken) {
      participation = await prisma.participation.findUnique({
        where: { rejoinToken },
      });
      if (participation) {
        // Update to connected
        await prisma.participation.update({
          where: { id: participation.id },
          data: { connected: true, lastSeenAt: new Date() },
        });
      }
    }

    // Build snapshot
    const snapshot = {
      roomId: room.id,
      code: room.code,
      roomName: room.roomName,
      status: room.status,
      runPhase: room.runPhase,
      game: {
        slug: room.gameDefinition.slug,
        name: room.gameDefinition.name,
      },
      players: room.participations.map(p => ({
        id: p.id,
        displayName: p.displayName,
        role: p.role,
        connected: p.connected,
        ready: p.ready,
        score: p.score,
        avatarMode: p.avatarMode,
        avatarGenerated: p.avatarGenerated ? JSON.parse(p.avatarGenerated) : null,
      })),
      viewerCount: room.viewerSessions.length,
      revision: room.revision,
      serverTime: Date.now(),
    };

    // Send snapshot
    socket.emit('room:snapshot', snapshot);

    // Broadcast update to room
    io.to(roomCode).emit('room:updated', {
      roomCode,
      revision: room.revision + 1,
      players: snapshot.players,
    });

    // Emit player join
    if (participation) {
      io.to(roomCode).emit('player:join', {
        player: {
          id: participation.id,
          displayName: participation.displayName,
          role: participation.role,
          connected: true,
        },
      });
    }

    callback?.({ success: true, snapshot });

    logger.info('Room subscribed', { socketId: socket.id, roomCode });
  });

  return room;
}

export const handleRoomEvents = {
  resync(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    // Re-send current state
    prisma.room.findUnique({
      where: { code: data.roomCode },
      include: {
        gameDefinition: true,
        participations: { where: { role: { not: 'VIEWER' } } },
      },
    }).then((room) => {
      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      socket.emit('room:snapshot', {
        roomId: room.id,
        code: room.code,
        status: room.status,
        runPhase: room.runPhase,
        game: { slug: room.gameDefinition.slug, name: room.gameDefinition.name },
        players: room.participations.map(p => ({
          id: p.id,
          displayName: p.displayName,
          role: p.role,
          connected: p.connected,
          ready: p.ready,
          score: p.score,
        })),
        revision: room.revision,
        serverTime: Date.now(),
      });

      callback?.({ success: true });
    });
  },
};
