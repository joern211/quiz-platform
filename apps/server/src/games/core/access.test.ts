import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { authorizeGameAction } from './access.js';

function socketFor(data: Record<string, unknown>, joinedRooms: string[]): Socket {
  return {
    data,
    rooms: new Set(joinedRooms),
  } as unknown as Socket;
}

describe('authorizeGameAction', () => {
  it('allows a moderator in the matching room channel', () => {
    const socket = socketFor(
      { roomId: 'room-1', role: 'MODERATOR', participationId: 'p-mod', displayName: 'Mod' },
      ['socket-1', 'room_room-1']
    );

    const result = authorizeGameAction(socket, { roles: ['MODERATOR'], requireParticipation: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.actor.roomId).toBe('room-1');
      expect(result.actor.participationId).toBe('p-mod');
    }
  });

  it('rejects a player for a moderator-only action', () => {
    const socket = socketFor(
      { roomId: 'room-1', role: 'PLAYER', participationId: 'p-1' },
      ['socket-1', 'room_room-1']
    );

    expect(authorizeGameAction(socket, { roles: ['MODERATOR'] })).toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  it('rejects a socket that is not subscribed to its room channel', () => {
    const socket = socketFor(
      { roomId: 'room-1', role: 'PLAYER', participationId: 'p-1' },
      ['socket-1']
    );

    expect(authorizeGameAction(socket, { roles: ['PLAYER'] })).toEqual({
      ok: false,
      error: 'NOT_IN_ROOM',
    });
  });

  it('requires a participation when requested', () => {
    const socket = socketFor(
      { roomId: 'room-1', role: 'MODERATOR' },
      ['socket-1', 'room_room-1']
    );

    expect(authorizeGameAction(socket, { roles: ['MODERATOR'], requireParticipation: true })).toEqual({
      ok: false,
      error: 'NO_PARTICIPATION',
    });
  });
});
