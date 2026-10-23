// ============================================================
// Shared Game Authorization
// Exact role + room membership checks for game actions.
// ============================================================

import type { Socket } from 'socket.io';
import { getSocketDataIdentity } from '../../sockets/auth.js';
import { roomChannel } from '../../sockets/channel.js';
import { prisma } from '../../persistence/prisma.js';
import { resolveCanonicalSlug } from '@quiz/shared';
import type { GamePermission } from '@quiz/shared';
import { requireGamePermission } from './permissions.js';
import type { GameDefinition, Room } from '@prisma/client';

export type GameRole = 'HOST' | 'PLAYER' | 'VIEWER';

export interface GameActor {
  roomId: string;
  participationId?: string;
  role: GameRole;
  displayName?: string;
}

export type GameAuthorizationResult =
  | { ok: true; actor: GameActor }
  | { ok: false; error: 'NOT_IN_ROOM' | 'FORBIDDEN' | 'NO_PARTICIPATION' };

export function authorizeGameAction(
  socket: Socket,
  options: {
    roles: readonly GameRole[];
    requireParticipation?: boolean;
  }
): GameAuthorizationResult {
  const identity = getSocketDataIdentity(socket);

  if (!identity.roomId || !identity.role) {
    return { ok: false, error: 'NOT_IN_ROOM' };
  }

  if (!socket.rooms.has(roomChannel(identity.roomId))) {
    return { ok: false, error: 'NOT_IN_ROOM' };
  }

  if (!options.roles.includes(identity.role as GameRole)) {
    return { ok: false, error: 'FORBIDDEN' };
  }

  if (options.requireParticipation && !identity.participationId) {
    return { ok: false, error: 'NO_PARTICIPATION' };
  }

  return {
    ok: true,
    actor: {
      roomId: identity.roomId,
      participationId: identity.participationId,
      role: identity.role as GameRole,
      displayName: identity.displayName,
    },
  };
}

/** Resolve the actor and its game from server state for a game-owned handler. */
export async function authorizeGameContext(
  socket: Socket,
  options: {
    roles: readonly GameRole[];
    gameSlug: string;
    requireParticipation?: boolean;
    requireRunning?: boolean;
    controlPermission?: GamePermission;
  }
): Promise<
  | { ok: true; actor: GameActor; room: Room & { gameDefinition: GameDefinition } }
  | { ok: false; error: 'NOT_IN_ROOM' | 'FORBIDDEN' | 'NO_PARTICIPATION' | 'ROOM_NOT_FOUND' | 'WRONG_GAME' | 'GAME_NOT_RUNNING' }
> {
  let auth = authorizeGameAction(socket, options);
  if (!auth.ok && options.controlPermission) {
    const permission = await requireGamePermission(socket, options.controlPermission);
    if (permission.ok) auth = authorizeGameAction(socket, { ...options, roles: ['HOST', 'PLAYER', 'VIEWER'] });
  }
  if (!auth.ok) return auth;
  const room = await prisma.room.findUnique({
    where: { id: auth.actor.roomId }, include: { gameDefinition: true },
  });
  if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
  // Slug-Vergleich über die kanonische Identität (Regelwerk §5.23): Räume,
  // die noch einen Legacy-Slug tragen (Migration fehlgeschlagen / übersprungen),
  // werden weiterhin korrekt autorisiert — Legacy und Engine-Slug werden auf
  // dieselbe kanonische Form normalisiert.
  const roomSlug = resolveCanonicalSlug(room.gameDefinition.slug) ?? room.gameDefinition.slug;
  const expectedSlug = resolveCanonicalSlug(options.gameSlug) ?? options.gameSlug;
  if (roomSlug !== expectedSlug) return { ok: false, error: 'WRONG_GAME' };
  if (options.requireRunning && room.status !== 'RUNNING') {
    return { ok: false, error: 'GAME_NOT_RUNNING' };
  }
  if (options.requireParticipation && auth.actor.role !== 'VIEWER') {
    const participant = await prisma.participation.findFirst({
      where: {
        id: auth.actor.participationId, roomId: room.id,
        role: auth.actor.role, connected: true, kickedAt: null, bannedAt: null, leftAt: null, admission: 'ACTIVE', connectionId: socket.id,
      }, select: { id: true },
    });
    if (!participant) return { ok: false, error: 'NO_PARTICIPATION' };
  }
  return { ...auth, room };
}

// ============================================================
// BASIS-STANDARDS: gemeinsamer Guard = Rolle (bestehende Engine-Grenze)
// + wirksames Recht (Permission-Vertrag, aktuelle DB-Rechte).
// ============================================================

export type GamePermissionGuardResult =
  | { ok: true; permission: GamePermission }
  | { ok: false; error: 'NOT_IN_ROOM' | 'NO_PARTICIPATION' | 'FORBIDDEN' };

/**
 * Prüft die Engine-Rolle (bestehende Grenze) UND das erforderliche
 * Recht aus dem Permission-Vertrag (§2.3). Grants/Revocations wirken
 * sofort (DB-Auslese pro Aktion) — auch für bereits verbundene Sockets.
 */
export async function authorizeGameActionWithPermission(
  socket: Socket,
  options: {
    roles: readonly GameRole[];
    permission: GamePermission;
    requireParticipation?: boolean;
  },
): Promise<GamePermissionGuardResult> {
  const base = authorizeGameAction(socket, { roles: options.roles, requireParticipation: options.requireParticipation });
  if (!base.ok) return { ok: false, error: base.error };
  const perm = await requireGamePermission(socket, options.permission);
  if (!perm.ok) return { ok: false, error: perm.error === 'NOT_IN_ROOM' ? 'NOT_IN_ROOM' : 'FORBIDDEN' };
  return { ok: true, permission: options.permission };
}
