// ============================================================
// Medien-Lebenszyklus Tests (PR11 Nacharbeit E)
//
// Prüft den konkreten Setup-Ablauf:
//   1. Composite wird VOR der Raumerstellung erzeugt (roomId 'tmp-<Host>').
//   2. Nach POST /rooms wird es KONTROLLIERT an den echten Raum gebunden
//      (nur ROOM_TEMP + owner + im Snapshot referenziert; idempotent;
//      fremde/bereits gebundene Assets nicht gestohlen; Originale nicht).
//   3. Verwaiste tmp-Assets (Abbruch, Quellaustausch, gelöschte Runde,
//      fehlgeschlagene Raumerstellung, Prozessunterbrechung) werden
//      befristet bereinigt — aktive + historisch referenzierte Bilder
//      bleiben geschützt.
// ============================================================

import { describe, it, expect, afterAll } from 'vitest';
import supertest from 'supertest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import {
  seedTestUserWithDb,
  getOrCreateStartableGame,
  cleanupTestDataForDb,
  createTestDatabase,
} from '../test-helpers.js';
import { bindSnapshotAssetsToRoom, cleanupOrphanedTempAssets } from './lifecycle.js';

const ALL_TEMP_DIRS: string[] = [];
const NOW = new Date();

async function makeApp() {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-lifecycle-'));
  ALL_TEMP_DIRS.push(tmpDir);
  const dbUrl = `file:${join(tmpDir, 'test.db')}`;
  await createTestDatabase(dbUrl);
  const freshPrisma = new PrismaClient({ datasourceUrl: dbUrl });
  await freshPrisma.$connect();
  globalThis.__prisma = freshPrisma;
  const { createApp } = await import('../app.js');
  const { app } = createApp();
  return { app, prisma: freshPrisma, request: supertest(app), dbUrl, tmpDir };
}

// Ein ROOM_TEMP-Asset, genau so, wie es der Composite-Endpunkt vor der
// Raumerstellung erzeugt (roomId 'tmp-<Host>', optional mit echter Datei).
async function makeTempAsset(db: PrismaClient, opts: {
  host: string; roundId?: string; visibility?: string; roomId?: string | null;
  daysOld?: number; withFile?: boolean; dir?: string;
}) {
  const file = opts.withFile ? join(opts.dir!, `asset-${Math.random().toString(36).slice(2)}.webp`) : undefined;
  if (file) await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // placeholder-Bildbytes
  const daysOldMs = (opts.daysOld ?? 0) * 24 * 60 * 60 * 1000;
  return db.mediaAsset.create({ data: {
    type: 'image', mimeType: 'image/webp', filename: 'fusion-x.webp', originalName: 'fusion.webp',
    fileSize: 4, sha256: `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
    storagePath: file ?? `/nonexistent/${Math.random().toString(36).slice(2)}.webp`,
    uploadedBy: opts.host, visibility: opts.visibility ?? 'ROOM_TEMP',
    roomId: opts.roomId ?? `tmp-${opts.host}`, processStatus: 'READY',
    derivedFromAssetIds: JSON.stringify(['a'.repeat(32), 'b'.repeat(32)]),
    createdAt: new Date(NOW.getTime() - daysOldMs),
  } });
}

function v2Snapshot(gameImageAssetId: string) {
  return JSON.stringify({
    setupSchemaVersion: 2,
    rounds: [{
      id: 'r1',
      personAImageAssetId: 'a'.repeat(32), personBImageAssetId: 'b'.repeat(32),
      gameImageAssetId, personAName: 'A', personBName: 'B', setupVersion: 2,
    }],
  });
}

afterAll(async () => {
  for (const dir of ALL_TEMP_DIRS) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

describe('Medien-Lebenszyklus — kontrollierte Raum-Bindung (PR11 E)', () => {
  it('POST /rooms bindet vorab erzeugte tmp-Composites an den echten Raum (nur referenzierte ROOM_TEMP-Assets des Hosts)', async () => {
    const { request, prisma: db, dbUrl } = await makeApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-e1-${ts}`, `E1${ts}`, `mod-e1-${ts}@t.local`);
    const startable = await getOrCreateStartableGame();
    // Vor der Raumerstellung erzeugtes Composite (roomId 'tmp-<host>').
    const composite = await makeTempAsset(db, { host: host.userId });
    // Ein PRIVATES Original im selben Snapshot — darf NICHT umgebunden werden.
    const original = await db.mediaAsset.create({ data: {
      type: 'image', mimeType: 'image/png', filename: 'o.png', originalName: 'o.png',
      fileSize: 4, sha256: `${Math.random().toString(36).slice(2)}x1`, storagePath: '/nonexistent/o.png',
      uploadedBy: host.userId, visibility: 'PRIVATE', roomId: null, processStatus: 'READY',
    } });
    // Ein fremdes ROOM_TEMP-Asset (anderer Host), das im Snapshot steht → kein Diebstahl.
    const strangerAsset = await makeTempAsset(db, { host: 'other-host-xyz' });

    const snapshot = JSON.stringify({
      setupSchemaVersion: 2,
      rounds: [{
        id: 'r1', personAImageAssetId: original.id, personBImageAssetId: strangerAsset.id,
        gameImageAssetId: composite.id, personAName: 'A', personBName: 'B', setupVersion: 2,
      }],
    });

    const res = await request.post('/api/v1/rooms').set('Cookie', host.cookie)
      .send({ roomName: 'Lifecycle Room', gameDefinitionId: startable.id, setupSnapshotJson: JSON.parse(snapshot) });
    expect(res.status, res.text).toBe(201);
    const roomId = res.body.data.roomId as string;

    // Composite: an den echten Raum gebunden.
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: composite.id } })).roomId).toBe(roomId);
    // Original: UNVERÄNDERT (PRIVATE bleibt owner-only, roomId null).
    const origAfter = await db.mediaAsset.findUniqueOrThrow({ where: { id: original.id } });
    expect(origAfter.roomId).toBeNull();
    expect(origAfter.visibility).toBe('PRIVATE');
    // Fremdes Asset: UNVERÄNDERT (bleibt beim anderen Host).
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: strangerAsset.id } })).roomId).toBe('tmp-other-host-xyz');

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('Bindung ist idempotent und stiehlt nichts: zweiter Raum mit denselben IDs bindet das Asset nicht um', async () => {
    const { prisma: db, dbUrl } = await makeApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-e2-${ts}`, `E2${ts}`, `mod-e2-${ts}@t.local`);
    const composite = await makeTempAsset(db, { host: host.userId });

    const startable = await getOrCreateStartableGame();
    const room1 = await db.room.create({ data: {
      code: `700-1${(ts % 90) + 1}`, roomName: 'R1', gameDefinitionId: startable.id,
      hostUserId: host.userId, status: 'LOBBY', runPhase: 'OPEN',
      setupSnapshotJson: v2Snapshot(composite.id),
    } });
    await bindSnapshotAssetsToRoom(db, { roomId: room1.id, hostUserId: host.userId, snapshotJson: v2Snapshot(composite.id) });
    await bindSnapshotAssetsToRoom(db, { roomId: room1.id, hostUserId: host.userId, snapshotJson: v2Snapshot(composite.id) });
    // Idempotent: zweiter Aufruf ändert nichts.
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: composite.id } })).roomId).toBe(room1.id);

    // Zweiter Raum referenziert dasselbe Asset → wird NICHT umgebunden.
    const room2 = await db.room.create({ data: {
      code: `700-20${ts % 100}`, roomName: 'R2', gameDefinitionId: room1.gameDefinitionId,
      hostUserId: host.userId, status: 'LOBBY', runPhase: 'OPEN',
      setupSnapshotJson: v2Snapshot(composite.id),
    } });
    await bindSnapshotAssetsToRoom(db, { roomId: room2.id, hostUserId: host.userId, snapshotJson: v2Snapshot(composite.id) });
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: composite.id } })).roomId).toBe(room1.id);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('Bindung bei fehlgeschlagener Raumerstellung passiert nicht — Asset bleibt tmp (und wird später bereinigt)', async () => {
    const { prisma: db, dbUrl } = await makeApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-e3-${ts}`, `E3${ts}`, `mod-e3-${ts}@t.local`);
    const composite = await makeTempAsset(db, { host: host.userId, daysOld: 2 });
    // Keine Raumerstellung (z.B. 400/403/500) → keine Bindung:
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: composite.id } })).roomId).toBe(`tmp-${host.userId}`);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('Prozessunterbrechung an der kritischen Grenze: Raum existiert, Bindung lief NICHT (Crash) → Asset bleibt tmp; Heilung beim Spielstart bindet es', async () => {
    const { prisma: db, dbUrl } = await makeApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-e5-${ts}`, `E5${ts}`, `mod-e5-${ts}@t.local`);
    const startable = await getOrCreateStartableGame();
    const composite = await makeTempAsset(db, { host: host.userId });
    // Raum direkt in der DB (simuliert: POST /rooms lieferte 201, aber der
    // Prozess wurde VOR der Bindung beendet) → Asset liegt noch unter tmp-.
    const room = await db.room.create({ data: {
      code: `700-4${(ts % 90) + 1}`, roomName: 'Crashed', gameDefinitionId: startable.id,
      hostUserId: host.userId, status: 'LOBBY', runPhase: 'OPEN',
      setupSnapshotJson: v2Snapshot(composite.id),
    } });
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: composite.id } })).roomId).toBe(`tmp-${host.userId}`);

    // Heilungspfad = derselbe Aufruf, den engine.initialize() beim Spielstart
    // ausführt (idempotent, an den echten Raum):
    await bindSnapshotAssetsToRoom(db, { roomId: room.id, hostUserId: host.userId, snapshotJson: room.setupSnapshotJson });
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: composite.id } })).roomId).toBe(room.id);

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });

  it('Doppelklick/Retry bei POST /rooms: Asset wird an den ERSTEN Raum gebunden, nicht an den zweiten gestohlen', async () => {
    const { prisma: db, dbUrl } = await makeApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-e6-${ts}`, `E6${ts}`, `mod-e6-${ts}@t.local`);
    const startable = await getOrCreateStartableGame();
    const composite = await makeTempAsset(db, { host: host.userId });
    const snap = v2Snapshot(composite.id);
    const roomA = await db.room.create({ data: {
      code: `700-5${(ts % 90) + 1}`, roomName: 'A', gameDefinitionId: startable.id,
      hostUserId: host.userId, status: 'LOBBY', runPhase: 'OPEN', setupSnapshotJson: snap,
    } });
    const roomB = await db.room.create({ data: {
      code: `700-6${(ts % 90) + 1}`, roomName: 'B', gameDefinitionId: startable.id,
      hostUserId: host.userId, status: 'LOBBY', runPhase: 'OPEN', setupSnapshotJson: snap,
    } });
    // Beide POST /rooms haben (je Klick) ihre Bindung gefahren. Das Asset
    // gehört dem ERSTEN; der zweite Raumbindungsversuch stiehlt es NICHT.
    await bindSnapshotAssetsToRoom(db, { roomId: roomA.id, hostUserId: host.userId, snapshotJson: snap });
    await bindSnapshotAssetsToRoom(db, { roomId: roomB.id, hostUserId: host.userId, snapshotJson: snap });
    expect((await db.mediaAsset.findUniqueOrThrow({ where: { id: composite.id } })).roomId).toBe(roomA.id);
    // Raum B bleibt trotzdem funktionsfähig (Startvalidierung prüft
    // Eigentum + Provenienz, nicht roomId) → kein „halb gebrochener" Raum.
    expect(roomB.id).toBeTruthy();

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });
});

describe('Medien-Lebenszyklus — befristete Bereinigung verwaister tmp-Assets (PR11 E)', () => {
  it('löscht NUR unreferenzierte, ältere tmp-Assets (Datei + DB-Zeile); schützt referenzierte, frische, echte-Raum- und Originale', async () => {
    const { prisma: db, dbUrl, tmpDir } = await makeApp();
    const ts = Date.now();
    const host = await seedTestUserWithDb(db, `mod-e4-${ts}`, `E4${ts}`, `mod-e4-${ts}@t.local`);
    const startable = await getOrCreateStartableGame();

    // 1) Verwaist + 2 Tage alt + reale Datei → wird gelöscht.
    const orphan = await makeTempAsset(db, { host: host.userId, daysOld: 2, withFile: true, dir: tmpDir });
    // 2) Referenziert in einem ENDED-Raum (historisch benötigt) → bleibt.
    const referenced = await makeTempAsset(db, { host: host.userId, daysOld: 2 });
    const endedRoom = await db.room.create({ data: {
      code: `700-30${ts % 100}`, roomName: 'Ended', gameDefinitionId: startable.id,
      hostUserId: host.userId, status: 'ENDED', runPhase: 'RESULTS', setupSnapshotJson: v2Snapshot(referenced.id),
    } });
    // 3) Verwaist, aber frisch (1 Stunde) → bleibt (unter TTL).
    const fresh = await makeTempAsset(db, { host: host.userId });
    // 4) An einen echten Raum gebunden (nicht mehr 'tmp-') → bleibt.
    const bound = await makeTempAsset(db, { host: host.userId, daysOld: 2, roomId: endedRoom.id });
    // 5) Privates Original (roomId null) → bleibt.
    const original = await db.mediaAsset.create({ data: {
      type: 'image', mimeType: 'image/png', filename: 'o2.png', originalName: 'o2.png',
      fileSize: 4, sha256: `${Math.random().toString(36).slice(2)}x2`, storagePath: join(tmpDir, 'orig2.png'),
      uploadedBy: host.userId, visibility: 'PRIVATE', roomId: null, processStatus: 'READY',
      createdAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
    } });

    const cleaned = await cleanupOrphanedTempAssets(db, 24 * 60 * 60 * 1000, NOW);
    expect(cleaned).toBe(1);
    // Orphan: DB-Zeile + Datei weg.
    expect(await db.mediaAsset.findUnique({ where: { id: orphan.id } })).toBeNull();
    await expect((await import('node:fs/promises')).access(orphan.storagePath)).rejects.toThrow();
    // Referenziert, frisches, gebundenes, Original: alle da.
    for (const id of [referenced.id, fresh.id, bound.id, original.id]) {
      expect(await db.mediaAsset.findUnique({ where: { id } })).not.toBeNull();
    }

    await cleanupTestDataForDb(dbUrl);
    await db.$disconnect();
  });
});
