// ============================================================
// Join Rate-Limiter Integration Tests
// ============================================================
// Strategy: Each test spins up a real Node.js subprocess running dist/app.js
// in production mode. The subprocess starts the server, writes its port to
// a temp file, then stays alive until killed. Supertest sends HTTP requests
// to that port so they all hit the SAME joinLimiter instance (max=20).
// Dev-mode tests use createApp() directly (limiter is a no-op in dev).
// ============================================================

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import supertest from 'supertest';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { getOrCreateGeoGame } from '../test-helpers.js';

const serverDir = dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const appPath = pathResolve(serverDir, '../../dist/app.js');

interface JoinResult { status: number; body: Record<string, unknown> }

/** A persistent production-mode server for one test suite.
 * Launched once in beforeAll, killed in afterAll.
 * All requests share the same process so they hit the SAME joinLimiter counter. */
class ProdServer {
  private child: ReturnType<typeof spawn> | null = null;
  private port: number | null = null;
  private stderr = '';
  private tmpScript = '';
  private tmpPortFile = '';
  private started = false;
  private tempDir = '';

  async start(): Promise<number> {
    if (this.started) return this.port!;

    // mkdtemp gives a unique dir; cleaned reliably in stop() via rm(..., {recursive:true})
    this.tempDir = await mkdtemp(join(os.tmpdir(), 'quiz-prod-'));
    this.tmpScript = join(this.tempDir, 'server.mjs');
    this.tmpPortFile = join(this.tempDir, 'port.txt');

    const scriptBody = `
import { createApp } from ${JSON.stringify(appPath)};
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

try {
  const { app } = createApp();
  const server = createServer(app);

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => { if (err) reject(err); else resolve(undefined); });
  });

  const port = server.address().port;
  writeFileSync(${JSON.stringify(this.tmpPortFile)}, String(port), 'utf8');

  await new Promise(() => {});
} catch (err) {
  writeFileSync(${JSON.stringify(this.tmpPortFile)}, 'ERROR: ' + String(err), 'utf8');
  process.exit(1);
}`.trim();

    writeFileSync(this.tmpScript, scriptBody);

    this.child = spawn(nodeBin, [this.tmpScript], {
      cwd: pathResolve(serverDir, '../..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: process.env.DATABASE_URL ?? 'file:/tmp/quiz-server-test.db',
        SESSION_SECRET: process.env.SESSION_SECRET ?? 'ci-test-secret-at-least-32-chars-long',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stderr!.on('data', (d: Buffer) => { this.stderr += d; });

    const deadline = Date.now() + 15_000;
    while (!this.port) {
      if (Date.now() > deadline) {
        this.child.kill();
        throw new Error(`Server startup timed out\nSTDERR: ${this.stderr}`);
      }
      try {
        const n = Number(readFileSync(this.tmpPortFile, 'utf8').trim());
        if (n > 0) this.port = n;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    this.started = true;
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.child) { this.child.kill('SIGTERM'); this.child = null; }
    // rmAsync with recursive:true removes the entire temp dir in one call
    if (this.tempDir) {
      try { await rmAsync(this.tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      this.tempDir = '';
    }
    this.port = null;
    this.started = false;
  }

  async join(roomCode: string, displayName: string): Promise<JoinResult> {
    if (!this.port) throw new Error('ProdServer not started');
    const res = await supertest(`http://127.0.0.1:${this.port}`)
      .post(`/api/v1/rooms/${roomCode}/join`)
      .send({ displayName });
    return { status: res.status, body: res.body as Record<string, unknown> };
  }

  async createRoom(gameSlug: string, roomName: string, cookie: string): Promise<JoinResult> {
    if (!this.port) throw new Error('ProdServer not started');
    const res = await supertest(`http://127.0.0.1:${this.port}`)
      .post('/api/v1/rooms')
      .set('Cookie', cookie)
      .send({ gameSlug, roomName });
    return { status: res.status, body: res.body as Record<string, unknown> };
  }
}

// ── Test room factory ────────────────────────────────────────
// Uses dynamic import so it picks up globalThis.__prisma when set by tests
async function createTestRoomInDb(hostUserId: string, maxPlayers = 30) {
  const { prisma } = await import('../persistence/prisma.js');
  const raw = `${String(Math.floor(Math.random() * 900) + 100)}-${String(Math.floor(Math.random() * 900) + 100)}`;
  const geoDef = await getOrCreateGeoGame();
  await prisma.room.upsert({
    where: { code: raw },
    update: {},
    create: {
      code: raw, roomName: `Test Room ${raw}`, hostUserId,
      gameDefinitionId: geoDef.id, status: 'LOBBY', pinHash: null,
      maxPlayers, isPublic: true, setupSnapshotJson: '{}',
      setupSchemaVersion: 1, runPhase: 'LOBBY', revision: 0,
    },
  });
  return raw;
}

// ============================================================
// Dev-mode tests — rate limiter is a no-op
// ============================================================

describe('Rate Limiter — Join Route (dev mode)', () => {
  let roomCode: string;

  afterEach(async () => {
    const { prisma } = await import('../persistence/prisma.js');
    try {
      if (roomCode) await prisma.room.deleteMany({ where: { code: roomCode } });
    } catch { /* ignore */ }
    try { await prisma.session.deleteMany({ where: { userId: { startsWith: 'mod-rl-dev-' } } }); } catch { /* ignore */ }
  });

  it('joins are not rate-limited in development', async () => {
    const { createApp } = await import('../app.js');
    const { app } = createApp();

    // Create a test room
    const { prisma } = await import('../persistence/prisma.js');
    const { createHmac } = await import('crypto');
    const { config } = await import('../config/index.js');
    const geoDef = await getOrCreateGeoGame();

    const modUser = await prisma.user.upsert({
      where: { id: `mod-rl-dev-${Date.now()}` },
      update: {},
      create: { id: `mod-rl-dev-${Date.now()}`, displayName: 'RLHost', email: `rl-dev-${Date.now()}@test.local`, passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test', role: 'MODERATOR' },
    });
    const session = await prisma.session.create({ data: { id: `rl-dev-sess-${Date.now()}`, userId: modUser.id, expiresAt: new Date(Date.now() + 86400000) } });
    const sig = createHmac('sha256', config.sessionSecret).update(session.id).digest('base64url');
    const cookie = `quiz_session=${session.id}.${sig}`;

    const req = supertest(app);
    const createRes = await req.post('/api/v1/rooms').set('Cookie', cookie).send({ gameSlug: geoDef.slug, roomName: 'RL Dev Room' });
    expect(createRes.status, createRes.text).toBe(201);
    roomCode = createRes.body.data.code;

    // 5 requests — all succeed in dev (limiter is a no-op)
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) =>
      req.post(`/api/v1/rooms/${roomCode}/join`).send({ displayName: `Player${i}` }),
    ));
    // All should be 201 (first player joined) or 400 (room fills up).
    // In dev mode the limiter middleware never blocks.
    expect(results.every((r) => r.status === 201 || r.status === 400)).toBe(true);
  });
});

// ============================================================
// Production-mode tests — single persistent server
// joinLimiter: max=20 requests per IP per 15 minutes
// ============================================================

describe('Rate Limiter — Production (real behavior)', () => {
  let roomCode: string;
  const server = new ProdServer();

  beforeAll(async () => {
    const { prisma } = await import('../persistence/prisma.js');
    const { createHmac } = await import('crypto');
    const { config } = await import('../config/index.js');

    const modId = `mod-rl-prod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const modUser = await prisma.user.upsert({
      where: { id: modId },
      update: {},
      create: { id: modId, displayName: 'RateLimitHost', email: `${modId}@test.local`, passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$test', role: 'MODERATOR' },
    });
    const session = await prisma.session.create({ data: { id: `rl-prod-sess-${Date.now()}`, userId: modUser.id, expiresAt: new Date(Date.now() + 86400000) } });
    const sig = createHmac('sha256', config.sessionSecret).update(session.id).digest('base64url');
    const _cookie = `quiz_session=${session.id}.${sig}`;
    void _cookie; // suppress unused warning (reserved for future authenticated requests)

    roomCode = await createTestRoomInDb(modUser.id, 30);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    const { prisma } = await import('../persistence/prisma.js');
    try { await prisma.session.deleteMany({ where: { userId: { startsWith: 'mod-rl-prod-' } } }); } catch { /* ignore */ }
    try { await prisma.room.deleteMany({ where: { hostUserId: { startsWith: 'mod-rl-prod-' } } }); } catch { /* ignore */ }
  });

  it('first 20 join requests succeed (201), 21st returns 429', async () => {
    for (let i = 1; i <= 20; i++) {
      const res = await server.join(roomCode, `Player${i}`);
      expect(res.status, `Request ${i} should be 201`).toBe(201);
      expect(res.body.success, `Request ${i} success should be true`).toBe(true);
    }

    const r21 = await server.join(roomCode, 'Player21');
    expect(r21.status, '21st request should be 429').toBe(429);
  });

  it('429 response has correct JSON format', async () => {
    const r429 = await server.join(roomCode, 'Player21Again');
    expect(r429.status).toBe(429);

    const body = r429.body as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('RATE_LIMIT');
    expect(typeof body.error.message).toBe('string');
  });

  it('22nd and 23rd requests also blocked while limit is exhausted', async () => {
    const [r22, r23] = await Promise.all([
      server.join(roomCode, 'Player22'),
      server.join(roomCode, 'Player23'),
    ]);
    expect(r22.status).toBe(429);
    expect(r23.status).toBe(429);

    const body22 = r22.body as { success: boolean; error: { code: string } };
    expect(body22.success).toBe(false);
    expect(body22.error.code).toBe('RATE_LIMIT');
  });
});
