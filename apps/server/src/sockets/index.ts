// ============================================================
// Socket.IO Handler Setup
// ============================================================

import { Server, Socket } from 'socket.io';
import { verifySession } from '../auth/session.js';
import { config } from '../config/index.js';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { handleRoomSubscription, handleRoomEvents, handleKickPlayer } from './room.js';
import { handlePlayerEvents } from './player.js';
import { handleLobbyEvents, handleDisconnect } from './lobby.js';
import { handleGameEvents } from './game.js';

// Room channel helper - returns a Socket.IO room identifier for a specific room
export function roomChannel(roomId: string): string {
  // Socket.IO uses room names to emit to specific rooms
  // The roomId is the room UUID (not the public code)
  return `room:${roomId}`;
}

export function setupSocketHandlers(io: Server) {
  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const sessionId = verifySession(socket.request as any, config.sessionSecret);
      if (sessionId) {
        const session = await prisma.session.findUnique({
          where: { id: sessionId },
          include: { user: true },
        });
        if (session && !session.revokedAt && session.expiresAt > new Date()) {
          (socket as any).user = session.user;
        }
      }
      next();
    } catch (error) {
      logger.error('Socket auth error', { error });
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: Socket) => {
    logger.info('Socket connected', { socketId: socket.id });

    // P0-08/P0-09: Initialize socket.data to track identity
    socket.data = {};

    // Room subscription
    socket.on('room:subscribe', async (data, callback) => {
      try {
        await handleRoomSubscription(io, socket, data, callback);
      } catch (error) {
        logger.error('Room subscription error', { error });
        callback?.({ success: false, error: 'SUBSCRIPTION_FAILED' });
      }
    });

    // Room events
    socket.on('room:resync', (data, callback) => {
      handleRoomEvents.resync(io, socket, data, callback);
    });

    // Kick player (moderator only)
    socket.on('room:kick', (data, callback) => {
      handleKickPlayer(io, socket, data, callback);
    });

    // Player events
    socket.on('player:ready:set', (data, callback) => {
      handlePlayerEvents.setReady(io, socket, data, callback);
    });

    socket.on('player:profile:update', (data, callback) => {
      handlePlayerEvents.updateProfile(io, socket, data, callback);
    });

    // Lobby events
    socket.on('lobby:chat:send', (data, callback) => {
      handleLobbyEvents.sendChat(io, socket, data, callback);
    });

    socket.on('lobby:chat:lock', (data, callback) => {
      handleLobbyEvents.lockChat(io, socket, data, callback);
    });

    // Game events
    socket.on('game:start', (data, callback) => {
      handleGameEvents.start(io, socket, data, callback);
    });

    socket.on('game:pause', (data, callback) => {
      handleGameEvents.pause(io, socket, data, callback);
    });

    socket.on('game:resume', (data, callback) => {
      handleGameEvents.resume(io, socket, data, callback);
    });

    socket.on('game:end', (data, callback) => {
      handleGameEvents.end(io, socket, data, callback);
    });

    // Geo game events
    socket.on('geo:answer', (data, callback) => {
      handleGameEvents.geoAnswer(io, socket, data, callback);
    });

    socket.on('geo:joker:5050', (data, callback) => {
      handleGameEvents.geoJoker5050(io, socket, data, callback);
    });

    socket.on('geo:joker:spy', (data, callback) => {
      handleGameEvents.geoJokerSpy(io, socket, data, callback);
    });

    socket.on('geo:joker:risk', (data, callback) => {
      handleGameEvents.geoJokerRisk(io, socket, data, callback);
    });

    socket.on('geo:reveal', (data, callback) => {
      handleGameEvents.geoReveal(io, socket, data, callback);
    });

    socket.on('geo:next', (data, callback) => {
      handleGameEvents.geoNext(io, socket, data, callback);
    });

    // Buzz events
    socket.on('buzz:press', (data, callback) => {
      handleGameEvents.buzzPress(io, socket, data, callback);
    });

    // Disconnect
    socket.on('disconnect', async (reason) => {
      logger.info('Socket disconnected', { socketId: socket.id, reason });
      await handleDisconnect(io, socket);
    });
  });
}

