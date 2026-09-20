// ============================================================
// Join Rate-Limiter Integration Tests
// Tests verify:
//  1. Dev mode: joins work normally (rate limiter is a no-op)
//  2. Prod mode: joinLimiter fires at 20 requests (max=20, windowMs=15min)
// ============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  seedTestUser,
  getOrCreateGeoGame,
  cleanupTestSessions,
} from '../test-helpers.js';
import { prisma } from '../persistence/prisma.js';

// ── Architecture ─────────────────────────────────────────────
// joinLimiter is created at module-load time in rooms.ts, using the
// process.env.NODE_ENV that was present when rooms.ts was first imported.
// Since modules are cached by Node.js, the limiter instance is sticky.
//
// This means a single server process accumulates all requests in its
// limiter counter.  We launch ONE persistent background server per
// describe-block, send all requests to it (via supertest pointing at the
// background process's HTTP port), then tear it down.
//
// The port is communicated back via a temporary file written by the server.

const serverDir = dirname(fileURLToPath(import.meta.url));
const nodeBin = process.execPath;
const appPath = pathResolve(serverDir, '../../dist/app.js');

interface JoinResult { status: number; body: Record<string, unknown> }

/**
 * A persistent production-mode server for one test suite.
 * Launched once in beforeAll, killed in afterAll.
 * All requests share the same process so they hit the SAME joinLimiter instance.
 */
class ProdServer {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private stderr = '';
  private tmpScript = '';
  private tmpPortFile = '';
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.tmpScript = `/tmp/quiz-prod-server-${id}.mjs`;
    this.tmpPortFile = `/tmp/quiz-prod-port-${id}.txt`;

    const scriptBody = `
import { createApp } from ${JSON.stringify(appPath)};
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const { app } = createApp();
const server = createServer(app);

await new Promise((resolve, reject) => {
  server.listen(0, '127.0.0.1', (err) => { if (err) reject(err); else resolve(undefined); });
});

const port = server.address().port;
// Signal port to parent process
writeFileSync(${JSON.stringify(this.tmpPortFile)}, String(port), 'utf8');

// Keep alive until killed
await new Promise(() => {});
`.trim();

    writeFileSync(this.tmpScript, scriptBody);

    this.child = spawn(nodeBin, [this.tmpScript], {
      cwd: pathResolve(serverDir, '../..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        SESSION_SECRET: process.env.SESSION_SECRET ?? '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stderr!.on('data', (d: Buffer) => { this.stderr += d; });

    // Wait for port file to appear (server is ready)
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
  }

  async stop(): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    try { unlinkSync(this.tmpScript); } catch { /* ignore */ }
    try { unlinkSync(this.tmpPortFile); } catch { /* ignore */ }
    this.port = null;
    this.started = false;
  }

  /** Send a POST /api/v1/rooms/:code/join to the background server. */
  async join(roomCode: string, displayName: string): Promise<JoinResult> {
    if (!this.port) throw new Error('ProdServer not started');
    const res = await supertest(`http://127.0.0.1:${this.port}`)
      .post(`/api/v1/rooms/${roomCode}/join`)
      .send({ displayName });
    return { status: res.status, body: res.body as Record<string, unknown> };
  }
}

// ── Shared helpers ───────────────────────────────────────────

async function createTestRoom(opts: {
  hostUserId: string;
  maxPlayers?: number;
}): Promise<string> {
  // normalizeRoomCode() strips non-digits, takes first 6, pads to NNN-NNN.
  const raw = `${String(Math.floor(Math.random() * 900) + 100)}-${String(
    Math.floor(Math.random() * 900) + 100,
  )}`;
  const geoDef = await getOrCreateGeoGame();
  await prisma.room.upsert({
    where: { code: raw },
    update: {},
    create: {
      code: raw,
      roomName: `Test Room ${raw}`,
      hostUserId: opts.hostUserId,
      gameDefinitionId: geoDef.id,
      status: 'LOBBY',
      pinHash: null,
      maxPlayers: opts.maxPlayers ?? 30,
      isPublic: true,
      setupSnapshotJson: '{}',
      setupSchemaVersion: 1,
      runPhase: 'LOBBY',
      revision: 0,
    },
  });
  return raw;
}

// ============================================================
// Dev-mode tests — rate limiter is a no-op, joins must work
// ============================================================

describe('Rate Limiter — Join Route (dev mode)', () => {
  let roomCode: string;

  beforeEach(async () => {
    await cleanupTestSessions();
    const result = await seedTestUser(
      `mod-rl-dev-${Date.now()}`,
      'RateLimitHost',
      `mod-rl-dev-${Date.now()}@test.local`,
    );
    roomCode = await createTestRoom({ hostUserId: result.userId, maxPlayers: 30 });
  });

  afterEach(async () => {
    await cleanupTestSessions();
  });

  it('joins are not rate-limited in development', async () => {
    // NODE_ENV=test → joinLimiter is a no-op (passes through without tracking)
    const { createApp } = await import('../app.js');
    const { app } = createApp();

    const requests = Array.from({ length: 5 }, (_, i) =>
      supertest(app)
        .post(`/api/v1/rooms/${roomCode}/join`)
        .send({ displayName: `Player${i}` }),
    );
    const results = await Promise.all(requests);

    // All should be 201 (first) or 400 if room fills up.
    // In dev mode the noop middleware never blocks.
    expect(results.every((r) => r.status === 201 || r.status === 400)).toBe(true);
  });

  it('join endpoint is reachable and uses real middleware chain', async () => {
    const { createApp } = await import('../app.js');
    const { app } = createApp();

    const res = await supertest(app)
      .post(`/api/v1/rooms/${roomCode}/join`)
      .send({ displayName: 'TestPlayer' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

// ============================================================
// Production-mode tests — single persistent server, real limiter
// joinLimiter: max=20 requests per IP per 15 minutes
// ============================================================

describe('Rate Limiter — Production (real behavior)', () => {
  let roomCode: string;
  // One server shared across all requests within this describe block so all
  // 21 requests hit the SAME joinLimiter instance and its request counter.
  const server = new ProdServer();

  beforeAll(async () => {
    await cleanupTestSessions();
    const id = `mod-rl-prod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const result = await seedTestUser(id, `RateLimitHost${id}`, `${id}@test.local`);
    roomCode = await createTestRoom({ hostUserId: result.userId, maxPlayers: 30 });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    await cleanupTestSessions();
  });

  it('first 20 join requests succeed, 21st returns 429 with correct body', async () => {
    // First 20: all must succeed (201 = created session + joined room)
    for (let i = 1; i <= 20; i++) {
      const res = await server.join(roomCode, `RatePlayer${i}`);
      expect(res.status, `Request ${i} should succeed`).toBe(201);
      expect(res.body.success, `Request ${i} body.success should be true`).toBe(true);
    }

    // 21st: joinLimiter fires and returns 429
    const res21 = await server.join(roomCode, 'RatePlayer21');
    expect(res21.status, '21st request should be 429').toBe(429);
    expect(res21.body).toEqual({
      success: false,
      error: {
        code: 'RATE_LIMIT',
        message: 'Zu viele Beitrittsversuche. Bitte 15 Minuten warten.',
      },
    });
  });

  it('rate limit fires only after 20 requests, 22nd also blocked', async () => {
    // After the first test exhausted the limit, both should be 429 immediately.
    const [res21, res22] = await Promise.all([
      server.join(roomCode, 'Rate21'),
      server.join(roomCode, 'Rate22'),
    ]);

    expect(res21.status).toBe(429);
    expect(res22.status).toBe(429);
    expect(res21.body).toHaveProperty('error');
    expect((res21.body as Record<string, unknown>).error).toHaveProperty('code', 'RATE_LIMIT');
    expect(res22.body).toHaveProperty('error');
    expect((res22.body as Record<string, unknown>).error).toHaveProperty('code', 'RATE_LIMIT');
  });
});
