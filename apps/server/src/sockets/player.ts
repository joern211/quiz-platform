// ============================================================
// Player Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';

export const handlePlayerEvents = {
  async setReady(
    io: Server,
    socket: Socket,
    data: { roomCode: string; ready: boolean; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      if (!data.rejoinToken) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      const participation = await prisma.participation.findUnique({
        where: { rejoinToken: data.rejoinToken },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
        return;
      }

      await prisma.participation.update({
        where: { id: participation.id },
        data: { ready: data.ready },
      });

      // Broadcast
      io.to(data.roomCode).emit('player:ready:set', {
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
      if (!data.rejoinToken) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      const participation = await prisma.participation.findUnique({
        where: { rejoinToken: data.rejoinToken },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
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

      // Broadcast
      io.to(data.roomCode).emit('player:profile:update', {
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
