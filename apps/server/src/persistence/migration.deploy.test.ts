// ============================================================
// Audit PR14, 14-08 — SICHERE BESTANDSMIGRATION per ECHTEM
// "prisma migrate deploy" (nicht: UPDATEs auf dem fertigen Schema).
//
// Das Audit (14-08) bemängelte, dass migration.roles.test.ts nur zwei
// extrahierte UPDATE-Statements auf dem bereits fertigen Schema ausführt —
// kein "migrate deploy" auf einer repräsentativen DB VOR der Migration,
// kein echter Rejoin von WID-v1/v2. Dieser Test schließt genau das:
//
//   Phase 0  Repräsentative DB im BASIS-Migrationsstand: nur die 5
//            Basismigrationen (vor BASIS-STANDARDS) per echtem
//            "prisma migrate deploy" angewendet → DB OHNE
//            room_permission_grants / command_receipts /
//            configSchemaVersion / beforeRevision / leaseExpiresAt.
//   Phase 1  In diese BASIS-DB werden echte Bestandsdaten per RAW SQL
//            geschrieben (exakt das Basisschema, mit Legacy-Rolle
//            MODERATOR): zwei laufende WID-Räume (setupSchemaVersion 1
//            UND 2, engineVersion 1 UND 2), Sessions, Medien-Assets,
//            Punkte, Rejoin-Tokens.
//   Phase 2  Die beiden PR14-Migrationen (20261010120000 +
//            20261013120000) werden per ECHTEM "migrate deploy" auf
//            dieselbe DB gespielt (nicht neu aufgebaut!).
//   Phase 3  "migrate deploy" WIEDER → No-op (Idempotenz).
//   Phase 4  Vergleich: alle 7 Migrations angewendet, neue
//            Tabellen/Spalten vorhanden, Rollen konvertiert
//            (MODERATOR→HOST, ADMIN bleibt, SUPERUSER as-is), und
//            IDs/Referenzen/Versionen/Punkte/Rejoin-Tokens
//            UNVERÄNDERT (kein Datenverlust).
//   Phase 5  ECHTER Prozess-Start (node src/server.ts) auf der
//            migrierten DB → echte alte Session + WID-v1- UND
//            WID-v2-Rejoin überleben die Migration: Phase, Bild,
//            Punkte, Buzz-Rechte, Geheimhaltung, beenden.
//
// RAW SQL über Prisma $queryRawUnsafe/$executeRawUnsafe (statt node:sqlite,
// das Vite nicht transformiert): Bestandsdaten tragen EXAKT das Basisschema
// (ohne die PR14-Spalten); Introspektion (sqlite_master/PRAGMA) via Raw.
// Historische Ergebnisse (migration.roles.test.ts) bleiben UNVERÄNDERT —
// dieser Test ergänzt den verlangten deploy-Nachweis, er ersetzt nichts.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, cp, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createSessionCookie } from '../auth/session.js';
import { connectGameClient, gameAck } from '../test-socket-harness.js';
import type { Socket as ClientSocket } from 'socket.io-client';

const ack = gameAck;
const here = dirname(fileURLToPath(import.meta.url)); // apps/server/src/persistence
const serverRoot = resolve(here, '..', '..'); // apps/server
const repoRoot = resolve(serverRoot, '..', '..'); // repo root
const SERVER_ENTRY = resolve(serverRoot, 'src/server.ts');
const MIGRATIONS_DIR = join(repoRoot, 'prisma', 'migrations');
const SCHEMA_PATH = join(repoRoot, 'prisma', 'schema.prisma');
const PRISMA_CLI = join(serverRoot, 'node_modules', 'prisma', 'build', 'index.js');

// 5 Basismigrationen (vor BASIS-STANDARDS) — der "Basis-Migrationsstand".
const BASE_MIGRATIONS = [
  '20260917213827_init',
  '20260920041715_init',
  '20261005211743_add_media_derived_from_and_process_status',
  '20261007214818_media_sha256_owner_scoped',
  '20261008183000_audit_p1_logical_asset_identity_and_room_idempotency',
];
// All PR14 migrations, including the audit receipt recovery fields.
const PR14_MIGRATIONS = [
  '20261010120000_basis_standards_roles_config_receipts',
  '20261013120000_receipt_before_revision_and_lease',
  '20261016130000_receipt_before_state_revision',
  '20261020110000_command_execution_fence',
  '20261020114000_participation_connection_owner',
  '20261023190000_team_room',
];

const SESSION_SECRET = 'ci-test-secret-at-least-32-chars-long';
const SECRET_NAME = 'UNIQUE_PRIVATE_PERSON_MIG1408';
const MOD_USER_ID = 'u-mod-mig';
const ADMIN_USER_ID = 'u-admin-mig';
const SUPER_USER_ID = 'u-super-mig';

let tmpRoot: string;
let stagedDir: string; // staged schema + migrations
let dbUrl: string;
let prisma: PrismaClient;
let port: number;
let proc: ChildProcess | null = null;
let procStderr = '';
const sockets: ClientSocket[] = [];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const origin = () => `http://127.0.0.1:${port}`;

function serverEnv() {
  return {
    ...process.env, NODE_ENV: 'development', PORT: String(port),
    DATABASE_URL: dbUrl, SESSION_SECRET, LOG_LEVEL: 'debug',
    PATH: process.env.PATH ?? '',
  };
}

async function healthOk(): Promise<boolean> {
  try { const r = await fetch(`${origin()}/api/v1/health`); return r.ok; } catch { return false; }
}
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 30000, step = 250): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await cond()) return; await sleep(step); }
  throw new Error(`waitFor timeout nach ${timeoutMs}ms. Server-Stderr:\n${procStderr.slice(-4000)}`);
}

/** Echter "prisma migrate deploy" als Subprozess gegen die gestufte Migrations-Dir. */
function runMigrateDeploy(): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    execFile(
      process.execPath,
      [PRISMA_CLI, 'migrate', 'deploy', '--schema', join(stagedDir, 'schema.prisma')],
      { cwd: stagedDir, env: { ...process.env, DATABASE_URL: dbUrl, PATH: process.env.PATH ?? '' } },
      (error, stdout, stderr) => {
        if (error) rejectP(new Error(`migrate deploy failed: ${stderr || error.message}\n${stdout}`));
        else resolveP({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function stageMigration(migration: string, targetDir: string) {
  await cp(join(MIGRATIONS_DIR, migration), join(targetDir, migration), { recursive: true });
}

// ── WID-State-Form (identisch zu recovery.integration.test.ts) ──────────
function midGameState(aliceId: string, bobId: string) {
  return {
    phase: 'ROUND_READY', roundIndex: 0, roundCount: 2,
    scores: { [aliceId]: -1, [bobId]: 0 },
    playerNames: { [aliceId]: 'Alice', [bobId]: 'Bob' },
    buzzer: { open: false, winnerId: null, excludedPlayerIds: [aliceId] },
    hintActive: false, playedRoundIds: [], solvedBy: null, lastDelta: -1, revealed: false,
  };
}

const ROOMS = {
  v1: { roomId: 'room-mig-v1', code: '421-001', aliceId: 'part-mig-a-1', bobId: 'part-mig-b-1', hostPartId: 'part-mig-h-1' },
  v2: { roomId: 'room-mig-v2', code: '421-002', aliceId: 'part-mig-a-2', bobId: 'part-mig-b-2', hostPartId: 'part-mig-h-2' },
};
// Die WID-Setup-Schema validiert Asset-IDs als UUID (Zod) → echte UUIDs.
const MEDIA: { imgV1: string; origA: string; origB: string; compV2: string } = {
  imgV1: crypto.randomUUID(), origA: crypto.randomUUID(), origB: crypto.randomUUID(), compV2: crypto.randomUUID(),
};

// RAW-SQL-Shortcuts über den verbundenen Client (bypass das generierte Modell).
const ex = (sql: string, ...args: unknown[]) => prisma.$executeRawUnsafe(sql, ...args);
const qy = <T,>(sql: string, ...args: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...args);
const one = async <T,>(sql: string, ...args: unknown[]): Promise<T> => (await qy<T>(sql, ...args))[0];

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'quiz-mig-deploy-'));
  dbUrl = `file:${join(tmpRoot, 'deploy.db')}`;
  stagedDir = join(tmpRoot, 'staged');
  await mkdir(join(stagedDir, 'migrations'), { recursive: true });
  await copyFile(SCHEMA_PATH, join(stagedDir, 'schema.prisma'));
  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();

  // ── Phase 0: repräsentative BASIS-DB (nur die 5 Basismigrationen) ─────
  for (const m of BASE_MIGRATIONS) await stageMigration(m, join(stagedDir, 'migrations'));
  await runMigrateDeploy(); // 5 Migrations → fertiges Basisschema
  {
    const tables = new Set((await qy<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map(t => t.name));
    // Beweis: die PR14-Objekte existieren in der Basis-DB NICHT.
    expect(tables.has('room_permission_grants')).toBe(false);
    expect(tables.has('command_receipts')).toBe(false);
    const roomCols = new Set((await qy<{ name: string }>('PRAGMA table_info(rooms)')).map(c => c.name));
    expect(roomCols.has('configSchemaVersion')).toBe(false);
    expect(roomCols.has('gameConfigSnapshotJson')).toBe(false);
  }

  // ── Phase 1: echte Bestandsdaten im BASISSchema (RAW SQL) ─────────────
  await seedBaseState();

  // ── Phase 2: PR14-Migrationen per echtem deploy auf dieselbe DB ──────
  for (const m of PR14_MIGRATIONS) await stageMigration(m, join(stagedDir, 'migrations'));
  const deploy1 = await runMigrateDeploy();
  expect(deploy1.stdout + deploy1.stderr).toMatch(/20261010120000_basis_standards_roles_config_receipts/);
  expect(deploy1.stdout + deploy1.stderr).toMatch(/20261013120000_receipt_before_revision_and_lease/);
  expect(deploy1.stdout + deploy1.stderr).toMatch(/20261016130000_receipt_before_state_revision/);
  const receiptColumns = await qy<{ name: string }>('PRAGMA table_info(command_receipts)');
  expect(receiptColumns.map(column => column.name)).toContain('beforeStateRevision');

  // ── Phase 3: deploy WIEDER → No-op (Idempotenz) ──────────────────────
  const deploy2 = await runMigrateDeploy();
  expect(deploy2.stdout + deploy2.stderr).toMatch(/No pending migrations to apply/i);

  // ── Phase 4: Vergleich IDs/Referenzen/Versionen/Daten ────────────────
  await assertDataPreserved();

  // ── Phase 5: echter Prozess-Start + WID-v1/v2-Rejoin ─────────────────
  port = 42300 + Math.floor(Math.random() * 400);
  procStderr = '';
  proc = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: serverRoot, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', d => { procStderr += String(d); });
  await waitFor(healthOk, 60000);
}, 180000);

afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch { /* */ } }
  if (proc && !proc.killed) { try { proc.kill('SIGKILL'); } catch { /* */ } }
  await prisma.$disconnect().catch(() => {});
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

// Bestandsdaten im Basisschema schreiben (RAW SQL → exakt die Basis-Spalten).
async function seedBaseState() {
  const now = new Date().toISOString();

  // Nutzer (einer mit Legacy-Rolle MODERATOR, einer ADMIN, einer UNKNOWN).
  await ex('INSERT INTO users (id, displayName, passwordHash, role, updatedAt) VALUES (?,?,?,?,?)',
    MOD_USER_ID, 'Mig Host', 'x', 'MODERATOR', now);
  await ex('INSERT INTO users (id, displayName, passwordHash, role, updatedAt) VALUES (?,?,?,?,?)',
    ADMIN_USER_ID, 'Mig Admin', 'x', 'ADMIN', now);
  await ex('INSERT INTO users (id, displayName, passwordHash, role, updatedAt) VALUES (?,?,?,?,?)',
    SUPER_USER_ID, 'Mig Super', 'x', 'SUPERUSER', now);

  // Session des Hosts (alte Session — muss nach der Migration weiterreichen).
  await ex('INSERT INTO sessions (id, userId, expiresAt) VALUES (?,?,?)',
    'sess-mig-host', MOD_USER_ID, new Date(Date.now() + 24 * 3600 * 1000).toISOString());

  // WID-GameDefinition (kanonischer Slug, BETA wie Seed/Manifest).
  await ex('INSERT INTO game_definitions (id, slug, name, category, status, minPlayers, maxPlayers, estimatedMinutes, hasBuzzer, hasTeams, hasCamera, hasAudio, hasTimer, tags, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'gd-wid-mig', 'wer-ist-das', 'Wer ist das?', 'buzzer-reaktion', 'BETA', 2, 10, 15, 1, 0, 0, 0, 0, '[]', now);

  // Medien-Assets (echte Zeilen; Dateien werden im Rejoin-Pfad nicht gelesen).
  const asset = (id: string, mime: string, fn: string, sha: string, visibility: string = 'PRIVATE', derived: string | null = null) =>
    ex('INSERT INTO media_assets (id, type, mimeType, filename, originalName, fileSize, sha256, storagePath, uploadedBy, visibility, derivedFromAssetIds, processStatus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, 'image', mime, fn, fn, 12, sha, `/tmp/${fn}`, MOD_USER_ID, visibility, derived, 'READY');
  await asset(MEDIA.imgV1, 'image/png', 'v1.png', 'h-v1');
  await asset(MEDIA.origA, 'image/png', 'a.png', 'h-a');
  await asset(MEDIA.origB, 'image/png', 'b.png', 'h-b');
  await asset(MEDIA.compV2, 'image/webp', 'comp.webp', 'h-c', 'ROOM_TEMP', JSON.stringify([MEDIA.origA, MEDIA.origB]));

  const mkRoom = async (r: typeof ROOMS.v1, setupVersion: 1 | 2, engineVersion: number, gameImageAssetId: string, originalAssetIds: string[]) => {
    const roundOne = setupVersion === 1
      ? { id: 'one', imageAssetId: gameImageAssetId, person1: SECRET_NAME, person2: 'Second', setupVersion: 1 }
      : { id: 'one', personAImageAssetId: originalAssetIds[0], personBImageAssetId: originalAssetIds[1], gameImageAssetId, personAName: SECRET_NAME, personBName: 'Second', setupVersion: 2 };
    const roundTwo = setupVersion === 1
      ? { id: 'two', imageAssetId: gameImageAssetId, person1: 'Third', person2: 'Fourth', setupVersion: 1 }
      : { id: 'two', personAImageAssetId: originalAssetIds[0], personBImageAssetId: originalAssetIds[1], gameImageAssetId, personAName: 'Third', personBName: 'Fourth', setupVersion: 2 };
    const setupSnapshot = JSON.stringify({ setupSchemaVersion: setupVersion, rounds: [roundOne, roundTwo] });
    const state = midGameState(r.aliceId, r.bobId);
    await ex('INSERT INTO rooms (id, code, roomName, gameDefinitionId, hostUserId, status, runPhase, setupSnapshotJson, setupSchemaVersion, viewerRequiresPin) VALUES (?,?,?,?,?,?,?,?,?,?)',
      r.roomId, r.code, `Mig WID v${setupVersion}`, 'gd-wid-mig', MOD_USER_ID, 'RUNNING', 'ROUND_ACTIVE', setupSnapshot, setupVersion, 0);
    // Host-Participation mit Legacy-Rolle MODERATOR (wird zur Migration HOST).
    await ex('INSERT INTO participations (id, roomId, displayName, normalizedName, role, rejoinToken, connected, ready, score) VALUES (?,?,?,?,?,?,?,?,?)',
      r.hostPartId, r.roomId, `Host v${setupVersion}`, `host-mig-v${setupVersion}`, 'MODERATOR', `rt-mig-h-${setupVersion}`, 1, 1, 0);
    await ex('INSERT INTO participations (id, roomId, displayName, normalizedName, role, rejoinToken, connected, ready, score) VALUES (?,?,?,?,?,?,?,?,?)',
      r.aliceId, r.roomId, 'Alice', `alice-mig-v${setupVersion}`, 'PLAYER', `rt-mig-a-${setupVersion}`, 1, 1, -1);
    await ex('INSERT INTO participations (id, roomId, displayName, normalizedName, role, rejoinToken, connected, ready, score) VALUES (?,?,?,?,?,?,?,?,?)',
      r.bobId, r.roomId, 'Bob', `bob-mig-v${setupVersion}`, 'PLAYER', `rt-mig-b-${setupVersion}`, 1, 1, 0);
    await ex('INSERT INTO room_game_states (id, roomId, engineVersion, phase, stateJson, revision, updatedAt) VALUES (?,?,?,?,?,?,?)',
      `rgs-${r.roomId}`, r.roomId, engineVersion, state.phase, JSON.stringify(state), 1, now);
  };
  await mkRoom(ROOMS.v1, 1, 1, MEDIA.imgV1, []);
  await mkRoom(ROOMS.v2, 2, 2, MEDIA.compV2, [MEDIA.origA, MEDIA.origB]);
}

// IDs/Referenzen/Versionen/Punkte überleben den deploy unverändert.
async function assertDataPreserved() {
  // All staged migrations applied, including audit follow-ups.
  const applied = (await qy<{ n: string }>('SELECT migration_name AS n FROM _prisma_migrations')).map(r => r.n);
  expect(applied.length).toBe(BASE_MIGRATIONS.length + PR14_MIGRATIONS.length);
  for (const m of [...BASE_MIGRATIONS, ...PR14_MIGRATIONS]) expect(applied).toContain(m);

  // Neue Objekte existieren NACH dem deploy.
  const tables = new Set((await qy<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map(r => r.name));
  expect(tables.has('room_permission_grants')).toBe(true);
  expect(tables.has('command_receipts')).toBe(true);
  const roomCols = new Set((await qy<{ name: string }>('PRAGMA table_info(rooms)')).map(c => c.name));
  expect(roomCols.has('configSchemaVersion')).toBe(true);
  expect(roomCols.has('gameConfigSnapshotJson')).toBe(true);
  expect(roomCols.has('liveConfigJson')).toBe(true);
  const crCols = new Set((await qy<{ name: string }>('PRAGMA table_info(command_receipts)')).map(c => c.name));
  expect(crCols.has('beforeRevision')).toBe(true);
  expect(crCols.has('leaseExpiresAt')).toBe(true);

  // Rollen: MODERATOR→HOST (User + Participation), ADMIN bleibt, SUPERUSER as-is.
  expect((await one<{ role: string }>('SELECT role FROM users WHERE id=?', MOD_USER_ID)).role).toBe('HOST');
  expect((await one<{ role: string }>('SELECT role FROM users WHERE id=?', ADMIN_USER_ID)).role).toBe('ADMIN');
  expect((await one<{ role: string }>('SELECT role FROM users WHERE id=?', SUPER_USER_ID)).role).toBe('SUPERUSER');
  const hostParts = await qy<{ id: string; role: string }>("SELECT id, role FROM participations WHERE id LIKE 'part-mig-h-%'");
  expect(hostParts.length).toBe(2);
  for (const p of hostParts) expect(p.role).toBe('HOST');
  const players = await qy<{ role: string }>("SELECT role FROM participations WHERE id LIKE 'part-mig-a-%' OR id LIKE 'part-mig-b-%'");
  expect(players.length).toBe(4);
  for (const p of players) expect(p.role).toBe('PLAYER');

  // IDs + Referenzen + Versionen + Punkte + Rejoin-Tokens UNVERÄNDERT.
  for (const [key, r] of Object.entries(ROOMS)) {
    const room = await one<{ id: string; code: string; gameDefinitionId: string; hostUserId: string; status: string; runPhase: string; revision: number }>(
      'SELECT id, code, gameDefinitionId, hostUserId, status, runPhase, revision FROM rooms WHERE id=?', r.roomId);
    expect(room.id).toBe(r.roomId);
    expect(room.code).toBe(r.code);
    expect(room.gameDefinitionId).toBe('gd-wid-mig');
    expect(room.hostUserId).toBe(MOD_USER_ID);
    expect(room.status).toBe('RUNNING');
    expect(room.runPhase).toBe('ROUND_ACTIVE');
    expect(room.revision).toBe(0); // Migration toucht die Raum-Daten NICHT.
    expect((await one<{ score: number }>('SELECT score FROM participations WHERE id=?', r.aliceId)).score).toBe(-1);
    expect((await one<{ rejoinToken: string }>('SELECT rejoinToken FROM participations WHERE id=?', r.aliceId)).rejoinToken).toBe(`rt-mig-a-${key === 'v1' ? 1 : 2}`);
    expect((await one<{ phase: string }>('SELECT phase FROM room_game_states WHERE roomId=?', r.roomId)).phase).toBe('ROUND_READY');
    expect((await one<{ engineVersion: number }>('SELECT engineVersion FROM room_game_states WHERE roomId=?', r.roomId)).engineVersion).toBe(key === 'v1' ? 1 : 2);
  }
  // Die neue Room-Spalte trägt den ehrlichen Default (NOT NULL DEFAULT 0),
  // die alten Raum-Daten bleiben erhalten.
  expect((await one<{ v: number }>('SELECT configSchemaVersion AS v FROM rooms WHERE id=?', 'room-mig-v1')).v).toBe(0);
  // Session + Medien-Assets unverändert.
  expect((await one<{ userId: string }>('SELECT userId FROM sessions WHERE id=?', 'sess-mig-host')).userId).toBe(MOD_USER_ID);
  expect((await one<{ derivedFromAssetIds: string | null }>('SELECT derivedFromAssetIds FROM media_assets WHERE id=?', MEDIA.compV2)).derivedFromAssetIds).toContain(MEDIA.origA);
}

describe('14-08: WID-v1/v2-Rejoin überlebt den echten migrate-deploy', () => {
  it('v1-Raum (engineVersion=1): alte Session + Rejoin → Phase/Bild/Punkte/Geheimhaltung/beenden', async () => {
    const r = ROOMS.v1;
    const cookie = createSessionCookie('sess-mig-host', SESSION_SECRET);
    const mod = await connectGameClient(origin(), cookie); sockets.push(mod);
    const alice = await connectGameClient(origin()); sockets.push(alice);
    const bob = await connectGameClient(origin()); sockets.push(bob);
    const viewer = await connectGameClient(origin()); sockets.push(viewer);
    expect((await ack(mod, 'room:subscribe', { roomCode: r.code })).success).toBe(true);
    expect((await ack(alice, 'room:subscribe', { roomCode: r.code, rejoinToken: 'rt-mig-a-1' })).success).toBe(true);
    expect((await ack(bob, 'room:subscribe', { roomCode: r.code, rejoinToken: 'rt-mig-b-1' })).success).toBe(true);
    expect((await ack(viewer, 'room:subscribe', { roomCode: r.code })).success).toBe(true);

    const view = await ack(viewer, 'weristdas:resync');
    if (!view.success) { console.log('RESYNC-V1-ERROR', JSON.stringify(view)); console.log('SERVER-STDERR-TAIL:\n' + procStderr.slice(-3000)); }
    expect(view.success).toBe(true);
    expect(view.state).toMatchObject({ phase: 'ROUND_READY', roundIndex: 0, roundCount: 2, imageAssetId: MEDIA.imgV1, revealed: false });
    expect(view.state).toMatchObject({ scores: { [r.aliceId]: -1, [r.bobId]: 0 } });
    expect(JSON.stringify(view)).not.toContain(SECRET_NAME);
    // Buzz-Rechte überleben: Alice ist persistiert AUSGEDRÄNGT.
    expect((await ack(mod, 'weristdas:buzzer:open')).success).toBe(true);
    expect((await ack(alice, 'weristdas:buzz')).error).toBe('PLAYER_EXCLUDED');
    expect((await ack(bob, 'weristdas:buzz')).success).toBe(true);
    // Host sieht die Lösung, Viewer nicht.
    expect(JSON.stringify(await ack(mod, 'weristdas:resync'))).toContain(SECRET_NAME);
    expect(JSON.stringify(await ack(viewer, 'weristdas:resync'))).not.toContain(SECRET_NAME);
    const endCommand = { roomCode: r.code, commandId: crypto.randomUUID() };
    const endV1 = await ack(mod, 'game:end', endCommand);
    if (!endV1.success) { console.log('GAME-END-V1-ERROR', JSON.stringify(endV1)); console.log('SERVER-TAIL:\n' + procStderr.slice(-2500)); }
    expect(endV1.success).toBe(true);
    expect(await ack(mod, 'game:end', endCommand)).toMatchObject({ success: true, replayed: true });
    expect(await prisma.commandReceipt.findUniqueOrThrow({ where: { roomId_commandId: { roomId: r.roomId, commandId: endCommand.commandId } } })).toMatchObject({ status: 'COMPLETED', beforeStateRevision: expect.any(Number), executionToken: expect.any(String), mutationStartedAt: expect.any(Date) });
    const room = await prisma.room.findUniqueOrThrow({ where: { id: r.roomId } });
    expect(room.status).toBe('ENDED');
    // Reader hat die Engine-Version NICHT umgeschrieben.
    expect((await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.roomId } })).engineVersion).toBe(1);
  }, 60000);

  it('v2-Raum (engineVersion=2): Composite wird Spielbild, Originale/Namen bleiben geheim, beenden', async () => {
    const r = ROOMS.v2;
    const cookie = createSessionCookie('sess-mig-host', SESSION_SECRET);
    const mod = await connectGameClient(origin(), cookie); sockets.push(mod);
    const viewer = await connectGameClient(origin()); sockets.push(viewer);
    expect((await ack(mod, 'room:subscribe', { roomCode: r.code })).success).toBe(true);
    expect((await ack(viewer, 'room:subscribe', { roomCode: r.code })).success).toBe(true);
    const view = await ack(viewer, 'weristdas:resync');
    expect(view.success).toBe(true);
    expect(view.state).toMatchObject({ phase: 'ROUND_READY', roundIndex: 0, imageAssetId: MEDIA.compV2, revealed: false });
    for (const orig of [MEDIA.origA, MEDIA.origB]) {
      expect((view.state as { imageAssetId: string }).imageAssetId).not.toBe(orig);
    }
    expect(JSON.stringify(view)).not.toContain(SECRET_NAME);
    for (const orig of [MEDIA.origA, MEDIA.origB]) expect(JSON.stringify(view)).not.toContain(orig);
    const host = await ack(mod, 'weristdas:resync');
    expect(JSON.stringify(host)).toContain(SECRET_NAME);
    expect(JSON.stringify(host)).toContain(MEDIA.origA);
    expect((await ack(mod, 'game:end', { roomCode: r.code })).success).toBe(true);
    expect((await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.roomId } })).engineVersion).toBe(2);
  }, 60000);
  it('defekter Config-Snapshot liefert Fehler-ACK; echter Serverprozess bleibt erreichbar', async () => {
    const r = ROOMS.v1;
    const roomBefore = await prisma.room.findUniqueOrThrow({ where: { id: r.roomId } });
    const host = await connectGameClient(origin(), createSessionCookie('sess-mig-host', SESSION_SECRET));
    sockets.push(host);
    expect((await ack(host, 'room:subscribe', { roomCode: r.code })).success).toBe(true);
    await prisma.room.update({ where: { id: r.roomId }, data: { configSchemaVersion: 1, gameConfigSnapshotJson: 'broken' } });
    try {
      const response = await ack(host, 'room:config:update', {
        roomCode: r.code, expectedRevision: roomBefore.revision, changes: { roundCount: 1 },
      });
      expect(response).toMatchObject({ success: false, error: 'CONFIG_SNAPSHOT_INVALID', code: 'RECOVERY_REQUIRED', traceId: expect.any(String) });
      expect(JSON.stringify(response)).not.toContain('broken');
      expect(await healthOk()).toBe(true);
      expect(proc?.exitCode).toBeNull();
    } finally {
      await prisma.room.update({ where: { id: r.roomId }, data: { configSchemaVersion: roomBefore.configSchemaVersion, gameConfigSnapshotJson: roomBefore.gameConfigSnapshotJson } });
    }
  }, 60000);

});
