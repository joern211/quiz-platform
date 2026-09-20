// ============================================================
// Rooms Integration Tests — using createApp() factory + supertest
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../persistence/prisma.js';
import {
  seedTestUser,
  getOrCreateGeoGame,
  cleanupTestSessions,
} from '../test-helpers.js';

const request = supertest(createApp().app);

// ── Helpers ─────────────────────────────────────────────────

async function createTestRoom(opts: {
  hostUserId: string;
  code?: string;
  status?: string;
  pinHash?: string | null;
  maxPlayers?: number;
  isPublic?: boolean;
}) {
  const code =
    opts.code ??
    `${String(Math.floor(Math.random() * 900) + 100)}-${String(
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
      status: opts.status ?? 'LOBBY',
      pinHash: opts.pinHash ?? null,
      maxPlayers: opts.maxPlayers ?? 10,
      isPublic: opts.isPublic ?? true,
      setupSnapshotJson: '{}',
      setupSchemaVersion: 1,
      runPhase: 'LOBBY',
      revision: 0,
    },
  });
  return code;
}

async function cleanupTestData(codes: string[] = []) {
  await prisma.participation.deleteMany({
    where: {
      OR: codes.map((code) => ({ room: { code } })),
    },
  });
  await prisma.room.deleteMany({ where: { code: { in: codes } } });
  await cleanupTestSessions();
}

describe('Rooms API — Create Room', () => {
  let cookie: string;
  let geoDefId: string;
  let geoDefSlug: string;

  beforeEach(async () => {
    await cleanupTestData();
    const result = await seedTestUser(
      'mod-create-1',
      'RoomCreator',
      'mod-create-1@test.local',
    );
    cookie = result.cookie;
    const geoDef = await getOrCreateGeoGame();
    geoDefId = geoDef.id;
    geoDefSlug = geoDef.slug;
  });

  afterEach(async () => {
    await cleanupTestData();
  });

  it('POST /api/v1/rooms — should create room with valid session', async () => {
    const res = await request
      .post('/api/v1/rooms')
      .set('Cookie', cookie)
      .send({ gameSlug: geoDefSlug, gameDefinitionId: geoDefId, roomName: 'My Test Room' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.code).toMatch(/^\d{3}-\d{3}$/);
    expect(res.body.data.roomId).toBeTruthy();
    expect(res.body.data.moderatorToken).toBeTruthy();

    await cleanupTestData([res.body.data.code]);
  });

  it('POST /api/v1/rooms — should reject unauthenticated request with 401', async () => {
    const res = await request
      .post('/api/v1/rooms')
      .send({ gameDefinitionId: geoDefId, roomName: 'Private Room' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_AUTHENTICATED');
  });

  it('POST /api/v1/rooms — should reject missing game definition', async () => {
    const res = await request
      .post('/api/v1/rooms')
      .set('Cookie', cookie)
      .send({ roomName: 'Room Without Game', gameSlug: 'non-existent-game-slug' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/v1/rooms — should reject missing roomName', async () => {
    const res = await request
      .post('/api/v1/rooms')
      .set('Cookie', cookie)
      .send({ gameSlug: geoDefSlug });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION');
  });
});

describe('Rooms API — List & Get Room', () => {
  let cookie: string;
  let roomCode: string;

  beforeEach(async () => {
    await cleanupTestData();
    const result = await seedTestUser(
      'mod-list-1',
      'Lister',
      'mod-list-1@test.local',
    );
    cookie = result.cookie;
    roomCode = await createTestRoom({ hostUserId: result.userId });
  });

  afterEach(async () => {
    await cleanupTestData([roomCode]);
  });

  it('GET /api/v1/rooms/public — should list public LOBBY/RUNNING rooms', async () => {
    const res = await request.get('/api/v1/rooms/public');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    const found = res.body.data.find(
      (r: { code: string }) => r.code === roomCode,
    );
    expect(found).toBeDefined();
    expect(found.status).toBe('LOBBY');
  });

  it('GET /api/v1/rooms/:code — should return room details', async () => {
    const res = await request.get(`/api/v1/rooms/${roomCode}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.code).toBe(roomCode);
  });

  it('GET /api/v1/rooms/:code — should return 404 for unknown code', async () => {
    const res = await request.get('/api/v1/rooms/999-999');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /api/v1/rooms/:code — private rooms hidden from unauthenticated users', async () => {
    // Create a private room
    const result = await seedTestUser(
      'mod-private-1',
      'PrivateHost',
      'mod-private-1@test.local',
    );
    const privateCode = await createTestRoom({
      hostUserId: result.userId,
      isPublic: false,
    });

    const res = await request.get(`/api/v1/rooms/${privateCode}`);

    // Without auth, non-public rooms are hidden as 404
    expect(res.status).toBe(404);

    await cleanupTestData([privateCode]);
  });

  it('GET /api/v1/rooms/:code — host can retrieve own private room', async () => {
    const res = await request
      .get(`/api/v1/rooms/${roomCode}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe(roomCode);
  });
});

describe('Rooms API — Join Room', () => {
  let roomCode: string;

  beforeEach(async () => {
    await cleanupTestData();
    const result = await seedTestUser(
      'mod-join-1',
      'JoinHost',
      'mod-join-1@test.local',
    );
    // maxPlayers=1 so moderator already occupies it, leaving no slot for player
    roomCode = await createTestRoom({
      hostUserId: result.userId,
      maxPlayers: 1,
      pinHash: null,
    });
  });

  afterEach(async () => {
    await cleanupTestData([roomCode]);
  });

  it('POST /api/v1/rooms/:code/join — should create participation with rejoinToken', async () => {
    // Create a room with a free slot
    const host = await seedTestUser(
      'mod-join-slot-1',
      'SlotHost',
      'mod-join-slot-1@test.local',
    );
    const freeCode = await createTestRoom({
      hostUserId: host.userId,
      maxPlayers: 10,
      pinHash: null,
    });

    const res = await request
      .post(`/api/v1/rooms/${freeCode}/join`)
      .send({ displayName: 'JoinPlayer' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rejoinToken).toBeTruthy();
    expect(res.body.data.participationId).toBeTruthy();
    expect(res.body.data.role).toBe('PLAYER');
    expect(res.body.data.roomCode).toBe(freeCode);

    await cleanupTestData([freeCode]);
  });

  it('POST /api/v1/rooms/:code/join — wrong PIN returns 403', async () => {
    const host = await seedTestUser(
      'mod-pin-1',
      'PinHost',
      'mod-pin-1@test.local',
    );
    const argon2 = (await import('argon2')).default;
    const pinHash = await argon2.hash('1234', { type: argon2.argon2id });
    const pinCode = await createTestRoom({
      hostUserId: host.userId,
      pinHash,
    });

    // Must use a valid 4-digit PIN (Zod validation) to test PIN mismatch
    const res = await request
      .post(`/api/v1/rooms/${pinCode}/join`)
      .send({ displayName: 'PinBreaker', pin: '9999' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('INVALID_PIN');

    await cleanupTestData([pinCode]);
  });

  it('POST /api/v1/rooms/:code/join — room full returns 400', async () => {
    // Create a room that already has players filling it (maxPlayers=1, one player already joined)
    const host = await seedTestUser(
      'mod-full-1',
      'FullHost',
      'mod-full-1@test.local',
    );
    // Use maxPlayers=1: first player joins successfully, second is rejected
    const fullCode = await createTestRoom({
      hostUserId: host.userId,
      maxPlayers: 1,
      pinHash: null,
    });

    // First player joins (now playerCount=1, maxPlayers=1 → room full)
    const first = await request
      .post(`/api/v1/rooms/${fullCode}/join`)
      .send({ displayName: 'FirstPlayer' });
    expect(first.status).toBe(201);

    // Second player should be rejected
    const second = await request
      .post(`/api/v1/rooms/${fullCode}/join`)
      .send({ displayName: 'ExtraPlayer' });

    expect(second.status).toBe(400);
    expect(second.body.success).toBe(false);
    expect(second.body.error.code).toBe('ROOM_FULL');

    await cleanupTestData([fullCode]);
  });

  it('POST /api/v1/rooms/:code/join — non-joinable room (RUNNING) returns 400', async () => {
    const host = await seedTestUser(
      'mod-running-1',
      'RunningHost',
      'mod-running-1@test.local',
    );
    const runningCode = await createTestRoom({
      hostUserId: host.userId,
      status: 'RUNNING',
    });

    const res = await request
      .post(`/api/v1/rooms/${runningCode}/join`)
      .send({ displayName: 'LateJoiner' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('ROOM_NOT_JOINABLE');

    await cleanupTestData([runningCode]);
  });

  it('POST /api/v1/rooms/:code/join — PIN required when room has PIN', async () => {
    const host = await seedTestUser(
      'mod-pinreq-1',
      'PinReqHost',
      'mod-pinreq-1@test.local',
    );
    const argon2 = (await import('argon2')).default;
    const pinHash = await argon2.hash('9999', { type: argon2.argon2id });
    const pinCode = await createTestRoom({
      hostUserId: host.userId,
      pinHash,
    });

    const res = await request
      .post(`/api/v1/rooms/${pinCode}/join`)
      .send({ displayName: 'NoPin' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_PIN');

    await cleanupTestData([pinCode]);
  });

  it('POST /api/v1/rooms/:code/join — correct PIN joins successfully', async () => {
    const host = await seedTestUser(
      'mod-corrpin-1',
      'CorrPinHost',
      'mod-corrpin-1@test.local',
    );
    const argon2 = (await import('argon2')).default;
    const pinHash = await argon2.hash('5678', { type: argon2.argon2id });
    const pinCode = await createTestRoom({
      hostUserId: host.userId,
      pinHash,
      maxPlayers: 10,
    });

    const res = await request
      .post(`/api/v1/rooms/${pinCode}/join`)
      .send({ displayName: 'CorrectPinPlayer', pin: '5678' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.rejoinToken).toBeTruthy();

    await cleanupTestData([pinCode]);
  });
});
