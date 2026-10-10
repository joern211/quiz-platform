// ============================================================
// PR11 Audit-Regressionen (Audit 11-01 … 11-07)
//
// Übernimmt die sieben Audit-Gegenproben (08.10.2026, isolierte
// Checkouts) als dauerhafte Regressionstests und ergänzt die
// Pflichttests des Wiederaufnahme-Auftrags:
//   11-01: roundId kann das Upload-Verzeichnis nicht verlassen,
//          ungültige Eingaben werden kontrolliert abgelehnt.
//   11-02: vertauschte/parallele Composites überschreiben keine
//          gespeicherten Bytes; Hash-Zuordnung bleibt intakt;
//          Integritäts-Reparatur bei Byte-Abweichung.
//   11-03: verschiedene Quellpaare mit identischen Bytes behalten
//          eigene Provenienz; gleiche Quellen sind idempotent.
//   11-04: PRIVATE-Upload erbt keine PUBLIC-Sichtbarkeit; die
//          öffentliche Variante bleibt erreichbar, die private ist
//          anonym nicht lesbar; Legacy-Assets ohne assetKey.
//   11-05: Setup-Vorschau lädt vor Raumerstellung (200), fremde
//          Session erhält keinen Zugriff.
//   11-06: gleiche/parallele Absicht → ein Raum; andere
//          Konfiguration → neuer Raum; JSON-Key-Reihenfolge ist
//          identitätsneutral; Token-Verhalten; verschiedene Hosts;
//          gültiges Moderator-Token in jeder Antwort.
//   11-07: fehlgeschlagene Reparatur/Insert hinterlässt keine neuen
//          unreferenzierten Dateien und löscht keine Gewinner-Datei.
//
// Nachbefunde (10.10., Wiederaufnahme-Auftrag):
//   A: Upload-Reparatur — DB-Update gelingt, Referenzabfrage für die alte
//      Datei schlägt fehl: neue Datei bleibt erhalten; Zeile zeigt nie
//      READY auf Unbekannt (kontrolliert FAILED); Heilung per Retry.
//   B: Composite — zwei Quellpaare mit identischen Bytes; Insert UND
//      Referenzabfrage des zweiten scheitern: Datei des ersten Assets
//      bleibt bytegleich erhalten; fehlgeschlagene Referenzabfrage wird
//      nie als „keine Referenzen“ behandelt (keine Löschung).
//   C: Raum-Idempotenz — gleiche/parallele Absicht (Token) → ein Raum;
//      andere Tokens mit identischer Konfiguration → eigene Räume;
//      tokenloses 60-s-Fenster: überalter Raum gleicher Konfiguration
//      wird nicht zurückgeliefert; Tokenloser-Vertrag ist KEINE
//      allgemeine Retry-Garantie (siehe rooms.ts + Handoff).
//
// Isolation: eigene Test-Datenbank (alle Migrations, inkl. der
// assetKey/idempotencyKey-Migration). Datei-Zählung läuft auf
// DELTAS, damit die gemeinsame Storage-Umgebung anderer
// Testdateien nicht stört.
// ============================================================

import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import supertest from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestDatabase, seedTestUserWithDb } from './test-helpers.js';
import { createGameImage } from './games/weristdas/composite.js';
import { config } from './config/index.js';

let db: PrismaClient;
let temp: string;
let owner: { userId: string; cookie: string };
let other: { userId: string; cookie: string };
let request: ReturnType<typeof supertest>;
const uploadsDir = () => path.resolve(config.storagePaths.uploads);

beforeAll(async () => {
  temp = await mkdtemp(path.join(tmpdir(), 'pr11-audit-'));
  const url = `file:${path.join(temp, 'audit.db')}`;
  await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: url });
  await db.$connect();
  globalThis.__prisma = db;
  owner = await seedTestUserWithDb(db, 'audit-host', 'Audit', 'audit@test.local');
  other = await seedTestUserWithDb(db, 'audit-host-2', 'Audit 2', 'audit2@test.local');
  await mkdir(uploadsDir(), { recursive: true });
  const { createApp } = await import('./app.js');
  request = supertest(createApp().app);
});

afterAll(async () => {
  await db?.$disconnect();
  await rm(temp, { recursive: true, force: true });
});

// ------------------------------------------------------------
// Helfer
// ------------------------------------------------------------

async function fileCount(dir: string): Promise<number> {
  try { return (await readdir(dir)).length; } catch { return 0; }
}

async function source(size: number, color: string, ownerId?: string) {
  const buf = await sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
  const filename = `${crypto.randomUUID()}.png`;
  const storagePath = path.join(temp, filename);
  await writeFile(storagePath, buf);
  return db.mediaAsset.create({
    data: {
      type: 'image', mimeType: 'image/png', filename, originalName: 'source.png',
      fileSize: buf.length, width: size, height: size,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      storagePath, uploadedBy: ownerId ?? owner.userId,
      visibility: 'PRIVATE', processStatus: 'READY', processed: true,
    },
  });
}

/** Deterministisches, musterhaftes 1024²-Bild (WebP verschleiert nicht). */
async function patternedSource(seed: number) {
  const raw = Buffer.alloc(1024 * 1024 * 3);
  let n = seed;
  for (let i = 0; i < raw.length; i++) {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    raw[i] = n >>> 24;
  }
  const buf = await sharp(raw, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  const filename = `${crypto.randomUUID()}.png`;
  const storagePath = path.join(temp, filename);
  await writeFile(storagePath, buf);
  return db.mediaAsset.create({
    data: {
      type: 'image', mimeType: 'image/png', filename, originalName: 'source.png',
      fileSize: buf.length, width: 1024, height: 1024,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      storagePath, uploadedBy: owner.userId, visibility: 'PRIVATE', processStatus: 'READY', processed: true,
    },
  });
}

function widSetupBody(rounds: Array<{ a: string; b: string; game: string; roundId?: string }>) {
  return {
    gameSlug: 'wer-ist-das',
    roomName: 'Retry audit',
    setupSnapshotJson: {
      setupSchemaVersion: 2,
      rounds: rounds.map((r, i) => ({
        id: r.roundId ?? crypto.randomUUID(),
        personAImageAssetId: r.a,
        personBImageAssetId: r.b,
        gameImageAssetId: r.game,
        personAName: `A${i}`,
        personBName: `B${i}`,
        setupVersion: 2,
      })),
    },
  };
}

async function ensureWidGame() {
  await db.gameDefinition.upsert({
    where: { slug: 'wer-ist-das' },
    create: { id: 'audit-wid', slug: 'wer-ist-das', name: 'Wer ist das?', category: 'BUZZER', status: 'BETA', minPlayers: 2, maxPlayers: 10 },
    update: {},
  });
}

// ------------------------------------------------------------
// 11-05 — Setup-Vorschau lädt vor Raumerstellung
// ------------------------------------------------------------

it('11-05: host-Vorschau lädt VOR Raumerstellung (200), fremde/anonyme Session abgewiesen', async () => {
  const a = await source(70, '#ee0000');
  const b = await source(80, '#0000ee');
  const response = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  expect(response.status).toBe(201);
  const url: string = response.body.data.gameImageUrl;
  expect(url).toContain('exp=');
  expect(url).toContain('sig=');
  // Eigene gültige Host-Session → Bild lädt.
  const preview = await request.get(url).set('Cookie', owner.cookie);
  expect(preview.status).toBe(200);
  expect(preview.headers['content-type']).toBe('image/webp');
  // Fremde, gültige Session (anderer Host) → 403.
  const foreign = await request.get(url).set('Cookie', other.cookie);
  expect(foreign.status).toBe(403);
  // Anonym → 403.
  const anon = await request.get(url);
  expect(anon.status).toBe(403);
});

// ------------------------------------------------------------
// 11-03 — Provenienz und logische Identität
// ------------------------------------------------------------

it('11-03: gleiche Quellen (gleiche IDs) sind idempotent → gleiche Asset-ID', async () => {
  const a = await source(101, '#dd0011');
  const b = await source(102, '#1100dd');
  const first = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId: crypto.randomUUID() });
  const second = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId: crypto.randomUUID() });
  expect(second.gameImageAssetId).toBe(first.gameImageAssetId);
});

it('11-03: verschiedene Quellpaare mit identischen Bytes behalten eigene Provenienz', async () => {
  const a = await source(101, '#dd0011');
  const b = await source(102, '#1100dd');
  const aa = await source(201, '#dd0011');
  const bb = await source(202, '#1100dd');
  const first = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId: crypto.randomUUID() });
  const second = await createGameImage({ personAImageAssetId: aa.id, personBImageAssetId: bb.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId: crypto.randomUUID() });
  expect(second.gameImageAssetId).not.toBe(first.gameImageAssetId);
  const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: second.gameImageAssetId } });
  expect(JSON.parse(row.derivedFromAssetIds!).sort()).toEqual([aa.id, bb.id].sort());
  const firstRow = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
  expect(JSON.parse(firstRow.derivedFromAssetIds!).sort()).toEqual([a.id, b.id].sort());
});

// ------------------------------------------------------------
// 11-02 — Unveränderliche Composite-Dateien
// ------------------------------------------------------------

it('11-02: vertauschte Quellen überschreiben kein gespeichertes Bild (Muster-Bytes)', async () => {
  const a = await patternedSource(101);
  const b = await patternedSource(102);
  const roundId = crypto.randomUUID();
  const first = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId });
  const before = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
  const bytes = await readFile(before.storagePath);
  const second = await createGameImage({ personAImageAssetId: b.id, personBImageAssetId: a.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId });
  const after = await db.mediaAsset.findUniqueOrThrow({ where: { id: second.gameImageAssetId } });
  // Unterschiedliche logische Identität → anderes Asset, eigener Pfad.
  expect(second.gameImageAssetId).not.toBe(first.gameImageAssetId);
  expect(after.storagePath).not.toBe(before.storagePath);
  // Beide Dateien behalten exakt ihre Bytes; beide Hash-Zuordnungen intakt.
  expect((await readFile(before.storagePath)).equals(bytes)).toBe(true);
  expect((await readFile(before.storagePath)).toString('hex')).not.toBe((await readFile(after.storagePath)).toString('hex'));
  for (const asset of [before, after]) {
    const fileHash = crypto.createHash('sha256').update(await readFile(asset.storagePath)).digest('hex');
    expect(fileHash).toBe(asset.sha256);
  }
});

it('11-02: Byte-Abweichung einer gespeicherten Datei wird kontrolliert repariert', async () => {
  const a = await patternedSource(201);
  const b = await patternedSource(202);
  const first = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId: crypto.randomUUID() });
  const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
  // Beschädigung: fremde Bytes über die Datei schreiben (Hash passt nicht).
  await writeFile(row.storagePath, Buffer.from('corrupted-bytes-not-a-webp'));
  const second = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId: crypto.randomUUID() });
  expect(second.gameImageAssetId).toBe(first.gameImageAssetId);
  // Datei wieder bytegleich zum gespeicherten Hash (deterministisch).
  const repaired = await readFile(row.storagePath);
  expect(crypto.createHash('sha256').update(repaired).digest('hex')).toBe(row.sha256);
});

// ------------------------------------------------------------
// 11-04 — Private Uploads bleiben privat
// ------------------------------------------------------------

it('11-04: frischer PRIVATE-Upload erbt keine PUBLIC-Sichtbarkeit', async () => {
  const buf = await sharp({ create: { width: 11, height: 12, channels: 3, background: '#0099dd' } }).png().toBuffer();
  const first = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'first.png');
  expect(first.status).toBe(201);
  await db.mediaAsset.update({ where: { id: first.body.data.id }, data: { visibility: 'PUBLIC' } });
  const next = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'private-round.png');
  expect(next.status).toBe(200);
  expect(next.body.data.id).not.toBe(first.body.data.id);
  const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: next.body.data.id } });
  expect(row.visibility).toBe('PRIVATE');
  // Die bereits öffentliche Variante bleibt offen erreichbar.
  const publicUrl = await request.get(`/api/v1/media/${first.body.data.id}`);
  expect(publicUrl.status).toBe(200);
  // Die private Variante ist anonym NICHT lesbar.
  const privateAnon = await request.get(`/api/v1/media/${next.body.data.id}`);
  expect(privateAnon.status).toBe(403);
  // Die private Variante MIT gültiger Host-Session + host-Signatur ist lesbar.
  const { buildSignedMediaUrl } = await import('./media/signedUrl.js');
  const hostUrl = buildSignedMediaUrl({ assetId: next.body.data.id, audience: 'host' });
  const privateHost = await request.get(hostUrl).set('Cookie', owner.cookie);
  expect(privateHost.status).toBe(200);
});

it('11-04: Legacy-Upload ohne assetKey (NULL) bleibt dedupe-frei und lesbar', async () => {
  // Simuliert ein Legacy-Asset aus der Zeit vor der assetKey-Spalte:
  // assetKey NULL → Unique-Index lässt es durch (SQLite: NULL distinct).
  const buf = await sharp({ create: { width: 15, height: 16, channels: 3, background: '#336699' } }).png().toBuffer();
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const legacy = await db.mediaAsset.create({
    data: {
      type: 'image', mimeType: 'image/png', filename: `${crypto.randomUUID()}.png`, originalName: 'legacy.png',
      fileSize: buf.length, width: 15, height: 16, sha256: sha,
      storagePath: path.join(temp, `${crypto.randomUUID()}.png`),
      uploadedBy: owner.userId, visibility: 'PRIVATE', processStatus: 'READY', processed: true,
      assetKey: null,
    },
  });
  await writeFile(legacy.storagePath, buf);
  // Neuer Upload desselben Contents: erzeugt EIGENE Zeile (keine Kollision
  // mit dem Legacy-Asset), Legacy-Zeile bleibt unverändert.
  const fresh = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'fresh.png');
  expect(fresh.status).toBe(201);
  expect(fresh.body.data.id).not.toBe(legacy.id);
  const legacyAfter = await db.mediaAsset.findUniqueOrThrow({ where: { id: legacy.id } });
  expect(legacyAfter.assetKey).toBeNull();
  expect(legacyAfter.visibility).toBe('PRIVATE');
  // Legacy-Asset bleibt lesbar (eigene Session + host-Signatur).
  const { buildSignedMediaUrl } = await import('./media/signedUrl.js');
  const legacyUrl = buildSignedMediaUrl({ assetId: legacy.id, audience: 'host' });
  const legacyGet = await request.get(legacyUrl).set('Cookie', owner.cookie);
  expect(legacyGet.status).toBe(200);
});

// ------------------------------------------------------------
// 11-07 — Reparatur-Cleanup
// ------------------------------------------------------------

it('11-07: fehlgeschlagene Reparatur hinterlässt keine neue Datei', async () => {
  const buf = await sharp({ create: { width: 13, height: 14, channels: 3, background: '#0099cc' } }).png().toBuffer();
  const first = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'first.png');
  expect(first.status).toBe(201);
  const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.body.data.id } });
  await rm(row.storagePath, { force: true });
  await db.mediaAsset.update({ where: { id: row.id }, data: { processStatus: 'FAILED' } });
  const before = await fileCount(uploadsDir());
  const mediaDelegate = db.mediaAsset as unknown as Record<string, unknown>;
  const realUpdate = (mediaDelegate.update as (...a: unknown[]) => Promise<unknown>).bind(db.mediaAsset);
  mediaDelegate.update = async () => { throw new Error('audit DB write failure'); };
  try {
    const next = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'retry.png');
    expect(next.status).toBe(500);
    expect(await fileCount(uploadsDir())).toBe(before); // keine Orphan-Datei
    // Die Asset-Zeile ist UNBERÜHRT geblieben (keine halbe Reparatur).
    const after = await db.mediaAsset.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.processStatus).toBe('FAILED');
  } finally {
    (db.mediaAsset as unknown as Record<string, unknown>).update = realUpdate;
  }
});

it('11-07: paralleler identischer Upload löst auf Gewinner auf, ohne dessen Datei zu löschen', async () => {
  const buf = await sharp({ create: { width: 17, height: 18, channels: 3, background: '#669933' } }).png().toBuffer();
  const first = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'winner.png');
  expect(first.status).toBe(201);
  const winner = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.body.data.id } });
  const before = await fileCount(uploadsDir());
  const winnerBytes = await readFile(winner.storagePath);
  // Zweiter Upload desselben Contents: dedupliziert (200) auf die
  // bestehende Zeile; die Gewinner-Datei bleibt bytegleich erhalten.
  const second = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'dup.png');
  expect(second.status).toBe(200);
  expect(second.body.data.id).toBe(first.body.data.id);
  expect(await fileCount(uploadsDir())).toBe(before);
  expect((await readFile(winner.storagePath)).equals(winnerBytes)).toBe(true);
});

// ------------------------------------------------------------
// 11-01 — Sichere Pfade
// ------------------------------------------------------------

it('11-01: roundId mit Traversal-Separatoren kann das Upload-Verzeichnis nicht verlassen', async () => {
  const a = await source(113, '#012345');
  const b = await source(114, '#543210');
  const response = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: 'x/../../escaped' });
  expect(response.status).toBe(201);
  const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: response.body.data.gameImageAssetId } });
  const relative = path.relative(uploadsDir(), row.storagePath);
  expect(relative.startsWith('..')).toBe(false);
  expect(path.isAbsolute(relative)).toBe(false);
  // Keine Datei außerhalb des Upload-Verzeichnisses entstanden.
  const outside = path.resolve(uploadsDir(), '..', 'escaped.webp');
  expect(existsSync(outside)).toBe(false);
});

it('11-01: ungültige roundId (zu lang / leer) wird kontrolliert abgelehnt (400)', async () => {
  const a = await source(120, '#012345');
  const b = await source(121, '#543210');
  const tooLong = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: 'x'.repeat(200) });
  expect(tooLong.status).toBe(400);
  const empty = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: '' });
  expect(empty.status).toBe(400);
});

// ------------------------------------------------------------
// 11-06 — Raum-Erstellung bei Wiederholungen
// ------------------------------------------------------------

it('11-06: identische Wiederholung desselben Requests → genau ein Raum (Fingerprint-Fallback)', async () => {
  await ensureWidGame();
  const testName = `Retry audit A${Date.now()}`;
  const a = await source(123, '#012355');
  const b = await source(124, '#543310');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  expect(composite.status).toBe(201);
  const body = widSetupBody([{ a: a.id, b: b.id, game: composite.body.data.gameImageAssetId }]);
  body.roomName = testName;
  const first = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(body);
  const second = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(body);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(second.body.data.roomId).toBe(first.body.data.roomId);
  expect(second.body.data.idempotentReplay).toBe(true);
  // Beide Antworten tragen ein gültiges Moderator-Token (nie null).
  expect(first.body.data.moderatorToken).toBeTruthy();
  expect(second.body.data.moderatorToken).toBe(first.body.data.moderatorToken);
  // In der DB existiert genau EIN Raum mit diesem Namen des Hosts.
  const roomCount = await db.room.count({ where: { roomName: testName, hostUserId: owner.userId } });
  expect(roomCount).toBe(1);
});

it('11-06: parallele identische Requests → genau ein Raum, konsistente Identität', async () => {
  await ensureWidGame();
  const a = await source(125, '#112233');
  const b = await source(126, '#332211');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  const body = widSetupBody([{ a: a.id, b: b.id, game: composite.body.data.gameImageAssetId }]);
  body.roomName = `Retry audit B${Date.now()}`;
  const [r1, r2] = await Promise.all([
    request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(body),
    request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(body),
  ]);
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
  expect(r1.body.data.roomId).toBe(r2.body.data.roomId);
  const roomCount = await db.room.count({ where: { roomName: body.roomName, hostUserId: owner.userId } });
  expect(roomCount).toBe(1);
  expect(r1.body.data.moderatorToken).toBeTruthy();
});

it('11-06: anderer Name/Spiel/Setup/Sicherheitskonfiguration → bewusst neuer Raum', async () => {
  await ensureWidGame();
  const a = await source(127, '#445566');
  const b = await source(128, '#665544');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  const base = { a: a.id, b: b.id, game: composite.body.data.gameImageAssetId };
  const roomCountBefore = await db.room.count({ where: { hostUserId: owner.userId } });
  const r1 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(widSetupBody([base]));
  const r2 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send({ ...widSetupBody([base]), roomName: 'Retry audit 2' });
  const r3 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie)
    .send({ ...widSetupBody([base]), viewerRequiresPin: true, isPublic: false });
  const r4 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie)
    .send({ ...widSetupBody([base]), maxPlayers: 4 });
  for (const r of [r1, r2, r3, r4]) expect(r.status).toBe(201);
  const ids = [r1, r2, r3, r4].map(r => r.body.data.roomId);
  expect(new Set(ids).size).toBe(4); // vier bewusste Räume
  expect(await db.room.count({ where: { hostUserId: owner.userId } })).toBe(roomCountBefore + 4);
});

it('11-06: JSON-Schlüsselreihenfolge erzeugt keine zweite Identität', async () => {
  await ensureWidGame();
  const a = await source(129, '#778899');
  const b = await source(130, '#998877');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  const round = {
    id: crypto.randomUUID(), personAImageAssetId: a.id, personBImageAssetId: b.id,
    gameImageAssetId: composite.body.data.gameImageAssetId,
    personAName: 'A', personBName: 'B', setupVersion: 2,
  };
  // Selbes Setup, anderes Key-Ordering (Setup erst, dann Name).
  const bodyKeyOrder1 = {
    gameSlug: 'wer-ist-das', roomName: 'KeyOrder audit',
    setupSnapshotJson: { setupSchemaVersion: 2, rounds: [round] },
  };
  const reordered = { rounds: [round], setupSchemaVersion: 2 };
  const bodyKeyOrder2 = {
    setupSnapshotJson: reordered, roomName: 'KeyOrder audit', gameSlug: 'wer-ist-das',
  };
  const r1 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(bodyKeyOrder1);
  const r2 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(bodyKeyOrder2);
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
  expect(r2.body.data.roomId).toBe(r1.body.data.roomId);
});

it('11-06: explizites Idempotency-Token — Retry liefert denselben Raum, neues Token einen neuen', async () => {
  await ensureWidGame();
  const a = await source(131, '#aabbbb');
  const b = await source(132, '#bbbaaa');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  const token = crypto.randomUUID();
  const body = widSetupBody([{ a: a.id, b: b.id, game: composite.body.data.gameImageAssetId }]);
  const r1 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send({ ...body, idempotencyKey: token });
  const r2 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send({ ...body, idempotencyKey: token });
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
  expect(r2.body.data.roomId).toBe(r1.body.data.roomId);
  expect(r2.body.data.idempotentReplay).toBe(true);
  // Neues Token → neue Absicht → neuer Raum.
  const r3 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send({ ...body, idempotencyKey: crypto.randomUUID() });
  expect(r3.status).toBe(201);
  expect(r3.body.data.roomId).not.toBe(r1.body.data.roomId);
});

it('11-06: anderer Host mit identischer Konfiguration erhält einen eigenen Raum', async () => {
  await ensureWidGame();
  const name = `Host audit ${Date.now()}`;
  // Referenzraum vom ERSTEN Host (eigene Originale).
  const a1 = await source(133, '#cccddd', owner.userId);
  const b1 = await source(134, '#dddccc', owner.userId);
  const c1 = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a1.id, personBImageAssetId: b1.id, roundId: crypto.randomUUID() });
  const body1 = widSetupBody([{ a: a1.id, b: b1.id, game: c1.body.data.gameImageAssetId }]);
  body1.roomName = name;
  const rOwner = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(body1);
  expect(rOwner.status).toBe(201);
  // ZWEITER Host: eigene Originale, identische Konfiguration (gleicher Name).
  const a2 = await source(135, '#cccddd', other.userId);
  const b2 = await source(136, '#dddccc', other.userId);
  const c2 = await request.post('/api/v1/media/composite')
    .set('Cookie', other.cookie)
    .send({ personAImageAssetId: a2.id, personBImageAssetId: b2.id, roundId: crypto.randomUUID() });
  const body2 = widSetupBody([{ a: a2.id, b: b2.id, game: c2.body.data.gameImageAssetId }]);
  body2.roomName = name;
  const rOther = await request.post('/api/v1/rooms').set('Cookie', other.cookie).send(body2);
  expect(rOther.status).toBe(201);
  // Getrennte Räume: der Fingerprint ist host-bound (hostUserId im Unique-Key).
  expect(rOther.body.data.roomId).not.toBe(rOwner.body.data.roomId);
  expect(rOther.body.data.idempotentReplay).not.toBe(true);
  expect(await db.room.count({ where: { roomName: name, hostUserId: other.userId } })).toBe(1);
});

it('11-06: Raum + Moderator-Teilnahme entstehen atomar (kein null-Token, keine Waise)', async () => {
  await ensureWidGame();
  const a = await source(135, '#eeefff');
  const b = await source(136, '#fffeee');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  const body = widSetupBody([{ a: a.id, b: b.id, game: composite.body.data.gameImageAssetId }]);
  body.roomName = `Atomic audit ${Date.now()}`;
  const r = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(body);
  expect(r.status).toBe(201);
  const roomId = r.body.data.roomId;
  const mod = await db.participation.findFirst({ where: { roomId, role: 'MODERATOR' } });
  expect(mod).not.toBeNull();
  expect(mod!.rejoinToken).toBe(r.body.data.moderatorToken);
  expect(mod!.rejoinToken).toBeTruthy();
});

// ------------------------------------------------------------
// Nachbefund C (10.10.) — Raum-Idempotenz: Tokens vs. Absichten,
// 60-s-Fenster, tokenloser Vertrag
// ------------------------------------------------------------

it('C: parallele Requests mit GLEICHDEM expliziten Token → genau ein Raum, gleiche Identität', async () => {
  await ensureWidGame();
  const a = await source(141, '#110011');
  const b = await source(142, '#001111');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  const body = widSetupBody([{ a: a.id, b: b.id, game: composite.body.data.gameImageAssetId }]);
  body.roomName = `Parallel-Token ${Date.now()}`;
  const token = crypto.randomUUID();
  const [r1, r2] = await Promise.all([
    request.post('/api/v1/rooms').set('Cookie', owner.cookie).send({ ...body, idempotencyKey: token }),
    request.post('/api/v1/rooms').set('Cookie', owner.cookie).send({ ...body, idempotencyKey: token }),
  ]);
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
  expect(r1.body.data.roomId).toBe(r2.body.data.roomId);
  expect(r1.body.data.moderatorToken).toBeTruthy();
  expect(r2.body.data.moderatorToken).toBeTruthy();
  expect(r1.body.data.moderatorToken).toBe(r2.body.data.moderatorToken);
  expect(await db.room.count({ where: { roomName: body.roomName, hostUserId: owner.userId } })).toBe(1);
});

it('C: unterschiedliche Absichten (andere Tokens) mit IDENTISCHER Konfiguration → unterschiedliche Räume', async () => {
  await ensureWidGame();
  const a = await source(143, '#220022');
  const b = await source(144, '#002222');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  const body = widSetupBody([{ a: a.id, b: b.id, game: composite.body.data.gameImageAssetId }]);
  body.roomName = `Intent ${Date.now()}`;
  const r1 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie)
    .send({ ...body, idempotencyKey: crypto.randomUUID() });
  const r2 = await request.post('/api/v1/rooms').set('Cookie', owner.cookie)
    .send({ ...body, idempotencyKey: crypto.randomUUID() });
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
  // Verschiedene Erstellungsabsichten (jeder Klick ein eigenes Token):
  // zwei eigenständige Räume, kein Replay.
  expect(r2.body.data.roomId).not.toBe(r1.body.data.roomId);
  expect(r2.body.data.idempotentReplay).not.toBe(true);
  expect(await db.room.count({ where: { roomName: body.roomName, hostUserId: owner.userId } })).toBe(2);
});

it('C: tokenloses Fenster — ein 60 s alter Raum gleicher Konfiguration wird NICHT zurückgeliefert', async () => {
  await ensureWidGame();
  const a = await source(145, '#330033');
  const b = await source(146, '#003333');
  const composite = await request.post('/api/v1/media/composite')
    .set('Cookie', owner.cookie)
    .send({ personAImageAssetId: a.id, personBImageAssetId: b.id, roundId: crypto.randomUUID() });
  const body = widSetupBody([{ a: a.id, b: b.id, game: composite.body.data.gameImageAssetId }]);
  const name = `Window ${Date.now()}`;
  body.roomName = name;
  // Raum aus dem VORHERIGEN 60-s-Fenster direkt in der DB anlegen
  // (simuliert: Erstellungsversuch vor über 60 Sekunden).
  const epochPrev = Math.floor(Date.now() / 60000) - 1;
  const gameDef = await db.gameDefinition.findUniqueOrThrow({ where: { slug: 'wer-ist-das' } });
  const staleRoom = await db.room.create({
    data: {
      code: 'WIN-OLD', roomName: name, gameDefinitionId: gameDef.id, hostUserId: owner.userId,
      setupSnapshotJson: JSON.stringify(body.setupSnapshotJson), isPublic: true,
      idempotencyKey: `fp:${epochPrev}:${'0'.repeat(64)}`, status: 'LOBBY', runPhase: 'OPEN',
    },
  });
  // Identische Konfiguration, OHNES Token, AKTUELLES Fenster → neuer Raum,
  // der stale-Win-Raum bleibt unverändert und wird NICHT wiederverwendet
  // (Fenster-Grenze: Retry-Schutz ist bewusst auf 60 s begrenzt).
  const r = await request.post('/api/v1/rooms').set('Cookie', owner.cookie).send(body);
  expect(r.status).toBe(201);
  expect(r.body.data.roomId).not.toBe(staleRoom.id);
  expect(r.body.data.idempotentReplay).not.toBe(true);
  const stale = await db.room.findUniqueOrThrow({ where: { id: staleRoom.id } });
  expect(stale.idempotencyKey).toBe(`fp:${epochPrev}:${'0'.repeat(64)}`);
});

// ------------------------------------------------------------
// Nachbefund A (10.10.) — Upload-Reparatur: DB-Update gelingt,
// anschließend scheitert die Referenzabfrage (Bereinigung alte Datei)
// ------------------------------------------------------------

it('A: Reparatur — Update OK, Referenzabfrage schlägt fehl: neue Datei bleibt, Zeile zeigt nie READY auf Unbekannt', async () => {
  const buf = await sharp({ create: { width: 21, height: 22, channels: 3, background: '#0099dd' } }).png().toBuffer();
  const first = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'a-first.png');
  expect(first.status).toBe(201);
  const row = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.body.data.id } });
  // Ausgangszustand: Datei verloren + Zeile FAILED (Reparatur-Anlass).
  await rm(row.storagePath, { force: true });
  await db.mediaAsset.update({ where: { id: row.id }, data: { processStatus: 'FAILED' } });
  const before = await fileCount(uploadsDir());
  // NUR die Referenzabfrage (mediaAsset.count) injizieren → das Update
  // gelingt, die Abfrage zur Bereinigung der alten Datei schlägt fehl.
  const mediaDelegate = db.mediaAsset as unknown as Record<string, unknown>;
  const realCount = (mediaDelegate.count as (...a: unknown[]) => Promise<unknown>).bind(db.mediaAsset);
  mediaDelegate.count = async () => { throw new Error('audit reference check failure'); };
  try {
    const next = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'a-retry.png');
    expect(next.status).toBe(500);
    expect(next.body.error?.code).toBe('MEDIA_ASSET_REPAIR_DEGRADED');
    // Die NEUE Datei ist gespeichert und von der Zeile referenziert
    // (keine READY-auf-fehlende-Datei, keine READY-auf-Unbekannt):
    const after = await db.mediaAsset.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.processStatus).toBe('FAILED'); // kontrolliert entzogen
    const fs = await import('node:fs/promises');
    expect(await fs.stat(after.storagePath)).toBeTruthy(); // Datei existiert
    // Keine Orphan über die referenzierte neue Datei hinaus:
    expect(await fileCount(uploadsDir())).toBe(before + 1);
  } finally {
    (db.mediaAsset as unknown as Record<string, unknown>).count = realCount;
  }
  // Heilung: nächster Upload derselben Bytes repariert die Zeile auf READY
  // (Reparatur ist idempotent: deterministische Bytes → kontrollierte
  // In-Place-Reparatur derselben Zeile, alte referenzfreie Datei wird
  // bereinigt, Zeile-ID bleibt stabil).
  const healed = await request.post('/api/v1/media').set('Cookie', owner.cookie).attach('file', buf, 'a-heal.png');
  expect(healed.status).toBe(200);
  expect(healed.body.data.id).toBe(row.id);
  const healedRow = await db.mediaAsset.findUniqueOrThrow({ where: { id: row.id } });
  expect(healedRow.processStatus).toBe('READY');
  const fs2 = await import('node:fs/promises');
  expect(await fs2.stat(healedRow.storagePath)).toBeTruthy();
});

// ------------------------------------------------------------
// Nachbefund B (10.10.) — Composite: zwei Quellpaare mit identischen
// Bytes; Insert UND Referenzabfrage des zweiten scheitern
// ------------------------------------------------------------

it('B: Composite mit identischen Bytes — fehlgeschlagene Referenzabfrage löscht nie die Datei des ersten Assets', async () => {
  // Verschiedene Quellpaare, identische Ausgabe-Bytes (gleiche Farben,
  // andere Abmessungen → nach Normalisierung bytegleiches Composite).
  const a = await source(101, '#dd0011');
  const b = await source(102, '#1100dd');
  const aa = await source(201, '#dd0011');
  const bb = await source(202, '#1100dd');
  const first = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId: crypto.randomUUID() });
  const firstRow = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
  const fs = await import('node:fs/promises');
  const firstBytes = await fs.readFile(firstRow.storagePath);
  expect(crypto.createHash('sha256').update(firstBytes).digest('hex')).toBe(firstRow.sha256);
  const before = await fileCount(uploadsDir());
  // Zweites Composite: Insert UND Referenzabfrage injiziert fehlgeschlagen.
  const mediaDelegate = db.mediaAsset as unknown as Record<string, unknown>;
  const realCreate = (mediaDelegate.create as (...a: unknown[]) => Promise<unknown>).bind(db.mediaAsset);
  const realCount = (mediaDelegate.count as (...a: unknown[]) => Promise<unknown>).bind(db.mediaAsset);
  mediaDelegate.create = async () => { throw new Error('audit DB write failure'); };
  mediaDelegate.count = async () => { throw new Error('audit reference check failure'); };
  let thrown: unknown = null;
  try {
    await createGameImage({ personAImageAssetId: aa.id, personBImageAssetId: bb.id, hostUserId: owner.userId, roomId: 'tmp-audit-host', roundId: crypto.randomUUID() });
  } catch (e) {
    thrown = e;
  }
  finally {
    (db.mediaAsset as unknown as Record<string, unknown>).create = realCreate;
    (db.mediaAsset as unknown as Record<string, unknown>).count = realCount;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe('COMPOSITE_FAILED');
  // Die DATEI des ersten Assets bleibt bytegleich erhalten; Zeile READY:
  const firstRowAfter = await db.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
  expect(firstRowAfter.processStatus).toBe('READY');
  expect((await fs.readFile(firstRowAfter.storagePath)).equals(firstBytes)).toBe(true);
  // Keine neuen Dateien (tmp des zweiten Composite wurde bereinigt;
  // finale Datei des ersten Assets weder überschrieben noch gelöscht):
  expect(await fileCount(uploadsDir())).toBe(before);
});
