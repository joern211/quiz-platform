// ============================================================
// Online Quiz Plattform - Rooms Router
// ============================================================

import { Router } from 'express';
import crypto from 'crypto';
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
      isPublic = true,
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

    // Hash PIN if provided
    let pinHash: string | null = null;
    if (pin) {
      pinHash = crypto.createHash('sha256').update(pin).digest('hex');
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
        id: room.id,
        code: room.code,
        roomName: room.roomName,
        status: room.status,
        runPhase: room.runPhase,
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
      where: { code: req.params.code },
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
    const { displayName, pin, rejoinToken } = req.body;

    if (!displayName) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION', message: 'Name erforderlich.' },
      });
    }

    const room = await prisma.room.findUnique({
      where: { code: req.params.code },
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

    // Check PIN - compare hashes properly
    if (room.pinHash) {
      // PIN is stored as SHA256 hash, compare hashes directly
      if (!pin) {
        return res.status(403).json({
          success: false,
          error: { code: 'INVALID_PIN', message: 'PIN erforderlich.' },
        });
      }
      const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
      if (pinHash !== room.pinHash) {
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
