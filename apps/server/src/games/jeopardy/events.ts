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
import { getGameEngineContract } from '../core/engineContract.js';
import { JeopardyGameState } from './state.js';
import { authorizeGameAction, authorizeGameContext } from '../core/access.js';
import { gameErrorCode } from '../core/errors.js';
import { runGuardedCriticalAction, receiptPayloadWithoutRoomCode, type EngineActionResult } from '../core/receiptedAction.js';
import { ensureGameStateSafe } from '../core/recovery.js';
import { limitSocketRead } from '../core/limitGuard.js';

// ── Jeopardy Runtime Payload Validation ──────────────────────
const JeopardyFieldOpenSchema = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/).optional(),
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
  roomCode: z.string().regex(/^\d{3}-\d{3}$/).optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});

const JeopardyJudgeSchema = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/).optional(),
  correct: z.boolean(),
  attemptId: z.string().min(1).max(256).optional(),
  rejoinToken: z.string().optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});

const JeopardyNextSchema = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/).optional(),
  rejoinToken: z.string().optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});

const JeopardyBoardSwitchSchema = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/).optional(),
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
    gameSlug: 'jeopardy',
    io,
    socket,
    action: args.action,
    permission: args.permission,
    payload: args.payload,
    receiptPayload: receiptPayloadWithoutRoomCode(args.payload as object),
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
          handler: directHandler(() => getGameEngineContract('jeopardy')!.handleCommand({ io, socket }, { action: 'fieldOpen', payload: valid })),
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
          handler: directHandler(() => getGameEngineContract('jeopardy')!.handleCommand({ io, socket }, { action: 'fieldOpen', payload: valid })),
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
          handler: directHandler(() => getGameEngineContract('jeopardy')!.handleCommand({ io, socket }, { action: 'buzz', payload: valid })),
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
          handler: directHandler(() => getGameEngineContract('jeopardy')!.handleCommand({ io, socket }, { action: 'judge', payload: valid })),
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
          handler: directHandler(() => getGameEngineContract('jeopardy')!.handleCommand({ io, socket }, { action: 'stealBuzz', payload: valid })),
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
          handler: directHandler(() => getGameEngineContract('jeopardy')!.handleCommand({ io, socket }, { action: 'stealJudge', payload: valid })),
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
          handler: directHandler(() => getGameEngineContract('jeopardy')!.handleCommand({ io, socket }, { action: 'next', payload: valid })),
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
        await ensureGameStateSafe(room.id);
        await runGuardedCriticalAction({
    gameSlug: 'jeopardy',
          io,
          socket,
          action: 'boardSwitch',
          permission: 'ROUND_ADVANCE',
          payload: valid,
          receiptPayload: receiptPayloadWithoutRoomCode(valid),
          handler: async (onResult) => {
            const gameStateRow = await prisma.roomGameState.findUnique({ where: { roomId: room.id } });
            if (!gameStateRow) { onResult({ success: false, error: 'GAME_NOT_FOUND' }); return; }
            const currentBoard = (JSON.parse(gameStateRow.stateJson) as JeopardyGameState).currentBoard;
            if (valid.toBoard !== (currentBoard === 1 ? 2 : 1)) {
              onResult({ success: false, error: 'WRONG_BOARD' }); return;
            }
            onResult(await getGameEngineContract('jeopardy')!.handleCommand({ io, socket }, { action: 'boardSwitch', payload: valid }));
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
      const limited = limitSocketRead(socket, 'jeopardy:resync');
      if (limited) { callback?.({ ...limited }); return; }
      try {
        const auth = await authorizeGameContext(socket, { roles: ['HOST', 'PLAYER', 'VIEWER'], gameSlug: 'jeopardy', roomCode: _data?.roomCode, requireParticipation: true });
        if (!auth.ok) { callback?.({ success: false, error: auth.error }); return; }
        const { room } = auth;
        const participations = await prisma.participation.findMany({ where: { roomId: room.id } });

        const gameStateData = await prisma.roomGameState.findUnique({
          where: { roomId: room.id },
        });
        if (!gameStateData) { callback?.({ success: false, error: 'GAME_NOT_FOUND' }); return; }

        const state: JeopardyGameState = JSON.parse(gameStateData.stateJson);
        callback?.(getGameEngineContract('jeopardy')!.createProjection({ state, setup: JSON.parse(room.setupSnapshotJson ?? '{}'), actor: { ...auth.actor, blindHost: room.contentVisibility === 'BLIND_HOST' }, participants: participations, stateVersion: gameStateData.revision }));
      } catch (err) {
        logger.error('jeopardy:resync threw', { err });
        callback?.({ success: false, error: gameErrorCode(err) });
      }
    });
}
