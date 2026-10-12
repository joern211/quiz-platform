// ============================================================
// BASIS-STANDARDS — Abnahme E: Konfiguration, Revisionsschutz,
// Start-Snapshots (7-Ebenen, Änderungsklassen, CAS)
// ============================================================
//   E1: Resolver behält false/0/null; ungültige Werte abgelehnt.
//   E2: 7-Ebenen-Priorität (spezifischer gewinnt).
//   E3: LOCKED_AFTER_START nach Start nicht live änderbar; EDITABLE schon.
//   E4: Unveränderlicher Start-Snapshot (gameSlug + engineVersion); bleibt
//       nach Live-Änderung unverändert (echter Start via game:start).
//   E5: Fachliche Änderung erhöht Revision; No-op nicht; Konflikt →
//       REVISION_CONFLICT (Optimistic Locking via CAS).
// Läuft gegen die geseedete Test-DB mit echten Sockets + Prisma.
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../../persistence/prisma.js';
import { setupSocketHandlers } from '../../sockets/index.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { resolveGameConfig, GAME_CONFIG_FIELDS, persistConfigSnapshot, loadGameConfig, updateRoomConfig } from '../core/config.js';
import type { GameConfigSnapshot } from '@quiz/shared';

const ack = gameAck;
const HOST_USER_ID = 'mod-1';

describe('E: Config-Resolver + Start-Snapshot + Revision', () => {
  let httpServer: HttpServer;
  let io: Server;
  let origin: string;
  const sockets: ClientSocket[] = [];
  let hostSocket: ClientSocket;
  const cleanupPackIds: string[] = [];

  async function connect(cookie?: string): Promise<ClientSocket> {
    const s = await connectGameClient(origin, cookie);
    sockets.push(s);
    return s;
  }

  beforeAll(async () => {
    await prisma.user.upsert({ where: { id: HOST_USER_ID }, update: {}, create: { id: HOST_USER_ID, displayName: 'E Host', passwordHash: 'x', role: 'HOST' } });
    await prisma.gameDefinition.upsert({ where: { slug: 'geo' }, update: {}, create: { slug: 'geo', name: 'Wissensduell (Geo)', category: 'Knowledge', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10, engineVersion: 3 } });
    await prisma.session.create({ data: { id: `sess-e-${randomUUID()}`, userId: HOST_USER_ID, expiresAt: new Date(Date.now() + 60000) } });
    const hostSession = await prisma.session.findFirst({ where: { userId: HOST_USER_ID }, orderBy: { createdAt: 'desc' } });

    httpServer = createServer();
    io = new Server(httpServer);
    setupSocketHandlers(io);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${address.port}`;
    hostSocket = await connect(createSessionCookie(hostSession!.id, config.sessionSecret));
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
    // NUR die eigenen Test-Fragen/Packs räumen — nie global (andere
    // Testdateilen in derselben Suite brauchen die geseedeten Fragen).
    if (cleanupPackIds.length) {
      await prisma.geoQuestion.deleteMany({ where: { packId: { in: cleanupPackIds } } });
      await prisma.questionPack.deleteMany({ where: { id: { in: cleanupPackIds } } });
    }
  });

  // ── E1/E2: Resolver (reine Funktion, deterministisch) ──────────────
  it('E1: Resolver behält 0/false (kein value||default); ungültige Einheiten abgelehnt', async () => {
    // timerDurationMs: 0 bleibt 0 (nicht durch Default ersetzt).
    const r = resolveGameConfig('geo', { gameConfig: { timerDurationMs: 0 } });
    expect(r.timerDurationMs.value).toBe(0);
    expect(r.timerDurationMs.source).toBe('GAME_CONFIG');
    // questionCount: 0 bleibt 0.
    const r2 = resolveGameConfig('geo', { gameConfig: { questionCount: 0 } });
    expect(r2.questionCount.value).toBe(0);
    // Nicht gesetzt → SYSTEM_DEFAULT.
    const r3 = resolveGameConfig('geo', {});
    expect(r3.questionCount.value).toBe(GAME_CONFIG_FIELDS.geo.questionCount.systemDefault);
    expect(r3.questionCount.source).toBe('SYSTEM_DEFAULT');

    // updateRoomConfig lehnt ungültige Einheiten ab (count/durationMs < 0,
    // nicht-Integer, unbekanntes Feld).
    const room = await prisma.room.create({
      data: { code: `E1${Math.floor(Math.random() * 900000 + 100000)}`.replace(/(\d{3})(\d{3})/, '$1-$2'), roomName: 'E1', gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id, hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY' },
    });
    const invalidCases: Record<string, unknown>[] = [
      { questionCount: -1 }, { timerDurationMs: 2.5 }, { unknownField: 1 },
    ];
    for (const changes of invalidCases) {
      const res = await updateRoomConfig({ roomId: room.id, actorUserId: HOST_USER_ID, expectedRevision: room.revision, changes });
      if (res.ok) throw new Error(`expected rejection for ${JSON.stringify(changes)}`);
      expect(res.error).toBe('INVALID_CONFIG');
    }
    await prisma.room.delete({ where: { id: room.id } });
  });

  it('E2: 7-Ebenen-Priorität — spezifischer Ebene gewinnt', async () => {
    // Jedes Feld von einer anderen Ebene gesetzt → spezifischer gewinnt.
    const r = resolveGameConfig('geo', {
      systemDefault: { timerDurationMs: 1000 },
      hostDefault: { timerDurationMs: 2000 },
      roomTemplate: { timerDurationMs: 3000 },
      gamePreset: { timerDurationMs: 4000 },
      roomConfig: { timerDurationMs: 5000 },
      gameConfig: { timerDurationMs: 6000 },
      liveOverride: { timerDurationMs: 7000 },
    });
    expect(r.timerDurationMs.value).toBe(7000);
    expect(r.timerDurationMs.source).toBe('LIVE_OVERRIDE');

    // Ohne liveOverride → GAME_CONFIG.
    const r2 = resolveGameConfig('geo', {
      systemDefault: { timerDurationMs: 1000 },
      gameConfig: { timerDurationMs: 6000 },
    });
    expect(r2.timerDurationMs.value).toBe(6000);
    expect(r2.timerDurationMs.source).toBe('GAME_CONFIG');

    // questionCount aus ROOM_TEMPLATE, timer aus SYSTEM_DEFAULT (unabhängig).
    const r3 = resolveGameConfig('geo', { roomTemplate: { questionCount: 3 } });
    expect(r3.questionCount.value).toBe(3);
    expect(r3.questionCount.source).toBe('ROOM_TEMPLATE');
    expect(r3.timerDurationMs.source).toBe('SYSTEM_DEFAULT');
  });

  // ── E3/E4/E5: echter Start + Live-Änderung via geroutetem Socket ────
  it('E3+E4+E5: Start-Snapshot unveränderlich; LOCKED_AFTER_START gesperrt; Revision via CAS', async () => {
    // Geo-Raum mit 2 Fragen + 2 ready Player → game:start erfolgreich.
    const pack = await prisma.questionPack.create({ data: { gameSlug: 'geo', title: 'E Pack', status: 'PUBLISHED' } });
    cleanupPackIds.push(pack.id);
    const q1 = await prisma.geoQuestion.create({ data: { packId: pack.id, prompt: 'A?', category: 'G', options: JSON.stringify([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]), correctOptionId: 'a' } });
    const q2 = await prisma.geoQuestion.create({ data: { packId: pack.id, prompt: 'B?', category: 'G', options: JSON.stringify([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]), correctOptionId: 'b' } });
    const roomCode = `E4${Math.floor(Math.random() * 900000 + 100000)}`.replace(/(\d{3})(\d{3})/, '$1-$2');
    const room = await prisma.room.create({
      data: {
        code: roomCode, roomName: 'E Start',
        gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id,
        hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY',
        setupSnapshotJson: JSON.stringify({ selectedQuestionIds: [q1.id, q2.id], timerDuration: 25 }),
      },
    });
    for (const name of ['E1', 'E2']) {
      await prisma.participation.create({ data: { roomId: room.id, displayName: name, normalizedName: `${name.toLowerCase()}-e`, role: 'PLAYER', rejoinToken: randomUUID(), connected: true, ready: true } });
    }
    expect((await ack(hostSocket, 'room:subscribe', { roomCode })).success).toBe(true);

    // ── E4: Echter Start persistiert den unveränderlichen Start-Snapshot. ──
    const start = await ack(hostSocket, 'game:start', { roomCode });
    expect(start.success).toBe(true);
    const startedRoom = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(startedRoom.status).toBe('RUNNING');
    expect(startedRoom.configSchemaVersion).toBe(1);
    const snap: GameConfigSnapshot = JSON.parse(startedRoom.gameConfigSnapshotJson!);
    expect(snap.gameSlug).toBe('geo');
    expect(snap.engineVersion).toBe(1);
    // Legacy timerDuration 25s → 25000 ms im Snapshot (Auflösung, kein Default).
    expect(snap.values.timerDurationMs.value).toBe(25000);
    const snapshotJsonBefore = startedRoom.gameConfigSnapshotJson;

    // E4: EDITABLE-Live-Änderung überschreibt den START-Snapshot NICHT.
    const editable = await ack(hostSocket, 'room:config:update', { roomCode, expectedRevision: (await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).revision, changes: { timerDurationMs: 30000 } });
    expect(editable.success).toBe(true);
    const afterLive = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(afterLive.gameConfigSnapshotJson).toBe(snapshotJsonBefore); // unverändert
    // loadGameConfig: Snapshot + aktive Live-Überschreibung.
    const loaded = await loadGameConfig(afterLive, 'geo');
    expect(loaded?.fromSnapshot).toBe(true);
    expect(loaded?.values.timerDurationMs.value).toBe(30000);
    expect(loaded?.values.timerDurationMs.source).toBe('LIVE_OVERRIDE');
    expect(loaded?.values.questionCount.value).toBe(snap.values.questionCount.value);
    // E4 (persistConfigSnapshot direkt): dieselben Werte.
    const snap2 = await persistConfigSnapshot(afterLive, 'geo', 1);
    expect(snap2.values.questionCount.value).toBe(snap.values.questionCount.value);

    // Cleanup des gestarteten Raums (Engine läuft weiter; nur DB aufräumen).
    hostSocket.disconnect();
    await prisma.participation.deleteMany({ where: { roomId: room.id } });
    await prisma.room.delete({ where: { id: room.id } });

    // ── E3 + E5: stabeler RUNNING-Raum (ohne Engine-AfterStart-Bumps) ────
    const room2Code = `E5${Math.floor(Math.random() * 900000 + 100000)}`.replace(/(\d{3})(\d{3})/, '$1-$2');
    const room2 = await prisma.room.create({
      data: { code: room2Code, roomName: 'E5 stable', gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id, hostUserId: HOST_USER_ID, status: 'RUNNING', runPhase: 'ROUND_ACTIVE', setupSnapshotJson: JSON.stringify({ timerDuration: 25 }) },
    });
    await persistConfigSnapshot(room2, 'geo', 1); // Snapshot für deterministische Base
    const hostSocket2 = await connect(createSessionCookie((await prisma.session.findFirst({ where: { userId: HOST_USER_ID }, orderBy: { createdAt: 'desc' } }))!.id, config.sessionSecret));
    expect((await ack(hostSocket2, 'room:subscribe', { roomCode: room2Code })).success).toBe(true);
    const rev0 = (await prisma.room.findUniqueOrThrow({ where: { id: room2.id } })).revision;

    // E3: LOCKED_AFTER_START (questionCount) im RUNNING-Zustand gesperrt.
    const locked = await ack(hostSocket2, 'room:config:update', { roomCode: room2Code, expectedRevision: rev0, changes: { questionCount: 99 } });
    expect(locked.success).toBe(false);
    expect(locked.error).toBe('LOCKED_AFTER_START');

    // E3: EDITABLE (timerDurationMs) ist live änderbar; E5: Revision +1.
    const editable2 = await ack(hostSocket2, 'room:config:update', { roomCode: room2Code, expectedRevision: rev0, changes: { timerDurationMs: 30000 } });
    expect(editable2.success).toBe(true);
    expect(editable2.changed).toBe(true);
    const rev1 = (await prisma.room.findUniqueOrThrow({ where: { id: room2.id } })).revision;
    expect(rev1).toBe(rev0 + 1);

    // E5: No-op (gleicher Wert) → keine Revisionserhöhung.
    const noOp = await ack(hostSocket2, 'room:config:update', { roomCode: room2Code, expectedRevision: rev1, changes: { timerDurationMs: 30000 } });
    expect(noOp.success).toBe(true);
    expect(noOp.changed).toBe(false);
    const revAfterNoOp = (await prisma.room.findUniqueOrThrow({ where: { id: room2.id } })).revision;
    expect(revAfterNoOp).toBe(rev1);

    // E5: veraltete expectedRevision (valide, aber nicht aktuell) →
    // REVISION_CONFLICT, kein Überschreiben. (rev1=1, veraltet=0.)
    const stale = await ack(hostSocket2, 'room:config:update', { roomCode: room2Code, expectedRevision: Math.max(0, rev1 - 1), changes: { timerDurationMs: 35000 } });
    expect(stale.success).toBe(false);
    expect(stale.error).toBe('REVISION_CONFLICT');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room2.id } })).revision).toBe(rev1);

    // Cleanup.
    hostSocket2.disconnect();
    await prisma.participation.deleteMany({ where: { roomId: room2.id } });
    await prisma.room.delete({ where: { id: room2.id } });
    // NUR die eigenen Test-Fragen/Packs räumen — nie global.
    if (cleanupPackIds.length) {
      await prisma.geoQuestion.deleteMany({ where: { packId: { in: cleanupPackIds } } });
      await prisma.questionPack.deleteMany({ where: { id: { in: cleanupPackIds } } });
    }
  });
});
