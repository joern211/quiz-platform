// F5-Contract: ENGINE WER IST DAS?
// Dieselbe Contract-Suite wie Wissensduell und Jeopardy (Protokollversion, Rechte, Replay/CAS, Config-Snapshot) auf der
// dritten echten Engine. Das Setup braucht ein Bild-Asset; es wird im eigenen Contract-Client angelegt.
import { beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { contractClient, contractSuite } from './contractSuite.js';

const SECRET = 'CONTRACT_SECRET_DO_NOT_LEAK';
let assetId = '';

beforeAll(async () => {
  const db = await contractClient();
  await db.user.upsert({ where: { id: 'mod-1' }, update: {}, create: { id: 'mod-1', displayName: 'F5 Host', passwordHash: 'x', role: 'HOST' } });
  await db.gameDefinition.upsert({
    where: { slug: 'wer-ist-das' }, update: {},
    create: { slug: 'wer-ist-das', name: 'Wer ist das?', category: 'buzzer-reaktion', status: 'BETA', minPlayers: 2, maxPlayers: 10, hasBuzzer: true, engineVersion: 1 },
  });
  assetId = (await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'contract.png', originalName: 'contract.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/contract.png', uploadedBy: 'mod-1' } })).id;
});

contractSuite({
  slug: 'wer-ist-das',
  playerCount: 2,
  setup: () => JSON.stringify({ rounds: [{ id: 'c1', imageAssetId: assetId, person1: SECRET, person2: `${SECRET}_2` }] }),
});
