import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import sharp from 'sharp';
import { createTestDatabase } from '../test-helpers.js';
import { createSessionCookie } from '../auth/session.js';
import { config } from '../config/index.js';
import { createApp } from '../app.js';
import { contentMediaUrl } from './media.js';

let dir: string, db: PrismaClient, previous: PrismaClient | undefined, app: ReturnType<typeof createApp>;
let owner: string, other: string, ownerId: string, otherId: string;
const quiz = { title: 'Draft', payload: { prompt: 'TEST_QUESTION', category: 'Test', options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }], correctOptionId: 'b', explanation: 'SECRET_EXPLANATION' } };
const clue = { title: 'Clue', payload: { question: 'TEST_CLUE', category: 'Test', value: 100, answer: 'SECRET_ANSWER' } };
const api = (cookie = '') => ({ get: (path: string) => supertest(app.app).get(`/api/v1/content${path}`).set('Cookie', cookie),
  post: (path: string, data: object) => supertest(app.app).post(`/api/v1/content${path}`).set('Cookie', cookie).send(data) });
async function fixture(slug = 'wissensduell', value: object = quiz) {
  const p = await api(owner).post('/pools', { commandId: randomUUID(), gameSlug: slug, name: 'Playtest pool' }); expect(p.status).toBe(201);
  const q = await api(owner).post(`/pools/${p.body.data.id}/items`, { commandId: randomUUID(), item: value }); expect(q.status).toBe(201);
  return { pool: p.body.data, item: q.body.data };
}
async function start(poolId: string, items: Array<{ id: string; revision: number }>, commandId = randomUUID()) {
  const r = await api(owner).post('/playtests', { commandId, poolId, items: items.map(({ id, revision }) => ({ id, revision })) }); expect(r.status).toBe(201); return r.body.data;
}
const control = (code: string, version: number, action: string, cookie = owner) => api(cookie).post(`/playtests/${code}/control`, { commandId: randomUUID(), version, action });
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-playtest-')); const url = `file:${join(dir, 'test.db')}`; await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db; app = createApp();
  const users = await Promise.all(['HOST', 'HOST'].map(role => db.user.create({ data: { displayName: randomUUID(), role, passwordHash: 'unused' } })));
  ownerId = users[0].id; otherId = users[1].id;
  [owner, other] = await Promise.all(users.map(async user => createSessionCookie((await db.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) } })).id, config.sessionSecret)));
  for (const slug of ['wissensduell', 'jeopardy']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA' } });
});
afterAll(async () => { await new Promise<void>(resolve => app.io.close(() => resolve())); await db.$disconnect(); globalThis.__prisma = previous; await rm(dir, { recursive: true, force: true }); });
it('runs both saved DRAFT games with role-safe projections, explicit reveal, and no normal room, stats or scoring', async () => {
  const counts = async () => Promise.all([db.room.count(), db.participation.count(), db.scoreEvent.count(), db.gameResultRecord.count(), db.roundResultRecord.count(), db.contentUse.count()]);
  const before = await counts();
  for (const [slug, value, secret] of [['wissensduell', quiz, 'SECRET_EXPLANATION'], ['jeopardy', clue, 'SECRET_ANSWER']] as const) {
    const f = await fixture(slug, value), test = await start(f.pool.id, [f.item]);
    for (const role of ['PLAYER', 'VIEWER', 'TEAM']) {
      const r = await api().get(`/playtests/${test.code}?role=${role}`); expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain(secret); expect(r.body.data.canControl).toBe(false);
    }
    expect((await api().get(`/playtests/${test.code}?role=HOST`)).status).toBe(403);
    expect(JSON.stringify((await api(owner).get(`/playtests/${test.code}?role=HOST`)).body)).toContain(secret);
    expect((await control(test.code, 1, 'REVEAL', other)).status).toBe(403);
    expect((await control(test.code, 1, 'REVEAL')).status).toBe(200);
    expect(JSON.stringify((await api().get(`/playtests/${test.code}`)).body)).toContain(secret);
    expect((await control(test.code, 1, 'CLOSE')).status).toBe(409);
    expect((await control(test.code, 2, 'CLOSE')).status).toBe(200);
    expect((await api().get(`/playtests/${test.code}`)).status).toBe(404);
    expect((await api(owner).get(`/playtests/${test.code}?role=HOST`)).body.data.question).toBeNull();
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: f.item.id } })).status).toBe('DRAFT');
  }
  expect(await counts()).toEqual(before);
});
it('pins only explicitly selected saved revisions, keeps snapshot immutable and refuses stale/foreign/duplicate selection', async () => {
  const f = await fixture(), foreign = await fixture();
  const input = { commandId: randomUUID(), poolId: f.pool.id, items: [{ id: f.item.id, revision: 1 }] };
  const created = await api(owner).post('/playtests', input), replay = await api(owner).post('/playtests', input); expect(created.body.data.code).toBe(replay.body.data.code);
  const code = created.body.data.code;
  await supertest(app.app).put(`/api/v1/content/items/${f.item.id}`).set('Cookie', owner).send({ commandId: randomUUID(), revision: 1, item: { ...quiz, payload: { ...quiz.payload, prompt: 'CHANGED_QUESTION' } } }).expect(200);
  const r = await api().get(`/playtests/${code}`); expect(r.body.data.question.prompt).toBe('TEST_QUESTION'); expect(r.body.data.endsAt).toBeTypeOf('number');
  await expect(db.contentPlaytest.update({ where: { code }, data: { snapshotJson: '[]' } })).rejects.toThrow();
  expect((await api(owner).post('/playtests', { ...input, commandId: randomUUID() })).status).toBe(409);
  expect((await api(owner).post('/playtests', { ...input, commandId: randomUUID(), items: [foreign.item] })).status).toBe(400);
  expect((await api(owner).post('/playtests', { ...input, commandId: randomUUID(), items: [{ id: foreign.item.id, revision: 1 }] })).status).toBe(404);
  expect((await api(other).post('/playtests', { ...input, commandId: randomUUID() })).status).toBe(404);
  const current = { id: f.item.id, revision: 2 };
  expect((await api(owner).post('/playtests', { ...input, commandId: randomUUID(), items: [current, current] })).status).toBe(400);
});
it('projects invalid drafts through an allowlist and collects validation warnings without leaking injected option secrets', async () => {
  const f = await fixture('wissensduell', { title: 'Invalid', payload: { ...quiz.payload, options: [{ id: 'a', text: 'Visible', secret: 'HIDDEN_OPTION_SECRET', correct: true }], correctOptionId: 'HIDDEN_OPTION_SECRET' } });
  const t = await start(f.pool.id, [f.item]), r = await api().get(`/playtests/${t.code}`);
  expect(r.status).toBe(200); expect(r.body.data.warnings.length).toBeGreaterThan(0); expect(JSON.stringify(r.body)).not.toContain('HIDDEN_OPTION_SECRET'); expect(JSON.stringify(r.body)).not.toContain('"correct"');
  const preview = await api(owner).get(`/items/${f.item.id}/preview?role=PLAYER`); expect(JSON.stringify(preview.body)).not.toContain('HIDDEN_OPTION_SECRET');
});
it('stores one answer/report per client and question, survives rejoin, hides reports, and enforces role/version/timer boundaries', async () => {
  const f = await fixture(), t = await start(f.pool.id, [f.item]), clientKey = randomUUID();
  const input = { clientKey, role: 'PLAYER', version: 1, kind: 'ANSWER', value: 'a' };
  for (const role of ['VIEWER', 'TEAM', 'HOST']) expect((await api().post(`/playtests/${t.code}/feedback`, { ...input, role })).status).toBe(403);
  expect((await api().post(`/playtests/${t.code}/feedback`, { ...input, value: 'unknown' })).status).toBe(400);
  const race = await Promise.all([api().post(`/playtests/${t.code}/feedback`, input), api().post(`/playtests/${t.code}/feedback`, input)]); expect(race.map(r => r.status)).toEqual([200, 200]);
  expect((await api().post(`/playtests/${t.code}/feedback`, { ...input, value: 'b' })).status).toBe(409);
  expect((await api().get(`/playtests/${t.code}?clientKey=${clientKey}`)).body.data.ownAnswer).toBe('a');
  const report = { ...input, kind: 'REPORT', value: 'PRIVATE_TEST_REPORT' };
  expect((await api().post(`/playtests/${t.code}/feedback`, report)).status).toBe(200);
  expect(JSON.stringify((await api().get(`/playtests/${t.code}?clientKey=${clientKey}`)).body)).not.toContain(report.value);
  expect(JSON.stringify((await api(owner).get(`/playtests/${t.code}?role=HOST`)).body)).toContain(report.value);
  await db.contentPlaytest.update({ where: { code: t.code }, data: { startedAt: new Date(Date.now() - 60000) } });
  expect((await api().post(`/playtests/${t.code}/feedback`, { ...input, clientKey: randomUUID() })).status).toBe(409);
  expect((await control(t.code, 1, 'REVEAL')).status).toBe(200);
  expect((await api().post(`/playtests/${t.code}/feedback`, { ...input, clientKey: randomUUID() })).status).toBe(409);
  expect((await api().post(`/playtests/${t.code}/feedback`, { ...input, version: 2, clientKey: randomUUID() })).status).toBe(409);
  expect(await db.contentPlaytestFeedback.count({ where: { playtest: { code: t.code }, kind: 'ANSWER' } })).toBe(1);
});
it('revokes expired capabilities and sharing authority after account disabling or editor removal', async () => {
  const f = await fixture(), t = await start(f.pool.id, [f.item]);
  await db.user.update({ where: { id: ownerId }, data: { disabledAt: new Date() } });
  expect((await api().get(`/playtests/${t.code}`)).status).toBe(404);
  await db.user.update({ where: { id: ownerId }, data: { disabledAt: null } });
  await db.contentPool.update({ where: { id: f.pool.id }, data: { ownerId: otherId } });
  expect((await api().get(`/playtests/${t.code}`)).status).toBe(404);
  await db.contentPool.update({ where: { id: f.pool.id }, data: { ownerId } });
  await db.contentPlaytest.update({ where: { code: t.code }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect((await api(owner).get(`/playtests/${t.code}?role=HOST`)).status).toBe(404);
  expect((await control(t.code, 1, 'CLOSE')).status).toBe(404);
});
it('delivers only current pinned test media, fences forged/future links, and revokes on close/expiry', async () => {
  const file = join(dir, 'test.png'); await writeFile(file, await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer());
  const assets = await Promise.all([1, 2].map(() => db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: randomUUID(), originalName: 'test.png', fileSize: 100, sha256: randomUUID(), storagePath: file, uploadedBy: ownerId, visibility: 'PRIVATE', processStatus: 'READY' } })));
  const rights = { source: '', sourceUrl: '', author: '', license: '', ownMaterial: true, recognizablePerson: false, consent: false };
  const f = await fixture('wissensduell', { ...quiz, payload: { ...quiz.payload, mediaAssetId: assets[0].id, mediaType: 'image', mediaRights: rights } });
  const q = await api(owner).post(`/pools/${f.pool.id}/items`, { commandId: randomUUID(), item: { ...quiz, payload: { ...quiz.payload, mediaAssetId: assets[1].id, mediaType: 'image', mediaRights: rights } } }); expect(q.status).toBe(201);
  const t = await start(f.pool.id, [{ id: f.item.id, revision: 1 }, { id: q.body.data.id, revision: 1 }]);
  const first = (await api().get(`/playtests/${t.code}`)).body.data.question.mediaUrl;
  const future = contentMediaUrl(assets[1].id, { kind: 'PLAYTEST', code: t.code, itemId: q.body.data.id, revision: 1 });
  expect((await supertest(app.app).get(first)).status).toBe(200); expect((await supertest(app.app).get(future)).status).toBe(403);
  expect((await supertest(app.app).get(first.replace(assets[0].id, assets[1].id))).status).toBe(403);
  expect((await control(t.code, 1, 'NEXT')).status).toBe(200);
  expect((await supertest(app.app).get(first)).status).toBe(403); expect((await supertest(app.app).get(future)).status).toBe(200);
  await db.user.update({ where: { id: ownerId }, data: { disabledAt: new Date() } }); expect((await supertest(app.app).get(future)).status).toBe(403);
  await db.user.update({ where: { id: ownerId }, data: { disabledAt: null } });
  expect((await control(t.code, 2, 'CLOSE')).status).toBe(200); expect((await supertest(app.app).get(future)).status).toBe(403);
  const t2 = await start(f.pool.id, [f.item]); const expiredUrl = (await api().get(`/playtests/${t2.code}`)).body.data.question.mediaUrl;
  await db.contentPlaytest.update({ where: { code: t2.code }, data: { expiresAt: new Date(0) } }); expect((await supertest(app.app).get(expiredUrl)).status).toBe(403);
});
