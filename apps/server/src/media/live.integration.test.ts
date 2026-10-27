import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import type { LiveMediaSnapshot } from '@quiz/shared';
import { createApp } from '../app.js';
import { createTestDatabase } from '../test-helpers.js';
import { createSessionCookie } from '../auth/session.js';
import { config } from '../config/index.js';
import { connectGameClient, gameAck } from '../test-socket-harness.js';
import { handleGeoGame, cancelGeoTimer } from '../games/geo/index.js';
import { displayToken, verifyDisplayToken } from './display.js';
import { socketIdentityMap } from '../http/middleware/auth.js';
let dir: string, db: PrismaClient, previous: PrismaClient | undefined, app: ReturnType<typeof createApp>, origin: string;
const clients: Socket[] = [], views = new Map<string, LiveMediaSnapshot>();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quiz-live-')); const url = `file:${join(dir, 'db.sqlite')}`; await createTestDatabase(url);
  db = new PrismaClient({ datasourceUrl: url }); previous = globalThis.__prisma; globalThis.__prisma = db; app = createApp();
  for (const slug of ['wissensduell', 'jeopardy']) await db.gameDefinition.create({ data: { slug, name: slug, category: 'test', status: 'BETA' } });
  await new Promise<void>(resolve => app.httpServer.listen(0, '127.0.0.1', resolve)); const address = app.httpServer.address(); if (!address || typeof address === 'string') throw Error('NO_PORT'); origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { const ids = clients.map(s => s.id).filter(Boolean); for (const socket of clients) socket.disconnect(); await new Promise<void>(resolve => app.io.close(() => resolve())); await vi.waitFor(() => expect(ids.some(id => socketIdentityMap.has(id!))).toBe(false)); await db.$disconnect(); globalThis.__prisma = previous; await rm(dir, { recursive: true, force: true }); });
async function socket(cookie?: string) { const client = await connectGameClient(origin, cookie); clients.push(client); client.on('media:snapshot', (s: LiveMediaSnapshot) => views.set(client.id!, s)); return client; }
async function fixture(slug = 'wissensduell') {
  const user = await db.user.create({ data: { role: 'HOST', displayName: randomUUID(), passwordHash: 'unused' } });
  const session = await db.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3600000) } }); const cookie = createSessionCookie(session.id, config.sessionSecret);
  const game = await db.gameDefinition.findUniqueOrThrow({ where: { slug } });
  const room = await db.room.create({ data: { code: String(Math.floor(Math.random() * 900000) + 100000).replace(/(\d{3})(\d{3})/, '$1-$2'), roomName: 'Media', gameDefinitionId: game.id, hostUserId: user.id, status: 'LOBBY', runPhase: 'OPEN', cameraEnabled: true, viewerRequiresPin: false } });
  const host = await socket(cookie); expect((await gameAck(host, 'room:subscribe', { roomCode: room.code })).success).toBe(true);
  async function player(teamId?: string) { const p = await db.participation.create({ data: { roomId: room.id, role: 'PLAYER', teamId, displayName: randomUUID(), normalizedName: randomUUID(), rejoinToken: randomUUID(), connected: true, ready: true } }); const client = await socket(); expect((await gameAck(client, 'room:subscribe', { roomCode: room.code, rejoinToken: p.rejoinToken })).success).toBe(true); return { client, p }; }
  async function enter(client: Socket) { expect((await gameAck(client, 'media:join')).success).toBe(true); await vi.waitFor(() => expect(views.has(client.id!)).toBe(true)); }
  async function control(change: object) { const result = await gameAck(host, 'media:control', { expectedRevision: views.get(host.id!)!.revision, ...change }); expect(result.success).toBe(true); }
  await enter(host); return { user, session, cookie, room, host, player, enter, control };
}
const self = (client: Socket, values: object = {}) => gameAck(client, 'media:self', { mic: false, camera: false, talking: false, teamListen: null, ...values });
const route = (from: Socket, to: Socket, kind = 'audio') => views.get(from.id!)!.routes.find(r => r.from === from.id && r.to === to.id && r.kind === kind);
it('requires real admitted membership, consent and receive-only viewer, and relays only server-issued routes', async () => {
  const f = await fixture(), a = await f.player(), b = await f.player(), anonymous = await socket(), viewer = await socket();
  expect((await gameAck(anonymous, 'media:join')).success).toBe(false);
  await gameAck(viewer, 'room:subscribe', { roomCode: f.room.code }); await f.enter(viewer); await f.enter(a.client); await f.enter(b.client);
  expect(route(a.client, b.client)).toBeUndefined(); expect((await self(viewer, { mic: true })).error).toBe('MEDIA_RECEIVE_ONLY');
  expect((await self(a.client, { mic: true })).success).toBe(true);
  const r = route(a.client, b.client)!; expect(r).toBeDefined(); expect(route(a.client, viewer)).toBeDefined();
  const received: unknown[] = []; b.client.on('media:signal', data => received.push(data));
  expect((await gameAck(a.client, 'media:signal', { routeId: r.id, description: { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n' } })).success).toBe(true);
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect((await gameAck(a.client, 'media:signal', { routeId: r.id, description: { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n' } })).error).toBe('MEDIA_SDP_NOT_ALLOWED');
  expect((await gameAck(viewer, 'media:signal', { routeId: r.id, description: { type: 'offer', sdp: 'spoof' } })).error).toBe('MEDIA_ROUTE_REVOKED');
  expect((await gameAck(b.client, 'media:signal', { routeId: r.id, description: { type: 'offer', sdp: 'reverse' } })).error).toBe('NOT_AUTHORIZED');
  expect((await self(a.client, { mic: true, roomId: 'forged' })).error).toBe('INVALID_PAYLOAD');
});
it('separates TEAM audio from cameras, prevents viewer access, and revalidates team changes and old routes', async () => {
  const f = await fixture(); const team = await db.roomTeam.create({ data: { roomId: f.room.id, name: 'A', color: 'blue', icon: 'A' } });
  const a = await f.player(team.id), b = await f.player(team.id), outsider = await f.player(), viewer = await socket();
  await gameAck(viewer, 'room:subscribe', { roomCode: f.room.code }); for (const s of [a.client, b.client, outsider.client, viewer]) await f.enter(s);
  await self(a.client, { mic: true, camera: true }); const old = route(a.client, outsider.client)!;
  await f.control({ policy: { channel: 'TEAM' } });
  expect(route(a.client, b.client)).toBeDefined(); expect(route(a.client, outsider.client)).toBeUndefined(); expect(route(a.client, viewer)).toBeUndefined(); expect(route(a.client, viewer, 'video')).toBeDefined();
  expect((await gameAck(a.client, 'media:signal', { routeId: old.id, description: { type: 'offer', sdp: 'old' } })).error).toBe('MEDIA_ROUTE_REVOKED');
  expect((await self(outsider.client, { teamListen: team.id })).error).toBe('TEAM_NOT_ALLOWED');
  await self(f.host, { teamListen: team.id }); expect(route(a.client, f.host)).toBeDefined();
  const before = route(a.client, b.client)!; await db.participation.update({ where: { id: b.p.id }, data: { teamId: null } });
  expect((await gameAck(a.client, 'media:signal', { routeId: before.id, candidate: { candidate: 'candidate:old' } })).error).toBe('MEDIA_ROUTE_REVOKED');
});
it('persists host mute across rejoin, prevents self-unmute, and release never enables capture', async () => {
  const f = await fixture(), a = await f.player(); await f.enter(a.client); await self(a.client, { mic: true });
  expect((await gameAck(a.client, 'media:control', { expectedRevision: 1, muteAll: true })).error).toBe('NOT_AUTHORIZED');
  await f.control({ targetId: a.client.id, hostMuted: true }); expect(route(a.client, f.host)).toBeUndefined();
  expect((await self(a.client, { mic: true })).error).toBe('HOST_MUTED');
  const again = await socket(); await gameAck(again, 'room:subscribe', { roomCode: f.room.code, rejoinToken: a.p.rejoinToken }); await f.enter(again);
  expect(views.get(again.id!)!.self.hostMuted).toBe(true); expect((await self(again, { mic: true })).error).toBe('HOST_MUTED');
  await f.control({ targetId: again.id, hostMuted: false }); expect(route(again, f.host)).toBeUndefined(); expect((await self(again, { mic: true })).success).toBe(true);
  expect((await db.participantMediaControl.findUniqueOrThrow({ where: { roomId_participantId: { roomId: f.room.id, participantId: a.p.id } } })).hostMuted).toBe(false);
});
it('gates push-to-talk and viewer audio independently, rejects stale controls and foreign moderation targets', async () => {
  const f = await fixture(), other = await fixture(), a = await f.player(), viewer = await socket();
  await f.enter(a.client); await gameAck(viewer, 'room:subscribe', { roomCode: f.room.code }); await f.enter(viewer);
  const oldRevision = views.get(f.host.id!)!.revision;
  await f.control({ policy: { voiceMode: 'PUSH_TO_TALK' } });
  await self(a.client, { mic: true }); expect(route(a.client, f.host)).toBeUndefined();
  await self(a.client, { mic: true, talking: true }); expect(route(a.client, f.host)).toBeDefined(); expect(route(a.client, viewer)).toBeDefined();
  await f.control({ policy: { viewerAudio: false } }); expect(route(a.client, viewer)).toBeUndefined(); expect(route(a.client, f.host)).toBeDefined();
  expect((await gameAck(f.host, 'media:control', { expectedRevision: oldRevision, muteAll: true })).error).toBe('REVISION_CONFLICT');
  expect((await gameAck(f.host, 'media:control', { expectedRevision: views.get(f.host.id!)!.revision, targetId: other.host.id, hostMuted: true })).error).toBe('WRONG_ROOM');
});
it('removes media on kick, closed room and revoked authenticated session', async () => {
  const f = await fixture(), a = await f.player(); await f.enter(a.client); await self(a.client, { mic: true }); const old = route(a.client, f.host)!;
  await db.participation.update({ where: { id: a.p.id }, data: { kickedAt: new Date() } });
  expect((await gameAck(a.client, 'media:signal', { routeId: old.id, description: { type: 'offer', sdp: 'after kick' } })).success).toBe(false);
  await db.session.update({ where: { id: f.session.id }, data: { revokedAt: new Date() } });
  expect((await gameAck(f.host, 'media:control', { expectedRevision: 1, muteAll: true })).success).toBe(false);
  await db.room.update({ where: { id: f.room.id }, data: { status: 'ARCHIVED' } });
  expect((await gameAck(f.host, 'media:join')).success).toBe(false);
});
it('camera hide revokes video without muting voice and unhiding does not enable another camera', async () => {
  const f = await fixture(), a = await f.player(); await f.enter(a.client); await self(a.client, { mic: true, camera: true });
  expect(route(a.client, f.host, 'video')).toBeDefined(); await f.control({ targetId: a.client.id, cameraHidden: true });
  expect(route(a.client, f.host, 'video')).toBeUndefined(); expect(route(a.client, f.host)).toBeDefined();
  await f.control({ targetId: a.client.id, cameraHidden: false }); expect(route(a.client, f.host, 'video')).toBeUndefined();
});

it('creates multiple true DISPLAY sessions outside viewer limits and denies owner-cookie escalation', async () => {
  const f = await fixture(); await db.room.update({ where: { id: f.room.id }, data: { allowViewers: false, viewerLimit: 0 } });
  const link = await gameAck(f.host, 'media:display-link'); expect(link.success).toBe(true);
  const token = (link.data as { path: string }).path.split('#')[1], display = await socket(f.cookie), second = await socket();
  const before = await db.participation.count({ where: { roomId: f.room.id } });
  for (const client of [display, second]) {
    expect((await gameAck(client, 'room:display:subscribe', { roomCode: f.room.code, token })).success).toBe(true);
    expect((await gameAck(client, 'room:subscribe', { roomCode: f.room.code })).error).toBe('DISPLAY_READ_ONLY');
    await f.enter(client); expect(views.get(client.id!)!.self.role).toBe('DISPLAY'); expect(views.get(client.id!)!.canManage).toBe(false);
    expect((await self(client, { mic: true })).error).toBe('MEDIA_RECEIVE_ONLY');
    expect((await gameAck(client, 'media:control', { expectedRevision: 1, muteAll: true })).error).toBe('NOT_AUTHORIZED');
    expect((await gameAck(client, 'room:config:update', { roomCode: f.room.code, expectedRevision: 1, changes: { questionCount: 2 } })).success).toBe(false);
    expect((await gameAck(client, 'game:start', { roomCode: f.room.code, commandId: randomUUID() })).success).toBe(false);
    expect((await gameAck(client, 'geo:answer', { optionId: 'a', commandId: randomUUID() })).success).toBe(false);
  }
  expect(await db.displaySession.count({ where: { roomId: f.room.id, connected: true } })).toBe(2);
  expect(await db.viewerSession.count({ where: { roomId: f.room.id } })).toBe(0); expect(await db.participation.count({ where: { roomId: f.room.id } })).toBe(before);
  const wrong = await fixture(), stranger = await socket();
  expect((await gameAck(stranger, 'room:display:subscribe', { roomCode: wrong.room.code, token })).error).toBe('DISPLAY_TOKEN_INVALID');
  expect(verifyDisplayToken(f.room.id, token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'))).toBeNull();
  expect(verifyDisplayToken(f.room.id, displayToken(f.room.id))).not.toBeNull();
});
it('projects an actual started quiz to DISPLAY without answers, statistics or player controls', async () => {
  const f = await fixture(); await f.player(); await f.player();
  const pack = await db.questionPack.create({ data: { gameSlug: 'wissensduell', title: 'Broadcast' } });
  const q = await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'DISPLAY_PUBLIC_PROMPT', category: 'Test', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]), correctOptionId: 'b', explanation: 'DISPLAY_SECRET', durationMs: 60000 } });
  await db.room.update({ where: { id: f.room.id }, data: { setupSnapshotJson: JSON.stringify({ selectedQuestionIds: [q.id], questionCount: 1 }) } });
  const link = await gameAck(f.host, 'media:display-link'), token = (link.data as { path: string }).path.split('#')[1], display = await socket(f.cookie);
  await gameAck(display, 'room:display:subscribe', { roomCode: f.room.code, token });
  expect((await gameAck(f.host, 'game:start', { roomCode: f.room.code, commandId: randomUUID() })).success).toBe(true);
  try {
    cancelGeoTimer(f.room.id); await handleGeoGame.startRound(app.io, f.room.code);
    const projection = await gameAck(display, 'geo:resync'); expect(projection.success).toBe(true); expect(JSON.stringify(projection)).toContain('DISPLAY_PUBLIC_PROMPT'); expect(JSON.stringify(projection)).not.toMatch(/correctOptionId|answerStats|DISPLAY_SECRET/);
    const core = await gameAck(display, 'game:core:read'); expect(core.success).toBe(true); expect((core.projection as { availableActions: unknown[] }).availableActions).toEqual([]);
  } finally { cancelGeoTimer(f.room.id); }
});

it.each(['wissensduell', 'jeopardy'])('derives optional TEAM/PTT phase rules from a real started %s engine, including pause', async slug => {
  const f = await fixture(slug); await f.player(); await f.player();
  let setup: object = { board1: { categories: [{ name: 'Media', clues: [{ value: 100, question: 'Media question', answer: 'Media secret' }] }] } };
  if (slug === 'wissensduell') {
    const pack = await db.questionPack.create({ data: { gameSlug: slug, title: 'Media rules' } });
    const q = await db.geoQuestion.create({ data: { packId: pack.id, prompt: 'Media question', category: 'Test', options: JSON.stringify([{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }]), correctOptionId: 'a', durationMs: 60000 } }); setup = { selectedQuestionIds: [q.id], questionCount: 1 };
  }
  await db.room.update({ where: { id: f.room.id }, data: { setupSnapshotJson: JSON.stringify(setup) } });
  await f.control({ policy: { autoTeamDuringRound: true, autoPttDuringRound: true } });
  expect((await gameAck(f.host, 'game:start', { roomCode: f.room.code, commandId: randomUUID() })).success).toBe(true);
  try {
    if (slug === 'wissensduell') { cancelGeoTimer(f.room.id); await handleGeoGame.startRound(app.io, f.room.code); }
    else expect((await gameAck(f.host, 'jeopardy:field:open', { boardIndex: 1, categoryIndex: 0, value: 100, commandId: randomUUID() })).success).toBe(true);
    await vi.waitFor(() => expect(views.get(f.host.id!)!.policy).toMatchObject({ channel: 'TEAM', forcePushToTalk: true }));
    expect((await gameAck(f.host, 'game:pause', { roomCode: f.room.code, commandId: randomUUID() })).success).toBe(true);
    await self(f.host); expect(views.get(f.host.id!)!.policy).toMatchObject({ channel: 'TEAM', forcePushToTalk: true });
    expect((await gameAck(f.host, 'game:resume', { roomCode: f.room.code, commandId: randomUUID() })).success).toBe(true);
    expect((await gameAck(f.host, 'game:end', { roomCode: f.room.code, commandId: randomUUID() })).success).toBe(true);
    await self(f.host); expect(views.get(f.host.id!)!.policy).toMatchObject({ channel: 'MAIN', forcePushToTalk: false });
  } finally { cancelGeoTimer(f.room.id); }
});

it('restarts a receive-only viewer on both ends, isolates other routes and rejects stale signaling', async () => {
  const f = await fixture(), a = await f.player(), viewer = await socket(), unjoined = await socket();
  await gameAck(viewer, 'room:subscribe', { roomCode: f.room.code }); await f.enter(viewer); await f.enter(a.client);
  await gameAck(unjoined, 'room:subscribe', { roomCode: f.room.code });
  expect((await gameAck(unjoined, 'media:restart', {})).error).toBe('MEDIA_NOT_JOINED');
  await self(a.client, { mic: true, camera: true });
  const oldAudio = route(a.client, viewer)!, oldVideo = route(a.client, viewer, 'video')!, unaffected = route(a.client, f.host)!;
  const policy = views.get(viewer.id!)!.policy;
  expect((await gameAck(viewer, 'media:restart', { targetId: a.client.id })).error).toBe('INVALID_PAYLOAD');
  expect((await gameAck(viewer, 'media:restart', {})).success).toBe(true);
  const audio = route(a.client, viewer)!, video = route(a.client, viewer, 'video')!;
  expect(audio.id).not.toBe(oldAudio.id); expect(video.id).not.toBe(oldVideo.id);
  await vi.waitFor(() => expect(views.get(viewer.id!)!.routes.map(r => r.id)).toEqual(expect.arrayContaining([audio.id, video.id])));
  expect(route(a.client, f.host)!.id).toBe(unaffected.id);
  expect(views.get(viewer.id!)!.policy).toEqual(policy);
  expect(views.get(viewer.id!)!.self).toMatchObject({ role: 'VIEWER', mic: false, camera: false });
  const received: unknown[] = []; viewer.on('media:signal', data => received.push(data));
  expect((await gameAck(a.client, 'media:signal', { routeId: oldAudio.id, candidate: { candidate: 'old-ice' } })).error).toBe('MEDIA_ROUTE_REVOKED');
  expect((await gameAck(a.client, 'media:signal', { routeId: audio.id, description: { type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n' } })).success).toBe(true);
  await vi.waitFor(() => expect(received).toHaveLength(1));
  await f.control({ policy: { channel: 'TEAM' } });
  expect((await gameAck(viewer, 'media:restart', {})).success).toBe(true); expect(route(a.client, viewer)).toBeUndefined(); expect(route(a.client, viewer, 'video')).toBeDefined();
  await f.control({ targetId: a.client.id, hostMuted: true, cameraHidden: true });
  expect((await gameAck(a.client, 'media:restart', {})).success).toBe(true);
  expect(views.get(a.client.id!)!.routes).toHaveLength(0);
  expect(views.get(a.client.id!)!.self).toMatchObject({ mic: false, camera: false, hostMuted: true, cameraHidden: true });
  await db.participation.update({ where: { id: a.p.id }, data: { kickedAt: new Date() } });
  expect((await gameAck(a.client, 'media:restart', {})).success).toBe(false);
});
