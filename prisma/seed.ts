// ============================================================
// Prisma Seed Script
// ============================================================

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { GAME_MANIFESTS, GAME_SLUGS } from '@quiz/shared';

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
      gameSlug: GAME_SLUGS.wissensduell,
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

  // Create game definitions – abgeleitet aus dem kanonischen Manifest
  // (@quiz/shared, Single Source of Truth, Regelwerk §14). So tragen DB,
  // API und Website dieselben Identitäten und ehrlichen Status.
  for (const game of GAME_MANIFESTS) {
    await prisma.gameDefinition.upsert({
      where: { slug: game.slug },
      update: {
        name: game.name,
        category: game.category,
        shortDescription: game.shortDescription,
        description: game.description,
        status: game.status,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        estimatedMinutes: game.estimatedDurationMinutes,
        hasBuzzer: game.hasBuzzer,
        hasTeams: game.hasTeams,
        hasCamera: game.hasCamera,
        hasAudio: game.hasAudio,
        hasTimer: game.hasTimer,
        tags: JSON.stringify(game.tags),
      },
      create: {
        slug: game.slug,
        name: game.name,
        category: game.category,
        shortDescription: game.shortDescription,
        description: game.description,
        status: game.status,
        minPlayers: game.minPlayers,
        maxPlayers: game.maxPlayers,
        estimatedMinutes: game.estimatedDurationMinutes,
        hasBuzzer: game.hasBuzzer,
        hasTeams: game.hasTeams,
        hasCamera: game.hasCamera,
        hasAudio: game.hasAudio,
        hasTimer: game.hasTimer,
        tags: JSON.stringify(game.tags),
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
