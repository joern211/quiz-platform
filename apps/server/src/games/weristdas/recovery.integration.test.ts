// ============================================================
// Wer ist das? — ECHTER Prozess-Restart-Recovery-Test (PR11 Nacharbeit D)
//
// Regelwerk §5.22/§5.23, PR11-Nacharbeit D:
//   "Prozess/Server wirklich stoppen, mit derselben DB neu starten,
//    wiederbeitreten, Phase, Bild-ID, Punkte, Buzz-Rechte und
//    Geheimhaltung prüfen, Runde normal beenden."
//
// Warum ein SUBPROZESS (kein in-process create/close/create):
//   Der vorhandene Test "frischer Client am selben Testserver" teilt sich den
//   Node-Prozess (gleiche Module, gleiche Prisma-Singleton, gleicher
//   In-Memory-Cache). Er beweist NICHT, dass ein FRESCHER Prozess den
//   persistierten State korrekt liest. Hier startet der Server als eigenes
//   OS-Kind (node --import tsx src/server.ts) auf derselben DB-Datei. Die
//   Room-States wurden VOR dem Start in die DB geschrieben — exakt der
//   "vor dem Upgrade gestartete Raum" / "Prozess ist mitten im Spiel
//   abgestürzt" Fall. Der frisch gestartete Prozess liest sie neu und muss
//   sie exakt + sicher reproduzieren.
//
// Entscheidung D (belegt, nicht behauptet): v1 und v2 erzeugen die GLEICHE
//   State-Form WerIstDasState; die Versions-Differenz liegt im
//   Setup-Rundenformat, das normalizeRound version-agnostisch liest. Deshalb
//   unterstützt EIN Reader beide Versionen exakt — hier nachgewiesen für
//   einen v1-Raum (engineVersion=1, "vor Upgrade") UND einen v2-Raum
//   (engineVersion=2, "war aktiv, Prozess tot").
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createTestDatabase } from '../../test-helpers.js';
import { createSessionCookie } from '../../auth/session.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import type { Socket as ClientSocket } from 'socket.io-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/games/weristdas → apps/server ist 3 Ebenen oben.
const serverRoot = resolve(__dirname, '..', '..', '..'); // apps/server
const SERVER_ENTRY = resolve(serverRoot, 'src/server.ts');
const SESSION_SECRET = 'ci-test-secret-at-least-32-chars-long';
const SECRET_NAME = 'UNIQUE_PRIVATE_PERSON_12345'; // bleibt vor Reveal geheim

let dbUrl: string;
let storageRoot: string;
let prisma: PrismaClient;
let tmpRoot: string;
let port: number;
let proc: ChildProcess | null = null;
let procStderr = '';
const sockets: ClientSocket[] = [];
const roomIds: string[] = [];
const gameDefIds: string[] = [];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const origin = () => `http://127.0.0.1:${port}`;

function serverEnv() {
  return {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    DATABASE_URL: dbUrl,
    SESSION_SECRET,
    STORAGE_ROOT: storageRoot,
    LOG_LEVEL: 'error',
    PATH: process.env.PATH ?? '',
  };
}

async function healthOk(): Promise<boolean> {
  try {
    const r = await fetch(`${origin()}/api/v1/health`);
    return r.ok;
  } catch { return false; }
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 30000, step = 250): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(step);
  }
  throw new Error(`waitFor: Timeout nach ${timeoutMs}ms. Server-Stderr:\n${procStderr.slice(-4000)}`);
}

async function startServer(): Promise<void> {
  procStderr = '';
  proc = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: serverRoot, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', d => { procStderr += String(d); });
  const early = await new Promise<number>(res => {
    if (proc && !proc.killed) proc.once('exit', code => res(code ?? -1));
    setTimeout(() => res(-99), 2000);
  });
  // early -99 = noch am Laufen (gut), 0 = sauber beendet (seltsam, aber kein
  // Crash). Ein POSITIVES Exit-Code wäre ein echtes frühes Fehlstart-Signal.
  if (early > 0) throw new Error(`Server exit früh (code ${early}):\n${procStderr.slice(-4000)}`);
  await waitFor(healthOk);
}

async function stopServer(): Promise<void> {
  if (!proc || proc.killed) return;
  const p = proc;
  await new Promise<void>(res => {
    const done = () => res();
    p.once('exit', done);
    p.kill('SIGTERM');
    setTimeout(() => { if (!p.killed) p.kill('SIGKILL'); done(); }, 8000);
  });
  proc = null;
}

async function connect(cookie?: string): Promise<ClientSocket> {
  const s = await connectGameClient(origin(), cookie);
  sockets.push(s);
  return s;
}
const ack = gameAck;

// Mitten im Spiel: Alice (P1) hat gejubelt und FALSCH → -1, ausgedrängt.
// Bob (P2) 0. Phase ROUND_READY, Runde 0, nichts aufgedeckt.
function midGameState(aliceId: string, bobId: string) {
  return {
    phase: 'ROUND_READY',
    roundIndex: 0,
    roundCount: 2,
    scores: { [aliceId]: -1, [bobId]: 0 },
    playerNames: { [aliceId]: 'Alice', [bobId]: 'Bob' },
    buzzer: { open: false, winnerId: null, excludedPlayerIds: [aliceId] },
    hintActive: false,
    playedRoundIds: [],
    solvedBy: null,
    lastDelta: -1,
    revealed: false,
  };
}

interface SeededRoom {
  roomId: string; code: string;
  aliceId: string; bobId: string;
  aliceToken: string; bobToken: string; modToken: string;
  modCookie: string;
  gameImageAssetId: string; // v1: das eine Bild; v2: das Composite
  originalAssetIds: string[]; // v2: die beiden Originale (leer bei v1)
  stateBefore: ReturnType<typeof midGameState>;
}

async function seedRunningRoom(version: 1 | 2): Promise<SeededRoom> {
  const hostId = `host-${version}-${Date.now()}`;
  await prisma.user.create({
    data: { id: hostId, email: `${hostId}@quiz.local`, displayName: `Host ${version}`, passwordHash: 'x', role: 'MODERATOR' },
  });
  const session = await prisma.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 3_600_000) } });

  let gameDefId = gameDefIds[0];
  if (!gameDefId) {
    const gd = await prisma.gameDefinition.create({ data: {
      slug: 'wer-ist-das', name: 'Wer ist das?', category: 'buzzer-reaktion', status: 'BETA',
      minPlayers: 2, maxPlayers: 10, estimatedMinutes: 15,
      hasBuzzer: true, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false, tags: '[]',
    } });
    gameDefId = gd.id; gameDefIds.push(gameDefId);
  }

  const code = `${version}${Math.floor(100000 + Math.random() * 900000)}`;
  // Medien-Assets (echte DB-Zeilen, damit die Signed-URLs auf existierende
  // Assets zeigen; die Dateien werden im Recovery-Pfad NICHT gelesen).
  let gameImageAssetId: string;
  const originalAssetIds: string[] = [];
  if (version === 1) {
    const img = await prisma.mediaAsset.create({ data: {
      type: 'image', mimeType: 'image/png', filename: `v1-${code}.png`, originalName: 'v1.png',
      fileSize: 12, sha256: `h1-${code}-${Date.now()}`, storagePath: `/tmp/v1-${code}.png`,
      uploadedBy: hostId, visibility: 'PRIVATE', processStatus: 'READY',
    } });
    gameImageAssetId = img.id;
  } else {
    const a = await prisma.mediaAsset.create({ data: {
      type: 'image', mimeType: 'image/png', filename: `origA-${code}.png`, originalName: 'a.png',
      fileSize: 12, sha256: `ha-${code}-${Date.now()}`, storagePath: `/tmp/origA-${code}.png`,
      uploadedBy: hostId, visibility: 'PRIVATE', processStatus: 'READY',
    } });
    const b = await prisma.mediaAsset.create({ data: {
      type: 'image', mimeType: 'image/png', filename: `origB-${code}.png`, originalName: 'b.png',
      fileSize: 12, sha256: `hb-${code}-${Date.now()}`, storagePath: `/tmp/origB-${code}.png`,
      uploadedBy: hostId, visibility: 'PRIVATE', processStatus: 'READY',
    } });
    originalAssetIds.push(a.id, b.id);
    const g = await prisma.mediaAsset.create({ data: {
      type: 'image', mimeType: 'image/webp', filename: `comp-${code}.webp`, originalName: 'fusion.webp',
      fileSize: 40, sha256: `hg-${code}-${Date.now()}`, storagePath: `/tmp/comp-${code}.webp`,
      uploadedBy: hostId, visibility: 'ROOM_TEMP', processStatus: 'READY',
      derivedFromAssetIds: JSON.stringify([a.id, b.id]),
    } });
    gameImageAssetId = g.id;
  }

  const roundOne = version === 1
    ? { id: 'one', imageAssetId: gameImageAssetId, person1: SECRET_NAME, person2: 'Second', setupVersion: 1 }
    : { id: 'one', personAImageAssetId: originalAssetIds[0], personBImageAssetId: originalAssetIds[1], gameImageAssetId, personAName: SECRET_NAME, personBName: 'Second', setupVersion: 2 };
  const roundTwo = version === 1
    ? { id: 'two', imageAssetId: gameImageAssetId, person1: 'Third', person2: 'Fourth', setupVersion: 1 }
    : { id: 'two', personAImageAssetId: originalAssetIds[0], personBImageAssetId: originalAssetIds[1], gameImageAssetId, personAName: 'Third', personBName: 'Fourth', setupVersion: 2 };
  const setupSnapshot = JSON.stringify({ setupSchemaVersion: version, rounds: [roundOne, roundTwo] });

  const room = await prisma.room.create({ data: {
    code, roomName: `Recovery v${version}`, gameDefinitionId: gameDefId, hostUserId: hostId,
    status: 'RUNNING', runPhase: 'ROUND_ACTIVE', setupSnapshotJson: setupSnapshot,
    setupSchemaVersion: version, viewerRequiresPin: false,
  } });
  roomIds.push(room.id);

  const modPart = await prisma.participation.create({ data: {
    roomId: room.id, role: 'MODERATOR', displayName: `Host ${version}`, normalizedName: `host${version}`,
    connected: true, ready: true, rejoinToken: crypto.randomUUID(), rejoinTokenVersion: 1,
  } });
  const alice = await prisma.participation.create({ data: {
    roomId: room.id, role: 'PLAYER', displayName: 'Alice', normalizedName: `alice-v${version}`,
    connected: true, ready: true, rejoinToken: crypto.randomUUID(), rejoinTokenVersion: 1, score: -1,
  } });
  const bob = await prisma.participation.create({ data: {
    roomId: room.id, role: 'PLAYER', displayName: 'Bob', normalizedName: `bob-v${version}`,
    connected: true, ready: true, rejoinToken: crypto.randomUUID(), rejoinTokenVersion: 1, score: 0,
  } });

  const state = midGameState(alice.id, bob.id);
  // Engine-Version ECHT pinnen: v1-Raum = vor Upgrade (engineVersion 1),
  // v2-Raum = war aktiv mit der aktuellen Engine (engineVersion 2).
  await prisma.roomGameState.create({ data: {
    roomId: room.id, engineVersion: version, phase: state.phase,
    stateJson: JSON.stringify(state), revision: 1,
  } });

  return {
    roomId: room.id, code,
    aliceId: alice.id, bobId: bob.id,
    aliceToken: alice.rejoinToken, bobToken: bob.rejoinToken, modToken: modPart.rejoinToken,
    modCookie: createSessionCookie(session.id, SESSION_SECRET),
    gameImageAssetId, originalAssetIds, stateBefore: state,
  };
}

async function reconnectAll(r: SeededRoom) {
  const mod = await connect(r.modCookie);
  const alice = await connect();
  const bob = await connect();
  const viewer = await connect();
  expect((await ack(mod, 'room:subscribe', { roomCode: r.code, moderatorToken: r.modToken })).success).toBe(true);
  expect((await ack(alice, 'room:subscribe', { roomCode: r.code, rejoinToken: r.aliceToken })).success).toBe(true);
  expect((await ack(bob, 'room:subscribe', { roomCode: r.code, rejoinToken: r.bobToken })).success).toBe(true);
  expect((await ack(viewer, 'room:subscribe', { roomCode: r.code })).success).toBe(true);
  return { mod, alice, bob, viewer };
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'quiz-recovery-'));
  storageRoot = join(tmpRoot, 'storage');
  dbUrl = `file:${join(tmpRoot, 'test.db')}`;
  await createTestDatabase(dbUrl);
  prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.$connect();
  port = 42100 + Math.floor(Math.random() * 400);
  // FRESCHER Prozess liest die VOR dem Start persistierten Räume.
  await startServer();
}, 120000);

afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch { /* */ } }
  await stopServer().catch(() => {});
  if (proc && !proc.killed) { try { proc.kill('SIGKILL'); } catch { /* */ } }
  if (prisma) await prisma.$disconnect().catch(() => {});
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe('Wer ist das? — Recovery nach echtem Prozess-Restart (PR11 D)', () => {
  it('D: v1-Raum (engineVersion=1, vor Upgrade) überlebt Restart — Phase, Bild, Punkte, Buzz, Geheimhaltung, beenden', async () => {
    const r = await seedRunningRoom(1);
    const { mod, alice, bob, viewer } = await reconnectAll(r);

    // Wiederaufnahme: Phase + Bild-ID + Punkte EXAKT wie persistiert.
    const view = await ack(viewer, 'weristdas:resync');
    expect(view.success).toBe(true);
    expect(view.state).toMatchObject({
      phase: r.stateBefore.phase, roundIndex: 0, roundCount: 2,
      imageAssetId: r.gameImageAssetId,
      scores: { [r.aliceId]: -1, [r.bobId]: 0 },
      revealed: false,
    });
    // Geheimhaltung: v1-Bild zeigt, aber KEIN Name (vor Reveal) für Viewer.
    expect(JSON.stringify(view)).not.toContain(SECRET_NAME);

    // Buzz-Rechte überleben den Restart: Alice ist persistiert AUSGEDRÄNGT
    // (excludedPlayerIds) → ihr Buzz wird mit PLAYER_EXCLUDED abgelehnt.
    expect((await ack(mod, 'weristdas:buzzer:open')).success).toBe(true);
    expect((await ack(alice, 'weristdas:buzz')).error).toBe('PLAYER_EXCLUDED');
    expect((await ack(bob, 'weristdas:buzz')).success).toBe(true);
    // Moderator sieht die Lösung (Host-Geheimhaltung bleibt erhalten).
    expect(JSON.stringify(await ack(mod, 'weristdas:resync'))).toContain(SECRET_NAME);
    expect(JSON.stringify(await ack(viewer, 'weristdas:resync'))).not.toContain(SECRET_NAME);

    // Runde normal beenden (engineVersion-1-State wird korrekt beendet).
    expect((await ack(mod, 'game:end', { roomCode: r.code })).success).toBe(true);
    const room = await prisma.room.findUniqueOrThrow({ where: { id: r.roomId } });
    expect(room.status).toBe('ENDED');
    expect(room.runPhase).toBe('RESULTS');
    expect((await ack(viewer, 'weristdas:resync')).state).toMatchObject({ phase: 'GAME_END' });
    // Reader hat die Engine-Version NICHT umgeschrieben.
    expect((await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.roomId } })).engineVersion).toBe(1);
  }, 60000);

  it('D: v2-Raum (engineVersion=2, war aktiv) überlebt Restart — Composite wird Spielbild, Originale/Namen bleiben geheim, beenden', async () => {
    const r = await seedRunningRoom(2);
    const { mod, viewer } = await reconnectAll(r);

    // Das freigegebene SPIELBILD ist das COMPOSITE (nicht die Originale).
    const view = await ack(viewer, 'weristdas:resync');
    expect(view.success).toBe(true);
    expect(view.state).toMatchObject({
      phase: r.stateBefore.phase, roundIndex: 0,
      imageAssetId: r.gameImageAssetId, // Composite
      scores: { [r.aliceId]: -1, [r.bobId]: 0 },
      revealed: false,
    });
    // Originale werden NICHT als das angezeigte Bild projiziert.
    for (const orig of r.originalAssetIds) {
      expect((view.state as { imageAssetId: string }).imageAssetId).not.toBe(orig);
    }
    // Namen + Original-IDs bleiben vor Reveal für Viewer unsichtbar.
    expect(JSON.stringify(view)).not.toContain(SECRET_NAME);
    for (const orig of r.originalAssetIds) expect(JSON.stringify(view)).not.toContain(orig);
    // Host sieht (nach Restart) Originale + Namen als hostsecret (Reveal-Ausgabe).
    const host = await ack(mod, 'weristdas:resync');
    expect(JSON.stringify(host)).toContain(SECRET_NAME);
    expect(JSON.stringify(host)).toContain(r.originalAssetIds[0]);
    expect(JSON.stringify(host)).toContain(r.originalAssetIds[1]);

    expect((await ack(mod, 'game:end', { roomCode: r.code })).success).toBe(true);
    const room = await prisma.room.findUniqueOrThrow({ where: { id: r.roomId } });
    expect(room.status).toBe('ENDED');
    expect(room.runPhase).toBe('RESULTS');
    expect((await prisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.roomId } })).engineVersion).toBe(2);
  }, 60000);

  it('D: inkompatible Engine-Version (z.B. 3) → kontrollierte Ablehnung statt falschem State', async () => {
    const r = await seedRunningRoom(1);
    // State-zeile auf eine Version setzen, die der Reader NICHT kennt.
    await prisma.roomGameState.update({ where: { roomId: r.roomId }, data: { engineVersion: 3 } });
    const { mod, viewer } = await reconnectAll(r);
    // Resync + jede Action lehnen kontrolliert ab (kein crash, kein falscher
    // State, kein 500). Raum bleibt ansonsten unverändert.
    expect((await ack(viewer, 'weristdas:resync')).error).toBe('UNSUPPORTED_ENGINE_VERSION');
    expect((await ack(mod, 'weristdas:buzzer:open')).error).toBe('UNSUPPORTED_ENGINE_VERSION');
    const room = await prisma.room.findUniqueOrThrow({ where: { id: r.roomId } });
    expect(room.status).toBe('RUNNING'); // nicht umgeschrieben/zerstört
  }, 60000);
});
