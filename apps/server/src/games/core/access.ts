// ============================================================
// Shared Game Authorization
// Exact role + room membership checks for game actions.
// ============================================================

import type { Socket } from 'socket.io';
import { getSocketDataIdentity } from '../../sockets/auth.js';
import { roomChannel } from '../../sockets/channel.js';

export type GameRole = 'MODERATOR' | 'PLAYER' | 'VIEWER';

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
