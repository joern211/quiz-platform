// ============================================================
// Room Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';

export async function handleRoomSubscription(
  io: Server,
  socket: Socket,
  data: { roomCode: string; rejoinToken?: string; pin?: string },
  callback?: (result: any) => void
) {
  const { roomCode, rejoinToken, pin } = data;

  // Find room
  const room = await prisma.room.findUnique({
    where: { code: roomCode },
    include: {
      gameDefinition: true,
      participations: { where: { role: { not: 'VIEWER' } } },
      viewerSessions: true,
    },
  });

  if (!room) {
    callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
    return;
  }

  // Initialize default socket data
  socket.data = {
    participationId: undefined,
    roomId: undefined,
    role: undefined,
    displayName: undefined,
  };

  let identity = {
    participationId: '',
    roomId: room.id,
    role: '',
    displayName: '',
  };

  // Handle rejoin token - validate against THIS room
  if (rejoinToken) {
    const participation = await prisma.participation.findUnique({
      where: { rejoinToken },
      include: { room: true },
    });

    // Validate rejoin token belongs to THIS room (P0-07 fix)
    if (!participation || participation.roomId !== room.id) {
      callback?.({ success: false, error: 'INVALID_REJOIN_TOKEN' });
      return;
    }

    // Update to connected
    await prisma.participation.update({
      where: { id: participation.id },
      data: { connected: true, lastSeenAt: new Date() },
    });

    identity = {
      participationId: participation.id,
      roomId: room.id,
      role: participation.role,
      displayName: participation.displayName,
    };
  } else if (!room.allowViewers) {
    // Viewers not allowed
    callback?.({ success: false, error: 'VIEWERS_NOT_ALLOWED' });
    return;
  } else if (room.viewerRequiresPin) {
    // Check PIN for viewer access (P0-06 fix)
    if (!pin) {
      callback?.({ success: false, error: 'PIN_REQUIRED' });
      return;
    }

    // Verify PIN
    if (room.pinHash) {
      const crypto = await import('crypto');
      const inputHash = crypto.createHash('sha256').update(pin).digest('hex');
      if (inputHash !== room.pinHash) {
        callback?.({ success: false, error: 'INVALID_PIN' });
        return;
      }
    }

    // Create or update ViewerSession
    const viewerSession = await prisma.viewerSession.create({
      data: {
        roomId: room.id,
        connected: true,
        lastSeenAt: new Date(),
      },
    });

    identity = {
      participationId: `viewer:${viewerSession.id}`,
      roomId: room.id,
      role: 'VIEWER',
      displayName: 'Zuschauer',
    };
  } else {
    // Anonymous viewer
    const viewerSession = await prisma.viewerSession.create({
      data: {
        roomId: room.id,
        connected: true,
        lastSeenAt: new Date(),
      },
    });

    identity = {
      participationId: `viewer:${viewerSession.id}`,
      roomId: room.id,
      role: 'VIEWER',
      displayName: 'Zuschauer',
    };
  }

  // Store identity in socket.data (P0-08/P0-09 fix)
  socket.data = identity;

  // ONLY AFTER identity validated: socket.join(roomCode) (P0-07 fix)
  await socket.join(roomCode);

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
    viewerCount: room.viewerSessions.filter(vs => vs.connected).length,
    revision: room.revision,
    serverTime: Date.now(),
    // Include identity for client to store
    identity: {
      participationId: identity.participationId,
      role: identity.role,
    },
  };

  // Send snapshot
  socket.emit('room:snapshot', snapshot);

  // Broadcast update to room (only THIS room)
  io.to(roomCode).emit('room:updated', {
    roomCode,
    revision: room.revision + 1,
    players: snapshot.players,
  });

  // Emit player join only for actual players (not viewers), only to THIS room
  if (identity.role !== 'VIEWER' && identity.participationId) {
    io.to(roomCode).emit('player:join', {
      player: {
        id: identity.participationId,
        displayName: identity.displayName,
        role: identity.role,
        connected: true,
      },
    });
  }

  callback?.({ success: true, snapshot });

  logger.info('Room subscribed', {
    socketId: socket.id,
    roomCode,
    role: identity.role,
    participationId: identity.participationId,
  });
}

export const handleRoomEvents = {
  async resync(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    const room = await prisma.room.findUnique({
      where: { code: data.roomCode },
      include: {
        gameDefinition: true,
        participations: { where: { role: { not: 'VIEWER' } } },
        viewerSessions: true,
      },
    });

    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    socket.emit('room:snapshot', {
      roomId: room.id,
      code: room.code,
      roomName: room.roomName,
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
        avatarMode: p.avatarMode,
        avatarGenerated: p.avatarGenerated ? JSON.parse(p.avatarGenerated) : null,
      })),
      viewerCount: room.viewerSessions.filter(vs => vs.connected).length,
      revision: room.revision,
      serverTime: Date.now(),
    });

    callback?.({ success: true });
  },
};
