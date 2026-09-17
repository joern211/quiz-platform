// ============================================================
// Online Quiz Plattform - Rooms Router
// ============================================================

import { Router } from 'express';
import crypto from 'crypto';
import argon2 from 'argon2';
import { prisma } from '../persistence/prisma.js';
import { verifySession } from '../auth/session.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';

export const roomsRouter : ReturnType<typeof Router> = Router();

// Generate unique room code using crypto
function generateRoomCode(): string {
  const d1 = crypto.randomInt(0, 1000);
  const d2 = crypto.randomInt(0, 1000);
  return `${String(d1).padStart(3, '0')}-${String(d2).padStart(3, '0')}`;
}

// Normalize room code to NNN-NNN format
// Accepts: NNN-NNN, NNNNNN, NNN NNN, strips spaces/dashes
export function normalizeRoomCode(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '').slice(0, 6);
  if (digits.length < 6) return digits;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

// GET /api/v1/rooms/public - List public rooms
roomsRouter.get('/public', async (_req, res) => {
  try {
    const rooms = await prisma.room.findMany({
      where: {
        isPublic: true,
        status: { in: ['LOBBY', 'RUNNING'] },
      },
      select: {
        id: true,
        code: true,
        roomName: true,
        status: true,
        runPhase: true,
        maxPlayers: true,
        allowViewers: true,
        cameraEnabled: true,
        gameDefinition: {
          select: {
            slug: true,
            name: true,
            category: true,
          },
        },
        _count: {
          select: {
            participations: {
              where: { role: 'PLAYER' },
            },
            viewerSessions: true,
          },
        },
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      success: true,
      data: rooms.map(r => ({
        id: r.id,
        code: r.code,
        roomName: r.roomName,
        status: r.status,
        runPhase: r.runPhase,
        maxPlayers: r.maxPlayers,
        allowViewers: r.allowViewers,
        cameraEnabled: r.cameraEnabled,
        game: r.gameDefinition,
        playerCount: r._count.participations,
        viewerCount: r._count.viewerSessions,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    logger.error('Failed to list rooms', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Räume konnten nicht geladen werden.' },
    });
  }
});

// POST /api/v1/rooms - Create room (Moderator only)
roomsRouter.post('/', async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' },
      });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
      });
    }

    const {
      gameSlug,
      gameDefinitionId,
      roomName,
      pin,
      maxPlayers = 10,
      cameraEnabled = false,
      allowViewers = true,
      viewerRequiresPin = true,
      viewerLimit = 50,
      lobbyChatEnabled = true,
      setupSnapshotJson = {},
    } = req.body;

    // Validate required fields
    if (!roomName) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION', message: 'Raumname erforderlich.' },
      });
    }

    // Resolve game definition: prefer slug, fallback to id
    let resolvedGameDefId = gameDefinitionId;
    if (!resolvedGameDefId && gameSlug) {
      const gameDef = await prisma.gameDefinition.findUnique({
        where: { slug: gameSlug },
      });
      if (!gameDef) {
        return res.status(400).json({
          success: false,
          error: { code: 'GAME_NOT_FOUND', message: 'Spiel nicht gefunden.' },
        });
      }
      resolvedGameDefId = gameDef.id;
    }

    if (!resolvedGameDefId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION', message: 'Spiel (slug oder id) erforderlich.' },
      });
    }

    // Generate unique code
    let code: string;
    let attempts = 0;
    do {
      code = generateRoomCode();
      const existing = await prisma.room.findUnique({ where: { code } });
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      return res.status(500).json({
        success: false,
        error: { code: 'CODE_COLLISION', message: 'Raumcode konnte nicht generiert werden.' },
      });
    }

    // Hash PIN if provided (using argon2id)
    let pinHash: string | null = null;
    if (pin) {
      pinHash = await argon2.hash(pin, { type: argon2.argon2id });
    }

    // Create room
    const room = await prisma.room.create({
      data: {
        code,
        roomName,
        gameDefinitionId: resolvedGameDefId,
        hostUserId: session.userId,
        pinHash,
        maxPlayers,
        cameraEnabled,
        allowViewers,
        viewerRequiresPin,
        viewerLimit,
        lobbyChatEnabled,
        setupSnapshotJson: JSON.stringify(setupSnapshotJson),
        status: 'LOBBY',
        runPhase: 'OPEN',
      },
    });

    // Create host participation
    await prisma.participation.create({
      data: {
        roomId: room.id,
        displayName: session.user.displayName,
        normalizedName: session.user.displayName.toLowerCase().trim(),
        role: 'MODERATOR',
        connected: true,
        ready: true,
        rejoinToken: crypto.randomUUID(),
        rejoinTokenVersion: 1,
      },
    });

    logger.info('Room created', { roomId: room.id, code, hostId: session.userId });

    res.status(201).json({
      success: true,
      data: {
        code: room.code,
        roomId: room.id,
      },
    });
  } catch (error) {
    logger.error('Failed to create room', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Raum konnte nicht erstellt werden.' },
    });
  }
});

// GET /api/v1/rooms/:code - Get room details
roomsRouter.get('/:code', async (req, res) => {
  try {
    // Check if user is authenticated
    const sessionId = verifySession(req, config.sessionSecret);
    let isAuthenticated = false;
    let userId: string | null = null;

    if (sessionId) {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        include: { user: true },
      });
      if (session && !session.revokedAt && session.expiresAt >= new Date()) {
        isAuthenticated = true;
        userId = session.userId;
      }
    }

    const room = await prisma.room.findUnique({
      where: { code: normalizeRoomCode(req.params.code) },
      include: {
        gameDefinition: true,
        participations: {
          where: { role: { not: 'VIEWER' } },
          select: {
            id: true,
            displayName: true,
            role: true,
            connected: true,
            ready: true,
            avatarMode: true,
            avatarGenerated: true,
            score: true,
            lives: true,
          },
        },
        _count: {
          select: { viewerSessions: true },
        },
      },
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    // Only show isPublic rooms to non-authenticated users
    // Authenticated moderators can see their own rooms regardless of isPublic
    if (!isAuthenticated && !room.isPublic) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }
    if (isAuthenticated && !room.isPublic && room.hostUserId !== userId) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    res.json({
      success: true,
      data: {
        id: room.id,
        code: room.code,
        roomName: room.roomName,
        status: room.status,
        runPhase: room.runPhase,
        maxPlayers: room.maxPlayers,
        cameraEnabled: room.cameraEnabled,
        allowViewers: room.allowViewers,
        game: room.gameDefinition,
        players: room.participations.map(p => ({
          id: p.id,
          displayName: p.displayName,
          role: p.role,
          connected: p.connected,
          ready: p.ready,
          score: p.score,
          lives: p.lives,
        })),
        viewerCount: room._count.viewerSessions,
        createdAt: room.createdAt,
      },
    });
  } catch (error) {
    logger.error('Failed to get room', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Raum konnte nicht geladen werden.' },
    });
  }
});

// POST /api/v1/rooms/:code/join - Player join
// TODO: Add rate limiting for join attempts to prevent brute-force PIN attacks
roomsRouter.post('/:code/join', async (req, res) => {
  try {
    const { displayName, pin } = req.body;

    if (!displayName) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION', message: 'Name erforderlich.' },
      });
    }

    const room = await prisma.room.findUnique({
      where: { code: normalizeRoomCode(req.params.code) },
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    if (room.status !== 'LOBBY') {
      return res.status(400).json({
        success: false,
        error: { code: 'ROOM_NOT_JOINABLE', message: 'Raum ist nicht mehr beitretbar.' },
      });
    }

    // Check PIN - verify with argon2
    if (room.pinHash) {
      if (!pin) {
        return res.status(403).json({
          success: false,
          error: { code: 'INVALID_PIN', message: 'PIN erforderlich.' },
        });
      }
      const validPin = await argon2.verify(room.pinHash, pin);
      if (!validPin) {
        return res.status(403).json({
          success: false,
          error: { code: 'INVALID_PIN', message: 'Falscher PIN.' },
        });
      }
    }

    // Check player limit
    const playerCount = await prisma.participation.count({
      where: { roomId: room.id, role: 'PLAYER' },
    });

    if (playerCount >= room.maxPlayers) {
      return res.status(400).json({
        success: false,
        error: { code: 'ROOM_FULL', message: 'Raum ist voll.' },
      });
    }

    // Generate new rejoin token for this join
    const newRejoinToken = crypto.randomUUID();

    // Create participation with rejoinTokenVersion: 1 on first join
    const participation = await prisma.participation.create({
      data: {
        roomId: room.id,
        displayName,
        normalizedName: displayName.toLowerCase().trim(),
        role: 'PLAYER',
        connected: true,
        ready: false,
        rejoinToken: newRejoinToken,
        rejoinTokenVersion: 1,
      },
    });

    logger.info('Player joined', { roomId: room.id, participationId: participation.id });

    res.status(201).json({
      success: true,
      data: {
        rejoinToken: newRejoinToken,
        participationId: participation.id,
        role: 'PLAYER',
        roomCode: room.code,
      },
    });
  } catch (error) {
    logger.error('Failed to join room', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Beitritt fehlgeschlagen.' },
    });
  }
});

// DELETE /api/v1/rooms/:code - Close room (moderator only)
roomsRouter.delete('/:code', async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' },
      });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' },
      });
    }

    const roomData = await prisma.room.findUnique({
      where: { code: normalizeRoomCode(req.params.code) },
    });

    if (!roomData) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    // Only host can close their room
    if (roomData.hostUserId !== session.userId) {
      return res.status(403).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Nur der Raum-Ersteller kann den Raum schließen.' },
      });
    }

    const room = await prisma.room.update({
      where: { code: normalizeRoomCode(req.params.code) },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });

    logger.info('Room closed', { roomId: room.id, code: room.code });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to close room', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Raum konnte nicht geschlossen werden.' },
    });
  }
});

// GET /api/v1/rooms/:code/results - Get game results
roomsRouter.get('/:code/results', async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { code: normalizeRoomCode(req.params.code) },
      include: {
        gameDefinition: { select: { slug: true, name: true } },
        participations: {
          where: { role: { not: 'VIEWER' } },
          orderBy: { score: 'desc' },
          select: { id: true, displayName: true, role: true, score: true },
        },
        gameState: {
          select: { phase: true, stateJson: true },
        },
      },
    });

    if (!room) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Raum nicht gefunden.' },
      });
    }

    // Return results for ENDED rooms or RUNNING rooms with RESULTS phase
    if (room.status !== 'ENDED' && room.status !== 'RUNNING' && room.status !== 'LOBBY') {
      return res.status(404).json({
        success: false,
        error: { code: 'RESULTS_NOT_AVAILABLE', message: 'Ergebnisse noch nicht verfügbar.' },
      });
    }

    const rankedPlayers = room.participations.map((p, i) => ({
      rank: i + 1,
      participationId: p.id,
      displayName: p.displayName,
      role: p.role,
      score: p.score,
    }));

    res.json({
      success: true,
      data: {
        roomCode: room.code,
        roomName: room.roomName,
        status: room.status,
        runPhase: room.runPhase,
        game: room.gameDefinition,
        scores: rankedPlayers,
        endedAt: room.endedAt,
      },
    });
  } catch (error) {
    logger.error('Failed to get results', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Ergebnisse konnten nicht geladen werden.' },
    });
  }
});
