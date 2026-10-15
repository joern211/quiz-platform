// ============================================================
// BASIS-STANDARDS — Abnahme A4: Sichere Bestandsmigration
// User.role / Participation.role (MODERATOR → HOST)
// ============================================================
// Wirkt mit einer echten "Bestandskopie": in das fertige Schema werden
// Legacy-Zeilen mit MODERATOR/ADMIN/PLAYER/VIEWER/UNKNOWN geschrieben (wie
// ein Bestand vor der Migration), dann werden die Migration-UPDATEs aus der
// realen Migration 20261010120000 ausgeführt und die Invarianten geprüft:
//   1. MODERATOR → HOST (User + Participation)
//   2. ADMIN bleibt ADMIN
//   3. PLAYER/VIEWER/DISPLAY bleiben unverändert
//   4. Unbekannte Rolle (SUPERUSER) bleibt als-is (kein String-Cast)
//   5. Wiederholte Ausführung = No-op (idempotent)
//   6. IDs, Rejoin-Tokens, Scores, Raum-/Spielreferenzen bleiben erhalten
//      → Rejoin eines laufenden Raums bleibt funktionsfähig.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm as rmAsync, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createTestDatabase } from '../test-helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..', '..', '..');
const BASIS_MIGRATION = 'prisma/migrations/20261010120000_basis_standards_roles_config_receipts/migration.sql';

/** Nur die rollenbezogenen UPDATE-Anweisungen der realen Migration extrahieren. */
async function basisRoleUpdateStatements(): Promise<string[]> {
  const sql = await readFile(join(repositoryRoot, BASIS_MIGRATION), 'utf8');
  return sql
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^UPDATE\s+"?(users|participations)"?\s+SET\s+"?role"?\s*=\s*'HOST'\s+WHERE/i.test(l));
}

let dbPath: string;
let prisma: PrismaClient;

beforeAll(async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'quiz-roles-mig-'));
  dbPath = join(tmpDir, 'test.db');
  await createTestDatabase(`file:${dbPath}`);
  prisma = new PrismaClient({ datasourceUrl: `file:${dbPath}` });
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  await rmAsync(dbPath, { recursive: true, force: true, maxRetries: 3 });
});

describe('A4: Bestandsmigration MODERATOR→HOST (sichere Fortsetzung)', () => {
  let hostUserId: string;
  let adminUserId: string;
  let unknownUserId: string;
  let roomId: string;
  let hostPartId: string;
  let playerPartId: string;
  let unknownPartId: string;

  beforeAll(async () => {
    // "Bestandskopie": Legacy-Rollenwerte direkt ins fertige Schema.
    adminUserId = (await prisma.user.create({
      data: { id: 'u-admin', displayName: 'Admin', passwordHash: 'x', role: 'ADMIN' },
    })).id;
    hostUserId = (await prisma.user.create({
      data: { id: 'u-mod', displayName: 'Mig Host', passwordHash: 'x', role: 'MODERATOR' },
    })).id;
    unknownUserId = (await prisma.user.create({
      data: { id: 'u-super', displayName: 'Super', passwordHash: 'x', role: 'SUPERUSER' },
    })).id;

    const gameDef = await prisma.gameDefinition.upsert({
      where: { slug: 'geo' },
      update: {},
      create: {
        slug: 'geo',
        name: 'Wissensduell (Geo)',
        category: 'Knowledge',
        status: 'AVAILABLE',
        minPlayers: 2,
        maxPlayers: 10,
        engineVersion: 3,
      },
    });

    const room = await prisma.room.create({
      data: {
        code: 'ROLES123',
        roomName: 'Bestands-Raum',
        gameDefinitionId: gameDef.id,
        hostUserId,
        status: 'RUNNING',
        runPhase: 'ROUND_ACTIVE',
      },
    });
    roomId = room.id;

    const pHost = await prisma.participation.create({
      data: { roomId, displayName: 'Host', normalizedName: 'host', role: 'MODERATOR', rejoinToken: 'rt-host-42', connected: true, score: 123 },
    });
    hostPartId = pHost.id;
    const pPlayer = await prisma.participation.create({
      data: { roomId, displayName: 'Alice', normalizedName: 'alice', role: 'PLAYER', rejoinToken: 'rt-alice', connected: true, score: 7 },
    });
    playerPartId = pPlayer.id;
    const pSuper = await prisma.participation.create({
      data: { roomId, displayName: 'Weird', normalizedName: 'weird', role: 'SUPERUSER', rejoinToken: 'rt-weird', connected: false },
    });
    unknownPartId = pSuper.id;

    // Session des Hosts (Rejoin-Aufwand bleibt referenziert).
    await prisma.session.create({
      data: { id: 'sess-host', userId: hostUserId, expiresAt: new Date(Date.now() + 60000) },
    });

    await prisma.roomGameState.create({
      data: { roomId, engineVersion: 3, phase: 'INPUT_OPEN', stateJson: JSON.stringify({ phase: 'INPUT_OPEN', currentRoundIndex: 0 }) },
    });
  });

  it('1) MODERATOR → HOST in User.role und Participation.role', async () => {
    const stmts = await basisRoleUpdateStatements();
    expect(stmts.length).toBe(2);
    for (const s of stmts) await prisma.$executeRawUnsafe(s);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: hostUserId } });
    expect(user.role).toBe('HOST');
    const part = await prisma.participation.findUniqueOrThrow({ where: { id: hostPartId } });
    expect(part.role).toBe('HOST');
  });

  it('2) ADMIN bleibt ADMIN (kein Umbenennen)', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } });
    expect(admin.role).toBe('ADMIN');
  });

  it('3) PLAYER/VIEWER/DISPLAY bleiben unverändert', async () => {
    const player = await prisma.participation.findUniqueOrThrow({ where: { id: playerPartId } });
    expect(player.role).toBe('PLAYER');
  });

  it('4) Unbekannte Rolle (SUPERUSER) bleibt als-is — kein String-Cast', async () => {
    const superUser = await prisma.user.findUniqueOrThrow({ where: { id: unknownUserId } });
    expect(superUser.role).toBe('SUPERUSER');
    const superPart = await prisma.participation.findUniqueOrThrow({ where: { id: unknownPartId } });
    expect(superPart.role).toBe('SUPERUSER');
  });

  it('5) Wiederholte Ausführung ist ein No-op (idempotent)', async () => {
    const stmts = await basisRoleUpdateStatements();
    const before = await prisma.$queryRawUnsafe<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM participations WHERE role = \'HOST\'');
    for (const s of stmts) await prisma.$executeRawUnsafe(s);
    const after = await prisma.$queryRawUnsafe<Array<{ c: number }>>('SELECT COUNT(*) AS c FROM participations WHERE role = \'HOST\'');
    expect(after[0].c).toBe(before[0].c);
    // Kein zweiter Wert hat sich "verschoben".
    const superPart = await prisma.participation.findUniqueOrThrow({ where: { id: unknownPartId } });
    expect(superPart.role).toBe('SUPERUSER');
  });

  it('6) IDs, Rejoin-Tokens, Scores und Raum-Referenzen bleiben erhalten → Rejoin funktionsfähig', async () => {
    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.id).toBe(roomId);
    expect(room.code).toBe('ROLES123');
    expect(room.hostUserId).toBe(hostUserId);

    const hostPart = await prisma.participation.findUniqueOrThrow({ where: { id: hostPartId } });
    expect(hostPart.rejoinToken).toBe('rt-host-42');
    expect(hostPart.score).toBe(123);
    expect(hostPart.roomId).toBe(roomId);

    // Rejoin-Fähigkeit: der laufende Raum hat State + Token + neue Rolle.
    const state = await prisma.roomGameState.findUniqueOrThrow({ where: { roomId } });
    expect(state.phase).toBe('INPUT_OPEN');
    const session = await prisma.session.findUniqueOrThrow({ where: { id: 'sess-host' } });
    expect(session.userId).toBe(hostUserId);
  });

  it('A6: DISPLAY-Rolle ist read-only/public-Vertrag (kein Gameplay-Slot)', async () => {
    // DISPLAY ist eine kanonische, aber read-only Projektionsrolle: keine
    // Eingabe-, keine Verwaltungs-, keine Secret-Rechte aus dem Default-Paket.
    const { PLATFORM_ROLES, effectivePermissions, hasPermission } = await import('@quiz/shared');
    expect(PLATFORM_ROLES).toContain('DISPLAY');
    const perms = effectivePermissions('DISPLAY', [], []);
    expect(hasPermission(perms, 'BUZZER_CONTROL')).toBe(false);
    expect(hasPermission(perms, 'GAME_START')).toBe(false);
    expect(hasPermission(perms, 'REVEAL_CONTENT')).toBe(false);
  });

  it('A5: Legacy-Normalisierung nur an der klaren Grenze (MODERATOR→HOST, unbekannt→null)', async () => {
    const { normalizeRole, LEGACY_ROLE_VALUES } = await import('@quiz/shared');
    // Kanonische Werte bleiben, Legacy wird NUR an dieser Grenze geschrieben.
    expect(normalizeRole('MODERATOR')).toBe('HOST');
    expect(normalizeRole('ADMIN')).toBe('ADMIN');
    expect(normalizeRole('PLAYER')).toBe('PLAYER');
    expect(normalizeRole('DISPLAY')).toBe('DISPLAY');
    // Unbekannt → null (kein String-Cast, kein stilleres "Berichtigen").
    expect(normalizeRole('SUPERUSER')).toBe(null);
    expect(normalizeRole('')).toBe(null);
    // Die Legacy-Map ist explizit und klein (kein generischer Fallback).
    expect(LEGACY_ROLE_VALUES).toEqual({ MODERATOR: 'HOST' });
  });
});
