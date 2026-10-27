// SQLite has one writer. Queue same-room admissions/edits before opening their
// transaction so concurrent joins cannot exhaust the connection pool while an
// earlier writer waits to commit. DB locks, unique keys and receipt fences
// remain authoritative; this queue is not a multi-process correctness lock.
import { AsyncLocalStorage } from 'node:async_hooks';

const pending = new Map<string, Promise<void>>();
const activeRoom = new AsyncLocalStorage<{ roomId: string; active: boolean }>();
export async function serializeRoom<T>(roomId: string, work: () => Promise<T>): Promise<T> {
  // Socket admission may call the same room's transactional viewer admission.
  // Re-enter only the actively held room lease, never a detached continuation
  // whose parent already released the queue.
  const held = activeRoom.getStore();
  if (held?.roomId === roomId && held.active) return work();
  const previous = pending.get(roomId) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  pending.set(roomId, barrier);
  await previous;
  const lease = { roomId, active: true };
  try { return await activeRoom.run(lease, work); }
  finally { lease.active = false; release(); if (pending.get(roomId) === barrier) pending.delete(roomId); }
}
