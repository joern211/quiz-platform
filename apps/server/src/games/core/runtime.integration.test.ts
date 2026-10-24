import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import { createApp } from '../../app.js';
import { createSessionCookie } from '../../auth/session.js';
import { config } from '../../config/index.js';
import { connectGameClient, gameAck } from '../../test-socket-harness.js';
import { cancelGeoTimer, handleGeoGame } from '../geo/index.js';
import { socketIdentityMap } from '../../http/middleware/auth.js';
import { CoreRuntimeProjectionSchema } from '@quiz/shared';
import { saveGameStateIfRevision } from './state.js';
import { createTurn } from './roundFlow.js';
import { applyStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';

let db: PrismaClient, app: ReturnType<typeof createApp>, origin: string, cookie: string, questionId: string, packId: string;
const hostId = `runtime-${randomUUID()}`, rooms: string[] = [], assets: string[] = [], sockets: Socket[] = [];
async function connect(auth?: string) { const socket = await connectGameClient(origin, auth); sockets.push(socket); return socket; }
async function runtime(socket: Socket) {
  const response = await gameAck(socket, 'game:core:read', {});
  expect(response.success).toBe(true);
  return CoreRuntimeProjectionSchema.parse(response.projection);
}
async function assertEventReplay(roomId: string) {
  const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId } });
  const events = await db.gameDomainEvent.findMany({ where: { roomId, runIndex: 1 }, orderBy: { stateVersion: 'asc' } });
  expect(events[0]).toMatchObject({ type: 'GAME_INITIALIZED', baseStateVersion: 0, stateVersion: 1 });
  let snapshot: EngineStateSnapshot = { roomId, runIndex: 1, gameSlug: events[0].gameSlug, engineVersion: events[0].engineVersion, stateVersion: 0, state: {} };
  for (const event of events) snapshot = applyStateEvent(snapshot, JSON.parse(event.payloadJson));
  expect(snapshot.stateVersion).toBe(row.revision);
  expect(snapshot.state).toEqual(JSON.parse(row.stateJson));
}
beforeAll(async () => {
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL }); await db.$connect(); globalThis.__prisma = db;
  await db.user.create({ data: { id: hostId, displayName: 'Runtime Host', passwordHash: 'unused', role: 'HOST' } });
  const session = await db.session.create({ data: { userId: hostId, expiresAt: new Date(Date.now() + 86400000) } });
  cookie = createSessionCookie(session.id, config.sessionSecret);
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'Runtime integration', status: 'PUBLISHED' } }); packId = pack.id;
  const question = await db.geoQuestion.create({ data: { packId, prompt: 'Runtime question', category: 'Test', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]), correctOptionId: 'a', points: 100 } }); questionId = question.id;
  app = createApp(); await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve));
  const address = app.httpServer.address(); if (!address || typeof address === 'string') throw Error('NO_PORT'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const id of rooms) cancelGeoTimer(id);
  for (const socket of sockets) socket.disconnect();
  await new Promise<void>(resolve => app.io.close(() => app.httpServer.close(() => resolve())));
  await vi.waitFor(() => expect([...socketIdentityMap.values()].filter(identity => identity.roomId && rooms.includes(identity.roomId))).toHaveLength(0), { timeout: 10000 });
  await db.room.deleteMany({ where: { id: { in: rooms } } }); await db.questionPack.delete({ where: { id: packId } });
  await db.mediaAsset.deleteMany({ where: { id: { in: assets } } });
  await db.user.delete({ where: { id: hostId } }); await db.$disconnect(); globalThis.__prisma = undefined;
});
async function start(slug: 'wissensduell' | 'jeopardy' | 'wer-ist-das', playerCount = 2, teamMode = false) {
  let imageId: string | undefined;
  if (slug === 'wer-ist-das') {
    const asset = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'runtime.png', originalName: 'runtime.png', fileSize: 12, sha256: randomUUID(), storagePath: '/tmp/runtime.png', uploadedBy: hostId } });
    imageId = asset.id; assets.push(asset.id);
  }
  const game = await db.gameDefinition.findUniqueOrThrow({ where: { slug } });
  const code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
  const room = await db.room.create({ data: { code, roomName: 'Runtime proof', hostUserId: hostId, gameDefinitionId: game.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false,
    setupSnapshotJson: JSON.stringify(slug === 'wissensduell' ? { selectedQuestionIds: [questionId] } : slug === 'wer-ist-das' ? { rounds: [{ id: 'override', imageAssetId: imageId, person1: 'SECRET_A', person2: 'SECRET_B' }, ...(teamMode ? [{ id: 'next', imageAssetId: imageId, person1: 'SECRET_C', person2: 'SECRET_D' }] : [])] } : { board1: { categories: [{ name: 'Test', clues: [{ value: 100, question: 'Question', answer: 'RUNTIME_SECRET' }, ...(teamMode ? [{ value: 200, question: 'Second', answer: 'RUNTIME_SECRET_2' }] : [])] }] } }),
  } }); rooms.push(room.id);
  const host = await connect(cookie); expect((await gameAck(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    const p = await db.participation.create({ data: { roomId: room.id, displayName: `Player ${i}`, normalizedName: `player-${i}`, rejoinToken: randomUUID(), role: 'PLAYER', ready: true } });
    const socket = await connect(); expect((await gameAck(socket, 'room:subscribe', { roomCode: code, rejoinToken: p.rejoinToken })).success).toBe(true);
    expect((await gameAck(socket, 'player:ready:set', { roomCode: code, ready: true })).success).toBe(true);
    players.push({ ...p, socket });
  }
  if (teamMode) {
    const teams = await Promise.all(['A', 'B'].map((name, index) => db.roomTeam.create({ data: { roomId: room.id, name, color: ['#2563eb', '#dc2626'][index], icon: name } })));
    await db.room.update({ where: { id: room.id }, data: { roomPolicyJson: JSON.stringify({ teamMode: 'MANUAL', teamCount: 2, allowTeamReshuffleBetweenRounds: true }) } });
    for (let i = 0; i < players.length; i++) await db.participation.update({ where: { id: players[i].id }, data: { teamId: teams[i < 2 ? 0 : 1].id } });
  }
  expect((await gameAck(host, 'game:start', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  return { room, code, host, players };
}

it('Wissensduell uses shared timer/submission/judge through real commands, pause and rejoin', async () => {
  const { room, code, host, players } = await start('wissensduell'); const [player] = players;
  cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, code);
  const playerRuntime = await runtime(player.socket);
  expect(playerRuntime.availableActions).toContainEqual(expect.objectContaining({ key: 'answer' }));
  expect(playerRuntime.progress).toMatchObject({ currentRound: 1, totalRounds: 1, remainingRounds: 1 });
  expect((await gameAck(host, 'game:pause', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  let state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(state.roundStates[0].timer.status).toBe('PAUSED');
  expect((await gameAck(player.socket, 'geo:answer', { optionId: 'a', commandId: randomUUID() })).success).toBe(false);
  state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(state.roundStates[0].playerStates[player.id].submission).toBeUndefined();
  expect((await gameAck(host, 'game:resume', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(player.socket, 'geo:answer', { optionId: 'a', commandId: randomUUID() })).success).toBe(true);
  expect((await runtime(player.socket)).availableActions).not.toContainEqual(expect.objectContaining({ key: 'answer' }));
  expect((await gameAck(player.socket, 'geo:answer', { optionId: 'b', commandId: randomUUID() })).error).toBe('ALREADY_ANSWERED');
  const replacement = await connect(); expect((await gameAck(replacement, 'room:subscribe', { roomCode: code, rejoinToken: player.rejoinToken })).success).toBe(true);
  expect(await gameAck(replacement, 'geo:resync', {})).toMatchObject({ ownAnswered: true, ownAnswer: 'a' });
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: code });
  expect((await runtime(viewer)).availableActions).toEqual([]);
  expect(await gameAck(viewer, 'geo:resync', {})).toMatchObject({ ownAnswer: null, ownAnswered: false });
  const commandId = randomUUID();
  expect((await gameAck(host, 'geo:reveal', { roomCode: code, commandId })).success).toBe(true);
  expect((await gameAck(host, 'geo:reveal', { roomCode: code, commandId })).replayed).toBe(true);
  state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(state.roundStates[0].playerStates[player.id].submission).toMatchObject({ participantId: player.id, roundId: '0', value: 'a', status: 'JUDGED', decision: 'CORRECT', matchStatus: 'MATCH' });
  expect(await db.scoreEvent.count({ where: { roomId: room.id, participationId: player.id } })).toBe(1);
  expect(state.scores[player.id]).toBe(100);
  const end = new Promise<{ finalScores: Array<{ participationId: string; score: number; rank: number }> }>(resolve => host.once('game:end', resolve));
  expect((await gameAck(host, 'geo:next', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  expect((await end).finalScores).toEqual(expect.arrayContaining([
    expect.objectContaining({ participationId: player.id, score: 100, rank: 1 }),
  ]));
  expect((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).phase).toBe('GAME_END');
  await assertEventReplay(room.id);
  expect(await db.gameDomainEvent.count({ where: { roomId: room.id, commandId } })).toBe(1);
});
it('Jeopardy uses the same durable submission/judge with unlimited time and no fabricated oral text', async () => {
  const { room, code, host, players } = await start('jeopardy'); const [player] = players;
  expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
  expect((await runtime(player.socket)).availableActions).toContainEqual(expect.objectContaining({ key: 'buzz' }));
  expect((await gameAck(player.socket, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true);
  let state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(state.timer).toMatchObject({ mode: 'UNLIMITED', status: 'RUNNING', endsAtMs: null });
  expect(Object.values(state.submissions)).toEqual([expect.objectContaining({ participantId: player.id, value: null, status: 'SUBMITTED', decision: null, matchStatus: 'NEEDS_JUDGE' })]);
  expect(state.answerTurn).toMatchObject({ mode: 'FIXED', order: [player.id], index: 0 });
  const persistedTurn = state.answerTurn;
  const replacement = await connect();
  expect((await gameAck(replacement, 'room:subscribe', { roomCode: code, rejoinToken: player.rejoinToken })).success).toBe(true);
  expect(JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson).answerTurn).toEqual(persistedTurn);
  expect((await runtime(host)).availableActions).toContainEqual(expect.objectContaining({ key: 'judge' }));
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: code });
  const publicRuntime = await runtime(viewer);
  expect(publicRuntime.availableActions).toEqual([]);
  expect(JSON.stringify(publicRuntime)).not.toContain('RUNTIME_SECRET');
  expect((await gameAck(host, 'game:pause', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(host, 'jeopardy:judge', { correct: true, commandId: randomUUID() })).success).toBe(false);
  expect((await gameAck(host, 'game:resume', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  const commandId = randomUUID();
  expect((await gameAck(host, 'jeopardy:judge', { correct: true, commandId })).success).toBe(true);
  expect((await gameAck(host, 'jeopardy:judge', { correct: true, commandId })).replayed).toBe(true);
  state = JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  expect(Object.values(state.submissions)).toEqual([expect.objectContaining({ participantId: player.id, value: null, status: 'JUDGED', decision: 'CORRECT' })]);
  expect(await db.scoreEvent.count({ where: { roomId: room.id, participationId: player.id } })).toBe(1);
  expect(state.scores[player.id]).toBe(100);
  await assertEventReplay(room.id);
  const judgedEvents = await db.gameDomainEvent.findMany({ where: { roomId: room.id, commandId } });
  expect(judgedEvents).toHaveLength(1);
  expect(judgedEvents[0]).toMatchObject({ type: 'JUDGE' });
  await expect(db.gameDomainEvent.update({ where: { id: judgedEvents[0].id }, data: { type: 'FORGED' } })).rejects.toThrow();
});

it.each(['wissensduell', 'jeopardy'] as const)('%s rejects unsafe writes and freezes corrupted persisted state before scoring', async slug => {
  const { room, code, host, players } = await start(slug);
  if (slug === 'wissensduell') {
    cancelGeoTimer(room.id); await handleGeoGame.startRound(app.io, code); cancelGeoTimer(room.id);
  } else {
    expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(players[0].socket, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true);
  }
  const before = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  const corrupted = JSON.parse(before.stateJson);
  if (slug === 'wissensduell') corrupted.currentRoundIndex = 999;
  else corrupted.answerTurn = createTurn([players[1].id]);
  await expect(db.$transaction(tx => saveGameStateIfRevision(tx, {
    roomId: room.id, expectedRevision: before.revision, state: corrupted, phase: before.phase, gameSlug: slug,
  }))).rejects.toThrow('STATE_INVARIANT_FAILED');
  expect(await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).toEqual(before);
  // Simulated on-disk corruption/legacy import bypasses the normal guarded writer.
  await db.roomGameState.update({ where: { roomId: room.id }, data: { stateJson: JSON.stringify(corrupted) } });
  const result = slug === 'wissensduell'
    ? await gameAck(host, 'geo:reveal', { roomCode: code, commandId: randomUUID() })
    : await gameAck(host, 'jeopardy:judge', { correct: true, commandId: randomUUID() });
  expect(result).toMatchObject({ success: false, error: 'STATE_INVARIANT_FAILED', code: 'RECOVERY_REQUIRED' });
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  expect(frozen.phase).toBe('ERROR_RECOVERY');
  expect(JSON.parse(frozen.stateJson).recoverySnapshotJson).toBe(JSON.stringify(corrupted));
  expect((await db.room.findUniqueOrThrow({ where: { id: room.id } })).runPhase).toBe('ERROR_RECOVERY');
  expect(await db.scoreEvent.count({ where: { roomId: room.id } })).toBe(0);
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: code });
  expect(await runtime(viewer)).toMatchObject({ enginePhase: 'ERROR_RECOVERY', recoveryRequired: true, timer: null, availableActions: [] });
  expect(JSON.stringify(await runtime(viewer))).not.toMatch(/recoverySnapshotJson|RUNTIME_SECRET|SOLUTION|answerTurn/);
  expect((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).revision).toBe(frozen.revision);
});

it('a read freezes malformed persisted JSON and returns only recovery metadata', async () => {
  const { room, code, players } = await start('wissensduell');
  cancelGeoTimer(room.id);
  const invalid = '{MALFORMED_PRIVATE_STATE';
  await db.roomGameState.update({ where: { roomId: room.id }, data: { stateJson: invalid } });
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: code });
  expect(await runtime(viewer)).toMatchObject({ enginePhase: 'ERROR_RECOVERY', recoveryRequired: true, timer: null, availableActions: [] });
  expect(await gameAck(players[0].socket, 'geo:resync', {})).toMatchObject({ success: true, phase: 'ERROR_RECOVERY', question: null });
  const frozen = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  expect(JSON.parse(frozen.stateJson).recoverySnapshotJson).toBe(invalid);
  expect(JSON.stringify(await runtime(viewer))).not.toContain('MALFORMED_PRIVATE_STATE');
});

it.each(['wissensduell', 'jeopardy'] as const)('%s pins its supported tie rule and publishes joint winners without a new random choice', async slug => {
  const { room, code, host, players } = await start(slug);
  cancelGeoTimer(room.id);
  const before = await db.room.findUniqueOrThrow({ where: { id: room.id } });
  expect(JSON.parse(before.gameConfigSnapshotJson!).values.tieStrategy.value).toBe('ALLOW_TIE');
  expect(await gameAck(host, 'room:config:update', { roomCode: code, expectedRevision: before.revision, changes: { tieStrategy: 'HOST_DECIDES' } })).toMatchObject({ success: false, error: 'INVALID_CONFIG' });
  expect(await gameAck(host, 'room:config:update', { roomCode: code, expectedRevision: before.revision, changes: { tieStrategy: 'ALLOW_TIE' } })).toMatchObject({ success: false, error: 'LOCKED_AFTER_START' });
  const end = new Promise<{ winnerIds: string[]; finalScores: Array<{ rank: number }> }>(resolve => host.once(slug === 'wissensduell' ? 'game:end' : 'jeopardy:game:end', resolve));
  expect((await gameAck(host, 'game:end', { roomCode: code, commandId: randomUUID() })).success).toBe(true);
  const result = await end;
  expect(new Set(result.winnerIds)).toEqual(new Set(players.map(player => player.id)));
  expect(result.finalScores.map(entry => entry.rank)).toEqual([1, 1]);
  expect((await db.room.findUniqueOrThrow({ where: { id: room.id } })).gameConfigSnapshotJson).toBe(before.gameConfigSnapshotJson);
  expect(JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson).tieStrategy).toBe('ALLOW_TIE');
});


it.each(['jeopardy', 'wer-ist-das'] as const)('%s: host buzzer override is audited, receipted, fenced and judged exactly once', async slug => {
  const { room, host, players } = await start(slug);
  const [original, replacement] = players;
  const viewer = await connect(); await gameAck(viewer, 'room:subscribe', { roomCode: room.code });
  if (slug === 'jeopardy') expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
  else expect((await gameAck(host, 'weristdas:buzzer:open', { commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(original.socket, slug === 'jeopardy' ? 'jeopardy:buzz' : 'weristdas:buzz', { commandId: randomUUID() })).success).toBe(true);
  const before = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  const payload = { participantId: replacement.id, gameStateVersion: before.revision, runIndex: room.runIndex, reason: 'Host verified the first input', commandId: randomUUID() };
  expect((await runtime(host)).availableActions).toContainEqual(expect.objectContaining({ key: 'buzzerOverride' }));
  expect((await runtime(original.socket)).availableActions.some(a => a.key === 'buzzerOverride')).toBe(false);
  expect(await gameAck(original.socket, 'game:buzzer:override', { ...payload, commandId: randomUUID() })).toMatchObject({ success: false, error: 'FORBIDDEN' });
  expect((await gameAck(viewer, 'game:buzzer:override', { ...payload, commandId: randomUUID() })).success).toBe(false);
  expect((await gameAck(host, 'game:buzzer:override', { ...payload, participantId: randomUUID(), commandId: randomUUID() })).success).toBe(false);
  expect(await gameAck(host, 'game:buzzer:override', { participantId: replacement.id, gameStateVersion: before.revision })).toMatchObject({ success: false, error: 'INVALID_PAYLOAD' });
  expect(await gameAck(host, 'game:buzzer:override', { ...payload, runIndex: room.runIndex + 1, commandId: randomUUID() })).toMatchObject({ success: false, error: 'STATE_CONFLICT' });
  await db.roomPermissionGrant.create({ data: { roomId: room.id, userId: hostId, permission: 'BUZZER_CONTROL', direction: 'REVOKE', grantedBy: hostId } });
  expect((await runtime(host)).availableActions.some(a => a.key === 'buzzerOverride')).toBe(false);
  expect(await gameAck(host, 'game:buzzer:override', { ...payload, commandId: randomUUID() })).toMatchObject({ success: false, error: 'FORBIDDEN' });
  await db.roomPermissionGrant.deleteMany({ where: { roomId: room.id, userId: hostId } });
  expect(await gameAck(host, 'game:buzzer:override', { ...payload, reason: 'x'.repeat(301), commandId: randomUUID() })).toMatchObject({ success: false, error: 'INVALID_PAYLOAD' });
  const response = await gameAck(host, 'game:buzzer:override', payload);
  expect(response, JSON.stringify(response)).toMatchObject({ success: true });
  const after = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  const state = JSON.parse(after.stateJson);
  expect(after.revision).toBe(before.revision + 1);
  expect(state.buzzer).toMatchObject({ winnerId: replacement.id, overrides: [expect.objectContaining({ fromPlayerId: original.id, toPlayerId: replacement.id, reason: payload.reason })] });
  expect(state.answerTurn.order).toEqual([replacement.id]);
  expect(await db.auditLog.count({ where: { resourceId: room.id, action: 'BUZZER_WINNER_OVERRIDDEN' } })).toBe(1);
  expect(await db.roomFeedEntry.count({ where: { roomId: room.id, kind: 'BUZZER_OVERRIDE' } })).toBe(1);
  expect(await db.gameDomainEvent.findFirst({ where: { roomId: room.id, commandId: payload.commandId } })).toMatchObject({ type: 'BUZZER_OVERRIDE' });
  expect(await db.scoreEvent.count({ where: { roomId: room.id } })).toBe(0);
  expect(await gameAck(host, 'game:buzzer:override', payload)).toMatchObject({ success: true, replayed: true });
  expect(await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).toEqual(after);
  expect(await gameAck(host, 'game:buzzer:override', { ...payload, participantId: original.id, commandId: randomUUID() })).toMatchObject({ success: false, error: 'STATE_CONFLICT' });
  if (slug === 'jeopardy') {
    const submissions = Object.values(state.submissions) as Array<{ participantId: string; decision: string }>;
    expect(submissions.find(s => s.participantId === original.id)?.decision).toBe('CANCELLED');
  }
  const resync = await gameAck(viewer, slug === 'jeopardy' ? 'jeopardy:resync' : 'weristdas:resync');
  expect(JSON.stringify(resync)).not.toMatch(/Host verified|SECRET_A|SECRET_B|RUNTIME_SECRET|overrides/);
  const judge = slug === 'jeopardy' ? 'jeopardy:judge' : 'weristdas:judge';
  const judgement = { ...(slug === 'jeopardy' ? { correct: true } : { result: 'BOTH_CORRECT' }), commandId: randomUUID() };
  expect((await gameAck(host, judge, judgement)).success).toBe(true);
  expect(await gameAck(host, judge, judgement)).toMatchObject({ success: true, replayed: true });
  expect(await db.scoreEvent.findMany({ where: { roomId: room.id } })).toEqual([expect.objectContaining({ participationId: replacement.id })]);
  expect(await gameAck(host, 'game:buzzer:override', { ...payload, gameStateVersion: (await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).revision, commandId: randomUUID() })).toMatchObject({ success: false });
  expect(await db.auditLog.count({ where: { resourceId: room.id, action: 'BUZZER_WINNER_OVERRIDDEN' } })).toBe(1);
  await assertEventReplay(room.id);
});


it('Jeopardy steal override preserves first-responder exclusion and supports a second correction without points', async () => {
  const { room, host, players } = await start('jeopardy', 3);
  const [first, steal, replacement] = players;
  expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(first.socket, 'jeopardy:buzz', { commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(host, 'jeopardy:judge', { correct: false, commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(steal.socket, 'jeopardy:steal:buzz', { commandId: randomUUID() })).success).toBe(true);
  const correction = async (id: string) => {
    const row = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
    return gameAck(host, 'game:buzzer:override', { participantId: id, runIndex: room.runIndex, gameStateVersion: row.revision, commandId: randomUUID() });
  };
  expect(await correction(first.id)).toMatchObject({ success: false, error: 'PLAYER_EXCLUDED' });
  expect(await correction(replacement.id)).toMatchObject({ success: true });
  expect(await correction(steal.id)).toMatchObject({ success: true });
  const beforeJudge = await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } });
  expect(JSON.parse(beforeJudge.stateJson).stealBuzzer.overrides).toHaveLength(2);
  expect(await db.scoreEvent.count({ where: { roomId: room.id } })).toBe(1);
  expect((await gameAck(host, 'jeopardy:steal:judge', { correct: true, commandId: randomUUID() })).success).toBe(true);
  const scores = await db.scoreEvent.findMany({ where: { roomId: room.id } });
  expect(scores).toHaveLength(2);
  expect(scores).toContainEqual(expect.objectContaining({ participationId: steal.id, delta: 50 }));
  expect(scores.some(s => s.participationId === replacement.id)).toBe(false);
  await assertEventReplay(room.id);
});


it.each(['jeopardy', 'wer-ist-das'] as const)('%s: pins team buzzers, excludes the wrong team and refreshes only at the next round', async slug => {
  const { room, code, host, players } = await start(slug, 4, true);
  const [first, teammate, opponent] = players;
  if (slug === 'jeopardy') expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
  else expect((await gameAck(host, 'weristdas:buzzer:open', { commandId: randomUUID() })).success).toBe(true);
  const read = async () => JSON.parse((await db.roomGameState.findUniqueOrThrow({ where: { roomId: room.id } })).stateJson);
  const initial = await read();
  expect(initial.buzzer.mode).toBe('TEAM');
  expect(initial.buzzer.eligiblePlayerIds).toHaveLength(4);
  const oldTeam = initial.buzzer.teamByPlayer[first.id], otherTeam = initial.buzzer.teamByPlayer[opponent.id];
  expect(initial.buzzer.teamByPlayer[teammate.id]).toBe(oldTeam);
  expect((await gameAck(first.socket, slug === 'jeopardy' ? 'jeopardy:buzz' : 'weristdas:buzz', { commandId: randomUUID() })).success).toBe(true);
  expect((await read()).buzzer.winnerTeamId).toBe(oldTeam);
  expect((await gameAck(host, slug === 'jeopardy' ? 'jeopardy:judge' : 'weristdas:judge', { ...(slug === 'jeopardy' ? { correct: false } : { result: 'WRONG' }), commandId: randomUUID() })).success).toBe(true);
  const assignments = { [first.id]: oldTeam, [teammate.id]: otherTeam, [opponent.id]: oldTeam, [players[3].id]: otherTeam };
  const reshuffle = () => gameAck(host, 'room:command', { roomCode: code, protocolVersion: 1, commandId: randomUUID(), operation: { type: 'TEAMS_ASSIGN', mode: 'MANUAL', assignments, override: true } });
  expect(await reshuffle()).toMatchObject({ success: false, error: 'TEAMS_LOCKED' });
  if (slug === 'wer-ist-das') expect((await gameAck(host, 'weristdas:buzzer:open', { commandId: randomUUID() })).success).toBe(true);
  const state = await read(), buzzer = slug === 'jeopardy' ? state.stealBuzzer : state.buzzer;
  expect(buzzer.teamByPlayer).toEqual(initial.buzzer.teamByPlayer);
  expect(buzzer.excludedPlayerIds).toEqual(expect.arrayContaining([first.id, teammate.id]));
  expect((await runtime(teammate.socket)).availableActions.some(a => a.key === (slug === 'jeopardy' ? 'stealBuzz' : 'buzz'))).toBe(false);
  expect((await gameAck(teammate.socket, slug === 'jeopardy' ? 'jeopardy:steal:buzz' : 'weristdas:buzz', { commandId: randomUUID() })).success).toBe(false);
  const rejoined = await connect();
  expect((await gameAck(rejoined, 'room:subscribe', { roomCode: code, rejoinToken: teammate.rejoinToken })).success).toBe(true);
  expect((await runtime(rejoined)).availableActions.some(a => a.key === (slug === 'jeopardy' ? 'stealBuzz' : 'buzz'))).toBe(false);
  expect((await gameAck(opponent.socket, slug === 'jeopardy' ? 'jeopardy:steal:buzz' : 'weristdas:buzz', { commandId: randomUUID() })).success).toBe(true);
  expect((await gameAck(host, slug === 'jeopardy' ? 'jeopardy:steal:judge' : 'weristdas:judge', { ...(slug === 'jeopardy' ? { correct: true } : { result: 'BOTH_CORRECT' }), commandId: randomUUID() })).success).toBe(true);
  expect(await reshuffle()).toMatchObject({ success: true });
  expect((await gameAck(host, slug === 'jeopardy' ? 'jeopardy:next' : 'weristdas:next', { commandId: randomUUID() })).success).toBe(true);
  if (slug === 'jeopardy') expect((await gameAck(host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 200, commandId: randomUUID() })).success).toBe(true);
  else expect((await gameAck(host, 'weristdas:buzzer:open', { commandId: randomUUID() })).success).toBe(true);
  const next = await read();
  expect(next.buzzer.mode).toBe('TEAM');
  expect(next.buzzer.excludedPlayerIds).toEqual([]);
  expect(next.buzzer.teamByPlayer[teammate.id]).toBe(otherTeam);
  expect(next.buzzer.teamByPlayer[opponent.id]).toBe(oldTeam);
  expect((await runtime(rejoined)).availableActions.some(a => a.key === 'buzz')).toBe(true);
  await assertEventReplay(room.id);
});
