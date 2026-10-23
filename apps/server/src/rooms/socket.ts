import type { Server, Socket } from 'socket.io';
import { RoomCommandSchema } from '@quiz/shared';
import { prisma } from '../persistence/prisma.js';
import { roomChannel } from '../sockets/channel.js';
import { socketIdentityMap } from '../http/middleware/auth.js';
import { loadEffectivePermissions } from '../games/core/permissions.js';
import { runReceipted } from '../games/core/commands.js';
import { wireErrorToAppError } from '../games/core/appError.js';
import { getGameHandler } from '../games/registry.js';
import { mutateRoom, RoomError, roomView, roomPolicy, assertRoomLive, audit, feed, type RoomActor } from './core.js';
import { normalizeRole } from '@quiz/shared';
import { logger } from '../observability/logger.js';

export async function socketRoomActor(socket: Socket): Promise<{ roomId: string; actor: RoomActor }> {
  const identity = socketIdentityMap.get(socket.id);
  if (!identity?.roomId || !socket.rooms.has(roomChannel(identity.roomId))) throw new RoomError('NOT_IN_ROOM');
  const room = await prisma.room.findUniqueOrThrow({ where: { id: identity.roomId } });
  const user = (socket as Socket & { user?: { id: string; sessionId?: string } }).user;
  let userId: string | null = null;
  if (user?.id) {
    const session = await prisma.session.findFirst({ where: { id: user.sessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } } });
    if (session) userId = user.id;
  }
  if (identity.participationId && !identity.participationId.startsWith('viewer:')) {
    const p = await prisma.participation.findFirst({ where: { id: identity.participationId, roomId: room.id, connectionId: socket.id, connected: true, bannedAt: null, kickedAt: null, leftAt: null } });
    if (!p) throw new RoomError('NO_PARTICIPATION');
  }
  const role = userId === room.hostUserId ? 'HOST' : identity.role === 'HOST' ? 'VIEWER' : normalizeRole(identity.role) ?? 'VIEWER';
  const permissions = await loadEffectivePermissions(room.id, role, userId === room.hostUserId || roomPolicy(room).coHostEnabled ? userId : null);
  return { roomId: room.id, actor: { participantId: identity.participationId ?? '', userId, permissions, canManage: permissions.has('PLAYER_MANAGE') || permissions.has('TEAM_MANAGE') || userId === room.hostUserId } };
}

export function revokeParticipantSockets(io: Server, roomId: string, ids: string[], event = 'session:replaced') {
  for (const [id, identity] of socketIdentityMap.entries()) {
    if (identity.roomId !== roomId || !identity.participationId || !ids.includes(identity.participationId)) continue;
    const socket = io.sockets.sockets.get(id);
    socket?.emit(event, { participationId: identity.participationId });
    if (socket) { void socket.leave(roomChannel(roomId)); socket.data = {}; }
    socketIdentityMap.delete(id);
  }
}
export function changed(io: Server, roomId: string) { io.to(roomChannel(roomId)).emit('room:core:changed'); }

export function registerRoomCore(io: Server, socket: Socket) {
  socket.on('room:core:read', async (_data, ack) => {
    try { const { roomId, actor } = await socketRoomActor(socket); ack?.({ success: true, view: await roomView(roomId, actor) }); }
    catch (error) { const code = error instanceof RoomError ? error.code : 'INTERNAL_ERROR'; ack?.({ success: false, error: code }); }
  });
  socket.on('room:command', async (raw, ack) => {
    try {
      const parsed = RoomCommandSchema.safeParse(raw);
      if (!parsed.success) throw new RoomError('INVALID_PAYLOAD');
      const data = parsed.data;
      const { roomId, actor } = await socketRoomActor(socket);
      const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true } });
      if (room.code !== data.roomCode) throw new RoomError('WRONG_ROOM');
      const response = await runReceipted<Record<string, unknown> & { success: boolean }>(prisma, {
        roomId, commandId: data.commandId, actor: { actorId: actor.participantId || actor.userId!, actorRole: socket.data.role }, action: 'ROOM_COMMAND', payload: data.operation, stateVersion: data.stateVersion,
        mutate: async () => {
          try {
            if (data.operation.type === 'EMERGENCY') {
              if (!actor.permissions.has('GAME_ABORT')) throw new RoomError('NOT_AUTHORIZED');
              assertRoomLive(room);
              // Engines only advertise safe implemented emergency actions.
              if (data.operation.action !== 'ABORT_GAME' || data.operation.points !== 'KEEP_POINTS') throw new RoomError('ENGINE_ACTION_UNSUPPORTED');
              const handler = getGameHandler(room.gameDefinition.slug);
              if (!handler || room.status !== 'RUNNING') throw new RoomError('GAME_NOT_RUNNING');
              await handler.end({ io, room });
              await prisma.$transaction(async tx => { await audit(tx, roomId, actor.userId, 'ABORT_GAME', { points: 'KEEP_POINTS' }); await feed(tx, roomId, actor.participantId, 'ABORT_GAME', 'Spiel abgebrochen (Punkte behalten)'); });
              return { success: true };
            }
            return { success: true, ...await mutateRoom(roomId, actor, data.operation) };
          } catch (e) { if (e instanceof RoomError) return { success: false, error: e.code }; throw e; }
        }, toResponse: d => d,
      });
      const result = response.success ? response.data : response;
      ack?.({ ...result, ...(response.replayed ? { replayed: true } : {}) });
      if (result.success && !response.replayed) {
        const op = data.operation;
        if (['KICK', 'BAN', 'TOKEN_ROTATE'].includes(op.type) && 'participantId' in op) revokeParticipantSockets(io, roomId, [op.participantId], op.type === 'TOKEN_ROTATE' ? 'session:replaced' : 'room:kicked');
        if (op.type === 'LEAVE') revokeParticipantSockets(io, roomId, [actor.participantId]);
        if (op.type === 'TRANSFER') {
          const stale = await prisma.participation.findMany({ where: { roomId, role: 'VIEWER', connected: false } });
          revokeParticipantSockets(io, roomId, stale.map(p => p.id));
        }
        if (['REMATCH', 'LOBBY', 'SWITCH_GAME'].includes(op.type)) io.to(roomChannel(roomId)).emit('room:lobby', { roomCode: room.code });
        if (op.type === 'CLOSE') { io.to(roomChannel(roomId)).emit('room:closed'); for (const s of io.sockets.sockets.values()) if (s.data.roomId === roomId) { void s.leave(roomChannel(roomId)); socketIdentityMap.delete(s.id); s.data = {}; } }
        changed(io, roomId);
      }
    } catch (error) {
      const code = error instanceof RoomError ? error.code : 'INTERNAL_ERROR';
      if (code === 'INTERNAL_ERROR') logger.error('Room command failed', { error });
      ack?.({ success: false, error: code, ...wireErrorToAppError(code) });
    }
  });
}
