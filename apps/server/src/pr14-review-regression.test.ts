import { createCommandIntentClient } from '@quiz/shared';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTestDatabase } from './test-helpers.js';
import { socketIdentityMap } from './http/middleware/auth.js';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { PrismaClient, Prisma } from '@prisma/client';
import { setupSocketHandlers } from './sockets/index.js';
import { createSessionCookie } from './auth/session.js';
import { config } from './config/index.js';
import { connectGameClient, gameAck } from './test-socket-harness.js';
import { hashCommandPayload, runReceipted } from './games/core/commands.js';
import { saveGameStateIfRevision, upsertGameState } from './games/core/state.js';
import { awaitEngineResult } from './games/core/receiptedAction.js';
import { werIstDasGame } from './games/weristdas/engine.js';
import { handleGeoGame, cancelGeoTimer } from './games/geo/index.js';
const ack = gameAck;
const HOST_USER_ID = 'mod-1';
let testPrisma: PrismaClient;
let testDirectory: string;
let httpServer: HttpServer;
let io: Server;
let origin: string;
let hostSessionId: string;
const sockets: ClientSocket[] = [];
const roomIds: string[] = [];
const assetIds: string[] = [];
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
} = { slug: 'wer-ist-das', setup: {} }): Promise<{
    id: string;
    code: string;
    host: ClientSocket;
}> {
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
    const host = await connect(createSessionCookie(hostSessionId, config.sessionSecret));
    expect((await ack(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
    return { id: room.id, code, host };
}
beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    // Preserve all real DB/socket races inside this suite while preventing
    // other suites' background servers and probes from owning its database.
    testDirectory = await mkdtemp(join(tmpdir(), 'quiz-pr14-review-'));
    const databaseUrl = `file:${join(testDirectory, 'review.db')}`;
    await createTestDatabase(databaseUrl);
    const seed = resolve(dirname(fileURLToPath(import.meta.url)), '../../../prisma/seed.ts');
    await promisify(execFile)(process.execPath, ['--import', 'tsx', seed], { env: { ...process.env, DATABASE_URL: databaseUrl } });
    testPrisma = new PrismaClient({ datasourceUrl: databaseUrl });
    await testPrisma.$connect();
    (globalThis as Record<string, unknown>).__prisma = testPrisma;
    await testPrisma.user.upsert({ where: { id: HOST_USER_ID }, update: {}, create: { id: HOST_USER_ID, displayName: 'A14 Host', passwordHash: 'x', role: 'HOST' } });
    hostSessionId = (await testPrisma.session.create({ data: { id: `sess-a14-${randomUUID()}`, userId: HOST_USER_ID, expiresAt: new Date(Date.now() + 86400000) } })).id;
    httpServer = createServer();
    io = new Server(httpServer);
    setupSocketHandlers(io);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string')
        throw new Error('no port');
    origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
    for (const id of roomIds) cancelGeoTimer(id);
    for (const s of sockets)
        s.disconnect();
    await new Promise<void>((resolve) => io.close(() => httpServer.close(() => resolve())));
    await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(identity => identity.roomId && roomIds.includes(identity.roomId))).toHaveLength(0), { timeout: 10000 });
    for (const id of roomIds)
        await testPrisma.room.deleteMany({ where: { id } }).catch(() => undefined);
    await testPrisma.mediaAsset.deleteMany({ where: { id: { in: assetIds } } });
    await testPrisma.$disconnect();
    (globalThis as Record<string, unknown>).__prisma = undefined;
    await rm(testDirectory, { recursive: true, force: true });
});
async function reviewWid(start = true) {
    const image = await testPrisma.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'review.png', originalName: 'review.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/review.png', uploadedBy: HOST_USER_ID } });
    assetIds.push(image.id);
    const room = await makeHostRoom({ slug: 'wer-ist-das', setup: { rounds: [{ id: 'r1', imageAssetId: image.id, person1: 'A', person2: 'B' }, { id: 'r2', imageAssetId: image.id, person1: 'C', person2: 'D' }] } });
    const players = await testPrisma.participation.findMany({ where: { roomId: room.id, role: 'PLAYER' }, orderBy: { displayName: 'asc' } });
    const clients = await Promise.all(players.map(async (p) => { const s = await connect(); expect((await ack(s, 'room:subscribe', { roomCode: room.code, rejoinToken: p.rejoinToken })).success).toBe(true); return s; }));
    if (start)
        expect((await ack(room.host, 'game:start', { roomCode: room.code })).success).toBe(true);
    return { ...room, players, clients };
}
it('PR14 review: different WID actions using one ID must conflict, never replay', async () => {
    const r = await reviewWid();
    expect((await ack(r.host, 'weristdas:buzzer:open', { commandId: 'action-collision' })).success).toBe(true);
    const b = await ack(r.host, 'weristdas:hint', { commandId: 'action-collision' });
    expect(b.error).toBe('COMMAND_CONFLICT');
});
it('PR14 review: malformed lifecycle token must be rejected rather than execute without receipt', async () => {
    const r = await reviewWid();
    const res = await ack(r.host, 'game:end', { roomCode: r.code, commandId: 123, stateVersion: 'bad' });
    const room = await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } });
    expect(res.error).toBe('INVALID_PAYLOAD');
    expect(room.status).toBe('RUNNING');
});
it('PR14 review: completed start must replay even if a player subsequently disconnects', async () => {
    const r = await makeHostRoom({ slug: 'wer-ist-das', setup: {} });
    const image = await testPrisma.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'review.png', originalName: 'review.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/review.png', uploadedBy: HOST_USER_ID } });
    assetIds.push(image.id);
    await testPrisma.room.update({ where: { id: r.id }, data: { setupSnapshotJson: JSON.stringify({ rounds: [{ id: 'r1', imageAssetId: image.id, person1: 'A', person2: 'B' }] }) } });
    const payload = { roomCode: r.code, commandId: 'start-disconnect' };
    const first = await ack(r.host, 'game:start', payload);
    await testPrisma.participation.updateMany({ where: { roomId: r.id, role: 'PLAYER' }, data: { connected: false } });
    const replay = await ack(r.host, 'game:start', payload);
    expect(first.success).toBe(true);
    expect(replay).toMatchObject({ success: true, replayed: true });
});
it('PR14 review: expired lease must not allow the original live handler to judge a second player', async () => {
    const r = await reviewWid();
    await ack(r.host, 'weristdas:buzzer:open', {});
    await ack(r.clients[0], 'weristdas:buzz', {});
    const original = werIstDasGame.act;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    werIstDasGame.act = async function (...args: Parameters<typeof original>) {
        if (args[2] === 'judge' && first) {
            first = false;
            entered();
            await gate;
        }
        return original.apply(werIstDasGame, args);
    };
    let initial: Record<string, unknown>;
    try {
        const payload = { result: 'WRONG', commandId: 'lease-live-judge' };
        const pending = ack(r.host, 'weristdas:judge', payload);
        await started;
        await new Promise(resolve => setTimeout(resolve, 3100));
        expect((await ack(r.host, 'weristdas:judge', payload)).success).toBe(true);
        await ack(r.host, 'weristdas:buzzer:open', {});
        await ack(r.clients[1], 'weristdas:buzz', {});
        release();
        initial = await pending;
        const state = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
        expect(state.scores[r.players[1].id]).toBe(0);
        expect(state.scores[r.players[0].id]).toBe(-1);
        expect(initial).toMatchObject({ success: true, replayed: true });
        const receipt = await testPrisma.commandReceipt.findUniqueOrThrow({ where: { roomId_commandId: { roomId: r.id, commandId: 'lease-live-judge' } } });
        expect(receipt.status).toBe('COMPLETED');
        expect(JSON.parse(receipt.responseJson!).state.scores[r.players[1].id]).toBe(0);
    }
    finally {
        release();
        werIstDasGame.act = original;
    }
});
it('PR14 review: timer accepted by config writer must be executable by Geo', async () => {
    const qs = await testPrisma.geoQuestion.findMany({ take: 2 });
    const r = await makeHostRoom({ slug: 'wissensduell', setup: { selectedQuestionIds: qs.map(q => q.id), timerDuration: 20 } });
    const rev = (await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } })).revision;
    const saved = await ack(r.host, 'room:config:update', { roomCode: r.code, expectedRevision: rev, changes: { timerDurationMs: 0 } });
    const start = await ack(r.host, 'game:start', { roomCode: r.code });
    await handleGeoGame.startRound(io, r.code);
    const row = await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } });
    await ack(r.host, 'game:end', { roomCode: r.code });
    cancelGeoTimer(r.id);
    expect(saved).toMatchObject({ success: false, error: 'INVALID_CONFIG' });
    expect(start.success).toBe(true);
    expect(row.phase).toBe('INPUT_OPEN');
});
it('PR14 review: configured question count must match actual initialized game', async () => {
    const qs = await testPrisma.geoQuestion.findMany({ take: 2 });
    const r = await makeHostRoom({ slug: 'wissensduell', setup: { selectedQuestionIds: qs.map(q => q.id), timerDuration: 20 } });
    const rev = (await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } })).revision;
    const saved = await ack(r.host, 'room:config:update', { roomCode: r.code, expectedRevision: rev, changes: { questionCount: 1 } });
    const start = await ack(r.host, 'game:start', { roomCode: r.code });
    expect(start).toMatchObject({ success: true });
    const room = await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } });
    const state = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
    const configured = JSON.parse(room.gameConfigSnapshotJson!).values.questionCount.value;
    expect(saved.success).toBe(true);
    expect(start.success).toBe(true);
    expect(configured).toBe(1);
    await ack(r.host, 'game:end', { roomCode: r.code });
    cancelGeoTimer(r.id);
    expect(state.questions.length).toBe(configured);
});
it('PR14 review: stale answer must not be applied to the next question when receipt claim is delayed', async () => {
    const qs = await testPrisma.geoQuestion.findMany({ take: 2 });
    const r = await makeHostRoom({ slug: 'wissensduell', setup: { selectedQuestionIds: qs.map(q => q.id), timerDuration: 20 } });
    const player = await testPrisma.participation.findFirstOrThrow({ where: { roomId: r.id, role: 'PLAYER' } });
    const client = await connect();
    await ack(client, 'room:subscribe', { roomCode: r.code, rejoinToken: player.rejoinToken });
    await ack(r.host, 'game:start', { roomCode: r.code });
    await handleGeoGame.startRound(io, r.code);
    cancelGeoTimer(r.id);
    const before = await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } });
    const first = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
    const optionId = first.roundStates[0].question.options[0].id;
    const original = testPrisma.commandReceipt.create.bind(testPrisma.commandReceipt);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    testPrisma.commandReceipt.create = (async (a: Prisma.CommandReceiptCreateArgs) => {
        if (a.data.commandId === 'delayed-answer') {
            entered();
            await gate;
        }
        return original(a);
    }) as unknown as typeof testPrisma.commandReceipt.create;
    try {
        const answer = ack(client, 'geo:answer', { optionId, commandId: 'delayed-answer', stateVersion: before.revision });
        await started;
        expect((await ack(r.host, 'geo:reveal', { roomCode: r.code })).success).toBe(true);
        expect((await ack(r.host, 'geo:next', { roomCode: r.code })).success).toBe(true);
        cancelGeoTimer(r.id);
        expect((await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } })).revision).toBeGreaterThan(before.revision);
        release();
        const response = await answer;
        const state = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
        expect(response.error).toBe('REVISION_CONFLICT');
        expect(state.roundStates[1].playerStates[player.id].answered).toBe(false);
    }
    finally {
        release();
        testPrisma.commandReceipt.create = original;
        await ack(r.host, 'game:end', { roomCode: r.code });
        cancelGeoTimer(r.id);
    }
});
it.each([
    { commandId: '' }, { commandId: null }, { requestId: 42 },
    { commandId: 'valid', requestId: null }, { commandId: 'valid', stateVersion: '2' },
    { commandId: 'valid', expectedRevision: {} }, { stateVersion: -1 },
])('PR14 review: reject malformed envelope %j before any lifecycle effect', async (fields) => {
    const r = await reviewWid();
    const response = await ack(r.host, 'game:end', { roomCode: r.code, ...fields });
    expect(response).toMatchObject({ success: false, error: 'INVALID_PAYLOAD' });
    expect((await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('RUNNING');
    expect(await testPrisma.commandReceipt.count({ where: { roomId: r.id } })).toBe(0);
});
it('PR14 review: revision is checked inside the engine transaction, after entry validation', async () => {
    const qs = await testPrisma.geoQuestion.findMany({ take: 2 });
    const r = await makeHostRoom({ slug: 'wissensduell', setup: { selectedQuestionIds: qs.map(q => q.id), timerDuration: 20 } });
    const player = await testPrisma.participation.findFirstOrThrow({ where: { roomId: r.id, role: 'PLAYER' } });
    const client = await connect();
    await ack(client, 'room:subscribe', { roomCode: r.code, rejoinToken: player.rejoinToken });
    await ack(r.host, 'game:start', { roomCode: r.code });
    await handleGeoGame.startRound(io, r.code);
    cancelGeoTimer(r.id);
    const revision = (await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } })).revision;
    const original = handleGeoGame.handleAnswer;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    handleGeoGame.handleAnswer = async function (...args: Parameters<typeof original>) {
        entered();
        await gate;
        return original.apply(handleGeoGame, args);
    };
    try {
        const answer = ack(client, 'geo:answer', { optionId: 'a', commandId: 'delayed-engine-answer', stateVersion: revision });
        await started;
        expect((await ack(r.host, 'geo:reveal', { roomCode: r.code })).success).toBe(true);
        expect((await ack(r.host, 'geo:next', { roomCode: r.code })).success).toBe(true);
        cancelGeoTimer(r.id);
        release();
        expect(await answer).toMatchObject({ success: false, error: 'REVISION_CONFLICT' });
        const state = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
        expect(state.roundStates[1].playerStates[player.id].answered).toBe(false);
    }
    finally {
        release();
        handleGeoGame.handleAnswer = original;
        await ack(r.host, 'game:end', { roomCode: r.code });
        cancelGeoTimer(r.id);
    }
});
it('PR14 review: committed mutation marker prevents takeover while result delivery is delayed', async () => {
    const r = await makeHostRoom();
    await upsertGameState({ roomId: r.id, state: { phase: 'BEFORE', value: 0 }, phase: 'BEFORE' });
    let release!: () => void;
    let committed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const changed = new Promise<void>(resolve => { committed = resolve; });
    let mutations = 0;
    const args = {
        roomId: r.id, commandId: randomUUID(), actor: { actorId: 'review', actorRole: 'HOST' },
        action: 'ROUND_ADVANCE' as const, payload: {},
        mutate: async () => {
            mutations++;
            await testPrisma.$transaction(tx => saveGameStateIfRevision(tx, {
                roomId: r.id, expectedRevision: 1, state: { phase: 'AFTER', value: 1 }, phase: 'AFTER',
            }));
            committed();
            await gate;
            return { success: true };
        },
        toResponse: (data: {
            success: boolean;
        }) => data,
    };
    const initial = runReceipted(testPrisma, args);
    await changed;
    try {
        await testPrisma.commandReceipt.update({ where: { roomId_commandId: { roomId: r.id, commandId: args.commandId } }, data: { leaseExpiresAt: new Date(0) } });
        expect(await runReceipted(testPrisma, args)).toMatchObject({ success: false, resyncRequired: true });
        expect(mutations).toBe(1);
    }
    finally {
        release();
        await initial;
    }
    expect(await runReceipted(testPrisma, args)).toMatchObject({ success: true, replayed: true });
});
it('PR14 review: engine continuation after result timeout cannot write with a closed execution', async () => {
    const r = await makeHostRoom();
    await upsertGameState({ roomId: r.id, state: { phase: 'BEFORE' }, phase: 'BEFORE' });
    let release!: () => void;
    let done!: () => void;
    let lateError: unknown;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finished = new Promise<void>(resolve => { done = resolve; });
    const initial = runReceipted(testPrisma, {
        roomId: r.id, commandId: randomUUID(), actor: { actorId: 'review', actorRole: 'HOST' }, action: 'ROUND_ADVANCE', payload: {},
        mutate: () => awaitEngineResult(async () => {
            await gate;
            try {
                await testPrisma.$transaction(tx => saveGameStateIfRevision(tx, {
                    roomId: r.id, expectedRevision: 1, state: { phase: 'AFTER' }, phase: 'AFTER',
                }));
            }
            catch (error) {
                lateError = error;
                throw error;
            }
            finally {
                done();
            }
        }, 20),
        toResponse: data => data,
    });
    await expect(initial).rejects.toThrow('ENGINE_RESULT_TIMEOUT');
    release();
    await finished;
    expect(lateError).toMatchObject({ code: 'COMMAND_OWNERSHIP_LOST' });
    expect((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).phase).toBe('BEFORE');
});
it('PR14 review: configured WID round count controls the actual game end', async () => {
    const r = await reviewWid(false);
    const revision = (await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } })).revision;
    expect(await ack(r.host, 'room:config:update', { roomCode: r.code, expectedRevision: revision, changes: { roundCount: 3 } })).toMatchObject({ success: false, error: 'INVALID_CONFIG' });
    expect((await ack(r.host, 'room:config:update', { roomCode: r.code, expectedRevision: revision, changes: { roundCount: 1 } })).success).toBe(true);
    expect((await ack(r.host, 'game:start', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
    expect((await ack(r.host, 'weristdas:reveal', {})).success).toBe(true);
    expect((await ack(r.host, 'weristdas:next', {})).success).toBe(true);
    const room = await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } });
    expect(room.status).toBe('ENDED');
    expect(JSON.parse(room.gameConfigSnapshotJson!).values.roundCount.value).toBe(1);
});
it('PR14 review: configured Jeopardy board count controls registration, resync and game end', async () => {
    const board = { categories: [{ name: 'Review', clues: [{ value: 100, question: 'Q?', answer: 'A' }] }] };
    const r = await makeHostRoom({ slug: 'jeopardy', setup: { board1: board, board2: board } });
    const player = await testPrisma.participation.findFirstOrThrow({ where: { roomId: r.id, role: 'PLAYER' } });
    const client = await connect();
    await ack(client, 'room:subscribe', { roomCode: r.code, rejoinToken: player.rejoinToken });
    const revision = (await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } })).revision;
    expect((await ack(r.host, 'room:config:update', { roomCode: r.code, expectedRevision: revision, changes: { boardCount: 1 } })).success).toBe(true);
    expect((await ack(r.host, 'game:start', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
    expect(await ack(client, 'jeopardy:resync', {})).toMatchObject({ board2Categories: [], board2Values: [], playedFields: [] });
    const state = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
    expect(Object.keys(state.openFields)).toEqual(['1-0-100']);
    expect((await ack(r.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(true);
    expect((await ack(client, 'jeopardy:buzz', {})).success).toBe(true);
    expect((await ack(r.host, 'jeopardy:judge', { correct: true })).success).toBe(true);
    expect((await ack(r.host, 'jeopardy:board:switch', { toBoard: 2 })).success).toBe(true);
    const room = await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } });
    expect(room.status).toBe('ENDED');
    expect(JSON.parse(room.gameConfigSnapshotJson!).values.boardCount.value).toBe(1);
});
it('PR14 review: Geo joker types cannot replay another joker receipt', async () => {
    const qs = await testPrisma.geoQuestion.findMany({ take: 1 });
    const r = await makeHostRoom({ slug: 'wissensduell', setup: { selectedQuestionIds: qs.map(q => q.id), timerDuration: 20 } });
    const player = await testPrisma.participation.findFirstOrThrow({ where: { roomId: r.id, role: 'PLAYER' } });
    const client = await connect();
    await ack(client, 'room:subscribe', { roomCode: r.code, rejoinToken: player.rejoinToken });
    await ack(r.host, 'game:start', { roomCode: r.code });
    await handleGeoGame.startRound(io, r.code);
    cancelGeoTimer(r.id);
    const payload = { roomCode: r.code, rejoinToken: player.rejoinToken, commandId: 'different-joker' };
    try {
        expect((await ack(client, 'geo:joker:5050', payload)).success).toBe(true);
        expect(await ack(client, 'geo:joker:risk', payload)).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
        const state = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
        expect(state.roundStates[0].playerStates[player.id].jokers).toMatchObject({ used5050: true, usedRisk: false });
    }
    finally {
        await ack(r.host, 'game:end', { roomCode: r.code });
        cancelGeoTimer(r.id);
    }
});
it('PR14 review: Jeopardy judge and steal-judge have distinct receipt identities', async () => {
    const board = { categories: [{ name: 'Review', clues: [{ value: 100, question: 'Q?', answer: 'A' }] }] };
    const r = await makeHostRoom({ slug: 'jeopardy', setup: { board1: board } });
    const players = await testPrisma.participation.findMany({ where: { roomId: r.id, role: 'PLAYER' }, orderBy: { displayName: 'asc' } });
    const clients = await Promise.all(players.map(async (p) => {
        const client = await connect();
        await ack(client, 'room:subscribe', { roomCode: r.code, rejoinToken: p.rejoinToken });
        return client;
    }));
    expect((await ack(r.host, 'game:start', { roomCode: r.code })).success).toBe(true);
    expect((await ack(r.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 })).success).toBe(true);
    expect((await ack(clients[0], 'jeopardy:buzz', {})).success).toBe(true);
    const judgePayload = { correct: false, commandId: 'different-judge' };
    expect((await ack(r.host, 'jeopardy:judge', judgePayload)).success).toBe(true);
    expect((await ack(clients[1], 'jeopardy:steal:buzz', {})).success).toBe(true);
    expect(await ack(r.host, 'jeopardy:steal:judge', judgePayload)).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
});
it('PR14 review: takeover rechecks both revisions in the mutation transaction', async () => {
    const r = await reviewWid();
    await ack(r.host, 'weristdas:buzzer:open', {});
    await ack(r.clients[0], 'weristdas:buzz', {});
    const room = await testPrisma.room.findUniqueOrThrow({ where: { id: r.id } });
    const state = await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } });
    const host = await testPrisma.participation.findFirstOrThrow({ where: { roomId: r.id, role: 'HOST' } });
    const payload = { result: 'WRONG', commandId: 'takeover-delayed-judge' };
    await testPrisma.commandReceipt.create({ data: {
            roomId: r.id, commandId: payload.commandId, actorId: host.id, actorRole: 'HOST', action: 'JUDGE',
            payloadHash: hashCommandPayload('JUDGE', payload), beforeRevision: room.revision, beforeStateRevision: state.revision, status: 'FAILED',
        } });
    const original = werIstDasGame.act;
    let release!: () => void;
    let entered!: () => void;
    let first = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    werIstDasGame.act = async function (...args: Parameters<typeof original>) {
        if (args[2] === 'judge' && first) {
            first = false;
            entered();
            await gate;
        }
        return original.apply(werIstDasGame, args);
    };
    try {
        const recovery = ack(r.host, 'weristdas:judge', payload);
        await started;
        expect((await ack(r.host, 'weristdas:judge', { result: 'WRONG', commandId: 'intervening-judge' })).success).toBe(true);
        expect((await ack(r.host, 'weristdas:buzzer:open', {})).success).toBe(true);
        expect((await ack(r.clients[1], 'weristdas:buzz', {})).success).toBe(true);
        release();
        expect(await recovery).toMatchObject({ success: false, error: 'COMMAND_STATE_ADVANCED', resyncRequired: true });
        const saved = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
        expect(saved.scores[r.players[1].id]).toBe(0);
    }
    finally {
        release();
        werIstDasGame.act = original;
    }
});
it('PR14 review: frontend retains the same intent after a lost completion, preventing a second score effect', async () => {
    const r = await reviewWid();
    await ack(r.host, 'weristdas:buzzer:open', {});
    await ack(r.clients[0], 'weristdas:buzz', {});
    const { emitCommand } = createCommandIntentClient();
    const sentIds: unknown[] = [];
    const emitter = {
        emit(event: string, payload: unknown, callback: (response: unknown) => void) {
            sentIds.push((payload as {
                commandId: string;
            }).commandId);
            r.host.emit(event, payload, callback);
        },
    };
    const judgeFromFrontend = () => new Promise<Record<string, unknown>>(resolve => emitCommand(emitter, 'weristdas:judge', { result: 'WRONG' }, `${r.code}:judge:round0:wrong`, resolve));
    const original = testPrisma.commandReceipt.update.bind(testPrisma.commandReceipt);
    let injected = false;
    testPrisma.commandReceipt.update = (async (args: Prisma.CommandReceiptUpdateArgs) => {
        if (args.data.status === 'COMPLETED' && !injected) {
            injected = true;
            throw new Error('LOST_FRONTEND_COMPLETION');
        }
        return original(args);
    }) as unknown as typeof testPrisma.commandReceipt.update;
    try {
        expect(await judgeFromFrontend()).toMatchObject({ success: false, outcomeUnknown: true });
    }
    finally {
        testPrisma.commandReceipt.update = original;
    }
    expect(injected).toBe(true);
    await ack(r.host, 'weristdas:buzzer:open', {});
    await ack(r.clients[1], 'weristdas:buzz', {});
    expect(await judgeFromFrontend()).toMatchObject({ success: false, error: 'COMMAND_STATE_ADVANCED', resyncRequired: true });
    expect(sentIds[1]).toBe(sentIds[0]);
    const state = JSON.parse((await testPrisma.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson);
    expect(state.scores[r.players[0].id]).toBe(-1);
    expect(state.scores[r.players[1].id]).toBe(0);
});
