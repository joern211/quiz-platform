import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { z } from 'zod';
import { contentMediaUrl } from './media.js';
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
import { cancelGeoTimer, handleGeoGame } from '../games/geo/index.js';
import { connectGameClient, gameAck } from '../test-socket-harness.js';
import { exportContent, parseContentImport } from './importExport.js';
import { contentActor } from './core.js';
import { socketIdentityMap } from '../http/middleware/auth.js';

let dir: string, db: PrismaClient, previous: PrismaClient | undefined;
let app: ReturnType<typeof createApp>, owner: string, other: string, admin: string;
let ownerId: string, otherId: string, origin: string;
const roomIds: string[] = [];
const mediaFiles: string[] = [];
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
async function item(poolId: string, value: object = quiz) {
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
  ownerId = users[0].id; otherId = users[1].id;
  [owner, other, admin] = await Promise.all(users.map(async user => createSessionCookie((await db.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) } })).id, config.sessionSecret)));
  for (const slug of ['wissensduell', 'jeopardy']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA' } });
  await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address(); if (!address || typeof address === 'string') throw new Error('NO_PORT');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { for (const id of roomIds) cancelGeoTimer(id); if (app) await new Promise<void>(resolve => app.io.close(() => resolve()));
  await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(v => roomIds.includes(v.roomId ?? ''))).toHaveLength(0), { timeout: 10000 });
  for (const path of mediaFiles) await rm(path, { force: true });
  await db?.$disconnect(); globalThis.__prisma = previous; if (dir) await rm(dir, { recursive: true, force: true }); });

describe('content HTTP/DB contracts', () => {
  it('requires live sessions and hides other private pools, items and revisions', async () => {
    const currentSession = await supertest(app.app).get('/api/v1/auth/session').set('Cookie', owner);
    expect(currentSession.status).toBe(200); expect(currentSession.body.data.user.role).toBe('HOST');
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
    const p = await pool(); const q = await item(p.id, { title: 'Bad', payload: {} });
    expect(q.status).toBe('DRAFT'); expect(q.validation.length).toBeGreaterThan(0);
    expect((await api(owner).post(`/items/${q.id}/status`, { commandId: commandId(), revision: 1, status: 'READY' })).status).toBe(400);
    expect((await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: { ...quiz, tagIds: [randomUUID()] } })).status).toBe(400);
    const response = await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: quiz });
    expect(response.body.data.status).toBe('DRAFT'); await ready(q.id, 2);
  });
  it('shows the same effective game defaults in the editor and does not mistake them for a public gameplay edit', async () => {
    const p = await pool(); const minimal = { title: 'Minimal', payload: { prompt: 'Frage?', category: 'Test',
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctOptionId: 'a' }, source: 'Eigene Frage', license: 'Eigene Rechte' };
    const q = await item(p.id, minimal);
    expect(q.payload).toMatchObject({ durationMs: 20000, points: 100, wrongPoints: 0, explanation: '' });
    await ready(q.id);
    await db.contentPool.update({ where: { id: p.id }, data: { scope: 'PUBLIC' } });
    await db.contentItem.update({ where: { id: q.id }, data: { reviewState: 'APPROVED' } });
    const patched = await api(owner).post(`/items/${q.id}/propose`, { commandId: commandId(), revision: 2,
      item: { ...minimal, title: 'Metadaten', payload: q.payload } });
    expect(patched.body.data.kind).toBe('PATCH');
    expect(patched.body.data.item.status).toBe('READY');
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
      const p = await pool(slug), q = await item(p.id, value);
      for (const role of ['PLAYER', 'VIEWER', 'TEAM']) expect(JSON.stringify((await api(owner).get(`/items/${q.id}/preview?role=${role}`)).body)).not.toContain(secret);
      expect(JSON.stringify((await api(owner).get(`/items/${q.id}/preview?role=HOST`)).body)).toContain(secret);
    }
  });
  it('pins authorized READY selection for both real engines; edits/archive cannot change a room', async () => {
    for (const [gameSlug, value] of [['wissensduell', quiz], ['jeopardy', clue]] as const) {
      const p = await pool(gameSlug), q = await item(p.id, value); await ready(q.id);
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
          const openedState = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } }); expect(openedState.stateJson).toContain('CLUE_QUESTION');
          const player = await db.participation.findFirstOrThrow({ where: { roomId: room.id, role: 'PLAYER', displayName: 'Alice' } });
          const socket = await connectGameClient(origin);
          try {
            await gameAck(socket, 'room:subscribe', { roomCode: room.code, rejoinToken: player.rejoinToken });
            expect((await gameAck(socket, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true);
            expect((await gameAck(host, 'jeopardy:judge', { correct: true, commandId: randomUUID() })).success).toBe(true);
            const eligible = await supertest(app.app).post('/api/v1/content/corrections/eligible').send({ roomCode: room.code, participantId: player.id, rejoinToken: player.rejoinToken, runIndex: 1 });
            expect(eligible.body.data[0].itemId).toBe(q.id);
          } finally { socket.disconnect(); }
        }
      } finally { host.disconnect(); }
      const state = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
      expect(state.stateJson).not.toContain('NEW_PROMPT');
      if (gameSlug === 'wissensduell') expect(state.stateJson).toContain('PRIVATE_CONTENT_PROMPT');
      else expect(room.setupSnapshotJson).toContain('CLUE_QUESTION');
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
      const p = await pool(slug); await item(p.id, value);
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
  it('inherits pool standards, checks shared-editor ownership and revokes removed collaborators immediately', async () => {
    const p = await pool(), q = await item(p.id);
    const tag = (await api(owner).post('/tags', { commandId: commandId(), name: 'Science', slug: 'science' })).body.data;
    const update = { commandId: commandId(), revision: 1, name: 'Shared pool', description: '', scope: 'SHARED', editorIds: [otherId],
      defaults: { language: 'en-US', difficulty: 'HARD', tagIds: [tag.id] } };
    expect((await api(owner).put(`/pools/${p.id}`, update)).status).toBe(200);
    expect((await api(other).get(`/items/${q.id}`)).body.data.effective).toEqual({ language: 'en-US', difficulty: 'HARD', tagIds: [tag.id] });
    expect((await api(other).put(`/pools/${p.id}`, { ...update, commandId: commandId(), revision: 2 })).status).toBe(403);
    expect((await api(owner).put(`/pools/${p.id}`, { ...update, commandId: commandId(), revision: 2, scope: 'PRIVATE', editorIds: [] })).status).toBe(200);
    expect((await api(other).get(`/items/${q.id}`)).status).toBe(404);
  });
  it('canonicalizes aliases only after explicit ADMIN assignment and fences preview changes to tags', async () => {
    const p = await pool(), tag = (await api(owner).post('/tags', { commandId: commandId(), name: 'Physics', slug: 'physics' })).body.data;
    expect((await api(owner).put(`/tags/${tag.id}/aliases`, { commandId: commandId(), aliases: ['physik'] })).status).toBe(403);
    expect((await api(admin).put(`/tags/${tag.id}/aliases`, { commandId: commandId(), aliases: ['physik'] })).status).toBe(200);
    const upload = Buffer.from(JSON.stringify({ schemaVersion: 1, gameSlug: 'wissensduell', items: [{ ...quiz, tags: ['physik'] }] })).toString('base64');
    const preview = await api(owner).post(`/pools/${p.id}/import/preview`, { format: 'JSON', fileBase64: upload });
    expect(preview.body.data.rows[0].unknownTags).toEqual([]);
    const done = await api(owner).post('/imports/commit', { commandId: commandId(), importId: preview.body.data.importId, decisions: [{ index: 0, action: 'IMPORT_NEW' }], tagDecisions: [] });
    expect(done.status).toBe(200);
    expect(JSON.parse((await db.contentItem.findFirstOrThrow({ where: { poolId: p.id } })).tagIdsJson!)).toEqual([tag.id]);
    expect((await api(owner).post('/tags', { commandId: commandId(), name: 'Conflicting', slug: 'physik' })).status).toBe(409);
  });
  it('materializes exact counts per pool with language/difficulty/category/tag filters and pinned defaults', async () => {
    const p1 = await pool(), p2 = await pool();
    const tag = (await api(owner).post('/tags', { commandId: commandId(), name: 'Filtered', slug: 'filtered' })).body.data;
    for (const p of [p1, p2]) expect((await api(owner).put(`/pools/${p.id}`, { commandId: commandId(), revision: 1, name: p.name, description: '', scope: 'PRIVATE', editorIds: [],
      defaults: { language: 'en-US', difficulty: 'HARD', tagIds: [tag.id] } })).status).toBe(200);
    for (const [p, prompt] of [[p1, 'A'], [p1, 'B'], [p2, 'C']] as const) { const q = await item(p.id, { ...quiz, payload: { ...quiz.payload, prompt } }); await ready(q.id); }
    const selection = { poolIds: [p1.id, p2.id], poolCounts: { [p1.id]: 2, [p2.id]: 1 }, count: 100,
      language: 'en-US', difficulty: 'HARD', category: 'test', tagIds: [tag.id] };
    const create = (contentSelection: object) => supertest(app.app).post('/api/v1/rooms').set('Cookie', owner).send({ gameSlug: 'wissensduell', roomName: 'Filtered pools', idempotencyKey: randomUUID(), setupSnapshotJson: { contentSelection } });
    const created = await create(selection); expect(created.status, JSON.stringify(created.body)).toBe(201);
    const refs = await db.contentUse.findMany({ where: { roomId: created.body.data.roomId } });
    expect(refs.filter(r => JSON.parse(r.snapshotJson).poolId === p1.id)).toHaveLength(2);
    expect(refs.filter(r => JSON.parse(r.snapshotJson).poolId === p2.id)).toHaveLength(1);
    expect(refs.every(r => JSON.parse(r.snapshotJson).poolRevision === 2)).toBe(true);
    expect((await create({ ...selection, language: 'de-DE' })).status).toBe(400);
    expect((await create({ ...selection, poolCounts: { [p1.id]: 2 } })).status).toBe(400);
  });
  it('accepts guest corrections only for explicitly revealed content and keeps proposals separate from originals', async () => {
    const p = await pool(), q = await item(p.id); await ready(q.id);
    const future = await item(p.id, { ...quiz, payload: { ...quiz.payload, prompt: 'FUTURE_UNREVEALED_SECRET' } }); await ready(future.id);
    const created = await supertest(app.app).post('/api/v1/rooms').set('Cookie', owner).send({ gameSlug: 'wissensduell', roomName: 'Corrections', idempotencyKey: randomUUID(),
      setupSnapshotJson: { contentSelection: { poolIds: [p.id], mode: 'MANUAL', itemIds: [q.id, future.id], count: 2 } } });
    const room = await db.room.findUniqueOrThrow({ where: { id: created.body.data.roomId } }); roomIds.push(room.id);
    const players = await Promise.all(['C Alice', 'C Bob'].map(name => db.participation.create({ data: { roomId: room.id, displayName: name, normalizedName: name.toLowerCase(),
      role: 'PLAYER', connected: true, ready: true, rejoinToken: randomUUID() } })));
    const access = { roomCode: room.code, participantId: players[0].id, rejoinToken: players[0].rejoinToken, runIndex: 1 };
    const request = (path: string, body: object) => supertest(app.app).post(`/api/v1/content${path}`).send(body);
    expect((await request('/corrections/eligible', access)).body.data).toEqual([]);
    const proposal = { ...access, commandId: randomUUID(), itemId: q.id, field: 'prompt', currentValue: quiz.payload.prompt, proposedValue: 'Korrigierte Frage', comment: 'Tippfehler' };
    expect((await request('/corrections', proposal)).status).toBe(403);
    expect((await request('/corrections/eligible', { ...access, rejoinToken: randomUUID() })).status).toBe(401);
    const host = await connectGameClient(origin, owner);
    try {
      await gameAck(host, 'room:subscribe', { roomCode: room.code });
      expect((await gameAck(host, 'game:start', { roomCode: room.code, commandId: randomUUID() })).success).toBe(true);
      cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, room.code);
      expect((await request('/corrections/eligible', access)).body.data).toEqual([]);
      expect((await gameAck(host, 'geo:reveal', { roomCode: room.code, commandId: randomUUID() })).success).toBe(true);
      const eligible = await request('/corrections/eligible', access); expect(eligible.body.data).toHaveLength(1); expect(eligible.body.data[0].itemId).toBe(q.id);
      expect(JSON.stringify(eligible.body)).not.toContain('FUTURE_UNREVEALED_SECRET');
      const submitted = await request('/corrections', proposal); expect(submitted.status).toBe(201);
      expect((await request('/corrections', proposal)).body.data.reviewId).toBe(submitted.body.data.reviewId);
      expect((await db.contentItem.findUniqueOrThrow({ where: { id: q.id } })).payloadJson).toContain('PRIVATE_CONTENT_PROMPT');
      const accepted = await api(owner).post(`/reviews/${submitted.body.data.reviewId}/decide`, { commandId: commandId(), approve: true, reason: 'Geprüft' });
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect((await db.contentItem.findUniqueOrThrow({ where: { id: q.id } })).payloadJson).toContain('Korrigierte Frage');
      expect((await db.contentUse.findFirstOrThrow({ where: { roomId: room.id, itemId: q.id } })).snapshotJson).toContain('PRIVATE_CONTENT_PROMPT');
      const staleProposal = await request('/corrections', { ...proposal, commandId: randomUUID() });
      expect((await api(owner).post(`/reviews/${staleProposal.body.data.reviewId}/decide`, { commandId: commandId(), approve: false, reason: 'Bereits korrigiert' })).status).toBe(200);
      await db.room.update({ where: { id: room.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await request('/corrections/eligible', access)).status).toBe(404);
    } finally { host.disconnect(); cancelGeoTimer(room.id); }
  });
});

it('previews batch impact without writes and reports stale, locked and foreign items without overwriting historical content', async () => {
  const p = await pool(), a = await item(p.id), b = await item(p.id), stale = await item(p.id);
  await ready(a.id);
  const roomResponse = await supertest(app.app).post('/api/v1/rooms').set('Cookie', owner).send({ gameSlug: 'wissensduell', roomName: 'Batch history', idempotencyKey: randomUUID(),
    setupSnapshotJson: { contentSelection: { poolIds: [p.id], count: 1 } } });
  expect(roomResponse.status).toBe(201);
  const snapshot = await db.contentUse.findFirstOrThrow({ where: { itemId: a.id } });
  const lock = await api(owner).post(`/items/${b.id}/lock`, { commandId: commandId(), revision: 1, locked: true });
  expect(lock.status).toBe(200);
  await api(owner).put(`/items/${stale.id}`, { commandId: commandId(), revision: 1, item: { ...quiz, title: 'Newer' } });
  const foreign = await db.contentPool.create({ data: { name: 'PRIVATE_SECRET', gameSlug: 'wissensduell', ownerId: otherId } });
  const hidden = await db.contentItem.create({ data: { poolId: foreign.id, gameSlug: 'wissensduell', payloadJson: JSON.stringify(quiz.payload), title: 'HIDDEN_SECRET' } });
  const batch = { poolId: p.id, poolRevision: p.revision, items: [{ id: a.id, revision: 2 }, { id: b.id, revision: 2 }, { id: stale.id, revision: 1 }, { id: hidden.id, revision: 1 }], operation: { kind: 'DIFFICULTY', difficulty: 'HARD' } };
  const preview = await api(owner).post('/batch/preview', batch);
  expect(preview.status).toBe(200); expect(preview.body.data).toMatchObject({ total: 4, eligible: 1, historicallyUsed: 1 });
  expect(JSON.stringify(preview.body)).not.toContain('HIDDEN_SECRET');
  expect(await db.contentItem.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'READY', revision: 2 });
  expect((await api(owner).post('/batch/commit', { commandId: commandId(), batch, confirmed: false })).status).toBe(400);
  const command = { commandId: commandId(), batch, confirmed: true };
  const result = await api(owner).post('/batch/commit', command), retry = await api(owner).post('/batch/commit', command);
  expect(result.status).toBe(200); expect(retry.body).toEqual(result.body);
  expect(result.body.data.results.map((r: { error?: string; status: string }) => r.error ?? r.status)).toEqual(['UPDATED', 'CONTENT_LOCKED', 'REVISION_CONFLICT', 'RESOURCE_NOT_ACCESSIBLE']);
  expect(await db.contentItem.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: 'DRAFT', revision: 3, difficulty: 'HARD' });
  expect(await db.contentUse.findUniqueOrThrow({ where: { id: snapshot.id } })).toEqual(snapshot);
  const archived = await api(owner).post('/batch/commit', { commandId: commandId(), confirmed: true, batch: { ...batch, items: [{ id: a.id, revision: 3 }], operation: { kind: 'STATUS', status: 'ARCHIVED' } } });
  expect(archived.body.data.results[0].item.status).toBe('ARCHIVED');
  const trash = { ...batch, items: [{ id: a.id, revision: 4 }], operation: { kind: 'STATUS', status: 'TRASHED' } };
  expect((await api(owner).post('/batch/preview', trash)).body.data.rows[0].effect).toBe('ARCHIVED');
  expect((await api(owner).post('/batch/commit', { commandId: commandId(), confirmed: true, batch: trash })).body.data.results[0].item.status).toBe('ARCHIVED');
});
it('copies and moves batches as drafts with new copy identities and effective inheritance while preserving uses', async () => {
  const tag = await db.contentTag.create({ data: { name: 'Batch tag', slug: `batch-${randomUUID()}` } });
  const p = await pool(), target = await pool();
  await db.contentPool.update({ where: { id: p.id }, data: { defaultsJson: JSON.stringify({ language: 'tr-TR', difficulty: 'EASY', tagIds: [tag.id] }) } });
  const q = await item(p.id);
  const batch = { poolId: p.id, poolRevision: 1, items: [{ id: q.id, revision: 1 }], operation: { kind: 'COPY', targetPoolId: target.id, targetRevision: 1 } };
  const result = await api(owner).post('/batch/commit', { commandId: commandId(), confirmed: true, batch });
  expect(result.status).toBe(200); const copy = result.body.data.results[0].item;
  expect(copy).toMatchObject({ poolId: target.id, status: 'DRAFT', effective: { language: 'tr-TR', difficulty: 'EASY', tagIds: [tag.id] } });
  expect(copy.id).not.toBe(q.id); expect((await db.contentItem.findUniqueOrThrow({ where: { id: copy.id } })).duplicatedFromId).toBe(q.id);
  const moved = await api(owner).post('/batch/commit', { commandId: commandId(), confirmed: true, batch: { ...batch, operation: { ...batch.operation, kind: 'MOVE' } } });
  expect(moved.body.data.results[0].item).toMatchObject({ id: q.id, poolId: target.id, status: 'DRAFT', revision: 2, effective: copy.effective });
  expect(await db.contentRevision.count({ where: { itemId: q.id } })).toBe(2);
});
it('rechecks batch ownership, pool revisions and editor grants after preview', async () => {
  const p = await pool('wissensduell', 'SHARED', [otherId]), q = await item(p.id);
  const batch = { poolId: p.id, poolRevision: 1, items: [{ id: q.id, revision: 1 }], operation: { kind: 'TAGS', tagIds: [] } };
  expect((await api(other).post('/batch/preview', batch)).status).toBe(200);
  await db.contentPool.update({ where: { id: p.id }, data: { editorIdsJson: '[]', revision: { increment: 1 } } });
  expect((await api(other).post('/batch/commit', { commandId: commandId(), confirmed: true, batch })).status).toBe(404);
  expect((await api(owner).post('/batch/commit', { commandId: commandId(), confirmed: true, batch })).status).toBe(409);
  expect((await db.contentItem.findUniqueOrThrow({ where: { id: q.id } })).revision).toBe(1);
});
it('shows only live authorized concurrent editors and expires presence without granting a write lock', async () => {
  const p = await pool('wissensduell', 'SHARED', [otherId]), q = await item(p.id), a = randomUUID(), b = randomUUID();
  const beat = (cookie: string, editorKey: string, active = true) => api(cookie).post(`/items/${q.id}/presence`, { editorKey, active });
  expect((await beat(owner, a)).body.data).toEqual([]);
  expect((await beat(other, b)).body.data).toEqual([expect.objectContaining({ id: ownerId })]);
  const visible = await beat(owner, a); expect(visible.body.data).toEqual([expect.objectContaining({ id: otherId })]);
  expect(JSON.stringify(visible.body)).not.toContain('sessionId'); expect(JSON.stringify(visible.body)).not.toContain(b);
  expect((await api(other).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: { ...quiz, title: 'Shared edit' } })).status).toBe(200);
  await db.contentEditorPresence.updateMany({ where: { userId: otherId, itemId: q.id }, data: { lastSeenAt: new Date(Date.now() - 46000) } });
  expect((await beat(owner, a)).body.data).toEqual([]);
  await beat(other, b); await db.user.update({ where: { id: otherId }, data: { disabledAt: new Date() } });
  expect((await beat(owner, a)).body.data).toEqual([]);
  await db.user.update({ where: { id: otherId }, data: { disabledAt: null } });
  await beat(owner, a, false); expect(await db.contentEditorPresence.count({ where: { itemId: q.id, userId: ownerId } })).toBe(0);
  await db.contentPool.update({ where: { id: p.id }, data: { scope: 'PRIVATE', editorIdsJson: '[]' } });
  expect((await beat(other, b)).status).toBe(404);
});
it('keeps internal comments, presence and historical usage private from readers of public pools', async () => {
  const p = await pool(), q = await item(p.id); await ready(q.id);
  const comment = await api(owner).post(`/items/${q.id}/comments`, { commandId: commandId(), message: 'INTERNAL_SECRET' });
  expect(comment.status).toBe(201);
  await db.contentPool.update({ where: { id: p.id }, data: { scope: 'PUBLIC' } });
  expect((await api(other).get(`/items/${q.id}`)).status).toBe(200);
  for (const path of [`/items/${q.id}/comments`, `/items/${q.id}/usage`]) {
    const r = await api(other).get(path); expect(r.status).toBe(403); expect(JSON.stringify(r.body)).not.toContain('INTERNAL_SECRET');
  }
  expect((await api(other).post(`/items/${q.id}/presence`, { editorKey: randomUUID(), active: true })).status).toBe(403);
  expect((await api(owner).get(`/items/${q.id}/comments`)).body.data[0].message).toBe('INTERNAL_SECRET');
  expect((await api(owner).post(`/comments/${comment.body.data.id}/resolve`, { commandId: commandId(), status: 'RESOLVED' })).body.data.status).toBe('RESOLVED');
});

it('serializes actual simultaneous editor writes at the database and returns one explicit revision conflict', async () => {
  const p = await pool('wissensduell', 'SHARED', [otherId]), q = await item(p.id);
  const saves = await Promise.all([owner, other].map((cookie, i) => api(cookie).put(`/items/${q.id}`, {
    commandId: commandId(), revision: 1, item: { ...quiz, title: `Concurrent ${i}` },
  })));
  expect(saves.map(r => r.status).sort()).toEqual([200, 409]);
  expect(saves.find(r => r.status === 409)?.body.error.code).toBe('REVISION_CONFLICT');
  expect(await db.contentRevision.count({ where: { itemId: q.id } })).toBe(2);
});

async function uploadContentImage(cookie: string) {
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: Math.floor(Math.random() * 256), g: Math.floor(Math.random() * 256), b: Math.floor(Math.random() * 256) } } }).png().toBuffer();
  const response = await supertest(app.app).post('/api/v1/media').set('Cookie', cookie).attach('file', bytes, { filename: 'content.png', contentType: 'image/png' });
  expect(response.status).toBe(201); const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: response.body.data.id } }); mediaFiles.push(asset.storagePath); return asset;
}
const ownRights = { source: 'Eigenes Material', sourceUrl: '', author: 'Test', license: 'Eigene Rechte', ownMaterial: true, recognizablePerson: false, consent: false };
it('authorizes private media through normalized references, requires rights/READY and protects historical asset rows', async () => {
  const asset = await uploadContentImage(owner), p = await pool('wissensduell', 'SHARED', [otherId]);
  const q = await item(p.id, { ...quiz, payload: { ...quiz.payload, mediaAssetId: asset.id, mediaType: 'image' } });
  expect((await api(owner).post(`/items/${q.id}/status`, { commandId: commandId(), revision: 1, status: 'READY' })).status).toBe(400);
  const save = await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: { ...quiz, payload: { ...quiz.payload,
    mediaAssetId: asset.id, mediaType: 'image', mediaRights: { ...ownRights, recognizablePerson: true, consent: false } } } });
  expect(save.status).toBe(200);
  expect((await api(owner).post(`/items/${q.id}/status`, { commandId: commandId(), revision: 2, status: 'READY' })).status).toBe(400);
  await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 2, item: { ...quiz, payload: { ...quiz.payload, mediaAssetId: asset.id, mediaType: 'image', mediaRights: ownRights } } });
  await ready(q.id, 3);
  expect((await supertest(app.app).get(`/api/v1/media/${asset.id}`)).status).toBe(403);
  const rolePreview = await api(other).get(`/items/${q.id}/preview?role=VIEWER`);
  expect(rolePreview.body.data.correctOptionId).toBeUndefined();
  expect((await supertest(app.app).get(rolePreview.body.data.mediaUrl).set('Cookie', other)).status).toBe(200);
  const preview = await api(other).get(`/items/${q.id}/media`); expect(preview.status).toBe(200);
  expect(JSON.stringify(preview.body)).not.toContain(asset.storagePath);
  expect((await supertest(app.app).get(preview.body.data.url).set('Cookie', other)).status).toBe(200);
  expect((await supertest(app.app).get(preview.body.data.url)).status).toBe(403);
  await db.contentPool.update({ where: { id: p.id }, data: { scope: 'PRIVATE', editorIdsJson: '[]' } });
  expect((await supertest(app.app).get(preview.body.data.url).set('Cookie', other)).status).toBe(403);
  const foreignPool = await db.contentPool.create({ data: { name: 'Unsafe old draft', gameSlug: 'wissensduell', ownerId: otherId } });
  const unsafe = await db.contentItem.create({ data: { poolId: foreignPool.id, gameSlug: 'wissensduell', payloadJson: JSON.stringify({ ...quiz.payload, mediaAssetId: asset.id, mediaType: 'image', mediaRights: ownRights }) } });
  expect((await api(other).get(`/items/${unsafe.id}/media`)).status).toBe(400);
  expect((await api(other).post(`/pools/${foreignPool.id}/items`, { commandId: commandId(), item: { ...quiz, payload: { ...quiz.payload, mediaAssetId: asset.id, mediaType: 'image', mediaRights: ownRights } } })).status).toBe(400);
  const signed = contentMediaUrl(asset.id, { kind: 'EDITOR', itemId: unsafe.id, revision: 1 });
  expect((await supertest(app.app).get(signed).set('Cookie', other)).status).toBe(403);
  const own = await api(owner).get(`/items/${q.id}/media`); expect(own.status).toBe(200);
  await db.mediaAsset.update({ where: { id: asset.id }, data: { processStatus: 'BLOCKED' } });
  expect((await supertest(app.app).get(own.body.data.url).set('Cookie', owner)).status).toBe(403);
  await db.mediaAsset.update({ where: { id: asset.id }, data: { processStatus: 'READY' } });
  const ref = await db.contentMediaReference.findFirstOrThrow({ where: { itemId: q.id } });
  await expect(db.contentMediaReference.update({ where: { id: ref.id }, data: { itemRevision: 100 } })).rejects.toThrow();
  await expect(db.mediaAsset.delete({ where: { id: asset.id } })).rejects.toThrow();
});
it('preserves media IDs and structured rights in JSON, CSV and XLSX without exporting private storage data', async () => {
  const asset = await uploadContentImage(owner), p = await pool(), q = await item(p.id, { ...quiz, payload: { ...quiz.payload, mediaAssetId: asset.id, mediaType: 'image', mediaRights: ownRights } });
  const actor = await contentActor(db, owner.split('=')[1].split('.')[0]);
  for (const format of ['JSON', 'CSV', 'XLSX'] as const) {
    const bytes = await exportContent(db, actor, p.id, format), rows = await parseContentImport(format, bytes, 'wissensduell');
    expect(rows[0].input.payload).toMatchObject({ mediaAssetId: asset.id, mediaType: 'image', mediaRights: ownRights });
    expect(bytes.toString('utf8')).not.toContain(asset.storagePath);
  }
  expect(await db.contentMediaReference.count({ where: { itemId: q.id, assetId: asset.id } })).toBe(1);
});
it('delivers media only for the active pinned question of both real engines and fences room/run/asset/rejoin', async () => {
  for (const [gameSlug, value] of [['wissensduell', quiz], ['jeopardy', clue]] as const) {
    const first = await uploadContentImage(owner), future = await uploadContentImage(owner), p = await pool(gameSlug);
    const a = await item(p.id, { ...value, payload: { ...value.payload, mediaAssetId: first.id, mediaType: 'image', mediaRights: ownRights } }); await ready(a.id);
    const b = await item(p.id, { ...value, payload: { ...value.payload, ...(gameSlug === 'jeopardy' ? { value: 200 } : { prompt: 'Future secret question' }), mediaAssetId: future.id, mediaType: 'image', mediaRights: ownRights } }); await ready(b.id);
    const created = await supertest(app.app).post('/api/v1/rooms').set('Cookie', owner).send({ gameSlug, roomName: 'Media runtime', idempotencyKey: randomUUID(),
      setupSnapshotJson: { contentSelection: { poolIds: [p.id], mode: 'MANUAL', itemIds: [a.id, b.id], count: 2 } } });
    expect(created.status).toBe(201); const room = await db.room.findUniqueOrThrow({ where: { id: created.body.data.roomId } }); roomIds.push(room.id);
    for (const name of ['Media Alice', 'Media Bob']) await db.participation.create({ data: { roomId: room.id, displayName: name, normalizedName: name.toLowerCase(), role: 'PLAYER', ready: true, connected: true, rejoinToken: randomUUID() } });
    const host = await connectGameClient(origin, owner), viewer = await connectGameClient(origin);
    try {
      await gameAck(host, 'room:subscribe', { roomCode: room.code }); await gameAck(viewer, 'room:subscribe', { roomCode: room.code });
      await db.mediaAsset.update({ where: { id: first.id }, data: { processStatus: 'FAILED' } });
      expect((await gameAck(host, 'game:start', { roomCode: room.code, commandId: randomUUID() })).success).toBe(false);
      await db.mediaAsset.update({ where: { id: first.id }, data: { processStatus: 'READY' } });
      expect((await gameAck(host, 'game:start', { roomCode: room.code, commandId: randomUUID() })).success).toBe(true);
      const nextUrl = contentMediaUrl(future.id, { kind: 'ROOM', roomId: room.id, runIndex: 1, itemId: b.id });
      expect((await supertest(app.app).get(nextUrl)).status).toBe(403);
      const event = new Promise<{ question?: { mediaUrl?: string }; mediaUrl?: string }>(resolve => host.once(gameSlug === 'wissensduell' ? 'geo:question' : 'jeopardy:field:open', resolve));
      if (gameSlug === 'wissensduell') { cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, room.code); }
      else expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
      const message = await event, url = gameSlug === 'wissensduell' ? message.question?.mediaUrl : message.mediaUrl;
      expect(url).toBeTruthy(); expect((await supertest(app.app).get(url!)).status).toBe(200);
      expect((await supertest(app.app).get(nextUrl)).status).toBe(403);
      expect((await supertest(app.app).get(url!.replace(first.id, future.id))).status).toBe(403);
      const projected = await gameAck(viewer, gameSlug === 'wissensduell' ? 'geo:resync' : 'jeopardy:resync', {});
      const current = gameSlug === 'wissensduell' ? projected.question : projected.currentField;
      expect((await supertest(app.app).get(z.object({ mediaUrl: z.string() }).parse(current).mediaUrl)).status).toBe(200);
      expect(JSON.stringify(projected)).not.toContain('mediaRights'); expect(JSON.stringify(projected)).not.toContain(future.id);
      await api(owner).put(`/items/${a.id}`, { commandId: commandId(), revision: 2, item: { ...value, payload: { ...value.payload, mediaAssetId: future.id, mediaType: 'image', mediaRights: ownRights } } });
      expect((await supertest(app.app).get(url!)).status).toBe(200);
      const afterReload = await gameAck(host, gameSlug === 'wissensduell' ? 'geo:resync' : 'jeopardy:resync', {});
      expect(z.object({ mediaUrl: z.string() }).parse(gameSlug === 'wissensduell' ? afterReload.question : afterReload.currentField).mediaUrl).toContain(first.id);
      await db.room.update({ where: { id: room.id }, data: { runIndex: 2 } });
      expect((await supertest(app.app).get(url!)).status).toBe(403);
      await db.room.update({ where: { id: room.id }, data: { runIndex: 1, lifecycle: 'CLOSED' } });
      expect((await supertest(app.app).get(url!)).status).toBe(403);
    } finally { host.disconnect(); viewer.disconnect(); cancelGeoTimer(room.id); }
  }
});

it('creates new DRAFT identities from system and private templates for both games, with receipts and ownership fences', async () => {
  for (const [slug, value] of [['wissensduell', quiz], ['jeopardy', clue]] as const) {
    const p = await pool(slug), catalog = await api(owner).get(`/templates/catalog?gameSlug=${slug}`);
    expect(catalog.status).toBe(200); expect(catalog.body.data[0]).toMatchObject({ scope: 'SYSTEM', revision: 1 });
    const created = await api(owner).post('/templates', { commandId: commandId(), gameSlug: slug, name: `Template ${slug}`, item: { ...value, difficulty: 'HARD' } });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await api(other).get(`/templates/catalog?gameSlug=${slug}`)).body.data.map((t: { id: string }) => t.id)).not.toContain(id);
    const intent = { commandId: commandId(), revision: 1, poolId: p.id, poolRevision: 1 };
    const one = await api(owner).post(`/templates/${id}/use`, intent), retry = await api(owner).post(`/templates/${id}/use`, intent);
    expect(one.status).toBe(201); expect(retry.body.data.id).toBe(one.body.data.id); expect(one.body.data).toMatchObject({ status: 'DRAFT', revision: 1, difficulty: 'HARD' });
    const two = await api(owner).post(`/templates/${id}/use`, { ...intent, commandId: commandId() });
    expect(two.body.data.id).not.toBe(one.body.data.id);
    expect((await api(other).post(`/templates/${id}/use`, { ...intent, commandId: commandId() })).status).toBe(404);
    const standard = await api(owner).post(`/templates/${catalog.body.data[0].id}/use`, { ...intent, commandId: commandId() });
    expect(standard.status).toBe(201); expect(standard.body.data.status).toBe('DRAFT'); expect(standard.body.data.validation.length).toBeGreaterThan(0);
    expect((await api(owner).post(`/templates/${id}/archive`, { commandId: commandId(), revision: 2 })).status).toBe(409);
    expect((await api(owner).post(`/templates/${id}/archive`, { commandId: commandId(), revision: 1 })).status).toBe(200);
    expect((await api(owner).post(`/templates/${id}/use`, { ...intent, commandId: commandId() })).status).toBe(404);
    expect(await db.contentItem.count({ where: { poolId: p.id } })).toBe(3);
  }
});
it('refuses concrete media IDs in reusable templates instead of silently dropping a private file', async () => {
  const r = await api(owner).post('/templates', { commandId: commandId(), gameSlug: 'wissensduell', name: 'Do not lose media', item: { ...quiz, payload: { ...quiz.payload, mediaAssetId: randomUUID() } } });
  expect(r.status).toBe(400); expect(r.body.error.code).toBe('INVALID_CONTENT');
});
it('assigns version-fenced review work only to current editors; completion never publishes or mutates content', async () => {
  const p = await pool('wissensduell', 'SHARED', [otherId]), q = await item(p.id);
  const intent = { commandId: commandId(), itemId: q.id, itemRevision: 1, assigneeId: otherId, note: 'Quelle prüfen', assignmentRevision: null };
  expect((await api(other).post('/assignments', intent)).status).toBe(403);
  const assigned = await api(owner).post('/assignments', intent), retried = await api(owner).post('/assignments', intent);
  expect(assigned.status).toBe(201); expect(retried.body.data.id).toBe(assigned.body.data.id);
  const id = assigned.body.data.id;
  expect((await api(other).get('/assignments')).body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id, canAdvance: true, stale: false })]));
  expect((await api(owner).post(`/assignments/${id}/status`, { commandId: commandId(), revision: 1, status: 'IN_REVIEW' })).status).toBe(403);
  expect((await api(other).post(`/assignments/${id}/status`, { commandId: commandId(), revision: 1, status: 'DONE' })).status).toBe(409);
  expect((await api(other).post(`/assignments/${id}/status`, { commandId: commandId(), revision: 1, status: 'IN_REVIEW' })).status).toBe(200);
  const done = { commandId: commandId(), revision: 2, status: 'DONE' };
  expect((await api(other).post(`/assignments/${id}/status`, done)).status).toBe(200);
  expect((await api(other).post(`/assignments/${id}/status`, done)).body.data.status).toBe('DONE');
  expect(await db.contentItem.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: 'DRAFT', reviewState: 'NOT_REVIEWED', revision: 1 });
  expect(await db.contentRevision.count({ where: { itemId: q.id } })).toBe(1);
  await api(owner).put(`/items/${q.id}`, { commandId: commandId(), revision: 1, item: { ...quiz, title: 'New version' } });
  expect((await api(other).get('/assignments')).body.data.find((t: { id: string }) => t.id === id).stale).toBe(true);
  expect((await api(owner).post('/assignments', { ...intent, commandId: commandId(), itemRevision: 2, assignmentRevision: 2 })).status).toBe(409);
  expect((await api(owner).post('/assignments', { ...intent, commandId: commandId(), itemRevision: 2, assignmentRevision: 3 })).status).toBe(201);
  await db.contentPool.update({ where: { id: p.id }, data: { scope: 'PRIVATE', editorIdsJson: '[]' } });
  expect((await api(other).get('/assignments')).body.data).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
  expect((await api(other).post(`/assignments/${id}/status`, { commandId: commandId(), revision: 4, status: 'IN_REVIEW' })).status).toBe(404);
});
it('hides public pending proposals and historical drafts from unrelated hosts, including old receipt replays', async () => {
  const p = await pool('wissensduell', 'SHARED', [otherId]), q = await item(p.id);
  const commentIntent = { commandId: commandId(), message: 'PREPUBLIC_INTERNAL_COMMENT' };
  expect((await api(other).post(`/items/${q.id}/comments`, commentIntent)).status).toBe(201);
  const editIntent = { commandId: commandId(), revision: 1, item: { ...quiz, title: 'PREPUBLIC_PRIVATE_DRAFT' } };
  expect((await api(other).put(`/items/${q.id}`, editIntent)).status).toBe(200);
  await ready(q.id, 2);
  await db.contentPool.update({ where: { id: p.id }, data: { scope: 'PUBLIC', editorIdsJson: '[]' } });
  await db.contentItem.update({ where: { id: q.id }, data: { reviewState: 'APPROVED' } });
  const proposed = await api(owner).post(`/items/${q.id}/propose`, { commandId: commandId(), revision: 3,
    item: { ...quiz, payload: { ...quiz.payload, prompt: 'PENDING_UNPUBLISHED_SECRET' }, source: 'Eigene Frage', license: 'Eigene Rechte' } });
  expect(proposed.status).toBe(200);
  const stranger = await api(other).get('/reviews'); expect(JSON.stringify(stranger.body)).not.toContain('PENDING_UNPUBLISHED_SECRET');
  expect((await api(owner).get('/reviews')).body.data.find((r: { id: string }) => r.id === proposed.body.data.reviewId).current[0].payload.prompt).toBe(quiz.payload.prompt);
  expect((await api(other).get(`/items/${q.id}/history`)).status).toBe(403);
  expect((await api(other).post(`/items/${q.id}/comments`, commentIntent)).status).toBe(403);
  expect((await api(other).put(`/items/${q.id}`, editIntent)).status).toBe(403);
});
