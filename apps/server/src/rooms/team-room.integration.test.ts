import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io-client';
import request from 'supertest';
import { RoomPolicySchema, type RoomOperation, type RoomCoreView } from '@quiz/shared';
import { createApp } from '../app.js';
import { createSessionCookie } from '../auth/session.js';
import { config } from '../config/index.js';
import { connectGameClient, gameAck } from '../test-socket-harness.js';
import { joinPlayer, roomPreflight } from './core.js';

let db: PrismaClient, app: ReturnType<typeof createApp>, origin: string;
const sockets: Socket[] = [], rooms: string[] = [], assets: string[] = [];
const hostId = 'pr15-host', secondId = 'pr15-second';
let cookie: string, secondCookie: string;
const ack = gameAck;
async function connect(auth?: string) { const s = await connectGameClient(origin, auth); sockets.push(s); return s; }
async function createRoom(slug = 'jeopardy', overrides: Record<string, unknown> = {}) {
  const game = await db.gameDefinition.findUniqueOrThrow({ where: { slug } });
  const code = String(Math.floor(100000 + Math.random() * 900000)).replace(/(\d{3})(\d{3})/, '$1-$2');
  const r = await db.room.create({ data: { code, roomName: 'PR15', hostUserId: hostId, gameDefinitionId: game.id, status: 'LOBBY', runPhase: 'OPEN', viewerRequiresPin: false,
    setupSnapshotJson: JSON.stringify({ board1: { categories: [{ name: 'Kategorie', clues: [{ value: 100, question: 'Öffentliche Frage', answer: 'PR15_SECRET' }] }] }, board2: { categories: [{ name: 'Kategorie 2', clues: [{ value: 200, question: 'Zweite Frage', answer: 'PR15_SECRET' }] }] } }), ...overrides } });
  rooms.push(r.id);
  const host = await connect(cookie);
  expect((await ack(host, 'room:subscribe', { roomCode: code })).success).toBe(true);
  return { ...r, host };
}
async function player(r: { id: string; code: string }, name: string, auth?: string, userId?: string) {
  const p = await joinPlayer(r.id, { displayName: name, userId });
  const s = await connect(auth);
  expect((await ack(s, 'room:subscribe', { roomCode: r.code, rejoinToken: p.rejoinToken })).success).toBe(true);
  return { ...p, socket: s };
}
async function command(socket: Socket, code: string, operation: RoomOperation, commandId = randomUUID()) {
  return ack(socket, 'room:command', { roomCode: code, operation, commandId, protocolVersion: 1 });
}
const policy = (extra: Record<string, unknown> = {}) => RoomPolicySchema.parse(extra);
async function configure(r: { host: Socket; code: string }, extra: Record<string, unknown>) {
  expect(await command(r.host, r.code, { type: 'POLICY', policy: policy(extra) })).toMatchObject({ success: true });
}
async function ready(r: { code: string }, players: Array<{ socket: Socket }>) {
  for (const p of players) expect(await ack(p.socket, 'player:ready:set', { roomCode: r.code, ready: true })).toMatchObject({ success: true });
}
beforeAll(async () => {
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL }); await db.$connect(); globalThis.__prisma = db;
  for (const id of [hostId, secondId]) await db.user.upsert({ where: { id }, update: {}, create: { id, displayName: id, passwordHash: 'unused', role: 'HOST' } });
  const sessions = await Promise.all([hostId, secondId].map(userId => db.session.create({ data: { userId, expiresAt: new Date(Date.now() + 86400000) } })));
  [cookie, secondCookie] = sessions.map(s => createSessionCookie(s.id, config.sessionSecret));
  app = createApp(); await new Promise<void>(done => app.httpServer.listen(0, '127.0.0.1', done));
  const address = app.httpServer.address(); if (!address || typeof address === 'string') throw Error('No port'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await new Promise<void>(done => app.io.close(() => app.httpServer.close(() => done())));
  await db.room.deleteMany({ where: { id: { in: rooms } } }); await db.mediaAsset.deleteMany({ where: { id: { in: assets } } });
  await db.$disconnect(); globalThis.__prisma = undefined;
});

describe('TEAM-ROOM: real HTTP / sockets / DB', () => {
  it('normalizes names, reserves the last slot atomically, and keeps waitlist read-only', async () => {
    const r = await createRoom('jeopardy', { maxPlayers: 2 });
    await configure(r, { waitlist: true });
    const responses = await Promise.all([' Alice ', 'Bob', 'Charly'].map(displayName => request(app.app).post(`/api/v1/rooms/${r.code}/join`).send({ displayName })));
    expect(responses.map(x => x.status)).toEqual([201, 201, 201]);
    expect(await db.participation.count({ where: { roomId: r.id, role: 'PLAYER', admission: 'ACTIVE' } })).toBe(2);
    expect(await db.participation.count({ where: { roomId: r.id, admission: 'WAITLIST' } })).toBe(1);
    const duplicate = await request(app.app).post(`/api/v1/rooms/${r.code}/join`).send({ displayName: '  ALICE  ' });
    expect(duplicate.body.error.code).toBe('NAME_TAKEN');
    const waiting = await db.participation.findFirstOrThrow({ where: { roomId: r.id, admission: 'WAITLIST' } });
    const s = await connect(); expect((await ack(s, 'room:subscribe', { roomCode: r.code, rejoinToken: waiting.rejoinToken })).success).toBe(true);
    expect((await ack(s, 'player:ready:set', { roomCode: r.code, ready: true })).success).toBe(false);
    expect((await ack(s, 'jeopardy:buzz', {})).success).toBe(false);
  });
  it('locks new admissions and waitlist while preserving existing rejoin', async () => {
    const r = await createRoom(); const p = await player(r, 'Existing');
    await configure(r, { waitlist: true });
    expect((await command(r.host, r.code, { type: 'LOCK', locked: true })).success).toBe(true);
    expect((await request(app.app).post(`/api/v1/rooms/${r.code}/join`).send({ displayName: 'New' })).body.error.code).toBe('ROOM_NOT_JOINABLE');
    const viewer = await connect(); expect((await ack(viewer, 'room:subscribe', { roomCode: r.code })).success).toBe(false);
    const replacement = await connect(); expect((await ack(replacement, 'room:subscribe', { roomCode: r.code, rejoinToken: p.rejoinToken })).success).toBe(true);
    expect((await ack(p.socket, 'player:ready:set', { roomCode: r.code, ready: true })).success).toBe(false);
  });
  it('separates player PIN and viewer access and consumes invites exactly once', async () => {
    const argon2 = await import('argon2');
    const r = await createRoom('jeopardy', { pinHash: await argon2.hash('1234') });
    await configure(r, { playerAccess: 'PIN_PROTECTED', viewerAccess: 'PUBLIC_JOIN' });
    expect((await request(app.app).post(`/api/v1/rooms/${r.code}/join`).send({ displayName: 'Wrong', pin: '0000' })).status).toBe(403);
    const viewer = await connect(); expect((await ack(viewer, 'room:subscribe', { roomCode: r.code })).success).toBe(true);
    await configure(r, { playerAccess: 'INVITE_ONLY' });
    const invite = await command(r.host, r.code, { type: 'INVITE', role: 'PLAYER' });
    expect(JSON.stringify(await db.roomInvite.findMany({ where: { roomId: r.id } }))).not.toContain(invite.inviteToken);
    const joined = await request(app.app).post(`/api/v1/rooms/${r.code}/join`).send({ displayName: 'Invited', inviteToken: invite.inviteToken });
    expect(joined.status).toBe(201);
    expect((await request(app.app).post(`/api/v1/rooms/${r.code}/join`).send({ displayName: 'Other', inviteToken: invite.inviteToken })).body.error.code).toBe('INVITE_REQUIRED');
  });
  it('requires approval, does not leak setup or credentials, and replays the same admission', async () => {
    const r = await createRoom(); await configure(r, { playerAccess: 'APPROVAL_REQUIRED' });
    const p = await player(r, 'Pending');
    expect(p.admission).toBe('PENDING_JOIN');
    const publicView = await ack(p.socket, 'room:core:read', {});
    expect(JSON.stringify(publicView)).not.toMatch(/PR15_SECRET|rejoinToken|pinHash|setupSnapshot/);
    const op = { type: 'ADMIT' as const, participantId: p.id, approve: true }, id = randomUUID();
    expect((await command(r.host, r.code, op, id)).success).toBe(true);
    expect(await command(r.host, r.code, op, id)).toMatchObject({ success: true, replayed: true });
    expect((await db.participation.findUniqueOrThrow({ where: { id: p.id } })).admission).toBe('ACTIVE');
  });
  it('persists balanced teams and history, enforces sizes, and permits self-selection only in the lobby', async () => {
    const r = await createRoom(); const players = await Promise.all(['A', 'B', 'C', 'D'].map(n => player(r, n)));
    await configure(r, { teamMode: 'SELF_SELECT', maxTeamSize: 2, equality: 'REQUIRED' });
    expect((await command(r.host, r.code, { type: 'TEAMS_ASSIGN', mode: 'RANDOM', override: false })).success).toBe(true);
    const teams = await db.roomTeam.findMany({ where: { roomId: r.id } });
    expect(await db.teamMembership.count({ where: { roomId: r.id } })).toBe(4);
    expect((await command(players[0].socket, r.code, { type: 'TEAM_SELECT', teamId: 'foreign-team' })).success).toBe(false);
    const before = await db.participation.findMany({ where: { roomId: r.id, role: 'PLAYER' } });
    for (const t of teams) expect(before.filter(p => p.teamId === t.id)).toHaveLength(2);
    expect((await command(r.host, r.code, { type: 'TEAMS_ASSIGN', mode: 'ROTATION', override: false })).success).toBe(true);
    expect(await db.teamMembership.count({ where: { roomId: r.id } })).toBeGreaterThan(4);
    expect((await roomPreflight(r.id)).blockers).not.toContain('TEAM_CONFIGURATION_INVALID');
  });
  it('blocks real preflight failures even with override and supports the explicit ready policy', async () => {
    const r = await createRoom(); const a = await player(r, 'A'), b = await player(r, 'B');
    await configure(r, { readyRule: 'HOST_CAN_OVERRIDE' });
    expect((await ack(r.host, 'game:start', { roomCode: r.code, commandId: randomUUID(), overrideReady: false })).error).toBe('NOT_ALL_READY');
    await configure(r, { readyRule: 'HOST_CAN_OVERRIDE', teamMode: 'MANUAL' });
    expect((await ack(r.host, 'game:start', { roomCode: r.code, commandId: randomUUID(), overrideReady: true })).error).toBe('TEAM_CONFIGURATION_INVALID');
    await configure(r, { readyRule: 'HOST_CAN_OVERRIDE' });
    expect((await ack(r.host, 'game:start', { roomCode: r.code, commandId: randomUUID(), overrideReady: true })).success).toBe(true);
    expect((await ack(a.socket, 'player:ready:set', { roomCode: r.code, ready: true })).success).toBe(false);
    expect(((await ack(b.socket, 'room:core:read', {})).view as RoomCoreView).lifecycle).toBe('GAME_ACTIVE');
  });
  it('retains identity/team/score on device takeover and invalidates rotated tokens', async () => {
    const r = await createRoom(); const p = await player(r, 'Stable');
    await configure(r, { teamMode: 'MANUAL' });
    const team = await db.roomTeam.findFirstOrThrow({ where: { roomId: r.id } });
    await command(r.host, r.code, { type: 'TEAMS_ASSIGN', mode: 'MANUAL', override: false, assignments: { [p.id]: team.id } });
    await db.participation.update({ where: { id: p.id }, data: { score: 17 } });
    const replacement = await connect();
    expect((await ack(replacement, 'room:subscribe', { roomCode: r.code, rejoinToken: p.rejoinToken })).success).toBe(true);
    expect((await db.participation.findUniqueOrThrow({ where: { id: p.id } }))).toMatchObject({ teamId: team.id, score: 17 });
    expect((await ack(p.socket, 'room:command', { roomCode: r.code, protocolVersion: 1, commandId: randomUUID(), operation: { type: 'LEAVE' } })).success).toBe(false);
    const rotation = await command(r.host, r.code, { type: 'TOKEN_ROTATE', participantId: p.id });
    expect(rotation.success).toBe(true);
    const s = await connect(); expect((await ack(s, 'room:subscribe', { roomCode: r.code, rejoinToken: p.rejoinToken })).success).toBe(false);
    expect((await ack(s, 'room:subscribe', { roomCode: r.code, rejoinToken: rotation.rejoinToken })).success).toBe(true);
    // Lost ACK replay must not evict the replacement device a second time.
  });
  it('ban preserves scores/history; unban allows a new identity; kick permits a fresh join', async () => {
    const r = await createRoom(); const p = await player(r, 'Original');
    await db.participation.update({ where: { id: p.id }, data: { score: 5 } });
    expect((await command(r.host, r.code, { type: 'BAN', participantId: p.id, reason: 'Test' })).success).toBe(true);
    const s = await connect(); expect((await ack(s, 'room:subscribe', { roomCode: r.code, rejoinToken: p.rejoinToken })).success).toBe(false);
    expect((await db.participation.findUniqueOrThrow({ where: { id: p.id } })).score).toBe(5);
    expect((await command(r.host, r.code, { type: 'UNBAN', participantId: p.id })).success).toBe(true);
    const replacement = await player(r, 'Original'); expect(replacement.id).not.toBe(p.id);
    expect((await command(r.host, r.code, { type: 'KICK', participantId: replacement.id })).success).toBe(true);
    expect((await joinPlayer(r.id, { displayName: 'Original' })).id).not.toBe(replacement.id);
    expect(await db.auditLog.count({ where: { resourceId: r.id, action: { in: ['BAN', 'UNBAN', 'KICK'] } } })).toBe(3);
  });
  it('delegates management without secrets and revokes an already connected co-host', async () => {
    const r = await createRoom(); const p = await player(r, 'Co', secondCookie, secondId);
    await configure(r, { coHostEnabled: true });
    expect((await command(r.host, r.code, { type: 'COHOST', userId: secondId, permissions: ['PLAYER_MANAGE', 'TEAM_MANAGE'] })).success).toBe(true);
    expect(((await ack(p.socket, 'room:core:read', {})).view as RoomCoreView).canManage).toBe(true);
    expect((await command(p.socket, r.code, { type: 'MESSAGE', message: 'Nur Verwaltung' })).success).toBe(true);
    expect((await ack(p.socket, 'jeopardy:judge', { correct: true })).success).toBe(false);
    expect(JSON.stringify(await ack(p.socket, 'room:core:read', {}))).not.toContain('PR15_SECRET');
    await command(r.host, r.code, { type: 'COHOST', userId: secondId, permissions: [] });
    expect((await command(p.socket, r.code, { type: 'MESSAGE', message: 'Nicht mehr erlaubt' })).success).toBe(false);
  });
  it('transfers ownership while retaining the new hosts PLAYER information role and evicting old host control', async () => {
    const r = await createRoom(); const p = await player(r, 'New host', secondCookie, secondId), b = await player(r, 'B');
    await ready(r, [p, b]);
    expect((await ack(r.host, 'game:start', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
    expect((await command(r.host, r.code, { type: 'TRANSFER', userId: secondId, claim: false })).success).toBe(true);
    expect((await db.room.findUniqueOrThrow({ where: { id: r.id } })).hostUserId).toBe(secondId);
    expect((await db.participation.findUniqueOrThrow({ where: { id: p.id } })).role).toBe('PLAYER');
    expect((await ack(r.host, 'game:end', { roomCode: r.code })).success).toBe(false);
    let secret = false; p.socket.on('jeopardy:answer:secret', () => { secret = true; });
    expect((await ack(p.socket, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
    expect(secret).toBe(false);
    expect(JSON.stringify(await ack(p.socket, 'jeopardy:resync', {}))).not.toContain('PR15_SECRET');
    // An owner-only subscription (e.g. navigating to the host URL) must keep the PLAYER role.
    const newDevice = await connect(secondCookie);
    const subscribed = await ack(newDevice, 'room:subscribe', { roomCode: r.code });
    expect(subscribed).toMatchObject({ success: true, snapshot: { identity: { role: 'PLAYER' } } });
    expect(JSON.stringify(await ack(newDevice, 'jeopardy:resync', {}))).not.toContain('PR15_SECRET');
    expect((await ack(newDevice, 'game:end', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
    expect((await ack(p.socket, 'game:end', { roomCode: r.code, commandId: randomUUID() })).success).toBe(false);
    const back = await connect(cookie); expect((await ack(back, 'room:subscribe', { roomCode: r.code })).success).toBe(true);
    expect(((await ack(back, 'room:core:read', {})).view as RoomCoreView).isOwner).toBe(false);
  });
  it('requires the disconnect grace and explicit eligible co-host for failover', async () => {
    const r = await createRoom(); const p = await player(r, 'Co', secondCookie, secondId);
    await configure(r, { coHostEnabled: true, hostGraceMs: 1000 });
    await command(r.host, r.code, { type: 'COHOST', userId: secondId, permissions: ['PLAYER_MANAGE'] });
    expect((await command(p.socket, r.code, { type: 'TRANSFER', userId: secondId, claim: true })).success).toBe(false);
    const oldHost = await db.participation.findFirstOrThrow({ where: { roomId: r.id, role: 'HOST' } });
    await db.participation.update({ where: { id: oldHost.id }, data: { connected: false, connectionId: null, lastSeenAt: new Date(Date.now() - 2000) } });
    expect((await command(p.socket, r.code, { type: 'TRANSFER', userId: secondId, claim: true })).success).toBe(true);
  });
  it('admits late join only at a round boundary, starts at zero and keeps old secrets hidden', async () => {
    const r = await createRoom(); const a = await player(r, 'A'), b = await player(r, 'B');
    await configure(r, { allowLateJoin: true }); await ready(r, [a, b]);
    expect((await ack(r.host, 'game:start', { roomCode: r.code })).success).toBe(true);
    await ack(r.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 });
    const late = await player(r, 'Late'); expect(late.admission).toBe('PENDING_JOIN');
    expect((await command(r.host, r.code, { type: 'ADMIT', participantId: late.id, approve: true })).error).toBe('ROUND_BOUNDARY_REQUIRED');
    await ack(a.socket, 'jeopardy:buzz', {}); await ack(r.host, 'jeopardy:judge', { correct: true });
    expect((await command(r.host, r.code, { type: 'ADMIT', participantId: late.id, approve: true })).success).toBe(true);
    expect((await db.participation.findUniqueOrThrow({ where: { id: late.id } })).score).toBe(0);
  });
  it.each(['jeopardy', 'wer-ist-das'])('integrates team scoring, immutable run history and rematch in %s', async slug => {
    const r = await createRoom(slug);
    if (slug === 'wer-ist-das') {
      const asset = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'pr15.png', originalName: 'pr15.png', fileSize: 1, sha256: randomUUID(), storagePath: '/tmp/pr15.png', uploadedBy: hostId } }); assets.push(asset.id);
      await db.room.update({ where: { id: r.id }, data: { setupSnapshotJson: JSON.stringify({ rounds: [{ id: 'r1', imageAssetId: asset.id, person1: 'PR15_SECRET', person2: 'SecondSecret' }] }) } });
    }
    const a = await player(r, 'A'), b = await player(r, 'B');
    await configure(r, { teamMode: 'MANUAL', scoring: 'TEAM_SCORE' });
    const teams = await db.roomTeam.findMany({ where: { roomId: r.id } });
    await command(r.host, r.code, { type: 'TEAMS_ASSIGN', mode: 'MANUAL', override: false, assignments: { [a.id]: teams[0].id, [b.id]: teams[1].id } });
    await ready(r, [a, b]); expect((await ack(r.host, 'game:start', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
    if (slug === 'jeopardy') { await ack(r.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 }); await ack(a.socket, 'jeopardy:buzz', {}); expect((await ack(r.host, 'jeopardy:judge', { correct: true })).success).toBe(true); }
    else { await ack(r.host, 'weristdas:buzzer:open', {}); await ack(a.socket, 'weristdas:buzz', {}); expect((await ack(r.host, 'weristdas:judge', { result: 'BOTH_CORRECT' })).success).toBe(true); }
    const expected = slug === 'jeopardy' ? 100 : 3;
    expect((await db.roomTeam.findUniqueOrThrow({ where: { id: teams[0].id } })).score).toBe(expected);
    expect((await ack(r.host, 'game:end', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
    const id = randomUUID(); expect((await command(r.host, r.code, { type: 'REMATCH' }, id)).success).toBe(true);
    expect(await command(r.host, r.code, { type: 'REMATCH' }, id)).toMatchObject({ success: true, replayed: true });
    const archive = await db.roomRun.findFirstOrThrow({ where: { roomId: r.id } }); expect(archive.teamsJson).toContain(String(expected));
    expect((await db.room.findUniqueOrThrow({ where: { id: r.id } })).runIndex).toBe(2);
    expect(await db.roomGameState.count({ where: { roomId: r.id } })).toBe(0);
    expect((await db.participation.findUniqueOrThrow({ where: { id: a.id } })).score).toBe(0);
    const publicHistory = await ack(a.socket, 'room:core:read', {});
    expect(JSON.stringify(publicHistory)).not.toContain('PR15_SECRET');
    expect((publicHistory.view as RoomCoreView).history[0].players.find(p => p.displayName === 'A')?.score).toBe(expected);
  });
  it.each(['jeopardy', 'wer-ist-das'])('freezes and restores the exact round in %s; no points during pause', async slug => {
    const r = await createRoom(slug);
    if (slug === 'wer-ist-das') {
      const asset = await db.mediaAsset.create({ data: { type: 'image', mimeType: 'image/png', filename: 'pause.png', originalName: 'pause.png', fileSize: 1, sha256: randomUUID(), storagePath: '/tmp/pr15.png', uploadedBy: hostId } }); assets.push(asset.id);
      await db.room.update({ where: { id: r.id }, data: { setupSnapshotJson: JSON.stringify({ rounds: [{ id: 'r1', imageAssetId: asset.id, person1: 'PR15_SECRET', person2: 'SecondSecret' }] }) } });
    }
    const a = await player(r, 'A'), b = await player(r, 'B'); await ready(r, [a, b]);
    expect((await ack(r.host, 'game:start', { roomCode: r.code })).success).toBe(true);
    if (slug === 'jeopardy') { await ack(r.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100 }); await ack(a.socket, 'jeopardy:buzz', {}); }
    else { await ack(r.host, 'weristdas:buzzer:open', {}); await ack(a.socket, 'weristdas:buzz', {}); }
    const before = await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } });
    const id = randomUUID();
    expect((await ack(r.host, 'game:pause', { roomCode: r.code, commandId: id })).success).toBe(true);
    expect((await ack(r.host, 'game:pause', { roomCode: r.code, commandId: id })).replayed).toBe(true);
    expect((await ack(r.host, slug === 'jeopardy' ? 'jeopardy:judge' : 'weristdas:judge', slug === 'jeopardy' ? { correct: true } : { result: 'BOTH_CORRECT' })).success).toBe(false);
    expect((await db.participation.findUniqueOrThrow({ where: { id: a.id } })).score).toBe(0);
    expect((await ack(r.host, 'game:resume', { roomCode: r.code, commandId: randomUUID() })).success).toBe(true);
    expect((await db.roomGameState.findUniqueOrThrow({ where: { roomId: r.id } })).stateJson).toBe(before.stateJson);
    expect(await db.roomFeedEntry.count({ where: { roomId: r.id, kind: { in: ['PAUSE', 'RESUME'] } } })).toBe(2);
  });
  it('requires viewer approval and prevents a second use of a viewer invitation', async () => {
    const r = await createRoom(); await configure(r, { viewerAccess: 'APPROVAL_REQUIRED' });
    const s = await connect(); const initial = await ack(s, 'room:subscribe', { roomCode: r.code });
    expect(initial.success).toBe(true); expect(initial.rejoinToken).toEqual(expect.any(String));
    const waiting = await db.participation.findFirstOrThrow({ where: { roomId: r.id, role: 'VIEWER' } });
    expect(waiting.admission).toBe('PENDING_JOIN');
    expect((await command(r.host, r.code, { type: 'ADMIT', participantId: waiting.id, approve: true })).success).toBe(true);
    expect((await db.participation.findUniqueOrThrow({ where: { id: waiting.id } })).admission).toBe('ACTIVE');
    await configure(r, { viewerAccess: 'INVITE_ONLY' });
    const invite = await command(r.host, r.code, { type: 'INVITE', role: 'VIEWER' });
    const one = await connect(), two = await connect();
    expect((await ack(one, 'room:subscribe', { roomCode: r.code, inviteToken: invite.inviteToken })).success).toBe(true);
    expect((await ack(two, 'room:subscribe', { roomCode: r.code, inviteToken: invite.inviteToken })).error).toBe('INVITE_REQUIRED');
  });
  it('blocks a banned guest credential on a fresh HTTP join and never rotates unrelated history', async () => {
    const r = await createRoom();
    const browser = request.agent(app.app);
    const first = await browser.post(`/api/v1/rooms/${r.code}/join`).send({ displayName: 'Guest' });
    expect(first.status).toBe(201);
    expect((await command(r.host, r.code, { type: 'BAN', participantId: first.body.data.participationId })).success).toBe(true);
    const retry = await browser.post(`/api/v1/rooms/${r.code}/join`).send({ displayName: 'Different name' });
    expect(retry.body.error.code).toBe('BANNED');
  });
  it('switches to an owned prepared game while rejecting someone elses setup', async () => {
    const r = await createRoom(); await db.room.update({ where: { id: r.id }, data: { status: 'ENDED', runPhase: 'RESULTS' } });
    const foreign = await createRoom('jeopardy', { hostUserId: secondId });
    expect((await command(r.host, r.code, { type: 'SWITCH_GAME', gameSlug: 'jeopardy', sourceRoomId: foreign.id })).error).toBe('SETUP_NOT_OWNED');
    expect((await command(r.host, r.code, { type: 'SWITCH_GAME', gameSlug: 'wissensduell' })).success).toBe(true);
    const live = await db.room.findUniqueOrThrow({ where: { id: r.id }, include: { gameDefinition: true } }); expect(live.gameDefinition.slug).toBe('wissensduell');
    expect(await db.roomRun.count({ where: { roomId: r.id } })).toBe(1);
  });
  it('does not auto-start scheduled rooms and denies all rejoin after final close/expiry', async () => {
    const r = await createRoom(); const p = await player(r, 'Existing');
    await command(r.host, r.code, { type: 'SCHEDULE', scheduledAt: new Date(Date.now() + 10000).toISOString() });
    expect((await ack(r.host, 'game:start', { roomCode: r.code, overrideReady: true })).success).toBe(false);
    await db.room.update({ where: { id: r.id }, data: { scheduledAt: new Date(Date.now() - 10000) } });
    expect((await roomPreflight(r.id)).blockers).toContain('ROOM_NOT_IN_LOBBY');
    expect((await command(r.host, r.code, { type: 'CLOSE' })).success).toBe(true);
    const s = await connect(); expect((await ack(s, 'room:subscribe', { roomCode: r.code, rejoinToken: p.rejoinToken })).error).toBe('ROOM_CLOSED');
    const expired = await createRoom(); await db.room.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ack(s, 'room:subscribe', { roomCode: expired.code })).error).toBe('ROOM_CLOSED');
  });
  it('rejects cross-room mutations, conflicting command payload and invalid envelopes before effects', async () => {
    const a = await createRoom(), b = await createRoom();
    expect((await command(a.host, b.code, { type: 'MESSAGE', message: 'Wrong' })).error).toBe('WRONG_ROOM');
    const id = randomUUID(); expect((await command(a.host, a.code, { type: 'MESSAGE', message: 'Once' }, id)).success).toBe(true);
    expect((await command(a.host, a.code, { type: 'MESSAGE', message: 'Different' }, id)).error).toBe('COMMAND_CONFLICT');
    expect((await ack(a.host, 'room:command', { roomCode: a.code, commandId: '', protocolVersion: 1, operation: { type: 'CLOSE' } })).error).toBe('INVALID_PAYLOAD');
    expect(await db.roomFeedEntry.count({ where: { roomId: a.id, kind: 'MESSAGE' } })).toBe(1);
  });
});
