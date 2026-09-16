// ============================================================
// Game Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { handleGeoGame } from '../games/geo/index.js';

export const handleGameEvents = {
  // ============================================================
  // Generic Game Events
  // ============================================================

  async start(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
        include: { gameDefinition: true },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // Check all players ready
      const unreadyPlayers = await prisma.participation.count({
        where: {
          roomId: room.id,
          role: 'PLAYER',
          connected: true,
          ready: false,
        },
      });

      if (unreadyPlayers > 0) {
        callback?.({ success: false, error: 'NOT_ALL_READY' });
        return;
      }

      // Update room status
      await prisma.room.update({
        where: { id: room.id },
        data: {
          status: 'RUNNING',
          runPhase: 'INTRO',
          startedAt: new Date(),
          revision: { increment: 1 },
        },
      });

      // Initialize game state based on game type
      if (room.gameDefinition.slug === 'geo') {
        await handleGeoGame.initialize(io, room, 'INTRO');
      }

      io.to(data.roomCode).emit('game:start', {
        roomCode: data.roomCode,
        status: 'RUNNING',
        runPhase: 'INTRO',
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Game start error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  async pause(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    try {
      await prisma.room.update({
        where: { code: data.roomCode },
        data: { runPhase: 'PAUSED', revision: { increment: 1 } },
      });

      io.to(data.roomCode).emit('game:pause', { roomCode: data.roomCode });
      callback?.({ success: true });
    } catch (error) {
      logger.error('Game pause error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  async resume(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    try {
      await prisma.room.update({
        where: { code: data.roomCode },
        data: { runPhase: 'ROUND_ACTIVE', revision: { increment: 1 } },
      });

      io.to(data.roomCode).emit('game:resume', { roomCode: data.roomCode });
      callback?.({ success: true });
    } catch (error) {
      logger.error('Game resume error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  async end(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    try {
      await prisma.room.update({
        where: { code: data.roomCode },
        data: {
          status: 'ENDED',
          runPhase: 'RESULTS',
          endedAt: new Date(),
          revision: { increment: 1 },
        },
      });

      io.to(data.roomCode).emit('game:end', {
        roomCode: data.roomCode,
        status: 'ENDED',
        runPhase: 'RESULTS',
      });
      callback?.({ success: true });
    } catch (error) {
      logger.error('Game end error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
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

      // Get room game state
      const gameState = await prisma.roomGameState.findUnique({
        where: { roomId: participation.roomId },
      });

      if (!gameState || gameState.phase !== 'BUZZ_OPEN') {
        callback?.({ success: false, error: 'BUZZ_CLOSED' });
        return;
      }

      // Parse state and check if buzz is open
      const state = JSON.parse(gameState.stateJson);
      if (!state.buzzOpen) {
        callback?.({ success: false, error: 'BUZZ_CLOSED' });
        return;
      }

      // Check if already has winner
      if (state.buzzWinnerId) {
        callback?.({ success: false, error: 'BUZZ_CLOSED' });
        return;
      }

      // Update game state - set winner
      state.buzzWinnerId = participation.id;
      state.buzzOpen = false;

      await prisma.roomGameState.update({
        where: { roomId: participation.roomId },
        data: {
          stateJson: JSON.stringify(state),
          phase: 'JUDGING',
          revision: { increment: 1 },
        },
      });

      // Broadcast buzz winner
      io.to(data.roomCode).emit('buzz:won', {
        playerId: participation.id,
        displayName: participation.displayName,
      });

      // Update room
      await prisma.room.update({
        where: { code: data.roomCode },
        data: { runPhase: 'ROUND_LOCKED', revision: { increment: 1 } },
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Buzz press error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  // ============================================================
  // Geo Quiz Events (delegated to geo engine)
  // ============================================================

  async geoAnswer(
    io: Server,
    socket: Socket,
    data: { roomCode: string; optionId: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    return handleGeoGame.handleAnswer(io, socket, data, callback);
  },

  async geoJoker5050(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    return handleGeoGame.handleJoker5050(io, socket, data, callback);
  },

  async geoJokerSpy(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    return handleGeoGame.handleJokerSpy(io, socket, data, callback);
  },

  async geoJokerRisk(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    return handleGeoGame.handleJokerRisk(io, socket, data, callback);
  },

  async geoReveal(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    return handleGeoGame.handleReveal(io, socket, data, callback);
  },

  async geoNext(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    return handleGeoGame.handleNext(io, socket, data, callback);
  },
};
