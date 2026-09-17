// ============================================================
// Online Quiz Plattform - Auth Router
// ============================================================

import { Router } from 'express';
import argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import rateLimit from 'express-rate-limit';
import { prisma } from '../persistence/prisma.js';
import { createSessionCookie, verifySession, deleteSessionCookie } from '../auth/session.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';

export const authRouter = Router();

// Rate limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Zu viele Anmeldeversuche. Bitte 15 Minuten warten.' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/v1/auth/login
authRouter.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION', message: 'Benutzername und Passwort erforderlich.' },
      });
    }

    // Find user
    const user = await prisma.user.findFirst({
      where: {
        displayName: username,
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
