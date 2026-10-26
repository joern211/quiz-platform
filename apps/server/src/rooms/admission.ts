import type { Server } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { roomChannel, roomWaitingChannel } from '../sockets/channel.js';

/** Promote only the current connection, after admission committed. */
export async function promoteAdmittedSockets(io: Server, roomId: string, participantId: string) {
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true } });
  const participant = await prisma.participation.findFirst({ where: {
    id: participantId, roomId, admission: 'ACTIVE', connected: true, leftAt: null, kickedAt: null, bannedAt: null,
  } });
  if (!participant?.connectionId) return;
  const socket = io.sockets.sockets.get(participant.connectionId);
  if (!socket || socket.data.roomId !== roomId || socket.data.participationId !== participantId) return;
  await socket.leave(roomWaitingChannel(roomId));
  await socket.join(roomChannel(roomId));
  socket.emit('room:admission', { admission: 'ACTIVE', status: room.status, gameSlug: room.gameDefinition.slug });
}
