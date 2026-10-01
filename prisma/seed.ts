// ============================================================
// Prisma Seed Script
// ============================================================

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function hashPassword(password: string): Promise<string> {
  return await argon2.hash(password, { type: argon2.argon2id });
}

async function main() {
  console.log('Seeding database...');

  // Idempotent seed: check if already seeded
  const existingGames = await prisma.gameDefinition.count();
  if (existingGames > 0) {
    console.log('Database already seeded, skipping...');
    return;
  }

  // Get admin credentials from env (with defaults for dev)
  const adminUsername = process.env.INITIAL_ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || 'admin123';
  const modPassword = process.env.INITIAL_ADMIN_PASSWORD || 'moderator123';

  // Create a default question pack (kanonischer Slug: wissensduell)
  await prisma.questionPack.upsert({
    where: { id: 'default-pack' },
    update: {},
    create: {
      id: 'default-pack',
      gameSlug: 'wissensduell',
      title: 'Standard-Wissenspaket',
      description: 'Standard-Wissensfragen (Geo, Allgemeinwissen, …)',
      status: 'PUBLISHED',
    },
  });

  // Create demo moderator
  await prisma.user.upsert({
    where: { id: 'mod-1' },
    update: {},
    create: {
      id: 'mod-1',
      email: 'moderator@example.com',
      displayName: adminUsername,
      passwordHash: await hashPassword(modPassword),
      role: 'MODERATOR',
    },
  });

  // Create admin
  await prisma.user.upsert({
    where: { id: 'admin-1' },
    update: {},
    create: {
      id: 'admin-1',
      displayName: 'Admin',
      passwordHash: await hashPassword(adminPassword),
      role: 'ADMIN',
    },
  });

  // Create game definitions – kanonische Identitäten aus dem
  // Spielekatalog (Regelwerk §14).
  //
  // WICHTIG: Dieses Script läuft vom REPOSITORY ROOT (pnpm db:seed /
  // Server-Test-Pipeline) und darf KEINEN Workspace-Package-Import
  // (z.B. @quiz/shared) nutzen – pnpm verlinkt @quiz/shared nur in die
  // Pakete (apps/*, packages/*), nicht ins Root-Verzeichnis. Die
  // Seed-Daten sind daher bewusst hier selbstbelegt. Der Konsistenztest
  // (apps/server/src/games/catalog-consistency.test.ts) stellt sicher,
  // dass Slugs + ehrlicher Status mit dem kanonischen Katalog in
  // @quiz/shared übereinstimmen – so bleibt @quiz/shared weiterhin die
  // Single Source of Truth für API/UI/Registry.
  //
  // Status-Logik (§13.1): AVAILABLE nur bei startbarer, getesteter
  // Engine (wissensduell, jeopardy, wer-ist-das). Alle anderen PLANNED.
  const seedGames = [
    { slug: 'wissensduell', name: 'Wissensduell', category: 'quiz-wissen', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 15, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
    { slug: 'jeopardy', name: 'Jeopardy', category: 'buzzer-reaktion', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 30, hasBuzzer: true, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
    { slug: 'wer-ist-das', name: 'Wer ist das?', category: 'buzzer-reaktion', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 15, hasBuzzer: true, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'song-quiz', name: 'Erkenne den Song', category: 'buzzer-reaktion', status: 'PLANNED', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 15, hasBuzzer: true, hasTeams: false, hasCamera: false, hasAudio: true, hasTimer: false },
    { slug: 'millionenfrage', name: 'Millionenfrage', category: 'quiz-wissen', status: 'PLANNED', minPlayers: 1, maxPlayers: 4, estimatedMinutes: 30, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
    { slug: 'timeline', name: 'Timeline', category: 'schaetzen-sortieren', status: 'PLANNED', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 20, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'schaetz-mal', name: 'Schätz mal', category: 'schaetzen-sortieren', status: 'PLANNED', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 15, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
    { slug: 'higher-lower', name: 'Higher or Lower', category: 'schaetzen-sortieren', status: 'PLANNED', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 10, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'imposter', name: 'Imposter', category: 'bluff-taeuschung', status: 'PLANNED', minPlayers: 3, maxPlayers: 10, estimatedMinutes: 20, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'wahr-oder-fake', name: 'Wahr oder Fake?', category: 'bluff-taeuschung', status: 'PLANNED', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 15, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'undercover', name: 'Undercover', category: 'social-deduction', status: 'PLANNED', minPlayers: 4, maxPlayers: 10, estimatedMinutes: 25, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'secret-agent', name: 'Geheim Agent', category: 'social-deduction', status: 'PLANNED', minPlayers: 4, maxPlayers: 10, estimatedMinutes: 25, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'partner-challenge', name: 'Wie weit gehst du?', category: 'team-kooperation', status: 'PLANNED', minPlayers: 4, maxPlayers: 8, estimatedMinutes: 25, hasBuzzer: false, hasTeams: true, hasCamera: false, hasAudio: false, hasTimer: true },
    { slug: 'same-thought', name: 'Gleicher Gedanke', category: 'team-kooperation', status: 'PLANNED', minPlayers: 2, maxPlayers: 8, estimatedMinutes: 15, hasBuzzer: false, hasTeams: true, hasCamera: false, hasAudio: false, hasTimer: true },
    { slug: 'stadt-land-fluss', name: 'Stadt, Land, Fluss', category: 'meta-spielmodi', status: 'PLANNED', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 20, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
    { slug: 'board-race', name: 'Raus damit!', category: 'meta-spielmodi', status: 'PLANNED', minPlayers: 2, maxPlayers: 6, estimatedMinutes: 20, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'yacht', name: 'Yacht', category: 'meta-spielmodi', status: 'PLANNED', minPlayers: 1, maxPlayers: 8, estimatedMinutes: 20, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
    { slug: 'last-man-standing', name: 'Last Man Standing', category: 'meta-spielmodi', status: 'PLANNED', minPlayers: 2, maxPlayers: 10, estimatedMinutes: 20, hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
  ];

  for (const game of seedGames) {
    await prisma.gameDefinition.upsert({
      where: { slug: game.slug },
      update: {
        name: game.name,
        category: game.category,
        status: game.status,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        estimatedMinutes: game.estimatedMinutes,
        hasBuzzer: game.hasBuzzer,
        hasTeams: game.hasTeams,
        hasCamera: game.hasCamera,
        hasAudio: game.hasAudio,
        hasTimer: game.hasTimer,
      },
      create: {
        slug: game.slug,
        name: game.name,
        category: game.category,
        status: game.status,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        estimatedMinutes: game.estimatedMinutes,
        hasBuzzer: game.hasBuzzer,
        hasTeams: game.hasTeams,
        hasCamera: game.hasCamera,
        hasAudio: game.hasAudio,
        hasTimer: game.hasTimer,
        tags: '[]',
      },
    });
  }

  // Create demo Geo questions
  const geoQuestions = [
    {
      id: 'geo-1',
      packId: 'default-pack',
      category: 'Hauptstädte',
      prompt: 'Was ist die Hauptstadt von Frankreich?',
      options: JSON.stringify([
        { id: 'a', text: 'London' },
        { id: 'b', text: 'Paris' },
        { id: 'c', text: 'Berlin' },
        { id: 'd', text: 'Madrid' },
      ]),
      correctOptionId: 'b',
      durationMs: 20000,
      points: 100,
      wrongPoints: 0,
      enabled: true,
    },
    {
      id: 'geo-2',
      packId: 'default-pack',
      category: 'Flaggen',
      prompt: 'Welches Land hat diese Flagge? 🇯🇵',
      options: JSON.stringify([
        { id: 'a', text: 'China' },
        { id: 'b', text: 'Japan' },
        { id: 'c', text: 'Südkorea' },
        { id: 'd', text: 'Vietnam' },
      ]),
      correctOptionId: 'b',
      durationMs: 20000,
      points: 100,
      wrongPoints: 0,
      enabled: true,
    },
    {
      id: 'geo-3',
      packId: 'default-pack',
      category: 'Allgemeinwissen',
      prompt: 'Wie viele Kontinente gibt es?',
      options: JSON.stringify([
        { id: 'a', text: '5' },
        { id: 'b', text: '6' },
        { id: 'c', text: '7' },
        { id: 'd', text: '8' },
      ]),
      correctOptionId: 'c',
      durationMs: 20000,
      points: 100,
      wrongPoints: 0,
      enabled: true,
    },
    {
      id: 'geo-4',
      packId: 'default-pack',
      category: 'Sprachen',
      prompt: 'In welchem Land ist Mandarin die Amtssprache?',
      options: JSON.stringify([
        { id: 'a', text: 'Japan' },
        { id: 'b', text: 'China' },
        { id: 'c', text: 'Vietnam' },
        { id: 'd', text: 'Thailand' },
      ]),
      correctOptionId: 'b',
      durationMs: 20000,
      points: 100,
      wrongPoints: 0,
      enabled: true,
    },
    {
      id: 'geo-5',
      packId: 'default-pack',
      category: 'Flüsse und Berge',
      prompt: 'Welcher ist der längste Fluss der Welt?',
      options: JSON.stringify([
        { id: 'a', text: 'Amazonas' },
        { id: 'b', text: 'Nil' },
        { id: 'c', text: 'Jangtsekiang' },
        { id: 'd', text: 'Mississippi' },
      ]),
      correctOptionId: 'b',
      durationMs: 20000,
      points: 100,
      wrongPoints: 0,
      enabled: true,
    },
  ];

  for (const q of geoQuestions) {
    await prisma.geoQuestion.upsert({
      where: { id: q.id },
      update: q,
      create: q,
    });
  }

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
