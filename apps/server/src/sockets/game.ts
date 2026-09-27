// ============================================================
// Game Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { getGameHandler } from '../games/registry.js';
import { gameErrorCode } from '../games/core/errors.js';
import { requireRoomRole, getSocketDataIdentity } from './auth.js';
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
    logger.info('game:start received', { socketId: socket.id, roomCode: data.roomCode, socketData: socket.data });

    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
        include: { gameDefinition: true },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // P0-17: Use socket identity for authorization
      const identity = getSocketDataIdentity(socket);
      logger.info('game:start identity check', { identity, socketId: socket.id });
      if (!identity || identity.roomId !== room.id) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      const authorized = requireRoomRole(socket, 'MODERATOR');
      logger.info('game:start auth result', { authorized, socketId: socket.id, role: identity?.role });
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
        return;
      }

      // Verify socket is in this room
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      if (room.status !== 'LOBBY') {
        callback?.({ success: false, error: 'GAME_ALREADY_STARTED' });
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

      // Resolve the lifecycle before mutating room state. Unsupported games
      // must never transiently enter RUNNING.
      const gameHandler = getGameHandler(room.gameDefinition.slug);
      if (!gameHandler) {
        callback?.({ success: false, error: 'GAME_NOT_IMPLEMENTED' });
        return;
      }

      // Update room status atomically from the lobby revision.
      const started = await prisma.room.updateMany({
        where: { id: room.id, status: 'LOBBY', revision: room.revision },
        data: {
          status: 'RUNNING',
          runPhase: 'INTRO',
          startedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (started.count !== 1) {
        callback?.({ success: false, error: 'GAME_ALREADY_STARTED' });
        return;
      }

      try {
        await gameHandler.initialize({ io, room, initialPhase: 'INTRO' });
      } catch (error) {
        // Only undo the transition we own. Do not reset a room that another
        // action has already advanced, and remove partial initialization.
        await prisma.$transaction(async (tx) => {
          const reverted = await tx.room.updateMany({
            where: { id: room.id, status: 'RUNNING', revision: room.revision + 1 },
            data: { status: 'LOBBY', runPhase: 'LOBBY', startedAt: null, revision: { increment: 1 } },
          });
          if (reverted.count === 1) {
            await tx.roomGameState.deleteMany({ where: { roomId: room.id } });
          }
        });
        throw error;
      }

      // Emit game start
      io.to(channel).emit('game:start', {
        roomCode: data.roomCode,
        status: 'RUNNING',
        runPhase: 'INTRO',
        gameSlug: room.gameDefinition.slug,
      });

      // Optional game-specific post-start lifecycle (for example Geo's
      // intro-to-first-round transition).
      await gameHandler.afterStart?.({
        io,
        room,
        initialPhase: 'INTRO',
      });

      callback?.({ success: true, gameSlug: room.gameDefinition.slug });
    } catch (error) {
      logger.error('Game start error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  },

  async pause(
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

      // P0-17: Use socket identity for authorization
      const identity = getSocketDataIdentity(socket);
      if (!identity.roomId || identity.roomId !== room.id) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      const authorized = requireRoomRole(socket, 'MODERATOR');
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
        return;
      }

      // Verify socket is in this room
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      const gameHandler = getGameHandler(room.gameDefinition.slug);
      if (gameHandler?.pause) {
        return gameHandler.pause({ io, socket, roomCode: room.code, callback });
      }

      await prisma.room.update({
        where: { id: room.id },
        data: { runPhase: 'PAUSED', revision: { increment: 1 } },
      });

      io.to(channel).emit('game:pause', { roomCode: data.roomCode });
      callback?.({ success: true });
    } catch (error) {
      logger.error('Game pause error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  },

  async resume(
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

      // P0-17: Use socket identity for authorization
      const identity = getSocketDataIdentity(socket);
      if (!identity.roomId || identity.roomId !== room.id) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      const authorized = requireRoomRole(socket, 'MODERATOR');
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
        return;
      }

      // Verify socket is in this room
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      const gameHandler = getGameHandler(room.gameDefinition.slug);
      if (gameHandler?.resume) {
        return gameHandler.resume({ io, socket, roomCode: room.code, callback });
      }

      await prisma.room.update({
        where: { id: room.id },
        data: { runPhase: 'ROUND_ACTIVE', revision: { increment: 1 } },
      });

      io.to(channel).emit('game:resume', { roomCode: data.roomCode });
      callback?.({ success: true });
    } catch (error) {
      logger.error('Game resume error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  },

  async end(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
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

      // P0-17: Use socket identity for authorization
      const identity = getSocketDataIdentity(socket);
      if (!identity.roomId || identity.roomId !== room.id) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      const authorized = requireRoomRole(socket, 'MODERATOR');
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
        return;
      }

      // Verify socket is in this room
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
      const gameDefinition = await prisma.gameDefinition.findUnique({ where: { id: room.gameDefinitionId } });
      if (gameDefinition) getGameHandler(gameDefinition.slug)?.cleanup?.(room.id);

      io.to(channel).emit('game:end', {
        roomCode: data.roomCode,
        status: 'ENDED',
        runPhase: 'RESULTS',
      });
      callback?.({ success: true });
    } catch (error) {
      logger.error('Game end error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  },
};
