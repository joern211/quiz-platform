import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
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
async function connect(auth?: string) { const s = await connectGameClient(origin, auth); sockets.push(s); return s; }
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-g1-')); const url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url); db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db;
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
it.each(['geo:reveal', 'geo:next'] as const)('%s refuses an explicit foreign room instead of rewriting it to the current room', async event => {
  const f = await fixture('wissensduell');
  if (event === 'geo:next') expect((await gameAck(f.host, 'geo:reveal', { roomCode: f.code, commandId: randomUUID() })).success).toBe(true);
  const before = await evidence(f.room.id);
  expect(await gameAck(f.host, event, { roomCode: '999-999', commandId: randomUUID() })).toMatchObject({ success: false, error: 'WRONG_ROOM' });
  expect(await evidence(f.room.id)).toEqual(before);
});
it.each(['jeopardy', 'wer-ist-das'] as const)('%s retains explicit room scope at its wire adapter', async slug => {
  const f = await fixture(slug), before = await evidence(f.room.id);
  const event = slug === 'jeopardy' ? 'jeopardy:field:open' : 'weristdas:buzzer:open';
  const payload = slug === 'jeopardy' ? { boardIndex: 1, categoryIndex: 0, value: 100 } : {};
  expect(await gameAck(f.host, event, { ...payload, roomCode: '999-999', commandId: randomUUID() })).toMatchObject({ success: false, error: 'WRONG_ROOM' });
  expect(await evidence(f.room.id)).toEqual(before);
});
it('rejects lifecycle writes from a replaced host connection before socket cleanup finishes', async () => {
  const f = await fixture('jeopardy', false);
  const host = await db.participation.findFirstOrThrow({ where: { roomId: f.room.id, role: 'HOST' } });
  await db.participation.update({ where: { id: host.id }, data: { connectionId: 'new-device' } });
  const before = await evidence(f.room.id);
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
