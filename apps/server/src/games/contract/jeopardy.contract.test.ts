// ============================================================
// F5-Contract: ENGINE JEOPARDY
// ============================================================
// Führt DASSELBE wiederverwendbare Contract-Gerüst (contractSuite) auf einer
// zweiten, unterschiedlichen echten Engine aus — der Nachweis, dass die
// gemeinsame Grundlage (Guard/Receipt/Config) engineübergreifend gilt.
// Jeopardy benötigt ein Board → wird hier deterministisch erzeugt.
//
// Isolation (vmForks, isolate:false): nutzt contractClient() = eigenen
// gültigen Client auf DATABASE_URL (siehe contractSuite.ts).
// ============================================================

import { beforeAll } from 'vitest';
import { contractClient, contractSuite } from './contractSuite.js';

const SECRET = 'CONTRACT_SECRET_DO_NOT_LEAK';

beforeAll(async () => {
  const db = await contractClient();
  await db.user.upsert({ where: { id: 'mod-1' }, update: {}, create: { id: 'mod-1', displayName: 'F5 Host', passwordHash: 'x', role: 'HOST' } });
  await db.gameDefinition.upsert({
    where: { slug: 'jeopardy' }, update: {},
    create: { slug: 'jeopardy', name: 'Jeopardy', category: 'buzzer-reaktion', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10, hasBuzzer: true, engineVersion: 1 },
  });
});

contractSuite({
  slug: 'jeopardy',
  playerCount: 2,
  setup: () => JSON.stringify({
    board1: { categories: [{ name: 'Cat1', clues: [{ value: 100, question: 'Frage 1?', answer: SECRET }] }] },
    board2: { categories: [{ name: 'Cat2', clues: [{ value: 200, question: 'Frage 2?', answer: SECRET }] }] },
  }),
});
