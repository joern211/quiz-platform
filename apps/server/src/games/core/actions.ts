import type { Socket } from 'socket.io';
import { z } from 'zod';
import { CoreRuntimeProjectionSchema, resolveCanonicalSlug, type CoreRuntimeProjection } from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import { socketRoomActor } from '../../rooms/socket.js';
import { CoreRuleError, legacyRoundTimer } from './runtimePrimitives.js';
import { ensureGameStateSafe } from './recovery.js';
import { roomChannel } from '../../sockets/channel.js';
import { getGameEngineContract } from './engineContract.js';

import { availableCoreActions, geoState, jeopardyState, widState, type CoreActionContext } from './actionRules.js';
import { isBuzzerController } from './controllers.js';
export { availableCoreActions, coreActionDenial, type CoreActionContext } from './actionRules.js';

async function loadContext(socket: Socket) {
  const { roomId, actor } = await socketRoomActor(socket);
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true, gameState: true, participations: { where: { id: actor.participantId } } } });
  const self = room.participations[0];
  let state: unknown = null;
  try { if (room.gameState) state = JSON.parse(room.gameState.stateJson); }
  catch { /* The invariant gate freezes malformed JSON before a mutation or projection. */ }
  const informationRole: CoreActionContext['informationRole'] = self?.role === 'HOST' && actor.userId === room.hostUserId ? 'HOST' : self?.role === 'PLAYER' ? 'PLAYER' : 'VIEWER';
  const buzzerController = await isBuzzerController(room, actor.userId);
  const context: CoreActionContext = { gameSlug: room.gameDefinition.slug, roomStatus: room.status, state,
    informationRole, participantId: self?.id ?? null, active: !!self && self.admission === 'ACTIVE' && !self.leftAt && !self.kickedAt && !self.bannedAt,
    permissions: actor.permissions, now: Date.now(), buzzerController };
  return { context, room };
}
export async function assertCoreActionAllowed(socket: Socket, key: string, expectedSlug?: string, payload?: unknown): Promise<void> {
  const { context, room } = await loadContext(socket);
  if (expectedSlug && resolveCanonicalSlug(expectedSlug) !== resolveCanonicalSlug(context.gameSlug)) throw new CoreRuleError('WRONG_GAME');
  if (key !== 'end') await ensureGameStateSafe(room.id);
  if (!['wissensduell', 'jeopardy', 'wer-ist-das'].includes(resolveCanonicalSlug(context.gameSlug) ?? context.gameSlug)) return;
  const result = getGameEngineContract(context.gameSlug)!.validateCommand(context, { action: key, payload: payload ?? {} });
  if (!result.success) throw new CoreRuleError(result.error);
}
export async function projectCoreRuntime(socket: Socket): Promise<CoreRuntimeProjection> {
  let loaded = await loadContext(socket);
  try { await ensureGameStateSafe(loaded.room.id); }
  catch (error) {
    if (!(error instanceof CoreRuleError) || error.code !== 'STATE_INVARIANT_FAILED') throw error;
    loaded = await loadContext(socket);
    socket.nsp.to(roomChannel(loaded.room.id)).emit('game:core:changed');
  }
  const { context, room } = loaded;
  if (!room.gameState) throw new CoreRuleError('GAME_NOT_FOUND');
  const slug = resolveCanonicalSlug(context.gameSlug) ?? context.gameSlug;
  if (room.gameState.phase === 'ERROR_RECOVERY') return CoreRuntimeProjectionSchema.parse({
    roomCode: room.code, runIndex: room.runIndex, gameSlug: slug, engineVersion: room.gameState.engineVersion,
    stateVersion: room.gameState.revision, enginePhase: 'ERROR_RECOVERY', corePhase: 'ERROR_RECOVERY', recoveryRequired: true,
    informationRole: context.informationRole, timer: null,
    progress: { currentRound: 0, totalRounds: null, remainingRounds: null, progressPercent: null },
    availableActions: [],
  });
  let currentRound = 0, totalRounds: number | null = null, completed = 0, timer = null;
  if (slug === 'wissensduell') {
    const state = geoState.parse(context.state), round = state.roundStates[state.currentRoundIndex];
    totalRounds = state.questions.length; currentRound = Math.min(totalRounds, state.currentRoundIndex + 1);
    completed = state.phase === 'GAME_END' ? totalRounds : Math.min(totalRounds, state.currentRoundIndex + (round?.revealed ? 1 : 0));
    if (round && ['INPUT_OPEN', 'PAUSED', 'INPUT_LOCKED'].includes(state.phase)) timer = legacyRoundTimer(round, state.phase);
  } else if (slug === 'jeopardy') {
    const state = jeopardyState.parse(context.state);
    const setup = z.object({ board1: z.object({ categories: z.array(z.object({ clues: z.array(z.unknown()) })) }), board2: z.object({ categories: z.array(z.object({ clues: z.array(z.unknown()) })) }).optional() }).parse(JSON.parse(room.setupSnapshotJson));
    totalRounds = [setup.board1, ...(state.boardCount === 1 ? [] : [setup.board2])].reduce((sum, board) => sum + (board?.categories.reduce((n, category) => n + category.clues.length, 0) ?? 0), 0);
    completed = state.phase === 'GAME_END' ? totalRounds : Math.max(0, totalRounds - Object.keys(state.openFields).length);
    currentRound = Math.min(totalRounds, completed + 1);
    if (state.timer) timer = state.timer;
  } else if (slug === 'wer-ist-das') {
    const state = widState.parse(context.state);
    totalRounds = state.roundCount; completed = state.phase === 'GAME_END' ? totalRounds : state.roundIndex + (state.revealed ? 1 : 0);
    currentRound = Math.min(totalRounds, state.roundIndex + 1);
  } else throw new CoreRuleError('COMMAND_UNSUPPORTED');
  return CoreRuntimeProjectionSchema.parse({ roomCode: room.code, runIndex: room.runIndex, gameSlug: slug, engineVersion: room.gameState.engineVersion, stateVersion: room.gameState.revision,
    enginePhase: z.object({ phase: z.string() }).parse(context.state).phase, corePhase: room.status === 'ENDED' && ['RESULT_REVIEW', 'FINALIZED'].includes(room.runPhase) ? room.runPhase : getGameEngineContract(slug)!.getLifecyclePhase(context.state), informationRole: context.informationRole, timer,
    progress: { currentRound, totalRounds, remainingRounds: totalRounds === null ? null : totalRounds - completed, progressPercent: totalRounds ? 100 * completed / totalRounds : null },
    availableActions: availableCoreActions(context) });
}
