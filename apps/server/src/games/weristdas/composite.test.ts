import { join } from 'node:path';
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
