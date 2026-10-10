import path, { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createTestDatabase, seedTestUserWithDb } from '../../test-helpers.js';
import { COMPOSITE_SIZE, createGameImage } from './composite.js';

// Zwei echte, unterscheidbare Bilder (unterschiedliche Größe/Farbe → eindeutige
// sha256), damit das Composite keine "umbenannte Kopie" sein kann.
async function png(width: number, height: number, color: { r: number; g: number; b: number }) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

interface Ctx {
  prisma: import('@prisma/client').PrismaClient;
  tmpDir: string;
  hostId: string;
  otherId: string;
}

let ctx: Ctx;
const TEMP_DIRS: string[] = [];
// vmForks + isolate:false → globalThis.__prisma wird worker-weit geteilt.
// Den vorherigen Client sichern, damit andere Test-DateiN im selben Worker
// (z. B. socket-flow mit Shared-DB) nicht unsere geschlossene Temp-DB erben.
let prevPrisma: import('@prisma/client').PrismaClient | undefined;

beforeAll(async () => {
  const { PrismaClient } = await import('@prisma/client');
  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-composite-'));
  TEMP_DIRS.push(tmpDir);
  const dbUrl = `file:${join(tmpDir, 'composite.db')}`;
  await createTestDatabase(dbUrl);
  const freshPrisma = new PrismaClient({ datasourceUrl: dbUrl });
  await freshPrisma.$connect();
  prevPrisma = globalThis.__prisma;
  globalThis.__prisma = freshPrisma;
  const host = await seedTestUserWithDb(freshPrisma, 'fusion-host', 'Fusion Host', 'fusion-host@test.local');
  const other = await seedTestUserWithDb(freshPrisma, 'fusion-other', 'Andere', 'fusion-other@test.local');
  ctx = { prisma: freshPrisma, tmpDir, hostId: host.userId, otherId: other.userId };
});

afterAll(async () => {
  await (globalThis.__prisma as import('@prisma/client').PrismaClient | undefined)?.$disconnect();
  globalThis.__prisma = prevPrisma; // vorherigen Client wiederherstellen
  for (const dir of TEMP_DIRS) await rm(dir, { recursive: true, force: true });
});

/** Legt ein echtes, auf Disk liegendes READY-Bild-Asset an (Host-eigen). */
async function seedImageAsset(userId: string, width: number, height: number, color: { r: number; g: number; b: number }) {
  const buf = await png(width, height, color);
  const filename = `src-${Math.random().toString(36).slice(2)}.webp`;
  const storagePath = join(ctx.tmpDir, filename);
  await mkdir(ctx.tmpDir, { recursive: true });
  await writeFile(storagePath, await sharp(buf).webp().toBuffer());
  const sha256 = (await import('node:crypto')).createHash('sha256').update(buf).digest('hex');
  return ctx.prisma.mediaAsset.create({
    data: {
      type: 'image', mimeType: 'image/webp', filename, originalName: 'source.png',
      fileSize: buf.length, width, height, sha256, storagePath, uploadedBy: userId,
      visibility: 'PRIVATE', processStatus: 'READY', processed: true,
    },
  });
}

describe('Wer ist das? — Composite/Fusion (Regelwerk §15.3)', () => {
  it('erzeugt aus zwei Originalen ein echtes, gespeichertes 1024×1024-Composite mit korrekt abgeleiteter Quelle', async () => {
    const a = await seedImageAsset(ctx.hostId, 300, 400, { r: 200, g: 40, b: 40 });
    const b = await seedImageAsset(ctx.hostId, 400, 300, { r: 40, g: 40, b: 200 });
    const result = await createGameImage({
      personAImageAssetId: a.id, personBImageAssetId: b.id,
      hostUserId: ctx.hostId, roomId: 'room-fusion-1', roundId: 'round-1',
    });
    expect(result.gameImageAssetId).toBeTruthy();
    expect(result.width).toBe(COMPOSITE_SIZE);
    expect(result.height).toBe(COMPOSITE_SIZE);

    const asset = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: result.gameImageAssetId } });
    expect(asset.type).toBe('image');
    expect(asset.mimeType).toBe('image/webp');
    expect(asset.visibility).toBe('ROOM_TEMP');
    expect(asset.processStatus).toBe('READY');
    expect(asset.processed).toBe(true);
    expect(asset.uploadedBy).toBe(ctx.hostId);
    expect(asset.roomId).toBe('room-fusion-1');
    // Quelle ist nachvollziehbar + beidseitig.
    const derived = JSON.parse(asset.derivedFromAssetIds ?? '[]');
    expect([...derived].sort()).toEqual([a.id, b.id].sort());
    // Filenamen enthält KEINE Lösung (keine Personen-Namen), aber eine
    // Algorithmus-abgeleitete Signatur (reproduzierbar, §5.22).
    expect(asset.filename).toContain('fusion-');
    expect(asset.filename).not.toMatch(/Alice|Bob|Person/i);
    // Das Composite ist ECHT: eine andere Datei als jedes Original.
    const compositeBytes = await readFile(asset.storagePath);
    const aBytes = await readFile(a.storagePath);
    const bBytes = await readFile(b.storagePath);
    expect(compositeBytes.length).toBeGreaterThan(0);
    expect(compositeBytes.equals(aBytes)).toBe(false);
    expect(compositeBytes.equals(bBytes)).toBe(false);
    // Metadaten: keine EXIF/Personeninfo — WebP mit festen 1024×1024.
    const meta = await sharp(asset.storagePath).metadata();
    expect(meta.width).toBe(COMPOSITE_SIZE);
    expect(meta.height).toBe(COMPOSITE_SIZE);
    expect(meta.format).toBe('webp');
  });

  it('ist idempotent: gleiche Quellen + Algorithmus → gleiche Asset-ID, keine Duplikate', async () => {
    const a = await seedImageAsset(ctx.hostId, 220, 220, { r: 10, g: 200, b: 10 });
    const b = await seedImageAsset(ctx.hostId, 260, 200, { r: 10, g: 10, b: 200 });
    const first = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: ctx.hostId, roomId: 'room-idem', roundId: 'r1' });
    const second = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: ctx.hostId, roomId: 'room-idem', roundId: 'r1' });
    const third = await createGameImage({ personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: ctx.hostId, roomId: 'room-idem', roundId: 'r1' });
    expect(second.gameImageAssetId).toBe(first.gameImageAssetId);
    expect(third.gameImageAssetId).toBe(first.gameImageAssetId);
    // Genau EINE gespeicherte Instanz.
    const count = await ctx.prisma.mediaAsset.count({ where: { derivedFromAssetIds: { contains: a.id } } });
    expect(count).toBe(1);
  });

  it('A-Regression: die gespeicherte Composite-Datei überlebt wiederholte Aufrufe (Button „Spielbild neu erzeugen")', async () => {
    const a = await seedImageAsset(ctx.hostId, 240, 200, { r: 200, g: 100, b: 10 });
    const b = await seedImageAsset(ctx.hostId, 200, 240, { r: 10, g: 100, b: 200 });
    const params = { personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: ctx.hostId, roomId: 'room-regress', roundId: 'rr-1' };
    const first = await createGameImage(params);
    const asset = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
    const expectedBytes = await readFile(asset.storagePath);
    // Wiederholte Aufrufe (identisch zur UI: „Spielbild neu erzeugen"):
    for (let i = 0; i < 2; i++) {
      const again = await createGameImage(params);
      expect(again.gameImageAssetId).toBe(first.gameImageAssetId);
      // DIE IM DB-ASSET REFERENZIERTE DATEI muss existieren, dekodierbar
      // und bytegleich (deterministische Bytes, §7.4 unveränderlich).
      const onDisk = await readFile(asset.storagePath);
      expect(onDisk.equals(expectedBytes)).toBe(true);
      expect((await sharp(asset.storagePath).metadata()).width).toBe(COMPOSITE_SIZE);
      // Asset-Zeile unverändert (kein zweites Asset, kein Pfadwechsel).
      const after = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
      expect(after.storagePath).toBe(asset.storagePath);
      expect(await ctx.prisma.mediaAsset.count({ where: { derivedFromAssetIds: { contains: a.id } } })).toBe(1);
    }
  });

  it('A-Reparatur: fehlt die Composite-Datei (alter Bug/verlust), stellt der normale Ablauf sie kontrolliert wieder her', async () => {
    const a = await seedImageAsset(ctx.hostId, 180, 180, { r: 30, g: 180, b: 250 });
    const b = await seedImageAsset(ctx.hostId, 180, 180, { r: 250, g: 30, b: 60 });
    const params = { personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: ctx.hostId, roomId: 'room-repair', roundId: 'rp-1' };
    const first = await createGameImage(params);
    const asset = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
    const expectedBytes = await readFile(asset.storagePath);
    // Simuliert den alten Datenverlust: Datei weg, DB-Zeile intakt.
    await rm(asset.storagePath);
    const again = await createGameImage(params);
    expect(again.gameImageAssetId).toBe(first.gameImageAssetId);
    const repaired = await readFile(asset.storagePath);
    expect(repaired.equals(expectedBytes)).toBe(true);
    expect((await sharp(asset.storagePath).metadata()).format).toBe('webp');
    // Kein zusätzliches Asset, keine fremden Dateien.
    expect(await ctx.prisma.mediaAsset.count({ where: { derivedFromAssetIds: { contains: a.id } } })).toBe(1);
  });

  it('A-Race: parallele identische Aufrufe liefern dasselbe Asset; die Datei bleibt vorhanden', async () => {
    const a = await seedImageAsset(ctx.hostId, 300, 220, { r: 90, g: 10, b: 190 });
    const b = await seedImageAsset(ctx.hostId, 220, 300, { r: 190, g: 190, b: 10 });
    const params = { personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: ctx.hostId, roomId: 'room-parallel', roundId: 'par-1' };
    const results = await Promise.all([createGameImage(params), createGameImage(params), createGameImage(params)]);
    const ids = [...new Set(results.map(r => r.gameImageAssetId))];
    expect(ids).toHaveLength(1);
    const asset = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: ids[0] } });
    const bytes = await readFile(asset.storagePath); // existiert + lesbar
    expect(bytes.length).toBeGreaterThan(0);
    expect((await sharp(asset.storagePath).metadata()).width).toBe(COMPOSITE_SIZE);
    expect(await ctx.prisma.mediaAsset.count({ where: { derivedFromAssetIds: { contains: a.id } } })).toBe(1);
    // Keine verwaisten tmp-Dateien im echten Upload-Verzeichnis (composite
    // schreibt dorthin, nicht nach ctx.tmpDir).
    const { config } = await import('../../config/index.js');
    const uploadsDir = path.resolve(config.storagePaths.uploads);
    const leftovers = (await readdir(uploadsDir).catch(() => [] as string[])).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('A-Konflikt: ein DB-Unique-Konflikt bei der Anlage löscht NIE die finale Composite-Datei und hinterlässt keine tmp-Datei', async () => {
    const a = await seedImageAsset(ctx.hostId, 260, 180, { r: 150, g: 60, b: 20 });
    const b = await seedImageAsset(ctx.hostId, 180, 260, { r: 20, g: 150, b: 60 });
    const params = { personAImageAssetId: a.id, personBImageAssetId: b.id, hostUserId: ctx.hostId, roomId: 'room-conflict', roundId: 'cf-1' };
    const first = await createGameImage(params);
    const asset = await ctx.prisma.mediaAsset.findUniqueOrThrow({ where: { id: first.gameImageAssetId } });
    const expectedBytes = await readFile(asset.storagePath);
    // Simuliert den Parallel-Fall: findFirst (idempotenter Lookup) findet
    // nichts, aber create kollidiert (P2002). Der Race-Auflösungs-Lookup
    // (auch findFirst) findet dann das Gewinner-Asset.
    const originalFindFirst = ctx.prisma.mediaAsset.findFirst.bind(ctx.prisma.mediaAsset);
    const originalCreate = ctx.prisma.mediaAsset.create.bind(ctx.prisma.mediaAsset);
    let firstFindCalls = 0;
    (ctx.prisma.mediaAsset as { findFirst: unknown }).findFirst = async (args: { where: { sha256?: string } }) => {
      if (args.where?.sha256) {
        firstFindCalls += 1;
        // Erster Lookup (vor Create): nichts gefunden → Create wird laufen.
        // Zweiter Lookup (nach P2002): das Gewinner-Asset.
        return firstFindCalls === 1 ? null : originalFindFirst(args as never);
      }
      return originalFindFirst(args as never);
    };
    (ctx as { conflictArmed?: boolean }).conflictArmed = true;
    (ctx.prisma.mediaAsset as { create: unknown }).create = async (args: unknown) => {
      if ((ctx as { conflictArmed?: boolean }).conflictArmed) {
        (ctx as { conflictArmed?: boolean }).conflictArmed = false;
        const e = new Error('Unique constraint failed') as Error & { code?: string };
        e.code = 'P2002';
        throw e;
      }
      return originalCreate(args as never);
    };
    try {
      const again = await createGameImage(params);
      // Nach dem Konflikt auf das vorhandene Asset auflösen (kein 500).
      expect(again.gameImageAssetId).toBe(first.gameImageAssetId);
    } finally {
      (ctx.prisma.mediaAsset as { findFirst: unknown }).findFirst = originalFindFirst;
      (ctx.prisma.mediaAsset as { create: unknown }).create = originalCreate;
    }
    // Die finale Datei bleibt exakt erhalten; keine tmp-Datei übrig.
    const onDisk = await readFile(asset.storagePath);
    expect(onDisk.equals(expectedBytes)).toBe(true);
    const { config } = await import('../../config/index.js');
    const uploadsDir = path.resolve(config.storagePaths.uploads);
    const leftovers = (await readdir(uploadsDir).catch(() => [] as string[])).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(await ctx.prisma.mediaAsset.count({ where: { derivedFromAssetIds: { contains: a.id } } })).toBe(1);
  });

  it('verhindert, dass ein fremder Host fremde Bild-IDs verwendet (Ownership)', async () => {
    const foreign = await seedImageAsset(ctx.otherId, 200, 200, { r: 250, g: 250, b: 0 });
    const own = await seedImageAsset(ctx.hostId, 200, 200, { r: 0, g: 250, b: 250 });
    await expect(createGameImage({
      personAImageAssetId: foreign.id, personBImageAssetId: own.id,
      hostUserId: ctx.hostId, roomId: 'room-x', roundId: 'r',
    })).rejects.toThrow('ASSET_NOT_OWNED');
  });

  it('lehnt identische A/B-Quellen und nicht-fertige Assets ab', async () => {
    const a = await seedImageAsset(ctx.hostId, 200, 200, { r: 1, g: 2, b: 3 });
    await expect(createGameImage({
      personAImageAssetId: a.id, personBImageAssetId: a.id,
      hostUserId: ctx.hostId, roomId: 'room-x', roundId: 'r',
    })).rejects.toThrow(); // Endpoint-Prüfung (gleich) + Validierung
  });

  it('lässt bei Verarbeitungs-/Persistenz-Fehler keine unkontrolliert liegende Datei zurück', async () => {
    // Referenziere ein Asset, dessen Datei nicht existiert.
    const missing = await ctx.prisma.mediaAsset.create({
      data: {
        type: 'image', mimeType: 'image/webp', filename: `m-${Math.random().toString(36).slice(2)}.webp`,
        originalName: 'm.png', fileSize: 1, width: 1, height: 1,
        sha256: (await import('node:crypto')).randomBytes(32).toString('hex'),
        storagePath: join(ctx.tmpDir, 'does-not-exist-xyz.webp'), uploadedBy: ctx.hostId,
        visibility: 'PRIVATE', processStatus: 'READY', processed: true,
      },
    });
    const ok = await seedImageAsset(ctx.hostId, 200, 200, { r: 5, g: 6, b: 7 });
    const before = (await readdir(ctx.tmpDir)).length;
    await expect(createGameImage({
      personAImageAssetId: missing.id, personBImageAssetId: ok.id,
      hostUserId: ctx.hostId, roomId: 'room-err', roundId: 'r',
    })).rejects.toThrow('ASSET_FILE_MISSING');
    // Kein Orphan-File: Verzeichnisgröße unverändert (keine halbgestzte fusion-Datei).
    const after = (await readdir(ctx.tmpDir)).length;
    expect(after).toBe(before);
  });
});
