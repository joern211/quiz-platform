import { coreLifecyclePhase } from '../games/core/lifecycle.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Server, Socket } from 'socket.io';
import { LiveMediaPolicySchema, type LiveMediaMember, type LiveMediaPolicy, type LiveMediaRoute, type LiveMediaSnapshot } from '@quiz/shared';
import { prisma } from '../persistence/prisma.js';
import { socketRoomActor } from '../rooms/socket.js';
import { RoomError, assertRoomLive } from '../rooms/core.js';
import { serializeRoom } from '../rooms/queue.js';
import { roomChannel } from '../sockets/channel.js';
import { socketIdentityMap } from '../http/middleware/auth.js';
import { logger } from '../observability/logger.js';

type Member = LiveMediaMember & { socket: Socket; roomId: string; canManage: boolean; wantsMic: boolean; wantsCamera: boolean; talking: boolean; teamListen: string | null };
type Consent = { roomId: string; mic: boolean; camera: boolean; talking: boolean; teamListen: string | null };
const selfSchema = z.object({ mic: z.boolean(), camera: z.boolean(), talking: z.boolean(), teamListen: z.string().max(100).nullable().default(null) }).strict();
const commandSchema = z.object({ expectedRevision: z.number().int().positive(), policy: LiveMediaPolicySchema.partial().optional(), targetId: z.string().max(150).optional(), hostMuted: z.boolean().optional(), cameraHidden: z.boolean().optional(), muteAll: z.boolean().optional() }).strict();
const signalSchema = z.object({ routeId: z.string().uuid(), description: z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().max(65536) }).strict().optional(), candidate: z.object({ candidate: z.string().max(4096), sdpMid: z.string().max(100).nullable().optional(), sdpMLineIndex: z.number().int().min(0).max(10).nullable().optional(), usernameFragment: z.string().max(256).nullable().optional() }).strict().optional() }).strict().refine(s => !!s.description !== !!s.candidate);
const iceSchema = z.array(z.object({ urls: z.union([z.string(), z.array(z.string()).max(8)]), username: z.string().optional(), credential: z.string().optional() })).max(8);
function iceServers(): LiveMediaSnapshot['iceServers'] {
  try { const parsed = iceSchema.parse(JSON.parse(process.env.RTC_ICE_SERVERS ?? '[]')); if (parsed.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => !/^(stun|stuns|turn|turns):[^\s]+$/.test(url)))) return []; return parsed; }
  catch { return []; }
}
const refreshers = new WeakMap<Server, () => Promise<void>>();
export function refreshLiveMedia(io: Server) { return refreshers.get(io)?.().catch(error => logger.error('Live media refresh failed', { error })) ?? Promise.resolve(); }
const publicMember = (m: Member): LiveMediaMember => ({ id: m.id, name: m.name, role: m.role, teamId: m.teamId, hostMuted: m.hostMuted, cameraHidden: m.cameraHidden, mic: m.mic, camera: m.camera });
export function liveMediaAllowed(from: LiveMediaMember, to: LiveMediaMember, kind: 'audio' | 'video', policy: LiveMediaPolicy, listenerTeam: string | null = null): boolean {
  if (from.id === to.id || ['VIEWER', 'DISPLAY'].includes(from.role)) return false;
  if (kind === 'video') return policy.camerasEnabled && policy.camerasVisible && from.camera && !from.cameraHidden;
  if (!policy.voiceEnabled || !from.mic || from.hostMuted || (policy.exclusiveSpeakerId && policy.exclusiveSpeakerId !== from.id)) return false;
  if (['VIEWER', 'DISPLAY'].includes(to.role)) return policy.channel === 'MAIN' && policy.viewerAudio;
  if (policy.channel === 'MAIN') return true;
  // A non-playing HOST may select one team to moderate. A PLAYER never gets this bypass.
  const sourceTeam = from.role === 'HOST' && !from.teamId ? null : from.teamId;
  const receiverTeam = to.role === 'HOST' && !to.teamId ? listenerTeam : to.teamId;
  if (from.role === 'HOST' && !from.teamId) return !!to.teamId && listenerTeam === to.teamId;
  return !!sourceTeam && sourceTeam === receiverTeam;
}

export function setupLiveMedia(io: Server) {
  const consent = new Map<string, Consent>(), routes = new Map<string, LiveMediaRoute>(), snapshots = new Map<string, string>();
  let refreshTail: Promise<void> = Promise.resolve();
  async function member(socket: Socket): Promise<Member> {
    const { roomId, actor } = await socketRoomActor(socket);
    const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } }); assertRoomLive(room);
    const identity = socketIdentityMap.get(socket.id);
    if (!identity?.participationId || identity.userId && !actor.userId) throw new RoomError('SESSION_REQUIRED');
    const display = identity.role === 'DISPLAY';
    const p = identity.participationId.startsWith('viewer:') || display ? null : await prisma.participation.findFirst({ where: { id: identity.participationId, roomId, admission: 'ACTIVE', connected: true, connectionId: socket.id, leftAt: null, bannedAt: null, kickedAt: null } });
    if (!p && !display && !identity.participationId.startsWith('viewer:')) throw new RoomError('NO_PARTICIPATION');
    if (!p && !display && !await prisma.viewerSession.findFirst({ where: { id: identity.participationId.slice(7), roomId, connected: true } })) throw new RoomError('NO_PARTICIPATION');
    const control = await prisma.participantMediaControl.findUnique({ where: { roomId_participantId: { roomId, participantId: identity.participationId } } });
    const savedConsent = consent.get(socket.id); if (savedConsent && savedConsent.roomId !== roomId) throw new RoomError('MEDIA_ROOM_CHANGED');
    const c = savedConsent ?? { mic: false, camera: false, talking: false, teamListen: null };
    return { socket, roomId, id: socket.id, name: p?.displayName ?? 'Zuschauer', role: display ? 'DISPLAY' : p?.role ?? 'VIEWER', teamId: p?.teamId ?? null,
      canManage: actor.permissions.has('PLAYER_MANAGE'), hostMuted: control?.hostMuted ?? false, cameraHidden: control?.cameraHidden ?? false,
      wantsMic: c.mic, wantsCamera: c.camera, mic: c.mic, camera: c.camera, talking: c.talking, teamListen: p?.role === 'HOST' && !p.teamId ? c.teamListen : null };
  }
  async function refreshInner() {
    const valid: Member[] = [];
    for (const [id] of consent) {
      const socket = io.sockets.sockets.get(id);
      try { if (!socket?.connected) throw new RoomError('NOT_IN_ROOM'); valid.push(await member(socket)); }
      catch { if (socket) socket.emit('media:closed'); consent.delete(id); snapshots.delete(id); }
    }
    const next = new Map<string, LiveMediaRoute>();
    const byRoom = new Map<string, { policy: LiveMediaPolicy; revision: number }>();
    for (const m of valid) {
      if (byRoom.has(m.roomId)) continue;
      const room = await prisma.room.findUniqueOrThrow({ where: { id: m.roomId }, include: { gameDefinition: true, gameState: true } });
      const record = await prisma.roomMediaControl.findUnique({ where: { roomId: m.roomId } });
      const policy = LiveMediaPolicySchema.parse({ camerasEnabled: room.cameraEnabled, ...JSON.parse(record?.policyJson ?? '{}') });
      if ((policy.autoTeamDuringRound || policy.autoPttDuringRound) && room.gameState) {
        let activeRound = false;
        try { let state = JSON.parse(room.gameState.stateJson); if (state.phase === 'PAUSED') state = state._roomPause ?? (state.roundStates?.[state.currentRoundIndex] && !state.roundStates[state.currentRoundIndex].revealed ? { ...state, phase: 'INPUT_OPEN' } : state); activeRound = ['ROUND_ACTIVE', 'ROUND_RESOLUTION'].includes(coreLifecyclePhase(room.gameDefinition.slug, state)); } catch { policy.voiceEnabled = false; }
        if (policy.autoTeamDuringRound) policy.channel = activeRound ? 'TEAM' : 'MAIN';
        if (policy.autoPttDuringRound && activeRound) policy.forcePushToTalk = true;
      }
      byRoom.set(m.roomId, { policy, revision: record?.revision ?? 1 });
    }
    for (const m of valid) {
      const policy = byRoom.get(m.roomId)!.policy;
      m.mic = m.wantsMic && !m.hostMuted && (policy.voiceMode !== 'PUSH_TO_TALK' && !policy.forcePushToTalk || m.talking);
      m.camera = m.wantsCamera && !m.cameraHidden && policy.camerasEnabled && policy.camerasVisible;
    }
    for (const from of valid) for (const to of valid) {
      if (from.roomId !== to.roomId) continue;
      const policy = byRoom.get(from.roomId)!.policy;
      for (const kind of ['audio', 'video'] as const) {
        // TEAM host source uses its own selected channel, not the receiver's selection.
        const listen = from.role === 'HOST' && !from.teamId ? from.teamListen : to.teamListen;
        if (!liveMediaAllowed(from, to, kind, policy, listen)) continue;
        const key = `${from.id}:${to.id}:${kind}`;
        const previous = routes.get(key);
        next.set(key, previous ?? { id: randomUUID(), from: from.id, to: to.id, kind, name: from.name });
      }
    }
    routes.clear(); for (const [key, value] of next) routes.set(key, value);
    for (const m of valid) {
      const config = byRoom.get(m.roomId)!;
      const room = await prisma.room.findUniqueOrThrow({ where: { id: m.roomId } });
      const state: LiveMediaSnapshot = { roomCode: room.code, selfId: m.id, revision: config.revision, policy: config.policy, canManage: m.canManage,
        self: publicMember(m), members: valid.filter(v => v.roomId === m.roomId).map(publicMember), routes: [...next.values()].filter(r => r.from === m.id || r.to === m.id), iceServers: iceServers() };
      const hash = JSON.stringify(state); if (snapshots.get(m.id) !== hash) { snapshots.set(m.id, hash); m.socket.emit('media:snapshot', state); }
    }
  }
  function refresh() { const run = refreshTail.then(refreshInner); refreshTail = run.catch(() => {}); return run; }
  refreshers.set(io, refresh);
  const timer = setInterval(() => { if (consent.size) void refresh().catch(error => logger.error('Live media refresh failed', { error })); }, 1000); timer.unref();
  io.httpServer?.once('close', () => clearInterval(timer));
  io.on('connection', socket => {
    const limits = new Map<string, { start: number; count: number }>();
    function rate(event: string, max: number) { const now = Date.now(), old = limits.get(event); const row = old && now - old.start < 10000 ? old : { start: now, count: 0 }; limits.set(event, row); if (++row.count > max) throw new RoomError('MEDIA_RATE_LIMIT'); }
    const register = (event: string, max: number, run: (raw: unknown) => Promise<unknown>) => socket.on(event, async (raw, ack) => {
      try { rate(event, max); const data = await run(raw); ack?.({ success: true, data }); }
      catch (error) { ack?.({ success: false, error: error instanceof RoomError ? error.code : error instanceof z.ZodError ? 'INVALID_PAYLOAD' : 'MEDIA_UNAVAILABLE' }); }
    });
    register('media:join', 20, async () => { const m = await member(socket); consent.set(socket.id, { roomId: m.roomId, mic: false, camera: false, talking: false, teamListen: null }); snapshots.delete(socket.id); await refresh(); return {}; });
    register('media:self', 60, async raw => {
      const self = selfSchema.parse(raw), m = await member(socket);
      if (!consent.has(socket.id)) throw new RoomError('MEDIA_NOT_JOINED');
      if (['VIEWER', 'DISPLAY'].includes(m.role) && (self.mic || self.camera || self.teamListen)) throw new RoomError('MEDIA_RECEIVE_ONLY');
      if (self.teamListen && (m.role !== 'HOST' || m.teamId || !await prisma.roomTeam.findFirst({ where: { id: self.teamListen, roomId: m.roomId } }))) throw new RoomError('TEAM_NOT_ALLOWED');
      if (self.mic && m.hostMuted) throw new RoomError('HOST_MUTED');
      consent.set(socket.id, { ...self, roomId: m.roomId }); await refresh(); return {};
    });
    register('media:control', 30, async raw => {
      const command = commandSchema.parse(raw), initial = await member(socket);
      if (!initial.canManage) throw new RoomError('NOT_AUTHORIZED');
      await serializeRoom(initial.roomId, async () => {
        const m = await member(socket); if (!m.canManage) throw new RoomError('NOT_AUTHORIZED');
        await prisma.$transaction(async tx => {
          const existing = await tx.roomMediaControl.findUnique({ where: { roomId: m.roomId } });
          if ((existing?.revision ?? 1) !== command.expectedRevision) throw new RoomError('REVISION_CONFLICT');
          const room = await tx.room.findUniqueOrThrow({ where: { id: m.roomId } });
          const policy = LiveMediaPolicySchema.parse({ camerasEnabled: room.cameraEnabled, ...JSON.parse(existing?.policyJson ?? '{}'), ...command.policy });
          if (policy.exclusiveSpeakerId && !io.sockets.sockets.get(policy.exclusiveSpeakerId)?.rooms.has(roomChannel(m.roomId))) throw new RoomError('WRONG_ROOM');
          await tx.roomMediaControl.upsert({ where: { roomId: m.roomId }, create: { roomId: m.roomId, revision: 2, policyJson: JSON.stringify(policy) }, update: { revision: { increment: 1 }, policyJson: JSON.stringify(policy) } });
          const targets = command.muteAll ? [...consent.keys()].filter(id => io.sockets.sockets.get(id)?.data.roomId === m.roomId && id !== socket.id) : command.targetId ? [command.targetId] : [];
          for (const id of targets) {
            const target = io.sockets.sockets.get(id), identity = socketIdentityMap.get(id);
            if (!target || identity?.roomId !== m.roomId || !identity.participationId) throw new RoomError('WRONG_ROOM');
            await tx.participantMediaControl.upsert({ where: { roomId_participantId: { roomId: m.roomId, participantId: identity.participationId } },
              create: { roomId: m.roomId, participantId: identity.participationId, hostMuted: command.muteAll || command.hostMuted || false, cameraHidden: command.cameraHidden ?? false },
              update: { ...(command.muteAll || command.hostMuted !== undefined ? { hostMuted: command.muteAll || command.hostMuted } : {}), ...(command.cameraHidden !== undefined ? { cameraHidden: command.cameraHidden } : {}) } });
          }
          await tx.auditLog.create({ data: { userId: socketIdentityMap.get(socket.id)?.userId, action: 'MEDIA_CONTROL', resource: 'ROOM', resourceId: m.roomId, metadata: JSON.stringify(command) } });
        });
      });
      // A host release never enables another person's hardware or microphone.
      for (const [id, state] of consent) if (io.sockets.sockets.get(id)?.data.roomId === initial.roomId) {
        const m = await member(io.sockets.sockets.get(id)!); if (m.hostMuted) state.mic = false;
        const saved = await prisma.roomMediaControl.findUnique({ where: { roomId: m.roomId } }); const policy = LiveMediaPolicySchema.parse(JSON.parse(saved?.policyJson ?? '{}'));
        if (!policy.camerasEnabled || !policy.camerasVisible || m.cameraHidden) state.camera = false;
        if (!policy.voiceEnabled) state.mic = false;
      }
      await refresh(); return {};
    });
    register('media:signal', 300, async raw => {
      const signal = signalSchema.parse(raw); await member(socket); await refresh();
      const route = [...routes.values()].find(r => r.id === signal.routeId && (r.from === socket.id || r.to === socket.id));
      if (!route) throw new RoomError('MEDIA_ROUTE_REVOKED');
      if (signal.description && (signal.description.type === 'offer' ? route.from !== socket.id : route.to !== socket.id)) throw new RoomError('NOT_AUTHORIZED');
      if (signal.description) {
        const kinds = [...signal.description.sdp.matchAll(/^m=(\w+) /gm)].map(match => match[1]);
        const direction = signal.description.type === 'offer' ? 'sendonly' : 'recvonly';
        if (kinds.length !== 1 || kinds[0] !== route.kind || !signal.description.sdp.split(/\r?\n/).includes(`a=${direction}`)) throw new RoomError('MEDIA_SDP_NOT_ALLOWED');
      }
      const other = io.sockets.sockets.get(route.from === socket.id ? route.to : route.from); if (!other) throw new RoomError('MEDIA_ROUTE_REVOKED');
      await member(other); other.emit('media:signal', signal); return {};
    });
    register('media:leave', 20, async () => { consent.delete(socket.id); snapshots.delete(socket.id); await refresh(); return {}; });
    socket.on('disconnect', () => { consent.delete(socket.id); snapshots.delete(socket.id); void refresh().catch(() => {}); });
  });
}
