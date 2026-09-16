// ============================================================
// Socket.IO Handler Setup
// ============================================================

import { Server, Socket } from 'socket.io';
import { verifySession } from '../auth/session.js';
import { config } from '../config/index.js';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { handleRoomSubscription, handleRoomEvents } from './room';
import { handlePlayerEvents } from './player';
import { handleLobbyEvents } from './lobby';
import { handleGameEvents } from './game';

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

async function handleDisconnect(io: Server, socket: Socket) {
  try {
    const rooms = socket.rooms;
    for (const roomId of rooms) {
      if (roomId === socket.id) continue;
      
      // Update participation connected status
      const participation = await prisma.participation.findFirst({
        where: { roomId, connected: true, lastSeenAt: { gt: new Date(Date.now() - 60000) } },
      });
      
      if (participation) {
        // We need to find by socket or session - simplified for now
        // In production, track socket-to-participation mapping
      }
    }
  } catch (error) {
    logger.error('Disconnect handler error', { error });
  }
}
