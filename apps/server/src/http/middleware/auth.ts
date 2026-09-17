// ============================================================
// Server-side authorization helpers - v0.2.1
// Centralized role/room checks for socket and HTTP handlers.
// ============================================================

import type { Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';

export type Role = 'MODERATOR' | 'PLAYER' | 'VIEWER';

export interface SocketIdentity {
  socketId: string;
  userId?: string;          // for authenticated (moderator)
  participationId?: string; // for players
  viewerSessionId?: string; // for viewers
  role: Role;
  roomId?: string;
}

/**
 * Map from socket.id -> identity (populated on subscribe)
 */
export const socketIdentityMap = new Map<string, SocketIdentity>();

/**
 * Get the identity for a given socket.
 */
export function getSocketIdentity(socket: Socket): SocketIdentity | null {
  return socketIdentityMap.get(socket.id) ?? null;
}

/**
 * Check if the socket has the required role in the given room.
 */
export async function requireRoomRole(
  socket: Socket,
  roomId: string,
  requiredRole: Role
): Promise<boolean> {
  const identity = getSocketIdentity(socket);
  if (!identity) {
    logger.warn('requireRoomRole: no identity', { socketId: socket.id });
    return false;
  }
  if (identity.roomId !== roomId) {
    logger.warn('requireRoomRole: wrong room', { socketId: socket.id, identityRoom: identity.roomId, requestedRoom: roomId });
    return false;
  }
  if (identity.role !== requiredRole && !(requiredRole === 'VIEWER' && identity.role === 'PLAYER')) {
    logger.warn('requireRoomRole: insufficient role', { socketId: socket.id, has: identity.role, needs: requiredRole });
    return false;
  }
  return true;
}

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
