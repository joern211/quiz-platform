// ============================================================
// Player Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { getSocketDataIdentity } from './auth.js';
import { roomChannel } from './index.js';

export const handlePlayerEvents = {
  async setReady(
    io: Server,
    socket: Socket,
    data: { roomCode: string; ready: boolean; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      // Try socket identity first, then fall back to rejoinToken
      const identity = getSocketDataIdentity(socket);
      const participationId = identity?.participationId || data.rejoinToken;

      if (!participationId) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      // Look up participation by id or rejoinToken
      const participation = await prisma.participation.findFirst({
        where: {
          OR: [
            { id: participationId },
            { rejoinToken: participationId },
          ],
        },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
        return;
      }

      // P0-08: Cross-Room-Schutz — Participation muss zum mitgesendeten roomCode gehören
      const room = await prisma.room.findUnique({ where: { id: participation.roomId } });
      if (!room || room.code !== data.roomCode) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      // P0-08: kicked players may not mutate state
      if ((participation as any).kickedAt) {
        callback?.({ success: false, error: 'KICKED' });
        return;
      }

      await prisma.participation.update({
        where: { id: participation.id },
        data: { ready: data.ready },
      });

      // Broadcast to room using roomChannel
      const roomId = identity?.roomId || participation.roomId;
      io.to(roomChannel(roomId)).emit('player:ready:set', {
        playerId: participation.id,
        ready: data.ready,
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Set ready error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  async updateProfile(
    io: Server,
    socket: Socket,
    data: { roomCode: string; avatarMode?: string; avatarAssetId?: string; avatarGenerated?: any; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      // Try socket identity first, then fall back to rejoinToken
      const identity = getSocketDataIdentity(socket);
      const participationId = identity?.participationId || data.rejoinToken;

      if (!participationId) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      // Look up participation by id or rejoinToken
      const participation = await prisma.participation.findFirst({
        where: {
          OR: [
            { id: participationId },
            { rejoinToken: participationId },
          ],
        },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
        return;
      }

      // P0-08: Cross-Room-Schutz — Participation muss zum mitgesendeten roomCode gehören
      const room = await prisma.room.findUnique({ where: { id: participation.roomId } });
      if (!room || room.code !== data.roomCode) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      // P0-08: kicked players may not mutate state
      if ((participation as any).kickedAt) {
        callback?.({ success: false, error: 'KICKED' });
        return;
      }

      await prisma.participation.update({
        where: { id: participation.id },
        data: {
          avatarMode: data.avatarMode,
          avatarAssetId: data.avatarAssetId,
          avatarGenerated: data.avatarGenerated ? JSON.stringify(data.avatarGenerated) : undefined,
        },
      });

      // Broadcast to room using roomChannel
      const roomId = identity?.roomId || participation.roomId;
      io.to(roomChannel(roomId)).emit('player:profile:update', {
        playerId: participation.id,
        avatarMode: data.avatarMode,
        avatarGenerated: data.avatarGenerated,
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Update profile error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },
};
