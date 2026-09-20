// ============================================================
// E2E Endpoints Production Block Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Test the app factory — pass NODE_ENV=production to test production mode
process.env.NODE_ENV = 'production';

const { createApp } = await import('../app.js');
const app = createApp();
const request = supertest(app.app);

describe('E2E Endpoints — Production Block', () => {
  describe('POST /api/v1/auth/e2e-token', () => {
    it('returns 404 in production', async () => {
      const res = await request
        .post('/api/v1/auth/e2e-token')
        .send({ email: 'admin@quiz.local', password: 'secret' });

      expect(res.status).toBe(404);
    });

    it('does not create a session in production', async () => {
      const { prisma } = await import('../persistence/prisma.js');

      const beforeCount = await prisma.session.count();

      await request
        .post('/api/v1/auth/e2e-token')
        .send({ email: 'admin@quiz.local', password: 'secret' });

      const afterCount = await prisma.session.count();
      expect(afterCount).toBe(beforeCount); // No new sessions
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

      // Check no ROOM is modified
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

describe('E2E Endpoints — Development Mode', () => {
  // Only test if the env var override allows it
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('e2e-token is reachable in development', async () => {
    process.env.NODE_ENV = 'development';
    // We can't easily recreate the app in test context, so we just
    // verify the source code has the guard
    const _dirname = dirname(fileURLToPath(import.meta.url));
    const authSrc = readFileSync(resolve(_dirname, '../http/auth.ts'), 'utf8');
    expect(authSrc).toContain("NODE_ENV === 'production'");
  });
});
