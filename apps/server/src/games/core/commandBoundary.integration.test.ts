import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CoreRuntimeProjectionSchema } from '@quiz/shared';
import { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import { createApp } from '../../app.js';
import { createTestDatabase } from '../../test-helpers.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { socketIdentityMap } from '../../http/middleware/auth.js';
import { cancelGeoTimer, handleGeoGame } from '../geo/index.js';

let db: PrismaClient, previous: PrismaClient | undefined, dir: string, app: ReturnType<typeof createApp>, origin: string, cookie: string, hostId: string, questionIds: string[];
const sockets: Socket[] = [], roomIds: string[] = [];
let nextCode = 610000;
let beforeReceipt: (() => Promise<void>) | undefined;
async function connect(auth?: string) { const s = await connectGameClient(origin, auth); sockets.push(s); return s; }
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-g1-')); const url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url); db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db;
  db.$use(async (params, next) => {
    if (params.model === 'CommandReceipt' && params.action === 'create' && beforeReceipt) {
      const wait = beforeReceipt; beforeReceipt = undefined; await wait();
    }
    return next(params);
  });
  const user = await db.user.create({ data: { role: 'HOST', displayName: 'G1 Host', passwordHash: 'unused' } }); hostId = user.id;
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 3600000) } }); cookie = createSessionCookie(session.id, config.sessionSecret);
  for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA', minPlayers: 2 } });
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'G1' } });
  questionIds = [];
  for (let i = 0; i < 2; i++) { const q = await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'G1 question', category: 'G1', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]), correctOptionId: 'a', durationMs: 600000 } }); questionIds.push(q.id); }
  app = createApp(); await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address(); if (!address || typeof address === 'string') throw Error('NO_PORT'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const id of roomIds) cancelGeoTimer(id); for (const s of sockets) s.disconnect();
  if (app) await new Promise<void>(resolve => app.io.close(() => resolve()));
  await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(i => roomIds.includes(i.roomId ?? ''))).toHaveLength(0), { timeout: 10000 });
  await db?.$disconnect(); globalThis.__prisma = previous; if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(slug: 'wissensduell' | 'jeopardy' | 'wer-ist-das' = 'jeopardy', running = true) {
  const game = await db.gameDefinition.findUniqueOrThrow({ where: { slug } });
  const code = String(nextCode++).replace(/(\d{3})(\d{3})/, '$1-$2');
  let setup: object = { selectedQuestionIds: questionIds };
  if (slug === 'jeopardy') setup = { board1: { categories: [{ name: 'G1', clues: [{ value: 100, question: 'Question', answer: 'G1_PRIVATE_SOLUTION' }, { value: 200, question: 'Question 2', answer: 'G1_PRIVATE_SECOND' }] }] } };
  if (slug === 'wer-ist-das') {
    const image = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'g1.png', originalName: 'g1.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/g1.png', uploadedBy: hostId } });
    setup = { rounds: [{ id: 'g1', imageAssetId: image.id, person1: 'G1_PRIVATE_A', person2: 'G1_PRIVATE_B' }] };
  }
  const room = await db.room.create({ data: { code, roomName: 'G1', hostUserId: hostId, gameDefinitionId: game.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(setup) } }); roomIds.push(room.id);
  const host = await connect(cookie); expect((await gameAck(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
  const players = [];
  for (const name of ['Alice', 'Bob']) {
    const p = await db.participation.create({ data: { roomId: room.id, displayName: name, normalizedName: name.toLowerCase(), role: 'PLAYER', ready: true, rejoinToken: randomUUID() } });
    const client = await connect(); expect((await gameAck(client, 'room:subscribe', { roomCode: code, rejoinToken: p.rejoinToken })).success).toBe(true);
    await gameAck(client, 'player:ready:set', { roomCode: code, ready: true }); players.push({ ...p, client });
  }
  if (running) {
    const result = await gameAck(host, 'game:start', { roomCode: code, commandId: randomUUID() }); expect(result.success, JSON.stringify(result)).toBe(true);
    if (slug === 'wissensduell') { cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, code); cancelGeoTimer(room.id); }
  }
  return { room, code, host, players };
}
async function evidence(roomId: string) {
  return { room: await db.room.findUniqueOrThrow({ where: { id: roomId } }), state: await db.roomGameState.findUnique({ where: { roomId } }),
    events: await db.gameDomainEvent.count({ where: { roomId } }), scores: await db.scoreEvent.count({ where: { roomId } }), receipts: await db.commandReceipt.count({ where: { roomId } }) };
}
const wireActions = {
  wissensduell: [
    ['geo:answer', { optionId: 'a' }], ['geo:joker:5050', {}], ['geo:joker:spy', {}], ['geo:joker:risk', {}], ['geo:reveal', {}], ['geo:next', {}],
  ],
  jeopardy: [
    ['jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 }],
    ['jeopardy:field:lock', { boardIndex: 1, categoryIndex: 0, value: 100 }],
    ['jeopardy:buzz', {}], ['jeopardy:judge', { correct: true }], ['jeopardy:steal:buzz', {}], ['jeopardy:steal:judge', { correct: false }],
    ['jeopardy:next', {}], ['jeopardy:board:switch', { toBoard: 2 }],
  ],
  'wer-ist-das': [
    ['weristdas:buzzer:open', {}], ['weristdas:buzz', {}], ['weristdas:hint', {}], ['weristdas:judge', { result: 'WRONG' }], ['weristdas:reveal', {}], ['weristdas:next', {}],
  ],
} as const;
it.each(['wissensduell', 'jeopardy', 'wer-ist-das'] as const)('%s refuses foreign room scope for every registered engine mutation, with and without receipts', async slug => {
  const f = await fixture(slug), before = await evidence(f.room.id);
  for (const [event, payload] of wireActions[slug]) for (const receipted of [false, true]) {
    const response = await gameAck(f.host, event, { ...payload, roomCode: '999-999', ...(receipted ? { commandId: randomUUID() } : {}) });
    expect(response, event).toMatchObject({ success: false, error: 'WRONG_ROOM' });
    expect(await evidence(f.room.id), event).toEqual(before);
  }
});
it('rejects lifecycle writes from a replaced host connection before socket cleanup finishes', async () => {
  const f = await fixture('jeopardy', false);
  const host = await db.participation.findFirstOrThrow({ where: { roomId: f.room.id, role: 'HOST' } });
  await db.participation.update({ where: { id: host.id }, data: { connectionId: 'new-device' } });
  const before = await evidence(f.room.id);
  expect((await gameAck(f.host, 'room:config:update', { roomCode: f.code, expectedRevision: before.room.revision, changes: { boardCount: 2 } })).success).toBe(false);
  expect((await gameAck(f.host, 'room:resync', { roomCode: f.code })).success).toBe(false);
  expect((await gameAck(f.host, 'game:start', { roomCode: f.code, commandId: randomUUID() })).success).toBe(false);
  expect(await evidence(f.room.id)).toEqual(before);
});
it.each(['wissensduell', 'jeopardy', 'wer-ist-das'] as const)('%s rejects resync from a replaced host without projecting private state', async slug => {
  const f = await fixture(slug);
  const host = await db.participation.findFirstOrThrow({ where: { roomId: f.room.id, role: 'HOST' } });
  await db.participation.update({ where: { id: host.id }, data: { connectionId: 'new-device' } });
  const event = slug === 'wissensduell' ? 'geo:resync' : slug === 'jeopardy' ? 'jeopardy:resync' : 'weristdas:resync';
  const response = await gameAck(f.host, event, {});
  expect(response.success).toBe(false); expect(JSON.stringify(response)).not.toContain('G1_PRIVATE');
});

// The same shared contract is exercised by two real engines: accepted intent,
// terminal-phase replay, current revocation and replaced-device denial.
it.each(['jeopardy', 'wer-ist-das'] as const)('%s executes once, replays without writes, and revalidates authority before replay', async slug => {
  const f = await fixture(slug);
  const event = slug === 'jeopardy' ? 'jeopardy:field:open' : 'weristdas:buzzer:open';
  const payload = { ...(slug === 'jeopardy' ? { boardIndex: 1, categoryIndex: 0, value: 100 } : {}), roomCode: f.code, commandId: randomUUID() };
  expect((await gameAck(f.host, event, payload)).success).toBe(true);
  const after = await evidence(f.room.id);
  expect(await gameAck(f.host, event, payload)).toMatchObject({ success: true, replayed: true });
  expect(await evidence(f.room.id)).toEqual(after);
  await db.roomPermissionGrant.create({ data: { roomId: f.room.id, userId: hostId, permission: 'BUZZER_CONTROL', direction: 'REVOKE', grantedBy: hostId } });
  expect((await gameAck(f.host, event, payload)).success).toBe(false);
  expect(await evidence(f.room.id)).toEqual(after);
  await db.roomPermissionGrant.delete({ where: { roomId_userId_permission_direction: { roomId: f.room.id, userId: hostId, permission: 'BUZZER_CONTROL', direction: 'REVOKE' } } });
  const host = await db.participation.findFirstOrThrow({ where: { roomId: f.room.id, role: 'HOST' } });
  await db.participation.update({ where: { id: host.id }, data: { connectionId: 'new-device' } });
  expect((await gameAck(f.host, event, payload)).success).toBe(false);
  expect(await evidence(f.room.id)).toEqual(after);
});
it.each(['wissensduell', 'jeopardy', 'wer-ist-das'] as const)('%s denies pending players on mutation and private resync', async slug => {
  const f = await fixture(slug), p = f.players[0];
  await db.participation.update({ where: { id: p.id }, data: { admission: 'PENDING' } });
  const event = slug === 'wissensduell' ? 'geo:resync' : slug === 'jeopardy' ? 'jeopardy:resync' : 'weristdas:resync';
  const before = await evidence(f.room.id);
  expect((await gameAck(p.client, event, {})).success).toBe(false);
  expect((await gameAck(p.client, 'game:core:read', {})).success).toBe(false);
  const [action, payload] = wireActions[slug][0];
  expect((await gameAck(p.client, action, { ...payload, roomCode: f.code, commandId: randomUUID() })).success).toBe(false);
  expect(await evidence(f.room.id)).toEqual(before);
});
it('denies every private host read after authentication revocation, before socket cleanup', async () => {
  const f = await fixture('jeopardy');
  const session = await db.session.findFirstOrThrow({ where: { userId: hostId, revokedAt: null } });
  await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  for (const event of ['jeopardy:resync', 'game:core:read', 'room:core:read']) {
    const response = await gameAck(f.host, event, {});
    expect(response.success, event).toBe(false); expect(JSON.stringify(response)).not.toContain('G1_PRIVATE');
  }
  await db.session.update({ where: { id: session.id }, data: { revokedAt: null } });
});
it('checks anonymous viewer presence while preserving public resync', async () => {
  const f = await fixture('jeopardy'), viewer = await connect();
  expect((await gameAck(viewer, 'room:subscribe', { roomCode: f.code })).success).toBe(true);
  const publicView = await gameAck(viewer, 'jeopardy:resync', {});
  expect(publicView.success).toBe(true); expect(JSON.stringify(publicView)).not.toContain('G1_PRIVATE');
  const identity = socketIdentityMap.get(viewer.id!); expect(identity?.participationId).toMatch(/^viewer:/);
  await db.viewerSession.update({ where: { id: identity!.participationId!.slice(7) }, data: { connected: false } });
  for (const event of ['jeopardy:resync', 'game:core:read', 'room:core:read']) expect((await gameAck(viewer, event, {})).success, event).toBe(false);
});

it.each(['wissensduell', 'jeopardy', 'wer-ist-das'] as const)('%s refuses explicit foreign room scope on resync and core reads', async slug => {
  const f = await fixture(slug);
  const event = slug === 'wissensduell' ? 'geo:resync' : slug === 'jeopardy' ? 'jeopardy:resync' : 'weristdas:resync';
  for (const read of [event, 'game:core:read']) {
    const response = await gameAck(f.host, read, { roomCode: '999-999' });
    expect(response).toMatchObject({ success: false, error: 'WRONG_ROOM' }); expect(JSON.stringify(response)).not.toContain('G1_PRIVATE');
    expect((await gameAck(f.host, read, { roomCode: f.code })).success).toBe(true);
  }
});
it.each(['jeopardy', 'wer-ist-das'] as const)('%s lifecycle commands match available actions and preserve pause/resume replay', async slug => {
  const f = await fixture(slug);
  for (const [event, allowed, phase] of [['game:pause', 'pause', 'PAUSED'], ['game:resume', 'resume', slug === 'jeopardy' ? 'SELECTING' : 'ROUND_READY']] as const) {
    const core = await gameAck(f.host, 'game:core:read', {});
    expect(CoreRuntimeProjectionSchema.parse(core.projection).availableActions.some((a: { key: string }) => a.key === allowed)).toBe(true);
    const payload = { roomCode: f.code, commandId: randomUUID() };
    expect((await gameAck(f.host, event, payload)).success).toBe(true);
    const after = await evidence(f.room.id); expect(after.state!.phase).toBe(phase);
    expect(await gameAck(f.host, event, payload)).toMatchObject({ success: true, replayed: true });
    expect(await evidence(f.room.id)).toEqual(after);
  }
});
it.each(['jeopardy', 'wer-ist-das'] as const)('%s keeps frozen recovery state out of pause', async slug => {
  const f = await fixture(slug);
  await db.roomGameState.update({ where: { roomId: f.room.id }, data: { stateJson: '{}' } });
  const frozen = await gameAck(f.host, 'game:core:read', {});
  expect(frozen.projection).toMatchObject({ enginePhase: 'ERROR_RECOVERY', availableActions: [] });
  const before = await evidence(f.room.id);
  expect((await gameAck(f.host, 'game:pause', { roomCode: f.code, commandId: randomUUID() })).success).toBe(false);
  const after = await evidence(f.room.id);
  expect(after.state).toEqual(before.state); expect(after.events).toBe(before.events); expect(after.scores).toBe(before.scores);
});
it('rechecks lifecycle authority after an asynchronous receipt claim', async () => {
  const f = await fixture('jeopardy', false);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  beforeReceipt = async () => { entered(); await gate; };
  const before = await evidence(f.room.id);
  const response = gameAck(f.host, 'game:start', { roomCode: f.code, commandId: randomUUID() });
  try {
    await ready;
    await db.roomPermissionGrant.create({ data: { roomId: f.room.id, userId: hostId, permission: 'GAME_START', direction: 'REVOKE', grantedBy: hostId } });
    release(); expect(await response).toMatchObject({ success: false, error: 'UNAUTHORIZED' });
    const after = await evidence(f.room.id);
    expect(after.state).toEqual(before.state); expect(after.room.status).toBe('LOBBY'); expect(after.events).toBe(before.events); expect(after.scores).toBe(before.scores);
  } finally { release(); await response; beforeReceipt = undefined; }
});

it.each(['wissensduell', 'jeopardy', 'wer-ist-das'] as const)('%s preserves pre-G1 receipt fingerprints when a retry carries the newly retained locator', async slug => {
  const f = await fixture(slug);
  const event = slug === 'wissensduell' ? 'geo:answer' : slug === 'jeopardy' ? 'jeopardy:field:open' : 'weristdas:buzzer:open';
  const client = slug === 'wissensduell' ? f.players[0].client : f.host;
  const payload = { ...(slug === 'wissensduell' ? { optionId: 'a' } : slug === 'jeopardy' ? { boardIndex: 1, categoryIndex: 0, value: 100 } : {}), commandId: randomUUID() };
  expect((await gameAck(client, event, payload)).success).toBe(true);
  const after = await evidence(f.room.id);
  expect(await gameAck(client, event, { ...payload, roomCode: f.code })).toMatchObject({ success: true, replayed: true });
  expect(await evidence(f.room.id)).toEqual(after);
  expect(await gameAck(client, event, { ...payload, roomCode: '999-999' })).toMatchObject({ success: false, error: 'WRONG_ROOM' });
  expect(await evidence(f.room.id)).toEqual(after);
});

it.each(['jeopardy', 'wer-ist-das'] as const)('%s applies current abort authority to the room emergency route, including receipt replay', async slug => {
  const f = await fixture(slug);
  const payload = { roomCode: f.code, commandId: randomUUID(), protocolVersion: 1, operation: { type: 'EMERGENCY', action: 'ABORT_GAME', points: 'KEEP_POINTS' } };
  expect((await gameAck(f.host, 'room:command', payload)).success).toBe(true);
  const after = await evidence(f.room.id); expect(after.room.status).toBe('ENDED');
  expect(await gameAck(f.host, 'room:command', payload)).toMatchObject({ success: true, replayed: true });
  await db.roomPermissionGrant.create({ data: { roomId: f.room.id, userId: hostId, permission: 'GAME_ABORT', direction: 'REVOKE', grantedBy: hostId } });
  expect(await gameAck(f.host, 'room:command', payload)).toMatchObject({ success: false, error: 'NOT_AUTHORIZED' });
  expect(await evidence(f.room.id)).toEqual(after);
});

it('does not return saved credentials after permission or ownership is lost', async () => {
  const f = await fixture('jeopardy', false);
  const payload = { roomCode: f.code, commandId: randomUUID(), protocolVersion: 1, operation: { type: 'TOKEN_ROTATE', participantId: f.players[0].id } };
  const issued = await gameAck(f.host, 'room:command', payload); expect(issued.success).toBe(true); expect(issued.rejoinToken).toBeTypeOf('string');
  await db.roomPermissionGrant.create({ data: { roomId: f.room.id, userId: hostId, permission: 'PLAYER_MANAGE', direction: 'REVOKE', grantedBy: hostId } });
  const denied = await gameAck(f.host, 'room:command', payload);
  expect(denied).toMatchObject({ success: false, error: 'NOT_AUTHORIZED' }); expect(denied).not.toHaveProperty('rejoinToken');
  const invite = { roomCode: f.code, commandId: randomUUID(), protocolVersion: 1, operation: { type: 'INVITE', role: 'VIEWER' } };
  expect((await gameAck(f.host, 'room:command', invite)).success).toBe(true);
  const owner = await db.user.create({ data: { role: 'HOST', displayName: 'New owner', passwordHash: 'unused' } });
  await db.room.update({ where: { id: f.room.id }, data: { hostUserId: owner.id } });
  const oldOwner = await gameAck(f.host, 'room:command', invite);
  expect(oldOwner).toMatchObject({ success: false, error: 'OWNER_REQUIRED' }); expect(oldOwner).not.toHaveProperty('inviteToken');
});
