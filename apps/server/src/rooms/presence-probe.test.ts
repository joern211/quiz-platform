import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Server, Socket } from 'socket.io';
import type { PrismaClient } from '@prisma/client';
import { registerRoomCore } from './socket.js';

let previous: PrismaClient | undefined;
const write = vi.fn().mockResolvedValue({ count: 1 });
beforeEach(() => { vi.useFakeTimers(); write.mockClear(); previous = globalThis.__prisma; globalThis.__prisma = { participation: { updateMany: write } } as unknown as PrismaClient; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); globalThis.__prisma = previous; });
async function probe() {
  let response: ((error: Error | null) => void) | undefined;
  const socket = Object.assign(new EventEmitter(), { id: 'connection', connected: true, data: { roomId: 'room', participationId: 'participant' },
    timeout: () => ({ emit: (_event: string, cb: (error: Error | null) => void) => { response = cb; } }) });
  registerRoomCore({} as Server, socket as unknown as Socket);
  await vi.advanceTimersByTimeAsync(1000);
  expect(response).toBeTypeOf('function'); return { socket, finish: () => response!(null) };
}
it('records a response only for the currently connected room identity', async () => {
  const { finish } = await probe(); finish(); await Promise.resolve();
  expect(write).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'participant', roomId: 'room', connectionId: 'connection', connected: true } }));
});
it('does not write when a delayed probe finishes after disconnect', async () => {
  const { socket, finish } = await probe(); socket.connected = false; socket.emit('disconnect'); finish(); await Promise.resolve();
  expect(write).not.toHaveBeenCalled();
});
it('does not apply a previous room or participant probe after the socket changes identity', async () => {
  const { socket, finish } = await probe(); socket.data = { roomId: 'other-room', participationId: 'other-participant' }; finish(); await Promise.resolve();
  expect(write).not.toHaveBeenCalled();
});
