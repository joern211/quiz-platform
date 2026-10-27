import { afterEach, expect, it, vi } from 'vitest';
vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })) }));
import { disconnectSocket, getSocket, observeSocket } from '../socket';
afterEach(() => disconnectSocket());
it('notifies persistent views when a page replaces its socket and stops notifying after unsubscribe', () => {
  const changed = vi.fn(), first = getSocket(), stop = observeSocket(changed);
  expect(changed).toHaveBeenLastCalledWith(first);
  disconnectSocket(); expect(first.disconnect).toHaveBeenCalledTimes(1);
  const second = getSocket(); expect(second).not.toBe(first);
  expect(changed).toHaveBeenLastCalledWith(second); expect(changed).toHaveBeenCalledTimes(2);
  stop(); disconnectSocket(); getSocket(); expect(changed).toHaveBeenCalledTimes(2);
});
