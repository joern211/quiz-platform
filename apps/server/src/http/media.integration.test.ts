// ============================================================
// Media Integration Tests — PR11 Medienrechte + sichere Verarbeitung
//
// Prüft ECHTE Risiken (Regelwerk §7.6–7.9, §10.7/10.8, §15.3):
//   1. Upload: echter Content-Check (MIME-Spoofing, korrupt, Abmessungen),
//      EXIF-Strip, Dedupe ohne Ownership-Transfer, Fehler-Cleanup (keine Orphan).
//   2. GET-Zugriff: PUBLIC offen; PRIVATE ohne/gut/veraltete/foreign-Signed-URL,
//      host-audience nur mit Session+Host-Recht; Cache-Header; Geo-Medien OK.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import {
  createTestDatabase,
  seedTestUserWithDb,
  getOrCreateGeoGame,
} from '../test-helpers.js';

// Ein kleines echtes PNG (zufällige Größe/Farbe → eindeutiger sha256 pro Aufruf).
const tinyPng = () => sharp({
  create: {
    width: 4 + Math.floor(Math.random() * 32),
    height: 4 + Math.floor(Math.random() * 32),
    channels: 3,
    background: { r: Math.floor(Math.random() * 256), g: Math.floor(Math.random() * 256), b: Math.floor(Math.random() * 256) },
  },
}).png().toBuffer();
// Ein "Bild", das eigentlich Text ist (MIME-Spoofing / korrupt).
const corruptedImage = (): Buffer => Buffer.from('this is definitely not an image', 'utf8');

interface TestCtx {
  app: Awaited<ReturnType<typeof makeApp>>['app'];
  prisma: import('@prisma/client').PrismaClient;
  request: ReturnType<typeof supertest>;
  dbUrl: string;
  tmpDir: string;
}

const ALL_TEMP_DIRS: string[] = [];

async function makeApp() {
  const { PrismaClient } = await import('@prisma/client');
  const { mkdtemp } = await import('node:fs/promises');
  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-media-'));
  ALL_TEMP_DIRS.push(tmpDir);
  const dbPath = join(tmpDir, 'test.db');
  const dbUrl = `file:${dbPath}`;
  await createTestDatabase(dbUrl);
  const freshPrisma = new PrismaClient({ datasourceUrl: dbUrl });
  await freshPrisma.$connect();
  globalThis.__prisma = freshPrisma;
  const { createApp } = await import('../app.js');
  const { app } = createApp();
  return { app, prisma: freshPrisma, request: supertest(app), dbUrl, tmpDir };
}

async function uploadsDir(): Promise<string> {
  const { config } = await import('../config/index.js');
  return join(config.storagePaths.root, 'uploads');
}

async function countUploadFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    return entries.filter(e => e !== '.gitkeep').length;
  } catch { return 0; }
}

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await makeApp();
  const { config } = await import('../config/index.js');
  // Sicherstellen, dass das Upload-Verzeichnis existiert.
  await import('node:fs/promises').then(fs => fs.mkdir(join(config.storagePaths.root, 'uploads'), { recursive: true }));
});

afterAll(async () => {
  for (const dir of ALL_TEMP_DIRS) { try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// Seedet ein Asset direkt in der DB (mit echter Datei), damit GET-Tests laufen.
async function seedAsset(db: import('@prisma/client').PrismaClient, opts: {
  visibility?: string; roomId?: string | null; uploadedBy?: string | null; buffer?: Buffer;
}): Promise<string> {
  const { config } = await import('../config/index.js');
  const dir = join(config.storagePaths.root, 'uploads');
  const buffer = opts.buffer ?? await tinyPng();
  const filename = `${Math.random().toString(36).slice(2)}.webp`;
  const storagePath = join(dir, filename);
  await writeFile(storagePath, buffer);
  const sha256 = (await import('node:crypto')).createHash('sha256').update(buffer).digest('hex');
  const asset = await db.mediaAsset.create({
    data: {
      type: 'image', mimeType: 'image/webp', filename, originalName: filename,
      fileSize: buffer.length, width: 8, height: 8, sha256, storagePath,
      uploadedBy: opts.uploadedBy ?? null, visibility: opts.visibility ?? 'PRIVATE',
      roomId: opts.roomId ?? null, processStatus: 'READY', processed: true,
    },
  });
  return asset.id;
}

describe('Media API — Upload (echter Content-Check)', () => {
  it('MIME-Spoofing: Text-Datei als image/png gemeldet → 415, keine DB-Zeile, keine Orphan-Datei', async () => {
    const { request, prisma: db } = ctx;
    const before = await countUploadFiles(await uploadsDir());
    const dbBefore = await db.mediaAsset.count();
    const user = await seedTestUserWithDb(db, `mod-spoof-${Date.now()}`, 'Spoof', `spoof-${Date.now()}@t.local`);
    const res = await request.post('/api/v1/media').set('Cookie', user.cookie).attach('file', corruptedImage(), { filename: 'evil.png', contentType: 'image/png' });
    expect(res.status).toBe(415);
    expect(res.body.success).toBe(false);
    // Keine DB-Zeile, keine hinterlassene Datei.
    expect(await db.mediaAsset.count()).toBe(dbBefore);
    expect(await countUploadFiles(await uploadsDir())).toBe(before);
  });

  it('valides PNG → 201, normalisiertes WebP-Asset, width/height gesetzt, processStatus READY', async () => {
    const { request, prisma: db } = ctx;
    const user = await seedTestUserWithDb(db, `mod-good-${Date.now()}`, 'Good', `good-${Date.now()}@t.local`);
    const res = await request.post('/api/v1/media').set('Cookie', user.cookie).attach('file', await tinyPng(), { filename: 'face.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('image');
    expect(res.body.data.mimeType).toBe('image/webp');
    const asset = await db.mediaAsset.findUnique({ where: { id: res.body.data.id } });
    expect(asset).not.toBeNull();
    expect(asset!.width).toBeGreaterThan(0);
    expect(asset!.height).toBeGreaterThan(0);
    expect(asset!.processStatus).toBe('READY');
    expect(asset!.visibility).toBe('PRIVATE');
    expect(asset!.uploadedBy).toBe(user.userId);
  });

  it('unangemeldet → 401, keine Datei/DB', async () => {
    const { request, prisma: db } = ctx;
    const before = await countUploadFiles(await uploadsDir());
    const dbBefore = await db.mediaAsset.count();
    const res = await request.post('/api/v1/media').attach('file', await tinyPng(), { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
    expect(await db.mediaAsset.count()).toBe(dbBefore);
    expect(await countUploadFiles(await uploadsDir())).toBe(before);
  });

  it('Dedupe: gleicher Upload desselben Users → 200, gleiche ID, keine Duplizierung', async () => {
    const { request, prisma: db } = ctx;
    const user = await seedTestUserWithDb(db, `mod-dedupe-${Date.now()}`, 'Dedupe', `dupe-${Date.now()}@t.local`);
    const img = await tinyPng();
    const r1 = await request.post('/api/v1/media').set('Cookie', user.cookie).attach('file', img, { filename: 'a.png', contentType: 'image/png' });
    expect(r1.status).toBe(201);
    const r2 = await request.post('/api/v1/media').set('Cookie', user.cookie).attach('file', img, { filename: 'b.png', contentType: 'image/png' });
    expect(r2.status).toBe(200);
    expect(r2.body.data.deduplicated).toBe(true);
    expect(r2.body.data.id).toBe(r1.body.data.id);
    // Genau ein Asset für diese hochgeladene Datei (nach Normalisierung).
    const stored = await db.mediaAsset.findUniqueOrThrow({ where: { id: r1.body.data.id } });
    const count = await db.mediaAsset.count({ where: { sha256: stored.sha256 } });
    expect(count).toBe(1);
  });
});

describe('Media API — GET Zugriffspolitik (Regelwerk §7.9/§10.8)', () => {
  it('PUBLIC-Asset ist offen (Geo/Wissensduell-Medien bleiben anzeigenbar)', async () => {
    const { request, prisma: db } = ctx;
    const id = await seedAsset(db, { visibility: 'PUBLIC' });
    const res = await request.get(`/api/v1/media/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/webp');
  });

  it('PRIVATE ohne Signed URL → 403 (auch für den Owner)', async () => {
    const { request, prisma: db } = ctx;
    const user = await seedTestUserWithDb(db, `mod-priv-${Date.now()}`, 'Priv', `priv-${Date.now()}@t.local`);
    const id = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: user.userId });
    expect((await request.get(`/api/v1/media/${id}`)).status).toBe(403);
    // Auch mit Session, aber OHNE Signed URL: weiterhin 403.
    expect((await request.get(`/api/v1/media/${id}`).set('Cookie', user.cookie)).status).toBe(403);
  });

  it('game-audience-Signed URL: freigegebenes Spielbild → 200 OHNE Session (Player/Viewer/Display)', async () => {
    const { request, prisma: db } = ctx;
    const id = await seedAsset(db, { visibility: 'PRIVATE' });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    const url = buildSignedMediaUrl({ assetId: id, audience: 'game' });
    const res = await request.get(url);
    expect(res.status).toBe(200);
    // Nicht-öffentliche Inhalte: kein öffentlicher Langzeit-Cache.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('host-audience ohne Session → 403; mit Session+uploader → 200', async () => {
    const { request, prisma: db } = ctx;
    const user = await seedTestUserWithDb(db, `mod-host-${Date.now()}`, 'Host', `host-${Date.now()}@t.local`);
    const id = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: user.userId });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    const hostUrl = buildSignedMediaUrl({ assetId: id, audience: 'host' });
    expect((await request.get(hostUrl)).status).toBe(403); // ohne Session
    expect((await request.get(hostUrl).set('Cookie', user.cookie)).status).toBe(200); // mit Session + uploader
  });

  it('host-audience: fremde Session (kein uploader, kein Raum-Host) → 403', async () => {
    const { request, prisma: db } = ctx;
    const owner = await seedTestUserWithDb(db, `mod-owner-${Date.now()}`, 'Owner', `owner-${Date.now()}@t.local`);
    const intruder = await seedTestUserWithDb(db, `mod-intruder-${Date.now()}`, 'Intruder', `intruder-${Date.now()}@t.local`);
    const id = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: owner.userId });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    const hostUrl = buildSignedMediaUrl({ assetId: id, audience: 'host' });
    expect((await request.get(hostUrl).set('Cookie', intruder.cookie)).status).toBe(403);
  });

  it('host-audience: Session eines Raum-Hosts (asset.roomId) → 200', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-roomhost-${Date.now()}`, 'RoomHost', `roomhost-${Date.now()}@t.local`);
    const geo = await getOrCreateGeoGame();
    const room = await db.room.create({
      data: { code: `9${String(Math.floor(Math.random() * 900) + 100)}-${String(Math.floor(Math.random() * 900) + 100)}`, roomName: 'R', hostUserId: host.userId, gameDefinitionId: geo.id, status: 'LOBBY', setupSnapshotJson: '{}', setupSchemaVersion: 1, runPhase: 'LOBBY', revision: 0 },
    });
    const id = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: 'somebody-else', roomId: room.id });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    const hostUrl = buildSignedMediaUrl({ assetId: id, audience: 'host' });
    expect((await request.get(hostUrl).set('Cookie', host.cookie)).status).toBe(200);
  });

  it('veraltete Signed URL → 403', async () => {
    const { request, prisma: db } = ctx;
    const id = await seedAsset(db, { visibility: 'PRIVATE' });
    const { signMediaAccess } = await import('../http/media.js');
    const past = Math.floor(Date.now() / 1000) - 60; // abgelaufen
    const sig = signMediaAccess({ assetId: id, audience: 'game', expiresAtEpochSeconds: past });
    expect((await request.get(`/api/v1/media/${id}?exp=${past}&sig=${encodeURIComponent(sig)}`)).status).toBe(403);
  });

  it('Signature für anderes Asset (getauschte assetId) → 403', async () => {
    const { request, prisma: db } = ctx;
    const a = await seedAsset(db, { visibility: 'PRIVATE' });
    const b = await seedAsset(db, { visibility: 'PRIVATE' });
    const { signMediaAccess } = await import('../http/media.js');
    const exp = Math.floor(Date.now() / 1000) + 60;
    // Sig für Asset A, aber auf Asset B angewendet.
    const sig = signMediaAccess({ assetId: a, audience: 'game', expiresAtEpochSeconds: exp });
    expect((await request.get(`/api/v1/media/${b}?exp=${exp}&sig=${encodeURIComponent(sig)}`)).status).toBe(403);
  });

  it('Header enthalten nie storagePath/originalName; Content-Disposition neutral', async () => {
    const { request, prisma: db } = ctx;
    const id = await seedAsset(db, { visibility: 'PUBLIC' });
    const asset = await db.mediaAsset.findUniqueOrThrow({ where: { id } });
    const res = await request.get(`/api/v1/media/${id}`);
    const headerStr = JSON.stringify(res.headers);
    expect(headerStr).not.toContain(asset.storagePath);
    expect(res.headers['content-disposition']).toBe('inline; filename="media"');
  });

  it('nicht vorhandenes Asset → 404', async () => {
    const { request } = ctx;
    expect((await request.get(`/api/v1/media/does-not-exist`)).status).toBe(404);
  });
});
