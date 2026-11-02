// ============================================================
// SQLite connection URL for the server's Prisma client
//
// WHY ONE CONNECTION: Prisma's query engine runs SQLite calls synchronously on its worker threads (one per CPU).
// A write that has to wait for SQLite's single write lock sits in the engine's busy handler and BLOCKS such a thread
// for up to the 5 s busy timeout. When an interactive transaction (BEGIN IMMEDIATE, e.g. the engine write of a
// receipted game action) holds that lock and at least as many other writers as there are threads wait for it
// (a burst of command receipts is enough; a 2-vCPU CI runner needs just two), no thread is left to run the
// transaction's own next statement: it only continues after the waiters give up with P1008, and the transaction itself
// is then usually past its own timeout. A bigger pool does not help (reproduced with connection_limit=40); with one
// connection the waiters queue in the pool, which does not block a thread, and everything runs in order.
//
// An explicit operator choice (a connection_limit already in the URL) is never overridden. Only SQLite file URLs are
// touched. Consequence for callers: code inside `prisma.$transaction(async tx => …)` must use `tx`, never the global
// client — that would wait for the connection the transaction itself holds.
// ============================================================

/** Appends `connection_limit=1` to a SQLite file URL unless the URL already sets a connection limit. */
export function singleConnectionSqliteUrl(url: string): string {
  if (!url.startsWith('file:')) return url;
  const queryStart = url.indexOf('?');
  if (queryStart !== -1 && /(^|[?&])connection_limit=/.test(url.slice(queryStart))) return url;
  return `${url}${queryStart === -1 ? '?' : '&'}connection_limit=1`;
}
