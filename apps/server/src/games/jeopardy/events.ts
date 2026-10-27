// Jeopardy owns its event registration and its role-specific resync projection.
// ============================================================
// BASIS-STANDARDS-Integration:
//   - Kritische Mutationen (Feld öffnen, Buzzer, Stehlen, Judge, Weiter,
//     Board-Wechsel) laufen über den gemeinsamen Guard
//     (runGuardedCriticalAction): wirksames Recht (BUZZER_CONTROL/
//     JUDGE_ANSWER/ROUND_ADVANCE) aus der DB + Command-Receipts im
//     Absichtstoken-Modus + Protokollversions-Check + AppError-Metadaten.
//   - Die Engine behält ihre eigenen Rolle-/Phase-/CAS-Gates (Defense in
//     Depth); der Guard prüft zusätzlich das §2.3-Recht und Replay.
//   - VIEWER/DISPLAY haben keine Basis-Spielrechte.
// ============================================================
import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { handleJeopardyGame } from './engine.js';
import { JeopardyGameState } from './state.js';
import { getSocketDataIdentity } from '../../sockets/auth.js';
import { authorizeGameAction } from '../core/access.js';
import { gameErrorCode } from '../core/errors.js';
import { runGuardedCriticalAction, type EngineActionResult } from '../core/receiptedAction.js';

// ── Jeopardy Runtime Payload Validation ──────────────────────
const JeopardyFieldOpenSchema = z.object({
  boardIndex: z.union([z.literal(1), z.literal(2)]),
  categoryIndex: z.number().int().min(0).max(5),
  value: z.number().int().positive(),
  rejoinToken: z.string().optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});

const JeopardyBuzzSchema = z.object({
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});

const JeopardyJudgeSchema = z.object({
  correct: z.boolean(),
  rejoinToken: z.string().optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});

const JeopardyNextSchema = z.object({
  rejoinToken: z.string().optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});

const JeopardyBoardSwitchSchema = z.object({
  toBoard: z.union([z.literal(1), z.literal(2)]),
  rejoinToken: z.string().optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
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

// ── BASIS-STANDARDS: kritische Jeopardy-Mutation über Guard+Receipt ──────
// Die Jeopardy-Handler sind Promise-basiert (kein Callback) — ihr Ergebnis
// wird dem Guard direkt zurückgegeben (directHandler-Adapter).
function runJeopardyCriticalAction(
  io: Server,
  socket: Socket,
  args: {
    action: string;
    permission?: 'BUZZER_CONTROL' | 'JUDGE_ANSWER' | 'ROUND_ADVANCE';
    payload: unknown;
    handler: (onResult: (r: EngineActionResult) => void) => Promise<EngineActionResult | void>;
  },
  callback?: (result: { success: boolean; error?: string; [k: string]: unknown }) => void,
): Promise<void> {
  return runGuardedCriticalAction({
    io,
    socket,
    action: args.action,
    permission: args.permission,
    payload: args.payload,
    handler: args.handler,
  }, callback);
}

// Direct-return-Adapter: Promise-Handler → Guard-Handler (onResult-Variante).
function directHandler(run: () => Promise<{ success: boolean; error?: string }>) {
  return (onResult: (r: EngineActionResult) => void) => run().then((r) => {
    onResult(r as EngineActionResult);
  });
}

export function registerJeopardyEvents(io: Server, socket: Socket) {
    // Jeopardy game events (P0-07: HOST-only, P0-08: Zod validation, P0-09: error handling)
    socket.on('jeopardy:field:open', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyFieldOpenSchema, data, callback);
        if (!valid) return;
        void runJeopardyCriticalAction(io, socket, {
          action: 'fieldOpen',
          permission: 'BUZZER_CONTROL',
          payload: valid,
          handler: directHandler(() => handleJeopardyGame.handleFieldOpen(io, socket, valid)),
        }, callback);
      } catch (err) {
        logger.error('jeopardy:field:open threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });

    socket.on('jeopardy:field:lock', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyFieldOpenSchema, data, callback);
        if (!valid) return;
        void runJeopardyCriticalAction(io, socket, {
          action: 'fieldOpen',
          permission: 'BUZZER_CONTROL',
          payload: valid,
          handler: directHandler(() => handleJeopardyGame.handleFieldOpen(io, socket, valid as unknown as { boardIndex: 1 | 2; categoryIndex: number; value: number })),
        }, callback);
      } catch (err) {
        logger.error('jeopardy:field:lock threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });

    socket.on('jeopardy:buzz', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyBuzzSchema, data, callback);
        if (!valid) return;
        void runJeopardyCriticalAction(io, socket, {
          action: 'buzz',
          permission: 'BUZZER_CONTROL',
          payload: valid,
          handler: directHandler(() => handleJeopardyGame.handleBuzz(io, socket, valid as unknown as Record<string, never>)),
        }, callback);
      } catch (err) {
        logger.error('jeopardy:buzz threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });

    socket.on('jeopardy:judge', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyJudgeSchema, data, callback);
        if (!valid) return;
        void runJeopardyCriticalAction(io, socket, {
          action: 'judge',
          permission: 'JUDGE_ANSWER',
          payload: valid,
          handler: directHandler(() => handleJeopardyGame.handleJudge(io, socket, valid as unknown as { correct: boolean })),
        }, callback);
      } catch (err) {
        logger.error('jeopardy:judge threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });

    socket.on('jeopardy:steal:buzz', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyBuzzSchema, data, callback);
        if (!valid) return;
        void runJeopardyCriticalAction(io, socket, {
          action: 'stealBuzz',
          permission: 'BUZZER_CONTROL',
          payload: valid,
          handler: directHandler(() => handleJeopardyGame.handleStealBuzz(io, socket, valid as unknown as Record<string, never>)),
        }, callback);
      } catch (err) {
        logger.error('jeopardy:steal:buzz threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });

    socket.on('jeopardy:steal:judge', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyJudgeSchema, data, callback);
        if (!valid) return;
        void runJeopardyCriticalAction(io, socket, {
          action: 'stealJudge',
          permission: 'JUDGE_ANSWER',
          payload: valid,
          handler: directHandler(() => handleJeopardyGame.handleStealJudge(io, socket, valid as unknown as { correct: boolean })),
        }, callback);
      } catch (err) {
        logger.error('jeopardy:steal:judge threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });

    socket.on('jeopardy:next', (data, callback) => {
      try {
        const valid = validateOrReject(JeopardyNextSchema, data, callback);
        if (!valid) return;
        void runJeopardyCriticalAction(io, socket, {
          action: 'next',
          permission: 'ROUND_ADVANCE',
          payload: valid,
          handler: directHandler(() => handleJeopardyGame.handleNext(io, socket, valid as unknown as Record<string, never>)),
        }, callback);
      } catch (err) {
        logger.error('jeopardy:next threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });

    // Jeopardy board switch (P0-07: HOST-only, P0-08: Zod validation, P0-09: error handling)
    // BASIS-STANDARDS: BOARD_SWITCH über Guard (ROUND_ADVANCE-Recht) + Receipt.
    socket.on('jeopardy:board:switch', (data, callback) => {
      void (async () => {
      try {
        const valid = validateOrReject(JeopardyBoardSwitchSchema, data, callback);
        if (!valid) return;
        const auth = await authorizeGameAction(socket, { roles: ['HOST'], requireParticipation: true });
        if (!auth.ok) { callback?.({ success: false, error: auth.error }); return; }
        const room = await prisma.room.findUnique({
          where: { id: auth.actor.roomId }, include: { gameDefinition: true },
        });
        if (!room) { callback?.({ success: false, error: 'ROOM_NOT_FOUND' }); return; }
        if (room.gameDefinition.slug !== 'jeopardy') {
          callback?.({ success: false, error: 'WRONG_GAME' }); return;
        }
        await runGuardedCriticalAction({
          io,
          socket,
          action: 'boardSwitch',
          permission: 'ROUND_ADVANCE',
          payload: valid,
          handler: async (onResult) => {
            const gameStateRow = await prisma.roomGameState.findUnique({ where: { roomId: room.id } });
            if (!gameStateRow) { onResult({ success: false, error: 'GAME_NOT_FOUND' }); return; }
            const currentBoard = (JSON.parse(gameStateRow.stateJson) as JeopardyGameState).currentBoard;
            if (valid.toBoard !== (currentBoard === 1 ? 2 : 1)) {
              onResult({ success: false, error: 'WRONG_BOARD' }); return;
            }
            onResult(await handleJeopardyGame.handleBoardSwitch(io, room));
          },
        }, callback);
      } catch (err) {
        logger.error('jeopardy:board:switch threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
      })();
    });

    // Jeopardy game state resync (P0-11: full rejoin)
    socket.on('jeopardy:resync', async (_data, callback) => {
      try {
        const auth = authorizeGameAction(socket, { roles: ['HOST', 'PLAYER', 'VIEWER'] });
        if (!auth.ok) { callback?.({ success: false, error: auth.error }); return; }
        const identity = getSocketDataIdentity(socket);

        const room = await prisma.room.findUnique({
          where: { id: identity.roomId },
          include: { participations: true, gameDefinition: true },
        });
        if (!room) { callback?.({ success: false, error: 'ROOM_NOT_FOUND' }); return; }
        if (room.gameDefinition.slug !== 'jeopardy') {
          callback?.({ success: false, error: 'WRONG_GAME' }); return;
        }

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
          const part = room.participations.find((p) => p.id === pId);
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
          firstResponderId?: string;
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
            firstResponderId: state.currentField.firstResponderId,
            phase: state.phase,
          };

          // P0-07: Only include answer for moderator
          if (identity.role === 'HOST' && socket.data.userId === room.hostUserId && clue?.answer) {
            currentField.answer = clue.answer;
          }
        }

        // Get played fields (for board rendering)
        const playedFields: string[] = [];
        for (const boardNumber of [1, 2] as const) {
          const board = boardNumber === 1 ? setup.board1 : state.boardCount === 1 ? undefined : setup.board2;
          board?.categories.forEach((category, categoryIndex) => {
            category.clues.forEach((clue) => {
              const key = `${boardNumber}-${categoryIndex}-${clue.value}`;
              if (!state.openFields[key]) playedFields.push(key);
            });
          });
        }

        // Get board categories
        const getBoardCategories = (board: typeof setup.board1) =>
          (board?.categories ?? []).map((c) => ({ name: c.name, clueCount: c.clues.length }));

        const board1Cats = getBoardCategories(setup.board1);
        const board2Cats = state.boardCount === 1 ? [] : getBoardCategories(setup.board2);

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
          board2Values: state.boardCount === 1 ? [] : (setup.board2?.categories[0]?.clues.map((c) => c.value) ?? []).sort((a, b) => a - b),
          gameEnded: state.phase === 'GAME_END',
          buzzWinnerId: state.buzzWinner,
          stealWinnerId: state.stealWinner,
          playerNames: state.playerNames,
          finalScores: state.phase === 'GAME_END' ? scores.sort((a, b) => b.score - a.score) : undefined,
        });
      } catch (err) {
        logger.error('jeopardy:resync threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });
}
