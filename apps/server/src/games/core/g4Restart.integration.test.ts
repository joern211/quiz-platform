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
let child: ChildProcess | undefined, stderr = '', sequence = 850000;
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
  dir = await mkdtemp(join(tmpdir(), 'quiz-g4-restart-')); url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url); db = new PrismaClient({ datasourceUrl: url });
  const user = await db.user.create({ data: { displayName: 'G4 restart host', role: 'HOST', passwordHash: 'unused' } }); hostId = user.id;
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 3600000) } }); cookie = createSessionCookie(session.id, config.sessionSecret);
  for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA', minPlayers: 2 } });
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'G4 restart' } }); questions = [];
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
  const room = await db.room.create({ data: { code, roomName: 'G4 restart', hostUserId: hostId, gameDefinitionId: definition.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(setup) } });
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
const ledger = async (roomId: string) => (await db.scoreEvent.findMany({ where: { roomId }, orderBy: { createdAt: 'asc' } })).map(e => [e.participationId, e.delta, e.kind]);
const versions = async (roomId: string) => (await db.gameResultVersion.findMany({ where: { result: { roomId } }, orderBy: { revision: 'asc' } })).map(v => [v.revision, v.kind]);
const resultCommand = (code: string, resultRevision: number, operation: object, commandId: string = randomUUID()) => ({ roomCode: code, commandId, protocolVersion: 1, runIndex: 1, resultRevision, operation });

it('Result commands: a correction acknowledged to nobody is replayed after process death without a second effect; history stays readable', async () => {
  const f = await fixture('wissensduell'), [alice, bob] = f.players;
  let clients = f.clients;
  expect((await gameAck(clients.players[0], 'geo:answer', { optionId: 'a', ...command(f.code) })).success).toBe(true);
  expect((await gameAck(clients.host, 'geo:reveal', command(f.code))).success).toBe(true);
  expect((await gameAck(clients.host, 'game:end', command(f.code))).success).toBe(true);
  const review = resultCommand(f.code, 1, { type: 'REVIEW' }), finalize = resultCommand(f.code, 2, { type: 'FINALIZE' }), amend = resultCommand(f.code, 3, { type: 'AMEND', participantId: bob.id, delta: 7, reason: 'Nachtrag' });
  for (const c of [review, finalize, amend]) expect((await gameAck(clients.host, 'game:result:command', c)).success).toBe(true);
  const settled = { versions: await versions(f.room.id), ledger: await ledger(f.room.id), record: await db.gameResultRecord.findFirstOrThrow({ where: { roomId: f.room.id } }) };
  expect(settled.versions).toEqual([[1, 'GAME_ENDED'], [2, 'REVIEW'], [3, 'FINALIZE'], [4, 'RESULT_AMENDMENT']]);
  await stop(); await start(); clients = await reconnect(f);
  // the same intents arrive again (their acknowledgements were "lost"): answered from the stored receipt, no new version, no new ledger row
  for (const c of [review, finalize, amend]) expect(await gameAck(clients.host, 'game:result:command', c)).toMatchObject({ success: true, replayed: true });
  expect(await versions(f.room.id)).toEqual(settled.versions);
  expect(await ledger(f.room.id)).toEqual(settled.ledger);
  expect((await db.gameResultRecord.findFirstOrThrow({ where: { roomId: f.room.id } })).revision).toBe(settled.record.revision);
  // a new intent for an old revision is refused, a different payload under a used id is a conflict
  expect(await gameAck(clients.host, 'game:result:command', resultCommand(f.code, 3, { type: 'AMEND', participantId: bob.id, delta: 1, reason: 'veraltet' }))).toMatchObject({ success: false, error: 'REVISION_CONFLICT' });
  expect(await gameAck(clients.host, 'game:result:command', { ...amend, operation: { type: 'AMEND', participantId: bob.id, delta: 8, reason: 'Nachtrag' } })).toMatchObject({ success: false, error: 'COMMAND_CONFLICT' });
  expect(await versions(f.room.id)).toEqual(settled.versions);
  const old = await gameAck(clients.players[1], 'game:result:read', { roomCode: f.code, revision: 1 }) as { data: { scores: Array<{ participationId: string; score: number }>; isLatestRevision: boolean; statusAtRevision: string } };
  expect(old.data).toMatchObject({ isLatestRevision: false, statusAtRevision: 'GAME_END' });
  expect(old.data.scores.find(x => x.participationId === bob.id)!.score).toBe(0);
  expect((await gameAck(clients.players[1], 'game:result:read', { roomCode: f.code })) as { data: { scores: Array<{ participationId: string; score: number }> } }).toMatchObject({ data: { scores: expect.arrayContaining([expect.objectContaining({ participationId: bob.id, score: 7 }), expect.objectContaining({ participationId: alice.id, score: 100 })]) } });
});

it('Limits: the in-memory budget is deliberately not persisted — a restart starts fresh and refusals never left a receipt', async () => {
  const f = await fixture('wissensduell');
  let clients = f.clients;
  const burst = await Promise.all(Array.from({ length: 60 }, () => gameAck(clients.players[0], 'geo:answer', { optionId: 'b', ...command(f.code) })));
  expect(burst.some(r => r.error === 'RATE_LIMITED')).toBe(true);
  const refused = burst.filter(r => r.error === 'RATE_LIMITED').length;
  expect(await db.commandReceipt.count({ where: { roomId: f.room.id, action: 'ANSWER_SUBMIT' } })).toBe(burst.length - refused);
  await stop(); await start(); clients = await reconnect(f);
  expect(await gameAck(clients.players[0], 'geo:resync', { roomCode: f.code })).toMatchObject({ success: true, ownAnswer: 'b' });
  expect(await gameAck(clients.players[0], 'geo:answer', { optionId: 'c', ...command(f.code) })).toMatchObject({ success: false, error: 'ALREADY_ANSWERED' });
});
