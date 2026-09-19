// ============================================================
// E2E Testing Endpoints (production-protected)
// Used for Playwright E2E tests that can't use real socket auth
// ============================================================

import { Router } from 'express';
import { verifySession } from '../auth/session.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';
import { validateBody } from './validators.js';
import { z } from 'zod';

export const e2eRouter: ReturnType<typeof Router> = Router();

// POST /api/v1/e2e/game-start — Startet ein laufendes Spiel via REST
// Umgeht Socket.IO game:start (das bei E2E-Tests wegen Session-Cookie-Problemen
// die Moderator-Rolle nicht korrekt setzt).
// Nutzt: verifySession + room.hostUserId → handleGameEvents.start()
const GameStartSchema = z.object({
  roomCode: z.string(),
  gameType: z.string().optional(),
});

e2eRouter.post('/game-start', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  }
  try {
    const parsed = validateBody(GameStartSchema, req.body, res);
    if (!parsed) return;

    const { roomCode } = parsed;
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No session.' } });
    }

    // Find the room
    const room = await (await import('../persistence/prisma.js')).prisma.room.findUnique({
      where: { code: roomCode },
      include: { gameDefinition: true },
    });
    if (!room) {
      return res.status(404).json({ success: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' } });
    }

    // Check if user is the room host
    const session = await (await import('../persistence/prisma.js')).prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });
    if (!session?.user || session.user.id !== room.hostUserId) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not the room host.' } });
    }

    // Get io instance from sockets/index.ts (via globalThis)
    const io = (globalThis as any).__quiz_io;
    if (!io) {
      return res.status(500).json({ success: false, error: { code: 'IO_NOT_READY', message: 'Socket.IO not initialized.' } });
    }

    // Call handleGameEvents.start directly
    const { handleGameEvents } = await import('../sockets/game.js');
    const socket = {
      id: `e2e-${sessionId}`,
      data: { roomId: room.id, role: 'MODERATOR', userId: session.user.id },
    } as any;

    await new Promise<void>((resolve) => {
      handleGameEvents.start(io, socket, { roomCode }, (result: any) => {
        logger.info('E2E game-start result', { roomCode, result });
        resolve();
      });
    });

    res.json({ success: true, data: { roomCode, status: 'RUNNING' } });
  } catch (err) {
    logger.error('e2e/game-start error', { error: (err as Error).message });
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } });
  }
});
