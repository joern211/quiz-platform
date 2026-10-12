// ============================================================
// BASIS-STANDARDS — Abnahme C: Command-Envelope, Protokoll, Replay
// ============================================================
//   C1: Zentrale Envelope — requestId↔commandId, stateVersion↔expectedRevision
//       kompatibel; Widerspruch → Ablehnung.
//   C2: protocolVersion=1 ok; EXPLIZIT inkompatible Version (2) →
//       CLIENT_VERSION_UNSUPPORTED VOR jeder Mutation; fehlende Version =
//       dokumentierter Legacy-Pfad.
//   C4: Command-Receipts: identischer Command seriell UND parallel → genau
//       EINE fachliche Wirkung; Duplicate liefert gespeicherte Antwort.
//       Failed-Command → sicherer Retry ohne Doppelwirkung.
// Läuft gegen die geseedete Test-DB mit echten Sockets + Prisma.
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../../persistence/prisma.js';
import { setupSocketHandlers } from '../../sockets/index.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { runReceipted } from '../core/commands.js';
import { checkCommandProtocolVersion } from '../core/commandContext.js';

const ack = gameAck;

describe('C: Command-Envelope + Protokoll + Replay', () => {
  let httpServer: HttpServer;
  let io: Server;
  let origin: string;
  const sockets: ClientSocket[] = [];
  const prismaC: PrismaClient = prisma;
  let roomId: string;
  let roomCode: string;
  let cleanupPackId: string;
  let hostSocket: ClientSocket;
  const HOST_USER_ID = 'mod-1';

  async function connect(cookie?: string): Promise<ClientSocket> {
    const s = await connectGameClient(origin, cookie);
    sockets.push(s);
    return s;
  }

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: HOST_USER_ID }, update: {},
      create: { id: HOST_USER_ID, displayName: 'C Host', passwordHash: 'x', role: 'HOST' },
    });
    await prisma.gameDefinition.upsert({
      where: { slug: 'geo' }, update: {},
      create: { slug: 'geo', name: 'Wissensduell (Geo)', category: 'Knowledge', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10, engineVersion: 3 },
    });
    await prisma.session.create({ data: { id: `sess-c-${randomUUID()}`, userId: HOST_USER_ID, expiresAt: new Date(Date.now() + 60000) } });
    const hostSession = await prisma.session.findFirst({ where: { userId: HOST_USER_ID }, orderBy: { createdAt: 'desc' } });

    // Deterministische Geo-Fragen für den Start (independent vom Seed).
    const pack = await prisma.questionPack.create({ data: { gameSlug: 'geo', title: 'C Pack', status: 'PUBLISHED' } });
    cleanupPackId = pack.id;
    const q1 = await prisma.geoQuestion.create({ data: { packId: pack.id, prompt: 'Hauptstadt FR?', category: 'Geo', options: JSON.stringify([{ id: 'a', text: 'London' }, { id: 'b', text: 'Paris' }]), correctOptionId: 'b' } });
    const q2 = await prisma.geoQuestion.create({ data: { packId: pack.id, prompt: 'Hauptstadt DE?', category: 'Geo', options: JSON.stringify([{ id: 'a', text: 'Berlin' }, { id: 'b', text: 'Hamburg' }]), correctOptionId: 'a' } });

    roomCode = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
    const room = await prisma.room.create({
      data: {
        code: roomCode, roomName: 'C Replay Raum',
        gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id,
        hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY', viewerRequiresPin: false,
        setupSnapshotJson: JSON.stringify({ selectedQuestionIds: [q1.id, q2.id] }),
      },
    });
    roomId = room.id;
    // 2 ready Player → game:start kann nach Guard erfolgreich sein.
    for (const name of ['P1', 'P2']) {
      await prisma.participation.create({
        data: { roomId, displayName: name, normalizedName: `${name.toLowerCase()}-c`, role: 'PLAYER', rejoinToken: randomUUID(), connected: true, ready: true },
      });
    }

    httpServer = createServer();
    io = new Server(httpServer);
    setupSocketHandlers(io);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${address.port}`;

    hostSocket = await connect(createSessionCookie(hostSession!.id, config.sessionSecret));
    expect((await ack(hostSocket, 'room:subscribe', { roomCode })).success).toBe(true);
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
    await prisma.commandReceipt.deleteMany({ where: { roomId } });
    await prisma.participation.deleteMany({ where: { roomId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    // NUR die eigenen Test-Fragen/Packs räumen — nie global (Sonstige
    // Testdateien in derselben Suite brauchen die geseedeten Fragen).
    await prisma.geoQuestion.deleteMany({ where: { packId: cleanupPackId } });
    await prisma.questionPack.deleteMany({ where: { id: cleanupPackId } });
  });

  it('C1: Envelope — requestId↔commandId / stateVersion↔expectedRevision, Widerspruch abgelehnt', async () => {
    const { resolveCommandEnvelope } = await import('@quiz/shared');
    // Legacy requestId → commandId.
    expect(resolveCommandEnvelope({ requestId: 'r-1', roomCode: 'X' })?.commandId).toBe('r-1');
    // Neues commandId.
    expect(resolveCommandEnvelope({ commandId: 'c-1', roomCode: 'X' })?.commandId).toBe('c-1');
    // Gleiche Werte (commandId === requestId) → ok.
    expect(resolveCommandEnvelope({ commandId: 'same', requestId: 'same', roomCode: 'X' })?.commandId).toBe('same');
    // Widerspruch commandId ≠ requestId → null.
    expect(resolveCommandEnvelope({ commandId: 'a', requestId: 'b', roomCode: 'X' })).toBeNull();
    // stateVersion/expectedRevision kompatibel.
    expect(resolveCommandEnvelope({ commandId: 'c', roomCode: 'X', expectedRevision: 5 })?.stateVersion).toBe(5);
    expect(resolveCommandEnvelope({ commandId: 'c', roomCode: 'X', stateVersion: 7 })?.stateVersion).toBe(7);
    // Widerspruch stateVersion ≠ expectedRevision → null.
    expect(resolveCommandEnvelope({ commandId: 'c', roomCode: 'X', stateVersion: 1, expectedRevision: 2 })).toBeNull();
    // Kein Token → null (Legacy-Modus, kein Receipt).
    expect(resolveCommandEnvelope({ roomCode: 'X' })).toBeNull();
  });

  it('C2: inkompatible protocolVersion (2) → CLIENT_VERSION_UNSUPPORTED VOR Mutation; v1/missing ok', async () => {
    const { PROTOCOL_VERSION, isSupportedProtocolVersion } = await import('@quiz/shared');
    expect(PROTOCOL_VERSION).toBe(1);
    expect(isSupportedProtocolVersion(1)).toBe(true);
    expect(isSupportedProtocolVersion(2)).toBe(false);
    expect(checkCommandProtocolVersion(undefined)).toBeNull(); // Legacy
    expect(checkCommandProtocolVersion(1)).toBeNull();
    expect(checkCommandProtocolVersion(2)).toBe('CLIENT_VERSION_UNSUPPORTED');

    // Echt: Host sendet game:start mit protocolVersion=2 → abgelehnt VOR
    // Mutation (Room bleibt LOBBY, kein RUNNING).
    const rejected = await ack(hostSocket, 'game:start', { roomCode, protocolVersion: 2 });
    expect(rejected.success).toBe(false);
    expect(rejected.error).toBe('CLIENT_VERSION_UNSUPPORTED');
    const roomAfter = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(roomAfter.status).toBe('LOBBY');

    // protocolVersion=1 (oder missing) → Guard + Start-Prüfungen laufen (kein
    // Protocol-Abbruch). Deterministisch: 2 ready Player + Fragen → Start.
    const withV1 = await ack(hostSocket, 'game:start', { roomCode, protocolVersion: 1 });
    expect(withV1.error).not.toBe('CLIENT_VERSION_UNSUPPORTED');
    expect(withV1.success).toBe(true);
    // Nach erfolgreichem Start: Room ist RUNNING (Mutation fand statt).
    const roomV1 = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(roomV1.status).toBe('RUNNING');
  });

  it('C4: serialer Duplicate → gespeicherte Antwort, genau eine fachliche Wirkung', async () => {
    // Reset: neuen Raum, damit GAME_START neu claimbar ist.
    const room2 = await prisma.room.create({
      data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'C Replay 2',
        gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id,
        hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY',
      },
    });
    const roomId2 = room2.id;
    for (const name of ['R1', 'R2']) {
      await prisma.participation.create({
        data: { roomId: roomId2, displayName: name, normalizedName: `${name.toLowerCase()}-c2`, role: 'PLAYER', rejoinToken: randomUUID(), connected: true, ready: true },
      });
    }

    // Fachliche Mutation: CAS (LOBBY→RUNNING) in einer TX (Engine-CAS).
    let mutations = 0;
    const commandId = `cmd-${randomUUID()}`;
    const mutate = async () => prisma.$transaction(async (tx) => {
      const cas = await tx.room.updateMany({
        where: { id: roomId2, status: 'LOBBY' },
        data: { status: 'RUNNING', runPhase: 'INTRO', revision: { increment: 1 } },
      });
      if (cas.count !== 1) throw new Error('STATE_CONFLICT');
      mutations += 1;
      return { started: true };
    });

    const first = await runReceipted(prismaC, {
      roomId: roomId2, commandId,
      actor: { actorId: 'host-part', actorRole: 'HOST' },
      action: 'GAME_START', payload: { roomCode: 'x' },
      mutate, toResponse: (d) => ({ success: true, ...d }),
    });
    expect(first.success).toBe(true);
    expect(first.replayed).toBe(false);
    expect(mutations).toBe(1);

    // Serialer Duplicate (gleicher commandId) → gespeicherte Antwort,
    // replayed:true, keine zweite Mutation.
    const dup = await runReceipted(prismaC, {
      roomId: roomId2, commandId,
      actor: { actorId: 'host-part', actorRole: 'HOST' },
      action: 'GAME_START', payload: { roomCode: 'x' },
      mutate, toResponse: (d) => ({ success: true, ...d }),
    });
    expect(dup.success).toBe(true);
    expect(dup.replayed).toBe(true);
    expect(mutations).toBe(1); // keine zweite fachliche Wirkung

    await prisma.room.delete({ where: { id: roomId2 } });
  });

  it('C4 (parallel): parallel identische Commands → genau eine fachliche Wirkung', async () => {
    const room3 = await prisma.room.create({
      data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'C Parallel',
        gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id,
        hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY',
      },
    });
    const roomId3 = room3.id;
    let mutations = 0;
    const commandId = `cmd-${randomUUID()}`;
    // Echter Engine-Flow: CAS-geschützte State-Mutation in einer TX
    // (saveGameStateIfRevision-Äquivalent). Der Duplicate wird vom
    // atomaren PENDING-Claim (roomId, commandId) von runReceipted gehalten,
    // bis der Gewinner committet — dadurch läuft die Mutation nur einmal.
    const mutate = async () => prisma.$transaction(async (tx) => {
      const cas = await tx.room.updateMany({
        where: { id: roomId3, status: 'LOBBY' },
        data: { status: 'RUNNING', runPhase: 'INTRO', revision: { increment: 1 } },
      });
      if (cas.count !== 1) throw new Error('STATE_CONFLICT');
      mutations += 1;
      await new Promise((r) => setTimeout(r, 10)); // kleine Überlappung
      return { ok: true };
    });

    const [a, b] = await Promise.all([
      runReceipted(prismaC, { roomId: roomId3, commandId, actor: { actorId: 'p', actorRole: 'HOST' }, action: 'GAME_START', payload: { r: 1 }, mutate, toResponse: (d) => ({ success: true, ...d }) }),
      runReceipted(prismaC, { roomId: roomId3, commandId, actor: { actorId: 'p', actorRole: 'HOST' }, action: 'GAME_START', payload: { r: 1 }, mutate, toResponse: (d) => ({ success: true, ...d }) }),
    ]);
    // Genau EINE fachliche Wirkung (Mutation + CAS) — das ist die Garantie.
    expect(mutations).toBe(1);
    // Gewinner ist original, der Duplicate liefert die gespeicherte Antwort.
    const sorted = [a, b].sort((x, y) => Number(x.replayed) - Number(y.replayed));
    expect(sorted[0].replayed).toBe(false);
    expect(sorted[1].replayed).toBe(true);
    expect(sorted[1].success).toBe(sorted[0].success); // gespeicherte Antwort
    // Nur genau ein COMPLETED-Receipt für den Command (kein doppeltes Claim).
    const receipts = await prisma.commandReceipt.findMany({ where: { roomId: roomId3, commandId } });
    expect(receipts.length).toBe(1);
    expect(receipts[0].status).toBe('COMPLETED');

    await prisma.room.delete({ where: { id: roomId3 } });
  });

  it('C5: FAILED-Command → sicherer Retry (kein Erfolgseintrag, neue Wirkung erlaubt)', async () => {
    const room4 = await prisma.room.create({
      data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'C Retry',
        gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id,
        hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY',
      },
    });
    const roomId4 = room4.id;
    const commandId = `cmd-${randomUUID()}`;
    let attempts = 0;
    const mutate = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('DB_FAILOVER'); // erster Versuch schlägt fehl
      const cas = await prisma.room.updateMany({
        where: { id: roomId4, status: 'LOBBY' },
        data: { status: 'RUNNING', revision: { increment: 1 } },
      });
      if (cas.count !== 1) throw new Error('STATE_CONFLICT');
      return { ok: true };
    };
    const ctx = { roomId: roomId4, commandId, actor: { actorId: 'p', actorRole: 'HOST' }, action: 'GAME_START' as const, payload: { r: 1 }, mutate, toResponse: (d: { ok: boolean }) => ({ success: d.ok, ...d }) };

    // Erster Versuch: Mutation wirft → FAILED, kein Erfolgseintrag.
    await expect(runReceipted(prismaC, ctx)).rejects.toThrow('DB_FAILOVER');
    const row1 = await prisma.commandReceipt.findUnique({ where: { roomId_commandId: { roomId: roomId4, commandId } } });
    expect(row1?.status).toBe('FAILED');

    // Retry (gleicher commandId) → diesmal Erfolg.
    const retried = await runReceipted(prismaC, ctx);
    expect(retried.success).toBe(true);
    expect(retried.replayed).toBe(false);
    const row2 = await prisma.commandReceipt.findUnique({ where: { roomId_commandId: { roomId: roomId4, commandId } } });
    expect(row2?.status).toBe('COMPLETED');

    await prisma.room.delete({ where: { id: roomId4 } });
  });

  it('C6: gleicher commandId mit anderer Akteur-/Payload-Identität → COMMAND_CONFLICT', async () => {
    const room5 = await prisma.room.create({
      data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'C Conflict',
        gameDefinitionId: (await prisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id,
        hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY',
      },
    });
    const roomId5 = room5.id;
    const commandId = `cmd-${randomUUID()}`;
    const mutate = async () => { await new Promise((r) => setTimeout(r, 5)); return { ok: true }; };

    // Akteur A claimt (COMPLETED).
    await runReceipted(prismaC, { roomId: roomId5, commandId, actor: { actorId: 'A', actorRole: 'HOST' }, action: 'GAME_START', payload: { p: 1 }, mutate, toResponse: () => ({ success: true }) });
    // Akteur B mit GLEICHEM commandId → kontrollierte Ablehnung, keine
    // fremden Ergebnisse/Rechte.
    const conflict = await runReceipted(prismaC, { roomId: roomId5, commandId, actor: { actorId: 'B', actorRole: 'HOST' }, action: 'GAME_START', payload: { p: 1 }, mutate, toResponse: () => ({ success: true }) });
    expect(conflict.success).toBe(false);
    expect((conflict as { error: string }).error).toBe('COMMAND_CONFLICT');

    await prisma.room.delete({ where: { id: roomId5 } });
  });
});
