// ============================================================
// Test helpers — shared setup/teardown for integration tests
// ============================================================

import { createHmac } from 'crypto';
import { prisma } from './persistence/prisma.js';
import { config } from './config/index.js';

/** Fixed test admin credentials */
export const TEST_ADMIN = {
  email: 'admin@quiz.local',
  password: 'secret',
  displayName: 'Test Admin',
};

/** Get an existing seed admin or create one */
export async function getSeedAdmin() {
  return prisma.user.findUniqueOrThrow({
    where: { email: TEST_ADMIN.email },
  });
}

/** Create a geo quiz game definition for integration tests */
export async function getOrCreateGeoGame() {
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

const COOKIE_NAME = 'quiz_session';

function makeSessionCookie(sessionId: string): string {
  const signature = createHmac('sha256', config.sessionSecret)
    .update(sessionId)
    .digest('base64url');
  return `${COOKIE_NAME}=${sessionId}.${signature}; Path=/; HttpOnly`;
}

/** Create a session for a user in the DB and return the signed cookie */
export async function createTestSession(userId: string): Promise<string> {
  const session = await prisma.session.create({
    data: {
      id: `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      userId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return makeSessionCookie(session.id);
}

/** Create user + session, return { user, cookie } for tests */
export async function seedTestUser(
  id: string,
  displayName: string,
  email: string,
  isAdmin = false,
): Promise<{ userId: string; cookie: string }> {
  const user = await prisma.user.upsert({
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
  const cookie = await createTestSession(user.id);
  return { userId: user.id, cookie };
}

// ── Cleanup helpers ─────────────────────────────────────────

/** Clean up test rooms created during a test */
export async function cleanupTestRoom(code: string) {
  await prisma.room.deleteMany({ where: { code } }).catch(() => {/* ignore */});
}

/** Delete all sessions that start with 'test-session-' (cleanup after test) */
export async function cleanupTestSessions() {
  await prisma.session.deleteMany({
    where: { id: { startsWith: 'test-session-' } },
  });
  // Also clean up e2e-* sessions from E2E endpoint integration tests
  await prisma.session.deleteMany({
    where: { userId: { startsWith: 'e2e-' } },
  });
}
