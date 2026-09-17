// ============================================================
// Game Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { handleGeoGame } from '../games/geo/index.js';
import { requireRoomRole } from './auth.js';
import { roomChannel } from './index.js';

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
    // P0-05: Require MODERATOR role
    if (!requireRoomRole(socket, 'MODERATOR', callback)) {
      return;
    }

    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
        include: { gameDefinition: true },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // Verify socket is in this room (P0-07 fix)
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      // P0-18: Check minPlayers from GameDefinition
      const minPlayers = room.gameDefinition.minPlayers || 2;
      const playerCount = await prisma.participation.count({
        where: {
          roomId: room.id,
          role: 'PLAYER',
          connected: true,
        },
      });

      if (playerCount < minPlayers) {
        callback?.({
          success: false,
          error: 'NOT_ENOUGH_PLAYERS',
          required: minPlayers,
          current: playerCount,
        });
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

      // Emit game start
      io.to(channel).emit('game:start', {
        roomCode: data.roomCode,
        status: 'RUNNING',
        runPhase: 'INTRO',
      });

      // P0-16: Start first round after INTRO phase (with timer)
      if (room.gameDefinition.slug === 'geo') {
        // Small delay then start the round
        setTimeout(async () => {
          await handleGeoGame.startRound(io, data.roomCode);
        }, 3000); // 3 second intro delay
      }

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
    // P0-05: Require MODERATOR role
    if (!requireRoomRole(socket, 'MODERATOR', callback)) {
      return;
    }

    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // Verify socket is in this room (P0-07 fix)
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      await prisma.room.update({
        where: { id: room.id },
        data: { runPhase: 'PAUSED', revision: { increment: 1 } },
      });

      io.to(channel).emit('game:pause', { roomCode: data.roomCode });
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
    // P0-05: Require MODERATOR role
    if (!requireRoomRole(socket, 'MODERATOR', callback)) {
      return;
    }

    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // Verify socket is in this room (P0-07 fix)
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      await prisma.room.update({
        where: { id: room.id },
        data: { runPhase: 'ROUND_ACTIVE', revision: { increment: 1 } },
      });

      io.to(channel).emit('game:resume', { roomCode: data.roomCode });
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
    // P0-05: Require MODERATOR role
    if (!requireRoomRole(socket, 'MODERATOR', callback)) {
      return;
    }

    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // Verify socket is in this room (P0-07 fix)
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      await prisma.room.update({
        where: { id: room.id },
        data: {
          status: 'ENDED',
          runPhase: 'RESULTS',
          endedAt: new Date(),
          revision: { increment: 1 },
        },
      });

      io.to(channel).emit('game:end', {
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
  // Geo Quiz Events (delegated to geo engine with auth)
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
    // P0-05: Require MODERATOR role
    if (!requireRoomRole(socket, 'MODERATOR', callback)) {
      return;
    }

    return handleGeoGame.handleReveal(io, socket, data, callback);
  },

  async geoNext(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    // P0-05: Require MODERATOR role
    if (!requireRoomRole(socket, 'MODERATOR', callback)) {
      return;
    }

    return handleGeoGame.handleNext(io, socket, data, callback);
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
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      if (!data.rejoinToken && !identity.participationId) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      const participation = await prisma.participation.findUnique({
        where: { rejoinToken: data.rejoinToken || identity.participationId },
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

      // Get room game state
      const gameState = await prisma.roomGameState.findUnique({
        where: { roomId: room.id },
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
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(state),
          phase: 'JUDGING',
          revision: { increment: 1 },
        },
      });

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
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },
};
