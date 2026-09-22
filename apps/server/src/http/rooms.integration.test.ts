// ============================================================
// Rooms Integration Tests
//
// Strategy: Every test creates its OWN PrismaClient and fresh createApp().
// The lazy prisma Proxy (persistence/prisma.ts) reads globalThis.__prisma at
// call-time, so setting globalThis.__prisma = freshPrisma BEFORE importing
// createApp makes the entire app chain use the test DB.
//
// mkdtemp used for temp dirs — cleaned up in afterEach.
// ============================================================

import { describe, it, expect, afterAll } from 'vitest';
import supertest from 'supertest';
import { rm as rmAsync } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import {
  seedTestUserWithDb,
  getOrCreateGeoGame,
  cleanupTestDataForDb,
} from '../test-helpers.js';

const ALL_TEMP_DIRS: string[] = [];

afterAll(async () => {
  for (const dir of ALL_TEMP_DIRS) {
    try { await rmAsync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Per-test app factory ─────────────────────────────────────
// nodeBin: absolute path to the running node executable (reliable, no symlinks)
// prismaBin: from monorepo root's node_modules (apps/ is the workspace root)
// src/http/ → apps/server/src/ → apps/server/ → apps/ → monorepo root (4 Ebenen)
const rootNodeModules = pathResolve(__dirname, '..', '..', '..', '..');
const prismaBin = pathResolve(rootNodeModules, 'node_modules/.bin/prisma');

// Run migration using `prisma db push` via execFile (no dynamic import needed).
// This avoids the "ERR_MODULE_NOT_FOUND" issue that occurs when a subprocess
// script in /tmp tries to `import('@prisma/client')` — Node can't find the
// monorepo's node_modules from a temp directory.
// Uses mkdtemp for unique temp dirs cleaned in afterAll.
async function migrateDb(dbUrl: string) {
  const { execFile } = await import('node:child_process');
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-migrate-'));
  ALL_TEMP_DIRS.push(tmpDir);

  const env = { ...process.env, DATABASE_URL: dbUrl };

  // `prisma db push` is non-interactive with --accept-data-loss
  await new Promise<void>((resolve, reject) => {
    execFile(prismaBin, ['db', 'push', '--accept-data-loss', '--skip-generate'], { cwd: rootNodeModules, env }, (err, _out, stderr) => {
      if (err) { console.error(stderr); reject(err); }
      else resolve();
    });
  });
}

async function createTestApp() {
  const { PrismaClient } = await import('@prisma/client');
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-server-'));
  ALL_TEMP_DIRS.push(tmpDir);
  const dbPath = join(tmpDir, 'test.db');
  const dbUrl = `file:${dbPath}`;

  // ── MIGRATE before any DB access ──────────────────────────────
  await migrateDb(dbUrl);

  const freshPrisma = new PrismaClient({ datasourceUrl: dbUrl });
  await freshPrisma.$connect();

  // Set globalThis BEFORE import — lazy prisma reads it at call-time
  globalThis.__prisma = freshPrisma;

  const { createApp } = await import('../app.js');
  const { app } = createApp();
  return { app, prisma: freshPrisma, request: supertest(app), dbUrl, tmpDir };
}

// ── Room helpers ─────────────────────────────────────────────

/** Create a test room using the patched prisma (accessible via dynamic import). */
async function createTestRoom(opts: {
  hostUserId: string;
  code?: string;
  status?: string;
  pinHash?: string | null;
  maxPlayers?: number;
  isPublic?: boolean;
}) {
  const { prisma } = await import('../persistence/prisma.js');
  const code = opts.code ?? `${String(Math.floor(Math.random() * 900) + 100)}-${String(Math.floor(Math.random() * 900) + 100)}`;
  const geoDef = await getOrCreateGeoGame();
  await prisma.room.upsert({
    where: { code },
    update: {},
    create: {
      code, roomName: `Test Room ${code}`, hostUserId: opts.hostUserId,
      gameDefinitionId: geoDef.id, status: opts.status ?? 'LOBBY',
      pinHash: opts.pinHash ?? null, maxPlayers: opts.maxPlayers ?? 10,
      isPublic: opts.isPublic ?? true, setupSnapshotJson: '{}',
      setupSchemaVersion: 1, runPhase: 'LOBBY', revision: 0,
    },
  });
  return code;
}

// ── Tests ────────────────────────────────────────────────────

describe('Rooms API — Create Room', () => {
  it('POST /api/v1/rooms — should create room with valid session', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const result = await seedTestUserWithDb(db, `mod-create-${ts}`, `Creator${ts}`, `mod-create-${ts}@test.local`);
    const geoDef = await getOrCreateGeoGame();

    const res = await req
      .post('/api/v1/rooms')
      .set('Cookie', result.cookie)
      .send({ roomName: 'My Test Room', gameSlug: geoDef.slug, gameDefinitionId: geoDef.id });

    expect(res.status, res.text).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.code).toMatch(/^\d{3}-\d{3}$/);
    expect(res.body.data.moderatorToken).toBeTruthy();

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('POST /api/v1/rooms — should reject unauthenticated request with 401', async () => {
    const { request: req } = await createTestApp();
    const res = await req.post('/api/v1/rooms').send({ gameDefinitionId: 'does-not-exist', roomName: 'Private Room' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('POST /api/v1/rooms — should reject missing roomName with 400', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const result = await seedTestUserWithDb(db, `mod-noname-${ts}`, `CreatorNoName${ts}`, `mod-noname-${ts}@test.local`);
    const geoDef = await getOrCreateGeoGame();

    const res = await req
      .post('/api/v1/rooms')
      .set('Cookie', result.cookie)
      .send({ gameSlug: geoDef.slug, gameDefinitionId: geoDef.id });

    expect(res.status, res.text).toBe(400);
    expect(res.body.success).toBe(false);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('POST /api/v1/rooms — should reject missing game definition with 400', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const result = await seedTestUserWithDb(db, `mod-nogame-${ts}`, `CreatorNoGame${ts}`, `mod-nogame-${ts}@test.local`);

    const res = await req
      .post('/api/v1/rooms')
      .set('Cookie', result.cookie)
      .send({ roomName: 'Room Without Game' });

    expect(res.status, res.text).toBe(400);
    expect(res.body.success).toBe(false);
    expect(['VALIDATION', 'VALIDATION_ERROR']).toContain(res.body.error.code);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });
});

describe('Rooms API — List & Get Room', () => {
  it('GET /api/v1/rooms/public — should list public LOBBY rooms', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const result = await seedTestUserWithDb(db, `mod-list1-${ts}`, `Lister${ts}`, `mod-list1-${ts}@test.local`);
    const roomCode = await createTestRoom({ hostUserId: result.userId });

    const res = await req.get('/api/v1/rooms/public');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const found = res.body.data.find((r: { code: string }) => r.code === roomCode);
    expect(found?.status).toBe('LOBBY');

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('GET /api/v1/rooms/:code — should return room details', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const result = await seedTestUserWithDb(db, `mod-get1-${ts}`, `Getter${ts}`, `mod-get1-${ts}@test.local`);
    const roomCode = await createTestRoom({ hostUserId: result.userId });

    const res = await req.get(`/api/v1/rooms/${roomCode}`);
    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe(roomCode);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('GET /api/v1/rooms/:code — unknown code returns 404', async () => {
    const { request: req } = await createTestApp();
    const res = await req.get('/api/v1/rooms/999-999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/v1/rooms/:code — private rooms hidden from unauthenticated users', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const result = await seedTestUserWithDb(db, `mod-priv1-${ts}`, `PrivHost${ts}`, `mod-priv1-${ts}@test.local`);
    const privateCode = await createTestRoom({ hostUserId: result.userId, isPublic: false });

    const res = await req.get(`/api/v1/rooms/${privateCode}`);
    expect(res.status).toBe(404);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('GET /api/v1/rooms/:code — host can retrieve own private room', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const result = await seedTestUserWithDb(db, `mod-hostpriv-${ts}`, `HostPriv${ts}`, `mod-hostpriv-${ts}@test.local`);
    const roomCode = await createTestRoom({ hostUserId: result.userId, isPublic: false });

    const res = await req.get(`/api/v1/rooms/${roomCode}`).set('Cookie', result.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe(roomCode);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });
});

describe('Rooms API — Join Room', () => {
  it('POST /api/v1/rooms/:code/join — creates participation with rejoinToken', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-join1-${ts}`, `JoinHost${ts}`, `mod-join1-${ts}@test.local`);
    const freeCode = await createTestRoom({ hostUserId: host.userId, maxPlayers: 10 });

    const res = await req
      .post(`/api/v1/rooms/${freeCode}/join`)
      .send({ displayName: 'JoinPlayer' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rejoinToken).toBeTruthy();
    expect(res.body.data.participationId).toBeTruthy();
    expect(res.body.data.role).toBe('PLAYER');

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('POST /api/v1/rooms/:code/join — wrong PIN returns 403', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-pin1-${ts}`, `PinHost${ts}`, `mod-pin1-${ts}@test.local`);
    const argon2 = (await import('argon2')).default;
    const pinHash = await argon2.hash('1234', { type: argon2.argon2id });
    const pinCode = await createTestRoom({ hostUserId: host.userId, pinHash });

    const res = await req
      .post(`/api/v1/rooms/${pinCode}/join`)
      .send({ displayName: 'PinBreaker', pin: '9999' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_PIN');

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('POST /api/v1/rooms/:code/join — room full returns 400', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-full1-${ts}`, `FullHost${ts}`, `mod-full1-${ts}@test.local`);
    const fullCode = await createTestRoom({ hostUserId: host.userId, maxPlayers: 1 });

    const first = await req.post(`/api/v1/rooms/${fullCode}/join`).send({ displayName: 'FirstPlayer' });
    expect(first.status).toBe(201);

    const second = await req.post(`/api/v1/rooms/${fullCode}/join`).send({ displayName: 'ExtraPlayer' });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('ROOM_FULL');

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('POST /api/v1/rooms/:code/join — non-joinable room (RUNNING) returns 400', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-run1-${ts}`, `RunHost${ts}`, `mod-run1-${ts}@test.local`);
    const runningCode = await createTestRoom({ hostUserId: host.userId, status: 'RUNNING' });

    const res = await req
      .post(`/api/v1/rooms/${runningCode}/join`)
      .send({ displayName: 'LateJoiner' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ROOM_NOT_JOINABLE');

    try { const { prisma } = await import('../persistence/prisma.js'); await prisma.room.deleteMany({ where: { code: runningCode } }); } catch { /* ignore */ }

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('POST /api/v1/rooms/:code/join — correct PIN joins successfully', async () => {
    const { request: req, prisma: db, dbUrl } = await createTestApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-cpin1-${ts}`, `CPinHost${ts}`, `mod-cpin1-${ts}@test.local`);
    const argon2 = (await import('argon2')).default;
    const pinHash = await argon2.hash('5678', { type: argon2.argon2id });
    const pinCode = await createTestRoom({ hostUserId: host.userId, pinHash, maxPlayers: 10 });

    const res = await req
      .post(`/api/v1/rooms/${pinCode}/join`)
      .send({ displayName: 'CorrectPinPlayer', pin: '5678' });

    expect(res.status, res.text).toBe(201);
    expect(res.body.data.rejoinToken).toBeTruthy();

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });
});
