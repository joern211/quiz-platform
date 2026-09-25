// ============================================================
// Room Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { socketIdentityMap } from '../http/middleware/auth.js';
import { roomChannel } from './index.js';

/**
 * Cleanup old disconnected ViewerSessions for a room
 * Called before creating a new session to prevent orphaned sessions
 */
async function cleanupOldViewerSessions(roomId: string): Promise<number> {
  // Delete sessions disconnected more than 5 minutes ago
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  
  const result = await prisma.viewerSession.deleteMany({
    where: {
      roomId,
      connected: false,
      OR: [
        { disconnectedAt: { lt: fiveMinutesAgo } },
        { lastSeenAt: { lt: fiveMinutesAgo } },
      ],
    },
  });
  
  return result.count;
}

export async function handleRoomSubscription(
  io: Server,
  socket: Socket,
  data: { roomCode: string; rejoinToken?: string; pin?: string; moderatorToken?: string },
  callback?: (result: any) => void
) {
  const { roomCode, rejoinToken, pin, moderatorToken } = data;

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

  // Initialize default socket data
  socket.data = {
    participationId: undefined,
    roomId: undefined,
    role: undefined,
    displayName: undefined,
    userId: userId ?? undefined,
  };

  // Auth shortcut used in both VIEWER and auto-upgrade paths
  const authModerator = socket as any;

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

    // Phase 3: Moderator Identity Validation
    // If participation is MODERATOR in DB, require moderatorToken to match
    // Token + Participation (MODERATOR role) + Host-User + Room must all align
    if (participation.role === 'MODERATOR') {
      // A moderator MUST provide a valid moderatorToken that matches their participation
      // moderatorToken is the same as rejoinToken for the moderator's own participation
      if (!moderatorToken || moderatorToken !== participation.rejoinToken) {
        logger.warn('Invalid moderator token', {
          socketId: socket.id,
          roomCode,
          participationId: participation.id,
          hasModeratorToken: !!moderatorToken,
          tokenMatches: moderatorToken === participation.rejoinToken,
        });
        // P0 Security: Immediately disconnect - do NOT silently create anonymous viewer
        socket.emit('error', { code: 'INVALID_MODERATOR_TOKEN' });
        socket.disconnect(true);
        return;
      }

      // Also verify the moderator's userId matches the room's hostUserId
      if (userId && room.hostUserId && userId !== room.hostUserId) {
        logger.warn('Moderator token user mismatch', {
          socketId: socket.id,
          roomCode,
          tokenUserId: userId,
          hostUserId: room.hostUserId,
        });
        socket.emit('error', { code: 'INVALID_MODERATOR_TOKEN' });
        socket.disconnect(true);
        return;
      }
    }

    // P0-21: Targeted emit session:replaced to OLD device sockets (same participation, different socket id)
    const existingSockets = [...socketIdentityMap.entries()]
      .filter(([sid, identity]) =>
        identity.participationId === participation.id &&
        identity.roomId === room.id &&
        sid !== socket.id
      )
      .map(([sid]) => io.sockets.sockets.get(sid))
      .filter(Boolean);

    for (const oldSocket of existingSockets) {
      oldSocket?.emit('session:replaced');
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
  } else {
    // -----------------------------------------------------------
    // VIEWER SUBSCRIPTION PATH
    // -----------------------------------------------------------
    
    // 1. P0-04: Check allowViewers - viewers not allowed in this room
    if (!room.allowViewers) {
      callback?.({ success: false, error: 'VIEWERS_NOT_ALLOWED' });
      return;
    }

    // 2. Cleanup old disconnected ViewerSessions (before checking limit)
    const cleaned = await cleanupOldViewerSessions(room.id);
    if (cleaned > 0) {
      logger.debug('Cleaned up old viewer sessions', { roomCode, count: cleaned });
    }

    // 3. P0-05/P0-21: viewerLimit prüfen (zählt nur verbundene ViewerSessions)
    const activeViewerCount = await prisma.viewerSession.count({
      where: { roomId: room.id, connected: true },
    });
    
    if (activeViewerCount >= room.viewerLimit) {
      callback?.({ success: false, error: 'VIEWER_LIMIT_REACHED' });
      return;
    }

    // 4. P0-05: PIN-Prüfung nur wenn viewerRequiresPin=true UND room.pinHash != null
    if (room.viewerRequiresPin && room.pinHash != null) {
      // Check PIN for viewer access
      if (!pin) {
        callback?.({ success: false, error: 'PIN_REQUIRED' });
        return;
      }

      // P0-21: Verify PIN with argon2 (must match hashing in http/rooms.ts)
      const argon2 = await import('argon2');
      const validPin = await argon2.default.verify(room.pinHash, pin);
      if (!validPin) {
        callback?.({ success: false, error: 'INVALID_PIN' });
        return;
      }
    }

    // P0-SECURITY / E2E-FIX: If the authenticated user is the room host,
    // DON'T create a VIEWER session here — they will be auto-upgraded to
    // MODERATOR below. Creating a real VIEWER Session would leave a stale
    // connected=true entry in the DB that triggers spurious player:join events.
    if (authModerator.user?.id && authModerator.user.id === room.hostUserId) {
      // Set a placeholder identity — auto-upgrade will replace it below
      identity = { participationId: '', roomId: room.id, role: 'VIEWER', displayName: '' };
    } else {
      // Create new ViewerSession
      const viewerSession = await prisma.viewerSession.create({
        data: { roomId: room.id, connected: true, lastSeenAt: new Date() },
      });
      identity = {
        participationId: `viewer:${viewerSession.id}`,
        roomId: room.id,
        role: 'VIEWER',
        displayName: 'Zuschauer',
      };
    }
  }

  // P0-SECURITY / E2E-FIX: Authenticated Host Auto-Upgrade
  // Even without a rejoinToken, an authenticated user whose userId matches the
  // room's hostUserId should be treated as MODERATOR (not VIEWER).
  // This fixes the reload scenario in E2E tests where sessionStorage has no
  // rejoinToken but the HTTP session cookie is valid.
  //
  // Note: identity.role is 'VIEWER' when the host connected initially without
  // a rejoinToken (the VIEWER path above creates a placeholder identity for them).
  // P0-SECURITY / E2E-FIX: Authenticated Host Auto-Upgrade
  // Even without a rejoinToken, an authenticated user whose userId matches the
  // room's hostUserId should be treated as MODERATOR (not VIEWER).
  // This fixes the reload scenario in E2E tests where sessionStorage has no
  // rejoinToken but the HTTP session cookie is valid.
  if (authModerator.user?.id && authModerator.user.id === room.hostUserId) {
    const existingModPart = await prisma.participation.findFirst({
      where: { roomId: room.id, role: 'MODERATOR' },
    });

    if (existingModPart) {
      // The MODERATOR participation was found. It may be stale (connected=false from
      // the previous socket disconnect). Fetch fresh from DB to know its real state.
      const freshModPart = await prisma.participation.findUnique({ where: { id: existingModPart.id } });

      if (freshModPart && !freshModPart.connected) {
        // Old participation disconnected — create a fresh one for this reconnect.
        // This prevents stale state from the previous socket session polluting the
        // lobby snapshot with a duplicate "admin" entry.
        const newModPart = await prisma.participation.create({
          data: {
            roomId: room.id,
            displayName: authModerator.user.displayName ?? 'Host',
            normalizedName: (authModerator.user.displayName ?? 'Host').toLowerCase().trim(),
            role: 'MODERATOR',
            connected: true,
            ready: true,
            rejoinToken: crypto.randomUUID(),
            rejoinTokenVersion: 1,
          },
        });
        identity = {
          participationId: newModPart.id,
          roomId: room.id,
          role: 'MODERATOR' as const,
          displayName: newModPart.displayName,
        };
        // Remove the stale MODERATOR entry and replace with the fresh one
        room.participations = [
          ...room.participations.filter(p => p.id !== existingModPart.id),
          {
            ...newModPart,
            avatarGenerated: newModPart.avatarGenerated ?? null,
            avatarMode: newModPart.avatarMode,
            kickedAt: null,
            rejoinTokenVersion: newModPart.rejoinTokenVersion ?? 1,
          } as any,
        ];
      } else if (existingModPart) {
        // Still connected — reuse the existing participation
        identity = {
          participationId: existingModPart.id,
          roomId: room.id,
          role: 'MODERATOR' as const,
          displayName: existingModPart.displayName,
        };
        await prisma.participation.update({
          where: { id: existingModPart.id },
          data: { connected: true },
        });
        const modPartInRoom = room.participations.find(p => p.id === existingModPart.id);
        if (modPartInRoom) modPartInRoom.connected = true;
      }
    } else {
      // No existing participation — create one now
      const newModPart = await prisma.participation.create({
        data: {
          roomId: room.id,
          displayName: authModerator.user.displayName ?? 'Host',
          normalizedName: (authModerator.user.displayName ?? 'Host').toLowerCase().trim(),
          role: 'MODERATOR',
          connected: true,
          ready: true,
          rejoinToken: crypto.randomUUID(),
          rejoinTokenVersion: 1,
        },
      });
      identity = {
        participationId: newModPart.id,
        roomId: room.id,
        role: 'MODERATOR' as const,
        displayName: newModPart.displayName,
      };
      room.participations.push({
        ...newModPart,
        avatarGenerated: newModPart.avatarGenerated ?? null,
        avatarMode: newModPart.avatarMode,
        kickedAt: null,
        rejoinTokenVersion: newModPart.rejoinTokenVersion ?? 1,
      } as any);
    }
  }

  // Store identity in socket.data (P0-08/P0-09 fix)
  logger.info('[DEBUG] Storing identity', {
    socketId: socket.id,
    role: identity.role,
    participationId: identity.participationId,
    roomCode: room.code,
    players: room.participations.map(p => ({ id: p.id, role: p.role, connected: p.connected })),
  });
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
    // Require MODERATOR role (identity check via socketIdentityMap)
    const identity = socketIdentityMap.get(socket.id);
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

    // Mark as kicked and update timestamp
    await prisma.participation.update({
      where: { id: data.playerId },
      data: { kickedAt: new Date(), connected: false },
    });

    // P0-09/P0-13: Rotate rejoin token (bump version so old token is useless)
    await prisma.participation.update({
      where: { id: data.playerId },
      data: { rejoinTokenVersion: { increment: 1 } },
    });

    // P0-12/P0-21: Targeted emit only to kicked player's sockets
    const targetSockets = [...socketIdentityMap.entries()]
      .filter(([, identity]) => identity.participationId === data.playerId && identity.roomId === room.id)
      .map(([sid]) => io.sockets.sockets.get(sid))
      .filter(Boolean);

    for (const targetSocket of targetSockets) {
      targetSocket?.emit('room:kicked', {
        participationId: data.playerId,
        reason: 'Du wurdest vom Moderator entfernt',
      });
      // P0-21: Force immediate disconnect so token is useless immediately
      targetSocket?.disconnect(true);
    }

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
