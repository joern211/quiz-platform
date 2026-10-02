// ============================================================
// Kanonische Slug-Migration – Integrationstests
//
// Regelwerk §5.22 (Engine-Versionierung), §5.23 (Migration/Compatibility),
// §12.1 (Single Source), §14 (FESTGELEGT).
//
// Szenarien:
//   A) Legacy-DB (geo/weristdas/luegen/song) mit Fragepaketen,
//      Participations, Scores, aktivem + abgeschlossenen Raum:
//      Migration benennt um, IDs/Relationen/Scores/Results bleiben,
//      Engine-Version und Status bleiben, Audit-Log wird geschrieben.
//   B) Idempotenz: zweiter Lauf verändert NICHTS mehr (vollständiger
//      Snapshot-Vergleich).
//   C) Kollision: alter + neuer Slug gleichzeitig vorhanden → kein
//      Löschen, Kinder auf kanonisch umgebunden, Legacy HIDDEN +
//      markiert, zweiter Lauf ist No-op.
//   D) Bereits kanonische DB → applied=false, keine Audit-Einträge.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm as rmAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { createTestDatabase } from '../test-helpers.js';
import {
  runCanonicalSlugMigration,
  CANONICAL_SLUG_MIGRATION_VERSION,
} from './canonicalSlugMigration.js';

let dbPath: string;
let dbUrl: string;
let prisma: PrismaClient;

beforeAll(async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-mig-'));
  dbPath = join(tmpDir, 'test.db');
  dbUrl = `file:${dbPath}`;
  await createTestDatabase(dbUrl);
  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await rmAsync(dbPath, { recursive: true, force: true, maxRetries: 3 });
});

// ── Fixtures ──────────────────────────────────────────────────

async function seedUser(): Promise<string> {
  const u = await prisma.user.create({
    data: { id: 'mig-host', displayName: 'Mig Host', passwordHash: 'x', role: 'MODERATOR' },
  });
  return u.id;
}

async function seedLegacyGeoContent(defId: string, hostUserId: string, roomCode: string, status: string) {
  // Fragepaket (legacy Slug "geo") mit Frage
  const pack = await prisma.questionPack.create({
    data: { gameSlug: 'geo', title: 'Legacy Geo Paket', status: 'PUBLISHED' },
  });
  await prisma.geoQuestion.create({
    data: {
      packId: pack.id,
      prompt: 'Welche Stadt ist die Hauptstadt von Frankreich?',
      category: 'Geografie',
      options: JSON.stringify([
        { id: 'a', text: 'Marseille' },
        { id: 'b', text: 'Paris' },
        { id: 'c', text: 'Lyon' },
        { id: 'd', text: 'Nice' },
      ]),
      correctOptionId: 'b',
    },
  });

  const room = await prisma.room.create({
    data: {
      code: roomCode,
      roomName: 'Legacy Raum',
      gameDefinitionId: defId,
      hostUserId,
      status,
      runPhase: status === 'RUNNING' ? 'ROUND_ACTIVE' : 'FINAL',
    },
  });
  const part = await prisma.participation.create({
    data: {
      roomId: room.id,
      displayName: 'Alice',
      normalizedName: 'alice',
      role: 'PLAYER',
      rejoinToken: `mig-rt-${roomCode}`,
      connected: true,
      score: 350,
    },
  });
  await prisma.scoreEvent.create({
    data: { roomId: room.id, participationId: part.id, roundIndex: 1, delta: 150, reason: 'correct' },
  });
  await prisma.scoreEvent.create({
    data: { roomId: room.id, participationId: part.id, roundIndex: 2, delta: 200, reason: 'correct' },
  });
  await prisma.roomGameState.create({
    data: { roomId: room.id, engineVersion: 3, phase: status === 'RUNNING' ? 'INPUT_OPEN' : 'RESULT', stateJson: JSON.stringify({ phase: status === 'RUNNING' ? 'INPUT_OPEN' : 'RESULT', currentRoundIndex: 2 }) },
  });
  return { packId: pack.id, roomId: room.id, participationId: part.id };
}

/** Vollständiger Snapshot aller migrationsrelevanten Zeilen (für Idempotenz). */
interface MigrationSnapshot {
  defs: unknown[];
  packs: unknown[];
  questions: unknown[];
  rooms: unknown[];
  parts: unknown[];
  events: unknown[];
  states: unknown[];
  audits: unknown[];
}
async function snapshot(): Promise<MigrationSnapshot> {
  const [defs, packs, questions, rooms, parts, events, states, audits] = await Promise.all([
    prisma.gameDefinition.findMany({ orderBy: { slug: 'asc' } }).then((d) => d.map((x) => ({ id: x.id, slug: x.slug, name: x.name, category: x.category, status: x.status, engineVersion: x.engineVersion, estimatedMinutes: x.estimatedMinutes, updatedAt: x.updatedAt.toISOString() }))),
    prisma.questionPack.findMany({ orderBy: { id: 'asc' } }).then((p) => p.map((x) => ({ id: x.id, gameSlug: x.gameSlug, title: x.title }))),
    prisma.geoQuestion.findMany().then((q) => q.map((x) => ({ id: x.id, packId: x.packId, prompt: x.prompt, correctOptionId: x.correctOptionId }))),
    prisma.room.findMany().then((r) => r.map((x) => ({ id: x.id, code: x.code, gameDefinitionId: x.gameDefinitionId, status: x.status, runPhase: x.runPhase }))),
    prisma.participation.findMany().then((p) => p.map((x) => ({ id: x.id, roomId: x.roomId, displayName: x.displayName, score: x.score, rejoinToken: x.rejoinToken }))),
    prisma.scoreEvent.findMany().then((e) => e.map((x) => ({ id: x.id, roomId: x.roomId, participationId: x.participationId, roundIndex: x.roundIndex, delta: x.delta, reason: x.reason }))),
    prisma.roomGameState.findMany().then((s) => s.map((x) => ({ id: x.id, roomId: x.roomId, engineVersion: x.engineVersion, phase: x.phase, stateJson: x.stateJson }))),
    prisma.auditLog.findMany().then((a) => a.map((x) => ({ id: x.id, action: x.action, metadata: x.metadata }))),
  ]);
  return { defs, packs, questions, rooms, parts, events, states, audits };
}

describe('Slug-Migration: Legacy-DB (§5.23)', () => {
  let hostId: string;
  let legacyDefId: string;
  let running: { packId: string; roomId: string; participationId: string };
  let ended: { packId: string; roomId: string; participationId: string };

  beforeAll(async () => {
    hostId = await seedUser();
    const legacy = await prisma.gameDefinition.create({
      data: { id: 'legacy-geo', slug: 'geo', name: 'Geografie-Quiz', category: 'GEO', status: 'AVAILABLE', estimatedMinutes: 20 },
    });
    legacyDefId = legacy.id;
    running = await seedLegacyGeoContent(legacyDefId, hostId, '111-111', 'RUNNING');
    ended = await seedLegacyGeoContent(legacyDefId, hostId, '222-222', 'ENDED');
    // weitere Legacy-Spieldefinitionen
    await prisma.gameDefinition.create({ data: { id: 'legacy-wid', slug: 'weristdas', name: 'Wer ist das?', category: 'BUZZER', status: 'AVAILABLE' } });
    await prisma.gameDefinition.create({ data: { id: 'legacy-luegen', slug: 'luegen', name: 'Wer lügt?', category: 'BLUFF', status: 'AVAILABLE' } });
  });

  it('benennt alle Legacy-Definitionen auf die kanonischen Slugs um (ID bleibt)', async () => {
    const result = await runCanonicalSlugMigration(prisma);
    expect(result.version).toBe(CANONICAL_SLUG_MIGRATION_VERSION);
    expect(result.applied).toBe(true);
    expect(result.renamedDefinitions).toContain('geo → wissensduell');
    expect(result.renamedDefinitions).toContain('weristdas → wer-ist-das');
    expect(result.renamedDefinitions).toContain('luegen → imposter');

    const wd = await prisma.gameDefinition.findUnique({ where: { id: legacyDefId } });
    expect(wd!.slug).toBe('wissensduell');
    expect(wd!.name).toBe('Wissensduell'); // Manifest-Name übernommen
    expect(wd!.status).toBe('AVAILABLE'); // ehrlicher Status aus Manifest
    const wid = await prisma.gameDefinition.findUnique({ where: { slug: 'wer-ist-das' } });
    expect(wid!.id).toBe('legacy-wid'); // ID stabil
    const imp = await prisma.gameDefinition.findUnique({ where: { slug: 'imposter' } });
    expect(imp!.id).toBe('legacy-luegen');
  });

  it('migrated Fragepakete auf die kanonische Slug (Fragen bleiben)', async () => {
    const pack = await prisma.questionPack.findUnique({ where: { id: running.packId } });
    expect(pack!.gameSlug).toBe('wissensduell');
    const q = await prisma.geoQuestion.findUnique({ where: { id: (await prisma.geoQuestion.findFirst({ where: { packId: running.packId } }))!.id } });
    expect(q!.correctOptionId).toBe('b');
  });

  it('aktive UND abgeschlossene Räume behalten ID/Slug-Referenz, Status, Scores, Events und Engine-Version', async () => {
    const runRoom = await prisma.room.findUnique({ where: { id: running.roomId } });
    expect(runRoom!.gameDefinitionId).toBe(legacyDefId); // ID unverändert
    expect(runRoom!.status).toBe('RUNNING');
    const runState = await prisma.roomGameState.findUnique({ where: { roomId: running.roomId } });
    expect(runState!.engineVersion).toBe(3); // Engine-Version NICHT berührt
    const endRoom = await prisma.room.findUnique({ where: { id: ended.roomId } });
    expect(endRoom!.status).toBe('ENDED');

    const parts = await prisma.participation.findMany({ where: { roomId: running.roomId } });
    expect(parts[0]!.score).toBe(350);
    const events = await prisma.scoreEvent.findMany({ where: { roomId: running.roomId } });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.delta).sort((a, b) => a - b)).toEqual([150, 200]);
  });

  it('schreibt genau einen Audit-Eintrag mit der Migrationsversion', async () => {
    const audits = await prisma.auditLog.findMany({ where: { action: 'canonical_slug_migration' } });
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0]!.metadata!);
    expect(meta.version).toBe(CANONICAL_SLUG_MIGRATION_VERSION);
  });
});

describe('Slug-Migration: Idempotenz (Wiederholung)', () => {
  it('zweiter Lauf: applied=false, changes=0, vollständiger Snapshot identisch', async () => {
    const before = await snapshot();
    const result = await runCanonicalSlugMigration(prisma);
    expect(result.applied).toBe(false);
    expect(result.changes).toBe(0);
    expect(result.renamedDefinitions).toHaveLength(0);
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});

describe('Slug-Migration: Kollision (legacy + canonical gleichzeitig)', () => {
  // Eigenes, sauberer isoliertes Szenario in derselben DB:
  // es existieren NUN "weristdas" (mit Raum) und bereits "wer-ist-das".
  // (Vorheriger Block hat geo→wissensduell umbenannt; hier nutzt weristdas,
  //  das im Legacy-Block zwar umbenannt wurde – wir erzeugen daher frische
  //  Legacy-Definitionen unter luegen-ähnlichen Slugs, die noch free sind.)

  let hostId: string;
  let legacyId: string;
  let canonicalId: string;

  beforeAll(async () => {
    // Der vorangehende Block hat luegen→imposter umbenannt und weristdas→wer-ist-das.
    // Für die Kollision erzeugen wir frische Paare über noch verfügbare Legacy-Slugs.
    const u = await prisma.user.create({
      data: { id: 'mig-coll-host', displayName: 'Coll Host', passwordHash: 'x', role: 'MODERATOR' },
    });
    hostId = u.id;
    // canonical "imposter" existiert bereits (aus Block A) → Kollision mit "wer-luegt"
    const canonical = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'imposter' } });
    canonicalId = canonical.id;
    const legacy = await prisma.gameDefinition.create({
      data: { id: 'coll-legacy', slug: 'wer-luegt', name: 'Wer lügt? (Alt)', category: 'BLUFF', status: 'AVAILABLE' },
    });
    legacyId = legacy.id;

    // Raum + SetupDraft + Fragepaket an der LEGACY-Definition
    const room = await prisma.room.create({
      data: { code: '333-333', roomName: 'Coll Raum', gameDefinitionId: legacyId, hostUserId: hostId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE' },
    });
    const part = await prisma.participation.create({
      data: { roomId: room.id, displayName: 'Bob', normalizedName: 'bob', role: 'PLAYER', rejoinToken: 'coll-rt', connected: true, score: 99 },
    });
    await prisma.scoreEvent.create({ data: { roomId: room.id, participationId: part.id, roundIndex: 0, delta: 99, reason: 'x' } });
    await prisma.setupDraft.create({ data: { gameDefinitionId: legacyId, ownerId: hostId, configJson: '{}', contentJson: '{}' } });
    const pack = await prisma.questionPack.create({ data: { gameSlug: 'wer-luegt', title: 'Coll Pack', status: 'PUBLISHED' } });
    await prisma.geoQuestion.create({ data: { packId: pack.id, prompt: 'q', category: 'c', options: '[]', correctOptionId: 'a' } });
  });

  it('Kollision: kein Löschen, Kinder auf kanonisch umgebunden, Legacy HIDDEN+markiert', async () => {
    const before = await snapshot();
    const result = await runCanonicalSlugMigration(prisma);
    expect(result.applied).toBe(true);
    expect(result.mergedCollisions).toEqual(expect.arrayContaining([{ legacy: 'wer-luegt', canonical: 'imposter' }]));

    // Legacy-Definition bleibt existieren (ID stabil), ist aber HIDDEN
    const legacy = await prisma.gameDefinition.findUnique({ where: { id: legacyId } });
    expect(legacy!.status).toBe('HIDDEN');
    expect(legacy!.name).toContain('[slug-migrated]');

    // Raum + SetupDraft zeigen jetzt auf die KANONISCHE Definition
    const room = await prisma.room.findUnique({ where: { code: '333-333' } });
    expect(room!.gameDefinitionId).toBe(canonicalId);
    const setup = await prisma.setupDraft.findFirst({ where: { ownerId: hostId } });
    expect(setup!.gameDefinitionId).toBe(canonicalId);

    // Fragepaket umgebunden
    const pack = await prisma.questionPack.findFirst({ where: { title: 'Coll Pack' } });
    expect(pack!.gameSlug).toBe('imposter');

    // Datenintakt: Scores + Events + Raumstatus
    const part = await prisma.participation.findFirst({ where: { roomId: room!.id } });
    expect(part!.score).toBe(99);
    expect(await prisma.scoreEvent.count({ where: { roomId: room!.id } })).toBe(1);
    expect(room!.status).toBe('RUNNING');

    const after = await snapshot();
    // genau EIN neuer Audit-Eintrag für diesen Lauf
    expect(after.audits.length).toBe(before.audits.length + 1);
  });

  it('zweiter Lauf nach Kollision: No-op (Snapshot identisch, keine neue Audit-Zeile)', async () => {
    const before = await snapshot();
    const result = await runCanonicalSlugMigration(prisma);
    expect(result.applied).toBe(false);
    expect(result.changes).toBe(0);
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});

describe('Slug-Migration: bereits kanonische DB', () => {
  it('applied=false, keine Audit-Einträge, nichts verändert', async () => {
    // DB ist jetzt komplett kanonisch (Blöcke A + C migriert, Idempotenz-Check oben)
    const before = await snapshot();
    const result = await runCanonicalSlugMigration(prisma);
    expect(result.applied).toBe(false);
    const after = await snapshot();
    expect(after).toEqual(before);
  });
});

// ============================================================
// Regelwerk §5.23 "keine sichere Migration → alte Engine behalten" +
// §5.21 Recovery: Eine fehlgeschlagene Startmigration darf keinen
// behaupteten Legacy-Betrieb verdecken. Die Kompatibilität muss REAL sein:
// Autorisierung (authorizeGameContext) UND Timer-Restoration (P0-16) müssen
// einen bestehenden, laufenden Raum mit Legacy-Slug ("geo") weiter bedienen.
// ============================================================
describe('Migrationsfehler → laufender geo-Raum bleibt funktionsfähig (§5.21/§5.23)', () => {
  let httpServer: import('node:http').Server;
  let io: import('socket.io').Server;
  let legacyRoomId: string;
  const prevGlobalPrisma = (globalThis as { __prisma?: unknown }).__prisma;

  beforeAll(async () => {
    // access.ts / geo/index.ts nutzen das lazy Prisma-Singleton → Test-DB einbinden.
    (globalThis as { __prisma?: unknown }).__prisma = prisma;

    // Legacy-Definition "geo" (frei, da Block A sie zu wissensduell umbenannt hat)
    const legacyDef = await prisma.gameDefinition.create({
      data: { id: 'migfail-geo', slug: 'geo', name: 'Geo (legacy)', category: 'GEO', status: 'AVAILABLE' },
    });
    const host = await prisma.user.create({ data: { id: 'migfail-host', displayName: 'FailHost', passwordHash: 'x', role: 'MODERATOR' } });

    // LAUFENDER Raum mit Legacy-Slug + aktivem Timer (INPUT_OPEN, future timerEndMs)
    const room = await prisma.room.create({
      data: { code: '444-444', roomName: 'Legacy Running', gameDefinitionId: legacyDef.id, hostUserId: host.id, status: 'RUNNING', runPhase: 'ROUND_ACTIVE' },
    });
    legacyRoomId = room.id;
    const part = await prisma.participation.create({
      data: { roomId: room.id, displayName: 'Alice', normalizedName: 'alice', role: 'PLAYER', rejoinToken: 'migfail-rt', connected: true, ready: true },
    });
    await prisma.roomGameState.create({
      data: {
        roomId: room.id, engineVersion: 1, phase: 'INPUT_OPEN',
        stateJson: JSON.stringify({
          phase: 'INPUT_OPEN', currentRoundIndex: 0,
          questions: [{ correctOptionId: 'b' }],
          roundStates: { 0: { timerEndMs: Date.now() + 60000, timerStartMs: Date.now() - 5000, revealed: false } },
          scores: { [part.id]: 0 },
        }),
      },
    });

    // io-Server nur für die Timer-Restoration (keine realen Clients)
    httpServer = (await import('node:http')).createServer();
    io = new (await import('socket.io')).Server(httpServer);
  });

  afterAll(async () => {
    // Test-Hooks zurücksetzen, damit sie andere Tests nicht beeinflussen
    const { _resetSlugMigrationDegradedForTest, _setMigrationRunnerForTest } = await import('./canonicalSlugMigration.js');
    const { cancelGeoTimer } = await import('../games/geo/index.js');
    cancelGeoTimer(legacyRoomId);
    _resetSlugMigrationDegradedForTest();
    _setMigrationRunnerForTest(null);
    await new Promise<void>((r) => io.close(() => r()));
    if (httpServer?.listening) await new Promise<void>((r) => httpServer.close(() => r()));
    await prisma.$transaction(async (tx) => {
      await tx.roomGameState.deleteMany({ where: { roomId: legacyRoomId } });
      await tx.participation.deleteMany({ where: { roomId: legacyRoomId } });
      await tx.room.deleteMany({ where: { id: legacyRoomId } });
      await tx.gameDefinition.deleteMany({ where: { id: 'migfail-geo' } });
    }).catch(() => undefined);
    (globalThis as { __prisma?: unknown }).__prisma = prevGlobalPrisma;
  });

  it('Server fährt im degradierten Zustand weiter (kein throw, Flag=true)', async () => {
    const { _setMigrationRunnerForTest, _resetSlugMigrationDegradedForTest, migrateCanonicalSlugsOnStartup, isSlugMigrationDegraded } = await import('./canonicalSlugMigration.js');
    _resetSlugMigrationDegradedForTest();
    // Simuliert einen Migrationsfehler (z.B. korrumpierte DB / Constraint-Fehler)
    _setMigrationRunnerForTest(async () => { throw new Error('simulated migration failure'); });

    await expect(migrateCanonicalSlugsOnStartup(prisma)).resolves.toBeUndefined(); // kein throw
    expect(isSlugMigrationDegraded()).toBe(true); // Zustand wird exponiert, NICHT vertuscht
  });

  it('Timer-Restoration (P0-16) restauriert den Timer des laufenden Legacy-geo-Raums', async () => {
    const { __activeTimerRoomIdsForTest } = await import('../games/geo/index.js');
    await import('../games/geo/index.js').then((m) => m.restoreActiveTimers(io));
    expect(__activeTimerRoomIdsForTest()).toContain(legacyRoomId);
  });

  it('Autorisierung akzeptiert eine Geo-Action für den Legacy-geo-Raum (engineSlug=wissensduell)', async () => {
    const { authorizeGameContext } = await import('../games/core/access.js');
    const { roomChannel } = await import('../sockets/channel.js');
    const room = await prisma.room.findUniqueOrThrow({ where: { id: legacyRoomId } });
    const part = await prisma.participation.findFirstOrThrow({ where: { roomId: legacyRoomId, role: 'PLAYER' } });
    // Die Geo-Engine ruft authorizeGameContext mit resolveCanonicalSlug('geo')="wissensduell" auf.
    const socket = {
      data: { roomId: legacyRoomId, role: 'PLAYER', participationId: part.id, displayName: 'Alice' },
      rooms: new Set([roomChannel(legacyRoomId)]),
    } as unknown as import('socket.io').Socket;

    const result = await authorizeGameContext(socket, {
      roles: ['PLAYER'], requireParticipation: true,
      gameSlug: 'wissensduell', // = resolveCanonicalSlug('geo'), wie die Engine es übergibt
      requireRunning: true,
    });

    expect(result.ok, `Legacy-geo-Raum wurde abgelehnt: ${JSON.stringify(result)}`).toBe(true);
    void room;
  });
});

// ============================================================
// Regelwerk §5.23 (keine sichere Migration → alte Engine behalten) +
// §5.21/§5.22 (Recovery / Engine-Versionierung): Kollisionsfall mit einem
// REAL LAUFENDEN Raum, END-TO-END nach der Umbindung auf die kanonische
// Definition. Nachweis, dass eine sichere Fortsetzung beweisbar ist:
//   Rejoin → Resync → nächste Spielaktion → Timer → Ergebnis.
// Engine-Version und Setup bleiben unverändert; der Raum läuft über den
// stabilen roomId/roomCode und den (umgebundenen) gameDefinitionId.
// ============================================================
describe('Kollision mit LAUFENDEM Raum — sichere Fortsetzung e2e (§5.21/§5.23)', () => {
  let httpServer: import('node:http').Server;
  let io: import('socket.io').Server;
  let origin: string;
  const sockets: import('socket.io-client').Socket[] = [];

  let legacyDefId: string;
  let canonicalDefId: string;
  let hostId: string;
  let roomId: string;
  let roomCode: string;
  let playerId: string;
  let playerToken: string;
  let modToken: string;
  let modCookie: string;

  const prevGlobalPrisma = (globalThis as { __prisma?: unknown }).__prisma;

  function connect(cookie?: string) {
    return import('../test-socket-harness.js').then(({ connectGameClient }) =>
      connectGameClient(origin, cookie).then((s) => { sockets.push(s); return s; }),
    );
  }
  function ack(s: import('socket.io-client').Socket, ev: string, data: object = {}) {
    return import('../test-socket-harness.js').then(({ gameAck }) => gameAck(s, ev, data));
  }

  beforeAll(async () => {
    (globalThis as { __prisma?: unknown }).__prisma = prisma;

    const canonical = await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'wissensduell' } });
    canonicalDefId = canonical.id;
    // Neue Legacy-Definition "geo" (Slug nach Block A wieder frei) → Kollision
    const legacy = await prisma.gameDefinition.create({
      data: { id: 'colllive-geo', slug: 'geo', name: 'Geo (Alt)', category: 'GEO', status: 'AVAILABLE' },
    });
    legacyDefId = legacy.id;

    const { randomUUID } = await import('node:crypto');
    const host = await prisma.user.create({ data: { id: 'colllive-host', displayName: 'CollLive Host', passwordHash: 'x', role: 'MODERATOR' } });
    hostId = host.id;

    roomCode = '555-555';
    const room = await prisma.room.create({
      data: { code: roomCode, roomName: 'Coll Live', gameDefinitionId: legacyDefId, hostUserId: hostId, status: 'RUNNING', runPhase: 'ROUND_ACTIVE' },
    });
    roomId = room.id;

    // Fragepaket (legacy Slug "geo") + echte Frage
    const pack = await prisma.questionPack.create({ data: { gameSlug: 'geo', title: 'CollLive Pack', status: 'PUBLISHED' } });
    await prisma.geoQuestion.create({
      data: { packId: pack.id, prompt: 'Hauptstadt von Frankreich?', category: 'Geo', options: JSON.stringify([{ id: 'a', text: 'London' }, { id: 'b', text: 'Paris' }]), correctOptionId: 'b', points: 100, wrongPoints: 0, enabled: true },
    });

    // Moderator + Spieler
    const mod = await prisma.participation.create({ data: { roomId, role: 'MODERATOR', displayName: 'Host', normalizedName: 'host', rejoinToken: `colllive-mod-${randomUUID()}`, connected: true, ready: true } });
    modToken = mod.rejoinToken;
    const player = await prisma.participation.create({ data: { roomId, role: 'PLAYER', displayName: 'Alice', normalizedName: 'alice', rejoinToken: `colllive-rt-${randomUUID()}`, connected: true, ready: true } });
    playerId = player.id;
    playerToken = player.rejoinToken;

    // Host-Session (für Moderator-Rejoin)
    const { createSessionCookie } = await import('../auth/session.js');
    const { config } = await import('../config/index.js');
    const session = await prisma.session.create({ data: { id: `colllive-sess-${randomUUID()}`, userId: hostId, expiresAt: new Date(Date.now() + 60000) } });
    modCookie = createSessionCookie(session.id, config.sessionSecret);

    // Realistischer Geo-Game-States (INPUT_OPEN, Zukunft-Timer) — so wie ihn
    // initialize()/startRound() schreiben würden. Setup: questionPoolId.
    const setupSnapshot = JSON.stringify({ questionPoolId: pack.id, questionCount: 1, timerDuration: 60 });
    await prisma.room.update({ where: { id: roomId }, data: { setupSnapshotJson: setupSnapshot } });
    const now = Date.now();
    const state = {
      phase: 'INPUT_OPEN',
      currentRoundIndex: 0,
      questions: [{ id: 'collq-1', prompt: 'Hauptstadt von Frankreich?', category: 'Geo', options: JSON.stringify([{ id: 'a', text: 'London' }, { id: 'b', text: 'Paris' }]), correctOptionId: 'b', points: 100, wrongPoints: 0 }],
      roundStates: {
        0: {
          questionIndex: 0,
          question: { id: 'collq-1', prompt: 'Hauptstadt von Frankreich?', category: 'Geo', options: [{ id: 'a', text: 'London' }, { id: 'b', text: 'Paris' }] },
          revealed: false,
          timerStartMs: now - 5000,
          timerEndMs: now + 60000,
          pauseRemainingMs: null,
          playerStates: { [playerId]: { answered: false, selectedOptionId: null, locked: false, score: 0, eliminatedOptions: [], jokers: { used5050: false, usedSpy: false, usedRisk: false } } },
          answers: {},
        },
      },
      scores: { [playerId]: 0 },
    };
    await prisma.roomGameState.create({ data: { roomId, engineVersion: 1, phase: 'INPUT_OPEN', stateJson: JSON.stringify(state) } });

    // Echter Socket-Server (setupSocketHandlers) für den e2e-Nachweis
    httpServer = (await import('node:http')).createServer();
    io = new (await import('socket.io')).Server(httpServer, { cors: { origin: '*' } });
    const { setupSocketHandlers } = await import('../sockets/index.js');
    setupSocketHandlers(io);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await new Promise<void>((r) => io.close(() => r()));
    if (httpServer?.listening) await new Promise<void>((r) => httpServer.close(() => r()));
    await prisma.$transaction(async (tx) => {
      await tx.roomGameState.deleteMany({ where: { roomId } });
      await tx.scoreEvent.deleteMany({ where: { roomId } });
      await tx.participation.deleteMany({ where: { roomId } });
      await tx.room.deleteMany({ where: { id: roomId } });
      await tx.geoQuestion.deleteMany({ where: { prompt: 'Hauptstadt von Frankreich?' } });
      await tx.questionPack.deleteMany({ where: { title: 'CollLive Pack' } });
      await tx.gameDefinition.deleteMany({ where: { id: 'colllive-geo' } });
      await tx.session.deleteMany({ where: { userId: hostId } });
    }).catch(() => undefined);
    (globalThis as { __prisma?: unknown }).__prisma = prevGlobalPrisma;
  });

  it('Kollisions-Migration bindet den laufenden Raum auf die kanonische Definition um (kein Löschen)', async () => {
    const result = await runCanonicalSlugMigration(prisma);
    expect(result.mergedCollisions).toEqual(expect.arrayContaining([{ legacy: 'geo', canonical: 'wissensduell' }]));
    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.gameDefinitionId).toBe(canonicalDefId); // Raum jetzt an KANONISCH
    expect(room.status).toBe('RUNNING'); // Status bleibt RUNNING
    const legacy = await prisma.gameDefinition.findUnique({ where: { id: legacyDefId } });
    expect(legacy?.status).toBe('HIDDEN'); // Legacy erhalten, nicht gelöscht
  });

  it('e2e nach Umbinden: Rejoin + Resync + Spielaktion + Timer + Ergebnis', async () => {
    // ── 1. REJOIN: Spieler verbindet sich per rejoinToken ──
    const alice = await connect();
    const rejoin = await ack(alice, 'room:subscribe', { roomCode, rejoinToken: playerToken });
    expect(rejoin.success, `Rejoin nach Umbinden fehlgeschlagen: ${JSON.stringify(rejoin)}`).toBe(true);

    // ── 2. RESYNC: Spieler erhält seinen State (Phase + Score) ──
    const resync = await ack(alice, 'geo:resync');
    expect(resync.success, `Resync nach Umbinden fehlgeschlagen: ${JSON.stringify(resync)}`).toBe(true);
    expect(resync.phase).toBe('INPUT_OPEN');
    expect((resync.scores as Record<string, number>)[playerId]).toBe(0);

    // ── 3. TIMER: Timer-Restoration restauriert den aktiven Timer des Raums ──
    const geo = await import('../games/geo/index.js');
    await geo.restoreActiveTimers(io);
    expect(geo.__activeTimerRoomIdsForTest(), 'Timer des umgebundenen Raums nicht restauriert').toContain(roomId);

    // ── 4. NÄCHSTE SPIELAKTION: Spieler antwortet auf die laufende Frage ──
    const answer = await ack(alice, 'geo:answer', { optionId: 'b' });
    expect(answer.success, `Spielaktion nach Umbinden fehlgeschlagen: ${JSON.stringify(answer)}`).toBe(true);

    // ── 5. ERGEBNIS: Moderator (via Host-Session) löst die Runde auf ──
    const mod = await connect(modCookie);
    const modRejoin = await ack(mod, 'room:subscribe', { roomCode, rejoinToken: modToken, moderatorToken: modToken });
    expect(modRejoin.success, `Moderator-Rejoin fehlgeschlagen: ${JSON.stringify(modRejoin)}`).toBe(true);
    const reveal = await ack(mod, 'geo:reveal', { roomCode });
    expect(reveal.success, `Reveal nach Umbinden fehlgeschlagen: ${JSON.stringify(reveal)}`).toBe(true);

    // Ergebnis nachgewiesen: Score + ScoreEvent + Phase + runPhase
    const part = await prisma.participation.findUniqueOrThrow({ where: { id: playerId } });
    expect(part.score).toBe(100);
    const events = await prisma.scoreEvent.findMany({ where: { roomId } });
    expect(events.some((e) => e.participationId === playerId && e.delta === 100)).toBe(true);
    const stateRow = await prisma.roomGameState.findUniqueOrThrow({ where: { roomId } });
    expect(stateRow.phase).toBe('REVEAL');
    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.runPhase).toBe('REVEAL');
  });
});
