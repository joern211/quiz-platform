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

  // Create a default question pack
  await prisma.questionPack.upsert({
    where: { id: 'default-pack' },
    update: {},
    create: {
      id: 'default-pack',
      gameSlug: 'geo',
      title: 'Standard Geo-Paket',
      description: 'Standard Geografie-Fragen',
      status: 'PUBLISHED',
    },
  });

  // Create demo moderator
  await prisma.user.upsert({
    where: { id: 'mod-1' },
    update: {},
    create: {
      id: 'mod-1',
      displayName: 'Moderator',
      passwordHash: await hashPassword(process.env.ADMIN_PASSWORD || 'admin123'),
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
      passwordHash: await hashPassword(process.env.ADMIN_PASSWORD || 'admin123'),
      role: 'ADMIN',
    },
  });

  // Create game definitions
  const games = [
    {
      slug: 'geo',
      name: 'Geografie-Quiz',
      category: 'Quiz & Wissen',
      description: 'Multiple-Choice Quiz mit Geografie-Fragen',
      shortDescription: '4 Antworten, 20s Timer, Joker verfügbar',
      status: 'AVAILABLE',
      minPlayers: 2,
      maxPlayers: 10,
      estimatedMinutes: 15,
      tags: JSON.stringify(['buzzer', 'teams']),
      hasBuzzer: true,
      hasTimer: true,
    },
    {
      slug: 'jeopardy',
      name: 'Jeopardy',
      category: 'Buzzer & Reaktion',
      description: 'Klassisches Jeopardy mit zwei Boards und Abstauber-Runde',
      shortDescription: 'Feld wählen, Antwort geben, bei Fehler können andere buzzern',
      status: 'AVAILABLE',
      minPlayers: 2,
      maxPlayers: 10,
      estimatedMinutes: 30,
      tags: JSON.stringify(['buzzer']),
      hasBuzzer: true,
      hasTimer: true,
    },
    {
      slug: 'weristdas',
      name: 'Wer ist das?',
      category: 'Buzzer & Reaktion',
      description: 'Errate die beiden Personen im Fusionsbild',
      shortDescription: 'Buzzer, zwei Personen erraten, Hinweis möglich',
      status: 'AVAILABLE',
      minPlayers: 2,
      maxPlayers: 10,
      estimatedMinutes: 20,
      tags: JSON.stringify(['buzzer', 'media']),
      hasBuzzer: true,
      hasTimer: true,
    },
    {
      slug: 'timeline',
      name: 'Timeline',
      category: 'Schätzen & Sortieren',
      description: 'Ordne Elemente in die richtige Reihenfolge ein',
      shortDescription: '3 Leben, Element an richtige Position setzen',
      status: 'AVAILABLE',
      minPlayers: 2,
      maxPlayers: 10,
      estimatedMinutes: 15,
      tags: JSON.stringify(['sorting']),
      hasTimer: true,
    },
    {
      slug: 'luegen',
      name: 'Wer lügt am besten?',
      category: 'Bluff & Täuschung',
      description: 'Echte und erfundene Antworten erkennen und voted',
      shortDescription: 'Lüge schreiben, abstimmen, Lügen-Ersteller punkten',
      status: 'AVAILABLE',
      minPlayers: 3,
      maxPlayers: 10,
      estimatedMinutes: 25,
      tags: JSON.stringify(['voting', 'creative']),
      hasTimer: true,
    },
    {
      slug: 'song',
      name: 'Erkenne den Song',
      category: 'Buzzer & Reaktion',
      description: 'Höre den Song und buzzere als Erster',
      shortDescription: 'Audio abspielen, schnell buzzern, Titel+Interpret nennen',
      status: 'AVAILABLE',
      minPlayers: 2,
      maxPlayers: 10,
      estimatedMinutes: 20,
      tags: JSON.stringify(['buzzer', 'audio']),
      hasBuzzer: true,
      hasAudio: true,
      hasTimer: true,
    },
  ];

  for (const game of games) {
    await prisma.gameDefinition.upsert({
      where: { slug: game.slug },
      update: game,
      create: game,
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
