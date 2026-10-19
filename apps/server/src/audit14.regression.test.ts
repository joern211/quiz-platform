// ============================================================
// Audit PR14 — Regressionstests für die reproduzierten Fehler-
// bedingungen (14-01..14-06, 14-10). Jeder Test stellt den
// EXAKTEN Zustand des Audit-Befunds her und belegt den Fix:
//   14-01: neue zulässige Absicht (neues Token) wird ausgeführt,
//          nicht als Replay behandelt (echter WID-Socket-Flow).
//   14-02: Fehler zwischen Mutation und Receipt-Abschluss → KEIN
//          Double-Apply bei Retry (Fehler-Injektion); PENDING-
//          Recovery nach Prozessabbruch.
//   14-03: widersprüchliche/veraltete Command-Felder werden VOR
//          der Mutation abgelehnt (echter Socket + Shared-Resolver).
//   14-04: kanonischer wissensduell-Raum mit nicht-default Timer →
//          Snapshot trägt tatsächliche Werte/Version (11 s → 11000 ms).
//   14-05: Config-Update atomar: fehlerhafte Änderung verbraucht
//          die Revision NICHT (Fehler-Injektion → Rollback).
//   14-06: PLAYER_MANAGE-Entzug wird beim Kicken beachtet (echter
//          Socket), auch bei bereits verbundenem Host.
//   14-10: normalizeRole wirft Prototype-Namen sauber weg.
// ============================================================
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { PrismaClient, Prisma } from '@prisma/client';
import { setupSocketHandlers } from './sockets/index.js';
import { createSessionCookie } from './auth/session.js';
import { config } from './config/index.js';
import { connectGameClient, gameAck } from './test-socket-harness.js';
import { runReceipted } from './games/core/commands.js';
import { resolveCommandContextForSocket } from './games/core/commandContext.js';
import { updateRoomConfig } from './games/core/config.js';
import { requireGamePermission } from './games/core/permissions.js';

const ack = gameAck;
const HOST_USER_ID = 'mod-1';

let testPrisma: PrismaClient;
let httpServer: HttpServer;
let io: Server;
let origin: string;
const sockets: ClientSocket[] = [];
const roomIds: string[] = [];

async function connect(cookie?: string): Promise<ClientSocket> {
  const s = await connectGameClient(origin, cookie);
  sockets.push(s);
  return s;
}

async function makeHostRoom(overrides: {
  slug: string;
  setup: Record<string, unknown>;
  status?: string;
  runPhase?: string;
  players?: number;
} = { slug: 'wer-ist-das', setup: {} }): Promise<{ id: string; code: string; host: ClientSocket }> {
  const code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
  const game = await testPrisma.gameDefinition.findUniqueOrThrow({ where: { slug: overrides.slug } });
  const room = await testPrisma.room.create({
    data: {
      code, roomName: `A14 ${code}`, gameDefinitionId: game.id, hostUserId: HOST_USER_ID,
      status: overrides.status ?? 'LOBBY', runPhase: overrides.runPhase ?? 'LOBBY',
      viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(overrides.setup),
    },
  });
  roomIds.push(room.id);
  const n = overrides.players ?? 2;
  for (let i = 0; i < n; i++) {
    await testPrisma.participation.create({
      data: { roomId: room.id, displayName: `P${i}`, normalizedName: `p${i}-${code}`, role: 'PLAYER', rejoinToken: randomUUID(), connected: true, ready: true },
    });
  }
  const host = await connect(createSessionCookie((await testPrisma.session.findFirstOrThrow({ where: { userId: HOST_USER_ID } })).id, config.sessionSecret));
  expect((await ack(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
  return { id: room.id, code, host };
}

beforeAll(async () => {
  const { PrismaClient } = await import('@prisma/client');
  testPrisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await testPrisma.$connect();
  (globalThis as Record<string, unknown>).__prisma = testPrisma;
  await testPrisma.user.upsert({ where: { id: HOST_USER_ID }, update: {}, create: { id: HOST_USER_ID, displayName: 'A14 Host', passwordHash: 'x', role: 'HOST' } });
  await testPrisma.session.create({ data: { id: `sess-a14-${randomUUID()}`, userId: HOST_USER_ID, expiresAt: new Date(Date.now() + 86400000) } });
  httpServer = createServer();
  io = new Server(httpServer);
  setupSocketHandlers(io);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
  for (const id of roomIds) await testPrisma.room.deleteMany({ where: { id } }).catch(() => undefined);
  await testPrisma.$disconnect();
  (globalThis as Record<string, unknown>).__prisma = undefined;
});

// ------------------------------------------------------------
// 14-01 — Neue zulässige Absicht ≠ Replay (echter WID-Flow)
// ------------------------------------------------------------
describe('14-01: WID öffnen–WRONG–erneut öffnen (echte Sockets)', () => {
  it('erneutes Buzzer-Öffnen derselben Runde mit NEUEM Token wird ausgeführt; mit ALTERM Token → Replay', async () => {
    const image = await testPrisma.mediaAsset.create({
      data: { type: 'image', mimeType: 'image/png', filename: 'a14.png', originalName: 'a14.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/a14.png', uploadedBy: HOST_USER_ID },
    });
    const { id, code, host } = await makeHostRoom({
      slug: 'wer-ist-das',
      setup: { rounds: [{ id: 'r1', imageAssetId: image.id, person1: 'A', person2: 'B' }, { id: 'r2', imageAssetId: image.id, person1: 'C', person2: 'D' }] },
    });
    const players = await testPrisma.participation.findMany({ where: { roomId: id, role: 'PLAYER' } });
    const alice = await connect();
    expect((await ack(alice, 'room:subscribe', { roomCode: code, rejoinToken: players[0].rejoinToken })).success).toBe(true);

    expect((await ack(host, 'game:start', { roomCode: code })).success).toBe(true);
    const token = (id2: string) => id2;
    // 1) Buzzer öffnen mit Token A.
    expect((await ack(host, 'weristdas:buzzer:open', { commandId: token('A') })).success).toBe(true);
    expect((await ack(alice, 'weristdas:buzz', { commandId: token('buzz-1') })).success).toBe(true);
    // 2) Host bewertet WRONG → Runde zurück auf ROUND_READY, Alice ausgeschlossen.
    expect((await ack(host, 'weristdas:judge', { result: 'WRONG', commandId: token('judge-1') })).success).toBe(true);
    const stateAfterWrong = await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: id } });
    expect(JSON.parse(stateAfterWrong.stateJson).phase).toBe('ROUND_READY');

    // 3a) NEUE zulässige Absicht (erneutes Öffnen) mit NEUEM Token →
    //     muss ausgeführt werden (BUZZ_OPEN), NICHT als Replay.
    const reopenNew = await ack(host, 'weristdas:buzzer:open', { commandId: token('A-new') });
    expect(reopenNew.success).toBe(true);
    expect(reopenNew.replayed).not.toBe(true);
    let st = await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: id } });
    expect(JSON.parse(st.stateJson).phase).toBe('BUZZ_OPEN');

    // 3b) Kontrolle — ALTES Token A erneut senden (der frühere Frontend-
    //     Fehler): wird als Replay behandelt und ändert den Zustand NICHT.
    const reopenOld = await ack(host, 'weristdas:buzzer:open', { commandId: token('A') });
    expect(reopenOld.success).toBe(true);
    expect(reopenOld.replayed).toBe(true);
    st = await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: id } });
    // Replay liefert die GESPEICHERTE Antwort des ersten Öffnens; der
    // Zustand bleibt, was er nach dem neuen Öffnen war (BUZZ_OPEN) —
    // der alte Token wird nicht doppelt angewendet.
    expect(JSON.parse(st.stateJson).phase).toBe('BUZZ_OPEN');
    await testPrisma.mediaAsset.delete({ where: { id: image.id } });
  }, 30000);
});

// ------------------------------------------------------------
// 14-02 — Receipt-Atomarität + Recovery (Fehler-Injektion)
// ------------------------------------------------------------
describe('14-02: Fehler zwischen Mutation und Receipt-Abschluss', () => {
  it('COMPLETED-Write schlägt NACH committierter Mutation fehl → Retry double-applied NICHT (Revision bleibt)', async () => {
    const { id, code } = await makeHostRoom({ slug: 'wer-ist-das', setup: { rounds: [{ id: 'r1', imageAssetId: randomUUID(), person1: 'A', person2: 'B' }] } });
    // Raum in einen Zustand versetzen, in dem eine echte Engine-Mutation
    // (LOBBY→RUNNING + State) per CAS die Room-Revision erhöht.
    const room = await testPrisma.room.findUniqueOrThrow({ where: { id } });
    const startRev = room.revision;
    const commandId = `cmd-1402-${randomUUID()}`;

    // Mutation: echter CAS, der die Revision erhöht (wie game:start).
    const mutate = async () => {
      const cas = await testPrisma.room.updateMany({ where: { id, status: 'LOBBY', revision: startRev }, data: { status: 'RUNNING', revision: { increment: 1 } } });
      if (cas.count !== 1) throw new Error('STATE_CONFLICT');
      return { ok: true };
    };

    // Fehler-Injektion: NUR der COMPLETED-Write (nach der erfolgreichen
    // Mutation) schlägt genau einmal fehl.
    const client = globalThis.__prisma as PrismaClient;
    const origUpdate = client.commandReceipt.update.bind(client.commandReceipt);
    let completedWrites = 0;
    (client.commandReceipt as unknown as { update: (a: unknown) => Promise<unknown> }).update = async (a: unknown) => {
      const data = (a as { data?: { status?: string } }).data;
      if (data?.status === 'COMPLETED') {
        completedWrites += 1;
        if (completedWrites === 1) throw new Error('INJECTED_COMPLETION_FAILURE');
      }
      return origUpdate(a as never);
    };

    try {
      // Erster Command: Mutation committet (Revision 0→1), COMPLETED-Write
      // schlägt fehl → FAILED-Zeile, aber die WIRKUNG ist schon da.
      await expect(runReceipted(client, {
        roomId: id, commandId, actor: { actorId: 'p', actorRole: 'HOST' }, action: 'GAME_START', payload: { r: 1 }, mutate, toResponse: (d: { ok: boolean }) => ({ success: d.ok }),
      })).rejects.toThrow('INJECTED_COMPLETION_FAILURE');
      const row1 = await testPrisma.commandReceipt.findUnique({ where: { roomId_commandId: { roomId: id, commandId } } });
      expect(row1?.status).toBe('FAILED');
      const afterFirst = await testPrisma.room.findUniqueOrThrow({ where: { id } });
      expect(afterFirst.revision).toBe(startRev + 1); // Mutation committet

      // Retry (gleicher commandId): die Revision ist FORTGESCHRITTEN →
      // der ursprüngliche Command hat gewirkt → KEINE zweite Ausführung
      // (sonst wäre die Revision 0→1→2 = Doppelwirkung).
      const retried = await runReceipted(client, {
        roomId: id, commandId, actor: { actorId: 'p', actorRole: 'HOST' }, action: 'GAME_START', payload: { r: 1 }, mutate, toResponse: (d: { ok: boolean }) => ({ success: d.ok }),
      });
      // Entweder gespeicherte Antwort (replayed) oder kontrollierter Resync —
      // aber auf KEINEN Fall ein erneuter CAS (Revision +1).
      const afterRetry = await testPrisma.room.findUniqueOrThrow({ where: { id } });
      expect(afterRetry.revision).toBe(startRev + 1); // NICHT +2
      expect(retried.success).toBe(false);
      if ('resyncRequired' in retried) expect(retried.resyncRequired).toBe(true);
      expect(afterRetry.status).toBe('RUNNING');
      expect(code).toBeTruthy();
    } finally {
      (client.commandReceipt as unknown as { update: (a: unknown) => Promise<unknown> }).update = origUpdate as never;
    }
  }, 20000);

  it('abgestürzter PENDING-Claim (abgelaufene Lease) wird wieder aufgenommen statt COMMAND_IN_PROGRESS für immer', async () => {
    const { id } = await makeHostRoom({ slug: 'wer-ist-das', setup: {} });
    const room = await testPrisma.room.findUniqueOrThrow({ where: { id } });
    const startRev = room.revision;
    const commandId = `cmd-1402b-${randomUUID()}`;
    const { hashCommandPayload } = await import('./games/core/commands.js');
    // Simuliere einen abgestürzten Prozess: PENDING-Zeile mit abgelaufener
    // Lease + beforeRevision = aktueller Revision (keine Wirkung committet).
    // actorId + payloadHash müssen EXAKT zum Retry passen, sonst Conflict.
    await testPrisma.commandReceipt.create({
      data: {
        roomId: id, commandId, actorId: 'p', actorRole: 'HOST', action: 'GAME_START',
        payloadHash: hashCommandPayload('GAME_START', { r: 1 }), stateVersion: null, beforeRevision: startRev,
        leaseExpiresAt: new Date(Date.now() - 60000), status: 'PENDING',
      },
    });
    let mutations = 0;
    const mutate = async () => { mutations += 1; return { ok: true }; };
    const client = globalThis.__prisma as PrismaClient;
    const res = await runReceipted(client, {
      roomId: id, commandId, actor: { actorId: 'p', actorRole: 'HOST' }, action: 'GAME_START', payload: { r: 1 }, mutate, toResponse: (d: { ok: boolean }) => ({ success: d.ok }),
    });
    // Der abgestürzte Claim hatte KEINE Wirkung (Revision unverändert) →
    // sichere Neu-Ausführung, NICHT COMMAND_IN_PROGRESS.
    expect(res.success).toBe(true);
    expect(mutations).toBe(1);
    const row = await testPrisma.commandReceipt.findUnique({ where: { roomId_commandId: { roomId: id, commandId } } });
    expect(row?.status).toBe('COMPLETED');
  }, 20000);
});

// ------------------------------------------------------------
// 14-03 — Widersprüchliche/veraltete Command-Felder
// ------------------------------------------------------------
describe('14-03: Command-Konflikte an der Socket-Grenze', () => {
  it('game:pause mit widersprüchlichen commandId/requestId → VOR Mutation abgelehnt', async () => {
    const { code, host } = await makeHostRoom({ slug: 'wer-ist-das', setup: {}, players: 2 });
    // Der Konflikt-Check (widersprüchliche Felder) läuft VOR jeder
    // fachlichen Prüfung (Timer/Phase/Engine-Support) → INVALID_PAYLOAD.
    const res = await ack(host, 'game:pause', { roomCode: code, commandId: 'A', requestId: 'B', protocolVersion: 1 });
    expect(res.success).toBe(false);
    expect(res.error).toBe('INVALID_PAYLOAD');
  });

  it('game:pause mit negativer stateVersion + ungültigem roomCode → abgelehnt, keine Mutation', async () => {
    const { id, host } = await makeHostRoom({ slug: 'wer-ist-das', setup: {}, players: 2 });
    const revBefore = (await testPrisma.room.findUniqueOrThrow({ where: { id } })).revision;
    const res = await ack(host, 'game:pause', { roomCode: 'X', commandId: 'C', stateVersion: -123, protocolVersion: 1 });
    expect(res.success).toBe(false);
    expect(res.error).toBe('INVALID_PAYLOAD');
    const revAfter = (await testPrisma.room.findUniqueOrThrow({ where: { id } })).revision;
    expect(revAfter).toBe(revBefore); // keine Mutation
  });

  it('Resolver: negatives stateVersion / ungültiges roomCode / überlange commandId → null; gültige Paare → Envelope (Shared-Boundary)', async () => {
    const { resolveCommandEnvelope, CommandEnvelopeSchema } = await import('@quiz/shared');
    expect(resolveCommandEnvelope({ commandId: 'c', roomCode: '123-456', stateVersion: -1 })).toBeNull();
    expect(resolveCommandEnvelope({ commandId: 'c', roomCode: 'BAD' })).toBeNull();
    expect(resolveCommandEnvelope({ commandId: 'x'.repeat(129), roomCode: '123-456' })).toBeNull();
    const ok = resolveCommandEnvelope({ commandId: 'c', roomCode: '123-456', stateVersion: 0 });
    expect(ok).not.toBeNull();
    expect(CommandEnvelopeSchema.safeParse(ok!).success).toBe(true);
  });
});

// ------------------------------------------------------------
// 14-04 — Kanonischer wissensduell-Raum, nicht-default Timer
// ------------------------------------------------------------
describe('14-04: kanonischer wissensduell-Raum (11 s → 11000 ms)', () => {
  it('Setup-Timer 11 s + 2 Fragen → Snapshot trägt kanonischen Slug, tatsächliche Werte und Version', async () => {
    const q = await testPrisma.geoQuestion.create({ data: { packId: (await testPrisma.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'A14', status: 'PUBLISHED' } })).id, prompt: 'Q?', category: 'G', options: JSON.stringify([{ id: 'a', text: 'x' }]), correctOptionId: 'a' } });
    const { id, code, host } = await makeHostRoom({
      slug: 'wissensduell',
      setup: { selectedQuestionIds: [q.id, q.id], timerDuration: 11 },
    });
    expect((await ack(host, 'game:start', { roomCode: code })).success).toBe(true);
    const room = await testPrisma.room.findUniqueOrThrow({ where: { id } });
    const snap = JSON.parse(room.gameConfigSnapshotJson!);
    // Kanonischer Slug (nicht 'geo'), nicht-default Timer aus dem Setup.
    expect(snap.gameSlug).toBe('wissensduell');
    expect(snap.values.timerDurationMs.value).toBe(11000);
    // Tatsächliche Frageanzahl aus dem Setup (2), nicht pauschaler Default.
    expect(snap.values.questionCount.value).toBe(2);
    // Engine-Version ist die tatsächliche (1 für wissensduell) — kein Fallback.
    expect(snap.engineVersion).toBe(1);
    // Der Geo-Reader liest jetzt unter dem kanonischen Slug und bekommt 11000.
    const { loadGameConfig } = await import('./games/core/config.js');
    const loaded = await loadGameConfig(room, 'wissensduell');
    expect(loaded?.values.timerDurationMs.value).toBe(11000);
  }, 20000);

  it('defekter Snapshot → persistenter ERROR_RECOVERY, Resync und kontrolliertes Beenden statt Default-Runde', async () => {
    const q = await testPrisma.geoQuestion.create({ data: { packId: (await testPrisma.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'A14b', status: 'PUBLISHED' } })).id, prompt: 'Q?', category: 'G', options: JSON.stringify([{ id: 'a', text: 'x' }]), correctOptionId: 'a' } });
    const { id, code, host } = await makeHostRoom({
      slug: 'wissensduell',
      setup: { selectedQuestionIds: [q.id], timerDuration: 11 },
    });
    expect((await ack(host, 'game:start', { roomCode: code })).success).toBe(true);
    const gsBefore = await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: id } });
    const revBefore = gsBefore.revision;
    // Fehlgewidmeten Snapshot eintragen (Snapshot gehört zu 'jeopardy',
    // Raum zu 'wissensduell') — exakt der Audit-Fall: ungültiger,
    // inkompatibler oder fremdzugeordneter Snapshot.
    await testPrisma.room.update({
      where: { id },
      data: {
        gameConfigSnapshotJson: JSON.stringify({
          gameSlug: 'jeopardy', engineVersion: 1,
          values: { timerDurationMs: { value: 20000, source: 'SYSTEM_DEFAULT' } },
          createdAt: new Date().toISOString(),
        }),
        configSchemaVersion: 1,
      },
    });
    const { handleGeoGame, __activeTimerRoomIdsForTest, cancelGeoTimer } = await import('./games/geo/index.js');
    try {
      const roundError = new Promise(resolve => host.once('geo:round:error', resolve));
      await handleGeoGame.startRound(io, code);
      expect(await roundError).toEqual({ error: 'CONFIG_SNAPSHOT_INVALID' });
      // Persist only the recovery marker, retaining questions/scores/rounds.
      const gsAfter = await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: id } });
      const after = JSON.parse(gsAfter.stateJson);
      expect(after).toEqual({ ...JSON.parse(gsBefore.stateJson), phase: 'ERROR_RECOVERY', recoveryError: 'CONFIG_SNAPSHOT_INVALID' });
      expect(gsAfter.revision).toBe(revBefore + 1);
      expect((await testPrisma.room.findUniqueOrThrow({ where: { id } })).runPhase).toBe('ERROR_RECOVERY');
      expect(await ack(host, 'geo:resync', {})).toMatchObject({
        success: true, phase: 'ERROR_RECOVERY', recoveryError: 'CONFIG_SNAPSHOT_INVALID', timerEndMs: null,
      });
      const viewer = await connect();
      expect((await ack(viewer, 'room:subscribe', { roomCode: code })).success).toBe(true);
      const publicView = await ack(viewer, 'geo:resync', {});
      expect(publicView).toMatchObject({ success: true, phase: 'ERROR_RECOVERY', recoveryError: 'CONFIG_SNAPSHOT_INVALID', question: null });
      expect(publicView).not.toHaveProperty('questions');
      // Keine Timer-Erzeugung (und damit KEINE stille 20000-Default-Runde).
      expect(__activeTimerRoomIdsForTest()).not.toContain(id);
      const endCommand = { roomCode: code, commandId: randomUUID() };
      expect(await ack(host, 'game:end', endCommand)).toMatchObject({ success: true });
      expect(await ack(host, 'game:end', endCommand)).toMatchObject({ success: true, replayed: true });
      expect(await testPrisma.commandReceipt.findUniqueOrThrow({ where: { roomId_commandId: { roomId: id, commandId: endCommand.commandId } } })).toMatchObject({ status: 'COMPLETED' });
      expect((await testPrisma.room.findUniqueOrThrow({ where: { id } })).status).toBe('ENDED');
    } finally {
      cancelGeoTimer(id);
    }
  }, 20000);

  it('Legacy-Bestandsraum OHNE Snapshot → Timer aus Legacy-Setup (11 s → 11000 ms), Runde startet (unterstützter Pfad bleibt erhalten)', async () => {
    const q = await testPrisma.geoQuestion.create({ data: { packId: (await testPrisma.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'A14c', status: 'PUBLISHED' } })).id, prompt: 'Q?', category: 'G', options: JSON.stringify([{ id: 'a', text: 'x' }]), correctOptionId: 'a' } });
    const { id, code, host } = await makeHostRoom({
      slug: 'wissensduell',
      setup: { selectedQuestionIds: [q.id], timerDuration: 11 },
    });
    expect((await ack(host, 'game:start', { roomCode: code })).success).toBe(true);
    // Bestandsraum-Simulation: keinen Start-Snapshot (configSchemaVersion < 1)
    // → die Legacy-Auflösung (Setup-Setupwerte + Defaults) muss weiterlaufen.
    await testPrisma.room.update({ where: { id }, data: { gameConfigSnapshotJson: null, configSchemaVersion: 0 } });
    const { handleGeoGame, cancelGeoTimer } = await import('./games/geo/index.js');
    try {
      await handleGeoGame.startRound(io, code);
      const gsAfter = await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: id } });
      const state = JSON.parse(gsAfter.stateJson);
      expect(state.phase).toBe('INPUT_OPEN');
      const round = state.roundStates[0];
      // Tatsächlicher Legacy-Setupwert (11 s → 11000 ms), nicht 20000.
      expect(round.timerEndMs - round.timerStartMs).toBe(11000);
    } finally {
      cancelGeoTimer(id);
    }
  }, 20000);
});

// ------------------------------------------------------------
// 14-05 — Config-Update atomar (Fehler verbraucht Revision nicht)
// ------------------------------------------------------------
describe('14-05: Config-Update — Fehler verbraucht Revision nicht', () => {
  it('fehlgeschlagene Änderung (Fehler nach CAS) → Revision + liveConfigJson unverändert', async () => {
    const { id, code } = await makeHostRoom({ slug: 'wissensduell', setup: { timerDuration: 10 }, status: 'RUNNING', runPhase: 'ROUND_ACTIVE' });
    // Start-Snapshot anlegen, damit loadGameConfig einen Snapshot-Pfad hat.
    const { persistConfigSnapshot } = await import('./games/core/config.js');
    await persistConfigSnapshot(await testPrisma.room.findUniqueOrThrow({ where: { id } }), 'wissensduell', 1);
    const rev0 = (await testPrisma.room.findUniqueOrThrow({ where: { id } })).revision;

    const client = globalThis.__prisma as PrismaClient;
    const origTx = client.$transaction.bind(client);
    // Fehler-Injektion IN der Transaktion: nach dem Revision-CAS (updateMany)
    // wirft ein nachfolgender Schritt → die ganze Tx rollt zurück.
    (client as unknown as { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown> }).$transaction = async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      return (origTx as (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown>)(async (tx) => {
        const origUpdateMany = tx.room.updateMany.bind(tx.room);
        let bumped = false;
        (tx.room as unknown as { updateMany: (a: unknown) => Promise<{ count: number }> }).updateMany = async (a: unknown) => {
          const r = await origUpdateMany(a as never);
          if (r.count === 1) bumped = true;
          if (bumped) throw new Error('INJECTED_MID_TX_FAILURE'); // NACH Revision-CAS
          return r;
        };
        return fn(tx);
      });
    };
    try {
      const res = await updateRoomConfig({ roomId: id, actorUserId: HOST_USER_ID, expectedRevision: rev0, changes: { timerDurationMs: 12000 } });
      expect(res.ok).toBe(false);
    } finally {
      (client as unknown as { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => Promise<unknown> }).$transaction = origTx as never;
    }
    const after = await testPrisma.room.findUniqueOrThrow({ where: { id } });
    expect(after.revision).toBe(rev0); // Revision NICHT verbraucht
    expect(after.liveConfigJson).toBeNull(); // Werte unverändert
    expect(code).toBeTruthy();
  }, 20000);
});

// ------------------------------------------------------------
// 14-06 — PLAYER_MANAGE-Entzug wird beim Kicken beachtet
// ------------------------------------------------------------
describe('14-06: Kick mit entzogenem PLAYER_MANAGE wird verweigert', () => {
  it('eingeloggter Host mit REVOKE(PLAYER_MANAGE) kann NICHT mehr kicken (echtes Socket)', async () => {
    const { id, code, host } = await makeHostRoom({ slug: 'wer-ist-das', setup: {}, players: 2 });
    const target = await testPrisma.participation.findFirstOrThrow({ where: { roomId: id, role: 'PLAYER' } });
    // Kontrolle: ohne Entzug klappt das Kicken.
    const controlKick = await ack(host, 'room:kick', { roomCode: code, playerId: target.id });
    expect(controlKick, JSON.stringify(controlKick)).toMatchObject({ success: true });
    await testPrisma.participation.update({ where: { id: target.id }, data: { kickedAt: null, connected: true } });
    // Entzug (Revoke) — wirkt SOFORT auch auf das verbundene Socket.
    await testPrisma.roomPermissionGrant.create({ data: { roomId: id, userId: HOST_USER_ID, permission: 'PLAYER_MANAGE', direction: 'REVOKE', grantedBy: HOST_USER_ID } });
    const target2 = await testPrisma.participation.findFirstOrThrow({ where: { roomId: id, role: 'PLAYER', NOT: { id: target.id } } });
    const kickAfterRevoke = await ack(host, 'room:kick', { roomCode: code, playerId: target2.id });
    expect(kickAfterRevoke.success).toBe(false);
    expect(kickAfterRevoke.error).toBe('UNAUTHORIZED');
    const stillThere = await testPrisma.participation.findUniqueOrThrow({ where: { id: target2.id } });
    expect(stillThere.kickedAt).toBeNull(); // nicht gekickt
  }, 20000);
});

// ------------------------------------------------------------
// 14-10 — normalizeRole wirft Prototype-Namen weg
// ------------------------------------------------------------
describe('14-10: normalizeRole (Prototype-Sicherheit)', () => {
  it('constructor/__proto__/toString/hasOwnProperty → null; gültige + Legacy-Rolle korrekt', async () => {
    const { normalizeRole } = await import('@quiz/shared');
    expect(normalizeRole('constructor')).toBeNull();
    expect(normalizeRole('__proto__')).toBeNull();
    expect(normalizeRole('toString')).toBeNull();
    expect(normalizeRole('hasOwnProperty')).toBeNull();
    expect(normalizeRole('MODERATOR')).toBe('HOST');
    expect(normalizeRole('PLAYER')).toBe('PLAYER');
    expect(normalizeRole('ADMIN')).toBe('ADMIN');
    expect(normalizeRole('totally-unknown')).toBeNull();
    expect(normalizeRole(null)).toBeNull();
  });
});

// ------------------------------------------------------------
// 14-03 — Adapter-Socket-Grenzen (Geo + Jeopardy, echte Sockets)
// ------------------------------------------------------------
// Die Audit-Gegenprobe war WID-spezifisch (Event-Schema streicht
// stateVersion/expectedRevision vor der zentralen Prüfung). Die Systematik
// gilt für ALLE Adapter — hier direkt an den betroffenen Event-Grenzen
// belegt, nicht nur über den Shared-Resolver.
describe('14-03: Adapter-Socket-Grenzen (Geo + Jeopardy)', () => {
  it('Geo-Adapter (echtes Socket): negative stateVersion + widersprüchliches expectedRevision → VOR der Mutation abgelehnt, keine Mutation', async () => {
    const { id, code, host } = await makeHostRoom({ slug: 'wissensduell', setup: {}, players: 2 });
    const revBefore = (await testPrisma.room.findUniqueOrThrow({ where: { id } })).revision;
    // Widersprüchliche Versionserwartung (stateVersion 1, expectedRevision 2)
    // + negatives stateVersion in einem zweiten Versuch — beides muss
    // INVALID_PAYLOAD sein, NICHT still gestrichen oder Legacy-Pfad.
    const res = await ack(host, 'geo:reveal', { roomCode: code, commandId: 'geo-c1', stateVersion: 1, expectedRevision: 2, protocolVersion: 1 });
    expect(res.success).toBe(false);
    expect(res.error).toBe('INVALID_PAYLOAD');
    const resNeg = await ack(host, 'geo:reveal', { roomCode: code, commandId: 'geo-c2', stateVersion: -1, protocolVersion: 1 });
    expect(resNeg.success).toBe(false);
    expect(resNeg.error).toBe('INVALID_PAYLOAD');
    const revAfter = (await testPrisma.room.findUniqueOrThrow({ where: { id } })).revision;
    expect(revAfter).toBe(revBefore); // keine Mutation
  });

  it('Jeopardy-Adapter (echtes Socket): falsch typisierte stateVersion → VOR der Mutation abgelehnt, keine Mutation', async () => {
    const { id, host } = await makeHostRoom({ slug: 'jeopardy', setup: {}, players: 2 });
    const revBefore = (await testPrisma.room.findUniqueOrThrow({ where: { id } })).revision;
    // Falscher Typ (String statt Zahl) → Schema-Grenze lehnt ab (zod
    // z.number().int() auf stateVersion). Das Feld wird nicht still
    // entfernt, sondern abgelehnt.
    const res = await ack(host, 'jeopardy:next', { commandId: 'jp-c1', stateVersion: 'abc', protocolVersion: 1 });
    expect(res.success).toBe(false);
    const revAfter = (await testPrisma.room.findUniqueOrThrow({ where: { id } })).revision;
    expect(revAfter).toBe(revBefore); // keine Mutation
  }, 20000);
});

// ------------------------------------------------------------
// 14-03/14-01 — resolveCommandContextForSocket: echte Socket-Grenze
// ------------------------------------------------------------
describe('14-03: resolveCommandContextForSocket an der echten Grenze', () => {
  it('widersprüchliche commandId/requestId → INVALID_PAYLOAD; fehlender Token → commandMode=false', () => {
    const socket = { data: { roomId: 'room-1', role: 'HOST', participationId: 'p1' } };
    // Widerspruch → abgelehnt.
    const conflict = resolveCommandContextForSocket({ commandId: 'A', requestId: 'B', roomCode: '123-456' }, socket as never);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toBe('INVALID_PAYLOAD');
    // Negatives stateVersion → abgelehnt.
    const neg = resolveCommandContextForSocket({ commandId: 'A', roomCode: '123-456', stateVersion: -5 }, socket as never);
    expect(neg.ok).toBe(false);
    // Kein Token → commandMode false (Legacy-Pfad, kein Receipt).
    const legacy = resolveCommandContextForSocket({ roomCode: '123-456' }, socket as never);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.ctx.commandMode).toBe(false);
    // Gültiges Token + roomCode → commandMode true + Envelope.
    const good = resolveCommandContextForSocket({ commandId: 'A', roomCode: '123-456', stateVersion: 0 }, socket as never);
    expect(good.ok).toBe(true);
    if (good.ok) { expect(good.ctx.commandMode).toBe(true); expect(good.ctx.envelope?.commandId).toBe('A'); }
  });
});


it('14-10: the live permission boundary rejects unknown/prototype roles without throwing', async () => {
  for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'SUPERUSER']) {
    const socket = { id: randomUUID(), data: { roomId: 'unknown-role-room', role } } as Socket;
    expect(await requireGamePermission(socket, 'GAME_START')).toEqual({ ok: false, error: 'ROLE_REQUIRED', code: 'ROLE_REQUIRED' });
  }
});
