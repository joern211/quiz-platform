// ============================================================
// Prisma Client Singleton — LAZY initialization
//
// WHY LAZY: In tests, we set globalThis.__prisma = freshPrisma
// BEFORE any other module reads `prisma`. The getter reads the
// global at call-time, so test patches take effect immediately.
//
// Usage in tests:
//   globalThis.__prisma = new PrismaClient({ datasourceUrl: dbUrl });
//   const { createApp } = await import('../app.js');
//   // app.ts reads getPrismaClient() which returns our patched instance
// ============================================================

import { PrismaClient } from '@prisma/client';

// Declare global so TypeScript knows about it
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function getPrismaClient(): PrismaClient {
  if (!globalThis.__prisma) {
    globalThis.__prisma = new PrismaClient();
  }
  return globalThis.__prisma;
}

// Re-export the lazy getter as the default export.
// All code that does `import { prisma } from '../persistence/prisma.js'`
// gets getPrismaClient() evaluated AT THE TIME OF FIRST ACCESS,
// so a test that sets globalThis.__prisma BEFORE import sees the patch.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop: string | symbol) {
    if (prop === 'then') return undefined; // not a thenable
    const p = String(prop);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const val = (getPrismaClient() as any)[p];
    if (typeof val === 'function') {
      // Bind methods so `prisma.room.findMany()` works correctly
      return val.bind(getPrismaClient());
    }
    return val;
  },
  has(_target, prop: string | symbol) {
    return prop in getPrismaClient();
  },
  set(_target, prop: string | symbol, value: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (getPrismaClient() as any)[String(prop)] = value;
    return true;
  },
});
