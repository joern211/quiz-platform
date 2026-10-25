import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { createTestDatabase } from '../test-helpers.js';
import { createSessionCookie } from '../auth/session.js';
import { config } from '../config/index.js';
import { createApp } from '../app.js';
import { cancelGeoTimer } from '../games/geo/index.js';
import { connectGameClient, gameAck } from '../test-socket-harness.js';

let dir: string, db: PrismaClient, previous: PrismaClient | undefined;
let app: ReturnType<typeof createApp>, owner: string, other: string, admin: string;
let otherId: string, origin: string;
const roomIds: string[] = [];
const commandId = () => randomUUID();
const quiz = { title: 'Test', payload: { prompt: 'PRIVATE_CONTENT_PROMPT', category: 'Test', options: [{ id: 'a', text: 'Eins' }, { id: 'b', text: 'Zwei' }], correctOptionId: 'b', explanation: 'SECRET_EXPLANATION', durationMs: 20000, points: 100, wrongPoints: 0 } };
const clue = { title: 'Clue', payload: { question: 'CLUE_QUESTION', answer: 'SECRET_CLUE_ANSWER', category: 'Test', value: 100 } };
function api(cookie: string) { return { get: (path: string) => supertest(app.app).get(`/api/v1/content${path}`).set('Cookie', cookie),
  post: (path: string, body: object) => supertest(app.app).post(`/api/v1/content${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object) => supertest(app.app).put(`/api/v1/content${path}`).set('Cookie', cookie).send(body) }; }
async function pool(gameSlug = 'wissensduell', scope = 'PRIVATE', editorIds: string[] = []) {
  const response = await api(owner).post('/pools', { commandId: commandId(), name: 'Pool', gameSlug, scope, editorIds });
  expect(response.status).toBe(201); return response.body.data;
}
async function item(poolId: string, value = quiz) {
  const response = await api(owner).post(`/pools/${poolId}/items`, { commandId: commandId(), item: value });
  expect(response.status).toBe(201); return response.body.data;
}
async function ready(id: string, revision = 1) {
  const response = await api(owner).post(`/items/${id}/status`, { commandId: commandId(), revision, status: 'READY' });
  expect(response.status).toBe(200); return response.body.data;
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-content-')); const url = `file:${join(dir, 'test.db')}`; await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db; app = createApp();
  const users = await Promise.all(['HOST', 'HOST', 'ADMIN'].map(role => db.user.create({ data: { displayName: randomUUID(), role, passwordHash: 'not-used' } })));
  otherId = users[1].id;
  [owner, other, admin] = await Promise.all(users.map(async user => createSessionCookie((await db.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) } })).id, config.sessionSecret)));
  for (const slug of ['wissensduell', 'jeopardy']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA' } });
  await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address(); if (!address || typeof address === 'string') throw new Error('NO_PORT');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { for (const id of roomIds) cancelGeoTimer(id); if (app) await new Promise<void>(resolve => app.io.close(() => resolve())); await db?.$disconnect(); globalThis.__prisma = previous; if (dir) await rm(dir, { recursive: true, force: true }); });

describe('content HTTP/DB contracts', () => {
  it('requires live sessions and hides other private pools, items and revisions', async () => {
    const p = await pool(), q = await item(p.id);
    expect((await supertest(app.app).get('/api/v1/content/pools')).status).toBe(401);
    for (const path of [`/pools/${p.id}`, `/items/${q.id}`, `/items/${q.id}/history`, `/items/${q.id}/preview`]) {
      const response = await api(other).get(path); expect(response.status).toBe(404); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_CONTENT_PROMPT');
    }
    expect((await api(other).get('/pools')).body.data).toHaveLength(0);
  });
  it('allows only explicitly shared editors; disabling an account invalidates its session', async () => {
    const p = await pool('wissensduell', 'SHARED', [otherId]), q = await item(p.id);
    expect((await api(other).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: quiz })).status).toBe(200);
    await db.user.update({ where: { id: otherId }, data: { disabledAt: new Date() } });
    expect((await api(other).get('/pools')).status).toBe(401); await db.user.update({ where: { id: otherId }, data: { disabledAt: null } });
  });
  it('retries create exactly once and rejects command reuse for a different intent', async () => {
    const input = { commandId: commandId(), gameSlug: 'wissensduell', name: 'Idempotent' };
    const a = await api(owner).post('/pools', input), b = await api(owner).post('/pools', input);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect((await api(owner).post('/pools', { ...input, name: 'Different' })).status).toBe(409);
  });
  it('keeps incomplete drafts, gates READY, validates refs and never auto-publishes', async () => {
    const p = await pool(); const q = await item(p.id, { title: 'Bad', payload: {} } as typeof quiz);
    expect(q.status).toBe('DRAFT'); expect(q.validation.length).toBeGreaterThan(0);
    expect((await api(owner).post(`/items/${q.id}/status`, { commandId: commandId(), revision: 1, status: 'READY' })).status).toBe(400);
    expect((await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: { ...quiz, tagIds: [randomUUID()] } })).status).toBe(400);
    const response = await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: quiz });
    expect(response.body.data.status).toBe('DRAFT'); await ready(q.id, 2);
  });
  it('rejects stale edits and restores as a new revision, keeping immutable originals', async () => {
    const p = await pool(), q = await item(p.id);
    const updated = await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: { ...quiz, title: 'Changed' } });
    expect(updated.body.data.revision).toBe(2);
    expect((await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: quiz })).status).toBe(409);
    const restored = await api(owner).post(`/items/${q.id}/restore`, { commandId: commandId(), revision: 2, targetRevision: 1 });
    expect(restored.body.data.revision).toBe(3); expect(restored.body.data.title).toBe('Test');
    expect((await api(owner).get(`/items/${q.id}/history`)).body.data).toHaveLength(3);
    await expect(db.contentRevision.update({ where: { itemId_revision: { itemId: q.id, revision: 1 } }, data: { kind: 'TAMPER' } })).rejects.toThrow();
  });
  it('public/system pools require private forks; copies are new DRAFT identities', async () => {
    const p = await pool(), q = await item(p.id); await db.contentPool.update({ where: { id: p.id }, data: { scope: 'SYSTEM', ownerId: null } });
    expect((await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: quiz })).status).toBe(403);
    const forked = await api(other).post(`/pools/${p.id}/fork`, { commandId: commandId() });
    expect(forked.body.data.scope).toBe('PRIVATE'); expect(forked.body.data.ownerId).toBe(otherId);
    const rows = (await api(other).get(`/pools/${forked.body.data.id}`)).body.data.items;
    expect(rows[0].id).not.toBe(q.id); expect(rows[0].status).toBe('DRAFT');
    expect((await api(admin).get(`/pools/${p.id}`)).status).toBe(200);
  });
  it('previews omit answer secrets from PLAYER/VIEWER/TEAM before reveal', async () => {
    for (const [slug, value, secret] of [['wissensduell', quiz, 'SECRET_EXPLANATION'], ['jeopardy', clue, 'SECRET_CLUE_ANSWER']] as const) {
      const p = await pool(slug), q = await item(p.id, value as typeof quiz);
      for (const role of ['PLAYER', 'VIEWER', 'TEAM']) expect(JSON.stringify((await api(owner).get(`/items/${q.id}/preview?role=${role}`)).body)).not.toContain(secret);
      expect(JSON.stringify((await api(owner).get(`/items/${q.id}/preview?role=HOST`)).body)).toContain(secret);
    }
  });
  it('pins authorized READY selection for both real engines; edits/archive cannot change a room', async () => {
    for (const [gameSlug, value] of [['wissensduell', quiz], ['jeopardy', clue]] as const) {
      const p = await pool(gameSlug), q = await item(p.id, value as typeof quiz); await ready(q.id);
      const intent = { gameSlug, roomName: 'Pinned', idempotencyKey: randomUUID(), setupSnapshotJson: { contentSelection: { poolIds: [p.id], count: 1 } } };
      expect((await supertest(app.app).post('/api/v1/rooms').set('Cookie', other).send(intent)).status).toBe(404);
      const response = await supertest(app.app).post('/api/v1/rooms').set('Cookie', owner).send(intent);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const room = await db.room.findUniqueOrThrow({ where: { id: response.body.data.roomId } });
      roomIds.push(room.id);
      const changed = await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 2, item: { ...value, payload: { ...value.payload, ...(gameSlug === 'wissensduell' ? { prompt: 'NEW_PROMPT' } : { question: 'NEW_PROMPT' }) } } });
      expect(changed.body.data.revision).toBe(3);
      for (const name of ['Alice', 'Bob']) await db.participation.create({ data: { roomId: room.id, displayName: name, normalizedName: name.toLowerCase(), role: 'PLAYER', ready: true, connected: true, rejoinToken: randomUUID() } });
      const host = await connectGameClient(origin, owner);
      try {
        expect((await gameAck(host, 'room:subscribe', { roomCode: room.code })).success).toBe(true);
        const start = await gameAck(host, 'game:start', { roomCode: room.code, commandId: randomUUID() });
        expect(start.success, JSON.stringify(start)).toBe(true);
        if (gameSlug === 'jeopardy') {
          const opened = await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() });
          expect(opened.success, JSON.stringify(opened)).toBe(true);
        }
      } finally { host.disconnect(); }
      const state = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
      expect(state.stateJson).not.toContain('NEW_PROMPT');
      expect(state.stateJson).toContain(gameSlug === 'wissensduell' ? 'PRIVATE_CONTENT_PROMPT' : 'CLUE_QUESTION');
      const pin = await db.contentUse.findFirstOrThrow({ where: { roomId: room.id } });
      await expect(db.contentUse.update({ where: { id: pin.id }, data: { snapshotJson: '{}' } })).rejects.toThrow();
      const archived = await api(owner).post(`/items/${q.id}/status`, { commandId: commandId(), revision: 3, status: 'TRASHED' });
      expect(archived.body.data.status).toBe('ARCHIVED');
      const publicRoom = await supertest(app.app).get(`/api/v1/rooms/${room.code}`);
      expect(JSON.stringify(publicRoom.body)).not.toContain('SECRET_');
    }
  });
});
