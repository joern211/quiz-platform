// ============================================================
// Server-side authorization helpers - v0.3.0
// Phase 3: 7-Punkt-Autorisierungssequenz inkl. Raumkanal-Isolation
// ============================================================

import type { Socket } from 'socket.io';
import { z } from 'zod';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';

export type Role = 'MODERATOR' | 'PLAYER' | 'VIEWER';

/** Room run phases used for phase-based authorization */
export type RunPhase =
  | 'OPEN'      // Lobby offen
  | 'LOCKED'    // Lobby gesperrt
  | 'INTRO'     // Spiel-Einführung
  | 'PROMPT'    // Fragenvorbereitung
  | 'ROUND_ACTIVE'  // Runde aktiv (Antworten möglich)
  | 'INPUT_LOCKED'  // Eingabe gesperrt
  | 'PAUSED'    // Pausiert
  | 'REVEAL'    // Auflösung
  | 'ROUND_LOCKED'  // Runde abgeschlossen
  | 'RESULTS';  // Endergebnis

/** Room status */
export type RoomStatus = 'LOBBY' | 'RUNNING' | 'ENDED';

/** 7-Punkt-Autorisierungsprüfung: Ergebnis einzelner Checks */
export interface AuthCheckResult {
  /** true wenn Check bestanden */
  passed: boolean;
  /** Fehlercode bei Misserfolg */
  errorCode?: string;
  /** Kontext für Logging/Fehlermeldung */
  context?: Record<string, unknown>;
}

/** Ergebnis der 7-Punkt-Autorisierung */
export interface AuthorizationResult {
  /** true wenn alle 7 Prüfungen bestanden */
  authorized: boolean;
  /** Fehlercode des ersten fehlgeschlagenen Checks */
  errorCode?: string;
  /** Nummer des fehlgeschlagenen Check (1-7) oder undefined */
  failedCheck?: number;
  /** Kontext für Logging/Fehlermeldung */
  context?: Record<string, unknown>;
}

/**
 * Map from socket.id -> identity (populated on subscribe)
 */
export const socketIdentityMap = new Map<string, SocketIdentity>();

export interface SocketIdentity {
  socketId: string;
  userId?: string;          // for authenticated (moderator)
  participationId?: string; // for players
  viewerSessionId?: string; // for viewers
  role: Role;
  roomId?: string;
}

/**
 * Get the identity for a given socket.
 */
export function getSocketIdentity(socket: Socket): SocketIdentity | null {
  return socketIdentityMap.get(socket.id) ?? null;
}

// ============================================================
// 7-Punkt-Autorisierungssequenz
// ============================================================

/**
 * P1: Socket besitzt validierte Identität (identityMap check)
 * Prüft ob der Socket eine gültige Identity in der identityMap hat.
 */
export function checkIdentity(socket: Socket): AuthCheckResult {
  const identity = socketIdentityMap.get(socket.id);
  if (!identity) {
    logger.warn('[AUTH P1] Keine Identity in identityMap', { socketId: socket.id });
    return { passed: false, errorCode: 'NO_IDENTITY', context: { socketId: socket.id } };
  }
  return { passed: true };
}

/**
 * P2: Identität gehört zum angefragten Raum (roomId check)
 * Prüft ob die Identity des Sockets zum angefragten roomId gehört.
 */
export function checkIdentityRoom(identity: SocketIdentity, roomId: string): AuthCheckResult {
  if (identity.roomId !== roomId) {
    logger.warn('[AUTH P2] Identity gehört nicht zum Raum', {
      socketId: identity.socketId,
      identityRoomId: identity.roomId ?? '(none)',
      requestedRoomId: roomId,
    });
    return {
      passed: false,
      errorCode: 'WRONG_ROOM',
      context: { identityRoomId: identity.roomId, requestedRoomId: roomId },
    };
  }
  return { passed: true };
}

/**
 * P3: Socket ist im internen Raumkanal (socket.rooms check)
 * Prüft ob der Socket dem internen Kanal `room:<roomId>` beigetreten ist.
 * Das ist die Raumkanal-Isolation: nur authentifizierte Sockets,
 * die auch socket.join(roomChannel(roomId)) aufgerufen haben, sind im Kanal.
 */
export function checkRoomChannel(socket: Socket, roomId: string): AuthCheckResult {
  const channelName = `room:${roomId}`;
  if (!socket.rooms.has(channelName)) {
    logger.warn('[AUTH P3] Socket nicht im Raumkanal', {
      socketId: socket.id,
      roomId,
      channelName,
      socketRooms: [...socket.rooms],
    });
    return {
      passed: false,
      errorCode: 'NOT_IN_ROOM_CHANNEL',
      context: {
        roomId,
        channelName,
        socketRooms: [...socket.rooms],
      },
    };
  }
  return { passed: true };
}

/**
 * P4: Rolle genügt der Aktion (MODERATOR/PLAYER/VIEWER check)
 * Prüft ob die Rolle des Sockets für die angeforderte Aktion ausreicht.
 * Rollenhierarchie: MODERATOR > PLAYER > VIEWER
 */
export function checkRole(identity: SocketIdentity, requiredRole: Role): AuthCheckResult {
  const roleHierarchy: Record<Role, number> = {
    MODERATOR: 3,
    PLAYER: 2,
    VIEWER: 1,
  };

  const hasLevel = roleHierarchy[identity.role] ?? 0;
  const needsLevel = roleHierarchy[requiredRole] ?? 99;

  if (hasLevel < needsLevel) {
    logger.warn('[AUTH P4] Unzureichende Rolle', {
      socketId: identity.socketId,
      hasRole: identity.role,
      needsRole: requiredRole,
    });
    return {
      passed: false,
      errorCode: 'INSUFFICIENT_ROLE',
      context: { hasRole: identity.role, needsRole: requiredRole },
    };
  }
  return { passed: true };
}

/**
 * P5: Raumstatus erlaubt die Aktion (LOBBY/PLAYING/ENDED)
 * Prüft ob der Raumstatus die angeforderte Aktion erlaubt.
 */
export async function checkRoomStatus(
  roomId: string,
  requiredStatuses: RoomStatus[]
): Promise<AuthCheckResult> {
  if (requiredStatuses.length === 0) {
    return { passed: true };
  }

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { status: true },
  });

  if (!room) {
    logger.warn('[AUTH P5] Raum nicht gefunden', { roomId });
    return { passed: false, errorCode: 'ROOM_NOT_FOUND', context: { roomId } };
  }

  if (!requiredStatuses.includes(room.status as RoomStatus)) {
    logger.warn('[AUTH P5] Raumstatus erlaubt Aktion nicht', {
      roomId,
      currentStatus: room.status,
      requiredStatuses,
    });
    return {
      passed: false,
      errorCode: 'ROOM_STATUS_FORBIDDEN',
      context: { currentStatus: room.status, requiredStatuses },
    };
  }
  return { passed: true };
}

/**
 * P6: Spielphase erlaubt die Aktion
 * Prüft ob die aktuelle Spielphase die angeforderte Aktion erlaubt.
 */
export async function checkGamePhase(
  roomId: string,
  requiredPhases: RunPhase[]
): Promise<AuthCheckResult> {
  if (requiredPhases.length === 0) {
    return { passed: true };
  }

  const gameState = await prisma.roomGameState.findUnique({
    where: { roomId },
    select: { phase: true },
  });

  // Kein GameState = Spiel noch nicht gestartet
  if (!gameState) {
    logger.warn('[AUTH P6] Kein GameState vorhanden', { roomId });
    return {
      passed: false,
      errorCode: 'GAME_NOT_STARTED',
      context: { roomId, requiredPhases },
    };
  }

  if (!requiredPhases.includes(gameState.phase as RunPhase)) {
    logger.warn('[AUTH P6] Spielphase erlaubt Aktion nicht', {
      roomId,
      currentPhase: gameState.phase,
      requiredPhases,
    });
    return {
      passed: false,
      errorCode: 'GAME_PHASE_FORBIDDEN',
      context: { currentPhase: gameState.phase, requiredPhases },
    };
  }
  return { passed: true };
}

/**
 * P7: Payload wurde validiert (Zod)
 * Führt eine Zod-Schema-Validierung des Payloads durch.
 */
export function checkPayload<T extends z.ZodTypeAny>(
  payload: unknown,
  schema: T,
  actionName = 'action'
): AuthCheckResult {
  const result = schema.safeParse(payload);

  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    logger.warn(`[AUTH P7] Payload-Validierung fehlgeschlagen`, {
      action: actionName,
      issues,
    });
    return {
      passed: false,
      errorCode: 'PAYLOAD_INVALID',
      context: { issues },
    };
  }
  return { passed: true };
}

// ============================================================
// Konfigurations-Typen für requireRoomRole
// ============================================================

export interface RoleCheckConfig {
  /** Erforderliche Rolle (MODERATOR, PLAYER, VIEWER) */
  role: Role;
  /** Erlaubte Raum-Status (leer = alle) */
  allowedRoomStatuses?: RoomStatus[];
  /** Erlaubte Spielphasen (leer = alle) */
  allowedGamePhases?: RunPhase[];
  /** Zod-Schema zur Payload-Validierung (optional) */
  payloadSchema?: z.ZodTypeAny;
  /** Name der Aktion für Logging */
  actionName?: string;
}

/**
 * 7-Punkt-Autorisierungssequenz vollständig durchführen.
 *
 * Prüft:
 *  1. Socket hat validierte Identität (identityMap)
 *  2. Identity gehört zum angefragten Raum (roomId)
 *  3. Socket ist im internen Raumkanal (socket.rooms)
 *  4. Rolle genügt der Aktion (MODERATOR/PLAYER/VIEWER)
 *  5. Raumstatus erlaubt die Aktion (LOBBY/RUNNING/ENDED)
 *  6. Spielphase erlaubt die Aktion
 *  7. Payload wurde validiert (Zod)
 *
 * Keine silent failures: Bei jedem Check-Fehler wird geloggt
 * und der passende errorCode zurückgegeben.
 *
 * @param socket        Der Socket des Clients
 * @param roomId        Interne Raum-ID (UUID)
 * @param config        Autorisierungskonfiguration
 * @param payload       Payload zur Zod-Validierung (optional)
 * @returns AuthorizationResult mit authorized/Fehlerdetails
 */
export async function requireRoomRole(
  socket: Socket,
  roomId: string,
  config: RoleCheckConfig,
  payload?: unknown
): Promise<AuthorizationResult> {
  const { role, allowedRoomStatuses, allowedGamePhases, payloadSchema, actionName } = config;

  // --- P1: Identität in identityMap ---
  const p1 = checkIdentity(socket);
  if (!p1.passed) {
    return { authorized: false, errorCode: p1.errorCode, failedCheck: 1, context: p1.context };
  }
  const identity = socketIdentityMap.get(socket.id)!;

  // --- P2: Identity gehört zum Raum ---
  const p2 = checkIdentityRoom(identity, roomId);
  if (!p2.passed) {
    return { authorized: false, errorCode: p2.errorCode, failedCheck: 2, context: p2.context };
  }

  // --- P3: Socket ist im internen Raumkanal ---
  const p3 = checkRoomChannel(socket, roomId);
  if (!p3.passed) {
    return { authorized: false, errorCode: p3.errorCode, failedCheck: 3, context: p3.context };
  }

  // --- P4: Rolle prüfen ---
  const p4 = checkRole(identity, role);
  if (!p4.passed) {
    return { authorized: false, errorCode: p4.errorCode, failedCheck: 4, context: p4.context };
  }

  // --- P5: Raumstatus prüfen ---
  if (allowedRoomStatuses && allowedRoomStatuses.length > 0) {
    const p5 = await checkRoomStatus(roomId, allowedRoomStatuses);
    if (!p5.passed) {
      return { authorized: false, errorCode: p5.errorCode, failedCheck: 5, context: p5.context };
    }
  }

  // --- P6: Spielphase prüfen ---
  if (allowedGamePhases && allowedGamePhases.length > 0) {
    const p6 = await checkGamePhase(roomId, allowedGamePhases);
    if (!p6.passed) {
      return { authorized: false, errorCode: p6.errorCode, failedCheck: 6, context: p6.context };
    }
  }

  // --- P7: Payload-Validierung ---
  if (payloadSchema !== undefined) {
    const p7 = checkPayload(payload, payloadSchema, actionName);
    if (!p7.passed) {
      return { authorized: false, errorCode: p7.errorCode, failedCheck: 7, context: p7.context };
    }
  }

  logger.debug(`[AUTH] Authorization granted`, {
    socketId: socket.id,
    action: actionName ?? 'unknown',
    role,
    roomId,
  });

  return { authorized: true };
}

/** Alias für requireRoomRole (expliziter Name für neue 7-Punkt-Sequenz) */
export const requireRoomRoleFull = requireRoomRole;

/**
 * Bestehende Signatur: Prüft Rolle + Zugehörigkeit (P1/P2/P4).
 * Gibt boolean zurück für Abwärtskompatibilität mit bestehenden Callern.
 *
 * Nutze requireRoomRole() für neue Handler mit vollständiger 7-Punkt-Prüfung.
 */
export async function requireRoomRoleBoolean(
  socket: Socket,
  roomId: string,
  requiredRole: Role
): Promise<boolean> {
  const result = await requireRoomRole(socket, roomId, { role: requiredRole });
  return result.authorized;
}

/**
 * Prüft ob der Socket dem internen Raumkanal `room:<roomId>` beigetreten ist.
 * Das ist die Socket.IO Channel-Isolation: nur Sockets die socket.join(roomChannel(id))
 * aufgerufen haben, sind in diesem Set.
 *
 * @example
 * const result = checkRoomChannel(socket, room.id);
 * if (!result.passed) {
 *   socket.emit('error', { code: result.errorCode, context: result.context });
 *   return;
 * }
 */

/**
 * Get the internal room ID from a public room code.
 */
export async function resolveRoomId(code: string): Promise<string | null> {
  const room = await prisma.room.findUnique({ where: { code } });
  return room?.id ?? null;
}

/**
 * Check that a join request's rejoinToken belongs to this room.
 */
export async function validateRejoinToken(
  roomId: string,
  rejoinToken: string,
  participationId: string
): Promise<boolean> {
  const p = await prisma.participation.findFirst({
    where: { id: participationId, roomId, rejoinToken },
  });
  return !!p;
}
