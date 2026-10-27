import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Prisma, Room } from '@prisma/client';
import { RoomPolicySchema, resolveCanonicalSlug, normalizedParticipantName, ParticipantNameSchema, effectivePermissions, type RoomPolicy, type RoomOperation, type RoomCoreView, type GamePermission } from '@quiz/shared';
import { serializeRoom } from './queue.js';
import { roomEngineRules } from './engineRules.js';
import { prisma } from '../persistence/prisma.js';
import { assertCommandMutation } from '../games/core/commandExecution.js';
import { shuffleServer } from '../games/core/roundFlow.js';
import { saveGameStateIfRevision } from '../games/core/state.js';

export class RoomError extends Error { constructor(readonly code: string) { super(code); } }
export function roomPolicy(room: Pick<Room, 'roomPolicyJson' | 'pinHash' | 'viewerRequiresPin'>): RoomPolicy {
  return RoomPolicySchema.parse(room.roomPolicyJson ? JSON.parse(room.roomPolicyJson) : {
    playerAccess: room.pinHash ? 'PIN_PROTECTED' : 'PUBLIC_JOIN',
    viewerAccess: room.viewerRequiresPin && room.pinHash ? 'PIN_PROTECTED' : 'PUBLIC_JOIN',
  });
}
export function lifecycle(room: Pick<Room, 'lifecycle' | 'status' | 'runPhase' | 'expiresAt'>): string {
  if (room.status === 'ARCHIVED') return 'CLOSED';
  if (room.expiresAt && room.expiresAt <= new Date()) return 'EXPIRED';
  if (room.status === 'RUNNING') return room.runPhase === 'PAUSED' ? 'PAUSED' : 'GAME_ACTIVE';
  if (room.status === 'ENDED') return 'IDLE';
  return room.lifecycle ?? (room.runPhase === 'LOCKED' ? 'LOBBY_LOCKED' : 'LOBBY_OPEN');
}
export function assertRoomLive(room: Room): void {
  if (['CLOSED', 'EXPIRED'].includes(lifecycle(room))) throw new RoomError('ROOM_CLOSED');
}
export const boundaryPhases = new Set(['INTRO', 'ROUND_READY', 'REVEAL', 'ROUND_END', 'ROUND_LOCKED', 'SELECTING', 'FIELD_DONE', 'BOARD_COMPLETE', 'INTERMISSION']);
const supportedRoomEngines = new Set(['wissensduell', 'geo', 'jeopardy', 'wer-ist-das', 'weristdas']);

export async function feed(tx: Prisma.TransactionClient, roomId: string, actorId: string | null, kind: string, message: string) {
  await tx.roomFeedEntry.create({ data: { roomId, actorId, kind, message } });
}
export async function audit(tx: Prisma.TransactionClient, roomId: string, userId: string | null, action: string, metadata: unknown) {
  await tx.auditLog.create({ data: { userId, action, resource: 'ROOM', resourceId: roomId, metadata: JSON.stringify(metadata) } });
}
export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

async function writeLock(tx: Prisma.TransactionClient, roomId: string) {
  await assertCommandMutation(tx, roomId);
  await tx.room.update({ where: { id: roomId }, data: { revision: { increment: 1 } } });
}
export async function checkAccess(room: Room, role: 'PLAYER' | 'VIEWER', pin?: string, inviteToken?: string) {
  assertRoomLive(room);
  const mode = role === 'PLAYER' ? roomPolicy(room).playerAccess : roomPolicy(room).viewerAccess;
  if (mode === 'PIN_PROTECTED' && (!room.pinHash || !pin || !await argon2.verify(room.pinHash, pin))) throw new RoomError('INVALID_PIN');
  if (mode === 'INVITE_ONLY') {
    const invite = inviteToken ? await prisma.roomInvite.findUnique({ where: { tokenHash: tokenHash(inviteToken) } }) : null;
    if (!invite || invite.roomId !== room.id || invite.role !== role || invite.usedAt || invite.expiresAt <= new Date()) throw new RoomError('INVITE_REQUIRED');
  }
  return mode;
}

/** Both viewer models share one capacity, checked under the room writer lock. */
export async function activeViewerCount(db: Prisma.TransactionClient, roomId: string, excludeParticipantId?: string): Promise<number> {
  return await db.viewerSession.count({ where: { roomId, connected: true } })
    + await db.participation.count({ where: { roomId, role: 'VIEWER', connected: true, admission: 'ACTIVE',
      leftAt: null, kickedAt: null, bannedAt: null, ...(excludeParticipantId ? { id: { not: excludeParticipantId } } : {}) } });
}

export async function reconnectViewer(roomId: string, participantId: string, rejoinToken: string, connectionId: string) {
  return prisma.$transaction(async tx => {
    await writeLock(tx, roomId);
    const room = await tx.room.findUniqueOrThrow({ where: { id: roomId } }); assertRoomLive(room);
    const participant = await tx.participation.findFirst({ where: { id: participantId, roomId, rejoinToken,
      role: 'VIEWER', leftAt: null, kickedAt: null, bannedAt: null } });
    if (!participant) throw new RoomError('NO_PARTICIPATION');
    if (participant.admission === 'ACTIVE' && await activeViewerCount(tx, roomId, participant.id) >= room.viewerLimit) throw new RoomError('VIEWER_LIMIT_REACHED');
    return tx.participation.update({ where: { id: participant.id }, data: { connected: true, connectionId, lastSeenAt: new Date() } });
  });
}

/** Viewer capacity and invite consumption use the same serialized write as admission. */
export async function joinViewer(roomId: string, connectionId: string, input: { pin?: string; inviteToken?: string; userId?: string; displayName?: string }) {
  const initial = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
  const mode = await checkAccess(initial, 'VIEWER', input.pin, input.inviteToken);
  return serializeRoom(roomId, () => prisma.$transaction(async tx => {
    await writeLock(tx, roomId);
    const room = await tx.room.findUniqueOrThrow({ where: { id: roomId } });
    assertRoomLive(room);
    if (!room.allowViewers || ['LOBBY_LOCKED', 'SCHEDULED', 'DRAFT_ROOM'].includes(lifecycle(room))) throw new RoomError('ROOM_NOT_JOINABLE');
    if (room.roomPolicyJson !== initial.roomPolicyJson || room.pinHash !== initial.pinHash) throw new RoomError('ROOM_CHANGED');
    if (input.userId && await tx.participation.findFirst({ where: { roomId, userId: input.userId, bannedAt: { not: null } } })) throw new RoomError('BANNED');
    const existing = input.userId ? await tx.participation.findFirst({ where: { roomId, userId: input.userId, role: 'VIEWER', leftAt: null, kickedAt: null, bannedAt: null } }) : null;
    const admission = existing?.admission ?? (mode === 'APPROVAL_REQUIRED' ? 'PENDING_JOIN' : 'ACTIVE');
    if (admission === 'ACTIVE' && await activeViewerCount(tx, roomId, existing?.id) >= room.viewerLimit) throw new RoomError('VIEWER_LIMIT_REACHED');
    if (mode === 'INVITE_ONLY') {
      const consumed = await tx.roomInvite.updateMany({ where: { roomId, tokenHash: tokenHash(input.inviteToken!), role: 'VIEWER', usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (consumed.count !== 1) throw new RoomError('INVITE_REQUIRED');
    }
    if (input.userId || mode === 'APPROVAL_REQUIRED' || mode === 'INVITE_ONLY') {
      const p = existing ? await tx.participation.update({ where: { id: existing.id }, data: { connected: true, connectionId, lastSeenAt: new Date() } }) : await tx.participation.create({ data: { roomId, role: 'VIEWER', userId: input.userId, displayName: input.displayName ?? 'Zuschauer', normalizedName: `viewer:${randomUUID()}`, rejoinToken: randomUUID(), admission: mode === 'APPROVAL_REQUIRED' ? 'PENDING_JOIN' : 'ACTIVE', connected: true, connectionId } });
      return { participationId: p.id, roomId, role: 'VIEWER' as const, displayName: p.displayName, rejoinToken: p.rejoinToken };
    }
    const viewer = await tx.viewerSession.create({ data: { roomId, connected: true } });
    return { participationId: `viewer:${viewer.id}`, roomId, role: 'VIEWER' as const, displayName: 'Zuschauer' };
  }));
}

/** Admission, capacity, name reservation and invite use commit together. */
export async function joinPlayer(roomId: string, input: { displayName: string; pin?: string; inviteToken?: string; userId?: string; guestKeyHash?: string }) {
  const initial = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
  await checkAccess(initial, 'PLAYER', input.pin, input.inviteToken);
  const name = ParticipantNameSchema.parse(input.displayName);
  const nameKey = normalizedParticipantName(name);
  return serializeRoom(roomId, () => prisma.$transaction(async tx => {
    await writeLock(tx, roomId);
    const room = await tx.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true } });
    assertRoomLive(room);
    // Revalidate access after acquiring the write lock (policy may have changed).
    if (room.roomPolicyJson !== initial.roomPolicyJson || room.pinHash !== initial.pinHash) throw new RoomError('ROOM_CHANGED');
    const state = lifecycle(room), policy = roomPolicy(room);
    if (['LOBBY_LOCKED', 'DRAFT_ROOM', 'SCHEDULED'].includes(state)) throw new RoomError('ROOM_NOT_JOINABLE');
    if (room.status !== 'LOBBY' && !(room.status === 'RUNNING' && policy.allowLateJoin && supportedRoomEngines.has(room.gameDefinition.slug))) throw new RoomError('ROOM_NOT_JOINABLE');
    const sameName = await tx.participation.findMany({ where: { roomId, role: 'PLAYER', leftAt: null, bannedAt: null, kickedAt: null } });
    if (sameName.some(p => normalizedParticipantName(p.displayName) === nameKey)) throw new RoomError('NAME_TAKEN');
    if (input.userId && await tx.participation.findFirst({ where: { roomId, userId: input.userId, hasSeenHostSecrets: true } })) throw new RoomError('HOST_CANNOT_PLAY_OWN_ROUND');
    if (input.guestKeyHash && await tx.participation.findFirst({ where: { roomId, guestKeyHash: input.guestKeyHash, bannedAt: { not: null } } })) throw new RoomError('BANNED');
    if (input.userId && await tx.participation.findFirst({ where: { roomId, userId: input.userId, bannedAt: { not: null } } })) throw new RoomError('BANNED');
    const count = await tx.participation.count({ where: { roomId, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, bannedAt: null, kickedAt: null } });
    const full = count >= Math.min(room.maxPlayers, room.gameDefinition.maxPlayers);
    if (full && !policy.waitlist) throw new RoomError('ROOM_FULL');
    const admission = full ? 'WAITLIST' : room.status === 'RUNNING' || policy.playerAccess === 'APPROVAL_REQUIRED' ? 'PENDING_JOIN' : 'ACTIVE';
    if (policy.playerAccess === 'INVITE_ONLY') {
      const used = await tx.roomInvite.updateMany({ where: { tokenHash: tokenHash(input.inviteToken!), roomId, role: 'PLAYER', usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (used.count !== 1) throw new RoomError('INVITE_REQUIRED');
    }
    const participant = await tx.participation.create({ data: {
      roomId, displayName: name, normalizedName: nameKey, activeNameKey: nameKey, role: 'PLAYER', admission,
      userId: input.userId, guestKeyHash: input.guestKeyHash, connected: true, ready: false, rejoinToken: randomUUID(),
    } });
    await feed(tx, roomId, participant.id, 'JOIN', `${name}: ${admission === 'ACTIVE' ? 'beigetreten' : admission === 'WAITLIST' ? 'auf der Warteliste' : 'wartet auf Freigabe'}`);
    return participant;
  }));
}

export async function roomPreflight(roomId: string, overrideReady = false, db: Prisma.TransactionClient = prisma): Promise<RoomCoreView['preflight']> {
  const room = await db.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true, participations: true, teams: true } });
  const policy = roomPolicy(room), blockers: string[] = [], warnings: string[] = [];
  const players = room.participations.filter(p => p.role === 'PLAYER' && p.admission === 'ACTIVE' && !p.leftAt && !p.kickedAt && !p.bannedAt);
  const online = players.filter(p => p.connected);
  if (online.length < room.gameDefinition.minPlayers) blockers.push('NOT_ENOUGH_PLAYERS');
  if (players.length > Math.min(room.maxPlayers, room.gameDefinition.maxPlayers)) blockers.push('TOO_MANY_PLAYERS');
  if (!['LOBBY_OPEN', 'LOBBY_LOCKED'].includes(lifecycle(room))) blockers.push('ROOM_NOT_IN_LOBBY');
  if (online.some(p => !p.ready) && policy.readyRule !== 'READY_CHECK_DISABLED') {
    if (policy.readyRule === 'HOST_CAN_OVERRIDE') { if (!overrideReady) warnings.push('NOT_ALL_READY'); }
    else blockers.push('NOT_ALL_READY');
  }
  if (policy.teamMode !== 'OFF') {
    const limits = roomEngineRules(room.gameDefinition.slug);
    if (!limits || policy.teamCount < limits.minTeams || policy.teamCount > limits.maxTeams) blockers.push('TEAM_CONFIGURATION_INVALID');
    const sizes = room.teams.map(t => players.filter(p => p.teamId === t.id).length);
    if (room.teams.length !== policy.teamCount || players.some(p => !p.teamId || !room.teams.some(t => t.id === p.teamId)) || sizes.some(n => n < policy.minTeamSize || n > Math.min(policy.maxTeamSize, limits?.maxTeamSize ?? 0))) blockers.push('TEAM_CONFIGURATION_INVALID');
    if (new Set(sizes).size > 1) {
      if (policy.equality === 'REQUIRED') blockers.push('TEAMS_NOT_EQUAL');
      if (policy.equality === 'WARN') warnings.push('TEAMS_NOT_EQUAL');
    }
  }
  if (new Set(players.map(p => normalizedParticipantName(p.displayName))).size !== players.length) blockers.push('NAME_TAKEN');
  if (!supportedRoomEngines.has(room.gameDefinition.slug) || !['AVAILABLE', 'BETA'].includes(room.gameDefinition.status)) blockers.push('GAME_NOT_STARTABLE');
  let setup: Record<string, unknown> = {};
  try { setup = JSON.parse(room.setupSnapshotJson); if (typeof setup === 'string') setup = JSON.parse(setup); } catch { blockers.push('INVALID_SETUP'); }
  const slug = room.gameDefinition.slug;
  if (slug === 'wissensduell' || slug === 'geo') {
    const selected = Array.isArray(setup.selectedQuestionIds) ? setup.selectedQuestionIds as string[] : null;
    const questions = await db.geoQuestion.count({ where: { enabled: true, ...(selected?.length ? { id: { in: selected } } : setup.questionPoolId ? { packId: String(setup.questionPoolId) } : {}) } });
    if (!questions || (selected?.length && questions !== selected.length)) blockers.push('CONTENT_NOT_READY');
  } else if (slug === 'wer-ist-das' || slug === 'weristdas') {
    if (!Array.isArray(setup.rounds) || !setup.rounds.length) blockers.push('CONTENT_NOT_READY');
    else {
      const ids = setup.rounds.flatMap((r: Record<string, unknown>) => [r.gameImageAssetId ?? r.imageAssetId]).filter((id): id is string => typeof id === 'string');
      const media = await db.mediaAsset.findMany({ where: { id: { in: ids } } });
      if (ids.length !== setup.rounds.length || ids.some(id => !media.some(m => m.id === id && m.processStatus === 'READY'))) blockers.push('MEDIA_NOT_READY');
    }
  } else if (slug === 'jeopardy' && !setup.board1) blockers.push('CONTENT_NOT_READY');
  return { status: blockers.length ? 'BLOCKED' : warnings.length ? 'WARNINGS' : 'READY_TO_START', blockers, warnings };
}

async function setTeam(tx: Prisma.TransactionClient, room: Room, participantId: string, teamId: string | null) {
  const player = await tx.participation.findFirst({ where: { id: participantId, roomId: room.id, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, bannedAt: null, kickedAt: null } });
  if (!player) throw new RoomError('PLAYER_NOT_FOUND');
  if (teamId && !await tx.roomTeam.findFirst({ where: { id: teamId, roomId: room.id } })) throw new RoomError('TEAM_NOT_IN_ROOM');
  if (player.teamId === teamId) return;
  await tx.teamMembership.updateMany({ where: { roomId: room.id, participationId: participantId, endedAt: null }, data: { endedAt: new Date() } });
  await tx.participation.update({ where: { id: participantId }, data: { teamId, ready: false } });
  await tx.teamMembership.create({ data: { roomId: room.id, participationId: participantId, teamId, runIndex: room.runIndex } });
}
function shuffled<T>(values: T[]): T[] {
  return shuffleServer(values);
}
export interface RoomActor { connectionId?: string; participantId: string; userId: string | null; sessionId?: string; canManage: boolean; permissions: Set<GamePermission> }

/** All room edits serialize on the room row and fence their receipt owner. */
export async function mutateRoom(roomId: string, actor: RoomActor, op: RoomOperation): Promise<Record<string, unknown>> {
  return serializeRoom(roomId, () => prisma.$transaction(async tx => {
    await writeLock(tx, roomId);
    const room = await tx.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true, gameState: true, participations: true, teams: { orderBy: { createdAt: 'asc' } } } });
    assertRoomLive(room);
    if (actor.userId && (!actor.sessionId || !await tx.session.findFirst({ where: { id: actor.sessionId, userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } } }))) throw new RoomError('NOT_AUTHENTICATED');
    const owner = actor.userId === room.hostUserId, policy = roomPolicy(room);
    const self = room.participations.find(p => p.id === actor.participantId);
    if (actor.connectionId && (!self || !self.connected || self.connectionId !== actor.connectionId || self.leftAt || self.kickedAt || self.bannedAt)) throw new RoomError('NO_PARTICIPATION');
    if (self && self.admission !== 'ACTIVE' && op.type !== 'LEAVE') throw new RoomError('ADMISSION_REQUIRED');
    const grants = actor.userId ? await tx.roomPermissionGrant.findMany({ where: { roomId, userId: actor.userId, revokedAt: null } }) : [];
    const permissions = effectivePermissions(owner ? 'HOST' : self?.role === 'PLAYER' ? 'PLAYER' : 'VIEWER', policy.coHostEnabled || owner ? grants.filter(g => g.direction === 'GRANT').map(g => g.permission as GamePermission) : [], grants.filter(g => g.direction === 'REVOKE').map(g => g.permission as GamePermission));
    actor = { ...actor, permissions, canManage: permissions.has('PLAYER_MANAGE') || permissions.has('TEAM_MANAGE') || owner };
    if (['LOCK', 'MESSAGE'].includes(op.type) && !permissions.has('PLAYER_MANAGE')) throw new RoomError('NOT_AUTHORIZED');
    const ownActions = new Set(['TEAM_SELECT', 'LEAVE', 'RENAME']);
    if (!ownActions.has(op.type) && !actor.canManage && !(op.type === 'TRANSFER' && op.claim)) throw new RoomError('NOT_AUTHORIZED');
    if (['POLICY', 'SCHEDULE', 'OPEN', 'DRAFT', 'CLOSE', 'TRANSFER', 'COHOST', 'INVITE', 'REMATCH', 'LOBBY', 'SWITCH_GAME'].includes(op.type) && !owner && !(op.type === 'TRANSFER' && op.claim)) throw new RoomError('OWNER_REQUIRED');
    const teamEdit = ['TEAM_SELECT', 'TEAM_EDIT', 'TEAMS_ASSIGN'].includes(op.type);
    let midWidRound = false;
    if (teamEdit && resolveCanonicalSlug(room.gameDefinition.slug) === 'wer-ist-das' && room.gameState?.phase === 'ROUND_READY') {
      try {
        const buzzer = JSON.parse(room.gameState.stateJson)?.buzzer;
        midWidRound = !!buzzer?.eligiblePlayerIds || (buzzer?.excludedPlayerIds?.length ?? 0) > 0;
      }
      catch { midWidRound = true; } // Fail closed on an unreadable round boundary.
    }
    if (teamEdit && !actor.permissions.has('TEAM_MANAGE') && op.type !== 'TEAM_SELECT') throw new RoomError('NOT_AUTHORIZED');
    if (teamEdit && room.status === 'RUNNING' && (!actor.permissions.has('TEAM_MANAGE') || !policy.allowTeamReshuffleBetweenRounds || !boundaryPhases.has(room.gameState?.phase ?? '') || midWidRound || op.type !== 'TEAMS_ASSIGN' || !op.override)) throw new RoomError('TEAMS_LOCKED');
    if (teamEdit && !['LOBBY', 'RUNNING'].includes(room.status)) throw new RoomError('TEAMS_LOCKED');
    const activePlayers = room.participations.filter(p => p.role === 'PLAYER' && p.admission === 'ACTIVE' && !p.leftAt && !p.kickedAt && !p.bannedAt);
    let result: Record<string, unknown> = {};
    switch (op.type) {
      case 'POLICY': {
        if (room.status !== 'LOBBY') throw new RoomError('LOCKED_AFTER_START');
        const limits = roomEngineRules(room.gameDefinition.slug);
        if (op.policy.teamMode !== 'OFF' && (!limits || op.policy.teamCount < limits.minTeams || op.policy.teamCount > limits.maxTeams || op.policy.minTeamSize < limits.minTeamSize || op.policy.minTeamSize > limits.maxTeamSize)) throw new RoomError('INVALID_TEAM_LIMITS');
        if ((op.policy.playerAccess === 'PIN_PROTECTED' || op.policy.viewerAccess === 'PIN_PROTECTED') && !room.pinHash) throw new RoomError('PIN_REQUIRED');
        await tx.room.update({ where: { id: roomId }, data: { roomPolicyJson: JSON.stringify(op.policy) } });
        if (!op.policy.coHostEnabled) await tx.roomPermissionGrant.updateMany({ where: { roomId, userId: { not: room.hostUserId }, direction: 'GRANT' }, data: { revokedAt: new Date() } });
        if (op.policy.teamMode !== 'OFF') {
          if (room.teams.length > op.policy.teamCount && activePlayers.some(p => room.teams.slice(op.policy.teamCount).some(t => t.id === p.teamId))) throw new RoomError('TEAM_IN_USE');
          for (let i = room.teams.length; i < op.policy.teamCount; i++) await tx.roomTeam.create({ data: { roomId, name: `Team ${i + 1}`, icon: '👥', color: ['#2563eb', '#dc2626', '#16a34a', '#9333ea'][i % 4] } });
          if (room.teams.length > op.policy.teamCount) await tx.roomTeam.deleteMany({ where: { id: { in: room.teams.slice(op.policy.teamCount).map(t => t.id) } } });
        }
        break;
      }
      case 'LOCK':
        if (room.status !== 'LOBBY') throw new RoomError('ROOM_NOT_IN_LOBBY');
        await tx.room.update({ where: { id: roomId }, data: { lifecycle: op.locked ? 'LOBBY_LOCKED' : 'LOBBY_OPEN', runPhase: op.locked ? 'LOCKED' : 'OPEN' } }); break;
      case 'SCHEDULE':
        if (room.status !== 'LOBBY' || new Date(op.scheduledAt) <= new Date() || (op.expiresAt && new Date(op.expiresAt) <= new Date(op.scheduledAt))) throw new RoomError('INVALID_SCHEDULE');
        await tx.room.update({ where: { id: roomId }, data: { lifecycle: 'SCHEDULED', scheduledAt: new Date(op.scheduledAt), expiresAt: op.expiresAt ? new Date(op.expiresAt) : null } }); break;
      case 'DRAFT':
        if (room.status !== 'LOBBY') throw new RoomError('ROOM_NOT_IN_LOBBY');
        await tx.room.update({ where: { id: roomId }, data: { lifecycle: 'DRAFT_ROOM' } }); break;
      case 'OPEN':
        if (room.status !== 'LOBBY') throw new RoomError('ROOM_NOT_IN_LOBBY');
        await tx.room.update({ where: { id: roomId }, data: { lifecycle: 'LOBBY_OPEN', runPhase: 'OPEN' } }); break;
      case 'TEAM_EDIT':
        if (!(await tx.roomTeam.updateMany({ where: { id: op.teamId, roomId }, data: { name: op.name, color: op.color, icon: op.icon } })).count) throw new RoomError('TEAM_NOT_IN_ROOM'); break;
      case 'TEAM_SELECT': {
        if (policy.teamMode !== 'SELF_SELECT' || !self || self.role !== 'PLAYER' || room.status !== 'LOBBY') throw new RoomError('TEAM_SELECTION_DISABLED');
        if (activePlayers.filter(p => p.teamId === op.teamId && p.id !== self.id).length >= policy.maxTeamSize) throw new RoomError('TEAM_FULL');
        await setTeam(tx, room, self.id, op.teamId); break;
      }
      case 'TEAMS_ASSIGN': {
        if (policy.teamMode === 'OFF' || !room.teams.length) throw new RoomError('TEAMS_DISABLED');
        const assignments = new Map<string, string | null>();
        if (op.mode === 'MANUAL') for (const [id, team] of Object.entries(op.assignments ?? {})) assignments.set(id, team);
        else {
          const previous = await tx.teamMembership.findMany({ where: { roomId } });
          const buckets = room.teams.map(() => [] as string[]);
          for (const p of shuffled(activePlayers)) {
            const min = Math.min(...buckets.map(b => b.length));
            const candidates = buckets.map((b, i) => ({ b, i })).filter(x => x.b.length === min);
            candidates.sort((a, b) => {
              const cost = (i: number) => buckets[i].reduce((total, id) => total + previous.filter(h => h.participationId === p.id && h.teamId && previous.some(other => other.participationId === id && other.teamId === h.teamId && other.runIndex === h.runIndex)).length, 0);
              return op.mode === 'ROTATION' ? cost(a.i) - cost(b.i) : 0;
            });
            const index = candidates[0].i; buckets[index].push(p.id); assignments.set(p.id, room.teams[index].id);
          }
        }
        for (const [id, team] of assignments) await setTeam(tx, room, id, team);
        const members = await tx.participation.findMany({ where: { roomId, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, kickedAt: null, bannedAt: null } });
        if (room.teams.some(t => members.filter(p => p.teamId === t.id).length > policy.maxTeamSize)) throw new RoomError('TEAM_FULL');
        break;
      }
      case 'ADMIT': {
        if (!actor.permissions.has('PLAYER_MANAGE')) throw new RoomError('NOT_AUTHORIZED');
        const p = room.participations.find(p => p.id === op.participantId && ['WAITLIST', 'PENDING_JOIN'].includes(p.admission) && !p.bannedAt && !p.leftAt);
        if (!p) throw new RoomError('PLAYER_NOT_PENDING');
        if (op.approve) {
          if (p.role === 'PLAYER' && activePlayers.length >= Math.min(room.maxPlayers, room.gameDefinition.maxPlayers)) throw new RoomError('ROOM_FULL');
          if (room.status === 'RUNNING' && (!policy.allowLateJoin || !boundaryPhases.has(room.gameState?.phase ?? ''))) throw new RoomError('ROUND_BOUNDARY_REQUIRED');
          if (p.role === 'PLAYER' && policy.teamMode !== 'OFF' && !(!op.teamId && policy.teamMode === 'SELF_SELECT') && (!op.teamId || !room.teams.some(t => t.id === op.teamId) || activePlayers.filter(x => x.teamId === op.teamId).length >= policy.maxTeamSize)) throw new RoomError('TEAM_CONFIGURATION_INVALID');
          if (p.role === 'VIEWER' && p.connected && await activeViewerCount(tx, roomId, p.id) >= room.viewerLimit) throw new RoomError('VIEWER_LIMIT_REACHED');
          await tx.participation.update({ where: { id: p.id }, data: { admission: 'ACTIVE', ready: false } });
          if (op.teamId && p.role === 'PLAYER') await setTeam(tx, room, p.id, op.teamId);
          if (p.role === 'PLAYER' && room.gameState && room.status === 'RUNNING') {
            const state = JSON.parse(room.gameState.stateJson);
            state.scores = { ...state.scores, [p.id]: 0 };
            if (state.playerNames) state.playerNames = { ...state.playerNames, [p.id]: p.displayName };
            await saveGameStateIfRevision(tx, { roomId, expectedRevision: room.gameState.revision,
              gameSlug: room.gameDefinition.slug, state, phase: room.gameState.phase, eventType: 'ROOM_PLAYER_ADMITTED' });
          }
        } else await tx.participation.update({ where: { id: p.id }, data: { admission: 'REJECTED', leftAt: new Date(), activeNameKey: null } });
        break;
      }
      case 'RENAME': {
        const p = room.participations.find(p => p.id === op.participantId && p.role === 'PLAYER');
        if (!p || (!actor.permissions.has('PLAYER_MANAGE') && p.id !== self?.id)) throw new RoomError('NOT_AUTHORIZED');
        if (room.status !== 'LOBBY' && !actor.permissions.has('PLAYER_MANAGE')) throw new RoomError('NAME_LOCKED');
        const key = normalizedParticipantName(op.name);
        if (room.participations.some(x => x.id !== p.id && !x.leftAt && normalizedParticipantName(x.displayName) === key)) throw new RoomError('NAME_TAKEN');
        await tx.participation.update({ where: { id: p.id }, data: { displayName: op.name, normalizedName: key, activeNameKey: key, nameHistoryJson: JSON.stringify([...JSON.parse(p.nameHistoryJson), p.displayName]) } });
        if (room.gameState) {
          const state = JSON.parse(room.gameState.stateJson);
          if (state.playerNames) {
            state.playerNames[p.id] = op.name;
            // Untimed engines resume this saved inner state, not the paused wrapper.
            if (state.phase === 'PAUSED' && state._roomPause?.playerNames) state._roomPause.playerNames[p.id] = op.name;
            await saveGameStateIfRevision(tx, { roomId, expectedRevision: room.gameState.revision,
              gameSlug: room.gameDefinition.slug, state, phase: room.gameState.phase, eventType: 'ROOM_PLAYER_RENAMED' });
          }
        }
        break;
      }
      case 'LEAVE': case 'KICK': case 'BAN': case 'UNBAN': case 'TOKEN_ROTATE': {
        if (op.type !== 'LEAVE' && !actor.permissions.has('PLAYER_MANAGE')) throw new RoomError('NOT_AUTHORIZED');
        const id = op.type === 'LEAVE' ? self?.id : op.participantId;
        const p = room.participations.find(p => p.id === id && p.role !== 'HOST');
        if (!p) throw new RoomError('PLAYER_NOT_FOUND');
        const token = randomUUID();
        const data: Prisma.ParticipationUpdateInput = { rejoinToken: token, rejoinTokenVersion: { increment: 1 }, connected: false, connectionId: null };
        if (op.type === 'BAN') { data.bannedAt = new Date(); data.admission = 'BANNED'; data.activeNameKey = null; }
        if (op.type === 'KICK') { data.kickedAt = new Date(); data.admission = 'KICKED'; data.activeNameKey = null; }
        if (op.type === 'LEAVE') { data.leftAt = new Date(); data.admission = 'LEFT'; data.activeNameKey = null; }
        if (op.type === 'UNBAN') { data.bannedAt = null; data.kickedAt = null; data.admission = 'LEFT'; data.leftAt = new Date(); }
        // A kick permits a fresh join; BAN additionally blocks the credential.
        if (op.type === 'TOKEN_ROTATE') { data.kickedAt = null; data.leftAt = null; data.admission = 'ACTIVE'; if (p.bannedAt) throw new RoomError('BANNED'); result = { rejoinToken: token, participantId: p.id }; }
        await tx.participation.update({ where: { id: p.id }, data });
        if (['LEAVE', 'KICK', 'BAN'].includes(op.type)) await tx.teamMembership.updateMany({ where: { roomId, participationId: p.id, endedAt: null }, data: { endedAt: new Date() } });
        await audit(tx, roomId, actor.userId, op.type, { participantId: p.id });
        break;
      }
      case 'COHOST': {
        if (!policy.coHostEnabled) throw new RoomError('COHOST_DISABLED');
        const user = await tx.user.findUnique({ where: { id: op.userId } });
        if (!user || user.disabledAt || user.id === room.hostUserId) throw new RoomError('INVALID_COHOST');
        await tx.roomPermissionGrant.updateMany({ where: { roomId, userId: op.userId, direction: 'GRANT' }, data: { revokedAt: new Date() } });
        for (const permission of op.permissions) await tx.roomPermissionGrant.upsert({ where: { roomId_userId_permission_direction: { roomId, userId: op.userId, permission, direction: 'GRANT' } }, create: { roomId, userId: op.userId, permission, direction: 'GRANT', grantedBy: actor.userId! }, update: { revokedAt: null, grantedBy: actor.userId! } });
        await audit(tx, roomId, actor.userId, 'COHOST', { userId: op.userId, permissions: op.permissions }); break;
      }
      case 'TRANSFER': {
        const target = await tx.user.findUnique({ where: { id: op.userId } });
        const session = await tx.session.findFirst({ where: { userId: op.userId, revokedAt: null, expiresAt: { gt: new Date() } } });
        const targetMember = room.participations.find(p => p.userId === op.userId && p.connected && !p.bannedAt && !p.kickedAt && p.admission === 'ACTIVE');
        const grants = await tx.roomPermissionGrant.findMany({ where: { roomId, userId: op.userId, direction: 'GRANT', revokedAt: null } });
        if (!target || target.disabledAt || !session || !targetMember) throw new RoomError('HOST_MISSING');
        if (op.claim) {
          const oldHost = room.participations.find(p => p.userId === room.hostUserId || p.role === 'HOST');
          if (actor.userId !== op.userId || !policy.coHostEnabled || !grants.some(g => g.permission === 'PLAYER_MANAGE') || !oldHost || oldHost.connected || Date.now() - oldHost.lastSeenAt.getTime() < policy.hostGraceMs) throw new RoomError('HOST_TRANSFER_NOT_ALLOWED');
        }
        // Never promote a player to the secret-bearing HOST game role.
        await tx.room.update({ where: { id: roomId }, data: { hostUserId: op.userId } });
        await tx.participation.updateMany({ where: { roomId, role: 'HOST' }, data: { role: 'VIEWER', connected: false, connectionId: null, rejoinToken: randomUUID(), rejoinTokenVersion: { increment: 1 } } });
        await tx.roomPermissionGrant.updateMany({ where: { roomId, userId: room.hostUserId }, data: { revokedAt: new Date() } });
        await audit(tx, roomId, actor.userId, 'HOST_TRANSFER', { previous: room.hostUserId, next: op.userId, claim: op.claim }); break;
      }
      case 'INVITE': {
        const token = randomUUID();
        await tx.roomInvite.create({ data: { roomId, role: op.role, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 86400000) } });
        result = { inviteToken: token }; break;
      }
      case 'MESSAGE': break;
      case 'LOBBY': case 'REMATCH': case 'SWITCH_GAME': {
        if (room.status !== 'ENDED') throw new RoomError('GAME_NOT_ENDED');
        await tx.roomRun.upsert({ where: { roomId_runIndex: { roomId, runIndex: room.runIndex } }, update: {}, create: {
          roomId, runIndex: room.runIndex, gameDefinitionId: room.gameDefinitionId, engineVersion: room.gameState?.engineVersion,
          configSnapshotJson: room.gameConfigSnapshotJson, stateJson: room.gameState?.stateJson, scoresJson: JSON.stringify(room.participations.map(p => ({ id: p.id, displayName: p.displayName, score: p.score, teamId: p.teamId }))), teamsJson: JSON.stringify(room.teams),
        } });
        let gameDefinitionId = room.gameDefinitionId, setupSnapshotJson = room.setupSnapshotJson;
        if (op.type === 'SWITCH_GAME') {
          const game = await tx.gameDefinition.findUnique({ where: { slug: op.gameSlug } });
          if (!game || !supportedRoomEngines.has(game.slug) || !['AVAILABLE', 'BETA'].includes(game.status)) throw new RoomError('GAME_NOT_STARTABLE');
          gameDefinitionId = game.id;
          const source = op.sourceRoomId ? await tx.room.findFirst({ where: { id: op.sourceRoomId, hostUserId: actor.userId!, gameDefinitionId: game.id } }) : null;
          if (op.sourceRoomId && !source) throw new RoomError('SETUP_NOT_OWNED');
          if (!source && game.slug !== 'wissensduell') throw new RoomError('PREPARED_SETUP_REQUIRED');
          setupSnapshotJson = source?.setupSnapshotJson ?? '{}';
        }
        await tx.roomGameState.deleteMany({ where: { roomId } });
        await tx.participation.updateMany({ where: { roomId }, data: { score: 0, ready: false } });
        await tx.roomTeam.updateMany({ where: { roomId }, data: { score: 0 } });
        await tx.room.update({ where: { id: roomId }, data: { status: 'LOBBY', runPhase: 'OPEN', lifecycle: 'LOBBY_OPEN', gameDefinitionId, setupSnapshotJson, runIndex: { increment: 1 }, startedAt: null, endedAt: null, gameConfigSnapshotJson: null, configSchemaVersion: 0, liveConfigJson: null } });
        break;
      }
      case 'CLOSE':
        if (room.status === 'RUNNING') throw new RoomError('END_GAME_FIRST');
        if (room.status === 'ENDED') await tx.roomRun.upsert({ where: { roomId_runIndex: { roomId, runIndex: room.runIndex } }, update: {}, create: {
          roomId, runIndex: room.runIndex, gameDefinitionId: room.gameDefinitionId, engineVersion: room.gameState?.engineVersion,
          configSnapshotJson: room.gameConfigSnapshotJson, stateJson: room.gameState?.stateJson, scoresJson: JSON.stringify(room.participations.map(p => ({ id: p.id, displayName: p.displayName, score: p.score, teamId: p.teamId }))), teamsJson: JSON.stringify(room.teams),
        } });
        await tx.room.update({ where: { id: roomId }, data: { status: 'ARCHIVED', lifecycle: 'CLOSED', archivedAt: new Date() } });
        await tx.participation.updateMany({ where: { roomId }, data: { connected: false, connectionId: null, rejoinTokenVersion: { increment: 1 } } });
        await tx.viewerSession.updateMany({ where: { roomId }, data: { connected: false, disconnectedAt: new Date() } }); break;
      case 'EMERGENCY': throw new RoomError('ENGINE_ACTION_UNSUPPORTED');
    }
    const labels: Record<string, string> = { POLICY: 'Raumeinstellungen geändert', LOCK: op.type === 'LOCK' && op.locked ? 'Lobby gesperrt' : 'Lobby geöffnet', SCHEDULE: 'Raum geplant', OPEN: 'Lobby geöffnet', DRAFT: 'Raum als Entwurf gespeichert', TEAMS_ASSIGN: 'Teams neu zugewiesen', TEAM_EDIT: 'Team bearbeitet', TEAM_SELECT: 'Team gewählt', ADMIT: 'Teilnahme entschieden', RENAME: 'Anzeigename geändert', LEAVE: 'Raum verlassen', KICK: 'Teilnehmer entfernt', BAN: 'Teilnehmer gesperrt', UNBAN: 'Raumsperre aufgehoben', TOKEN_ROTATE: 'Geräteübernahme vorbereitet', COHOST: 'Co-Host-Rechte geändert', TRANSFER: 'Host-Verwaltung übertragen', INVITE: 'Einladung erstellt', LOBBY: 'Neue Lobby vorbereitet', REMATCH: 'Revanche vorbereitet', SWITCH_GAME: 'Spiel gewechselt', CLOSE: 'Raum endgültig geschlossen' };
    await feed(tx, roomId, actor.participantId, op.type, op.type === 'MESSAGE' ? op.message : `${labels[op.type] ?? op.type}${'reason' in op && op.reason ? ': ' + op.reason : ''}`);
    return result;
  }));
}

export async function roomView(roomId: string, actor: RoomActor): Promise<RoomCoreView> {
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true, participations: true, teams: true, feed: { orderBy: { createdAt: 'desc' }, take: 50 } } });
  const self = room.participations.find(p => p.id === actor.participantId);
  const host = room.participations.find(p => p.userId === room.hostUserId || p.role === 'HOST');
  if (self && self.admission !== 'ACTIVE') return {
    gameSlug: room.gameDefinition.slug, history: [], switchOptions: [], revision: room.revision,
    lifecycle: lifecycle(room), policy: roomPolicy(room), scheduledAt: room.scheduledAt?.toISOString() ?? null,
    hostStatus: host?.connected ? 'ONLINE' : 'HOST_MISSING', permissions: [], canManage: false, isOwner: false,
    selfId: self.id, selfAdmission: self.admission, participants: [], teams: [], feed: [],
    preflight: { status: 'BLOCKED', blockers: ['ADMISSION_REQUIRED'], warnings: [] }, runIndex: room.runIndex,
  };
  return {
    gameSlug: room.gameDefinition.slug,
    history: (await prisma.roomRun.findMany({ where: { roomId }, orderBy: { runIndex: 'desc' }, take: 20 })).map(run => ({ runIndex: run.runIndex, endedAt: run.endedAt.toISOString(), players: (JSON.parse(run.scoresJson) as Array<{ displayName: string; score: number }>).map(p => ({ displayName: p.displayName, score: p.score })) })),
    switchOptions: actor.userId === room.hostUserId ? (await prisma.room.findMany({ where: { hostUserId: room.hostUserId }, include: { gameDefinition: true }, orderBy: { createdAt: 'desc' }, take: 50 })).map(r => ({ id: r.id, roomName: r.roomName, gameSlug: r.gameDefinition.slug })) : [],
    revision: room.revision, lifecycle: lifecycle(room), policy: roomPolicy(room), scheduledAt: room.scheduledAt?.toISOString() ?? null,
    hostStatus: host?.connected ? 'ONLINE' : host && Date.now() - host.lastSeenAt.getTime() < roomPolicy(room).hostGraceMs ? 'DISCONNECTED' : 'HOST_MISSING',
    permissions: [...actor.permissions],
    canManage: actor.canManage, isOwner: actor.userId === room.hostUserId, selfId: self?.id ?? null, selfAdmission: self?.admission ?? null,
    participants: room.participations.filter(p => actor.canManage || p.admission === 'ACTIVE' || p.id === self?.id).map(p => ({ id: p.id, displayName: p.displayName, role: p.role, admission: p.admission, connected: p.connected, ready: p.ready, teamId: p.teamId, score: p.score, banned: !!p.bannedAt, connectionQuality: p.lastRoundTripMs === null ? 'UNKNOWN' : p.lastRoundTripMs < 150 ? 'GUT' : p.lastRoundTripMs < 500 ? 'INSTABIL' : 'SCHLECHT', ...(actor.canManage ? { userId: p.userId } : {}) })),
    teams: room.teams.map(t => ({ id: t.id, name: t.name, color: t.color, icon: t.icon, score: t.score })),
    feed: room.feed.map(f => ({ id: f.id, kind: f.kind, message: f.message, createdAt: f.createdAt.toISOString() })),
    preflight: await roomPreflight(roomId), runIndex: room.runIndex,
  };
}
