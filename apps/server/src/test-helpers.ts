// ============================================================
// Test helpers — shared setup/teardown for integration tests
//
// IMPORTANT: All functions that access the DB do a DYNAMIC import of
// persistence/prisma.js inside the function body. This ensures that if
// globalThis.__prisma has been set by a test, the dynamic import returns
// the replaced singleton. A top-level `import { prisma } from './...'` would
// capture the original binding before any test can set globalThis.__prisma.
// ============================================================

import { createHmac } from 'crypto';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';

export const TEST_ADMIN = {
  email: 'admin@quiz.local',
  password: 'secret',
  displayName: 'Test Admin',
};

export async function createTestDatabase(databaseUrl: string): Promise<void> {
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'test-database.ts');
  await new Promise<void>((done, fail) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', scriptPath, databaseUrl],
      { env: { ...process.env, DATABASE_URL: databaseUrl } },
      (error, _stdout, stderr) => error ? fail(new Error(stderr || error.message)) : done(),
    );
  });
}

export async function getSeedAdmin() {
  const { prisma } = await import('./persistence/prisma.js');
  return prisma.user.findUniqueOrThrow({ where: { email: TEST_ADMIN.email } });
}

export async function getOrCreateGeoGame() {
  const { prisma } = await import('./persistence/prisma.js');
  const ts = Date.now();
  const id = `geo-integration-${ts}`;
  return prisma.gameDefinition.upsert({
    where: { id },
    update: {},
    create: {
      id,
      slug: `geo-integration-${ts}`,
      name: 'Geo-Quiz',
      category: 'GEO',
      status: 'AVAILABLE',
      minPlayers: 1,
      maxPlayers: 10,
    },
  });
}

// ── Session cookie factory ──────────────────────────────────

function makeSessionCookie(sessionId: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `quiz_session=${sessionId}.${signature}; Path=/; HttpOnly`;
}

/** Create user + session, return { userId, cookie } for tests.
 * Uses the PrismaClient that is currently registered (possibly patched via
 * globalThis.__prisma), so callers can use the SAME connection that the app
 * will read from. */
export async function seedTestUserWithDb(
  db: PrismaClient,
  id: string,
  displayName: string,
  email: string,
  isAdmin = false,
): Promise<{ userId: string; cookie: string }> {
  const { config } = await import('./config/index.js');
  const user = await db.user.upsert({
    where: { id },
    update: { displayName, email },
    create: {
      id,
      displayName,
      email,
      passwordHash:
        '$argon2id$v=19$m=65536,t=3,p=4$testHashDoesNotMatterForUnitTests',
      role: isAdmin ? 'ADMIN' : 'MODERATOR',
    },
  });
  const session = await db.session.create({
    data: {
      id: `seed-sess-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return { userId: user.id, cookie: makeSessionCookie(session.id, config.sessionSecret) };
}

/** Create user + session using the current prisma singleton. */
export async function seedTestUser(
  id: string,
  displayName: string,
  email: string,
  isAdmin = false,
): Promise<{ userId: string; cookie: string }> {
  const { prisma } = await import('./persistence/prisma.js');
  return seedTestUserWithDb(prisma, id, displayName, email, isAdmin);
}

// ── Cleanup helpers ─────────────────────────────────────────

/** Clean up test rooms created during a test */
export async function cleanupTestRoom(code: string) {
  try {
    const { prisma } = await import('./persistence/prisma.js');
    await prisma.room.deleteMany({ where: { code } });
  } catch { /* ignore */ }
}

/** Delete all sessions created during integration tests.
 * Scoped to test-specific prefixes to avoid wiping sessions created by
 * the current test (before its own requests).
 *
 * IMPORTANT: Uses a fresh PrismaClient (bypassing globalThis.__prisma) so
 * cleanup works even after a test has called $disconnect() on its own client. */
export async function cleanupTestSessions() {
  const { PrismaClient } = await import('@prisma/client');
  // Use DATABASE_URL directly — avoids globalThis.__prisma which may be $disconnect()ed
  const dbUrl = process.env.DATABASE_URL ?? 'file:/tmp/quiz-server-test.db';
  const cleanupDb = new PrismaClient({ datasourceUrl: dbUrl });
  try {
    await cleanupDb.$connect();
    await cleanupDb.session.deleteMany({ where: { id: { startsWith: 'seed-sess-' } } });
    await cleanupDb.session.deleteMany({ where: { userId: { startsWith: 'e2e-' } } });
    await cleanupDb.session.deleteMany({ where: { userId: { startsWith: 'mod-rl-' } } });
    await cleanupDb.session.deleteMany({ where: { userId: { startsWith: 'geo-room-' } } });
  } finally {
    await cleanupDb.$disconnect();
  }
}

/** Clean up test rooms and sessions for a given temp DB file.
 * Used at the end of each test instead of cleanupTestSessions when
 * the test has its own isolated DB. */
export async function cleanupTestDataForDb(dbUrl: string) {
  const { PrismaClient } = await import('@prisma/client');
  const cleanupDb = new PrismaClient({ datasourceUrl: dbUrl });
  try {
    await cleanupDb.$connect();
    // Remove rooms created by createTestRoom (geo-room-* host user or matching timestamps)
    await cleanupDb.room.deleteMany({
      where: { hostUserId: { startsWith: 'mod-' }, createdAt: { lt: new Date() } },
    });
    await cleanupDb.session.deleteMany({ where: { id: { startsWith: 'seed-sess-' } } });
  } finally {
    await cleanupDb.$disconnect();
  }
}
