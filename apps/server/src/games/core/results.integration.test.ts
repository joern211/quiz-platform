import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import { createApp } from '../../app.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { cancelGeoTimer, handleGeoGame } from '../geo/index.js';
import { ensureGameStateSafe } from './recovery.js';
import { readGameResult } from './results.js';
import { joinPlayer } from '../../rooms/core.js';
import { socketIdentityMap } from '../../http/middleware/auth.js';

let db: PrismaClient, app: ReturnType<typeof createApp>, origin: string, cookie: string, questionId: string, packId: string;
const hostId = `results-${randomUUID()}`, rooms: string[] = [], sockets: Socket[] = [];
async function connect(auth?: string) { const s = await connectGameClient(origin, auth); sockets.push(s); return s; }
beforeAll(async () => {
  const { PrismaClient } = await import('@prisma/client'); db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL }); await db.$connect(); globalThis.__prisma = db;
  await db.user.create({ data: { id: hostId, displayName: 'Results Host', passwordHash: 'unused', role: 'HOST' } });
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 86400000) } }); cookie = createSessionCookie(session.id, config.sessionSecret);
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'Result test', status: 'PUBLISHED' } }); packId = pack.id;
  const q = await db.geoQuestion.create({ data: { packId, prompt: 'Public prompt', category: 'Test', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]), correctOptionId: 'a', points: 100 } }); questionId = q.id;
  app = createApp(); await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve)); const address = app.httpServer.address(); if (!address || typeof address === 'string') throw Error('NO_PORT'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const id of rooms) cancelGeoTimer(id); for (const s of sockets) s.disconnect();
  await new Promise<void>(resolve => app.io.close(() => app.httpServer.close(() => resolve())));
  await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(i => i.roomId && rooms.includes(i.roomId))).toHaveLength(0), { timeout: 10000 });
  await db.room.deleteMany({ where: { id: { in: rooms } } }); await db.questionPack.delete({ where: { id: packId } }); await db.user.delete({ where: { id: hostId } }); await db.$disconnect(); globalThis.__prisma = undefined;
});
async function start(slug: 'jeopardy' | 'wissensduell' = 'jeopardy', team = false) {
  const game = await db.gameDefinition.findUniqueOrThrow({ where: { slug } });
  const code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'Pinned result name', hostUserId: hostId, gameDefinitionId: game.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false,
    setupSnapshotJson: JSON.stringify(slug === 'wissensduell' ? { selectedQuestionIds: [questionId] } : { board1: { categories: [{ name: 'Category', clues: [{ value: 100, question: 'Public prompt', answer: 'RESULT_SECRET' }, { value: 200, question: 'Another prompt', answer: 'UNPLAYED_SECRET' }] }] } }),
  } }); rooms.push(room.id);
  const host = await connect(cookie); expect((await gameAck(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
  const players = [];
  for (const name of ['Alice', 'Bob']) {
    const p = await db.participation.create({ data: { roomId: room.id, displayName: name, normalizedName: name.toLowerCase(), rejoinToken: randomUUID(), role: 'PLAYER', ready: true } });
    const socket = await connect(); expect((await gameAck(socket, 'room:subscribe', { roomCode: code, rejoinToken: p.rejoinToken })).success).toBe(true);
    await gameAck(socket, 'player:ready:set', { roomCode: code, ready: true }); players.push({ ...p, socket });
  }
  if (team) {
    await db.room.update({ where: { id: room.id }, data: { roomPolicyJson: JSON.stringify({ scoring: 'TEAM_SCORE' }) } });
    for (const p of players) { const t = await db.roomTeam.create({ data: { roomId: room.id, name: p.displayName, color: '#123456', icon: 'A' } }); await db.participation.update({ where: { id: p.id }, data: { teamId: t.id } }); }
  }
  expect((await gameAck(host, 'game:start', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  cancelGeoTimer(room.id);
  return { room, code, host, players };
}
async function play(r: Awaited<ReturnType<typeof start>>, slug: 'jeopardy' | 'wissensduell', finish = true) {
  const player = r.players[0];
  if (slug === 'wissensduell') {
    await handleGeoGame.startRound(app.io, r.code); expect((await gameAck(player.socket, 'geo:answer', { optionId: 'a', commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(r.host, 'geo:reveal', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
    if (finish) expect((await gameAck(r.host, 'geo:next', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
  } else {
    expect((await gameAck(r.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(player.socket, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(r.host, 'jeopardy:judge', { correct: true, commandId: randomUUID() })).success).toBe(true);
    if (finish) {
      await gameAck(r.host, 'jeopardy:next', { commandId: randomUUID() });
      await gameAck(r.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 200, commandId: randomUUID() });
      await gameAck(player.socket, 'jeopardy:buzz', { commandId: randomUUID() }); await gameAck(r.host, 'jeopardy:judge', { correct: true, commandId: randomUUID() });
      expect((await gameAck(r.host, 'jeopardy:board:switch', { toBoard: 2, commandId: randomUUID() })).success).toBe(true);
    }
  }
}
async function command(r: Awaited<ReturnType<typeof start>>, operation: Record<string, unknown>, revision: number, extra: Record<string, unknown> = {}, socket = r.host) {
  return gameAck(socket, 'game:result:command', { roomCode: r.code, commandId: randomUUID(), runIndex: 1, resultRevision: revision, operation, ...extra });
}
it.each(['jeopardy', 'wissensduell'] as const)('%s persists round and game results atomically, with ties, strict projections and idempotent finalization', async slug => {
  const r = await start(slug); await play(r, slug);
  const result = await readGameResult(r.room.id, 1); expect(result).not.toBeNull();
  expect(result!.summary.result).toMatchObject({ engineVersion: 1, endReason: 'COMPLETED', aborted: false, roundCount: slug === 'jeopardy' ? 2 : 1 });
  expect(result!.summary.integrity).toBe('VERIFIED');
  const rounds = await db.roundResultRecord.findMany({ where: { roomId: r.room.id } }); expect(rounds).toHaveLength(slug === 'jeopardy' ? 2 : 1);
  expect(new Set(rounds.map(x => x.roundKey)).size).toBe(rounds.length);
  const response = await request(app.app).get(`/api/v1/rooms/${r.code}/results`); expect(response.status).toBe(200);
  expect(response.body.data.scores).toHaveLength(2); expect(JSON.stringify(response.body)).not.toMatch(/RESULT_SECRET|UNPLAYED_SECRET|correctOptionId|rejoinToken|configSnapshot|stateJson/);
  expect((await command(r, { type: 'REVIEW' }, 1, {}, r.players[0].socket)).success).toBe(false);
  expect((await command(r, { type: 'REVIEW' }, 1)).success).toBe(true);
  expect((await command(r, { type: 'FINALIZE' }, 1)).success).toBe(false);
  const id = randomUUID(); expect((await command(r, { type: 'FINALIZE' }, 2, { commandId: id })).success).toBe(true);
  expect((await command(r, { type: 'FINALIZE' }, 2, { commandId: id })).replayed).toBe(true);
  expect((await db.gameResultRecord.findFirstOrThrow({ where: { roomId: r.room.id } })).revision).toBe(3);
  expect(await db.gameResultVersion.count({ where: { resultId: result!.row.id } })).toBe(3);
  const otherClient = new (await import('@prisma/client')).PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  expect((await otherClient.gameResultRecord.findUniqueOrThrow({ where: { id: result!.row.id } })).status).toBe('FINALIZED'); await otherClient.$disconnect();
});
it('keeps original results and ledger immutable, uses compensating events and isolates an amendment after rematch', async () => {
  const r = await start('jeopardy', true); await play(r, 'jeopardy');
  const initial = (await readGameResult(r.room.id, 1))!; const player = r.players[0];
  const event = await db.scoreEvent.findFirstOrThrow({ where: { roomId: r.room.id, participationId: player.id, delta: 100 } });
  expect((await command(r, { type: 'REVIEW' }, 1)).success).toBe(true);
  expect((await command(r, { type: 'ROLLBACK', referenceEventId: event.id, reason: 'Bewertung korrigiert' }, 2)).success).toBe(true);
  expect((await command(r, { type: 'ROLLBACK', referenceEventId: event.id, reason: 'Nicht doppelt' }, 3)).success).toBe(false);
  expect((await readGameResult(r.room.id, 1))!.summary.result.participants.find(p => p.participantId === player.id)?.score).toBe(200);
  expect((await command(r, { type: 'FINALIZE' }, 3)).success).toBe(true);
  expect((await command(r, { type: 'ADJUST', participantId: player.id, delta: 10, reason: 'Falscher Weg' }, 4)).success).toBe(false);
  expect((await gameAck(r.host, 'room:command', { roomCode: r.code, commandId: randomUUID(), protocolVersion: 1, operation: { type: 'REMATCH' } })).success).toBe(true);
  const before = await db.room.findUniqueOrThrow({ where: { id: r.room.id } }); expect(before.runIndex).toBe(2);
  await db.room.update({ where: { id: r.room.id }, data: { status: 'ENDED' } });
  expect((await gameAck(r.host, 'room:command', { roomCode: r.code, commandId: randomUUID(), protocolVersion: 1, operation: { type: 'REMATCH', runIndex: 1 } })).success).toBe(false);
  await db.room.update({ where: { id: r.room.id }, data: { status: 'LOBBY' } });

  expect((await command(r, { type: 'AMEND', participantId: player.id, delta: 20, reason: 'Spätere dokumentierte Korrektur' }, 4)).success).toBe(true);
  expect((await db.participation.findUniqueOrThrow({ where: { id: player.id } })).score).toBe(0);
  expect((await db.room.findUniqueOrThrow({ where: { id: r.room.id } })).revision).toBe(before.revision);
  const amended = (await readGameResult(r.room.id, 1))!; expect(amended.summary.result.participants.find(p => p.participantId === player.id)?.score).toBe(220);
  expect(amended.summary.teams[0].score).toBe(220);
  expect((await readGameResult(r.room.id, 1, 1))!.summary).toEqual(initial.summary);
  await expect(db.gameResultVersion.update({ where: { id: initial.version.id }, data: { dataJson: '{}' } })).rejects.toThrow();
  await expect(db.scoreEvent.update({ where: { id: event.id }, data: { delta: 999 } })).rejects.toThrow();
  const historical = await request(app.app).get(`/api/v1/rooms/${r.code}/results?runIndex=1`); expect(historical.body.data.resultRevision).toBe(5);
  expect((await request(app.app).get(`/api/v1/rooms/${r.code}/results`)).status).toBe(404);
});
it('refuses foreign-run references and stale concurrent corrections; tie ranks agree and revoked grants take effect', async () => {
  const r = await start(); await play(r, 'jeopardy'); await command(r, { type: 'REVIEW' }, 1);
  const responses = await Promise.all([1, 2].map(() => command(r, { type: 'ADJUST', participantId: r.players[1].id, delta: 300, reason: 'Gleichstand' }, 2)));
  expect(responses.filter(x => x.success)).toHaveLength(1);
  const summary = (await readGameResult(r.room.id, 1))!.summary; expect(summary.result.participants.map(p => p.rank)).toEqual([1, 1]); expect(summary.result.winnerIds).toHaveLength(2);
  await db.roomPermissionGrant.create({ data: { roomId: r.room.id, userId: hostId, permission: 'SCORE_ADJUST', direction: 'REVOKE', grantedBy: hostId } });
  expect((await command(r, { type: 'FINALIZE' }, 3)).success).toBe(false);
  expect((await db.gameResultRecord.findFirstOrThrow({ where: { roomId: r.room.id } })).status).toBe('RESULT_REVIEW');
});
it('repairs from committed replay evidence without changing points/random and rejects players, stale state and duplicate effects', async () => {
  const r = await start(); await play(r, 'jeopardy', false);
  const before = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } }); const ledgerCount = await db.scoreEvent.count({ where: { roomId: r.room.id } });
  await db.roomGameState.update({ where: { roomId: r.room.id }, data: { stateJson: '{broken' } });
  await expect(ensureGameStateSafe(r.room.id)).rejects.toThrow('STATE_INVARIANT_FAILED');
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } });
  const payload = { roomCode: r.code, runIndex: 1, gameStateVersion: frozen.revision, commandId: randomUUID(), operation: 'RESTORE_REPLAY' };
  expect((await gameAck(r.players[0].socket, 'game:recovery:command', payload)).success).toBe(false);
  expect((await gameAck(r.host, 'game:recovery:command', { ...payload, commandId: randomUUID(), gameStateVersion: before.revision })).success).toBe(false);
  expect((await gameAck(r.host, 'game:recovery:command', payload)).success).toBe(true);
  expect((await gameAck(r.host, 'game:recovery:command', payload)).replayed).toBe(true);
  const repaired = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } });
  expect(JSON.parse(repaired.stateJson)).toEqual(JSON.parse(before.stateJson)); expect(repaired.revision).toBe(frozen.revision + 1);
  expect(await db.scoreEvent.count({ where: { roomId: r.room.id } })).toBe(ledgerCount);
  expect(await db.auditLog.count({ where: { resourceId: r.room.id, action: 'RECOVERY_RESTORED' } })).toBe(1);
  // A second repair starts at the latest explicit checkpoint, across the prior freeze's revision gap.
  await db.roomGameState.update({ where: { roomId: r.room.id }, data: { stateJson: '{broken-again' } });
  await expect(ensureGameStateSafe(r.room.id)).rejects.toThrow('STATE_INVARIANT_FAILED');
  const second = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } });
  expect((await gameAck(r.host, 'game:recovery:command', { ...payload, gameStateVersion: second.revision, commandId: randomUUID() })).success).toBe(true);
  expect(JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } })).stateJson)).toEqual(JSON.parse(before.stateJson));
  expect(await db.scoreEvent.count({ where: { roomId: r.room.id } })).toBe(ledgerCount);

});
it('requires participation proof for protected result reads and rejects forged absolute-score payloads', async () => {
  const r = await start(); await play(r, 'jeopardy');
  await db.room.update({ where: { id: r.room.id }, data: { isPublic: false } });
  expect((await request(app.app).get(`/api/v1/rooms/${r.code}/results`)).status).toBe(403);
  expect((await request(app.app).get(`/api/v1/rooms/${r.code}/results`).set('Cookie', cookie)).status).toBe(200);
  expect((await request(app.app).get(`/api/v1/rooms/${r.code}/results`).set('X-Rejoin-Token', r.players[0].rejoinToken)).status).toBe(200);
  expect((await request(app.app).get(`/api/v1/rooms/${r.code}/results`).set('X-Rejoin-Token', 'foreign-token')).status).toBe(403);
  const viewer = await connect();
  expect((await gameAck(viewer, 'game:result:read', { roomCode: r.code })).success).toBe(false);
  expect((await gameAck(viewer, 'room:subscribe', { roomCode: r.code, role: 'VIEWER' })).success).toBe(true);
  const viewerResult = await gameAck(viewer, 'game:result:read', { roomCode: r.code });
  expect(viewerResult).toMatchObject({ success: true, data: { runIndex: 1, resultStatus: 'GAME_END' } });
  expect(JSON.stringify(viewerResult)).not.toMatch(/RESULT_SECRET|UNPLAYED_SECRET|configSnapshot|rejoinToken/);
  expect((await gameAck(viewer, 'game:result:read', { roomCode: '000-000' })).success).toBe(false);

  const count = await db.scoreEvent.count({ where: { roomId: r.room.id } });
  expect((await command(r, { type: 'ADJUST', participantId: r.players[0].id, score: 9000, reason: 'Forged' }, 1)).error).toBe('INVALID_PAYLOAD');
  expect(await db.scoreEvent.count({ where: { roomId: r.room.id } })).toBe(count);
});
it('rejects cross-room score references and leaves a finalization blocked when ledger evidence changed', async () => {
  const r = await start(), other = await start(); await play(r, 'jeopardy'); await play(other, 'jeopardy'); await command(r, { type: 'REVIEW' }, 1);
  const foreign = await db.scoreEvent.findFirstOrThrow({ where: { roomId: other.room.id } });
  expect((await command(r, { type: 'ROLLBACK', referenceEventId: foreign.id, reason: 'Foreign' }, 2)).success).toBe(false);
  await db.scoreEvent.create({ data: { roomId: r.room.id, participationId: r.players[0].id, runIndex: 1, delta: 50, reason: 'Unreconciled evidence' } });
  expect((await command(r, { type: 'FINALIZE' }, 2)).success).toBe(false);
  expect((await readGameResult(r.room.id, 1))!.row.status).toBe('RESULT_REVIEW');
});
it('records an abort without inventing winners and refuses recovery without valid evidence', async () => {
  const r = await start(); expect((await gameAck(r.host, 'game:end', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
  const result = (await readGameResult(r.room.id, 1))!.summary.result;
  expect(result).toMatchObject({ endReason: 'HOST_ABORTED', aborted: true, winnerIds: [], roundCount: 0 });
  const broken = await start(); await db.gameDomainEvent.deleteMany({ where: { roomId: broken.room.id } });
  await db.roomGameState.update({ where: { roomId: broken.room.id }, data: { stateJson: '{broken' } });
  await expect(ensureGameStateSafe(broken.room.id)).rejects.toThrow();
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: broken.room.id } });
  const response = await gameAck(broken.host, 'game:recovery:command', { roomCode: broken.code, runIndex: 1, gameStateVersion: frozen.revision, commandId: randomUUID(), operation: 'RESTORE_REPLAY' });
  expect(response).toMatchObject({ success: false, error: 'RECOVERY_EVIDENCE_MISSING' });
  expect((await db.roomGameState.findUniqueOrThrow({ where: { roomId: broken.room.id } })).stateJson).toBe(frozen.stateJson);
});

it('preserves an admitted and renamed late player across recovery and accepts their next score', async () => {
  const r = await start(); await play(r, 'jeopardy', false);
  await db.room.update({ where: { id: r.room.id }, data: { roomPolicyJson: JSON.stringify({ allowLateJoin: true }) } });
  await gameAck(r.host, 'jeopardy:next', { commandId: randomUUID() });
  const late = await joinPlayer(r.room.id, { displayName: 'Late before recovery' });
  const socket = await connect(); expect((await gameAck(socket, 'room:subscribe', { roomCode: r.code, rejoinToken: late.rejoinToken })).success).toBe(true);
  const roomCommand = (operation: object) => gameAck(r.host, 'room:command', { roomCode: r.code, commandId: randomUUID(), protocolVersion: 1, operation });
  expect((await roomCommand({ type: 'ADMIT', participantId: late.id, approve: true })).success).toBe(true);
  expect((await roomCommand({ type: 'RENAME', participantId: late.id, name: 'Late retained' })).success).toBe(true);
  const before = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } });
  const ledger = await db.scoreEvent.findMany({ where: { roomId: r.room.id } });
  await db.roomGameState.update({ where: { roomId: r.room.id }, data: { stateJson: '{broken' } });
  await expect(ensureGameStateSafe(r.room.id)).rejects.toThrow('STATE_INVARIANT_FAILED');
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } });
  expect((await gameAck(r.host, 'game:recovery:command', { roomCode: r.code, runIndex: 1, gameStateVersion: frozen.revision, commandId: randomUUID(), operation: 'RESTORE_REPLAY' })).success).toBe(true);
  expect(JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } })).stateJson)).toEqual(JSON.parse(before.stateJson));
  expect(await db.scoreEvent.findMany({ where: { roomId: r.room.id } })).toEqual(ledger);
  expect((await db.participation.findUniqueOrThrow({ where: { id: late.id } })).admission).toBe('ACTIVE');
  expect((await gameAck(r.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 200, commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(socket, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(r.host, 'jeopardy:judge', { correct: true, commandId: randomUUID() })).success).toBe(true);
  expect((await db.participation.findUniqueOrThrow({ where: { id: late.id } })).score).toBe(200);
});
it('refuses a valid but stale event tail that omits a legacy room mutation', async () => {
  const r = await start(); await play(r, 'jeopardy', false);
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } });
  // Simulate an older deployed writer that committed a runtime change without an event.
  const state = JSON.parse(row.stateJson); state.playerNames[r.players[0].id] = 'Unlogged committed name';
  await db.roomGameState.update({ where: { roomId: r.room.id }, data: { stateJson: JSON.stringify(state), revision: { increment: 1 } } });
  await db.roomGameState.update({ where: { roomId: r.room.id }, data: { stateJson: '{broken' } });
  await expect(ensureGameStateSafe(r.room.id)).rejects.toThrow('STATE_INVARIANT_FAILED');
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } });
  const ledger = await db.scoreEvent.findMany({ where: { roomId: r.room.id } });
  expect(await gameAck(r.host, 'game:recovery:command', { roomCode: r.code, runIndex: 1, gameStateVersion: frozen.revision, commandId: randomUUID(), operation: 'RESTORE_REPLAY' })).toMatchObject({ success: false, error: 'RECOVERY_EVIDENCE_INVALID' });
  expect(await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } })).toEqual(frozen);
  expect(await db.scoreEvent.findMany({ where: { roomId: r.room.id } })).toEqual(ledger);
  expect(await db.auditLog.count({ where: { resourceId: r.room.id, action: 'RECOVERY_RESTORED' } })).toBe(0);
});
it('G5: recovery with a complete event tail still refuses a ledger that disagrees with the replayed scores, and a foreign run, without changing anything', async () => {
  const r = await start(); await play(r, 'jeopardy', false);
  await db.roomGameState.update({ where: { roomId: r.room.id }, data: { stateJson: '{broken' } });
  await expect(ensureGameStateSafe(r.room.id)).rejects.toThrow('STATE_INVARIANT_FAILED');
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } });
  const recover = (extra: object = {}) => gameAck(r.host, 'game:recovery:command', { roomCode: r.code, runIndex: 1, gameStateVersion: frozen.revision, commandId: randomUUID(), operation: 'RESTORE_REPLAY', ...extra });
  expect(await recover({ runIndex: 2 })).toMatchObject({ success: false, error: 'STATE_CONFLICT' });
  // evidence that reaches the exact version but contradicts the ledger: points that no event produced
  await db.scoreEvent.create({ data: { roomId: r.room.id, participationId: r.players[0].id, runIndex: 1, delta: 0, reason: 'zero row is no disagreement' } });
  const extra = await db.scoreEvent.create({ data: { roomId: r.room.id, participationId: r.players[0].id, runIndex: 1, delta: 7, reason: 'Unreconciled evidence' } });
  expect(await recover()).toMatchObject({ success: false, error: 'RECOVERY_LEDGER_MISMATCH' });
  expect(await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.room.id } })).toEqual(frozen);
  expect(await db.auditLog.count({ where: { resourceId: r.room.id, action: 'RECOVERY_RESTORED' } })).toBe(0);
  await db.scoreEvent.delete({ where: { id: extra.id } });
  expect((await recover()).success).toBe(true);
});
