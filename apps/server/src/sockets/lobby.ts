// ============================================================
// Lobby Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';

export const handleLobbyEvents = {
  async sendChat(
    io: Server,
    socket: Socket,
    data: { roomCode: string; content: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      // Validate content
      const content = (data.content || '').trim().slice(0, 300);
      if (!content) {
        callback?.({ success: false, error: 'EMPTY_MESSAGE' });
        return;
      }

      // Check room chat enabled
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room || !room.lobbyChatEnabled) {
        callback?.({ success: false, error: 'CHAT_DISABLED' });
        return;
      }

      // Get participation for sender name
      let senderId: string | null = null;
      let senderName = 'Unbekannt';
      
      if (data.rejoinToken) {
        const participation = await prisma.participation.findUnique({
          where: { rejoinToken: data.rejoinToken },
        });
        if (participation) {
          senderId = participation.id;
          senderName = participation.displayName;
        }
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

      // Broadcast
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
      // Only moderator can lock chat
      // TODO: Add moderator check

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
