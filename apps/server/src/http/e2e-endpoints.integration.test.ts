// ============================================================
// E2E Endpoints Tests — Production Block + Development Mode
//
// STRATEGY:
//   - prisma db push via execFile for reliable migration
//   - per-test PrismaClient + fresh mkdtemp temp DB
//   - globalThis.__prisma patched before createApp import
//   - cleanupTestDataForDb in every afterEach / afterAll
//
// Module-level productionApp/request: guard-only tests, no DB data needed.
// ============================================================

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import supertest from 'supertest';
import { mkdtemp, rm as rmDir } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import os from 'node:os';
import { seedTestUserWithDb, cleanupTestDataForDb } from '../test-helpers.js';

const ALL_TEMP_DIRS: string[] = [];

afterAll(async () => {
  for (const dir of ALL_TEMP_DIRS) {
    try { await rmDir(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Paths ────────────────────────────────────────────────────
const rootNodeModules = pathResolve(__dirname, '..', '..', '..', '..');
const prismaBin = pathResolve(rootNodeModules, 'node_modules/.bin/prisma');

// ── Migration via prisma db push (execFile — reliable, no module path issues) ─
async function migrateDb(dbUrl: string) {
  const { execFile } = await import('node:child_process');
  const { mkdtemp: mkdtempFs } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const tmpDir = await mkdtempFs(joinPath(tmpdir(), 'quiz-migrate-'));
  ALL_TEMP_DIRS.push(tmpDir);
  const env = { ...process.env, DATABASE_URL: dbUrl };

  await new Promise<void>((resolve, reject) => {
    execFile(prismaBin, ['db', 'push', '--accept-data-loss', '--skip-generate'], {
      cwd: rootNodeModules,
      env,
    }, (err, _out, stderr) => {
      if (err) { console.error(stderr); reject(err); }
      else resolve();
    });
  });
}

// ── Per-test app factory ─────────────────────────────────────
// Creates fresh mkdtemp DB + migrated PrismaClient + patched createApp.
// Mirrors rooms.integration.test.ts exactly.
//
// IMPORTANT: Set NODE_ENV to 'development' HERE so createApp() reads the
// correct value at call-time. Vitest forks with NODE_ENV=production, so
// we must override it inside the factory, not at module level.
async function createTestApp() {
  const { PrismaClient } = await import('@prisma/client');
  const tmpDir = await mkdtemp(os.tmpdir() + '/quiz-e2e-');
  ALL_TEMP_DIRS.push(tmpDir);
  const dbPath = tmpDir + '/test.db';
  const dbUrl = `file:${dbPath}`;

  await migrateDb(dbUrl);

  const freshPrisma = new PrismaClient({ datasourceUrl: dbUrl });
  await freshPrisma.$connect();

  // Override BEFORE patching and BEFORE importing createApp
  // createApp() reads process.env.NODE_ENV at call-time (lazy evaluation)
  process.env.NODE_ENV = 'development';

  // Patch lazy prisma singleton BEFORE importing createApp
  globalThis.__prisma = freshPrisma;

  const { createApp } = await import('../app.js');
  const { app } = createApp();
  return { app, prisma: freshPrisma, request: supertest(app), dbUrl, tmpDir };
}

// ── Module-level production guard app ────────────────────────
// Safe: no DB access needed for simple 404 guard tests.
// Uses a temp DB so production app doesn't try to open a non-existent default path.
const savedNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
// Must set DATABASE_URL here so the production app doesn't try to use
// the default './storage/database/quiz.db' which doesn't exist in CI/test.
const tmpDir = await mkdtemp(join(os.tmpdir(), 'quiz-e2e-prod-'));
ALL_TEMP_DIRS.push(tmpDir);
process.env.DATABASE_URL = `file:${tmpDir}/prod.db`;

const { createApp } = await import('../app.js');
const productionApp = createApp();
const productionRequest = supertest(productionApp.app);

// ── Production block tests ───────────────────────────────────

describe('E2E Endpoints — Production Block', () => {
  // Ensure NODE_ENV=production for all production tests.
  // createTestApp() sets NODE_ENV=development, so production tests
  // use productionRequest (module-level, correct NODE_ENV at creation time).
  beforeAll(() => { process.env.NODE_ENV = 'production'; });
  // Restore after suite so subsequent describe blocks aren't polluted.
  afterAll(() => { process.env.NODE_ENV = savedNodeEnv; });

  describe('POST /api/v1/auth/e2e-token', () => {
    it('returns 404 in production', async () => {
      process.env.NODE_ENV = 'production';
      const res = await productionRequest
        .post('/api/v1/auth/e2e-token')
        .send({ userId: 'mod-1' });
      expect(res.status).toBe(404);
    });

    it('does not create a session in production', async () => {
      // HTTP call must target the production app (productionRequest).
      // Data seeding uses a fresh dev app so we can create a valid signed cookie.
      const { prisma: devPrisma } = await createTestApp();

      const testUserId = `prod-no-create-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      // Seed user + session in the dev DB (used only to get a valid signed cookie)
      await devPrisma.user.upsert({
        where: { id: testUserId },
        update: {},
        create: {
          id: testUserId,
          displayName: 'E2EProdNoCreate',
          email: `${testUserId}@test.local`,
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$hash',
          role: 'MODERATOR',
        },
      });
      const session = await devPrisma.session.create({
        data: {
          id: `prod-sess-${Date.now()}`,
          userId: testUserId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      // Sign cookie with the production SESSION_SECRET (from config)
      // so productionRequest (which uses the same secret) can verify it
      const { createHmac } = await import('crypto');
      const { config } = await import('../config/index.js');
      const sig = createHmac('sha256', config.sessionSecret).update(session.id).digest('base64url');
      const cookie = `quiz_session=${session.id}.${sig}`;

      // Count sessions in the production DB (production app's temp DB)
      const { prisma: prodPrisma } = await import('../persistence/prisma.js');
      const beforeCount = await prodPrisma.session.count({ where: { userId: testUserId } });
      expect(beforeCount).toBe(1);

      // POST e2e-token against productionRequest — should be blocked (404), no side effect
      process.env.NODE_ENV = 'production';
      const res = await productionRequest
        .post('/api/v1/auth/e2e-token')
        .set('Cookie', cookie)
        .send({ userId: testUserId });
      expect(res.status).toBe(404);

      // Count unchanged in production DB — no extra session created
      const afterCount = await prodPrisma.session.count({ where: { userId: testUserId } });
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe('POST /api/v1/auth/e2e-socket-identity', () => {
    it('returns 404 in production', async () => {
      process.env.NODE_ENV = 'production';
      const res = await productionRequest
        .post('/api/v1/auth/e2e-socket-identity')
        .send({ roomCode: 'ABC-123', role: 'MODERATOR' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/e2e/game-start', () => {
    it('returns 404 in production', async () => {
      process.env.NODE_ENV = 'production';
      const res = await productionRequest
        .post('/api/v1/e2e/game-start')
        .send({ roomCode: '123-456' });
      expect(res.status).toBe(404);
    });

    it('does not start a game in production', async () => {
      const { prisma } = await import('../persistence/prisma.js');
      const beforeStatus = await prisma.room.findFirst({ where: { status: 'RUNNING' } });
      expect(beforeStatus).toBeNull();

      process.env.NODE_ENV = 'production';
      await productionRequest
        .post('/api/v1/e2e/game-start')
        .send({ roomCode: '123-456' });

      const afterStatus = await prisma.room.findFirst({ where: { status: 'RUNNING' } });
      expect(afterStatus).toEqual(beforeStatus);
    });
  });
});

// ── Development mode tests ───────────────────────────────────

describe('E2E Endpoints — Development Mode', () => {
  afterEach(async () => {
    const { prisma } = await import('../persistence/prisma.js');
    try {
      await prisma.session.deleteMany({
        where: { id: { startsWith: 'seed-sess-' }, userId: { startsWith: 'e2e-dev-' } },
      });
    } catch { /* ignore */ }
  });

  it('e2e-token is reachable in development and creates a real session', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();

    const ts = Date.now();
    const userId = `e2e-dev-${ts}`;

    await seedTestUserWithDb(db, userId, `E2E Dev ${ts}`, `${userId}@test.local`);

    const res = await req
      .post('/api/v1/auth/e2e-token')
      .send({ userId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.id).toBe(userId);

    // Set-Cookie header present
    const raw = res.headers['set-cookie'] as string | string[] | undefined;
    const cookieArr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const cookieStr = cookieArr.join('; ');
    expect(cookieStr.includes('quiz_session=')).toBe(true);

    const newSessionId: string = res.body.data.sessionId;
    expect(newSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Session actually stored in DB
    const newSession = await db.session.findUnique({ where: { id: newSessionId } });
    expect(newSession).not.toBeNull();
    expect(newSession?.userId).toBe(userId);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('e2e-token returns 404 for unknown userId in development', async () => {
    const { request: req } = await createTestApp();

    const res = await req
      .post('/api/v1/auth/e2e-token')
      .send({ userId: 'does-not-exist' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('e2e-token does NOT create a session for unknown userId', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();

    const ts = Date.now();
    const testUserId = `e2e-dev-no-${ts}`;

    await seedTestUserWithDb(db, testUserId, `E2E Dev No ${ts}`, `${testUserId}@test.local`);

    const sessionsBefore = await db.session.findMany({ where: { userId: testUserId } });
    const sessionIdsBefore = new Set(sessionsBefore.map(s => s.id));

    const res = await req
      .post('/api/v1/auth/e2e-token')
      .send({ userId: 'definitely-not-a-real-user' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);

    const sessionsAfter = await db.session.findMany({ where: { userId: testUserId } });
    const newSessions = sessionsAfter.filter(s => !sessionIdsBefore.has(s.id));
    expect(newSessions).toHaveLength(0);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });
});
