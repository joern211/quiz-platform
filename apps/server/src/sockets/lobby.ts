// ============================================================
// Lobby Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { getSocketDataIdentity, socketIdentityMap } from './auth.js';
import { roomChannel } from './index.js';

export const handleLobbyEvents = {
  async sendChat(
    io: Server,
    socket: Socket,
    data: { roomCode: string; content: string },
    callback?: (result: any) => void
  ) {
    try {
      const identity = getSocketDataIdentity(socket);
      if (!identity) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      // P0-09: Check socket is connected to a room
      if (!identity.roomId) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      // Validate content
      const content = (data.content || '').trim().slice(0, 300);
      if (!content) {
        callback?.({ success: false, error: 'EMPTY_MESSAGE' });
        return;
      }

      // Check room chat enabled and verify room match
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room || room.id !== identity.roomId) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      if (!room.lobbyChatEnabled) {
        callback?.({ success: false, error: 'CHAT_DISABLED' });
        return;
      }

      const senderId = identity.participationId || null;
      let senderName = 'Unbekannt';
      if (identity.participationId && !identity.participationId.startsWith('viewer:')) {
        const participation = await prisma.participation.findUnique({
          where: { id: identity.participationId },
        });
        if (participation) senderName = participation.displayName;
      }

      // Save message
      const message = await prisma.chatMessage.create({
        data: {
          roomId: room.id,
          senderId,
          senderName,
          content,
        },
      });

      // Broadcast to THIS room only
      io.to(data.roomCode).emit('lobby:chat:message', {
        id: message.id,
        senderId: message.senderId,
        senderName: message.senderName,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Send chat error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  async lockChat(
    io: Server,
    socket: Socket,
    data: { roomCode: string; locked: boolean },
    callback?: (result: any) => void
  ) {
    try {
      const identity = getSocketDataIdentity(socket);
      if (!identity) {
        callback?.({ success: false, error: 'NOT_AUTHENTICATED' });
        return;
      }

      // P0-05: Only moderator can lock chat
      if (!identity.role || identity.role !== 'MODERATOR') {
        callback?.({ success: false, error: 'INSUFFICIENT_ROLE' });
        return;
      }

      // P0-09: Check socket is connected to a room
      if (!identity.roomId) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room || room.id !== identity.roomId) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      await prisma.room.update({
        where: { code: data.roomCode },
        data: { runPhase: data.locked ? 'LOCKED' : 'OPEN' },
      });

      io.to(data.roomCode).emit('lobby:chat:lock', {
        locked: data.locked,
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Lock chat error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },
};

// ============================================================
// Disconnect Handler
// ============================================================

export async function handleDisconnect(io: Server, socket: Socket) {
  try {
    const identity = getSocketDataIdentity(socket);

    if (!identity || !identity.participationId || !identity.roomId) {
      // No participation data, nothing to do
      return;
    }

    const roomId = identity.roomId;
    const channel = roomChannel(roomId);

    // Update participation or viewer session based on type
    if (identity.participationId.startsWith('viewer:')) {
      // Viewer session
      const viewerSessionId = identity.participationId.replace('viewer:', '');
      await prisma.viewerSession.updateMany({
        where: { id: viewerSessionId },
        data: { connected: false, lastSeenAt: new Date() },
      });
    } else {
      // Regular participation - set connected=false
      await prisma.participation.update({
        where: { id: identity.participationId },
        data: { connected: false, lastSeenAt: new Date() },
      });
    }

    // Get updated room state for broadcast
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        participations: { where: { role: { not: 'VIEWER' } } },
        viewerSessions: true,
      },
    });

    if (room) {
      // Broadcast player leave (only for actual players)
      if (identity.role !== 'VIEWER') {
        io.to(channel).emit('player:leave', {
          playerId: identity.participationId,
        });
      }

      // Broadcast updated room state
      io.to(channel).emit('room:updated', {
        roomCode: room.code,
        revision: room.revision + 1,
        players: room.participations.map(p => ({
          id: p.id,
          displayName: p.displayName,
          role: p.role,
          connected: p.connected,
          ready: p.ready,
          score: p.score,
        })),
        viewerCount: room.viewerSessions.filter(vs => vs.connected).length,
      });
    }

    // Clear socket data
    socket.data = {};

    logger.info('Socket disconnected and cleaned up', {
      socketId: socket.id,
      roomId,
      participationId: identity.participationId,
      role: identity.role,
    });
  } catch (error) {
    logger.error('Disconnect handler error', { error });
  }
}
