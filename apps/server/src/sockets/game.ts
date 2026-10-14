// ============================================================
// Game Socket Events
// ============================================================
// BASIS-STANDARDS-Integration:
//   - Autorisierung über den gemeinsamen Permission-Vertrag
//     (GAME_START/GAME_PAUSE/GAME_ABORT, §2.3): Raumzugehörigkeit +
//     aktuelle wirksame Rechte (Grants/Revocations aus der DB),
//     nie nur requireRoomRole.
//   - Wiederholungssicherheit: kritische Lifecycle-Mutationen (Start,
//     Abort) laufen mit Command-Receipts, soweit der Client ein
//     Absichtstoken (commandId) mitschickt.
//   - Start-Snapshot: beim Start wird die aufgelöste Game-Config als
//     unveränderlicher Snapshot (gameSlug + engineVersion) persistiert
//     (§5.24). Live-/Legacy-Änderungen rückwirken nicht.
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';
import { getGameHandler } from '../games/registry.js';
import { gameErrorCode } from '../games/core/errors.js';
import { requireRoomRole, getSocketDataIdentity } from './auth.js';
import { requireGamePermission } from '../games/core/permissions.js';
import { runReceipted } from '../games/core/commands.js';
import { resolveCommandContextForSocket } from '../games/core/commandContext.js';
import { persistConfigSnapshot, ENGINE_VERSIONS } from '../games/core/config.js';
import { resolveCanonicalSlug } from '@quiz/shared';
import { wireErrorToAppError } from '../games/core/appError.js';
import { roomChannel } from './index.js';

export const handleGameEvents = {
  // ============================================================
  // Generic Game Events
  // ============================================================

  async start(
    io: Server,
    socket: Socket,
    data: { roomCode: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    logger.info('game:start received', { socketId: socket.id, roomCode: data.roomCode, socketData: socket.data });

    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
        include: { gameDefinition: true },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // P0-17: Use socket identity for authorization
      const identity = getSocketDataIdentity(socket);
      logger.info('game:start identity check', { identity, socketId: socket.id });
      if (!identity || identity.roomId !== room.id) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      // BASIS-STANDARDS: gemeinsamer Permission-Guard (GAME_START) mit
      // aktueller, DB-basierter Berechtigung (Grants/Revocations).
      const perm = await requireGamePermission(socket, 'GAME_START');
      if (!perm.ok) {
        logger.info('game:start permission denied', { socketId: socket.id, error: perm.error });
        callback?.({ success: false, error: perm.error === 'NOT_IN_ROOM' ? 'NOT_IN_ROOM' : 'UNAUTHORIZED' });
        return;
      }
      const authorized = requireRoomRole(socket, 'HOST');
      logger.info('game:start auth result', { authorized, socketId: socket.id, role: identity?.role });
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
        return;
      }

      // Verify socket is in this room
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      // Protokollversion: explizit inkompatible Version → VOR Mutation ablehnen.
      const cmdCtx = resolveCommandContextForSocket(data, socket);
      if (!cmdCtx.ok && cmdCtx.error === 'CLIENT_VERSION_UNSUPPORTED') {
        callback?.({ success: false, error: 'CLIENT_VERSION_UNSUPPORTED' });
        return;
      }

      // Status-Check: im Legacy-Modus (ohne Absichtstoken) wird ein bereits
      // gestartetes Spiel früh abgelehnt. Im Command-Modus wird ein
      // Duplicate stattdessen als REPLAY der gespeicherten Antwort behandelt
      // (exakt eine fachliche Wirkung, deterministische Antwort) →
      // Status-Check hier übersprungen; die Receipt-/CAS-Schicht entscheidet.
      const inStartCommandMode = cmdCtx.ok && Boolean(cmdCtx.ctx.commandId);
      if (!inStartCommandMode && room.status !== 'LOBBY') {
        callback?.({ success: false, error: 'GAME_ALREADY_STARTED' });
        return;
      }

      // P0-18: Check minPlayers from GameDefinition
      const minPlayers = room.gameDefinition.minPlayers || 2;
      const playerCount = await prisma.participation.count({
        where: {
          roomId: room.id,
          role: 'PLAYER',
          connected: true,
        },
      });

      if (playerCount < minPlayers) {
        callback?.({
          success: false,
          error: 'NOT_ENOUGH_PLAYERS',
          required: minPlayers,
          current: playerCount,
        });
        return;
      }

      // Check all players ready
      const unreadyPlayers = await prisma.participation.count({
        where: {
          roomId: room.id,
          role: 'PLAYER',
          connected: true,
          ready: false,
        },
      });

      if (unreadyPlayers > 0) {
        callback?.({ success: false, error: 'NOT_ALL_READY' });
        return;
      }

      // Resolve the lifecycle before mutating room state. Unsupported games
      // must never transiently enter RUNNING.
      const gameHandler = getGameHandler(room.gameDefinition.slug);
      if (!gameHandler) {
        callback?.({ success: false, error: 'GAME_NOT_IMPLEMENTED' });
        return;
      }

      // Update room status atomically from the lobby revision (+ initialize,
      // Snapshot, Emit, afterStart) als eine fachliche Mutation. Im
      // Command-Modus (Client schickt commandId) wird sie mit einem
      // atomaren Command-Receipt geschützt: ein Retry derselben Absicht
      // erzeugt keine zweite Wirkung (CAS + Receipt).
      const performStart = async () => {
        // Update room status atomically from the lobby revision.
        const started = await prisma.room.updateMany({
          where: { id: room.id, status: 'LOBBY', revision: room.revision },
          data: {
            status: 'RUNNING',
            runPhase: 'INTRO',
            startedAt: new Date(),
            revision: { increment: 1 },
          },
        });
        if (started.count !== 1) {
          throw new Error('GAME_ALREADY_STARTED');
        }

        try {
          await gameHandler.initialize({ io, room, initialPhase: 'INTRO' });
        } catch (error) {
          // Only undo the transition we own. Do not reset a room that another
          // action has already advanced, and remove partial initialization.
          await prisma.$transaction(async (tx) => {
            const reverted = await tx.room.updateMany({
              where: { id: room.id, status: 'RUNNING', revision: room.revision + 1 },
              data: { status: 'LOBBY', runPhase: 'LOBBY', startedAt: null, revision: { increment: 1 } },
            });
            if (reverted.count === 1) {
              await tx.roomGameState.deleteMany({ where: { roomId: room.id } });
              await tx.commandReceipt.deleteMany({ where: { roomId: room.id, status: 'PENDING', action: 'GAME_START' } });
            }
          });
          throw error;
        }

        // BASIS-STANDARDS (E) + Audit PR14, 14-04/14-05: unveränderlicher
        // Start-Snapshot als START-INVARIANTE (kein degradierter Start ohne
        // Snapshot mehr). Der Snapshot trägt den KANONISCHEN Slug und die
        // TATSÄCHLICHE Engine-Version (ENGINE_VERSIONS — kein pauschales 1
        // mehr) und die aufgelösten TATSÄCHLICHEN Werte. Ein Fehler hier
        // (z.B. defektes Setup, unbekannte Engine-Version) → Rollback der
        // Start-Übergabe (kein RUNNING ohne Snapshot).
        // Audit PR14, 14-04: Der Raum kann einen LEGACY-Slug tragen
        // (Migration läuft/übersprungen) — für die Engine-Version-Auflösung
        // muss der KANONISCHE Slug her, sonst greift der Fallback `?? 1`
        // (WID-Snapshot v1 statt v2). persistConfigSnapshot normalisiert
        // intern ebenfalls; hier wird die Version korrekt gewählt.
        const canonicalSlug = resolveCanonicalSlug(room.gameDefinition.slug) ?? room.gameDefinition.slug;
        const engineVersion = ENGINE_VERSIONS[canonicalSlug]?.current ?? 1;
        try {
          const snapshotRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
          await persistConfigSnapshot(snapshotRoom, canonicalSlug, engineVersion);
        } catch (snapshotError) {
          // Rollback der (bereits committierten) Start-Übergabe — gleiche
          // Semantik wie bei einem initialize-Fehler.
          const failedRoom = await prisma.room.findUnique({ where: { id: room.id } });
          await prisma.$transaction(async (tx) => {
            const reverted = await tx.room.updateMany({
              where: { id: room.id, status: 'RUNNING', revision: (failedRoom?.revision ?? room.revision + 1) },
              data: { status: 'LOBBY', runPhase: 'LOBBY', startedAt: null, revision: { increment: 1 } },
            });
            if (reverted.count === 1) {
              await tx.roomGameState.deleteMany({ where: { roomId: room.id } });
              await tx.commandReceipt.deleteMany({ where: { roomId: room.id, status: 'PENDING', action: 'GAME_START' } });
              await tx.room.update({ where: { id: room.id }, data: { gameConfigSnapshotJson: null, configSchemaVersion: 0 } });
            }
          });
          throw snapshotError;
        }

        // Emit game start
        io.to(channel).emit('game:start', {
          roomCode: data.roomCode,
          status: 'RUNNING',
          runPhase: 'INTRO',
          gameSlug: room.gameDefinition.slug,
        });

        // Optional game-specific post-start lifecycle (for example Geo's
        // intro-to-first-round transition).
        await gameHandler.afterStart?.({
          io,
          room,
          initialPhase: 'INTRO',
        });

        return { gameSlug: room.gameDefinition.slug };
      };

      if (cmdCtx.ok && cmdCtx.ctx.commandMode) {
        try {
          const receipted = await runReceipted<{ gameSlug: string }>(prisma, {
            roomId: room.id,
            commandId: cmdCtx.ctx.commandId!,
            actor: { actorId: identity.participationId ?? room.id, actorRole: perm.role },
            action: 'GAME_START',
            payload: { roomCode: data.roomCode },
            // Audit PR14, 14-02/14-03: mitgesendete Versionserwartung wird
            // serverseitig gegen die aktuelle Room-Revision geprüft.
            stateVersion: cmdCtx.ctx.envelope?.stateVersion,
            mutate: performStart,
            toResponse: (d) => ({ success: true, ...d }),
          });
          if (receipted.success) {
            callback?.({ success: true, gameSlug: receipted.data.gameSlug, ...(receipted.replayed ? { replayed: true } : {}) });
          } else {
            callback?.({ success: false, error: receipted.error, ...(receipted.replayed ? { replayed: true } : {}), ...('resyncRequired' in receipted && receipted.resyncRequired ? { resyncRequired: true } : {}) });
          }
          return;
        } catch (error) {
          const appError = wireErrorToAppError(gameErrorCode(error), { internalDetail: error, context: { socketId: socket.id } });
          logger.error('Game start (receipted) error', { error });
          callback?.({ success: false, error: gameErrorCode(error), code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
          return;
        }
      }

      // Legacy-Pfad (kein Absichtstoken im Client): Verhalten wie vor
      // BASIS-STANDARDS, ohne Receipt-Schutz (ehrlich dokumentiert).
      const r = await performStart();
      callback?.({ success: true, gameSlug: r.gameSlug });
    } catch (error) {
      logger.error('Game start error', { error });
      // BASIS-STANDARDS (D): AppError-Vertrag (code/messageKey/traceId),
      // bestehende Wire-Codes bleiben als `code` erhalten.
      const appError = wireErrorToAppError(gameErrorCode(error), { internalDetail: error, context: { socketId: socket.id } });
      callback?.({ success: false, error: gameErrorCode(error), code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
    }
  },

  async pause(
    io: Server,
    socket: Socket,
    data: { roomCode: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
        include: { gameDefinition: true },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // P0-17: Use socket identity for authorization
      const identity = getSocketDataIdentity(socket);
      if (!identity.roomId || identity.roomId !== room.id) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      // BASIS-STANDARDS: Permission-Guard (GAME_PAUSE), aktuelle DB-Rechte.
      const perm = await requireGamePermission(socket, 'GAME_PAUSE');
      if (!perm.ok) {
        callback?.({ success: false, error: perm.error === 'NOT_IN_ROOM' ? 'NOT_IN_ROOM' : 'UNAUTHORIZED' });
        return;
      }
      const authorized = requireRoomRole(socket, 'HOST');
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
        return;
      }

      // Verify socket is in this room
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      // Protokollversion: explizit inkompatibel → VOR der Mutation ablehnen.
      const cmdCtx = resolveCommandContextForSocket(data, socket);
      if (!cmdCtx.ok && cmdCtx.error === 'CLIENT_VERSION_UNSUPPORTED') {
        callback?.({ success: false, error: 'CLIENT_VERSION_UNSUPPORTED' });
        return;
      }

      const gameHandler = getGameHandler(room.gameDefinition.slug);
      if (!gameHandler?.pause) {
        callback?.({ success: false, error: 'GAME_ACTION_UNSUPPORTED' });
        return;
      }

      const perform = () => new Promise<any>((resolve, reject) => {
        let done = false;
        gameHandler.pause!({
          io, socket, roomCode: room.code,
          callback: (res: any) => { if (!done) { done = true; if (res && res.success) resolve(res); else reject(new Error(res?.error ?? 'PAUSE_FAILED')); } },
        }).catch(reject);
      });

      if (cmdCtx.ok && cmdCtx.ctx.commandMode) {
        try {
          const receipted = await runReceipted<any>(prisma, {
            roomId: room.id,
            commandId: cmdCtx.ctx.commandId!,
            actor: { actorId: identity.participationId ?? room.id, actorRole: perm.role },
            action: 'GAME_PAUSE',
            payload: data,
            stateVersion: cmdCtx.ctx.envelope?.stateVersion,
            mutate: perform,
            toResponse: (d) => d,
          });
          if (receipted.success) callback?.({ success: true, ...(receipted.replayed ? { replayed: true } : {}) });
          else callback?.({ success: false, error: receipted.error, ...(receipted.replayed ? { replayed: true } : {}), ...('resyncRequired' in receipted && receipted.resyncRequired ? { resyncRequired: true } : {}) });
        } catch (error) {
          const e2 = wireErrorToAppError(gameErrorCode(error), { internalDetail: error, context: { socketId: socket.id } });
          logger.error('Game pause (receipted) error', { error });
          callback?.({ success: false, error: gameErrorCode(error), code: e2.code, messageKey: e2.messageKey, traceId: e2.traceId });
        }
        return;
      }

      const result = await perform();
      callback?.({ success: true, ...(typeof result === 'object' ? result : {}) });
    } catch (error) {
      logger.error('Game pause error', { error });
      const appError = wireErrorToAppError(gameErrorCode(error), { internalDetail: error, context: { socketId: socket.id } });
      callback?.({ success: false, error: gameErrorCode(error), code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
    }
  },

  async resume(
    io: Server,
    socket: Socket,
    data: { roomCode: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
        include: { gameDefinition: true },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // P0-17: Use socket identity for authorization
      const identity = getSocketDataIdentity(socket);
      if (!identity.roomId || identity.roomId !== room.id) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      // BASIS-STANDARDS: Permission-Guard (GAME_PAUSE umfasst Pause/Resume).
      const perm = await requireGamePermission(socket, 'GAME_PAUSE');
      if (!perm.ok) {
        callback?.({ success: false, error: perm.error === 'NOT_IN_ROOM' ? 'NOT_IN_ROOM' : 'UNAUTHORIZED' });
        return;
      }
      const authorized = requireRoomRole(socket, 'HOST');
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
        return;
      }

      // Verify socket is in this room
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      // Protokollversion: explizit inkompatibel → VOR der Mutation ablehnen.
      const cmdCtx = resolveCommandContextForSocket(data, socket);
      if (!cmdCtx.ok && cmdCtx.error === 'CLIENT_VERSION_UNSUPPORTED') {
        callback?.({ success: false, error: 'CLIENT_VERSION_UNSUPPORTED' });
        return;
      }

      const gameHandler = getGameHandler(room.gameDefinition.slug);
      if (!gameHandler?.resume) {
        callback?.({ success: false, error: 'GAME_ACTION_UNSUPPORTED' });
        return;
      }

      const perform = () => new Promise<any>((resolve, reject) => {
        let done = false;
        gameHandler.resume!({
          io, socket, roomCode: room.code,
          callback: (res: any) => { if (!done) { done = true; if (res && res.success) resolve(res); else reject(new Error(res?.error ?? 'RESUME_FAILED')); } },
        }).catch(reject);
      });

      if (cmdCtx.ok && cmdCtx.ctx.commandMode) {
        try {
          const receipted = await runReceipted<any>(prisma, {
            roomId: room.id,
            commandId: cmdCtx.ctx.commandId!,
            actor: { actorId: identity.participationId ?? room.id, actorRole: perm.role },
            action: 'GAME_RESUME',
            payload: data,
            stateVersion: cmdCtx.ctx.envelope?.stateVersion,
            mutate: perform,
            toResponse: (d) => d,
          });
          if (receipted.success) callback?.({ success: true, ...(receipted.replayed ? { replayed: true } : {}) });
          else callback?.({ success: false, error: receipted.error, ...(receipted.replayed ? { replayed: true } : {}), ...('resyncRequired' in receipted && receipted.resyncRequired ? { resyncRequired: true } : {}) });
        } catch (error) {
          const e2 = wireErrorToAppError(gameErrorCode(error), { internalDetail: error, context: { socketId: socket.id } });
          logger.error('Game resume (receipted) error', { error });
          callback?.({ success: false, error: gameErrorCode(error), code: e2.code, messageKey: e2.messageKey, traceId: e2.traceId });
        }
        return;
      }

      const result = await perform();
      callback?.({ success: true, ...(typeof result === 'object' ? result : {}) });
    } catch (error) {
      logger.error('Game resume error', { error });
      const appError = wireErrorToAppError(gameErrorCode(error), { internalDetail: error, context: { socketId: socket.id } });
      callback?.({ success: false, error: gameErrorCode(error), code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
    }
  },

  async end(
    io: Server,
    socket: Socket,
    data: { roomCode: string; commandId?: string; requestId?: string; protocolVersion?: number },
    callback?: (result: any) => void
  ) {
    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      // P0-17: Use socket identity for authorization
      const identity = getSocketDataIdentity(socket);
      if (!identity.roomId || identity.roomId !== room.id) {
        callback?.({ success: false, error: 'NOT_IN_ROOM' });
        return;
      }

      // BASIS-STANDARDS: Permission-Guard (GAME_ABORT), aktuelle DB-Rechte.
      const perm = await requireGamePermission(socket, 'GAME_ABORT');
      if (!perm.ok) {
        callback?.({ success: false, error: perm.error === 'NOT_IN_ROOM' ? 'NOT_IN_ROOM' : 'UNAUTHORIZED' });
        return;
      }
      const authorized = requireRoomRole(socket, 'HOST');
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
        return;
      }

      // Verify socket is in this room
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
        return;
      }

      // Protokollversion: explizit inkompatibel → VOR der Mutation ablehnen.
      const cmdCtx = resolveCommandContextForSocket(data, socket);
      if (!cmdCtx.ok && cmdCtx.error === 'CLIENT_VERSION_UNSUPPORTED') {
        callback?.({ success: false, error: 'CLIENT_VERSION_UNSUPPORTED' });
        return;
      }

      const gameDefinition = await prisma.gameDefinition.findUnique({ where: { id: room.gameDefinitionId } });
      const handler = gameDefinition && getGameHandler(gameDefinition.slug);
      if (!handler) { callback?.({ success: false, error: 'UNSUPPORTED_GAME' }); return; }

      const perform = async () => {
        const result = await handler.end({ io, room });
        if (result.ended) handler.cleanup?.(room.id);
        return { ended: result.ended };
      };

      if (cmdCtx.ok && cmdCtx.ctx.commandMode) {
        try {
          const receipted = await runReceipted<any>(prisma, {
            roomId: room.id,
            commandId: cmdCtx.ctx.commandId!,
            actor: { actorId: identity.participationId ?? room.id, actorRole: perm.role },
            action: 'GAME_ABORT',
            payload: data,
            stateVersion: cmdCtx.ctx.envelope?.stateVersion,
            mutate: perform,
            toResponse: (d) => d,
          });
          if (receipted.success) callback?.({ success: true, ...(receipted.replayed ? { replayed: true } : {}) });
          else callback?.({ success: false, error: receipted.error, ...(receipted.replayed ? { replayed: true } : {}), ...('resyncRequired' in receipted && receipted.resyncRequired ? { resyncRequired: true } : {}) });
        } catch (error) {
          const e2 = wireErrorToAppError(gameErrorCode(error), { internalDetail: error, context: { socketId: socket.id } });
          logger.error('Game end (receipted) error', { error });
          callback?.({ success: false, error: gameErrorCode(error), code: e2.code, messageKey: e2.messageKey, traceId: e2.traceId });
        }
        return;
      }

      await perform();
      callback?.({ success: true });
    } catch (error) {
      logger.error('Game end error', { error });
      const appError = wireErrorToAppError(gameErrorCode(error), { internalDetail: error, context: { socketId: socket.id } });
      callback?.({ success: false, error: gameErrorCode(error), code: appError.code, messageKey: appError.messageKey, traceId: appError.traceId });
    }
  },
};
