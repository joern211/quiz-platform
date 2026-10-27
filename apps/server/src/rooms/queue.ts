// SQLite has one writer. Queue same-room admissions/edits before opening their
// transaction so concurrent joins cannot exhaust the connection pool while an
// earlier writer waits to commit. DB locks, unique keys and receipt fences
// remain authoritative; this queue is not a multi-process correctness lock.
const pending = new Map<string, Promise<void>>();
export async function serializeRoom<T>(roomId: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(roomId) ?? Promise.resolve();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  pending.set(roomId, barrier);
  await previous;
  try { return await work(); }
  finally { release(); if (pending.get(roomId) === barrier) pending.delete(roomId); }
}
