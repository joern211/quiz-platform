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
import path, { join } from 'node:path';
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
    // NUR Dateien zählen, die der Upload-Handler erzeugt (32-hex-Name).
    // Damit ist die Zählung immun gegen parallel laufende Composite-Tests,
    // die fusion-<round>-<digest>.webp in dasselbe Verzeichnis schreiben.
    return entries.filter(e => e !== '.gitkeep' && /^[a-f0-9]{32}\./.test(e)).length;
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

// Legt einen Raum mit gegebenem Setup-Snapshot an (C: game-Freigabe ist
// snapshot-basiert). Rückgabe: roomId.
async function seedRoomWithSnapshot(
  db: import('@prisma/client').PrismaClient,
  hostUserId: string,
  snapshot: object,
): Promise<string> {
  const geo = await getOrCreateGeoGame();
  const room = await db.room.create({
    data: {
      code: `c${Math.floor(Math.random() * 1e9).toString(36)}`,
      roomName: 'C-Test', hostUserId, gameDefinitionId: geo.id,
      status: 'LOBBY', setupSnapshotJson: JSON.stringify(snapshot),
      setupSchemaVersion: 1, runPhase: 'LOBBY', revision: 0,
    },
  });
  return room.id;
}

// Session-ID aus dem Test-Cookie lesen + Session gezielt widerrufen/verfallen
// lassen (C: Gültigkeitsprüfung). Cookie-Format: quiz_session=<id>.<sig>.
async function setSessionState(
  db: import('@prisma/client').PrismaClient,
  cookie: string,
  state: 'revoke' | 'expire' | 'valid',
) {
  const m = cookie.match(/quiz_session=([^.;]+)/);
  if (!m) throw new Error('Keine Session-ID im Cookie');
  const sessionId = m[1];
  await db.session.update({
    where: { id: sessionId },
    data: {
      ...(state === 'revoke' ? { revokedAt: new Date() } : {}),
      ...(state === 'expire' ? { expiresAt: new Date(Date.now() - 60_000) } : {}),
      ...(state === 'valid' ? { revokedAt: null, expiresAt: new Date(Date.now() + 60_000) } : {}),
    },
  });
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

  it('game-audience-Signed URL: freigegebenes Spielbild (in Snapshot referenziert) → 200 OHNE Session (Player/Viewer/Display)', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-gamereleased-${Date.now()}`, 'Rel', `rel-${Date.now()}@t.local`);
    const id = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: host.userId });
    // Der Raum referenziert das Asset als freigegebenes Spielbild (v2).
    await seedRoomWithSnapshot(db, host.userId, {
      setupVersion: 2,
      rounds: [{ id: 'r1', personAImageAssetId: 'aa', personBImageAssetId: 'bb', gameImageAssetId: id, personAName: 'A', personBName: 'B' }],
    });
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

// ============================================================
// PR11-Nacharbeit B — Upload-Dedupe, Eigentum und Cleanup
// ============================================================

describe('Media API — Nacharbeit B (Dedupe je Owner, Race, Reparatur, Cleanup)', () => {
  it('B-1: gleicher normalisierter Content bei ZWEI Hosts → 2×201, eigene Assets, kein 500, kein Ownership-Leak', async () => {
    const { request, prisma: db } = ctx;
    const hostA = await seedTestUserWithDb(db, `mod-bA-${Date.now()}`, 'HostA', `bA-${Date.now()}@t.local`);
    const hostB = await seedTestUserWithDb(db, `mod-bB-${Date.now()}`, 'HostB', `bB-${Date.now()}@t.local`);
    // Gleicher Roh-Inhalt → nach Normalisierung gleiche Bytes.
    const img = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 210, g: 40, b: 90 } } }).png().toBuffer();
    const filesBefore = await countUploadFiles(await uploadsDir());
    const r1 = await request.post('/api/v1/media').set('Cookie', hostA.cookie).attach('file', img, { filename: 'a.png', contentType: 'image/png' });
    expect(r1.status).toBe(201);
    const r2 = await request.post('/api/v1/media').set('Cookie', hostB.cookie).attach('file', img, { filename: 'a.png', contentType: 'image/png' });
    expect(r2.status).toBe(201); // EIGENES Asset — nicht das fremde, kein 500.
    expect(r2.body.data.id).not.toBe(r1.body.data.id);
    expect(r2.body.data.deduplicated).toBeUndefined();
    const a1 = await db.mediaAsset.findUniqueOrThrow({ where: { id: r1.body.data.id } });
    const a2 = await db.mediaAsset.findUniqueOrThrow({ where: { id: r2.body.data.id } });
    // Ownership: jeder ist der Owner SEINES Assets.
    expect(a1.uploadedBy).toBe(hostA.userId);
    expect(a2.uploadedBy).toBe(hostB.userId);
    // Gleicher normalisierter Content (sha256) — aber getrennte Zeilen/Dateien.
    expect(a2.sha256).toBe(a1.sha256);
    expect(a2.storagePath).not.toBe(a1.storagePath);
    // Beide Dateien nutzbar (deklarierter Pfad existiert + lesbar).
    for (const a of [a1, a2]) {
      const bytes = await (await import('node:fs/promises')).readFile(a.storagePath);
      expect(bytes.length).toBeGreaterThan(0);
      const meta = await sharp(a.storagePath).metadata();
      expect(meta.width).toBeGreaterThan(0);
    }
    // EXAKT 2 DB-Zeilen für diesen Content, +2 Dateien im Upload-Verzeichnis
    // (keine Orphans).
    expect(await db.mediaAsset.count({ where: { sha256: a1.sha256 } })).toBe(2);
    expect(await countUploadFiles(await uploadsDir())).toBe(filesBefore + 2);
  });

  it('B-2: paralleler identischer Upload desselben Hosts → genau 1 Asset, beide Requests erfolgreich, keine Orphan-Datei', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-bC-${Date.now()}`, 'HostC', `bC-${Date.now()}@t.local`);
    const img = await sharp({ create: { width: 12, height: 20, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
    const before = await countUploadFiles(await uploadsDir());
    const dbBefore = await db.mediaAsset.count();
    const [r1, r2] = await Promise.all([
      request.post('/api/v1/media').set('Cookie', host.cookie).attach('file', img, { filename: 'p.png', contentType: 'image/png' }),
      request.post('/api/v1/media').set('Cookie', host.cookie).attach('file', img, { filename: 'p.png', contentType: 'image/png' }),
    ]);
    // Beide erfolgreich (201 + 200 — Reihenfolge egal), KEIN 500.
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 201]);
    const ids = [...new Set([r1.body.data.id, r2.body.data.id])];
    expect(ids).toHaveLength(1); // gleiche Asset-ID (Dedupe oder Race-Auflösung)
    const winner = await db.mediaAsset.findUniqueOrThrow({ where: { id: ids[0] } });
    expect(winner.uploadedBy).toBe(host.userId);
    // EXAKT 1 neue DB-Zeile und EXAKT 1 neue Datei (fremde/Orphan-Datei
    // wurde aufgeräumt; die referenzierte Datei bleibt nutzbar).
    expect(await db.mediaAsset.count()).toBe(dbBefore + 1);
    expect(await countUploadFiles(await uploadsDir())).toBe(before + 1);
    const bytes = await (await import('node:fs/promises')).readFile(winner.storagePath);
    expect(bytes.length).toBeGreaterThan(0);
    // Referenzierte Datei ist im Verzeichnis vorhanden:
    const files = (await readdir(await uploadsDir())).filter(f => f !== '.gitkeep');
    expect(files).toContain(path.basename(winner.storagePath));
  });

  it('B-3: Duplikat nach fehlender Datei/FAILED → kontrollierte Reparatur derselben Zeile (gleiche ID, READY, Datei nutzbar)', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-bD-${Date.now()}`, 'HostD', `bD-${Date.now()}@t.local`);
    const img = await sharp({ create: { width: 24, height: 10, channels: 3, background: { r: 90, g: 190, b: 60 } } }).png().toBuffer();
    const r1 = await request.post('/api/v1/media').set('Cookie', host.cookie).attach('file', img, { filename: 'd.png', contentType: 'image/png' });
    expect(r1.status).toBe(201);
    const first = await db.mediaAsset.findUniqueOrThrow({ where: { id: r1.body.data.id } });
    const dbBefore = await db.mediaAsset.count();
    // Simuliert: Datei verloren + Status FAILED.
    await (await import('node:fs/promises')).rm(first.storagePath);
    await db.mediaAsset.update({ where: { id: first.id }, data: { processStatus: 'FAILED' } });
    const r2 = await request.post('/api/v1/media').set('Cookie', host.cookie).attach('file', img, { filename: 'd.png', contentType: 'image/png' });
    expect(r2.status).toBe(200);
    expect(r2.body.data.deduplicated).toBe(true);
    // GLEICHE ID (stabile Referenzen), repariert:
    expect(r2.body.data.id).toBe(first.id);
    const repaired = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.id } });
    expect(repaired.processStatus).toBe('READY');
    expect(await db.mediaAsset.count()).toBe(dbBefore); // keine zweite Zeile
    // Datei wieder nutzbar (neuer storagePath, dekodierbar):
    const bytes = await (await import('node:fs/promises')).readFile(repaired.storagePath);
    expect(bytes.length).toBeGreaterThan(0);
    expect((await sharp(repaired.storagePath).metadata()).width).toBeGreaterThan(0);
  });

  it('B-4: DB-Fehler beim Insert → 500, aber ALLE eigenen Dateien werden aufgeräumt (keine Orphans)', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-bE-${Date.now()}`, 'HostE', `bE-${Date.now()}@t.local`);
    const img = await sharp({ create: { width: 18, height: 14, channels: 3, background: { r: 10, g: 200, b: 160 } } }).png().toBuffer();
    const before = await countUploadFiles(await uploadsDir());
    const dbBefore = await db.mediaAsset.count();
    // Insert kontrolliert zum Scheitern bringen (kein Unique-Konflikt).
    const originalCreate = db.mediaAsset.create.bind(db.mediaAsset);
    (db.mediaAsset as { create: unknown }).create = async () => {
      const e = new Error('Simulated DB outage') as Error & { code?: string };
      e.code = 'P1001';
      throw e;
    };
    let res;
    try {
      res = await request.post('/api/v1/media').set('Cookie', host.cookie).attach('file', img, { filename: 'e.png', contentType: 'image/png' });
    } finally {
      (db.mediaAsset as { create: unknown }).create = originalCreate;
    }
    expect(res!.status).toBe(500);
    // Keine DB-Zeile, KEINE hinterlassenen Dateien (Rohupload UND
    // normalisiertes Ergebnis wurden entfernt):
    expect(await db.mediaAsset.count()).toBe(dbBefore);
    expect(await countUploadFiles(await uploadsDir())).toBe(before);
  });
});

// ============================================================
// PR11-Nacharbeit C — Host-Routen + game-Audience nur für freigegebene
// Spielbilder (einheitliche serverseitige Policy)
// ============================================================

describe('Media API — Nacharbeit C (Host-Session-Gültigkeit, game nur für freigegebene Spielbilder)', () => {
  it('C-1: host-audience + gültige Session + uploader → 200; abgelaufene ODER widerrufene Session → 403', async () => {
    const { request, prisma: db } = ctx;
    const owner = await seedTestUserWithDb(db, `mod-cA-${Date.now()}`, 'CA', `cA-${Date.now()}@t.local`);
    const original = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: owner.userId });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    const hostUrl = buildSignedMediaUrl({ assetId: original, audience: 'host' });
    // Gültig: 200.
    expect((await request.get(hostUrl).set('Cookie', owner.cookie)).status).toBe(200);
    // Abgelaufene Session: 403.
    await setSessionState(db, owner.cookie, 'expire');
    expect((await request.get(hostUrl).set('Cookie', owner.cookie)).status).toBe(403);
    // Widerrufene Session: 403.
    await setSessionState(db, owner.cookie, 'valid');
    await setSessionState(db, owner.cookie, 'revoke');
    expect((await request.get(hostUrl).set('Cookie', owner.cookie)).status).toBe(403);
  });

  it('C-2: host-audience + gültige Session ohne Host-Recht (fremder Host) → 403; mit Raum-Host-Recht → 200', async () => {
    const { request, prisma: db } = ctx;
    const owner = await seedTestUserWithDb(db, `mod-cB-${Date.now()}`, 'CB', `cB-${Date.now()}@t.local`);
    const stranger = await seedTestUserWithDb(db, `mod-cB2-${Date.now()}`, 'CB2', `cB2-${Date.now()}@t.local`);
    const original = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: owner.userId });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    const hostUrl = buildSignedMediaUrl({ assetId: original, audience: 'host' });
    // Fremder Host mit eigener gültiger Session + host-Sig: 403 (kein Recht).
    expect((await request.get(hostUrl).set('Cookie', stranger.cookie)).status).toBe(403);
    // Gleiche Session, aber jetzt ist der Fremde RAUM-HOST des Assets: 200.
    const roomId = await seedRoomWithSnapshot(db, stranger.userId, { rounds: [] });
    await db.mediaAsset.update({ where: { id: original }, data: { roomId } });
    expect((await request.get(hostUrl).set('Cookie', stranger.cookie)).status).toBe(200);
  });

  it('C-3: game-audience auf ein ORIGINAL (kein Spielbild in Snapshot) → 403, auch mit gültiger Signatur', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-cC-${Date.now()}`, 'CC', `cC-${Date.now()}@t.local`);
    const originalA = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: host.userId });
    const originalB = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: host.userId });
    const gameImage = await seedAsset(db, { visibility: 'ROOM_TEMP', uploadedBy: host.userId, roomId: 'r-x' });
    // Der Raum referenziert die Originale als personA/B UND das Spielbild als
    // gameImageAssetId. game-Sig auf ein ORIGINAL muss abgelehnt werden.
    await seedRoomWithSnapshot(db, host.userId, {
      setupVersion: 2,
      rounds: [{ id: 'r1', personAImageAssetId: originalA, personBImageAssetId: originalB, gameImageAssetId: gameImage, personAName: 'A', personBName: 'B' }],
    });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    // Game-Sig auf Original A: 403 (wird NICHT als Spielbild referenziert).
    expect((await request.get(buildSignedMediaUrl({ assetId: originalA, audience: 'game' }))).status).toBe(403);
    // Game-Sig auf Original B: 403.
    expect((await request.get(buildSignedMediaUrl({ assetId: originalB, audience: 'game' }))).status).toBe(403);
    // Game-Sig auf das SPIELBILD: 200 (ist referenziert).
    expect((await request.get(buildSignedMediaUrl({ assetId: gameImage, audience: 'game' }))).status).toBe(200);
  });

  it('C-4: game-audience auf ein BILD EINES ANDEREN RAUMS (falsche Runde) → 403', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-cD-${Date.now()}`, 'CD', `cD-${Date.now()}@t.local`);
    const gameImageR1 = await seedAsset(db, { visibility: 'ROOM_TEMP', uploadedBy: host.userId });
    const gameImageR2 = await seedAsset(db, { visibility: 'ROOM_TEMP', uploadedBy: host.userId });
    // Zwei Räumte/Runden: R1 referenziert Spielbild-R1, R2 referenziert
    // Spielbild-R2. Eine game-Sig für R2 taugt nicht für R1 (und umgekehrt
    // ist R2 nicht „freigegeben", wenn nur R1 existiert).
    await seedRoomWithSnapshot(db, host.userId, {
      setupVersion: 2,
      rounds: [
        { id: 'r1', personAImageAssetId: 'a1', personBImageAssetId: 'b1', gameImageAssetId: gameImageR1, personAName: 'A', personBName: 'B' },
      ],
    });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    // R1-Spielbild: 200.
    expect((await request.get(buildSignedMediaUrl({ assetId: gameImageR1, audience: 'game' }))).status).toBe(200);
    // R2-Spielbild (in KEINEM Snapshot referenziert): 403.
    expect((await request.get(buildSignedMediaUrl({ assetId: gameImageR2, audience: 'game' }))).status).toBe(403);
  });

  it('C-5: GET /api/v1/media/host/:id existiert NICHT mehr (→ 404)', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-cE-${Date.now()}`, 'CE', `cE-${Date.now()}@t.local`);
    const original = await seedAsset(db, { visibility: 'PRIVATE', uploadedBy: host.userId });
    // Die alte /host/:id-Route (nur Session+Recht, KEINE Signatur, KEINE
    // Gültigkeitsprüfung) ist entfernt: der Pfad wird als unbekannte
    // Asset-ID "host" geparst → 404.
    const res = await request.get(`/api/v1/media/host/${original}`);
    expect(res.status).toBe(404);
  });

  it('C-6: game-Freigabe bleibt nach „game:end" (Snapshot-basiert, ENDED-Raum) → 200, nicht-öffentliche Freigabe', async () => {
    const { request, prisma: db } = ctx;
    const host = await seedTestUserWithDb(db, `mod-cF-${Date.now()}`, 'CF', `cF-${Date.now()}@t.local`);
    const gameImage = await seedAsset(db, { visibility: 'ROOM_TEMP', uploadedBy: host.userId });
    const roomId = await seedRoomWithSnapshot(db, host.userId, {
      setupVersion: 2,
      rounds: [{ id: 'r1', personAImageAssetId: 'a', personBImageAssetId: 'b', gameImageAssetId: gameImage, personAName: 'A', personBName: 'B' }],
    });
    // Raum auf ENDED (simuliert game:end ODER game:end ohne Reveal): die
    // game-Freigabe ist SNAPSHOT-basiert und ändert sich dadurch NICHT —
    // das freigegebene Spielbild bleibt ladbar (keine zusätzliche
    // „Geheimhaltung" nach Beendigung, aber auch keine FREIGABE von
    // Originalen/Namen — die sind nie in imageAssetId/gameImageAssetId).
    await db.room.update({ where: { id: roomId }, data: { status: 'ENDED', runPhase: 'RESULTS' } });
    const { buildSignedMediaUrl } = await import('../http/media.js');
    const res = await request.get(buildSignedMediaUrl({ assetId: gameImage, audience: 'game' }));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
