// ============================================================
// Room Socket Events
// ============================================================

import { assertRoomLive, RoomError, joinViewer } from '../rooms/core.js';
import { changed } from '../rooms/socket.js';
import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { z } from 'zod';
import { wireErrorToAppError } from '../games/core/appError.js';
import { updateRoomConfig, GAME_CONFIG_FIELDS } from '../games/core/config.js';
import { resolveCanonicalSlug } from '@quiz/shared';
import { socketIdentityMap, type Role } from '../http/middleware/auth.js';
import { requireGamePermission } from '../games/core/permissions.js';
import { roomChannel } from './index.js';

type AuthenticatedSocket = Socket & {
  user?: { id: string; displayName?: string };
};

interface RoomIdentity {
  participationId: string;
  roomId: string;
  role: Role;
  displayName: string;
}

type RoomAcknowledgement = (result: {
  success: boolean;
  error?: string;
  snapshot?: unknown;
  state?: unknown;
  details?: unknown;
  changed?: boolean;
  revision?: number;
  code?: string;
  messageKey?: string;
  traceId?: string;
  rejoinToken?: string;
}) => void;

function isRole(role: string): role is Role {
  return role === 'HOST' || role === 'PLAYER' || role === 'VIEWER';
}

export async function handleRoomSubscription(
  io: Server,
  socket: Socket,
  data: { roomCode: string; rejoinToken?: string; pin?: string; moderatorToken?: string; inviteToken?: string },
  callback?: RoomAcknowledgement
) {
  const { roomCode, rejoinToken, pin, moderatorToken } = data;

  // Find room
  const room = await prisma.room.findUnique({
    where: { code: roomCode },
    include: {
      gameDefinition: true,
      participations: { where: { role: { not: 'VIEWER' }, admission: 'ACTIVE', bannedAt: null, leftAt: null, kickedAt: null } },
      viewerSessions: true,
    },
  });

  if (!room) {
    callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
    return;
  }

  try { assertRoomLive(room); } catch (error) { callback?.({ success: false, error: error instanceof RoomError ? error.code : 'ROOM_CLOSED' }); return; }

  // Socket.IO rooms persist across subscribe calls. A socket switching rooms
  // must leave its previous channel before acquiring another identity.
  const previousRoomId = socket.data.roomId as string | undefined;
  const previousParticipationId = socket.data.participationId as string | undefined;
  if (previousRoomId && previousRoomId !== room.id) {
    await socket.leave(roomChannel(previousRoomId));
    socketIdentityMap.delete(socket.id);
    if (previousParticipationId?.startsWith('viewer:')) {
      await prisma.viewerSession.updateMany({
        where: { id: previousParticipationId.slice('viewer:'.length), roomId: previousRoomId },
        data: { connected: false, disconnectedAt: new Date(), lastSeenAt: new Date() },
      });
    } else if (previousParticipationId && ![...socketIdentityMap.values()].some((candidate) =>
      candidate.roomId === previousRoomId && candidate.participationId === previousParticipationId
    )) {
      await prisma.participation.updateMany({
        where: { id: previousParticipationId, roomId: previousRoomId, connectionId: socket.id },
        data: { connected: false, connectionId: null, lastSeenAt: new Date() },
      });
    }
  }

  // P0-04: Extract authenticated userId from HTTP session (set by socket middleware)
  const authenticatedUser = (socket as AuthenticatedSocket).user;
  const userId = authenticatedUser?.id;
  const isAuthenticatedHost = Boolean(userId && userId === room.hostUserId);

  // Initialize default socket data
  socket.data = {
    participationId: undefined,
    roomId: undefined,
    role: undefined,
    displayName: undefined,
    userId: userId ?? undefined,
  };

  // Auth shortcut used in both VIEWER and auto-upgrade paths
  let identity: RoomIdentity | null = null;

  // Handle rejoin token - validate against THIS room
  if (rejoinToken) {
    const participation = await prisma.participation.findUnique({
      where: { rejoinToken },
      include: { room: true },
    });

    // P0-13: Check if kicked
    if (participation?.bannedAt || participation?.leftAt || participation?.kickedAt) {
      callback?.({ success: false, error: 'KICKED' });
      return;
    }

    // Validate rejoin token belongs to THIS room (P0-07 fix)
    if (!participation || participation.roomId !== room.id) {
      callback?.({ success: false, error: 'INVALID_REJOIN_TOKEN' });
      return;
    }

    // Phase 3: Moderator Identity Validation
    // If participation is HOST in DB, require moderatorToken to match
    // Token + Participation (HOST role) + Host-User + Room must all align
    if (!isRole(participation.role)) {
      callback?.({ success: false, error: 'INVALID_PARTICIPATION_ROLE' });
      return;
    }

    if (participation.userId && participation.userId !== userId) { callback?.({ success: false, error: 'SESSION_REQUIRED' }); return; }

    if (participation.role === 'HOST') {
      // A moderator MUST provide a valid moderatorToken that matches their participation
      // moderatorToken is the same as rejoinToken for the moderator's own participation
      if (!isAuthenticatedHost || !moderatorToken || moderatorToken !== participation.rejoinToken) {
        logger.warn('Invalid moderator token', {
          socketId: socket.id,
          roomCode,
          participationId: participation.id,
          isAuthenticatedHost,
          hasModeratorToken: !!moderatorToken,
          tokenMatches: moderatorToken === participation.rejoinToken,
        });
        // P0 Security: Immediately disconnect - do NOT silently create anonymous viewer
        socket.emit('error', { code: 'INVALID_HOST_TOKEN' });
        socket.disconnect(true);
        return;
      }

    } else if (isAuthenticatedHost && participation.userId !== userId) {
      // A host session must never turn an unrelated player participation into
      // a moderator identity. The host reconnects through its own entry below.
      callback?.({ success: false, error: 'INVALID_REJOIN_TOKEN' });
      return;
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
      data: { connected: true, connectionId: socket.id, lastSeenAt: new Date() },
    });

    identity = {
      participationId: participation.id,
      roomId: room.id,
      role: participation.role,
      displayName: participation.displayName,
    };

  } else {
    // -----------------------------------------------------------
    // VIEWER SUBSCRIPTION PATH
    // -----------------------------------------------------------
    
    if (isAuthenticatedHost) {
      // Administration never changes an existing PLAYER/VIEWER information role.
      const existing = await prisma.participation.findFirst({ where: { roomId: room.id, userId, admission: 'ACTIVE', bannedAt: null, kickedAt: null, leftAt: null } });
      if (existing && isRole(existing.role)) {
        await prisma.participation.update({ where: { id: existing.id }, data: { connected: true, connectionId: socket.id, lastSeenAt: new Date() } });
        identity = { participationId: existing.id, roomId: room.id, role: existing.role, displayName: existing.displayName };
      } else identity = { participationId: '', roomId: room.id, role: 'VIEWER', displayName: '' };
    }
    else {
      try { identity = await joinViewer(room.id, socket.id, { pin, inviteToken: data.inviteToken, userId, displayName: authenticatedUser?.displayName }); }
      catch (error) { callback?.({ success: false, error: error instanceof RoomError ? error.code : 'NOT_AUTHORIZED' }); return; }
    }
  }

  // An authenticated room host always reconnects through the original
  // moderator participation. A reload updates connection metadata instead of
  // creating another database row.
  if (isAuthenticatedHost && (!identity?.participationId || identity.role === 'HOST')) {
    const existingModPart = await prisma.participation.findFirst({
      where: { roomId: room.id, role: 'HOST' },
      orderBy: { createdAt: 'asc' },
    });

    if (existingModPart) {
      const refreshedModerator = await prisma.participation.update({
        where: { id: existingModPart.id },
        data: { connected: true, connectionId: socket.id, ready: true, lastSeenAt: new Date(), userId },
      });
      identity = {
        participationId: refreshedModerator.id,
        roomId: room.id,
        role: 'HOST',
        displayName: refreshedModerator.displayName,
      };
      const index = room.participations.findIndex(p => p.id === refreshedModerator.id);
      if (index >= 0) room.participations[index] = refreshedModerator;
      else room.participations.push(refreshedModerator);
    } else {
      // Defensive recovery for legacy rooms that have no host participation.
      const displayName = authenticatedUser?.displayName ?? 'Host';
      const newModPart = await prisma.participation.create({
        data: {
          roomId: room.id,
          displayName,
          normalizedName: displayName.toLowerCase().trim(),
          role: 'HOST',
          userId,
          connected: true,
          connectionId: socket.id,
          ready: true,
          rejoinToken: crypto.randomUUID(),
          rejoinTokenVersion: 1,
        },
      });
      identity = {
        participationId: newModPart.id,
        roomId: room.id,
        role: 'HOST',
        displayName: newModPart.displayName,
      };
      room.participations.push(newModPart);
    }
  }

  if (!identity) {
    callback?.({ success: false, error: 'IDENTITY_NOT_ESTABLISHED' });
    return;
  }

  // A rejoin replaces the previous socket for the same player or moderator.
  // The old socket must lose both its channel and its action identity.
  if (identity.role !== 'VIEWER') {
    for (const [oldId, previous] of socketIdentityMap.entries()) {
      if (oldId === socket.id || previous.roomId !== room.id ||
          previous.participationId !== identity.participationId) continue;
      const oldSocket = io.sockets.sockets.get(oldId);
      if (oldSocket) {
        oldSocket.emit('session:replaced');
        await oldSocket.leave(roomChannel(room.id));
        oldSocket.data = {};
      }
      socketIdentityMap.delete(oldId);
    }
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
    userId,
    participationId: identity.participationId,
    role: identity.role,
    roomId: identity.roomId,
  });

  // A socket may belong to one quiz room at a time. Leaving the old channel
  // prevents a valid re-subscription from continuing to receive another room's events.
  for (const joinedRoom of socket.rooms) {
    if (joinedRoom.startsWith('room_') && joinedRoom !== roomChannel(room.id)) {
      await socket.leave(joinedRoom);
    }
  }
  // ONLY AFTER identity validated: socket.join(roomChannel(room.id)) (P0-07 fix)
  await socket.join(roomChannel(room.id));

  changed(io, room.id);

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
    gameSlug: room.gameDefinition.slug,
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

  callback?.({ success: true, snapshot, ...('rejoinToken' in identity ? { rejoinToken: String(identity.rejoinToken) } : {}) });

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
  callback?: RoomAcknowledgement
) {
  try {
    // Audit PR14, 14-06: Kicken ist eine Verwaltungs-Mutation und läuft über
    // den GEMEINSAMEN Permission-Guard mit dem wirksamen Recht PLAYER_MANAGE
    // (Defaultpaket ± Grants/Revocations, aktuelle DB-Werte). Die frühere
    // reine ROLE-Prüfung (identity.role === 'HOST') umging einen Entzug von
    // PLAYER_MANAGE bei verbundenen Sockets — das ist geschlossen.
    const perm = await requireGamePermission(socket, 'PLAYER_MANAGE');
    if (!perm.ok) {
      // Wire-Kompatibilität: bestehende Clients erhielten UNAUTHORIZED.
      callback?.({ success: false, error: perm.error === 'NOT_IN_ROOM' ? 'UNAUTHORIZED' : 'UNAUTHORIZED' });
      return;
    }

    const identity = socketIdentityMap.get(socket.id);

    const room = await prisma.room.findUnique({
      where: { code: data.roomCode },
    });

    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    // Verify moderator belongs to this room (serverseitiger Raumbezug).
    if (perm.roomId !== room.id || (identity && identity.roomId !== room.id)) {
      callback?.({ success: false, error: 'WRONG_ROOM' });
      return;
    }

    // Find the participation to kick
    const participation = await prisma.participation.findFirst({
      where: { id: data.playerId, roomId: room.id, role: { not: 'HOST' } },
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
      include: { participations: { where: { role: { not: 'VIEWER' }, admission: 'ACTIVE', bannedAt: null, leftAt: null, kickedAt: null } } },
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
  // BASIS-STANDARDS (E): serverseitig validierte Live-Konfigurationsänderung
  // (LIVE_OVERRIDE) mit Optimistic Locking. Nur eingeloggte Raum-Hosts.
  // LOCKED_AFTER_START-Felder werden im RUNNING-Zustand abgelehnen; No-ops
  // erhöhen die Revision nicht (E5).
  async configUpdate(
    io: Server,
    socket: Socket,
    data: { roomCode?: string; expectedRevision?: number; changes?: Record<string, unknown> },
    callback?: RoomAcknowledgement
  ) {
    const identity = socket.data as { roomId?: string; role?: string };
    if (!identity.roomId || !identity.role || !socket.rooms.has(roomChannel(identity.roomId))) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }
    const parsed = z.object({
      roomCode: z.string().min(1),
      expectedRevision: z.number().int().nonnegative(),
      changes: z.record(z.unknown()).refine((c) => Object.keys(c).length > 0, { message: 'EMPTY_CHANGES' }),
    }).safeParse(data);
    if (!parsed.success) {
      callback?.({ success: false, error: 'INVALID_PAYLOAD' });
      return;
    }
    const room = await prisma.room.findUnique({
      where: { id: identity.roomId },
      include: { gameDefinition: true },
    });
    if (!room || room.code !== parsed.data.roomCode) {
      callback?.({ success: false, error: 'WRONG_ROOM' });
      return;
    }
    // Konfigurationsänderung: nur eingeloggte Nutzer (hostUserId-Check in
    // updateRoomConfig). Keine SECRET-Rechte erforderlich (E3/E5).
    const user = (socket as AuthenticatedSocket).user;
    if (!user) {
      callback?.({ success: false, error: 'ROLE_REQUIRED' });
      return;
    }
    const unknownFields = Object.keys(parsed.data.changes).filter((k) => !Object.hasOwn(GAME_CONFIG_FIELDS[resolveCanonicalSlug(room.gameDefinition.slug) ?? ''] ?? {}, k));
    if (unknownFields.length > 0) {
      callback?.({ success: false, error: 'INVALID_CONFIG', details: { fields: unknownFields } });
      return;
    }
    const result = await updateRoomConfig({
      roomId: room.id,
      actorUserId: user.id,
      expectedRevision: parsed.data.expectedRevision,
      changes: parsed.data.changes,
    });
    if (!result.ok) {
      callback?.({ success: false, error: result.error, ...wireErrorToAppError(result.error) });
      return;
    }
    if (result.changed) {
      io.to(roomChannel(room.id)).emit('room:config:changed', {
        roomId: room.id,
        revision: result.revision,
        values: result.values,
      });
    }
    callback?.({ success: true, changed: result.changed, revision: result.revision });
  },

  async resync(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: RoomAcknowledgement
  ) {
    const identity = socket.data as { roomId?: string; role?: string; participationId?: string };
    if (!identity.roomId || !identity.role || !socket.rooms.has(roomChannel(identity.roomId))) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }
    if (!data || typeof data.roomCode !== 'string') {
      callback?.({ success: false, error: 'INVALID_PAYLOAD' });
      return;
    }
    const room = await prisma.room.findUnique({
      where: { id: identity.roomId },
      include: {
        gameDefinition: true,
        participations: { where: { role: { not: 'VIEWER' }, admission: 'ACTIVE', bannedAt: null, leftAt: null, kickedAt: null } },
        viewerSessions: true,
      },
    });

    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }
    if (room.code !== data.roomCode) {
      callback?.({ success: false, error: 'WRONG_ROOM' });
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
