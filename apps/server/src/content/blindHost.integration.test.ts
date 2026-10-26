import { z } from 'zod';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import sharp from 'sharp';
import { createApp } from '../app.js';
import { createTestDatabase } from '../test-helpers.js';
import { createSessionCookie } from '../auth/session.js';
import { config } from '../config/index.js';
import { connectGameClient, gameAck } from '../test-socket-harness.js';
import { handleGeoGame, cancelGeoTimer } from '../games/geo/index.js';
import { socketIdentityMap } from '../http/middleware/auth.js';
import { contentMediaUrl } from './media.js';
import { buildSignedMediaUrl } from '../media/signedUrl.js';
import { ContentSelectionSchema } from '@quiz/shared';

let dir: string, db: PrismaClient, previous: PrismaClient | undefined, app: ReturnType<typeof createApp>, origin: string;
const rooms: string[] = [];
const api = (cookie = '') => ({ get: (path: string) => supertest(app.app).get(`/api/v1/content${path}`).set('Cookie', cookie), post: (path: string, data: object) => supertest(app.app).post(`/api/v1/content${path}`).set('Cookie', cookie).send(data) });
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'quiz-blind-')); const url = `file:${join(dir, 'test.db')}`; await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db; app = createApp();
  for (const slug of ['wissensduell', 'jeopardy']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA' } });
  await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve)); const address = app.httpServer.address(); if (!address || typeof address === 'string') throw Error('NO_PORT'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { for (const id of rooms) cancelGeoTimer(id); await new Promise<void>(resolve => app.io.close(() => resolve())); await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(v => rooms.includes(v.roomId ?? ''))).toHaveLength(0), { timeout: 10000 }); await db.$disconnect(); globalThis.__prisma = previous; await rm(dir, { recursive: true, force: true }); });
async function fixture(slug = 'wissensduell', media = false) {
  const user = await db.user.create({ data: { role: 'HOST', displayName: randomUUID(), passwordHash: 'unused' } });
  const session = await db.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) } }), cookie = createSessionCookie(session.id, config.sessionSecret);
  const p = await api(cookie).post('/pools', { commandId: randomUUID(), gameSlug: slug, name: 'Blind pool' }); expect(p.status).toBe(201);
  const items = [], assets = [];
  for (let i = 0; i < 2; i++) {
    let extra = {};
    if (media) { const path = join(dir, `${randomUUID()}.png`); await writeFile(path, await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer());
      const asset = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: randomUUID(), originalName: 'blind.png', fileSize: 100, sha256: randomUUID(), storagePath: path, uploadedBy: user.id, visibility: 'PRIVATE', processStatus: 'READY' } }); assets.push(asset);
      extra = { mediaAssetId: asset.id, mediaType: 'image', mediaRights: { ownMaterial: true, source: '', sourceUrl: '', author: '', license: '', recognizablePerson: false, consent: false } };
    }
    const payload = slug === 'wissensduell' ? { prompt: `BLIND_PROMPT_${i}`, category: 'Blind', options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }], correctOptionId: 'b', explanation: `BLIND_SECRET_${i}`, durationMs: 60000, ...extra }
      : { question: `BLIND_PROMPT_${i}`, category: 'Blind', value: 100 * (i + 1), answer: `BLIND_SECRET_${i}`, ...extra };
    const q = await api(cookie).post(`/pools/${p.body.data.id}/items`, { commandId: randomUUID(), item: { title: `Blind ${i}`, payload } }); expect(q.status).toBe(201);
    const ready = await api(cookie).post(`/items/${q.body.data.id}/status`, { commandId: randomUUID(), revision: 1, status: 'READY' }); expect(ready.status).toBe(200); items.push(ready.body.data);
  }
  const selection = { poolIds: [p.body.data.id], count: 2, visibility: 'BLIND_HOST' };
  const create = (selectionOverride: object = selection) => supertest(app.app).post('/api/v1/rooms').set('Cookie', cookie).send({ gameSlug: slug, roomName: 'Blind room', idempotencyKey: randomUUID(), setupSnapshotJson: { contentSelection: selectionOverride } });
  return { user, cookie, pool: p.body.data, items, assets, selection, create };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.create(); expect(created.status).toBe(201); const room = await db.room.findUniqueOrThrow({ where: { id: created.body.data.roomId } }); rooms.push(room.id);
  const players = [];
  for (const displayName of ['Alice', 'Bob']) players.push(await db.participation.create({ data: { roomId: room.id, role: 'PLAYER', displayName, normalizedName: displayName.toLowerCase(), ready: true, connected: true, rejoinToken: randomUUID() } }));
  const host = await connectGameClient(origin, f.cookie); const subscribed = await gameAck(host, 'room:subscribe', { roomCode: room.code }); expect(subscribed.success).toBe(true); expect(JSON.stringify(subscribed)).not.toMatch(/BLIND_PROMPT|BLIND_SECRET/);
  expect((await db.participation.findFirstOrThrow({ where: { roomId: room.id, role: 'HOST' } })).hasSeenHostSecrets).toBe(false);
  expect((await gameAck(host, 'game:start', { roomCode: room.code, commandId: randomUUID() })).success).toBe(true);
  return { room, host, players };
}
it('requires RANDOM-only and excludes a parallel room oracle, while keeping host-preview defaults unchanged', async () => {
  expect(ContentSelectionSchema.safeParse({ poolIds: ['p'], visibility: 'BLIND_HOST', mode: 'MANUAL', itemIds: ['q'] }).success).toBe(false);
  expect(ContentSelectionSchema.safeParse({ poolIds: ['p'], visibility: 'BLIND_HOST', itemIds: ['q'] }).success).toBe(false);
  const f = await fixture(), ordinary = await f.create({ ...f.selection, visibility: 'HOST_PREVIEW' }); expect(ordinary.status).toBe(201); rooms.push(ordinary.body.data.roomId);
  const denied = await f.create(); expect(denied.status).toBe(409); expect(denied.body.error.code).toBe('BLIND_HOST_OTHER_ACTIVE_ROOM');
  await supertest(app.app).delete(`/api/v1/rooms/${ordinary.body.data.code}`).set('Cookie', f.cookie).expect(200);
  const created = await f.create(); expect(created.status).toBe(201); rooms.push(created.body.data.roomId);
  expect((await f.create({ ...f.selection, visibility: 'HOST_PREVIEW' })).status).toBe(409);
  const info = await supertest(app.app).get(`/api/v1/rooms/${created.body.data.code}`).set('Cookie', f.cookie); expect(info.body.data.contentVisibility).toBe('BLIND_HOST'); expect(JSON.stringify(info.body)).not.toMatch(/BLIND_PROMPT|BLIND_SECRET/);
});
it('hides solutions and answer statistics through real quiz events, pause, authenticated rejoin and the persisted projection', async () => {
  const f = await fixture(), { room, host, players } = await start(f); let rejoined: Awaited<ReturnType<typeof connectGameClient>> | undefined;
  const player = await connectGameClient(origin); const privateAnswers: unknown[] = []; host.on('geo:answered:moderator', p => privateAnswers.push(p));
  try {
    cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, room.code);
    const projection = await gameAck(host, 'geo:resync', { blindHost: false, role: 'HOST' }); expect(projection.blindHost).toBe(true); expect(JSON.stringify(projection)).not.toMatch(/correctOptionId|BLIND_SECRET|answerStats/);
    await gameAck(player, 'room:subscribe', { roomCode: room.code, rejoinToken: players[0].rejoinToken });
    expect((await gameAck(player, 'geo:answer', { optionId: 'a', commandId: randomUUID() })).success).toBe(true); expect(privateAnswers).toHaveLength(0);
    expect((await gameAck(host, 'game:pause', { roomCode: room.code, commandId: randomUUID() })).success).toBe(true);
    host.disconnect(); rejoined = await connectGameClient(origin, f.cookie); await gameAck(rejoined, 'room:subscribe', { roomCode: room.code });
    const resumed = await gameAck(rejoined, 'geo:resync', {}); expect(resumed.phase).toBe('PAUSED'); expect(JSON.stringify(resumed)).not.toMatch(/correctOptionId|BLIND_SECRET|answerStats/);
    const durable = new PrismaClient({ datasourceUrl: `file:${join(dir, 'test.db')}` }); try { expect((await durable.room.findUniqueOrThrow({ where: { id: room.id } })).contentVisibility).toBe('BLIND_HOST'); } finally { await durable.$disconnect(); }
    expect((await gameAck(rejoined, 'game:resume', { roomCode: room.code, commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(rejoined, 'geo:reveal', { roomCode: room.code, commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(rejoined, 'geo:resync', {})).question).toHaveProperty('correctOptionId', 'b');
  } finally { host.disconnect(); rejoined?.disconnect(); player.disconnect(); cancelGeoTimer(room.id); }
});
it('blocks editorial, setup, export, template and pre-created playtest read paths until the blind game is closed', async () => {
  const f = await fixture(); const test = await api(f.cookie).post('/playtests', { commandId: randomUUID(), poolId: f.pool.id, items: f.items.map(q => ({ id: q.id, revision: q.revision })) }); expect(test.status).toBe(201);
  const created = await f.create(); expect(created.status).toBe(201); rooms.push(created.body.data.roomId);
  for (const path of [`/pools/${f.pool.id}`, `/pools/${f.pool.id}/export?format=JSON`, `/items/${f.items[0].id}/history`, `/items/${f.items[0].id}/preview?role=HOST&reveal=true`, '/templates/catalog?gameSlug=wissensduell', '/setup-blueprints?gameSlug=wissensduell']) {
    const r = await api(f.cookie).get(path); expect(r.status, path).toBe(403); expect(JSON.stringify(r.body)).not.toMatch(/BLIND_PROMPT|BLIND_SECRET/);
  }
  expect((await api(f.cookie).get('/pools')).status).toBe(200); expect((await supertest(app.app).get('/api/v1/setups/unknown').set('Cookie', f.cookie)).status).toBe(403);
  expect((await api().get(`/playtests/${test.body.data.code}`)).status).toBe(404);
  await supertest(app.app).delete(`/api/v1/rooms/${created.body.data.code}`).set('Cookie', f.cookie).expect(200);
  expect((await api(f.cookie).get(`/items/${f.items[0].id}/preview?role=HOST`)).status).toBe(200);
});
it('fences editor/host/playtest media capabilities while delivering only the active pinned question', async () => {
  const f = await fixture('wissensduell', true); const url = (await api(f.cookie).get(`/items/${f.items[0].id}/media`)).body.data.url;
  const { room, host } = await start(f);
  try { cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, room.code);
    expect((await supertest(app.app).get(url).set('Cookie', f.cookie)).status).toBe(403);
    expect((await supertest(app.app).get(buildSignedMediaUrl({ assetId: f.assets[0].id, audience: 'host' })).set('Cookie', f.cookie)).status).toBe(403);
    const view = await gameAck(host, 'geo:resync', {}), question = z.object({ id: z.string(), mediaUrl: z.string() }).parse(view.question); expect((await supertest(app.app).get(question.mediaUrl)).status).toBe(200);
    const future = f.items.find(q => q.id !== question.id)!, futureUrl = contentMediaUrl(future.payload.mediaAssetId, { kind: 'ROOM', roomId: room.id, runIndex: 1, itemId: future.id });
    expect((await supertest(app.app).get(futureUrl)).status).toBe(403);
  } finally { host.disconnect(); cancelGeoTimer(room.id); }
});
it('does not emit a Jeopardy solution before resolution and keeps it hidden on resync, including during a steal', async () => {
  const f = await fixture('jeopardy'), { room, host, players } = await start(f), first = await connectGameClient(origin), second = await connectGameClient(origin); const secrets: unknown[] = [], resolved: unknown[] = []; host.on('jeopardy:answer:secret', p => secrets.push(p)); host.on('jeopardy:steal:close', p => resolved.push(p));
  try {
    await gameAck(first, 'room:subscribe', { roomCode: room.code, rejoinToken: players[0].rejoinToken }); await gameAck(second, 'room:subscribe', { roomCode: room.code, rejoinToken: players[1].rejoinToken });
    expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true); expect(secrets).toHaveLength(0);
    expect(JSON.stringify(await gameAck(host, 'jeopardy:resync', { blindHost: false }))).not.toContain('BLIND_SECRET');
    expect((await gameAck(first, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true); expect((await gameAck(host, 'jeopardy:judge', { correct: false, commandId: randomUUID() })).success).toBe(true);
    expect(JSON.stringify(await gameAck(host, 'jeopardy:resync', {}))).not.toContain('BLIND_SECRET');
    expect((await gameAck(second, 'jeopardy:steal:buzz', { commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(host, 'jeopardy:steal:judge', { correct: true, commandId: randomUUID() })).success).toBe(true);
    expect(JSON.stringify(resolved)).toContain('BLIND_SECRET_0');
    expect(JSON.stringify(await gameAck(host, 'jeopardy:resync', {}))).not.toContain('BLIND_SECRET_1');
  } finally { host.disconnect(); first.disconnect(); second.disconnect(); }
});
it('keeps host control separate from a blind player identity and never clears previously seen host secrets on reconnect', async () => {
  const f = await fixture(), created = await f.create(); expect(created.status).toBe(201); const roomId = created.body.data.roomId; rooms.push(roomId);
  const host = await connectGameClient(origin, f.cookie), player = await connectGameClient(origin, f.cookie);
  try {
    await gameAck(host, 'room:subscribe', { roomCode: created.body.data.code });
    const joined = await supertest(app.app).post(`/api/v1/rooms/${created.body.data.code}/join`).set('Cookie', f.cookie).send({ displayName: 'Blind host as player' }); expect(joined.status).toBe(201);
    const subscribed = await gameAck(player, 'room:subscribe', { roomCode: created.body.data.code, rejoinToken: joined.body.data.rejoinToken }); expect(subscribed.success, JSON.stringify(subscribed)).toBe(true); expect(z.object({ identity: z.object({ role: z.string() }) }).parse(subscribed.snapshot).identity.role).toBe('PLAYER');
    await db.participation.updateMany({ where: { roomId, role: 'HOST' }, data: { hasSeenHostSecrets: true } });
    await gameAck(host, 'room:subscribe', { roomCode: created.body.data.code });
    expect((await db.participation.findFirstOrThrow({ where: { roomId, role: 'HOST' } })).hasSeenHostSecrets).toBe(true);
    expect((await gameAck(player, 'room:subscribe', { roomCode: created.body.data.code, rejoinToken: joined.body.data.rejoinToken })).error).toBe('HOST_CANNOT_PLAY_OWN_ROUND');
  } finally { host.disconnect(); player.disconnect(); }
});
