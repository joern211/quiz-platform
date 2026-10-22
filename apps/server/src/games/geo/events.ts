// Geo-specific socket action adapters. Generic room lifecycle lives in sockets/game.ts.
// ============================================================
// BASIS-STANDARDS-Integration:
//   - Kritische Mutationen (Antwort, Joker, Reveal, Weiter) laufen über
//     den gemeinsamen Guard (runGuardedCriticalAction): wirksames Recht
//     (BUZZER_CONTROL/REVEAL_CONTENT/ROUND_ADVANCE) aus der DB +
//     Command-Receipts im Absichtstoken-Modus + Protokollversions-Check
//     + AppError-Metadaten (code/messageKey/traceId) bei Fehlern.
//   - VIEWER bleiben read-only: sie haben KEIN Basis-Spielrecht.
// ============================================================
import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { handleGeoGame } from './index.js';
import { getSocketDataIdentity } from '../../sockets/auth.js';
import { registerGeoResync } from './resync.js';
import { runGuardedCriticalAction } from '../core/receiptedAction.js';
import { prisma } from '../../persistence/prisma.js';

// Audit PR14, 14-03 (Nacharbeit): Envelope-Felder (stateVersion/
// expectedRevision) werden VOLLSTÄNDIG erlaubt und an die zentrale Prüfung
// übergeben — nie still entfernt (die zentrale Prüfung verwirft sie
// sonst, bevor sie stateVersion:-1 & Co. sehen kann). Legacy = Feld fehlt.
const roomAction = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/),
  rejoinToken: z.string().optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});
const answerAction = z.object({
  optionId: z.string().min(1),
  questionIndex: z.number().int().nonnegative().optional(),
  commandId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(),
  stateVersion: z.number().int().optional(),
  expectedRevision: z.number().int().optional(),
});

function validate<T>(schema: z.ZodType<T>, data: unknown, callback?: (result: { success: boolean; error: string }) => void): T | null {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  callback?.({ success: false, error: 'INVALID_PAYLOAD' });
  return null;
}

export function registerGeoEvents(io: Server, socket: Socket): void {
  socket.on('geo:answer', (data, callback) => {
    const valid = validate(answerAction, data, callback);
    if (valid) void handleGeoEvents.geoAnswer(io, socket, valid, callback);
  });
  socket.on('geo:joker:5050', (data, callback) => {
    const valid = validate(roomAction, data, callback);
    if (valid) void handleGeoEvents.geoJoker5050(io, socket, valid, callback);
  });
  socket.on('geo:joker:spy', (data, callback) => {
    const valid = validate(roomAction, data, callback);
    if (valid) void handleGeoEvents.geoJokerSpy(io, socket, valid, callback);
  });
  socket.on('geo:joker:risk', (data, callback) => {
    const valid = validate(roomAction, data, callback);
    if (valid) void handleGeoEvents.geoJokerRisk(io, socket, valid, callback);
  });
  socket.on('geo:reveal', (data, callback) => {
    const valid = validate(roomAction, data, callback);
    if (valid) void handleGeoEvents.geoReveal(io, socket, valid, callback);
  });
  socket.on('geo:next', (data, callback) => {
    const valid = validate(roomAction, data, callback);
    if (valid) void handleGeoEvents.geoNext(io, socket, valid, callback);
  });
  registerGeoResync(io, socket);
}

export const handleGeoEvents = {
  // ============================================================
  // Geo Quiz Events (delegated to geo engine with auth)
  // ============================================================

  async geoAnswer(
    io: Server,
    socket: Socket,
    data: { questionIndex?: number; optionId: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    await runGuardedCriticalAction({
      io,
      socket,
      action: 'answer',
      permission: 'BUZZER_CONTROL',
      payload: data,
      handler: async (onResult) => {
        // VIEWER role check: only PLAYER and HOST can answer (Rollen-Grenze).
        const identity = getSocketDataIdentity(socket);
        if (!identity || !identity.roomId) {
          onResult({ success: false, error: 'NOT_IN_ROOM' });
          return;
        }
        if (identity.role === 'VIEWER') {
          onResult({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
          return;
        }

        const room = await prisma.room.findUnique({
          where: { id: identity.roomId },
        });

        if (!room) {
          onResult({ success: false, error: 'ROOM_NOT_FOUND' });
          return;
        }

        // P0-10: Use socket.data.participationId instead of rejoinToken
        const dataWithRoom = {
          ...data,
          roomCode: room.code,
          participationId: socket.data.participationId,
        };

        await handleGeoGame.handleAnswer(io, socket, dataWithRoom, onResult);
      },
    }, callback);
  },

  async geoJoker5050(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    await runGuardedCriticalAction({
      io,
      socket,
      action: 'joker5050',
      permission: 'BUZZER_CONTROL',
      payload: data,
      handler: async (onResult) => {
        const identity = getSocketDataIdentity(socket);
        if (!identity || !identity.roomId) {
          onResult({ success: false, error: 'NOT_IN_ROOM' });
          return;
        }
        if (identity.role === 'VIEWER') {
          onResult({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
          return;
        }
        await handleGeoGame.handleJoker5050(io, socket, data, onResult);
      },
    }, callback);
  },

  async geoJokerSpy(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    await runGuardedCriticalAction({
      io,
      socket,
      action: 'jokerSpy',
      permission: 'BUZZER_CONTROL',
      payload: data,
      handler: async (onResult) => {
        const identity = getSocketDataIdentity(socket);
        if (!identity || !identity.roomId) {
          onResult({ success: false, error: 'NOT_IN_ROOM' });
          return;
        }
        if (identity.role === 'VIEWER') {
          onResult({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
          return;
        }
        await handleGeoGame.handleJokerSpy(io, socket, data, onResult);
      },
    }, callback);
  },

  async geoJokerRisk(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    await runGuardedCriticalAction({
      io,
      socket,
      action: 'jokerRisk',
      permission: 'BUZZER_CONTROL',
      payload: data,
      handler: async (onResult) => {
        const identity = getSocketDataIdentity(socket);
        if (!identity || !identity.roomId) {
          onResult({ success: false, error: 'NOT_IN_ROOM' });
          return;
        }
        if (identity.role === 'VIEWER') {
          onResult({ success: false, error: 'VIEWERS_CANNOT_MODIFY' });
          return;
        }
        await handleGeoGame.handleJokerRisk(io, socket, data, onResult);
      },
    }, callback);
  },

  async geoReveal(
    io: Server,
    socket: Socket,
    data: { roomCode: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    await runGuardedCriticalAction({
      io,
      socket,
      action: 'reveal',
      permission: 'REVEAL_CONTENT',
      payload: data,
      handler: async (onResult) => {
        // P0-17: Use socket identity for authorization
        const identity = getSocketDataIdentity(socket);
        if (!identity || !identity.roomId) {
          onResult({ success: false, error: 'NOT_IN_ROOM' });
          return;
        }

        const room = await prisma.room.findUnique({
          where: { id: identity.roomId },
        });

        if (!room) {
          onResult({ success: false, error: 'ROOM_NOT_FOUND' });
          return;
        }


        await handleGeoGame.handleReveal(io, socket, { roomCode: room.code }, onResult);
      },
    }, callback);
  },

  async geoNext(
    io: Server,
    socket: Socket,
    data: { roomCode: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    await runGuardedCriticalAction({
      io,
      socket,
      action: 'next',
      permission: 'ROUND_ADVANCE',
      payload: data,
      handler: async (onResult) => {
        // P0-17: Use socket identity for authorization
        const identity = getSocketDataIdentity(socket);
        if (!identity || !identity.roomId) {
          onResult({ success: false, error: 'NOT_IN_ROOM' });
          return;
        }

        const room = await prisma.room.findUnique({
          where: { id: identity.roomId },
        });

        if (!room) {
          onResult({ success: false, error: 'ROOM_NOT_FOUND' });
          return;
        }


        await handleGeoGame.handleNext(io, socket, { roomCode: room.code }, onResult);
      },
    }, callback);
  },

};
