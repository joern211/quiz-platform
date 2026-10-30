import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestDatabase } from '../../test-helpers.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let db: PrismaClient, dir: string, url: string, port: number, cookie: string, hostId: string, questions: string[];
let child: ChildProcess | undefined, stderr = '', sequence = 830000;
const sockets: Socket[] = [];
const origin = () => `http://127.0.0.1:${port}`;
async function connect(auth?: string) { const socket = await connectGameClient(origin(), auth); sockets.push(socket); return socket; }
async function stop() {
  const previous = child; child = undefined;
  if (previous && previous.exitCode === null && previous.signalCode === null) {
    const exited = new Promise<void>(resolve => previous.once('exit', () => resolve()));
    previous.kill('SIGKILL'); await exited;
  }
}
async function start() {
  stderr = '';
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: serverRoot, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: url, SESSION_SECRET: config.sessionSecret, STORAGE_ROOT: join(dir, 'storage'), LOG_LEVEL: 'error' } });
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-5000); });
  await vi.waitFor(async () => {
    if (child?.exitCode !== null) throw Error(`SERVER_EXIT: ${stderr}`);
    expect((await fetch(`${origin()}/api/v1/health`)).ok).toBe(true);
  }, { timeout: 20000, interval: 100 });
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-g3-restart-')); url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url); db = new PrismaClient({ datasourceUrl: url });
  const user = await db.user.create({ data: { displayName: 'G3 restart host', role: 'HOST', passwordHash: 'unused' } }); hostId = user.id;
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 3600000) } }); cookie = createSessionCookie(session.id, config.sessionSecret);
  for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA', minPlayers: 2 } });
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'G3 restart' } }); questions = [];
  for (let i = 0; i < 2; i++) { const q = await db.geoQuestion.create({ data: { packId: pack.id, prompt: `Restart ${i}`, category: 'test', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }]), correctOptionId: 'a', points: 100 } }); questions.push(q.id); }
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('NO_PORT'); port = address.port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  await start();
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect(); await stop(); await db?.$disconnect();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function fixture(slug: 'wissensduell' | 'jeopardy' | 'wer-ist-das', seconds = 600) {
  const definition = await db.gameDefinition.findUniqueOrThrow({ where: { slug } });
  let setup: object = { selectedQuestionIds: questions, timerDuration: seconds };
  if (slug === 'jeopardy') setup = { board1: { categories: [{ name: 'Restart', clues: [{ value: 100, question: 'Q', answer: 'RESTART_PRIVATE_SOLUTION' }, { value: 200, question: 'Q2', answer: 'RESTART_PRIVATE_SECOND' }] }] } };
  if (slug === 'wer-ist-das') {
    const image = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'restart.png', originalName: 'restart.png', fileSize: 12, sha256: randomUUID(), storagePath: join(dir, 'restart.png'), uploadedBy: hostId } });
    setup = { rounds: [{ id: 'first', imageAssetId: image.id, person1: 'RESTART_PRIVATE_A', person2: 'RESTART_PRIVATE_B' }, { id: 'second', imageAssetId: image.id, person1: 'RESTART_PRIVATE_C', person2: 'RESTART_PRIVATE_D' }] };
  }
  const code = String(sequence++).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'G3 restart', hostUserId: hostId, gameDefinitionId: definition.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(setup) } });
  const players = [];
  for (const displayName of ['Alice', 'Bob']) players.push(await db.participation.create({ data: { roomId: room.id, displayName, normalizedName: displayName.toLowerCase(), role: 'PLAYER', rejoinToken: randomUUID() } }));
  const clients = await reconnect({ code, players });
  for (const player of clients.players) expect((await gameAck(player, 'player:ready:set', { roomCode: code, ready: true })).success).toBe(true);
  expect((await gameAck(clients.host, 'game:start', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  if (slug === 'wissensduell') await vi.waitFor(async () => expect((await read(room.id)).row.phase).toBe('INPUT_OPEN'), { timeout: 7000, interval: 50 });
  return { room, code, players, clients };
}
async function reconnect(f: { code: string; players: Array<{ rejoinToken: string }> }) {
  const host = await connect(cookie); expect((await gameAck(host, 'room:subscribe', { roomCode: f.code })).success).toBe(true);
  const players = [];
  for (const player of f.players) { const socket = await connect(); expect((await gameAck(socket, 'room:subscribe', { roomCode: f.code, rejoinToken: player.rejoinToken })).success).toBe(true); players.push(socket); }
  return { host, players };
}
async function read(roomId: string) { const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } }); return { row, state: JSON.parse(row.stateJson) }; }
const command = (roomCode: string) => ({ roomCode, commandId: randomUUID() });
const ledger = async (roomId: string) => (await db.scoreEvent.findMany({ where: { roomId }, orderBy: { createdAt: 'asc' } })).map(e => [e.participationId, e.delta]);

it('Geo: a submitted answer is judged once by the host reveal; a restarted process replays the receipt without a second scoring', async () => {
  const f = await fixture('wissensduell'), [alice, bob] = f.players;
  expect((await gameAck(f.clients.players[0], 'geo:answer', { optionId: 'a', ...command(f.code) })).success).toBe(true);
  await stop(); await start(); let clients = await reconnect(f);
  expect(await gameAck(clients.players[1], 'geo:resync', {})).toMatchObject({ ownAnswer: null, ownAnswered: false });
  expect((await gameAck(clients.players[1], 'geo:answer', { optionId: 'b', ...command(f.code) })).success).toBe(true);
  const reveal = command(f.code);
  expect((await gameAck(clients.host, 'geo:reveal', reveal)).success).toBe(true);
  const revealed = await read(f.room.id);
  expect(revealed.state.scores).toMatchObject({ [alice.id]: 100, [bob.id]: 0 });
  expect(revealed.state.roundStates[0].playerStates[alice.id].submission).toMatchObject({ status: 'JUDGED', decision: 'CORRECT', matchStatus: 'MATCH' });
  expect(revealed.state.roundStates[0].playerStates[bob.id].submission).toMatchObject({ status: 'JUDGED', decision: 'WRONG', matchStatus: 'NO_MATCH' });
  const events = await db.gameDomainEvent.count({ where: { roomId: f.room.id } });
  await stop(); await start(); clients = await reconnect(f);
  expect(await gameAck(clients.host, 'geo:reveal', reveal)).toMatchObject({ success: true, replayed: true });
  expect((await gameAck(clients.host, 'geo:reveal', command(f.code))).success).toBe(false);
  expect(await read(f.room.id)).toEqual(revealed);
  expect(await ledger(f.room.id)).toEqual([[alice.id, 100], [bob.id, 0]]);
  expect(await db.gameDomainEvent.count({ where: { roomId: f.room.id } })).toBe(events);
  expect(await gameAck(clients.players[0], 'geo:resync', {})).toMatchObject({ revealed: true, ownAnswer: 'a', scores: { [alice.id]: 100 } });
});

it.each([
  ['jeopardy', 'jeopardy:judge', { correct: true }, 100],
  ['wer-ist-das', 'weristdas:judge', { result: 'BOTH_CORRECT' }, 3],
] as const)('%s: a judgement survives process death and its receipt cannot score twice', async (slug, judgeEvent, verdict, points) => {
  const f = await fixture(slug), [alice] = f.players;
  await gameAck(f.clients.host, slug === 'jeopardy' ? 'jeopardy:field:open' : 'weristdas:buzzer:open', { ...(slug === 'jeopardy' ? { boardIndex: 1, categoryIndex: 0, value: 100 } : {}), ...command(f.code) });
  expect((await gameAck(f.clients.players[0], slug === 'jeopardy' ? 'jeopardy:buzz' : 'weristdas:buzz', command(f.code))).success).toBe(true);
  await stop(); await start(); let clients = await reconnect(f);
  const judge = { ...verdict, ...command(f.code) };
  expect((await gameAck(clients.host, judgeEvent, judge)).success).toBe(true);
  const judged = await read(f.room.id);
  expect(judged.state.scores[alice.id]).toBe(points);
  expect(await ledger(f.room.id)).toEqual([[alice.id, points]]);
  await stop(); await start(); clients = await reconnect(f);
  expect(await read(f.room.id)).toEqual(judged);
  expect(await gameAck(clients.host, judgeEvent, judge)).toMatchObject({ success: true, replayed: true });
  expect((await gameAck(clients.host, judgeEvent, { ...verdict, ...command(f.code) })).success).toBe(false);
  expect(await read(f.room.id)).toEqual(judged);
  expect(await ledger(f.room.id)).toEqual([[alice.id, points]]);
  const watcher = await connect(); expect((await gameAck(watcher, 'room:subscribe', { roomCode: f.code })).success).toBe(true);
  expect(JSON.stringify(await gameAck(clients.players[1], slug === 'jeopardy' ? 'jeopardy:resync' : 'weristdas:resync', {}))).not.toContain('RESTART_PRIVATE_SOLUTION');
  if (slug === 'jeopardy') expect(JSON.stringify(await gameAck(watcher, 'jeopardy:resync', {}))).not.toContain('RESTART_PRIVATE');
});
