// ============================================================
// BASIS-STANDARDS — Abnahme B: Gemeinsame Berechtigungsprüfung
// + Trennung Verwaltungs-/Secret-Rechte (Grant/Revoke)
// ============================================================
// Läuft gegen die migrierte, geseedete Test-DB mit echten Socket.IO-
// Verbindungen und den produktionsgleichen Event-Handler.
//
//   B1: 11 Rechte zentral definiert; Rollen liefern Defaultpakete.
//   B2: Grant wirkt; Entzug (Revoke) wird auch bei BEREITS VERBUNDENEM
//       Socket verweigert (Re-Read der DB pro Aktion, kein gecachter Wert).
//   B3: Guard in kritischen Aktionen (game:start): falsche Rolle → verweigert;
//       Cross-Room-Claim des Clients ersetzt keine Membership; kein Socket →
//       NOT_IN_ROOM.
//   B4: Delegiertes Einzelrecht (z.B. GAME_PAUSE) verleiht KEIN Secret-Recht
//       (JUDGE/REVEAL).
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { PrismaClient } from '@prisma/client';
let testPrisma: PrismaClient;
import { setupSocketHandlers } from '../../sockets/index.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';

const ack = gameAck;

describe('B: Permission Core + Grant/Revoke (echte Sockets)', () => {
  let httpServer: HttpServer;
  let io: Server;
  let origin: string;
  const sockets: ClientSocket[] = [];
  let roomId: string;
  let roomCode: string;
  let hostSocket: ClientSocket;
  let playerSocket: ClientSocket;
  let viewerSocket: ClientSocket;
  const HOST_USER_ID = 'mod-1';
  const PLAYER_REJOIN = randomUUID();

  async function connect(cookie?: string): Promise<ClientSocket> {
    const s = await connectGameClient(origin, cookie);
    sockets.push(s);
    return s;
  }

  beforeAll(async () => {
    // Eigener gültiger Client auf DATABASE_URL (Isolation, vmForks isolate:false):
    // vorbestehende Temp-DB-Tests lassen globalThis.__prisma einen TOTEN Client
    // (disconnect + rm) stehen → wir patchen den Global auf unseren Client.
    const { PrismaClient } = await import('@prisma/client');
    testPrisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    await testPrisma.$connect();
    (globalThis as Record<string, unknown>).__prisma = testPrisma;
    // Host-User (idempotent, funktioniert mit oder ohne Seed).
    await testPrisma.user.upsert({
      where: { id: HOST_USER_ID },
      update: {},
      create: { id: HOST_USER_ID, displayName: 'B Host', passwordHash: 'x', role: 'HOST' },
    });
    // Game-Definition sicherstellen (Seed liefert sie; upsert = robust).
    await testPrisma.gameDefinition.upsert({
      where: { slug: 'geo' },
      update: {},
      create: { slug: 'geo', name: 'Wissensduell (Geo)', category: 'Knowledge', status: 'AVAILABLE', minPlayers: 2, maxPlayers: 10, engineVersion: 3 },
    });
    // Host-Session für den eingeloggten Host-Client.
    await testPrisma.session.create({ data: { id: `sess-b-${randomUUID()}`, userId: HOST_USER_ID, expiresAt: new Date(Date.now() + 60000) } });
    const hostSession = await testPrisma.session.findFirst({ where: { userId: HOST_USER_ID }, orderBy: { createdAt: 'desc' } });

    roomCode = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
    const room = await testPrisma.room.create({
      data: {
        code: roomCode, roomName: 'B Perm Raum',
        gameDefinitionId: (await testPrisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id,
        hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY', viewerRequiresPin: false,
      },
    });
    roomId = room.id;
    await testPrisma.participation.create({
      data: { roomId, displayName: 'Alice', normalizedName: 'alice-b', role: 'PLAYER', rejoinToken: PLAYER_REJOIN, connected: true, ready: true },
    });

    httpServer = createServer();
    io = new Server(httpServer);
    setupSocketHandlers(io);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    origin = `http://127.0.0.1:${address.port}`;

    // Host (eingeloggte Session) → Rolle HOST + userId.
    hostSocket = await connect(createSessionCookie(hostSession!.id, config.sessionSecret));
    expect((await ack(hostSocket, 'room:subscribe', { roomCode })).success).toBe(true);
    // Player (Guest via Rejoin-Token) → Rolle PLAYER, userId null.
    playerSocket = await connect();
    expect((await ack(playerSocket, 'room:subscribe', { roomCode, rejoinToken: PLAYER_REJOIN })).success).toBe(true);
    // Viewer (ohne Login) → Rolle VIEWER.
    viewerSocket = await connect();
    expect((await ack(viewerSocket, 'room:subscribe', { roomCode })).success).toBe(true);
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
    await testPrisma.commandReceipt.deleteMany({ where: { roomId } });
    await testPrisma.roomPermissionGrant.deleteMany({ where: { roomId } });
    await testPrisma.participation.deleteMany({ where: { roomId } });
    await testPrisma.room.deleteMany({ where: { id: roomId } });
    // Isolation: toten Client NICHT im worker-weiten Global lassen →
    // der lazy Proxy legt bei nächstem Zugriff einen frischen Client an.
    await testPrisma.$disconnect();
    (globalThis as Record<string, unknown>).__prisma = undefined;
  });

  it('B1: 11 Rechte zentral definiert; Rollen liefern Defaultpakete (Secret ≠ Verwaltung)', async () => {
    const { GAME_PERMISSIONS, ROLE_PLAYER_PERMISSIONS, effectivePermissions, hasPermission } = await import('@quiz/shared');
    expect([...GAME_PERMISSIONS].sort()).toEqual([
      'BUZZER_CONTROL', 'GAME_ABORT', 'GAME_PAUSE', 'GAME_START', 'JUDGE_ANSWER',
      'PLAYER_MANAGE', 'REVEAL_CONTENT', 'ROUND_ADVANCE', 'SCORE_ADJUST', 'TEAM_MANAGE', 'TIMER_CONTROL',
    ].sort());
    // HOST-Default trägt Verwaltungsrechte.
    expect(hasPermission(effectivePermissions('HOST', [], []), 'GAME_START')).toBe(true);
    // PLAYER-Default: genau BUZZER_CONTROL, kein GAME_START.
    expect(ROLE_PLAYER_PERMISSIONS).toEqual(['BUZZER_CONTROL']);
    expect(hasPermission(effectivePermissions('PLAYER', [], []), 'GAME_START')).toBe(false);
    expect(hasPermission(effectivePermissions('PLAYER', [], []), 'BUZZER_CONTROL')).toBe(true);
  });

  it('B2: Grant wirkt; Revoke wird auch bei bereits verbundenem Socket verweigert', async () => {
    // Kontrolle: Host hat GAME_START default → Guard läßt durch (keine
    // FORBIDDEN; hier NOT_ENOUGH_PLAYERS, da 0 Spieler). Kein Mutate.
    const before = await ack(hostSocket, 'game:start', { roomCode });
    expect(before.error).toBe('NOT_ENOUGH_PLAYERS');
    expect(before.success).toBe(false);

    // Entzug: GAME_START vom Host wegnehmen → wirkt SOFORT auf demselben,
    // bereits verbundenen Socket (DB-Neu-Lese pro Aktion, kein gecachter Wert).
    await testPrisma.roomPermissionGrant.create({
      data: { roomId, userId: HOST_USER_ID, permission: 'GAME_START', direction: 'REVOKE', grantedBy: 'admin-1' },
    });
    const revoked = await ack(hostSocket, 'game:start', { roomCode });
    expect(revoked.success).toBe(false);
    expect(revoked.error).toBe('UNAUTHORIZED');

    // Entzug aufheben (revokedAt) → Guard läßt wieder durch (kein Reconnect).
    await testPrisma.roomPermissionGrant.updateMany({
      where: { roomId, userId: HOST_USER_ID, permission: 'GAME_START', direction: 'REVOKE' },
      data: { revokedAt: new Date() },
    });
    const reGranted = await ack(hostSocket, 'game:start', { roomCode });
    expect(reGranted.error).toBe('NOT_ENOUGH_PLAYERS');
    expect(reGranted.success).toBe(false);
  });

  it('B3: Guard verweigert falsche Rolle, Cross-Room-Claim und fehlendes Socket', async () => {
    // Falsche Rolle: Player (kein GAME_START) → FORBIDDEN.
    const playerStart = await ack(playerSocket, 'game:start', { roomCode });
    expect(playerStart.success).toBe(false);
    expect(playerStart.error).toBe('UNAUTHORIZED');
    // Viewer (keine Rechte) → FORBIDDEN.
    const viewerStart = await ack(viewerSocket, 'game:start', { roomCode });
    expect(viewerStart.success).toBe(false);
    expect(viewerStart.error).toBe('UNAUTHORIZED');

    // Cross-Room: Player behauptet roomCode eines ANDEREN Raums. Die
    // Berechtigung wird aus der serverseitigen Socket-Identität (nicht aus
    // dem Payload) aufgelöst → bleibt an den tatsächlichen Raum gebunden.
    const other = await testPrisma.room.create({
      data: {
        code: String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: 'Other', gameDefinitionId: (await testPrisma.gameDefinition.findUniqueOrThrow({ where: { slug: 'geo' } })).id,
        hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY',
      },
    });
    const cross = await ack(playerSocket, 'game:start', { roomCode: other.code });
    expect(cross.success).toBe(false);
    expect(cross.error).toBe('NOT_IN_ROOM'); // Membership aus Socket-Identität, nicht Payload
    await testPrisma.room.delete({ where: { id: other.id } });

    // Kein Socket-Identität → NOT_IN_ROOM.
    const outsider = await connect();
    const notInRoom = await ack(outsider, 'game:start', { roomCode });
    expect(notInRoom.success).toBe(false);
    expect(notInRoom.error).toBe('NOT_IN_ROOM');
  });

  it('B4: Delegiertes Einzelrecht verleiht kein Secret-Recht (kein JUDGE/REVEAL)', async () => {
    const { effectivePermissions, hasPermission } = await import('@quiz/shared');
    // Ein PLAYER bekommt NUR GAME_PAUSE delegiert → erhält damit genau
    // PLAYER-Default + GAME_PAUSE, aber KEIN Secret-Recht.
    const delegated = effectivePermissions('PLAYER', ['GAME_PAUSE'], []);
    expect(hasPermission(delegated, 'GAME_PAUSE')).toBe(true);
    expect(hasPermission(delegated, 'BUZZER_CONTROL')).toBe(true); // Default bleibt
    expect(hasPermission(delegated, 'JUDGE_ANSWER')).toBe(false);
    expect(hasPermission(delegated, 'REVEAL_CONTENT')).toBe(false);
    expect(hasPermission(delegated, 'SCORE_ADJUST')).toBe(false);
    expect(hasPermission(delegated, 'GAME_START')).toBe(false);
  });
});
