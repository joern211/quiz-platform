import type { Server, Socket } from 'socket.io';
import { RecoveryCommandSchema, resolveCanonicalSlug } from '@quiz/shared';
import { applyStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { prisma } from '../../persistence/prisma.js';
import { socketRoomActor, changed } from '../../rooms/socket.js';
import { audit, feed } from '../../rooms/core.js';
import { roomChannel } from '../../sockets/channel.js';
import { assertCommandMutation } from './commandExecution.js';
import { runReceipted } from './commands.js';
import { CoreRuleError } from './runtimePrimitives.js';
import { assertGameInvariants } from './invariants.js';
import { ENGINE_VERSIONS } from './config.js';
import { saveGameStateIfRevision } from './state.js';
import { restoreActiveTimers } from '../geo/index.js';
import { logger } from '../../observability/logger.js';
import { wireErrorToAppError } from './appError.js';

/** Repair from committed evidence only. No scoring, new random choices or private client state. */
export function registerRecoveryCommands(io: Server, socket: Socket) {
  socket.on('game:recovery:command', (raw: unknown, ack?: (value: Record<string, unknown>) => void) => {
    void (async () => {
      const parsed = RecoveryCommandSchema.safeParse(raw);
      if (!parsed.success) { ack?.({ success: false, error: 'INVALID_PAYLOAD' }); return; }
      try {
        const { roomId, actor } = await socketRoomActor(socket), data = parsed.data;
        // Recovery ownership is intentionally restricted to the current authenticated room host.
        const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
        if (!actor.userId || actor.userId !== room.hostUserId || !actor.permissions.has('GAME_PAUSE')) throw new CoreRuleError('FORBIDDEN');
        if (room.code !== data.roomCode) throw new CoreRuleError('WRONG_ROOM');
        const response = await runReceipted(prisma, { roomId, commandId: data.commandId, actor: { actorId: actor.participantId, actorRole: socket.data.role }, action: 'RECOVERY_COMMAND', payload: data,
          mutate: () => prisma.$transaction(async tx => {
            await assertCommandMutation(tx, roomId);
            const live = await tx.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true, gameState: true } });
            const session = actor.sessionId ? await tx.session.findFirst({ where: { id: actor.sessionId, userId: actor.userId!, revokedAt: null, expiresAt: { gt: new Date() }, user: { disabledAt: null } } }) : null;
            const member = await tx.participation.findFirst({ where: { roomId, id: actor.participantId, connectionId: actor.connectionId ?? '', connected: true, admission: 'ACTIVE', kickedAt: null, bannedAt: null, leftAt: null } });
            if (!session || !member || live.hostUserId !== actor.userId) throw new CoreRuleError('FORBIDDEN');
            const revoked = await tx.roomPermissionGrant.findFirst({ where: { roomId, userId: actor.userId!, permission: 'GAME_PAUSE', direction: 'REVOKE', revokedAt: null } });
            if (revoked) throw new CoreRuleError('FORBIDDEN');
            const row = live.gameState, slug = resolveCanonicalSlug(live.gameDefinition.slug) ?? live.gameDefinition.slug;
            if (live.status !== 'RUNNING' || row?.phase !== 'ERROR_RECOVERY') throw new CoreRuleError('INVALID_PHASE');
            if (live.runIndex !== data.runIndex || row.revision !== data.gameStateVersion) throw new CoreRuleError('STATE_CONFLICT');
            if (!ENGINE_VERSIONS[slug]?.supported.includes(row.engineVersion)) throw new CoreRuleError('UNSUPPORTED_ENGINE_VERSION');
            const events = await tx.gameDomainEvent.findMany({ where: { roomId, runIndex: data.runIndex }, orderBy: { stateVersion: 'asc' } });
            let checkpoint = -1;
            for (let index = 0; index < events.length; index++) if (JSON.parse(events[index].payloadJson).checkpoint === true) checkpoint = index;
            if (checkpoint < 0) throw new CoreRuleError('RECOVERY_EVIDENCE_MISSING');
            let replay: EngineStateSnapshot = { roomId, runIndex: data.runIndex, gameSlug: slug, engineVersion: row.engineVersion, stateVersion: events[checkpoint].baseStateVersion, state: {} };
            for (const event of events.slice(checkpoint)) replay = applyStateEvent(replay, JSON.parse(event.payloadJson));
            // A valid older tail can still omit a committed admission or rename.
            // Restore only evidence that reaches the exact pre-freeze revision.
            const frozen = JSON.parse(row.stateJson);
            const expectedVersion = frozen.recoveryBaseStateVersion ?? row.revision - 1;
            if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== row.revision - 1 || replay.stateVersion !== expectedVersion || replay.state.phase === 'ERROR_RECOVERY' || replay.state.phase === 'GAME_END') throw new CoreRuleError('RECOVERY_EVIDENCE_INVALID');
            assertGameInvariants(slug, replay.state, String(replay.state.phase));
            const ledger = await tx.scoreEvent.findMany({ where: { roomId, runIndex: data.runIndex } });
            const totals: Record<string, number> = {};
            for (const e of ledger) totals[e.participationId] = (totals[e.participationId] ?? 0) + e.delta;
            const scores = replay.state.scores as Record<string, number>;
            if (Object.entries(scores).some(([id, value]) => value !== (totals[id] ?? 0)) || Object.keys(totals).some(id => !Object.hasOwn(scores, id))) throw new CoreRuleError('RECOVERY_LEDGER_MISMATCH');
            await saveGameStateIfRevision(tx, { roomId, gameSlug: slug, expectedRevision: row.revision, phase: String(replay.state.phase), state: replay.state });
            const runPhase = slug === 'wissensduell' && replay.state.phase === 'INPUT_OPEN' ? 'ROUND_ACTIVE' : String(replay.state.phase);
            const updated = await tx.room.updateMany({ where: { id: roomId, revision: live.revision }, data: { runPhase, revision: { increment: 1 } } });
            if (updated.count !== 1) throw new CoreRuleError('STATE_CONFLICT');
            await audit(tx, roomId, actor.userId, 'RECOVERY_RESTORED', { runIndex: data.runIndex, evidenceStateVersion: replay.stateVersion, repairedStateVersion: row.revision + 1 });
            await feed(tx, roomId, actor.participantId, 'RECOVERY_RESTORED', 'Spiel aus dem letzten geprüften Zustand wiederhergestellt.');
            return { success: true, gameStateVersion: row.revision + 1 };
          }), toResponse: value => value });
        if (response.success) {
          ack?.({ ...response.data, ...(response.replayed ? { replayed: true } : {}) });
          if (!response.replayed) {
            io.to(roomChannel(roomId)).emit('game:core:changed'); changed(io, roomId);
            // Keep timer restoration outside the command's ownership context.
            setImmediate(() => { void restoreActiveTimers(io).catch(error => logger.error('Recovered timer restoration failed', { roomId, error })); });
          }
        } else ack?.(response);
      } catch (error) {
        const code = error instanceof CoreRuleError ? error.code : 'RECOVERY_EVIDENCE_INVALID';
        ack?.({ success: false, error: code, ...wireErrorToAppError(code, { internalDetail: error instanceof CoreRuleError ? undefined : error, context: { action: 'recovery:command' } }) });
      }
    })();
  });
}
