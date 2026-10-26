import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { config } from '../config/index.js';
import { createTestDatabase, seedTestUserWithDb } from '../test-helpers.js';
import { runNextMediaJob, cleanupMediaJobStaging } from './jobs.js';
let dir: string, db: PrismaClient, previous: PrismaClient | undefined, app: ReturnType<typeof createApp>, cookie: string, foreign: string, image: Buffer, audio: Buffer;
const originalUploads = config.storagePaths.uploads, originalAudio = { ...config.audioProcessing };
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-jobs-')); const url = `file:${join(dir, 'db.sqlite')}`; await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db; config.storagePaths.uploads = join(dir, 'uploads'); app = createApp();
  cookie = (await seedTestUserWithDb(db, 'jobs-owner', 'Jobs', 'jobs@example.test')).cookie;
  foreign = (await seedTestUserWithDb(db, 'jobs-other', 'Other', 'other@example.test')).cookie;
  image = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#336699' } }).png().toBuffer();
  const file = join(dir, 'sound.wav'); await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', file]); audio = await readFile(file);
});
afterEach(() => { Object.assign(config.audioProcessing, originalAudio); });
afterAll(async () => { await new Promise<void>(resolve => app.io.close(() => resolve())); await db.$disconnect(); globalThis.__prisma = previous; config.storagePaths.uploads = originalUploads; await rm(dir, { recursive: true, force: true }); });
const upload = (bytes: Buffer, commandId = randomUUID()) => supertest(app.app).post('/api/v1/media/jobs').set('Cookie', cookie).field('commandId', commandId).attach('file', bytes, 'untrusted.bin');
const status = (id: string, c = cookie) => supertest(app.app).get(`/api/v1/media/jobs/${id}`).set('Cookie', c);
it('queues privately, preserves original bytes, commits WEB plus thumbnail atomically and protects both provenance edges', async () => {
  const created = await upload(image); expect(created.status).toBe(202); expect(created.body.data.status).toBe('QUEUED'); const id = created.body.data.id;
  expect((await status(id, foreign)).status).toBe(404); expect((await status(id, '')).status).toBe(403);
  expect(await runNextMediaJob(db)).toBe(true); const ready = await status(id); expect(ready.body.data.status).toBe('READY'); expect(ready.body.data.asset.mimeType).toBe('image/webp');
  const job = await db.mediaProcessingJob.findUniqueOrThrow({ where: { id }, include: { original: true } });
  expect(await readFile(job.original.storagePath)).toEqual(image); expect(job.original.variantKind).toBe('ORIGINAL');
  const variants = await db.mediaAssetVariant.findMany({ where: { originalId: job.originalId }, include: { asset: true } }); expect(variants.map(v => v.kind).sort()).toEqual(['THUMBNAIL', 'WEB']);
  for (const variant of variants) { expect(variant.asset.processStatus).toBe('READY'); expect(JSON.parse(variant.asset.derivedFromAssetIds!)).toEqual([job.originalId]); }
  const thumb = variants.find(v => v.kind === 'THUMBNAIL')!; expect(thumb.asset.width).toBe(384); expect(thumb.asset.height).toBe(192);
  expect(JSON.stringify(ready.body.data)).not.toMatch(/storagePath|uploads|leaseToken|originalName/);
  const download = await supertest(app.app).get(`/api/v1/media/jobs/${id}/original`).set('Cookie', cookie); expect(download.status).toBe(200); expect(download.headers['content-disposition']).toContain('attachment');
  expect((await supertest(app.app).get(`/api/v1/media/${job.originalId}`)).status).toBe(403);
  await expect(db.mediaAsset.delete({ where: { id: job.originalId } })).rejects.toThrow();
  expect(await runNextMediaJob(db)).toBe(false);
});
it('replays the same upload intention without new originals and rejects changed payloads under that intention', async () => {
  const command = randomUUID(), first = await upload(image, command), again = await upload(image, command); expect(again.body.data.id).toBe(first.body.data.id);
  expect((await upload(audio, command)).status).toBe(409);
  expect(await db.mediaProcessingJob.count({ where: { commandId: command } })).toBe(1);
  await runNextMediaJob(db);
});
it('recovers an expired PROCESSING lease from durable state, fences concurrent workers and removes abandoned uncommitted variants', async () => {
  const created = await upload(image), id = created.body.data.id;
  await db.mediaProcessingJob.update({ where: { id }, data: { status: 'PROCESSING', leaseToken: 'dead-worker', leaseUntil: new Date(0), attempts: 1 } });
  await mkdir(join(dir, 'uploads', 'variants'), { recursive: true }); const abandoned = join(dir, 'uploads', 'variants', `${id}-dead-worker-WEB.webp`); await writeFile(abandoned, 'unfinished');
  const restarted = new PrismaClient({ datasourceUrl: `file:${join(dir, 'db.sqlite')}` });
  try { await Promise.all([runNextMediaJob(restarted), runNextMediaJob(db)]); } finally { await restarted.$disconnect(); }
  const ready = await status(id); expect(ready.body.data.status).toBe('READY'); expect(ready.body.data.variants).toHaveLength(2);
  await expect(readFile(abandoned)).rejects.toThrow(); expect(await db.mediaAssetVariant.count({ where: { originalId: ready.body.data.originalId } })).toBe(2);
});
it('marks damaged input REJECTED, creates no playable variant and never serves the original', async () => {
  const created = await upload(Buffer.from('not an image or audio')), id = created.body.data.id; await runNextMediaJob(db);
  const rejected = await status(id); expect(rejected.body.data.status).toBe('REJECTED'); expect(rejected.body.data.asset).toBeNull(); expect(rejected.body.data.variants).toEqual([]);
  expect((await supertest(app.app).get(`/api/v1/media/jobs/${id}/original`).set('Cookie', cookie)).status).toBe(404);
});
it('persists a retryable decoder failure and resumes the same audio job after the processor is repaired', async () => {
  config.audioProcessing.ffmpeg = join(dir, 'missing-processor'); const queued = await upload(audio), id = queued.body.data.id; await runNextMediaJob(db);
  const failed = await status(id); expect(failed.body.data).toMatchObject({ status: 'FAILED', retryable: true, errorCode: 'MEDIA_PROCESSOR_UNAVAILABLE', asset: null });
  expect((await supertest(app.app).post(`/api/v1/media/jobs/${id}/retry`).set('Cookie', foreign)).status).toBe(404);
  Object.assign(config.audioProcessing, originalAudio);
  const retry = await supertest(app.app).post(`/api/v1/media/jobs/${id}/retry`).set('Cookie', cookie); expect(retry.body.data.status).toBe('QUEUED');
  await runNextMediaJob(db); const ready = await status(id); expect(ready.body.data.asset.mimeType).toBe('audio/mpeg'); expect(ready.body.data.variants).toMatchObject([{ kind: 'NORMALIZED_AUDIO' }]);
});

it('cleans old unreferenced staging bytes while preserving the original of a queued job', async () => {
  const queued = await upload(image), job = await db.mediaProcessingJob.findUniqueOrThrow({ where: { id: queued.body.data.id }, include: { original: true } });
  const orphan = join(dir, 'uploads', 'originals', `${randomUUID()}.bin`); await writeFile(orphan, 'abandoned');
  await utimes(orphan, new Date(0), new Date(0)); await utimes(job.original.storagePath, new Date(0), new Date(0));
  await cleanupMediaJobStaging(db); await expect(readFile(orphan)).rejects.toThrow(); expect(await readFile(job.original.storagePath)).toEqual(image);
  await runNextMediaJob(db); expect((await status(job.id)).body.data.status).toBe('READY');
});
