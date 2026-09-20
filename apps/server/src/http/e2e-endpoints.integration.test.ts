// ============================================================
// E2E Endpoints Tests — Production Block + Development Mode
// ============================================================

import { describe, it, expect, afterEach } from 'vitest';
import supertest from 'supertest';
import { seedTestUser, cleanupTestSessions } from '../test-helpers.js';

// ── Production block ─────────────────────────────────────────

process.env.NODE_ENV = 'production';

const { createApp } = await import('../app.js');
const productionApp = createApp();
const request = supertest(productionApp.app);

describe('E2E Endpoints — Production Block', () => {
  describe('POST /api/v1/auth/e2e-token', () => {
    it('returns 404 in production', async () => {
      const res = await request
        .post('/api/v1/auth/e2e-token')
        .send({ userId: 'mod-1' });

      expect(res.status).toBe(404);
    });

    it('does not create a session in production', async () => {
      const { prisma } = await import('../persistence/prisma.js');

      const beforeCount = await prisma.session.count();

      await request
        .post('/api/v1/auth/e2e-token')
        .send({ userId: 'mod-1' });

      const afterCount = await prisma.session.count();
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe('POST /api/v1/auth/e2e-socket-identity', () => {
    it('returns 404 in production', async () => {
      const res = await request
        .post('/api/v1/auth/e2e-socket-identity')
        .send({ socketId: 'test-socket', identity: 'MODERATOR' });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/e2e/game-start', () => {
    it('returns 404 in production', async () => {
      const res = await request
        .post('/api/v1/e2e/game-start')
        .send({ roomCode: '123-456' });

      expect(res.status).toBe(404);
    });

    it('does not start a game in production', async () => {
      const { prisma } = await import('../persistence/prisma.js');

      const beforeStatus = await prisma.room.findFirst({
        where: { status: 'RUNNING' },
      });

      await request
        .post('/api/v1/e2e/game-start')
        .send({ roomCode: '123-456' });

      const afterStatus = await prisma.room.findFirst({
        where: { status: 'RUNNING' },
      });

      expect(afterStatus).toEqual(beforeStatus);
    });
  });
});

// ── Development mode ─────────────────────────────────────────
// NOTE: NODE_ENV must be set BEFORE createApp() is called so
// the router guards evaluate correctly at instance-creation time.
// DATABASE_URL is set by the test script before vitest starts.

describe('E2E Endpoints — Development Mode', () => {
  afterEach(async () => {
    await cleanupTestSessions();
  });

  it('e2e-token is reachable in development and creates a real session', async () => {
    // Create fresh app BEFORE helpers so middleware chain reflects NODE_ENV=development
    process.env.NODE_ENV = 'development';
    const { createApp: mkApp } = await import('../app.js');
    const devApp = mkApp();
    const devRequest = supertest(devApp.app);
    const { prisma } = await import('../persistence/prisma.js');

    const ts = Date.now();
    const userId = `e2e-ok5-${ts}`;

    // Delete any stale sessions for this user before measuring
    await prisma.session.deleteMany({ where: { userId } });

    const { userId: seededId } = await seedTestUser(userId, `E2E Ok5 ${ts}`, `${userId}@test.local`);

    const res = await devRequest
      .post('/api/v1/auth/e2e-token')
      .send({ userId: seededId });

    expect(res.status).toBe(200);

    const raw = res.headers['set-cookie'];
    const cookieArr = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
    const cookieStr = cookieArr.join('; ');
    expect(cookieStr.includes('quiz_session=')).toBe(true);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user.id).toBe(seededId);
    const newSessionId: string = res.body.data.sessionId;
    expect(newSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Verify the session actually exists in the DB with the correct userId
    const newSession = await prisma.session.findUnique({ where: { id: newSessionId } });
    expect(newSession).not.toBeNull();
    expect(newSession?.userId).toBe(seededId);
  });

  it('e2e-token returns 404 for unknown userId in development', async () => {
    process.env.NODE_ENV = 'development';

    const { createApp: mkApp } = await import('../app.js');
    const devApp = mkApp();
    const devRequest = supertest(devApp.app);

    const res = await devRequest
      .post('/api/v1/auth/e2e-token')
      .send({ userId: 'does-not-exist' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('e2e-token does NOT create a session for unknown userId', async () => {
    process.env.NODE_ENV = 'development';
    const { createApp: mkApp } = await import('../app.js');
    const devApp = mkApp();
    const { prisma } = await import('../persistence/prisma.js');

    const ts = Date.now();
    const id = `e2e-no3-${ts}`;

    // Clean up before measuring
    await prisma.session.deleteMany({ where: { userId: { startsWith: 'e2e-' } } });

    // Seed a real user
    await seedTestUser(id, `E2E No3 ${ts}`, `${id}@test.local`);

    // Capture session count for this user BEFORE the failed e2e-token call
    const sessionsBefore = await prisma.session.findMany({ where: { userId: id } });
    const sessionIdsBefore = new Set(sessionsBefore.map(s => s.id));

    // Unknown user — e2e-token should not create a session
    const res = await supertest(devApp.app)
      .post('/api/v1/auth/e2e-token')
      .send({ userId: 'definitely-not-a-real-user' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);

    // Verify no new sessions were created for our known user
    const sessionsAfter = await prisma.session.findMany({ where: { userId: id } });
    const newSessions = sessionsAfter.filter(s => !sessionIdsBefore.has(s.id));
    expect(newSessions).toHaveLength(0);
  });
});
