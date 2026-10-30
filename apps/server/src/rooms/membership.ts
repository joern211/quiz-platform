import type { Socket } from 'socket.io';
import { normalizeRole } from '@quiz/shared';
import { prisma } from '../persistence/prisma.js';
import { getSocketIdentity } from '../http/middleware/auth.js';
import { roomChannel, roomWaitingChannel } from '../sockets/channel.js';

/** Revalidate presence and authentication before reads, writes and receipt replay. */
export async function currentSocketMembership(socket: Socket, allowPending = false): Promise<{
  userId: string | null; pending: boolean;
} | null> {
  const identity = getSocketIdentity(socket) ?? socket.data;
  const { roomId, participationId, role } = identity;
  if (!roomId || !participationId || !normalizeRole(role)) return null;
  if (socket.data.roomId !== roomId || socket.data.participationId !== participationId || socket.data.role !== role) return null;
  if (!(socket.rooms.has(roomChannel(roomId)) || allowPending && socket.rooms.has(roomWaitingChannel(roomId)))) return null;
  if (role === 'DISPLAY') {
    if (!participationId.startsWith('display:')) return null;
    const display = await prisma.displaySession.findFirst({ where: {
      id: participationId.slice(8), roomId, connected: true, expiresAt: { gt: new Date() },
    } });
    return display ? { userId: null, pending: false } : null;
  }
  const user = (socket as Socket & { user?: { id: string; sessionId?: string } }).user;
  let userId: string | null = null;
  if (user?.id) {
    if (!user.sessionId) return null;
    const session = await prisma.session.findFirst({ where: {
      id: user.sessionId, userId: user.id, revokedAt: null,
      expiresAt: { gt: new Date() }, user: { disabledAt: null },
    } });
    if (!session) return null;
    userId = user.id;
  }
  if (participationId.startsWith('viewer:')) {
    if (role !== 'VIEWER') return null;
    const viewer = await prisma.viewerSession.findFirst({ where: { id: participationId.slice(7), roomId, connected: true } });
    return viewer ? { userId, pending: false } : null;
  }
  const participant = await prisma.participation.findFirst({ where: {
    id: participationId, roomId, connectionId: socket.id, connected: true,
    kickedAt: null, bannedAt: null, leftAt: null,
  } });
  if (!participant || normalizeRole(participant.role) !== normalizeRole(role) || participant.userId && participant.userId !== userId) return null;
  const pending = participant.admission !== 'ACTIVE';
  if (pending && !allowPending) return null;
  return { userId, pending };
}
