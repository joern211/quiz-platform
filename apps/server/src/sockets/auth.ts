// ============================================================
// Socket Authorization Helpers (sockets layer)
// ============================================================
// Uses the socketIdentityMap from http/middleware/auth.ts
// This module provides convenience wrappers for socket handlers

import { Socket } from 'socket.io';
import { getSocketIdentity, requireRoomRole as checkRole } from '../http/middleware/auth.js';
import { logger } from '../observability/logger.js';

// Re-export for convenience in socket handlers
export { getSocketIdentity } from '../http/middleware/auth.js';
export { requireRoomRole as checkRole } from '../http/middleware/auth.js';

/**
 * Get socket identity from socket.data (alternative to socketIdentityMap)
 * Returns identity data stored during room subscription
 */
export function getSocketDataIdentity(socket: Socket): {
  participationId?: string;
  roomId?: string;
  role?: string;
  displayName?: string;
} {
  return {
    participationId: socket.data.participationId,
    roomId: socket.data.roomId,
    role: socket.data.role,
    displayName: socket.data.displayName,
  };
}

/**
 * Require room role with callback pattern for socket handlers
 * Checks socket.data.role >= requiredRole (using role hierarchy)
 */
export function requireRoomRole(
  socket: Socket,
  requiredRole: string,
  callback?: (result: { success: boolean; error?: string }) => void
): boolean {
  const identity = getSocketDataIdentity(socket);
  
  if (!identity || !identity.role) {
    const error = 'NOT_AUTHENTICATED';
    logger.warn('requireRoomRole: no identity', { socketId: socket.id, requiredRole });
    callback?.({ success: false, error });
    return false;
  }

  // Role hierarchy: MODERATOR > PLAYER > VIEWER
  const ROLE_LEVELS: Record<string, number> = {
    MODERATOR: 3,
    PLAYER: 2,
    VIEWER: 1,
  };

  const socketRoleLevel = ROLE_LEVELS[identity.role] || 0;
  const requiredLevel = ROLE_LEVELS[requiredRole] || 0;

  if (socketRoleLevel < requiredLevel) {
    const error = 'INSUFFICIENT_ROLE';
    logger.warn('requireRoomRole: insufficient role', {
      socketId: socket.id,
      has: identity.role,
      required: requiredRole,
    });
    callback?.({ success: false, error });
    return false;
  }

  return true;
}

/**
 * Check if socket has a valid participation
 */
export function requireParticipation(
  socket: Socket,
  callback?: (result: { success: boolean; error?: string }) => void
): boolean {
  const identity = getSocketDataIdentity(socket);

  if (!identity || !identity.participationId) {
    const error = 'NO_PARTICIPATION';
    logger.warn('requireParticipation: no participation', { socketId: socket.id });
    callback?.({ success: false, error });
    return false;
  }

  return true;
}

/**
 * Authorize a room action: check role AND room match
 */
export async function authorizeRoomAction(
  socket: Socket,
  roomCode: string,
  requiredRole: string
): Promise<{ authorized: boolean; error?: string; roomId?: string }> {
  const identity = getSocketDataIdentity(socket);

  if (!identity || !identity.participationId) {
    return { authorized: false, error: 'NOT_AUTHENTICATED' };
  }

  if (!identity.roomId) {
    return { authorized: false, error: 'NOT_IN_ROOM' };
  }

  // Verify socket is in the correct room
  const isInRoom = socket.rooms.has(roomCode);
  if (!isInRoom) {
    logger.warn('authorizeRoomAction: socket not in room', {
      socketId: socket.id,
      expectedRoom: roomCode,
      socketRooms: Array.from(socket.rooms),
    });
    return { authorized: false, error: 'WRONG_ROOM' };
  }

  // Role hierarchy
  const ROLE_LEVELS: Record<string, number> = {
    MODERATOR: 3,
    PLAYER: 2,
    VIEWER: 1,
  };

  const socketRoleLevel = ROLE_LEVELS[identity.role || ''] || 0;
  const requiredLevel = ROLE_LEVELS[requiredRole] || 0;

  if (socketRoleLevel < requiredLevel) {
    return { authorized: false, error: 'INSUFFICIENT_ROLE' };
  }

  return { authorized: true, roomId: identity.roomId };
}
