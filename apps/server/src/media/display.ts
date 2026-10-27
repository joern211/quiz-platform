import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { prisma } from '../persistence/prisma.js';
import { config } from '../config/index.js';
import { socketRoomActor } from '../rooms/socket.js';
import { assertRoomLive, RoomError } from '../rooms/core.js';
import { socketIdentityMap } from '../http/middleware/auth.js';
import { roomChannel } from '../sockets/channel.js';
import { handleDisconnect } from '../sockets/lobby.js';
const signature = (roomId: string, payload: string) => createHmac('sha256', config.sessionSecret).update(`display:${roomId}:${payload}`).digest('hex');
export function displayToken(roomId: string) { const payload = `${Date.now() + 12 * 3600000}.${randomUUID()}`; return `${payload}.${signature(roomId, payload)}`; }
export function verifyDisplayToken(roomId: string, token: string): number | null {
  const pieces = token.split('.'); if (pieces.length !== 3 || !/^\d+$/.test(pieces[0]) || !/^[a-f0-9]{64}$/.test(pieces[2])) return null;
  const expires = Number(pieces[0]); if (expires <= Date.now() || expires > Date.now() + 12 * 3600000) return null;
  const expected = signature(roomId, `${pieces[0]}.${pieces[1]}`); return timingSafeEqual(Buffer.from(expected), Buffer.from(pieces[2])) ? expires : null;
}
export function registerDisplay(io: Server, socket: Socket) {
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  socket.once('disconnect', () => clearTimeout(expiryTimer));
  socket.on('media:display-link', async (_raw, ack) => {
    try {
      const { roomId, actor } = await socketRoomActor(socket); if (!actor.permissions.has('PLAYER_MANAGE')) throw new RoomError('NOT_AUTHORIZED');
      const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } }); assertRoomLive(room);
      const token = displayToken(roomId);
      await prisma.auditLog.create({ data: { userId: actor.userId, action: 'DISPLAY_LINK', resource: 'ROOM', resourceId: roomId } });
      ack?.({ success: true, data: { path: `/raum/${room.code}/broadcast#${token}` } });
    } catch (error) { ack?.({ success: false, error: error instanceof RoomError ? error.code : 'DISPLAY_UNAVAILABLE' }); }
  });
  socket.on('room:display:subscribe', async (raw, ack) => {
    try {
      const input = z.object({ roomCode: z.string().regex(/^\d{3}-\d{3}$/), token: z.string().max(256) }).strict().parse(raw);
      const room = await prisma.room.findUnique({ where: { code: input.roomCode }, include: { gameDefinition: true, participations: { where: { role: 'PLAYER', admission: 'ACTIVE', bannedAt: null, leftAt: null, kickedAt: null } } } });
      if (!room) throw new RoomError('ROOM_NOT_FOUND'); assertRoomLive(room);
      const expires = verifyDisplayToken(room.id, input.token); if (!expires) throw new RoomError('DISPLAY_TOKEN_INVALID');
      if (socketIdentityMap.has(socket.id)) await handleDisconnect(io, socket);
      for (const joined of socket.rooms) if (joined.startsWith('room_')) await socket.leave(joined);
      const session = await prisma.displaySession.create({ data: { roomId: room.id, connected: true, expiresAt: new Date(expires) } });
      socket.data = { roomId: room.id, participationId: `display:${session.id}`, role: 'DISPLAY', displayName: 'Display', sessionType: 'DISPLAY', displayExpiresAt: expires };
      socketIdentityMap.set(socket.id, { socketId: socket.id, roomId: room.id, participationId: `display:${session.id}`, role: 'DISPLAY' });
      await socket.join(roomChannel(room.id));
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        if (socket.data.participationId !== `display:${session.id}`) return;
        void socket.leave(roomChannel(room.id)); socketIdentityMap.delete(socket.id); socket.data = {}; socket.emit('room:closed');
        void prisma.displaySession.updateMany({ where: { id: session.id }, data: { connected: false } }).catch(() => {});
      }, Math.max(1, expires - Date.now())); expiryTimer.unref();
      socket.emit('room:snapshot', { roomId: room.id, code: room.code, roomName: room.roomName, status: room.status, runPhase: room.runPhase, gameSlug: room.gameDefinition.slug,
        players: room.participations.map(p => ({ id: p.id, displayName: p.displayName, role: p.role, score: p.score, connected: p.connected, ready: p.ready })), selfParticipationId: `display:${session.id}` });
      ack?.({ success: true, data: { sessionType: 'DISPLAY', gameSlug: room.gameDefinition.slug, roomName: room.roomName } });
    } catch (error) { ack?.({ success: false, error: error instanceof RoomError ? error.code : error instanceof z.ZodError ? 'INVALID_PAYLOAD' : 'DISPLAY_UNAVAILABLE' }); }
  });
}
