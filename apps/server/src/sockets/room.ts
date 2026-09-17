// ============================================================
// Room Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { socketIdentityMap } from '../http/middleware/auth.js';
import { roomChannel } from './index.js';

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

  // P0-04: Extract authenticated userId from HTTP session (set by socket middleware)
  const userId = (socket as any).user?.id;

  // P0-10: Enforce viewer limit before creating a new viewer session.
  // Count connected viewer sessions; if this socket provides a rejoinToken it is
  // handled in the rejoin branch below and does not consume a viewer slot.
  if (!rejoinToken && room.allowViewers && room.viewerLimit != null && room.viewerLimit > 0) {
    const connectedViewers = room.viewerSessions.filter(vs => vs.connected).length;
    if (connectedViewers >= room.viewerLimit) {
      callback?.({ success: false, error: 'VIEWER_LIMIT_REACHED', limit: room.viewerLimit });
      return;
    }
  }

  // Initialize default socket data
  socket.data = {
    participationId: undefined,
    roomId: undefined,
    role: undefined,
    displayName: undefined,
    userId: userId ?? undefined,
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

    // P0-13: Check if kicked
    if (participation?.kickedAt) {
      callback?.({ success: false, error: 'KICKED' });
      return;
    }

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

    // P0-04: If userId matches host, auto-upgrade to MODERATOR
    if (userId && room.hostUserId && userId === room.hostUserId) {
      identity.role = 'MODERATOR';
      // Update DB to reflect MODERATOR role
      await prisma.participation.update({
        where: { id: participation.id },
        data: { role: 'MODERATOR' },
      });
    }
  } else if (!room.allowViewers) {
    // Viewers not allowed
    callback?.({ success: false, error: 'VIEWERS_NOT_ALLOWED' });
    return;
  // P0-05: ONLY require PIN if viewerRequiresPin=true AND room.pinHash != null
  // If pinHash is null, skip PIN requirement (room was created without PIN)
  // If viewerRequiresPin is false, skip PIN requirement
  } else if (room.viewerRequiresPin && room.pinHash != null) {
    // Check PIN for viewer access
    if (!pin) {
      callback?.({ success: false, error: 'PIN_REQUIRED' });
      return;
    }

    // Verify PIN
    const crypto = await import('crypto');
    const inputHash = crypto.createHash('sha256').update(pin).digest('hex');
    if (inputHash !== room.pinHash) {
      callback?.({ success: false, error: 'INVALID_PIN' });
      return;
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
    // Anonymous viewer (no PIN required)
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
  socket.data = {
    ...socket.data,
    participationId: identity.participationId,
    roomId: identity.roomId,
    role: identity.role,
    displayName: identity.displayName,
  };

  // Also update socketIdentityMap for http/middleware/auth.ts compatibility
  socketIdentityMap.set(socket.id, {
    socketId: socket.id,
    participationId: identity.participationId,
    role: identity.role as any,
    roomId: identity.roomId,
  });

  // ONLY AFTER identity validated: socket.join(roomChannel(room.id)) (P0-07 fix)
  await socket.join(roomChannel(room.id));

  // Build snapshot
  const snapshot = {
    roomId: room.id,
    code: room.code,
    roomName: room.roomName,
    status: room.status,
    runPhase: room.runPhase,
    lobbyChatEnabled: room.lobbyChatEnabled,  // P1-1 (SOCK-005): expose chat state in snapshot
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
  io.to(roomChannel(room.id)).emit('room:updated', {
    roomCode: room.code,
    revision: room.revision + 1,
    players: snapshot.players,
  });

  // Emit player join only for actual players (not viewers), only to THIS room
  if (identity.role !== 'VIEWER' && identity.participationId) {
    io.to(roomChannel(room.id)).emit('player:join', {
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

export async function handleKickPlayer(
  io: Server,
  socket: Socket,
  data: { roomCode: string; playerId: string },
  callback?: (result: any) => void
) {
  try {
    // Require MODERATOR role
    const identity = (socket as any).data;
    if (!identity || identity.role !== 'MODERATOR') {
      callback?.({ success: false, error: 'UNAUTHORIZED' });
      return;
    }

    const room = await prisma.room.findUnique({
      where: { code: data.roomCode },
    });

    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    // Verify moderator belongs to this room
    if (identity.roomId !== room.id) {
      callback?.({ success: false, error: 'WRONG_ROOM' });
      return;
    }

    // Find the participation to kick
    const participation = await prisma.participation.findFirst({
      where: { id: data.playerId, roomId: room.id, role: { not: 'MODERATOR' } },
    });

    if (!participation) {
      callback?.({ success: false, error: 'PLAYER_NOT_FOUND' });
      return;
    }

    // Mark as kicked and update timestamp; rotate rejoin token so the old
    // one can never be reused (P0-11). kickedAt is checked on every subscribe.
    const crypto = await import('crypto');
    await prisma.participation.update({
      where: { id: data.playerId },
      data: {
        kickedAt: new Date(),
        connected: false,
        rejoinToken: crypto.randomUUID(),
        rejoinTokenVersion: { increment: 1 },
      },
    });

    // P0-12: Broadcast 'room:kicked' to the kicked player
    io.to(roomChannel(room.id)).emit('room:kicked', {
      participationId: data.playerId,
      reason: 'Du wurdest vom Moderator entfernt',
    });

    // Broadcast updated room state
    const updatedRoom = await prisma.room.findUnique({
      where: { id: room.id },
      include: { participations: { where: { role: { not: 'VIEWER' } } } },
    });

    if (updatedRoom) {
      io.to(roomChannel(room.id)).emit('room:updated', {
        roomCode: room.code,
        revision: room.revision + 1,
        players: updatedRoom.participations.map(p => ({
          id: p.id,
          displayName: p.displayName,
          role: p.role,
          connected: p.connected,
          ready: p.ready,
          score: p.score,
        })),
      });
    }

    logger.info('Player kicked', { roomCode: data.roomCode, playerId: data.playerId });
    callback?.({ success: true });
  } catch (error) {
    logger.error('Kick player error', { error });
    callback?.({ success: false, error: 'INTERNAL_ERROR' });
  }
}

export const handleRoomEvents = {
  async resync(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    // P0-09: only authorized, room-bound sockets may resync
    const identity = (socket as any).data;
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

    if (!identity?.roomId || identity.roomId !== room.id ||
        !socket.rooms.has(roomChannel(room.id))) {
      callback?.({ success: false, error: 'UNAUTHORIZED' });
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
