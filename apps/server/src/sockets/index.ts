// ============================================================
// Socket.IO Handler Setup
// ============================================================

import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { verifySession } from '../auth/session.js';
import { config } from '../config/index.js';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { handleRoomSubscription, handleRoomEvents, handleKickPlayer } from './room.js';
import { handlePlayerEvents } from './player.js';
import { handleLobbyEvents, handleDisconnect } from './lobby.js';
import { handleGameEvents } from './game.js';
import { handleJeopardyGame } from '../games/jeopardy/engine.js';
import { JeopardyGameState } from '../games/jeopardy/state.js';
import { getSocketDataIdentity } from './auth.js';

// ── Jeopardy Runtime Payload Validation ──────────────────────
const JeopardyFieldOpenSchema = z.object({
  boardIndex: z.union([z.literal(1), z.literal(2)]),
  categoryIndex: z.number().int().min(0).max(5),
  value: z.number().int().positive(),
  rejoinToken: z.string().optional(),
});

const JeopardyBuzzSchema = z.object({});

const JeopardyJudgeSchema = z.object({
  correct: z.boolean(),
  rejoinToken: z.string().optional(),
});

const JeopardyNextSchema = z.object({
  rejoinToken: z.string().optional(),
});

const JeopardyBoardSwitchSchema = z.object({
  toBoard: z.union([z.literal(1), z.literal(2)]),
  rejoinToken: z.string().optional(),
});

// ── Helper: validate with Zod, return error code ─────────────
function validateOrReject<T>(
  schema: z.ZodType<T>,
  data: unknown,
  callback?: (res: { success: boolean; error: string }) => void
): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues.map((i) => i.message).join('; ');
    callback?.({ success: false, error: `VALIDATION_ERROR: ${message}` });
    return null;
  }
  return result.data;
}

// Room channel helper - returns a Socket.IO room identifier for a specific room
export function roomChannel(roomId: string): string {
  // Socket.IO uses room names to emit to specific rooms
  // The roomId is the room UUID (not the public code)
  return `room:${roomId}`;
}

// E2E helper: find socket ID by session ID
// Uses the module-level io reference (set in setupSocketHandlers)
export function getSocketIdBySession(sessionId: string): string | undefined {
  // io is set by setupSocketHandlers; use type assertion for flexibility
  const theIo = (globalThis as any).__quiz_io as any;
  if (!theIo?.sockets?.sockets) return undefined;
  for (const [id, sock] of theIo.sockets.sockets.entries() ?? []) {
    if ((sock as any).sessionId === sessionId || (sock as any).user?.sessionId === sessionId) {
      return id;
    }
  }
  return undefined;
}

export function setupSocketHandlers(io: Server) {
  // Register on globalThis so getSocketIdBySession (called from HTTP routes)
  // can access the io instance
  (globalThis as any).__quiz_io = io;

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const sessionId = verifySession(socket.request as any, config.sessionSecret);
      (socket as any).sessionId = sessionId;
      if (sessionId) {
        const session = await prisma.session.findUnique({
          where: { id: sessionId },
          include: { user: true },
        });
        if (session && !session.revokedAt && session.expiresAt > new Date()) {
          (socket as any).user = session.user;
          (socket as any).user.sessionId = sessionId; // store for lookup
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

    // Jeopardy game events (P0-07: MODERATOR-only, P0-08: Zod validation, P0-09: error handling)
    socket.on('jeopardy:field:open', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyFieldOpenSchema, data, callback);
        if (!valid) return;
        handleJeopardyGame.handleFieldOpen(io, socket, valid).then(
          (result) => callback?.(result),
          (err) => { logger.error('jeopardy:field:open failed', { err }); callback?.({ success: false, error: 'INTERNAL_ERROR' }); }
        );
      } catch (err) {
        logger.error('jeopardy:field:open threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('jeopardy:field:lock', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyFieldOpenSchema, data, callback);
        if (!valid) return;
        handleJeopardyGame.handleFieldOpen(io, socket, valid as unknown as { boardIndex: 1 | 2; categoryIndex: number; value: number }).then(
          (result) => callback?.(result),
          (err: unknown) => { logger.error('jeopardy:field:lock failed', { err }); callback?.({ success: false, error: 'INTERNAL_ERROR' }); }
        );
      } catch (err) {
        logger.error('jeopardy:field:lock threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('jeopardy:buzz', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyBuzzSchema, data, callback);
        if (!valid) return;
        handleJeopardyGame.handleBuzz(io, socket, valid as unknown as Record<string, never>).then(
          (result) => callback?.(result),
          (err: unknown) => { logger.error('jeopardy:buzz failed', { err }); callback?.({ success: false, error: 'INTERNAL_ERROR' }); }
        );
      } catch (err) {
        logger.error('jeopardy:buzz threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('jeopardy:judge', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyJudgeSchema, data, callback);
        if (!valid) return;
        handleJeopardyGame.handleJudge(io, socket, valid as unknown as { correct: boolean }).then(
          (result) => callback?.(result),
          (err: unknown) => { logger.error('jeopardy:judge failed', { err }); callback?.({ success: false, error: 'INTERNAL_ERROR' }); }
        );
      } catch (err) {
        logger.error('jeopardy:judge threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('jeopardy:steal:buzz', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyBuzzSchema, data, callback);
        if (!valid) return;
        handleJeopardyGame.handleStealBuzz(io, socket, valid as unknown as Record<string, never>).then(
          (result) => callback?.(result),
          (err: unknown) => { logger.error('jeopardy:steal:buzz failed', { err }); callback?.({ success: false, error: 'INTERNAL_ERROR' }); }
        );
      } catch (err) {
        logger.error('jeopardy:steal:buzz threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('jeopardy:steal:judge', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyJudgeSchema, data, callback);
        if (!valid) return;
        handleJeopardyGame.handleStealJudge(io, socket, valid as unknown as { correct: boolean }).then(
          (result) => callback?.(result),
          (err: unknown) => { logger.error('jeopardy:steal:judge failed', { err }); callback?.({ success: false, error: 'INTERNAL_ERROR' }); }
        );
      } catch (err) {
        logger.error('jeopardy:steal:judge threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });

    socket.on('jeopardy:next', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyNextSchema, data, callback);
        if (!valid) return;
        handleJeopardyGame.handleNext(io, socket, valid as unknown as Record<string, never>).then(
          (result) => callback?.(result),
          (err: unknown) => { logger.error('jeopardy:next failed', { err }); callback?.({ success: false, error: 'INTERNAL_ERROR' }); }
        );
      } catch (err) {
        logger.error('jeopardy:next threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });

    // Jeopardy board switch (P0-07: MODERATOR-only, P0-08: Zod validation, P0-09: error handling)
    socket.on('jeopardy:board:switch', async (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyBoardSwitchSchema, data, callback);
        if (!valid) return;
        const identity = getSocketDataIdentity(socket);
        if (!identity?.roomId || identity.role !== 'MODERATOR') {
          callback?.({ success: false, error: 'UNAUTHORIZED' });
          return;
        }
        const room = await prisma.room.findUnique({ where: { id: identity.roomId } });
        if (!room) { callback?.({ success: false, error: 'ROOM_NOT_FOUND' }); return; }
        const result = await handleJeopardyGame.handleBoardSwitch(io, room);
        callback?.(result);
      } catch (err) {
        logger.error('jeopardy:board:switch threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });

    // Jeopardy game state resync (P0-11: full rejoin)
    socket.on('jeopardy:resync', async (_data, callback) => {
      try {
        const identity = getSocketDataIdentity(socket);
        if (!identity?.roomId) { callback?.({ success: false, error: 'NOT_IN_ROOM' }); return; }

        const room = await prisma.room.findUnique({
          where: { id: identity.roomId },
          include: { participations: true },
        }) as any;
        if (!room) { callback?.({ success: false, error: 'ROOM_NOT_FOUND' }); return; }

        const gameStateData = await prisma.roomGameState.findUnique({
          where: { roomId: identity.roomId },
        });
        if (!gameStateData) { callback?.({ success: false, error: 'GAME_NOT_FOUND' }); return; }

        const state: JeopardyGameState = JSON.parse(gameStateData.stateJson);
        const setup = JSON.parse(room.setupSnapshotJson ?? '{}') as {
          board1?: { categories: Array<{ name: string; clues: Array<{ value: number; question: string; answer: string; mediaType?: string; mediaAssetId?: string }> }> };
          board2?: { categories: Array<{ name: string; clues: Array<{ value: number; question: string; answer: string; mediaType?: string; mediaAssetId?: string }> }> };
        };

        // Build player scores from state
        const scores: Array<{ playerId: string; playerName: string; score: number }> = [];
        for (const [pId, score] of Object.entries(state.scores)) {
          const part = room.participations.find((p: any) => p.id === pId);
          scores.push({ playerId: pId, playerName: part?.displayName ?? pId, score });
        }

        // Determine if there's an active question
        let currentField: {
          categoryIndex: number;
          value: number;
          question: string;
          mediaType?: string;
          mediaAssetId?: string;
          answer?: string; // moderator only
          buzzWinnerId?: string | null;
          buzzWinnerName?: string | null;
          phase: string;
        } | null = null;

        if (state.currentField?.fieldDef) {
          const fd = state.currentField.fieldDef;
          // Get board data for question (already sent to all)
          const board = state.currentBoard === 1 ? setup.board1 : setup.board2;
          const cat = board?.categories[fd.categoryIndex];
          const clue = cat?.clues.find((c) => c.value === fd.value);

          currentField = {
            categoryIndex: fd.categoryIndex,
            value: fd.value,
            question: fd.question,
            mediaType: clue?.mediaType,
            mediaAssetId: clue?.mediaAssetId,
            buzzWinnerId: state.buzzWinner,
            buzzWinnerName: state.buzzWinner ? state.playerNames[state.buzzWinner] : null,
            phase: state.phase,
          };

          // P0-07: Only include answer for moderator
          if (identity.role === 'MODERATOR' && clue?.answer) {
            currentField.answer = clue.answer;
          }
        }

        // Get played fields (for board rendering)
        const playedFields: string[] = Object.keys(state.openFields);

        // Get board categories
        const getBoardCategories = (board: typeof setup.board1) =>
          (board?.categories ?? []).map((c) => ({ name: c.name, clueCount: c.clues.length }));

        const board1Cats = getBoardCategories(setup.board1);
        const board2Cats = getBoardCategories(setup.board2);

        callback?.({
          success: true,
          role: identity.role,
          currentBoard: state.currentBoard,
          phase: state.phase,
          scores,
          currentField,
          playedFields,
          board1Categories: board1Cats,
          board2Categories: board2Cats,
          board1Values: (setup.board1?.categories[0]?.clues.map((c) => c.value) ?? []).sort((a, b) => a - b),
          board2Values: (setup.board2?.categories[0]?.clues.map((c) => c.value) ?? []).sort((a, b) => a - b),
          gameEnded: (state.phase as unknown as string) === 'GAME_OVER',
        });
      } catch (err) {
        logger.error('jeopardy:resync threw', { err });
        callback?.({ success: false, error: 'INTERNAL_ERROR' });
      }
    });
    socket.on('disconnect', async (reason) => {
      logger.info('Socket disconnected', { socketId: socket.id, reason });
      await handleDisconnect(io, socket);
    });
  });
}

