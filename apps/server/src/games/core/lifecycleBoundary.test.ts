import { beforeEach, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { handleGameEvents } from '../../sockets/game.js';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../persistence/prisma.js', () => ({ prisma: { room: { findUnique: mocks.read } } }));
const socket = { id: 'boundary', data: {} } as unknown as Socket;
const io = {} as Server;
beforeEach(() => mocks.read.mockReset());

it.each(['start', 'pause', 'resume', 'end'] as const)('%s rejects malformed lifecycle payloads before database access', async action => {
  for (const raw of [undefined, null, [], 17, '123-456', {}, { roomCode: '' }, { roomCode: 123456 }]) {
    const ack = vi.fn();
    await expect(handleGameEvents[action](io, socket, raw as never, ack)).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ success: false, error: 'INVALID_PAYLOAD' });
  }
  expect(mocks.read).not.toHaveBeenCalled();
});
it('start validates explicit preflight options without converting strings into booleans', async () => {
  for (const raw of [{ roomCode: '123-456', overrideReady: 'false' }, { roomCode: '123-456', acknowledgeWarnings: 1 }]) {
    const ack = vi.fn();
    await handleGameEvents.start(io, socket, raw as never, ack);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ success: false, error: 'INVALID_PAYLOAD' });
  }
  expect(mocks.read).not.toHaveBeenCalled();
});
it.each(['start', 'pause', 'resume', 'end'] as const)('%s preserves protocol and conflicting-envelope error precedence', async action => {
  const unsupported = vi.fn(), conflicting = vi.fn();
  await handleGameEvents[action](io, socket, { roomCode: '123-456', protocolVersion: 2 }, unsupported);
  await handleGameEvents[action](io, socket, { roomCode: '123-456', commandId: 'one', requestId: 'two' }, conflicting);
  expect(unsupported).toHaveBeenCalledTimes(1);
    expect(unsupported).toHaveBeenCalledWith({ success: false, error: 'CLIENT_VERSION_UNSUPPORTED' });
  expect(conflicting).toHaveBeenCalledTimes(1);
    expect(conflicting).toHaveBeenCalledWith({ success: false, error: 'INVALID_PAYLOAD' });
  expect(mocks.read).not.toHaveBeenCalled();
});
