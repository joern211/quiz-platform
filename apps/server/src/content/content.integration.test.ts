import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import supertest from 'supertest';
import { createTestDatabase } from '../test-helpers.js';
import { createSessionCookie } from '../auth/session.js';
import { config } from '../config/index.js';
import { createApp } from '../app.js';
import { cancelGeoTimer } from '../games/geo/index.js';
import { connectGameClient, gameAck } from '../test-socket-harness.js';
import { exportContent, parseContentImport } from './importExport.js';
import { contentActor } from './core.js';
import { socketIdentityMap } from '../http/middleware/auth.js';

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
afterAll(async () => { for (const id of roomIds) cancelGeoTimer(id); if (app) await new Promise<void>(resolve => app.io.close(() => resolve()));
  await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(v => roomIds.includes(v.roomId ?? ''))).toHaveLength(0), { timeout: 10000 });
  await db?.$disconnect(); globalThis.__prisma = previous; if (dir) await rm(dir, { recursive: true, force: true }); });

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
    const p = await pool(), q = await item(p.id); await ready(q.id); await db.contentPool.update({ where: { id: p.id }, data: { scope: 'SYSTEM', ownerId: null } });
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
  it('round-trips game payloads through JSON, CSV and real XLSX; refuses formulas', async () => {
    for (const [slug, value] of [['wissensduell', quiz], ['jeopardy', clue]] as const) {
      const p = await pool(slug); await item(p.id, value as typeof quiz);
      const sessionId = owner.split('=')[1].split('.')[0]; const actor = await contentActor(db, sessionId);
      for (const format of ['JSON', 'CSV', 'XLSX'] as const) {
        const bytes = await exportContent(db, actor, p.id, format);
        const rows = await parseContentImport(format, bytes, slug);
        expect(rows).toHaveLength(1); expect(rows[0].input.payload).toEqual(value.payload); expect(rows[0].parseIssues).toEqual([]);
        const unauthorized = await api(other).get(`/pools/${p.id}/export?format=${format}`); expect(unauthorized.status).toBe(404);
      }
    }
    await expect(parseContentImport('JSON', Buffer.from('{'), 'wissensduell')).rejects.toThrow('INVALID_JSON_IMPORT');
    await expect(parseContentImport('XLSX', Buffer.from('not zip'), 'wissensduell')).rejects.toThrow('INVALID_XLSX');
    const Workbook = createRequire(import.meta.url)('exceljs/lib/doc/workbook.js') as typeof import('exceljs').Workbook;
    const workbook = new Workbook(), sheet = workbook.addWorksheet('Content');
    sheet.addRow(['title', 'prompt']); sheet.addRow(['Formula', '']); sheet.getCell('B2').value = { formula: '1+1', result: 2 };
    await expect(parseContentImport('XLSX', Buffer.from(await workbook.xlsx.writeBuffer()), 'wissensduell')).rejects.toThrow('IMPORT_FORMULA_OR_COMPLEX_CELL');
  });
  it('previews duplicates/conflicts/unknown tags without writes; imports only explicitly decided DRAFTs once', async () => {
    const p = await pool(), q = await item(p.id);
    const upload = { schemaVersion: 1, gameSlug: 'wissensduell', items: [
      { ...quiz, id: q.id, tags: [] },
      { ...quiz, id: q.id, payload: { ...quiz.payload, prompt: 'Changed import' }, tags: [] },
      { ...quiz, payload: { ...quiz.payload, prompt: 'New import' }, tags: ['new-tag'] },
      { title: 'Invalid', payload: {}, tags: [] },
    ] };
    const preview = await api(owner).post(`/pools/${p.id}/import/preview`, { format: 'JSON', fileBase64: Buffer.from(JSON.stringify(upload)).toString('base64') });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.rows.map((r: { classification: string }) => r.classification)).toEqual(['EXACT', 'CONFLICT', 'NEW', 'INVALID']);
    expect(await db.contentItem.count({ where: { poolId: p.id } })).toBe(1);
    const payload = { commandId: commandId(), importId: preview.body.data.importId, decisions: [
      { index: 0, action: 'SKIP' }, { index: 1, action: 'UPDATE_EXISTING' }, { index: 2, action: 'IMPORT_NEW' }, { index: 3, action: 'IMPORT_DRAFT' },
    ], tagDecisions: [{ name: 'new-tag', action: 'CREATE' }] };
    const committed = await api(owner).post('/imports/commit', payload); expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect((await api(owner).post('/imports/commit', payload)).body.data).toEqual(committed.body.data);
    expect(await db.contentItem.count({ where: { poolId: p.id } })).toBe(3);
    expect((await db.contentItem.findMany({ where: { poolId: p.id } })).every(q => q.status === 'DRAFT')).toBe(true);
    expect(await db.contentTag.count({ where: { slug: 'new-tag' } })).toBe(1);
    expect((await api(owner).get('/inbox')).body.data.some((n: { kind: string }) => n.kind === 'IMPORT_RESULT')).toBe(true);
  });
  it('fences stale import previews and requires decisions; no partial accidental overwrites', async () => {
    const p = await pool(), q = await item(p.id);
    const upload = Buffer.from(JSON.stringify({ schemaVersion: 1, gameSlug: 'wissensduell', items: [{ ...quiz, id: q.id }] })).toString('base64');
    const preview = await api(owner).post(`/pools/${p.id}/import/preview`, { format: 'JSON', fileBase64: upload });
    const commit = { commandId: commandId(), importId: preview.body.data.importId, decisions: [{ index: 0, action: 'UPDATE_EXISTING' }], tagDecisions: [] };
    expect((await api(other).post('/imports/commit', commit)).status).toBe(409);
    await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: { ...quiz, title: 'Newer version' } });
    expect((await api(owner).post('/imports/commit', commit)).body.error.code).toBe('IMPORT_PREVIEW_STALE');
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: q.id } })).title).toBe('Newer version');
  });
  it('requires ADMIN public approval and reapproval for gameplay while preserving the published original', async () => {
    const p = await pool(); const value = { ...quiz, source: 'Eigenes Material', license: 'Eigene Nutzungsrechte' };
    const q = await item(p.id, value); await ready(q.id);
    const submit = await api(owner).post(`/pools/${p.id}/submit-public`, { commandId: commandId(), revision: 1 });
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    expect((await api(other).get(`/pools/${p.id}`)).status).toBe(404);
    expect((await api(owner).post(`/reviews/${submit.body.data.reviewId}/decide`, { commandId: commandId(), approve: true, reason: '' })).status).toBe(403);
    expect((await api(admin).post(`/reviews/${submit.body.data.reviewId}/decide`, { commandId: commandId(), approve: true, reason: '' })).status).toBe(200);
    expect((await api(other).get(`/pools/${p.id}`)).body.data.pool.scope).toBe('PUBLIC');
    const original = (await api(owner).get(`/items/${q.id}`)).body.data;
    expect((await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: original.revision, item: value })).status).toBe(403);
    const patch = await api(owner).post(`/items/${q.id}/propose`, { commandId: commandId(), revision: original.revision, item: { ...value, title: 'New metadata' } });
    expect(patch.body.data.kind).toBe('PATCH');
    const proposed = await api(owner).post(`/items/${q.id}/propose`, { commandId: commandId(), revision: patch.body.data.item.revision,
      item: { ...value, payload: { ...quiz.payload, correctOptionId: 'a' } } });
    expect(proposed.body.data.kind).toBe('CONTENT_CHANGE');
    expect((await api(other).get(`/items/${q.id}`)).body.data.payload.correctOptionId).toBe('b');
    const approved = await api(admin).post(`/reviews/${proposed.body.data.reviewId}/decide`, { commandId: commandId(), approve: true, reason: 'Geprüft' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await api(other).get(`/items/${q.id}`)).body.data.payload.correctOptionId).toBe('a');
    const version = await db.contentRevision.findUniqueOrThrow({ where: { itemId_revision: { itemId: q.id, revision: 1 } } });
    expect(JSON.parse(JSON.parse(version.snapshotJson).payloadJson).correctOptionId).toBe('b');
  });
  it('locks editing without blocking use, keeps internal comments private and exposes actionable quality reasons', async () => {
    const p = await pool(), q = await item(p.id); await ready(q.id);
    const lock = await api(owner).post(`/items/${q.id}/lock`, { commandId: commandId(), revision: 2, locked: true }); expect(lock.status).toBe(200);
    expect((await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 3, item: quiz })).body.error.code).toBe('CONTENT_LOCKED');
    const created = await api(owner).post(`/items/${q.id}/comments`, { commandId: commandId(), message: 'Interne Prüfanmerkung' }); expect(created.status).toBe(201);
    expect((await api(other).get(`/items/${q.id}/comments`)).status).toBe(404);
    expect((await api(owner).get(`/pools/${p.id}/quality`)).body.data).toMatchObject({ counts: { READY: 1 }, health: 'HINWEISE' });
  });
  it('uses the persisted room history for NO_REPEAT rematches and rolls back when no unseen content remains', async () => {
    const p = await pool(), q1 = await item(p.id), q2 = await item(p.id, { ...quiz, payload: { ...quiz.payload, prompt: 'Other question' } });
    await ready(q1.id); await ready(q2.id);
    const created = await supertest(app.app).post('/api/v1/rooms').set('Cookie', owner).send({ gameSlug: 'wissensduell', roomName: 'Repeat rules', idempotencyKey: randomUUID(),
      setupSnapshotJson: { contentSelection: { poolIds: [p.id], count: 1, repeatRule: 'NO_REPEAT_IN_ROOM' } } });
    expect(created.status).toBe(201); const roomId = created.body.data.roomId, code = created.body.data.code;
    roomIds.push(roomId);
    await db.room.update({ where: { id: roomId }, data: { status: 'ENDED' } });
    const host = await connectGameClient(origin, owner);
    try {
      expect((await gameAck(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
      const response = await gameAck(host, 'room:command', { roomCode: code, commandId: randomUUID(), protocolVersion: 1, operation: { type: 'REMATCH', runIndex: 1 } });
      expect(response.success, JSON.stringify(response)).toBe(true);
      const refs = await db.contentUse.findMany({ where: { roomId }, orderBy: { runIndex: 'asc' } });
      expect(refs).toHaveLength(2); expect(refs[0].itemId).not.toBe(refs[1].itemId);
      await db.room.update({ where: { id: roomId }, data: { status: 'ENDED' } });
      const exhausted = await gameAck(host, 'room:command', { roomCode: code, commandId: randomUUID(), protocolVersion: 1, operation: { type: 'REMATCH', runIndex: 2 } });
      expect(exhausted).toMatchObject({ success: false, error: 'CONTENT_NOT_READY' });
      expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).runIndex).toBe(2);
      expect(await db.contentUse.count({ where: { roomId } })).toBe(2);
    } finally { host.disconnect(); }
  });
});
