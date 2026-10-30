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
let child: ChildProcess | undefined, stderr = '', sequence = 810000;
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
  dir = await mkdtemp(join(tmpdir(), 'quiz-g2-restart-')); url = `file:${join(dir, 'test.db')}`;
  await createTestDatabase(url); db = new PrismaClient({ datasourceUrl: url });
  const user = await db.user.create({ data: { displayName: 'G2 restart host', role: 'HOST', passwordHash: 'unused' } }); hostId = user.id;
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 3600000) } }); cookie = createSessionCookie(session.id, config.sessionSecret);
  for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA', minPlayers: 2 } });
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'G2 restart' } }); questions = [];
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
  const room = await db.room.create({ data: { code, roomName: 'G2 restart', hostUserId: hostId, gameDefinitionId: definition.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false, setupSnapshotJson: JSON.stringify(setup) } });
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
it('retains an active Geo deadline and own accepted answer, then a paused budget, across two actual process deaths', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.clients.players[0], 'geo:answer', { optionId: 'a', ...command(f.code) })).success).toBe(true);
  const before = await read(f.room.id); await stop(); await start();
  let clients = await reconnect(f); expect(await read(f.room.id)).toEqual(before);
  const own = await gameAck(clients.players[0], 'geo:resync', {}); expect(own).toMatchObject({ success: true, ownAnswer: 'a', ownAnswered: true, timerEndMs: before.state.roundStates[0].timer.endsAtMs });
  const viewer = await connect(); expect((await gameAck(viewer, 'room:subscribe', { roomCode: f.code })).success).toBe(true);
  const publicView = await gameAck(viewer, 'geo:resync', {}); expect(publicView.question).not.toHaveProperty('correctOptionId'); expect(publicView.ownAnswer).toBeNull();
  expect((await gameAck(clients.host, 'game:pause', command(f.code))).success).toBe(true);
  const paused = await read(f.room.id), remaining = paused.state.roundStates[0].timer.remainingMs;
  await stop(); await start(); clients = await reconnect(f); expect(await read(f.room.id)).toEqual(paused);
  expect(await gameAck(clients.players[0], 'geo:resync', {})).toMatchObject({ success: true, phase: 'PAUSED', timerEndMs: null, pauseRemainingMs: remaining });
  const lower = Date.now(); expect((await gameAck(clients.host, 'game:resume', command(f.code))).success).toBe(true); const upper = Date.now();
  const resumed = await read(f.room.id), deadline = resumed.state.roundStates[0].timer.endsAtMs;
  expect(deadline).toBeGreaterThanOrEqual(lower + remaining); expect(deadline).toBeLessThanOrEqual(upper + remaining);
  expect(resumed.state.roundStates[0].playerStates[f.players[0].id].answered).toBe(true);
});
it('settles an offline-expired Geo deadline once on a fresh process without awarding points again on a second restart', async () => {
  const f = await fixture('wissensduell', 1);
  expect((await gameAck(f.clients.players[0], 'geo:answer', { optionId: 'a', ...command(f.code) })).success).toBe(true);
  const before = await read(f.room.id); await stop();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, before.state.roundStates[0].timer.endsAtMs - Date.now() + 50)));
  await start(); const settled = await read(f.room.id);
  expect(settled.row.phase).toBe('REVEAL'); expect(settled.state.scores[f.players[0].id]).toBe(100);
  const scores = await db.scoreEvent.count({ where: { roomId: f.room.id } }); expect(scores).toBe(1);
  const events = await db.gameDomainEvent.count({ where: { roomId: f.room.id } });
  await stop(); await start(); const clients = await reconnect(f);
  expect((await gameAck(clients.host, 'geo:resync', {})).phase).toBe('REVEAL'); expect(await read(f.room.id)).toEqual(settled);
  expect(await db.scoreEvent.count({ where: { roomId: f.room.id } })).toBe(scores);
  expect(await db.gameDomainEvent.count({ where: { roomId: f.room.id } })).toBe(events);
});
it.each(['jeopardy', 'wer-ist-das'] as const)('%s resumes the persisted winner/turn after process death and excludes the same wrong-answer player', async slug => {
  const f = await fixture(slug), open = slug === 'jeopardy' ? 'jeopardy:field:open' : 'weristdas:buzzer:open';
  expect((await gameAck(f.clients.host, open, { ...(slug === 'jeopardy' ? { boardIndex: 1, categoryIndex: 0, value: 100 } : {}), ...command(f.code) })).success).toBe(true);
  expect((await gameAck(f.clients.players[0], slug === 'jeopardy' ? 'jeopardy:buzz' : 'weristdas:buzz', command(f.code))).success).toBe(true);
  const winner = await read(f.room.id), pause = command(f.code);
  expect((await gameAck(f.clients.host, 'game:pause', pause)).success).toBe(true);
  const paused = await read(f.room.id); await stop(); await start(); const clients = await reconnect(f);
  expect(await read(f.room.id)).toEqual(paused);
  expect(await gameAck(clients.host, 'game:pause', pause)).toMatchObject({ success: true, replayed: true });
  expect((await gameAck(clients.host, 'game:resume', command(f.code))).success).toBe(true);
  const resumed = await read(f.room.id); expect(resumed.state.buzzer).toEqual(winner.state.buzzer); expect(resumed.state.answerTurn).toEqual(winner.state.answerTurn);
  const publicClient = await connect(); expect((await gameAck(publicClient, 'room:subscribe', { roomCode: f.code })).success).toBe(true);
  expect(JSON.stringify(await gameAck(publicClient, slug === 'jeopardy' ? 'jeopardy:resync' : 'weristdas:resync', {}))).not.toContain('RESTART_PRIVATE');
  expect((await gameAck(clients.host, slug === 'jeopardy' ? 'jeopardy:judge' : 'weristdas:judge', { ...(slug === 'jeopardy' ? { correct: false } : { result: 'WRONG' }), ...command(f.code) })).success).toBe(true);
  if (slug === 'wer-ist-das') expect((await gameAck(clients.host, open, command(f.code))).success).toBe(true);
  const nextBuzz = slug === 'jeopardy' ? 'jeopardy:steal:buzz' : 'weristdas:buzz';
  expect((await gameAck(clients.players[0], nextBuzz, command(f.code))).success).toBe(false);
  expect((await gameAck(clients.players[1], nextBuzz, command(f.code))).success).toBe(true);
});

it('continues a committed input-lock checkpoint on restart before accepting further play', async () => {
  const f = await fixture('wissensduell');
  expect((await gameAck(f.clients.players[0], 'geo:answer', { optionId: 'a', ...command(f.code) })).success).toBe(true);
  await stop();
  // Persist exactly the shape of the expiry checkpoint, before its separate
  // reveal transaction. No result, score or fabricated event is seeded.
  const checkpoint = await read(f.room.id), round = checkpoint.state.roundStates[0];
  checkpoint.state.phase = 'INPUT_LOCKED'; round.timerEndMs = Date.now() - 1;
  round.timer = { ...round.timer, status: 'EXPIRED', endsAtMs: null, startedAtMs: null, pausedAtMs: null, remainingMs: 0, elapsedBeforeMs: 600000 };
  round.playerStates[f.players[0].id].submission.status = 'LOCKED';
  await db.roomGameState.update({ where: { roomId: f.room.id }, data: { phase: 'INPUT_LOCKED', stateJson: JSON.stringify(checkpoint.state), revision: { increment: 1 } } });
  expect(await db.scoreEvent.count({ where: { roomId: f.room.id } })).toBe(0);
  await start(); const clients = await reconnect(f), settled = await read(f.room.id);
  expect(settled.row.phase).toBe('REVEAL'); expect(settled.state.scores[f.players[0].id]).toBe(100);
  expect((await gameAck(clients.host, 'geo:resync', {})).phase).toBe('REVEAL');
  expect(await db.scoreEvent.count({ where: { roomId: f.room.id } })).toBe(1);
});
