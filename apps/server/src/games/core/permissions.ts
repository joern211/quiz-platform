// ============================================================
// Permission Core (BASIS-STANDARDS, Master §2.2/§2.3)
// ============================================================
// Gemeinsame Berechtigungsprüfung für kritische Aktionen.
//
// Wirksame Rechte werden pro Aktion aus der DB berechnet:
//   Defaultpaket(Rolle) ± Grants/Revocations (room_permission_grants).
// Eine Revocation wirkt also SOFORT, auch für bereits verbundene
// Sockets — es wird nie eine gecachte Rolle allein vertraut.
//
// Verwaltungs- und Secret-Rechte sind getrennt: ein Grant für genau
// ein Recht (z.B. GAME_PAUSE) verleiht weder JUDGE_ANSWER noch
// REVEAL_CONTENT. Secret-Informationen (Antworten, Lösungen) werden
// zusätzlich projektionsseitig nur an berechtigte Rollen verteilt —
// dieser Core liefert die Berechtigung, die Projektionen nutzen sie.
// ============================================================

import { prisma } from '../../persistence/prisma.js';
import { getSocketDataIdentity } from '../../sockets/auth.js';
import { getSocketIdentity } from '../../http/middleware/auth.js';
import {
  effectivePermissions,
  normalizeRole,
  hasPermission,
  type GamePermission,
  type PlatformRole,
} from '@quiz/shared';
import type { Socket } from 'socket.io';
import { roomWaitingChannel } from '../../sockets/channel.js';

export type PermissionCheckResult =
  | { ok: true; roomId: string; actorId: string; role: PlatformRole }
  | {
      ok: false;
      error: 'NOT_IN_ROOM' | 'ROLE_REQUIRED' | 'NOT_AUTHORIZED';
      code: 'NOT_AUTHENTICATED' | 'ROLE_REQUIRED' | 'NOT_AUTHORIZED';
    };

export interface EffectivePermissionContext {
  roomId: string;
  role: PlatformRole;
  /** userId für Grants (nur eingeloggte Nutzer), sonst null. */
  userId: string | null;
  /** Participation-Id (Spielteilnahme) als Akteurs-Kontext. */
  participationId: string | null;
}

/**
 * Lädt wirksame Rechte eines Akteurs im Raum aus der DB (aktuelle Quelle).
 * Grants/Revocations gelten nur für eingeloggte Nutzer (userId).
 */
export async function loadEffectivePermissions(
  roomId: string,
  role: PlatformRole,
  userId: string | null,
): Promise<Set<GamePermission>> {
  let grants: readonly GamePermission[] = [];
  let revocations: readonly GamePermission[] = [];
  if (userId) {
    const rows = await prisma.roomPermissionGrant.findMany({
      where: { roomId, userId, revokedAt: null },
      select: { permission: true, direction: true },
    });
    for (const r of rows) {
      const p = r.permission as GamePermission;
      if (r.direction === 'GRANT') grants = [...grants, p];
      else if (r.direction === 'REVOKE') revocations = [...revocations, p];
    }
  }
  return effectivePermissions(role, grants, revocations);
}

/**
 * Haupt-Guard: prüft Raumzugehörigkeit + aktuelle Berechtigung serverseitig.
 * `permission` ist das für die Aktion erforderliche Recht (Master §2.3).
 * Client-behaftete Rollen werden nicht verwendet — die Rolle stammt aus der
 * serverseitig aufgelösten Socket-Identität; Grants/Revocations aus der DB.
 */
export async function requireGamePermission(
  socket: Socket,
  permission: GamePermission,
): Promise<PermissionCheckResult> {
  if (getSocketIdentity(socket)?.role === 'DISPLAY') return { ok: false, error: 'NOT_AUTHORIZED', code: 'NOT_AUTHORIZED' };
  const data = getSocketDataIdentity(socket);
  const identity = getSocketIdentity(socket);
  const roomId = identity?.roomId ?? data.roomId;
  if (!roomId) {
    return { ok: false, error: 'NOT_IN_ROOM', code: 'NOT_AUTHENTICATED' };
  }
  const rawRole = identity?.role ?? data.role;
  const role = normalizeRole(rawRole);
  if (!role) {
    // Unbekannte Rolle: keine Rechte, kein Cast.
    return { ok: false, error: 'ROLE_REQUIRED', code: 'ROLE_REQUIRED' };
  }
  if (socket.rooms.has(roomWaitingChannel(roomId))) return { ok: false, error: 'NOT_AUTHORIZED', code: 'NOT_AUTHORIZED' };
  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room || room.status === 'ARCHIVED' || (room.expiresAt && room.expiresAt <= new Date())) return { ok: false, error: 'NOT_IN_ROOM', code: 'NOT_AUTHENTICATED' };
  let userId = identity?.userId ?? null;
  const authenticated = (socket as Socket & { user?: { id: string; sessionId?: string } }).user;
  if (userId && authenticated?.sessionId) {
    const valid = await prisma.session.findFirst({ where: { id: authenticated.sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } } });
    if (!valid) userId = null;
  }
  const owner = !!userId && userId === room.hostUserId;
  const effectiveRole = owner ? 'HOST' : role === 'HOST' ? 'VIEWER' : role;
  const cohost = room.roomPolicyJson ? JSON.parse(room.roomPolicyJson).coHostEnabled === true : true;
  const perms = await loadEffectivePermissions(roomId, effectiveRole, owner || cohost ? userId : null);
  if (!hasPermission(perms, permission)) {
    return { ok: false, error: 'NOT_AUTHORIZED', code: 'NOT_AUTHORIZED' };
  }
  return { ok: true, roomId, actorId: data.participationId ?? identity?.participationId ?? roomId, role };
}
