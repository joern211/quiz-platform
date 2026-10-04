// ============================================================
// Seed-Verhalten auf bestehender, teilgefüllter Datenbank
//
// Regelwerk §14 (Seed-Konsistenz mit dem kanonischen Katalog):
//   - Spiel-Definitionen werden IMMER zum kanonischen Katalog
//     konvergiert (Status, Relevanzfelder, Beschreibungen) — auch
//     wenn die DB bereits befüllt ist.
//   - Nutzer, Fragepakete und Fragen werden bei einer bestehenden
//     DB NICHT angefasst (kein Überschreiben von Content).
//   - Ein zweiter Seed-Lauf ist ein No-op (keine updatedAt-Änderung).
//
// Testet das ECHTE prisma/seed.ts als Subprozess (wie `pnpm db:seed`),
// nicht eine Simulation.
// ============================================================

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm as rmAsync } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createTestDatabase } from '../test-helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TEMP_DIRS: string[] = [];

afterAll(async () => {
  for (const dir of TEMP_DIRS) {
    try { await rmAsync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  }
});

async function setupDb(): Promise<{ dbUrl: string; prisma: PrismaClient }> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-seed-'));
  TEMP_DIRS.push(tmpDir);
  const dbUrl = `file:${join(tmpDir, 'seed.db')}`;
  await createTestDatabase(dbUrl);
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();
  return { dbUrl, prisma };
}

function runSeedSubprocess(dbUrl: string): Promise<{ stdout: string; stderr: string }> {
  const seedPath = join(repoRoot, 'prisma', 'seed.ts');
  return new Promise((done, fail) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', seedPath],
      { cwd: repoRoot, env: { ...process.env, DATABASE_URL: dbUrl }, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) fail(new Error(`Seed-Subprozess fehlgeschlagen: ${stderr || error.message}`));
        else done({ stdout, stderr });
      },
    );
  });
}

describe('Seed auf bestehender, teilgefüllter DB (Regelwerk §14)', () => {
  it('konvergiert Definitionen zum Katalog, lässt Nutzer/Content unverändert', async () => {
    const { dbUrl, prisma } = await setupDb();

    // ── Teilgefüllte DB simulieren ──────────────────────────────
    // 1) wer-ist-das mit ALTEREM Status + alter Beschreibung (vor-BETA)
    await prisma.gameDefinition.create({
      data: {
        slug: 'wer-ist-das', name: 'Wer ist das?', category: 'buzzer-reaktion',
        status: 'AVAILABLE', shortDescription: 'Fusionbilder erkennen',
        description: 'Errate, welche beiden Personen im Fusionbild vorkommen.',
        minPlayers: 3, maxPlayers: 10,
      },
    });
    // 2) song-quiz fälschlich AVAILABLE
    await prisma.gameDefinition.create({
      data: { slug: 'song-quiz', name: 'Erkenne den Song', category: 'buzzer-reaktion', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10 },
    });
    // 3) yacht fehlt komplett (unterbrochener Seed)
    // 4) existierender Nutzer mit eigenem displayName
    const user = await prisma.user.create({
      data: { displayName: 'Mein eigener Admin', passwordHash: 'x', role: 'ADMIN', email: 'bestehend@quiz.local' },
    });
    // 5) existierendes Fragepaket + existierende Frage (eigener Content)
    const pack = await prisma.questionPack.create({
      data: { id: 'default-pack', gameSlug: 'wissensduell', title: 'MEIN eigenes Paket', status: 'PUBLISHED' },
    });
    await prisma.geoQuestion.create({
      data: { id: 'geo-1', packId: pack.id, category: 'Eigenes', prompt: 'MEINE eigene Frage', options: '[]', correctOptionId: 'a', durationMs: 1000, points: 1, wrongPoints: 0, enabled: true },
    });

    // ── Echten Seed ausführen (wie pnpm db:seed) ────────────────
    await runSeedSubprocess(dbUrl);

    // Definitionen sind zum kanonischen Katalog konvergiert
    const wid = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'wer-ist-das' } });
    expect(wid.status).toBe('BETA');
    expect(wid.minPlayers).toBe(2);
    expect(wid.shortDescription).toBe('Bild + zwei Namen raten (Buzzer)');
    expect(wid.description).toMatch(/MVP-BETA/);
    expect(wid.description).toMatch(/Fusionsbild/);

    const song = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'song-quiz' } });
    expect(song.status).toBe('PLANNED');

    // Fehlende Definition wurde nachgeholt → jetzt 18
    expect(await prisma.gameDefinition.count()).toBe(18);
    expect(await prisma.gameDefinition.findUnique({ where: { slug: 'yacht' } })).not.toBeNull();

    // Nutzer/Content blieben UNVERÄNDERT
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.displayName).toBe('Mein eigener Admin');
    expect(userAfter.email).toBe('bestehend@quiz.local');
    expect(await prisma.user.count({ where: { email: 'moderator@example.com' } })).toBe(0);
    expect(await prisma.user.count({ where: { displayName: 'Admin' } })).toBe(0);

    const packAfter = await prisma.questionPack.findUniqueOrThrow({ where: { id: pack.id } });
    expect(packAfter.title).toBe('MEIN eigenes Paket');
    expect(await prisma.questionPack.count()).toBe(1);

    const qAfter = await prisma.geoQuestion.findUniqueOrThrow({ where: { id: 'geo-1' } });
    expect(qAfter.prompt).toBe('MEINE eigene Frage');
    expect(await prisma.geoQuestion.count()).toBe(1);

    // ── Zweiter Lauf: No-op (keine updatedAt-Änderung) ──────────
    const before = await prisma.gameDefinition.findMany({ select: { slug: true, updatedAt: true }, orderBy: { slug: 'asc' } });
    await runSeedSubprocess(dbUrl);
    const after = await prisma.gameDefinition.findMany({ select: { slug: true, updatedAt: true }, orderBy: { slug: 'asc' } });
    expect(after).toHaveLength(18);
    for (const def of after) {
      const prev = before.find((b) => b.slug === def.slug)!;
      expect(def.updatedAt.getTime(), `updatedAt von ${def.slug} änderte sich beim 2. Seed-Lauf`).toBe(prev.updatedAt.getTime());
    }

    await prisma.$disconnect();
  });

  it('frische DB: vollständiger Seed (Definitionen, Nutzer, Paket, Fragen)', async () => {
    const { dbUrl, prisma } = await setupDb();
    await runSeedSubprocess(dbUrl);

    expect(await prisma.gameDefinition.count()).toBe(18);
    const wid = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'wer-ist-das' } });
    expect(wid.status).toBe('BETA');
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.questionPack.findUnique({ where: { id: 'default-pack' } })).not.toBeNull();
    expect(await prisma.geoQuestion.count()).toBe(5);
    await prisma.$disconnect();
  });
});
