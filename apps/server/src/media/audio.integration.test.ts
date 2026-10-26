import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { config } from '../config/index.js';
import { createTestDatabase, seedTestUserWithDb } from '../test-helpers.js';
import { buildSignedMediaUrl } from './signedUrl.js';

const run = promisify(execFile);
let dir: string, db: PrismaClient, previous: PrismaClient | undefined, app: ReturnType<typeof createApp>, cookie: string, source: string;
const owned = new Set<string>();
const originalAudioConfig = { ...config.audioProcessing }, originalSize = config.maxFileSizes.audio;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-audio-')); const url = `file:${join(dir, 'test.db')}`; await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db; app = createApp();
  cookie = (await seedTestUserWithDb(db, 'audio-host', 'Audio', 'audio@test.local')).cookie;
  source = join(dir, 'quiet.wav'); await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-af', 'volume=0.02', '-metadata', 'title=AUDIO_PRIVATE_TITLE', source]);
});
afterEach(() => { Object.assign(config.audioProcessing, originalAudioConfig); config.maxFileSizes.audio = originalSize; vi.restoreAllMocks(); });
afterAll(async () => {
  for (const row of await db.mediaAsset.findMany()) if (row.uploadedBy === 'audio-host') await rm(row.storagePath, { force: true });
  for (const path of owned) await rm(path, { force: true });
  await db.$disconnect(); globalThis.__prisma = previous; await rm(dir, { recursive: true, force: true });
});
const upload = (buffer: Buffer, filename = 'untrusted.exe', contentType = 'image/png') => supertest(app.app).post('/api/v1/media').set('Cookie', cookie).attach('file', buffer, { filename, contentType });
async function uploadFiles() { const path = config.storagePaths.uploads; try { return (await readdir(path)).filter(f => /^[a-f0-9]{32}\./.test(f)).sort(); } catch { return []; } }

it.each([
  ['WAV', 'wav', 'pcm_s16le'], ['MP3', 'mp3', 'libmp3lame'], ['M4A', 'ipod', 'aac'], ['AAC', 'adts', 'aac'], ['OGG', 'ogg', 'libvorbis'],
])('fully decodes %s, normalizes quiet audio, strips metadata and uses a server-controlled MP3 extension', async (_name, format, codec) => {
  const input = join(dir, `input-${format}.bin`); await run('ffmpeg', ['-v', 'error', '-i', source, '-c:a', codec, '-metadata', 'title=AUDIO_PRIVATE_TITLE', '-f', format, input]);
  const r = await upload(await readFile(input)); expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  expect(r.body.data).toMatchObject({ type: 'audio', mimeType: 'audio/mpeg', duration: expect.any(Number) }); expect(r.body.data.filename).toMatch(/^[a-f0-9]{32}\.mp3$/);
  const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id: r.body.data.id } }); expect(asset.processStatus).toBe('READY'); expect(asset.processed).toBe(true); expect(asset.duration).toBeGreaterThanOrEqual(1900); expect(asset.duration).toBeLessThan(2150);
  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_name,sample_rate,channels', '-of', 'json', asset.storagePath]); const data = JSON.parse(probe.stdout);
  expect(data.streams).toEqual([{ codec_name: 'mp3', sample_rate: '48000', channels: 2 }]); expect(JSON.stringify(data)).not.toContain('AUDIO_PRIVATE_TITLE');
  const decoded = await run('ffmpeg', ['-v', 'error', '-i', asset.storagePath, '-ac', '1', '-f', 'f32le', 'pipe:1'], { encoding: null });
  let energy = 0; for (let offset = 0; offset < decoded.stdout.length; offset += 4) energy += decoded.stdout.readFloatLE(offset) ** 2;
  const rms = Math.sqrt(energy / (decoded.stdout.length / 4)); expect(rms).toBeGreaterThan(0.04); expect(rms).toBeLessThan(0.35);
  const delivered = await supertest(app.app).get(buildSignedMediaUrl({ assetId: asset.id, audience: 'host' })).set('Cookie', cookie); expect(delivered.status).toBe(200); expect(delivered.headers['content-type']).toMatch(/audio\/mpeg/);
  expect((await supertest(app.app).get(`/api/v1/media/${asset.id}`)).status).toBe(403);
});

it.each(['ID3', 'RIFF', 'ftyp', 'OggS', 'AAC'])('rejects a forged %s header without READY rows or orphaned uploads', async header => {
  const bytes = Buffer.alloc(80); if (header === 'RIFF') { bytes.write('RIFF'); bytes.write('WAVE', 8); } else if (header === 'ftyp') bytes.write('ftyp', 4); else if (header === 'AAC') { bytes[0] = 0xff; bytes[1] = 0xf1; } else bytes.write(header);
  const before = await uploadFiles(), count = await db.mediaAsset.count(); const r = await upload(bytes); expect(r.status).toBe(415); expect(r.body.error.code).toBe('MEDIA_REJECTED'); expect(await db.mediaAsset.count()).toBe(count); expect(await uploadFiles()).toEqual(before);
});

it('rejects truncated, overlong and oversized real audio instead of silently trimming or persisting it', async () => {
  const bytes = await readFile(source), before = await uploadFiles(), count = await db.mediaAsset.count();
  expect((await upload(bytes.subarray(0, Math.floor(bytes.length / 2)))).status).toBe(415);
  config.audioProcessing.maxDurationSeconds = 1; expect((await upload(bytes)).status).toBe(415); config.audioProcessing.maxDurationSeconds = originalAudioConfig.maxDurationSeconds;
  config.maxFileSizes.audio = 1024; expect((await upload(bytes)).status).toBe(415);
  expect(await db.mediaAsset.count()).toBe(count); expect(await uploadFiles()).toEqual(before);
});

it('returns a retryable failure if the processor is absent, and keeps identical retries owner-scoped and idempotent', async () => {
  const bytes = await readFile(source), before = await uploadFiles(); config.audioProcessing.ffmpeg = join(dir, 'missing-ffmpeg');
  const unavailable = await upload(bytes); expect(unavailable.status).toBe(503); expect(unavailable.body.error.code).toBe('MEDIA_PROCESSOR_UNAVAILABLE'); expect(await uploadFiles()).toEqual(before);
  config.audioProcessing.ffmpeg = originalAudioConfig.ffmpeg;
  const first = await upload(bytes), second = await upload(bytes); expect([200, 201]).toContain(first.status); expect(second.status).toBe(200); expect(second.body.data.id).toBe(first.body.data.id); expect(second.body.data.deduplicated).toBe(true);
  const other = await seedTestUserWithDb(db, 'other-audio-host', 'Other', 'other-audio@test.local');
  const foreign = await supertest(app.app).post('/api/v1/media').set('Cookie', other.cookie).attach('file', bytes, 'same.wav'); expect(foreign.status).toBe(201); expect(foreign.body.data.id).not.toBe(first.body.data.id);
  owned.add((await db.mediaAsset.findUniqueOrThrow({ where: { id: foreign.body.data.id } })).storagePath);
});

it('rejects an actual video container even when it contains an audio stream', async () => {
  const file = join(dir, 'video.mp4'); await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=1', '-i', source, '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', file]);
  const before = await uploadFiles(); expect((await upload(await readFile(file), 'song.m4a', 'audio/mp4')).status).toBe(415); expect(await uploadFiles()).toEqual(before);
});

it('bounds processor runtime and concurrent decoders, cleans both failed uploads and releases the processing slot', async () => {
  const executable = join(dir, 'slow-ffmpeg'), marker = join(dir, 'processor-started');
  await writeFile(executable, '#!/usr/bin/env node\nconst fs = require("node:fs"), path = require("node:path"); fs.writeFileSync(path.join(path.dirname(process.argv[1]), "processor-started"), "started"); setInterval(() => {}, 1000);\n'); await chmod(executable, 0o755);
  config.audioProcessing.ffmpeg = executable; config.audioProcessing.timeoutMs = 1000; config.audioProcessing.concurrency = 1;
  const bytes = await readFile(source), before = await uploadFiles(); const pending = upload(bytes).then(r => r);
  await vi.waitFor(() => access(marker), { timeout: 1000 });
  const busy = await upload(bytes); expect(busy.status).toBe(503); expect(busy.body.error.code).toBe('MEDIA_PROCESSOR_BUSY');
  const timedOut = await pending; expect(timedOut.status).toBe(503); expect(timedOut.body.error.code).toBe('MEDIA_PROCESSOR_TIMEOUT'); expect(await uploadFiles()).toEqual(before);
  Object.assign(config.audioProcessing, originalAudioConfig); expect([200, 201]).toContain((await upload(bytes)).status);
});
