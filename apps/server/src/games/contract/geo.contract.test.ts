// ============================================================
// F5-Contract: ENGINE GEO (Wissensduell)
// ============================================================
// Führt das wiederverwendbare Contract-Gerüst (contractSuite) auf einer
// echten Engine aus. Geo benötigt für den Start Fragen → wird hier
// deterministisch erzeugt (independent vom Seed).
//
// Isolation (vmForks, isolate:false): nutzt contractClient() = eigenen
// gültigen Client auf DATABASE_URL. Vorbestehende Temp-DB-Tests lassen
// globalThis.__prisma einen TOTEN Client stehen; die Suite darf nicht
// darauf aufsetzen (siehe contractSuite.ts).
// ============================================================

import { beforeAll } from 'vitest';
import { contractClient, contractSuite } from './contractSuite.js';

beforeAll(async () => {
  const db = await contractClient();
  await db.user.upsert({ where: { id: 'mod-1' }, update: {}, create: { id: 'mod-1', displayName: 'F5 Host', passwordHash: 'x', role: 'HOST' } });
  await db.gameDefinition.upsert({
    where: { slug: 'geo' }, update: {},
    create: { slug: 'geo', name: 'Wissensduell (Geo)', category: 'Knowledge', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10, engineVersion: 3 },
  });
  // Deterministische Fragen für die Contract-Räume.
  const pack = await db.questionPack.create({ data: { gameSlug: 'geo', title: 'F5 Geo Pack', status: 'PUBLISHED' } });
  const q1 = await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'F1?', category: 'G', options: JSON.stringify([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]), correctOptionId: 'a' } });
  const q2 = await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'F2?', category: 'G', options: JSON.stringify([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]), correctOptionId: 'b' } });
  (globalThis as Record<string, unknown>).__f5GeoQuestions = [q1.id, q2.id];
});

contractSuite({
  slug: 'geo',
  playerCount: 2,
  setup: () => JSON.stringify({ selectedQuestionIds: (globalThis as Record<string, unknown>).__f5GeoQuestions as string[] }),
});
