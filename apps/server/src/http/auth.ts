// ============================================================
// Online Quiz Plattform - Auth Router
// ============================================================

import { Router } from 'express';
import argon2 from 'argon2';
import rateLimit from 'express-rate-limit';
import { prisma } from '../persistence/prisma.js';
import { createSessionCookie, verifySession, deleteSessionCookie } from '../auth/session.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';
import { LoginSchema, E2ETokenSchema, validateBody } from './validators.js';
import { z } from 'zod';
import { getSocketIdBySession } from '../sockets/index.js';

export const authRouter: ReturnType<typeof Router> = Router();

// Rate limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Zu viele Anmeldeversuche. Bitte 15 Minuten warten.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/v1/auth/login — rate limiter nur in production
authRouter.post('/login',
  process.env.NODE_ENV === 'production' ? loginLimiter : (_req, _res, next) => next(),
  async (req, res) => {
  try {
    const parsed = validateBody(LoginSchema, req.body, res);
    if (!parsed) return;

    const { username, password } = parsed;

    // Find user by email or displayName
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: username },
          { displayName: username },
        ],
        disabledAt: null,
      },
    });

    if (!user) {
      logger.info('Login failed: user not found', { username });
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Ungültige Anmeldedaten.' },
      });
    }

    // Verify password
    const validPassword = await argon2.verify(user.passwordHash, password);
    if (!validPassword) {
      logger.info('Login failed: invalid password', { username });
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Ungültige Anmeldedaten.' },
      });
    }

    // Create session
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    });

    // Set cookie
    const cookie = createSessionCookie(session.id, config.sessionSecret);
    res.setHeader('Set-Cookie', cookie);

    logger.info('Login successful', { userId: user.id, username });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          displayName: user.displayName,
          role: user.role,
        },
      },
    });
  } catch (error) {
    logger.error('Login error', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Anmeldung fehlgeschlagen.' },
    });
  }
});

// POST /api/v1/auth/logout
authRouter.post('/logout', async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);

    if (sessionId) {
      await prisma.session.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      });
    }

    deleteSessionCookie(res);

    res.json({ success: true });
  } catch (error) {
    logger.error('Logout error', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Abmeldung fehlgeschlagen.' },
    });
  }
});

// GET /api/v1/auth/session
authRouter.get('/session', async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);

    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Nicht angemeldet.' },
      });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      deleteSessionCookie(res);
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
      });
    }

    // Update last active
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date() },
    });

    res.json({
      success: true,
      data: {
        user: {
          id: session.user.id,
          displayName: session.user.displayName,
          role: session.user.role,
        },
      },
    });
  } catch (error) {
    logger.error('Session check error', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Sitzungsprüfung fehlgeschlagen.' },
    });
  }
});

// =====================================================================
// E2E Test Auth — NUR in Development, kein Rate-Limit, kein Passwort
// =====================================================================
const E2ESocketSchema = z.object({
  socketId: z.string().optional(),
  roomCode: z.string(),
  role: z.enum(['MODERATOR', 'PLAYER', 'VIEWER']),
});
authRouter.post('/e2e-socket-identity', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  }
  try {
    const parsed = validateBody(E2ESocketSchema, req.body, res);
    if (!parsed) return;

    const { roomCode, role } = parsed;

    // Verify session
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No session.' } });
    }

    // Find room
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room) {
      return res.status(404).json({ success: false, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' } });
    }

    // Find socket by sessionId — uses getSocketIdBySession from sockets/index.ts
    let socketId = parsed.socketId;
    if (!socketId) {
      socketId = getSocketIdBySession(sessionId);
    }

    if (!socketId) {
      return res.status(200).json({ success: true, data: { message: 'Socket not found — OK for E2E fallback.' } });
    }

    // Dynamic import to avoid circular dependency with sockets/index.ts
    const theIo = (globalThis as any).__quiz_io;
    const socket = theIo?.sockets?.sockets?.get(socketId);
    if (socket) {
      socket.data = {
        ...socket.data,
        roomId: room.id,
        role,
        sessionId,
      };
      socket.join(`room:${room.id}`);
      logger.info('E2E socket identity set', { socketId, role, roomCode });
    }

    return res.status(200).json({ success: true, data: { socketId, role, roomCode } });
  } catch (err) {
    logger.error('e2e-socket-identity error', { error: (err as Error).message });
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } });
  }
});

// POST /api/v1/auth/e2e-token — Legt Session-Cookie für E2E-Tests an (kein Login nötig)
// Endpoint: POST /api/v1/auth/e2e-token
// Body: { "userId": "mod-1" }
// Response: Set-Cookie für die angegebene User-ID, kein Login nötig
authRouter.post('/e2e-token', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  }

  try {
    const parsed = validateBody(E2ETokenSchema, req.body, res);
    if (!parsed) return;
    const { userId } = parsed;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.disabledAt) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }

    const session = await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const cookie = createSessionCookie(session.id, config.sessionSecret);
    res.setHeader('Set-Cookie', cookie);

    logger.info('E2E token issued', { userId: user.id });

    res.json({
      success: true,
      data: {
        user: { id: user.id, displayName: user.displayName, role: user.role },
        sessionId: session.id,
      },
    });
  } catch (error) {
    logger.error('E2E token error', { error });
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Token generation failed.' } });
  }
});
