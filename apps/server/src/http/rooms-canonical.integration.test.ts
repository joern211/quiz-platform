// ============================================================
// Raumerstellung & Slug-Resolution – Integrationstests
//
// Regelwerk §5.23 (Migration/Compatibility), §14 (FESTGELEGT), §12.1.
//
// Deckung:
//   - neue Räume mit kanonischen Slugs `wissensduell` und `wer-ist-das`
//   - Legacy-Slugs (`geo`, `weristdas`) werden bei der Raumerstellung auf
//     den kanonischen Slug aufgelöst (keine Doppel-Definition nötig)
//   - unbekanntes Spiel → GAME_NOT_FOUND (400)
//   - Rollenrechte: unauthentifiziert → 401
// ============================================================

import { describe, it, expect, afterAll } from 'vitest';
import supertest from 'supertest';
import { rm as rmAsync } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import {
  seedTestUserWithDb,
  createTestDatabase,
  cleanupTestDataForDb,
} from '../test-helpers.js';
import { createApp } from '../app.js';
import { GAME_SLUGS } from '@quiz/shared';

const TEMP_DIRS: string[] = [];

afterAll(async () => {
  for (const dir of TEMP_DIRS) {
    try { await rmAsync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  }
});

async function createTestApp() {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-room-'));
  TEMP_DIRS.push(tmpDir);
  const dbPath = join(tmpDir, 'test.db');
  const dbUrl = `file:${dbPath}`;
  await createTestDatabase(dbUrl);
  const freshPrisma = new PrismaClient({ datasourceUrl: dbUrl });
  await freshPrisma.$connect();
  globalThis.__prisma = freshPrisma;
  const { app } = createApp();
  return { app, prisma: freshPrisma, request: supertest(app), dbUrl };
}

/** Kanonische + Legacy-Definitionen für Raumerstellungs-Tests anlegen. */
async function seedGames(prisma: PrismaClient) {
  for (const slug of [GAME_SLUGS.wissensduell, GAME_SLUGS.werIstDas, GAME_SLUGS.jeopardy]) {
    const m = (await import('@quiz/shared')).getGameManifest(slug)!;
    await prisma.gameDefinition.upsert({
      where: { slug },
      update: {},
      create: { slug, name: m.name, category: m.category, status: 'AVAILABLE', minPlayers: m.minPlayers, maxPlayers: m.maxPlayers },
    });
  }
}

async function seedModerator(prisma: PrismaClient): Promise<{ cookie: string; userId: string }> {
  const ts = Date.now();
  return seedTestUserWithDb(prisma, `mod-canonical-${ts}`, `Moderator${ts}`, `mod-canonical-${ts}@test.local`);
}

describe('Raumerstellung mit kanonischen Slugs (§14)', () => {
  it('POST /rooms mit wissensduell erstellt Raum + Moderator-Participation', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const mod = await seedModerator(prisma);

    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Wissensduell-Abend', gameSlug: GAME_SLUGS.wissensduell });
    expect(res.status, res.text).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.moderatorToken).toBeTruthy();

    const room = await prisma.room.findUnique({ where: { code: res.body.data.code }, include: { gameDefinition: true, participations: true } });
    expect(room!.gameDefinition.slug).toBe(GAME_SLUGS.wissensduell);
    expect(room!.status).toBe('LOBBY');
    // Host-Participation wurde automatisch angelegt (Rolle MODERATOR)
    const host = room!.participations.find((p) => p.role === 'MODERATOR');
    expect(host).toBeDefined();
    expect(host!.role).toBe('MODERATOR');
    expect(host!.displayName).toMatch(/^Moderator\d+$/);
    expect(host!.connected).toBe(true);

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });

  it('POST /rooms mit wer-ist-das erstellt Raum', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const mod = await seedModerator(prisma);

    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Wer ist das?', gameSlug: GAME_SLUGS.werIstDas });
    expect(res.status, res.text).toBe(201);

    const room = await prisma.room.findUnique({ where: { code: res.body.data.code }, include: { gameDefinition: true } });
    expect(room!.gameDefinition.slug).toBe(GAME_SLUGS.werIstDas);

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });
});

describe('Legacy-Slug-Resolution bei Raumerstellung (§5.23)', () => {
  it('Legacy "geo" löst auf wissensduell auf (Definition wird gefunden)', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma); // nur KANONISCHE Definition vorhanden
    const mod = await seedModerator(prisma);

    // Client schickt den alten Slug "geo" – es existiert nur "wissensduell".
    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Alt-Client', gameSlug: 'geo' });
    expect(res.status, res.text).toBe(201);

    const room = await prisma.room.findUnique({ where: { code: res.body.data.code }, include: { gameDefinition: true } });
    // Der Raum hängt an der KANONISCHEN Definition, nicht an einer "geo".
    expect(room!.gameDefinition.slug).toBe(GAME_SLUGS.wissensduell);

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });

  it('Legacy "weristdas" löst auf wer-ist-das auf', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const mod = await seedModerator(prisma);

    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Legacy WerIstDas', gameSlug: 'weristdas' });
    expect(res.status, res.text).toBe(201);

    const room = await prisma.room.findUnique({ where: { code: res.body.data.code }, include: { gameDefinition: true } });
    expect(room!.gameDefinition.slug).toBe(GAME_SLUGS.werIstDas);

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });
});

describe('Raumerstellung: Fehlerfälle & Rechte', () => {
  it('unbekanntes Spiel → GAME_NOT_FOUND (400)', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const mod = await seedModerator(prisma);

    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Nix', gameSlug: 'definitiv-kein-spiel' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GAME_NOT_FOUND');

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });

  it('geplantes Spiel ohne Definition → GAME_NOT_FOUND (keine Phantom-Räume)', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const mod = await seedModerator(prisma);
    // "timeline" ist PLANNED und wurde nicht als Definition angelegt
    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Timeline', gameSlug: GAME_SLUGS.timeline });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('GAME_NOT_FOUND');

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });

  it('unauthentifiziert → 401 (Rollenrechte unverändert)', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const res = await req.post('/api/v1/rooms').send({ roomName: 'X', gameSlug: GAME_SLUGS.wissensduell });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NOT_AUTHENTICATED');
    await prisma.$disconnect();
    void dbUrl;
  });
});

// ============================================================
// Startfähigkeits-Sperre (Regelwerk §13.1) — serverseitig, für
// gameSlug UND gameDefinitionId. Ein PLANNED-/HIDDEN-Spiel, dessen
// Definition in der DB existiert (z.B. wie nach dem Seed), ist trotzdem
// NICH startbar → GAME_NOT_STARTABLE (nicht GAME_NOT_FOUND).
// ============================================================
describe('Raumerstellung: Startfähigkeits-Sperre (§13.1)', () => {
  // Legt eine Definition an, die wie nach dem Seed existiert (PLANNED).
  async function seedPlannedDefinition(prisma: PrismaClient) {
    const m = (await import('@quiz/shared')).getGameManifest(GAME_SLUGS.timeline)!;
    return prisma.gameDefinition.create({
      data: { slug: GAME_SLUGS.timeline, name: m.name, category: m.category, status: 'PLANNED', minPlayers: m.minPlayers, maxPlayers: m.maxPlayers },
    });
  }

  it('geplantes Spiel MIT Definition (wie nach Seed) → GAME_NOT_STARTABLE über gameSlug', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const planned = await seedPlannedDefinition(prisma);
    const mod = await seedModerator(prisma);

    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Timeline-Abend', gameSlug: GAME_SLUGS.timeline });
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('GAME_NOT_STARTABLE');
    // Kein Raum darf angelegt worden sein.
    expect(await prisma.room.count({ where: { gameDefinitionId: planned.id } })).toBe(0);

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });

  it('geplantes Spiel MIT Definition → GAME_NOT_STARTABLE über gameDefinitionId', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const planned = await seedPlannedDefinition(prisma);
    const mod = await seedModerator(prisma);

    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Timeline via ID', gameDefinitionId: planned.id });
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('GAME_NOT_STARTABLE');
    expect(await prisma.room.count({ where: { gameDefinitionId: planned.id } })).toBe(0);

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });

  it('HIDDEN-Spiel (Kollisions-Legacy) → GAME_NOT_STARTABLE', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    // Simuliert eine HIDDEN-Legacy-Definition (Kollisions-Migration).
    const hidden = await prisma.gameDefinition.create({
      data: { slug: 'verstecktes-spiel', name: 'Verstecktes', category: 'x', status: 'HIDDEN' },
    });
    const mod = await seedModerator(prisma);

    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'Hidden', gameDefinitionId: hidden.id });
    expect(res.status, res.text).toBe(400);
    expect(res.body.error.code).toBe('GAME_NOT_STARTABLE');
    expect(await prisma.room.count({ where: { gameDefinitionId: hidden.id } })).toBe(0);

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });

  it('AVAILABLE-Spiel mit Engine-Handler → 201 (Sperre lässt Startbares durch)', async () => {
    const { request: req, prisma, dbUrl } = await createTestApp();
    await seedGames(prisma);
    const mod = await seedModerator(prisma);

    const res = await req.post('/api/v1/rooms').set('Cookie', mod.cookie)
      .send({ roomName: 'OK', gameSlug: GAME_SLUGS.wissensduell });
    expect(res.status, res.text).toBe(201);

    await cleanupTestDataForDb(dbUrl);
    await prisma.$disconnect();
  });
});
