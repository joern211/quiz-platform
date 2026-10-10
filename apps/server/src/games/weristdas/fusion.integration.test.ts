import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import sharp from 'sharp';
import request from 'supertest';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { createTestDatabase } from '../../test-helpers.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { createGameImage } from './composite.js';

// Zwei echte, unterscheidbare Originale (Datei + READY-Asset) für den Host.
async function hostImageAsset(userId: string, width: number, height: number, color: { r: number; g: number; b: number }) {
  const buf = await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const filename = `v2src-${Math.random().toString(36).slice(2)}.webp`;
  const storagePath = join(CTX.tmpDir, filename);
  await mkdir(CTX.tmpDir, { recursive: true });
  const out = await sharp(buf).webp().toBuffer();
  await import('node:fs/promises').then(fs => fs.writeFile(storagePath, out));
  const sha256 = (await import('node:crypto')).createHash('sha256').update(out).digest('hex');
  return CTX.prisma.mediaAsset.create({
    data: {
      type: 'image', mimeType: 'image/webp', filename, originalName: 'v2source.png',
      fileSize: out.length, width, height, sha256, storagePath, uploadedBy: userId,
      visibility: 'PRIVATE', processStatus: 'READY', processed: true,
    },
  });
}

interface Ctx {
  prisma: import('@prisma/client').PrismaClient;
  app: import('express').Express;
  httpServer: HttpServer;
  socketIo: SocketIOServer;
  origin: string;
  tmpDir: string;
  roomId: string;
  code: string;
  hostSessionId: string;
  assetA: { id: string };
  assetB: { id: string };
  gameImageId: string;
  playerId: string;
  playerId2: string;
  playerToken: string;
  playerToken2: string;
  host: ClientSocket;
  player: ClientSocket;
  second: ClientSocket;
  viewer: ClientSocket;
  sockets: ClientSocket[];
  otherRooms: string[];
}

const CTX: Ctx = {
  prisma: null as unknown as import('@prisma/client').PrismaClient,
  app: null as unknown as import('express').Express,
  httpServer: null as unknown as HttpServer,
  socketIo: null as unknown as SocketIOServer,
  origin: '',
  tmpDir: tmpdir(),
  roomId: '',
  code: '',
  hostSessionId: '',
  assetA: { id: '' },
  assetB: { id: '' },
  gameImageId: '',
  playerId: '',
  playerId2: '',
  playerToken: '',
  playerToken2: '',
  host: null as unknown as ClientSocket,
  player: null as unknown as ClientSocket,
  second: null as unknown as ClientSocket,
  viewer: null as unknown as ClientSocket,
  sockets: [],
  otherRooms: [],
};

const secretA = 'SECRET_FUSION_PERSON_A_9f3a';
const secretB = 'Secret Fusion Person B 7c1d';
const ack = gameAck;
// vmForks + isolate:false → globalThis.__prisma ist worker-weit geteilt.
// Den vorherigen Client sichern, damit andere Test-Dateien im selben Worker
// (z. B. socket-flow mit Shared-DB) nicht unsere geschlossene Temp-DB erben.
let prevPrisma: import('@prisma/client').PrismaClient | undefined;
async function connect(cookie?: string) {
  const socket = await connectGameClient(CTX.origin, cookie);
  CTX.sockets.push(socket);
  return socket;
}

describe('Wer ist das? v2 — Fusion + Geheimhaltung (Regelwerk §15.3, §10.7, §5.22)', () => {
  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    const dir = await mkdtemp(join(tmpdir(), 'quiz-wid-v2-'));
    CTX.tmpDir = dir;
    const dbUrl = `file:${join(dir, 'v2.db')}`;
    await createTestDatabase(dbUrl);
    const fresh = new PrismaClient({ datasourceUrl: dbUrl });
    await fresh.$connect();
    prevPrisma = globalThis.__prisma;
    globalThis.__prisma = fresh;
    CTX.prisma = fresh;

    const { createApp } = await import('../../app.js');
    const { app, httpServer, io } = createApp();
    CTX.app = app;
    CTX.httpServer = httpServer;
    CTX.socketIo = io;
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    CTX.origin = `http://127.0.0.1:${address.port}`;

    const { GAME_SLUGS } = await import('@quiz/shared');
    const game = await fresh.gameDefinition.upsert({
      where: { slug: GAME_SLUGS.werIstDas },
      update: { status: 'BETA' },
      create: { slug: GAME_SLUGS.werIstDas, name: 'Wer ist das?', category: 'buzzer-reaktion', status: 'BETA', minPlayers: 2, maxPlayers: 10 },
    });
    const user = await fresh.user.create({
      data: { id: 'v2-host', displayName: 'V2 Host', email: 'v2host@test.local', passwordHash: 'x', role: 'MODERATOR' },
    });
    CTX.hostSessionId = (await fresh.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 600000) } })).id;

    // Zwei echte Originale + EIN Composite (exakt wie in der Produktion).
    CTX.assetA = await hostImageAsset(user.id, 320, 480, { r: 220, g: 30, b: 30 });
    CTX.assetB = await hostImageAsset(user.id, 480, 320, { r: 30, g: 30, b: 220 });
    const composite = await createGameImage({
      personAImageAssetId: CTX.assetA.id, personBImageAssetId: CTX.assetB.id,
      hostUserId: user.id, roomId: 'pending', roundId: 'v2-one',
    });
    CTX.gameImageId = composite.gameImageAssetId;

    CTX.code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
    const setup = JSON.stringify({
      setupVersion: 2,
      rounds: [{
        id: 'v2-one',
        personAImageAssetId: CTX.assetA.id,
        personBImageAssetId: CTX.assetB.id,
        gameImageAssetId: CTX.gameImageId,
        personAName: secretA,
        personBName: secretB,
        aliasesA: ['Secret Alias A'],
      }],
    });
    const room = await fresh.room.create({ data: { code: CTX.code, roomName: 'V2 Fusion', gameDefinitionId: game.id,
      hostUserId: user.id, status: 'LOBBY', runPhase: 'LOBBY', viewerRequiresPin: false, setupSnapshotJson: setup } });
    CTX.roomId = room.id;
    const players = await Promise.all(['Anna', 'Ben'].map(displayName => fresh.participation.create({ data: {
      roomId: room.id, role: 'PLAYER', displayName, normalizedName: displayName.toLowerCase(),
      rejoinToken: randomUUID(), connected: true, ready: true,
    } })));
    CTX.playerId = players[0].id; CTX.playerId2 = players[1].id;
    CTX.playerToken = players[0].rejoinToken; CTX.playerToken2 = players[1].rejoinToken;

    const hostCookie = createSessionCookie(CTX.hostSessionId, config.sessionSecret);
    CTX.host = await connect(hostCookie);
    CTX.player = await connect();
    CTX.second = await connect();
    CTX.viewer = await connect();
    expect((await ack(CTX.host, 'room:subscribe', { roomCode: CTX.code })).success).toBe(true);
    expect((await ack(CTX.player, 'room:subscribe', { roomCode: CTX.code, rejoinToken: CTX.playerToken })).success).toBe(true);
    expect((await ack(CTX.second, 'room:subscribe', { roomCode: CTX.code, rejoinToken: CTX.playerToken2 })).success).toBe(true);
    expect((await ack(CTX.viewer, 'room:subscribe', { roomCode: CTX.code })).success).toBe(true);
  }, 25000);

  afterAll(async () => {
    for (const socket of CTX.sockets) socket.disconnect();
    if (CTX.socketIo) await new Promise<void>(resolve => CTX.socketIo.close(() => resolve()));
    if (CTX.httpServer?.listening) await new Promise<void>(resolve => CTX.httpServer.close(() => resolve()));
    for (const id of CTX.otherRooms) await CTX.prisma.room.delete({ where: { id } }).catch(() => {});
    if (CTX.roomId) await CTX.prisma.room.delete({ where: { id: CTX.roomId } }).catch(() => {});
    await CTX.prisma.$disconnect();
    globalThis.__prisma = prevPrisma; // vorherigen Client wiederherstellen
    // SQLite sidecar cleanup can briefly race recursive removal (CI: ENOTEMPTY).
    // Retry transient filesystem errors; persistent cleanup failures still fail.
    await rm(CTX.tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('spielt eine v2-Runde: nur Composite vor Reveal, Namen erst nach Reveal (Rollenprojektionen)', async () => {
    const received: string[] = [];
    CTX.player.onAny((_e, value: unknown) => received.push(JSON.stringify(value)));
    CTX.viewer.onAny((_e, value: unknown) => received.push(JSON.stringify(value)));

    expect((await ack(CTX.host, 'game:start', { roomCode: CTX.code })).success).toBe(true);

    // Player: nur das Spielbild (id + Signed-URL), KEIN Name, KEINE Original-IDs/URLs.
    const playerView = (await ack(CTX.player, 'weristdas:resync')).state as Record<string, unknown>;
    expect(playerView).toMatchObject({ phase: 'ROUND_READY', imageAssetId: CTX.gameImageId });
    const playerGameUrl = String(playerView.gameImageUrl);
    expect(playerGameUrl).toContain(CTX.gameImageId);
    // Signed URL: exp + sig Parameter (Audience steckt im HMAC, nicht im Query).
    expect(playerGameUrl).toMatch(/[?&]exp=\d+/);
    expect(playerGameUrl).toMatch(/[?&]sig=([A-Za-z0-9_-]+)/);
    expect(JSON.stringify(playerView)).not.toContain(secretA);
    expect(JSON.stringify(playerView)).not.toContain(secretB);
    expect(JSON.stringify(playerView)).not.toContain(CTX.assetA.id);
    expect(JSON.stringify(playerView)).not.toContain(CTX.assetB.id);
    expect(playerView.hostImageUrls).toBeUndefined();

    // Viewer: identische Geheimhaltung.
    const viewerView = (await ack(CTX.viewer, 'weristdas:resync')).state as Record<string, unknown>;
    expect(JSON.stringify(viewerView)).not.toContain(secretA);
    expect(JSON.stringify(viewerView)).not.toContain(CTX.assetA.id);
    expect(viewerView.hostImageUrls).toBeUndefined();

    // Host: sieht das Spielbild UND die Originale (host-URLs). Host-URLs des
    // Composite sind ANDERS als die Player-Game-URL desselben Assets (unterschiedliche
    // Audience → unterschiedliche HMAC), und sie zeigen auf die beiden Originale.
    const hostView = (await ack(CTX.host, 'weristdas:resync')).state as Record<string, unknown>;
    const hostUrls = hostView.hostImageUrls as string[];
    expect(hostUrls).toHaveLength(2);
    expect(hostUrls.map(u => u).some(u => u === playerGameUrl)).toBe(false);
    // Originale erscheinen NUR als host-URLs, nie als game-URLs.
    for (const origId of [CTX.assetA.id, CTX.assetB.id]) {
      expect(JSON.stringify(hostUrls)).toContain(origId);
    }

    // Volle Runde: Buzz → falsch → Hint → richtig → Reveal (Regeln unverändert).
    expect((await ack(CTX.host, 'weristdas:buzzer:open')).success).toBe(true);
    expect((await ack(CTX.player, 'weristdas:buzz')).success).toBe(true);
    expect((await ack(CTX.second, 'weristdas:buzz')).success).toBe(false);
    expect((await ack(CTX.host, 'weristdas:judge', { result: 'WRONG' })).success).toBe(true);
    expect((await ack(CTX.host, 'weristdas:buzzer:open')).success).toBe(true);
    expect((await ack(CTX.second, 'weristdas:buzz')).success).toBe(true);
    expect((await ack(CTX.host, 'weristdas:judge', { result: 'ONE_CORRECT' })).error).toBe('HINT_REQUIRED');
    expect((await ack(CTX.host, 'weristdas:hint')).success).toBe(true);
    expect(JSON.stringify(await ack(CTX.viewer, 'weristdas:resync'))).not.toContain(secretA);
    expect(received.join(' ')).not.toContain(secretA);
    expect(received.join(' ')).not.toContain(CTX.assetA.id);
    expect((await ack(CTX.host, 'weristdas:judge', { result: 'ONE_CORRECT' })).success).toBe(true);

    // Reveal: Namen werden jetzt an ALLE freigegeben.
    const revealed = await ack(CTX.viewer, 'weristdas:resync');
    expect(JSON.stringify(revealed)).toContain(secretA);
    expect(JSON.stringify(revealed)).toContain(secretB);
    expect(revealed.state).toMatchObject({ phase: 'REVEAL', revealed: true });

    // Score-Events bleiben korrekt (−1, +1) und decken mit DB ab.
    const events = await CTX.prisma.scoreEvent.findMany({ where: { roomId: CTX.roomId } });
    expect(events.map(e => e.delta).sort((a, b) => a - b)).toEqual([-1, 1]);
    for (const p of await CTX.prisma.participation.findMany({ where: { roomId: CTX.roomId, role: 'PLAYER' } })) {
      expect(p.score).toBe(events.filter(e => e.participationId === p.id).reduce((s, e) => s + e.delta, 0));
    }

    // Nächstes → letztes Round → Endphase.
    expect((await ack(CTX.host, 'weristdas:next')).success).toBe(true);
    const endView = await ack(CTX.viewer, 'weristdas:resync');
    expect(endView.state).toMatchObject({ phase: 'GAME_END' });
  }, 30000);

  it('stabilisiert unter Reconnect/Rejoin: State + Bild-IDs werden aus der persistierten DB wiederhergestellt, Composite NICHT neu erzeugt', async () => {
    // Der Endzustand ist in roomGameStates persistiert (pinned engineVersion).
    // Ein frischer Client (z. B. nach Reload/Serverrestart) muss exakt denselben
    // State + dieselbe Bild-ID erhalten — und das Composite ist dasselbe Asset.
    const replayer = await connect();
    const hostCookie = createSessionCookie(CTX.hostSessionId, config.sessionSecret);
    const rehost = await connect(hostCookie);
    expect((await ack(rehost, 'room:subscribe', { roomCode: CTX.code })).success).toBe(true);
    expect((await ack(replayer, 'room:subscribe', { roomCode: CTX.code, rejoinToken: CTX.playerToken })).success).toBe(true);
    const recovered = (await ack(replayer, 'weristdas:resync')).state as Record<string, unknown>;
    expect(recovered).toMatchObject({ phase: 'GAME_END', imageAssetId: CTX.gameImageId });
    expect(String(recovered.gameImageUrl)).toContain(CTX.gameImageId);
    // Das Composite wurde NICHT neu erzeugt: exakt dasselbe Asset, 1 Instanz.
    const instances = await CTX.prisma.mediaAsset.count({ where: { id: CTX.gameImageId } });
    expect(instances).toBe(1);
    // Pinned engineVersion liegt im Game-State (Regelwerk §5.22).
    const row = await CTX.prisma.roomGameState.findUniqueOrThrow({ where: { roomId: CTX.roomId } });
    expect(row.engineVersion).toBe(2);
  }, 20000);

  it('verwirft fehlerhafte v2-Setups (fremde ID, falsche Composite-Zuordnung, identische Quellen) ohne halb gestarteten Raum', async () => {
    const source = await CTX.prisma.room.findUniqueOrThrow({ where: { id: CTX.roomId } });
    let seq = 0;
    const makeBadRoom = async (rounds: unknown) => {
      seq += 1;
      const room = await CTX.prisma.room.create({ data: {
        code: String(200000 + seq).replace(/(\d{3})(\d{3})/, '$1-$2'),
        roomName: `Bad V2 ${seq}`, gameDefinitionId: source.gameDefinitionId, hostUserId: 'v2-host',
        status: 'LOBBY', runPhase: 'LOBBY', setupSnapshotJson: JSON.stringify({ setupVersion: 2, rounds }),
      } });
      CTX.otherRooms.push(room.id);
      await Promise.all(['P', 'Q'].map(displayName => CTX.prisma.participation.create({ data: {
        roomId: room.id, role: 'PLAYER', displayName, normalizedName: displayName.toLowerCase(),
        rejoinToken: randomUUID(), connected: true, ready: true,
      } })));
      return room;
    };
    const hostCookie = createSessionCookie(CTX.hostSessionId, config.sessionSecret);

    // 1) Fremdes Original-Asset (anderer Host) → kein RUNNING, kein State.
    const foreign = await hostImageAsset('someone-else', 200, 200, { r: 9, g: 9, b: 9 });
    const bad1 = await makeBadRoom([{ id: 'bad1', personAImageAssetId: foreign.id, personBImageAssetId: CTX.assetB.id, gameImageAssetId: CTX.gameImageId, personAName: 'X', personBName: 'Y' }]);
    let h = await connect(hostCookie);
    expect((await ack(h, 'room:subscribe', { roomCode: bad1.code })).success).toBe(true);
    expect((await ack(h, 'game:start', { roomCode: bad1.code })).success).toBe(false);
    expect((await CTX.prisma.room.findUniqueOrThrow({ where: { id: bad1.id } })).status).toBe('LOBBY');
    expect(await CTX.prisma.roomGameState.findUnique({ where: { roomId: bad1.id } })).toBeNull();

    // 2) Composite gehört zu ANDEREN Quellen als die Setup-Quellen → abgelehnt.
    const assetC = await hostImageAsset('v2-host', 200, 200, { r: 50, g: 150, b: 50 });
    const bad2 = await makeBadRoom([{ id: 'bad2', personAImageAssetId: assetC.id, personBImageAssetId: CTX.assetB.id, gameImageAssetId: CTX.gameImageId, personAName: 'X', personBName: 'Y' }]);
    h = await connect(hostCookie);
    expect((await ack(h, 'room:subscribe', { roomCode: bad2.code })).success).toBe(true);
    expect((await ack(h, 'game:start', { roomCode: bad2.code })).success).toBe(false);
    expect(await CTX.prisma.roomGameState.findUnique({ where: { roomId: bad2.id } })).toBeNull();

    // 3) Identische A/B-Quellen → abgelehnt.
    const bad3 = await makeBadRoom([{ id: 'bad3', personAImageAssetId: CTX.assetA.id, personBImageAssetId: CTX.assetA.id, gameImageAssetId: CTX.gameImageId, personAName: 'X', personBName: 'Y' }]);
    h = await connect(hostCookie);
    expect((await ack(h, 'room:subscribe', { roomCode: bad3.code })).success).toBe(true);
    expect((await ack(h, 'game:start', { roomCode: bad3.code })).success).toBe(false);
    expect(await CTX.prisma.roomGameState.findUnique({ where: { roomId: bad3.id } })).toBeNull();
  }, 30000);

  it('blockiert Host-als-Player (HTTP-Join mit Host-Session) und lässt anonyme Player zu', async () => {
    const source = await CTX.prisma.room.findUniqueOrThrow({ where: { id: CTX.roomId } });
    const room = await CTX.prisma.room.create({ data: {
      code: String(300001).replace(/(\d{3})(\d{3})/, '$1-$2'),
      roomName: 'HostPlay', gameDefinitionId: source.gameDefinitionId, hostUserId: 'v2-host',
      status: 'LOBBY', runPhase: 'LOBBY', setupSnapshotJson: JSON.stringify({ setupVersion: 2, rounds: [] }),
    } });
    CTX.otherRooms.push(room.id);

    // Host-Konto mit Session → 403 + HOST_CANNOT_PLAY_OWN_ROUND.
    const hostCookie = createSessionCookie(CTX.hostSessionId, config.sessionSecret);
    const blocked = await request(CTX.app).post(`/api/v1/rooms/${room.code}/join`)
      .set('Cookie', hostCookie.split(';')[0])
      .send({ displayName: 'Host as player' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('HOST_CANNOT_PLAY_OWN_ROUND');
    expect(await CTX.prisma.participation.count({ where: { roomId: room.id, role: 'PLAYER' } })).toBe(0);

    // Anonymer Player (keine Session) → 201, normale Teilnahme.
    const anon = await request(CTX.app).post(`/api/v1/rooms/${room.code}/join`).send({ displayName: 'Fremde Spielerin' });
    expect(anon.status).toBe(201);
    expect(await CTX.prisma.participation.count({ where: { roomId: room.id, role: 'PLAYER' } })).toBe(1);
  });
});
