// ============================================================
// BASIS-STANDARDS — F5: Wiederverwendbares Contract-Testgerüst
// ============================================================
// `contractSuite(spec)` führt DIESELBEN Verifikationsprüfungen auf einer
// echten Engine aus (Master §13.2):
//   1. Protokoll: inkompatible protocolVersion → CLIENT_VERSION_UNSUPPORTED
//      VOR der Mutation.
//   2. Autorisierung: ein Viewer wird bei einer privilegierten Aktion
//      (game:pause / GAME_PAUSE) verweigert; der Host nicht.
//   3. Replay/CAS: identischer Command (commandId) → genau eine fachliche
//      Wirkung; das Duplicate liefert die gespeicherte Antwort (replayed).
//   4. Config-Snapshot: nach Start ist der unveränderliche Start-Snapshot
//      (configSchemaVersion=1, engineVersion) persistiert.
//
// Mindestens zwei UNTERSCHIEDLICHE echte Engines laufen diese Prüfung
// (geo + jeopardy). Eine bewusst falsche Rolle-/Replay-Bedingung lässt die
// Prüfung fehlgeschlagen (negative Kontrolle ist Teil jeder Assertion).
//
// Die Suite ist Engine-agnostisch: sie nutzt die generischen Game-Lifecycle-
// Events (game:start, game:pause), die alle Engines über die Guard-/Receipt-
// Schicht laufen — dadurch belegt sie den geteilten Core, nicht den
// Engine-Code.
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { PrismaClient } from '@prisma/client';
import { setupSocketHandlers } from '../../sockets/index.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';

const ack = gameAck;

// ── Dedizierter DB-Client (Isolation, vmForks isolate:false) ─────────────
// vitest läuft alle Dateien in EINEM Worker → globalThis.__prisma wird
// worker-weit geteilt. Vorbestehende Temp-DB-Tests patchen den Global auf
// einen eigenen Client und stellen ihn NICHT wieder her (disconnect + rm
// der Temp-DB). Wer danach auf den lazy Standard-Proxy (DATABASE_URL)
// zugreift, erbt einen TOTEN Client → "Error code 14: Unable to open the
// database file" (Nichtdeterminismus je nach Abschlussreihenfolge).
// Diese Suite nutzt daher einen EIGENEN gültigen Client auf DATABASE_URL,
// patcht den Global nur für die eigene Laufzeit (App-/Socket-Handler lesen
// ihn lazily) und setzt ihn in afterAll wieder auf undefined.
let activeContractClient: PrismaClient | undefined;
export async function contractClient(): Promise<PrismaClient> {
  if (activeContractClient) return activeContractClient;
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  await client.$connect();
  (globalThis as Record<string, unknown>).__prisma = client;
  activeContractClient = client;
  return client;
}
/** Disconnectet den Client und setzt den Global zurück (frischer
 *  Standard-Client bei nächstem Zugriff). Genau EINMAL pro Engine-Datei. */
export async function contractTeardown(): Promise<void> {
  if (activeContractClient) {
    await activeContractClient.$disconnect().catch(() => {});
    activeContractClient = undefined;
  }
  (globalThis as Record<string, unknown>).__prisma = undefined;
}

export interface ContractEngineSpec {
  /** Engine-Slug der Game-Definition (muss existieren). */
  slug: string;
  /** setupSnapshotJson für einen startbaren Raum. */
  setup: () => string;
  /** Anzahl ready-Player, damit game:start die MinPlayers-Prüfung besteht. */
  playerCount: number;
}

export function contractSuite(spec: ContractEngineSpec) {
  describe(`F5-Contract [Engine: ${spec.slug}]`, () => {
    let httpServer: HttpServer;
    let io: Server;
    let origin: string;
    const sockets: ClientSocket[] = [];
    const rooms: string[] = [];
    const HOST_USER_ID = 'mod-1';
    let contractPrisma: PrismaClient;

    async function connect(cookie?: string): Promise<ClientSocket> {
      const s = await connectGameClient(origin, cookie);
      sockets.push(s);
      return s;
    }

    async function makeRoom(): Promise<{ id: string; code: string }> {
      const code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
      const room = await contractPrisma.room.create({
        data: {
          code, roomName: `F5 ${spec.slug}`,
          gameDefinitionId: (await contractPrisma.gameDefinition.findUniqueOrThrow({ where: { slug: spec.slug } })).id,
          hostUserId: HOST_USER_ID, status: 'LOBBY', runPhase: 'LOBBY',
          setupSnapshotJson: spec.setup(),
        },
      });
      rooms.push(room.id);
      for (let i = 0; i < spec.playerCount; i++) {
        await contractPrisma.participation.create({
          data: { roomId: room.id, displayName: `P${i}`, normalizedName: `p${i}-${spec.slug}`, role: 'PLAYER', rejoinToken: randomUUID(), connected: true, ready: true },
        });
      }
      return { id: room.id, code };
    }

    beforeAll(async () => {
      contractPrisma = await contractClient();
      await contractPrisma.user.upsert({ where: { id: HOST_USER_ID }, update: {}, create: { id: HOST_USER_ID, displayName: 'F5 Host', passwordHash: 'x', role: 'HOST' } });
      await contractPrisma.gameDefinition.findUniqueOrThrow({ where: { slug: spec.slug } }).catch(() => {
        throw new Error(`Contract: Game-Definition ${spec.slug} fehlt (Seed nötig).`);
      });
      await contractPrisma.session.create({ data: { id: `sess-f5-${randomUUID()}`, userId: HOST_USER_ID, expiresAt: new Date(Date.now() + 60000) } });

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
      for (const id of rooms) {
        await contractPrisma.commandReceipt.deleteMany({ where: { roomId: id } });
        await contractPrisma.participation.deleteMany({ where: { roomId: id } });
        await contractPrisma.room.deleteMany({ where: { id } });
      }
      // Isolation: toten Client NICHT im worker-weiten Global lassen →
      // der lazy Proxy legt bei nächstem Zugriff einen frischen Client an.
      await contractTeardown();
    });

    it('1. Protokoll: inkompatible protocolVersion (2) → CLIENT_VERSION_UNSUPPORTED VOR Mutation', async () => {
      const { id, code } = await makeRoom();
      const h = await connect(createSessionCookie((await contractPrisma.session.findFirst({ where: { userId: HOST_USER_ID }, orderBy: { createdAt: 'desc' } }))!.id, config.sessionSecret));
      expect((await ack(h, 'room:subscribe', { roomCode: code })).success).toBe(true);
      const res = await ack(h, 'game:start', { roomCode: code, protocolVersion: 2 });
      expect(res.success).toBe(false);
      expect(res.error).toBe('CLIENT_VERSION_UNSUPPORTED');
      // VOR Mutation: Raum bleibt LOBBY.
      expect((await contractPrisma.room.findUniqueOrThrow({ where: { id } })).status).toBe('LOBBY');
    });

    it('2. Replay/CAS: identischer Command → genau eine Wirkung, Duplicate liefert gespeicherte Antwort', async () => {
      const { id, code } = await makeRoom();
      const h = await connect(createSessionCookie((await contractPrisma.session.findFirst({ where: { userId: HOST_USER_ID }, orderBy: { createdAt: 'desc' } }))!.id, config.sessionSecret));
      expect((await ack(h, 'room:subscribe', { roomCode: code })).success).toBe(true);
      const commandId = `f5-${randomUUID()}`;
      const first = await ack(h, 'game:start', { roomCode: code, commandId });
      expect(first.success).toBe(true);
      expect(first.replayed).toBeUndefined();
      expect((await contractPrisma.room.findUniqueOrThrow({ where: { id } })).status).toBe('RUNNING');
      const receipt1 = await contractPrisma.commandReceipt.findUnique({ where: { roomId_commandId: { roomId: id, commandId } } });
      expect(receipt1?.status).toBe('COMPLETED');

      // Identischer Command (gleiche Absicht) → gespeicherte Antwort, keine
      // zweite Start-Mutation (kein GAME_ALREADY_STARTED).
      const dup = await ack(h, 'game:start', { roomCode: code, commandId });
      expect(dup.replayed).toBe(true);
      // Raum bleibt genau einmal gestartet; keine Doppelwirkung.
      const roomAfter = await contractPrisma.room.findUniqueOrThrow({ where: { id } });
      expect(roomAfter.status).toBe('RUNNING');
      // Nur genau ein Receipt für den Command.
      const receipts = await contractPrisma.commandReceipt.findMany({ where: { roomId: id, commandId } });
      expect(receipts.length).toBe(1);
    });

    it('3. Autorisierung: Viewer wird bei privilegierter Aktion (GAME_PAUSE) vom Guard verweigert; Host NICHT', async () => {
      const { code } = await makeRoom();
      // Host startet (Legitimation für GAME_PAUSE vorhanden).
      const h = await connect(createSessionCookie((await contractPrisma.session.findFirst({ where: { userId: HOST_USER_ID }, orderBy: { createdAt: 'desc' } }))!.id, config.sessionSecret));
      expect((await ack(h, 'room:subscribe', { roomCode: code })).success).toBe(true);
      expect((await ack(h, 'game:start', { roomCode: code })).success).toBe(true);
      // Viewer im selben Raum (kein Login → keine GAME_PAUSE-Berechtigung).
      const v = await connect();
      expect((await ack(v, 'room:subscribe', { roomCode: code })).success).toBe(true);

      // DIE Autorisierungs-Garantie (engine-agnostisch): Die privilegierte
      // Aktion wird dem VIEWER vom Permission-Guard verweigert — negativ:
      // wäre die Guard-Prüfung ausgehebelt, wäre der Viewer nicht
      // UNAUTHORIZED und diese Assertion schlägt fehl.
      const viewerPause = await ack(v, 'game:pause', { roomCode: code });
      expect(viewerPause.success).toBe(false);
      expect(viewerPause.error).toBe('UNAUTHORIZED');

      // DER HOST wird NICHT vom Guard verweigert (kein NOT_IN_ROOM /
      // UNAUTHORIZED). Ob die Engine zusätzlich eine fachliche Bedingung
      // (z.B. aktiver Timer) stellt, ist engine-spezifisch und kein Teil
      // der Autorisierungs-Garantie.
      const hostPause = await ack(h, 'game:pause', { roomCode: code });
      expect(hostPause.error).not.toBe('UNAUTHORIZED');
      expect(hostPause.error).not.toBe('NOT_IN_ROOM');
    });

    it('4. Config-Snapshot: nach Start unveränderlicher Start-Snapshot (engineVersion)', async () => {
      const { id, code } = await makeRoom();
      const h = await connect(createSessionCookie((await contractPrisma.session.findFirst({ where: { userId: HOST_USER_ID }, orderBy: { createdAt: 'desc' } }))!.id, config.sessionSecret));
      expect((await ack(h, 'room:subscribe', { roomCode: code })).success).toBe(true);
      expect((await ack(h, 'game:start', { roomCode: code })).success).toBe(true);
      const room = await contractPrisma.room.findUniqueOrThrow({ where: { id } });
      expect(room.configSchemaVersion).toBe(1);
      expect(room.gameConfigSnapshotJson).toBeTruthy();
      const snap = JSON.parse(room.gameConfigSnapshotJson!);
      // Audit PR14, 14-04: Der Snapshot trägt IMMER den KANONISCHEN Slug —
      // auch wenn der Raum einen Legacy-Slug (z.B. 'geo') trägt. Die
      // Engine-Version ist die tatsächliche (ENGINE_VERSIONS), kein
      // pauschales 1.
      const { resolveCanonicalSlug } = await import('@quiz/shared');
      expect(snap.gameSlug).toBe(resolveCanonicalSlug(spec.slug) ?? spec.slug);
      expect(typeof snap.engineVersion).toBe('number');
      expect(snap.engineVersion).toBeGreaterThan(0);
    });
  });
}
