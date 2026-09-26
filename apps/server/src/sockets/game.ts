// ============================================================
// Game Socket Events
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { handleGeoGame } from '../games/geo/index.js';
import { handleJeopardyGame } from '../games/jeopardy/engine.js';
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

      // Update room status
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

      // Initialize game state based on game type
      if (room.gameDefinition.slug === 'geo') {
        await handleGeoGame.initialize(io, room, 'INTRO');
      } else if (room.gameDefinition.slug === 'jeopardy') {
        await handleJeopardyGame.initialize(io, room);
      }

      // Emit game start
      io.to(channel).emit('game:start', {
        roomCode: data.roomCode,
        status: 'RUNNING',
        runPhase: 'INTRO',
        gameSlug: room.gameDefinition.slug,
      });

      // P0-16: Start first round after INTRO phase (with timer)
      if (room.gameDefinition.slug === 'geo') {
        // Small delay then start the round
        setTimeout(async () => {
          await handleGeoGame.startRound(io, data.roomCode);
        }, 3000); // 3 second intro delay
      }

      callback?.({ success: true, gameSlug: room.gameDefinition.slug });
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
      if (!identity || !identity.roomId) {
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

      // P0-20: Delegate to geo engine for proper pause handling
      if (room.gameDefinition?.slug === 'geo') {
        return handleGeoGame.handlePause(io, socket, data, callback);
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
      if (!identity || !identity.roomId) {
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

      // P0-20: Delegate to geo engine for proper resume handling
      if (room.gameDefinition?.slug === 'geo') {
        return handleGeoGame.handleResume(io, socket, data, callback);
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
      if (!identity || !identity.roomId) {
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
      if (identity.role === 'VIEWER') {
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
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      // Reuse identity from above (already validated as non-VIEWER)
      const participationId = identity?.participationId || data.rejoinToken;
      
      if (!participationId) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

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

  // ============================================================
  // Jeopardy Events
  // ============================================================

  async jeopardyFieldOpen(
    io: Server,
    socket: Socket,
    data: { boardIndex: 1 | 2; categoryIndex: number; value: number },
    callback?: (result: any) => void
  ) {
    const result = await handleJeopardyGame.handleFieldOpen(io, socket, data);
    callback?.(result);
  },

  async jeopardyBuzz(
    io: Server,
    socket: Socket,
    data: Record<string, never>,
    callback?: (result: any) => void
  ) {
    const result = await handleJeopardyGame.handleBuzz(io, socket, data);
    callback?.(result);
  },

  async jeopardyJudge(
    io: Server,
    socket: Socket,
    data: { correct: boolean },
    callback?: (result: any) => void
  ) {
    const result = await handleJeopardyGame.handleJudge(io, socket, data);
    callback?.(result);
  },

  async jeopardyStealBuzz(
    io: Server,
    socket: Socket,
    data: Record<string, never>,
    callback?: (result: any) => void
  ) {
    const result = await handleJeopardyGame.handleStealBuzz(io, socket, data);
    callback?.(result);
  },

  async jeopardyStealJudge(
    io: Server,
    socket: Socket,
    data: { correct: boolean },
    callback?: (result: any) => void
  ) {
    const result = await handleJeopardyGame.handleStealJudge(io, socket, data);
    callback?.(result);
  },

  async jeopardyNext(
    io: Server,
    socket: Socket,
    data: Record<string, never>,
    callback?: (result: any) => void
  ) {
    const result = await handleJeopardyGame.handleNext(io, socket, data);
    callback?.(result);
  },

  async jeopardySwitchBoard(
    io: Server,
    socket: Socket,
    data: { toBoard: 2 | 1 },
    callback?: (result: any) => void
  ) {
    const identity = getSocketDataIdentity(socket);
    if (!identity?.roomId) {
      callback?.({ success: false, error: 'NOT_IN_ROOM' });
      return;
    }
    if (identity.role !== 'MODERATOR') {
      callback?.({ success: false, error: 'UNAUTHORIZED' });
      return;
    }

    const room = await prisma.room.findUnique({
      where: { id: identity.roomId },
    });
    if (!room) {
      callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    const result = await handleJeopardyGame.handleBoardSwitch(io, room);
    callback?.(result);
  },
};
