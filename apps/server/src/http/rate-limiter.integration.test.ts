// ============================================================
// Join Rate-Limiter Integration Tests
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import {
  seedTestUser,
  getOrCreateGeoGame,
  cleanupTestSessions,
} from '../test-helpers.js';

const request = supertest(createApp().app);

async function createTestRoom(opts: {
  hostUserId: string;
  maxPlayers?: number;
}) {
  const { prisma } = await import('../persistence/prisma.js');
  const code = `${String(Math.floor(Math.random() * 900) + 100)}-${String(
    Math.floor(Math.random() * 900) + 100,
  )}`;
  const geoDef = await getOrCreateGeoGame();
  await prisma.room.upsert({
    where: { code },
    update: {},
    create: {
      code,
      roomName: `Test Room ${code}`,
      hostUserId: opts.hostUserId,
      gameDefinitionId: geoDef.id,
      status: 'LOBBY',
      pinHash: null,
      maxPlayers: opts.maxPlayers ?? 10,
      isPublic: true,
      setupSnapshotJson: '{}',
      setupSchemaVersion: 1,
      runPhase: 'LOBBY',
      revision: 0,
    },
  });
  return code;
}

describe('Rate Limiter — Join Route', () => {
  let roomCode: string;

  beforeEach(async () => {
    await cleanupTestSessions();
    const result = await seedTestUser(
      'mod-rl-1',
      'RateLimitHost',
      'mod-rl-1@test.local',
    );
    roomCode = await createTestRoom({ hostUserId: result.userId, maxPlayers: 10 });
  });

  afterEach(async () => {
    await cleanupTestSessions();
  });

  it('in development mode: joins are not rate-limited', async () => {
    // NODE_ENV=test → rate limiter is NOT active (no-op)
    // Send 5 rapid requests — all should succeed
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request
          .post(`/api/v1/rooms/${roomCode}/join`)
          .send({ displayName: `Player${i}` }),
      ),
    );

    // All should be 201 (first one) or 400 if room fills up
    // In dev mode, the noop middleware doesn't block
    expect(results.every((r) => r.status === 201 || r.status === 400)).toBe(true);
  });

  it('join endpoint is reachable and uses real middleware chain', async () => {
    // The fact that this returns 201 proves the route is registered
    // and the middleware chain processes the request
    const res = await request
      .post(`/api/v1/rooms/${roomCode}/join`)
      .send({ displayName: 'TestPlayer' });

    // In dev mode, this should succeed
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

describe('Rate Limiter — Config', () => {
  it('joinLimiter is active in production NODE_ENV', async () => {
    // Read the actual source to verify production conditional
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, resolve } = await import('path');

    const _dirname = dirname(fileURLToPath(import.meta.url));
    const roomsSrc = readFileSync(
      resolve(_dirname, '../http/rooms.ts'),
      'utf8',
    );

    // Verify the production conditional exists in the source
    expect(roomsSrc).toContain("NODE_ENV === 'production'");
    // Verify joinLimiter is applied to the join route
    expect(roomsSrc).toContain("roomsRouter.post('/:code/join', joinLimiter");
  });
});
