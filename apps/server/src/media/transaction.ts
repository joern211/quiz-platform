import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * SQLite writer lock for a media row and its physical file. The zero-row
 * UPDATE reserves the writer before any lookup/file operation. All composite
 * publishers and startup cleanup use this transaction, including across
 * server processes using the same SQLite database.
 */
export function withMediaTransaction<T>(
  client: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async tx => {
    await tx.$executeRaw`UPDATE media_assets SET id = id WHERE 0`;
    return operation(tx);
  }, { maxWait: 10_000, timeout: 10_000 });
}
