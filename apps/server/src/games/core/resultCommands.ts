import type { Server, Socket } from 'socket.io';
import type { Prisma } from '@prisma/client';
import { ResultCommandSchema, ResultReadSchema, effectivePermissions, type ResultCommand, type GamePermission } from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import { socketRoomActor, changed } from '../../rooms/socket.js';
import { audit, feed, roomPolicy, type RoomActor } from '../../rooms/core.js';
import { roomChannel } from '../../sockets/channel.js';
import { assertCommandMutation } from './commandExecution.js';
import { runReceipted } from './commands.js';
import { CoreRuleError } from './runtimePrimitives.js';
import { saveGameStateIfRevision } from './state.js';
import { StoredGameResultSchema, readGameResult, publicResultView } from './results.js';
import { rankScores } from './roundFlow.js';
import { wireErrorToAppError } from './appError.js';
import { logger } from '../../observability/logger.js';

async function assertResultPermission(tx: Prisma.TransactionClient, roomId: string, actor: RoomActor) {
  const room = await tx.room.findUniqueOrThrow({ where: { id: roomId } });
  if (!actor.userId || !actor.sessionId || room.status === 'ARCHIVED') throw new CoreRuleError('FORBIDDEN');
  const session = await tx.session.findFirst({ where: { id: actor.sessionId, userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } } });
  const member = await tx.participation.findFirst({ where: { roomId, id: actor.participantId, connectionId: actor.connectionId ?? '', connected: true, admission: 'ACTIVE', kickedAt: null, bannedAt: null, leftAt: null } });
  if (!session || !member) throw new CoreRuleError('FORBIDDEN');
  const owner = room.hostUserId === actor.userId;
  const grants = owner || roomPolicy(room).coHostEnabled ? await tx.roomPermissionGrant.findMany({ where: { roomId, userId: actor.userId, revokedAt: null } }) : [];
  const permissions = effectivePermissions(owner ? 'HOST' : member.role === 'PLAYER' ? 'PLAYER' : 'VIEWER',
    grants.filter(g => g.direction === 'GRANT').map(g => g.permission as GamePermission), grants.filter(g => g.direction === 'REVOKE').map(g => g.permission as GamePermission));
  if (!permissions.has('SCORE_ADJUST')) throw new CoreRuleError('FORBIDDEN');
  return room;
}

/** A result revision, ledger event, live caches (when this run is current) and audit commit together. */
export async function mutateResult(roomId: string, actor: RoomActor, command: ResultCommand) {
  return prisma.$transaction(async tx => {
    await assertCommandMutation(tx, roomId);
    const room = await assertResultPermission(tx, roomId, actor);
    if (room.code !== command.roomCode) throw new CoreRuleError('WRONG_ROOM');
    const row = await tx.gameResultRecord.findUnique({ where: { roomId_runIndex: { roomId, runIndex: command.runIndex } }, include: { versions: { where: { revision: command.resultRevision } } } });
    if (!row) throw new CoreRuleError('RESULT_NOT_FOUND');
    if (row.revision !== command.resultRevision || !row.versions[0]) throw new CoreRuleError('REVISION_CONFLICT');
    const summary = StoredGameResultSchema.parse(JSON.parse(row.versions[0].dataJson));
    const ledger = await tx.scoreEvent.findMany({ where: { roomId, runIndex: command.runIndex } });
    const totals: Record<string, number> = {};
    for (const event of ledger) totals[event.participationId] = (totals[event.participationId] ?? 0) + event.delta;
    if (summary.result.participants.some(p => p.score !== (totals[p.participantId] ?? 0)) ||
      Object.keys(totals).some(id => !summary.result.participants.some(p => p.participantId === id))) throw new CoreRuleError('RESULT_REVIEW_REQUIRED');
    const operation = command.operation;
    let status = row.status, kind: string = operation.type, reason: string | null = null;
    if (operation.type === 'REVIEW') {
      if (row.status !== 'GAME_END') throw new CoreRuleError('INVALID_PHASE');
      status = 'RESULT_REVIEW';
    } else if (operation.type === 'FINALIZE') {
      if (row.status !== 'RESULT_REVIEW') throw new CoreRuleError('INVALID_PHASE');
      if (summary.integrity !== 'VERIFIED') throw new CoreRuleError('RESULT_REVIEW_REQUIRED');
      if (room.runIndex === command.runIndex) {
        const stateRow = await tx.roomGameState.findUnique({ where: { roomId } });
        const state = stateRow ? JSON.parse(stateRow.stateJson) as { phase: string; scores?: Record<string, number> } : null;
        if (room.status !== 'ENDED' || state?.phase !== 'GAME_END' || summary.result.participants.some(p => state.scores?.[p.participantId] !== p.score)) throw new CoreRuleError('RESULT_REVIEW_REQUIRED');
        const players = await tx.participation.findMany({ where: { roomId, id: { in: summary.result.participants.map(p => p.participantId) } } });
        if (summary.result.participants.some(p => players.find(player => player.id === p.participantId)?.score !== p.score)) throw new CoreRuleError('RESULT_REVIEW_REQUIRED');
      }
      if (room.runIndex === command.runIndex && summary.scoring === 'TEAM_SCORE') {
        const teams = await tx.roomTeam.findMany({ where: { roomId } });
        if (summary.teams.some(t => teams.find(team => team.id === t.id)?.score !== t.score)) throw new CoreRuleError('RESULT_REVIEW_REQUIRED');
      }
      status = 'FINALIZED';
    } else {
      if (row.status !== 'RESULT_REVIEW' && row.status !== 'FINALIZED') throw new CoreRuleError('INVALID_PHASE');
      if (row.status === 'FINALIZED' && operation.type === 'ADJUST' || row.status !== 'FINALIZED' && operation.type === 'AMEND') throw new CoreRuleError('RESULT_AMENDMENT_REQUIRED');
      if (summary.integrity !== 'VERIFIED') throw new CoreRuleError('RESULT_REVIEW_REQUIRED');
      reason = operation.reason;
      const reference = operation.referenceEventId ? await tx.scoreEvent.findFirst({ where: { id: operation.referenceEventId, roomId, runIndex: command.runIndex } }) : null;
      if (operation.referenceEventId && !reference) throw new CoreRuleError('SCORE_EVENT_NOT_FOUND');
      if (operation.type === 'ROLLBACK' && await tx.scoreEvent.findFirst({ where: { roomId, runIndex: command.runIndex, referenceEventId: reference!.id, kind: 'ROLLBACK' } })) throw new CoreRuleError('SCORE_EVENT_ALREADY_REVERSED');
      const participantId = operation.type === 'ROLLBACK' ? reference!.participationId : operation.participantId;
      if (reference && reference.participationId !== participantId) throw new CoreRuleError('SCORE_REFERENCE_MISMATCH');
      const target = summary.result.participants.find(p => p.participantId === participantId);
      if (!target) throw new CoreRuleError('PLAYER_NOT_IN_GAME');
      const delta = operation.type === 'ROLLBACK' ? -reference!.delta : operation.delta;
      if (!Number.isSafeInteger(target.score + delta)) throw new CoreRuleError('INVALID_SCORE');
      const teamId = reference ? reference.teamId : target.teamId;
      await tx.scoreEvent.create({ data: { roomId, runIndex: command.runIndex, participationId: participantId,
        teamId, delta, reason, source: 'manual', kind: operation.type === 'ROLLBACK' ? 'ROLLBACK' : row.status === 'FINALIZED' ? 'RESULT_AMENDMENT' : 'HOST_ADJUSTMENT',
        referenceEventId: reference?.id, roundIndex: reference?.roundIndex ?? 0, roundKey: reference?.roundKey, moderatorId: actor.userId } });
      summary.result.participants = rankScores(summary.result.participants.map(p => p.participantId === participantId ? { ...p, score: p.score + delta, delta: p.delta + delta } : p));
      summary.result.winnerIds = summary.result.aborted ? [] : summary.result.participants.filter(p => p.rank === 1).map(p => p.participantId);
      if (teamId) summary.teams = rankScores(summary.teams.map(t => t.id === teamId ? { ...t, score: t.score + delta } : t));
      summary.teamWinnerIds = summary.result.aborted ? [] : summary.teams.filter(t => t.rank === 1).map(t => t.id);
      // A historical amendment never touches a newer game's state or cached scores.
      if (room.runIndex === command.runIndex && room.status === 'ENDED') {
        const stateRow = await tx.roomGameState.findUniqueOrThrow({ where: { roomId } });
        const state = JSON.parse(stateRow.stateJson) as { phase: string; scores: Record<string, number> };
        if (state.phase !== 'GAME_END' || state.scores[participantId] !== target.score) throw new CoreRuleError('RESULT_REVIEW_REQUIRED');
        state.scores[participantId] = target.score + delta;
        await saveGameStateIfRevision(tx, { roomId, gameSlug: row.gameSlug, expectedRevision: stateRow.revision, state, phase: state.phase });
        await tx.participation.updateMany({ where: { roomId, id: participantId }, data: { score: target.score + delta } });
        if (teamId && summary.scoring === 'TEAM_SCORE') await tx.roomTeam.updateMany({ where: { roomId, id: teamId }, data: { score: { increment: delta } } });
      }
      kind = row.status === 'FINALIZED' ? 'RESULT_AMENDMENT' : operation.type;
    }
    const updated = await tx.gameResultRecord.updateMany({ where: { id: row.id, revision: command.resultRevision },
      data: { status, revision: { increment: 1 }, ...(status === 'FINALIZED' && !row.finalizedAt ? { finalizedAt: new Date() } : {}) } });
    if (updated.count !== 1) throw new CoreRuleError('REVISION_CONFLICT');
    await tx.gameResultVersion.create({ data: { resultId: row.id, revision: row.revision + 1, kind, reason, actorId: actor.participantId, dataJson: JSON.stringify(StoredGameResultSchema.parse(summary)) } });
    if (room.runIndex === command.runIndex && room.status === 'ENDED') await tx.room.update({ where: { id: roomId }, data: { runPhase: status, revision: { increment: 1 } } });
    await audit(tx, roomId, actor.userId, kind, { runIndex: command.runIndex, resultRevision: row.revision + 1, operation });
    await feed(tx, roomId, actor.participantId, kind, status === 'FINALIZED' ? 'Ergebnis verbindlich bestätigt bzw. mit Änderungsnachweis ergänzt.' : 'Ergebnisprüfung aktualisiert.');
    return { success: true, resultRevision: row.revision + 1, resultStatus: status };
  });
}

export function registerResultCommands(io: Server, socket: Socket) {
  socket.on('game:result:read', (raw: unknown, ack?: (response: Record<string, unknown>) => void) => {
    void (async () => {
      const parsed = ResultReadSchema.safeParse(raw);
      if (!parsed.success) { ack?.({ success: false, error: 'INVALID_PAYLOAD' }); return; }
      try {
        const { roomId } = await socketRoomActor(socket);
        const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
        if (room.code !== parsed.data.roomCode) throw new CoreRuleError('WRONG_ROOM');
        const read = await readGameResult(roomId, parsed.data.runIndex ?? room.runIndex, parsed.data.revision);
        if (!read) throw new CoreRuleError('RESULT_NOT_FOUND');
        ack?.({ success: true, data: publicResultView(room.code, read) });
      } catch (error) { ack?.({ success: false, error: error instanceof CoreRuleError ? error.code : 'RESULT_NOT_FOUND' }); }
    })();
  });

  socket.on('game:result:command', (raw: unknown, ack?: (response: Record<string, unknown>) => void) => {
    void (async () => {
      const parsed = ResultCommandSchema.safeParse(raw);
      if (!parsed.success) { ack?.({ success: false, error: 'INVALID_PAYLOAD' }); return; }
      try {
        const { roomId, actor } = await socketRoomActor(socket);
        if (!actor.permissions.has('SCORE_ADJUST')) throw new CoreRuleError('FORBIDDEN');
        const command = parsed.data;
        const response = await runReceipted(prisma, { roomId, commandId: command.commandId,
          actor: { actorId: actor.participantId, actorRole: socket.data.role }, action: 'RESULT_COMMAND', payload: { runIndex: command.runIndex, resultRevision: command.resultRevision, operation: command.operation },
          mutate: () => mutateResult(roomId, actor, command), toResponse: value => value });
        if (response.success) {
          ack?.({ ...response.data, ...(response.replayed ? { replayed: true } : {}) });
          if (!response.replayed) { io.to(roomChannel(roomId)).emit('game:result:changed'); io.to(roomChannel(roomId)).emit('game:core:changed'); changed(io, roomId); }
        } else ack?.(response);
      } catch (error) {
        const code = error instanceof CoreRuleError ? error.code : 'INTERNAL_ERROR';
        if (code === 'INTERNAL_ERROR') logger.error('Result command failed', { error });
        ack?.({ success: false, error: code, ...wireErrorToAppError(code) });
      }
    })();
  });
}
