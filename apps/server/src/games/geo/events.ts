// Geo-specific socket action adapters. Generic room lifecycle lives in sockets/game.ts.
import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { handleGeoGame } from './index.js';
import { saveGameStateIfRevision } from '../core/state.js';
import { gameErrorCode } from '../core/errors.js';
import { requireRoomRole, getSocketDataIdentity } from '../../sockets/auth.js';
import { roomChannel } from '../../sockets/channel.js';

export const handleGeoEvents = {
  // ============================================================
  // Geo Quiz Events (delegated to geo engine with auth)
  // ============================================================

  async geoAnswer(
    io: Server,
    socket: Socket,
    data: { questionIndex?: number; optionId: string },
    callback?: (result: any) => void
  ) {
    // VIEWER role check: only PLAYER and MODERATOR can answer
    const identity = getSocketDataIdentity(socket);
    if (!identity || !identity.roomId) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }
    if (identity.role === 'VIEWER') {
      callback?.({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
      return;
    }

    const room = await prisma.room.findUnique({
      where: { id: identity.roomId },
    });

    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    // P0-10: Use socket.data.participationId instead of rejoinToken
    const dataWithRoom = {
      ...data,
      roomCode: room.code,
      participationId: socket.data.participationId,
    };

    return handleGeoGame.handleAnswer(io, socket, dataWithRoom, callback);
  },

  async geoJoker5050(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    // VIEWER role check: only PLAYER and MODERATOR can use jokers
    const identity = getSocketDataIdentity(socket);
    if (!identity || !identity.roomId) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }
    if (identity.role === 'VIEWER') {
      callback?.({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
      return;
    }
    return handleGeoGame.handleJoker5050(io, socket, data, callback);
  },

  async geoJokerSpy(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    // VIEWER role check: only PLAYER and MODERATOR can use jokers
    const identity = getSocketDataIdentity(socket);
    if (!identity || !identity.roomId) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }
    if (identity.role === 'VIEWER') {
      callback?.({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
      return;
    }
    return handleGeoGame.handleJokerSpy(io, socket, data, callback);
  },

  async geoJokerRisk(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    // VIEWER role check: only PLAYER and MODERATOR can use jokers
    const identity = getSocketDataIdentity(socket);
    if (!identity || !identity.roomId) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }
    if (identity.role === 'VIEWER') {
      callback?.({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
      return;
    }
    return handleGeoGame.handleJokerRisk(io, socket, data, callback);
  },

  async geoReveal(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    // P0-17: Use socket identity for authorization
    const identity = getSocketDataIdentity(socket);
    if (!identity || !identity.roomId) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }

    const room = await prisma.room.findUnique({
      where: { id: identity.roomId },
    });

    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    const authorized = requireRoomRole(socket, 'MODERATOR');
    if (!authorized) {
      callback?.({ success: false, error: 'UNAUTHORIZED' });
      return;
    }

    return handleGeoGame.handleReveal(io, socket, { roomCode: room.code }, callback);
  },

  async geoNext(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    // P0-17: Use socket identity for authorization
    const identity = getSocketDataIdentity(socket);
    if (!identity || !identity.roomId) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }

    const room = await prisma.room.findUnique({
      where: { id: identity.roomId },
    });

    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    const authorized = requireRoomRole(socket, 'MODERATOR');
    if (!authorized) {
      callback?.({ success: false, error: 'UNAUTHORIZED' });
      return;
    }

    return handleGeoGame.handleNext(io, socket, { roomCode: room.code }, callback);
  },

  // ============================================================
  // Buzz Events
  // ============================================================

  async buzzPress(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      // VIEWER role check: only PLAYER and MODERATOR can buzz
      const identity = getSocketDataIdentity(socket);
      if (!identity || !identity.roomId) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }
      if (identity.role !== 'PLAYER') {
        callback?.({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
        return;
      }

      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      const channel = roomChannel(room.id);
      if (identity.roomId !== room.id || !socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      // Reuse identity from above (already validated as non-VIEWER)
      const participationId = identity.participationId;
      
      if (!participationId) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      const participation = await prisma.participation.findFirst({
        where: { id: participationId, roomId: room.id, role: 'PLAYER' },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
        return;
      }

      // Verify player belongs to THIS room (P0-07 fix)
      if (participation.roomId !== room.id) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      // The claim and revision update share one transaction. A concurrent
      // claim cannot overwrite the winner and will fail the revision check.
      const claimed = await prisma.$transaction(async (tx) => {
        const gameState = await tx.roomGameState.findUnique({ where: { roomId: room.id } });
        if (!gameState || gameState.phase !== 'BUZZ_OPEN') return false;
        const state = JSON.parse(gameState.stateJson);
        if (!state.buzzOpen || state.buzzWinnerId) return false;
        state.buzzWinnerId = participation.id;
        state.buzzOpen = false;
        await saveGameStateIfRevision(tx, {
          roomId: room.id, expectedRevision: gameState.revision, state, phase: 'JUDGING',
        });
        return true;
      });
      if (!claimed) { callback?.({ success: false, error: 'BUZZ_CLOSED' }); return; }

      // Broadcast buzz winner
      io.to(channel).emit('buzz:won', {
        playerId: participation.id,
        displayName: participation.displayName,
      });

      // Update room
      await prisma.room.update({
        where: { id: room.id },
        data: { runPhase: 'ROUND_LOCKED', revision: { increment: 1 } },
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Buzz press error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  },
};
