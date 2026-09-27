// ============================================================
// Player Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { authorizeGameAction } from '../games/core/access.js';
import { roomChannel } from './channel.js';

async function currentPlayer(socket: Socket) {
  const auth = authorizeGameAction(socket, { roles: ['PLAYER'], requireParticipation: true });
  if (!auth.ok) return { ok: false as const, error: auth.error };
  const player = await prisma.participation.findFirst({
    where: {
      id: auth.actor.participationId,
      roomId: auth.actor.roomId,
      role: 'PLAYER',
      connected: true,
      kickedAt: null,
    },
  });
  if (!player) return { ok: false as const, error: 'NO_PARTICIPATION' };
  return { ok: true as const, player };
}

export const handlePlayerEvents = {
  async setReady(
    io: Server,
    socket: Socket,
    data: { roomCode: string; ready: boolean; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      const auth = await currentPlayer(socket);
      if (!auth.ok) { callback?.({ success: false, error: auth.error }); return; }
      const { player } = auth;
      if (typeof data?.ready !== 'boolean') {
        callback?.({ success: false, error: 'INVALID_PAYLOAD' }); return;
      }

      await prisma.participation.update({
        where: { id: player.id },
        data: { ready: data.ready },
      });

      // Broadcast to room using roomChannel
      io.to(roomChannel(player.roomId)).emit('player:ready:set', {
        playerId: player.id,
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
      const auth = await currentPlayer(socket);
      if (!auth.ok) { callback?.({ success: false, error: auth.error }); return; }
      const { player } = auth;
      if (!data || typeof data !== 'object') {
        callback?.({ success: false, error: 'INVALID_PAYLOAD' }); return;
      }

      await prisma.participation.update({
        where: { id: player.id },
        data: {
          avatarMode: data.avatarMode,
          avatarAssetId: data.avatarAssetId,
          avatarGenerated: data.avatarGenerated ? JSON.stringify(data.avatarGenerated) : undefined,
        },
      });

      // Broadcast to room using roomChannel
      io.to(roomChannel(player.roomId)).emit('player:profile:update', {
        playerId: player.id,
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
