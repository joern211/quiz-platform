import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { resolveCanonicalSlug, type CoreBuzzer } from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import { audit, feed } from '../../rooms/core.js';
import { socketRoomActor } from '../../rooms/socket.js';
import { roomChannel } from '../../sockets/channel.js';
import { fieldKey, type JeopardyGameState } from '../jeopardy/state.js';
import type { WerIstDasState } from '../weristdas/state.js';
import { overrideBuzzerWinner } from './buzzer.js';
import { isBuzzerController } from './controllers.js';
import { CoreRuleError, createTimer, judgeSubmission, submitOnce } from './runtimePrimitives.js';
import { createTurn } from './roundFlow.js';
import { saveGameStateIfRevision } from './state.js';
import { runGuardedCriticalAction } from './receiptedAction.js';
import { gameErrorCode } from './errors.js';

export const BuzzerOverridePayloadSchema = z.object({ participantId: z.string().min(1).max(128), gameStateVersion: z.number().int().positive(), runIndex: z.number().int().positive(), reason: z.string().trim().max(500).optional() }).passthrough();
const wireSchema = BuzzerOverridePayloadSchema.extend({ commandId: z.string().min(1).max(128), requestId: z.string().min(1).max(128).optional(),
  protocolVersion: z.number().int().optional(), stateVersion: z.number().int().optional(), expectedRevision: z.number().int().optional() });

/** Only pending verbal answers can be reassigned; judged points require a correction event. */
export async function handleBuzzerOverride(io: Server, socket: Socket, input: unknown) {
  const payload = BuzzerOverridePayloadSchema.parse(input);
  const { roomId, actor } = await socketRoomActor(socket);
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true } });
  const slug = resolveCanonicalSlug(room.gameDefinition.slug);
  if (!actor.permissions.has('BUZZER_CONTROL') || !await isBuzzerController(room, actor.userId)) throw new CoreRuleError('FORBIDDEN');
  if (room.status !== 'RUNNING') throw new CoreRuleError('GAME_NOT_RUNNING');
  if (slug !== 'jeopardy' && slug !== 'wer-ist-das') throw new CoreRuleError('COMMAND_UNSUPPORTED');
  await prisma.$transaction(async tx => {
    const currentRoom = await tx.room.findUniqueOrThrow({ where: { id: roomId }, select: { runIndex: true, status: true } });
    if (currentRoom.status !== 'RUNNING' || currentRoom.runIndex !== payload.runIndex) throw new CoreRuleError('STATE_CONFLICT');
    const row = await tx.roomGameState.findUniqueOrThrow({ where: { roomId } });
    if (row.revision !== payload.gameStateVersion) throw new CoreRuleError('STATE_CONFLICT');
    const state = JSON.parse(row.stateJson) as JeopardyGameState | WerIstDasState;
    const target = await tx.participation.findFirst({ where: { id: payload.participantId, roomId, role: 'PLAYER', admission: 'ACTIVE',
      kickedAt: null, bannedAt: null, leftAt: null, connected: true } });
    if (!target || !Object.hasOwn(state.scores, target.id)) throw new CoreRuleError('PLAYER_NOT_IN_GAME');
    const now = Date.now();
    let before: CoreBuzzer;
    if (slug === 'jeopardy') {
      const jp = state as JeopardyGameState, steal = jp.phase === 'STEAL_LOCKED';
      if (!['BUZZ_LOCKED', 'STEAL_LOCKED'].includes(jp.phase) || !jp.currentField) throw new CoreRuleError('INVALID_PHASE');
      const winnerId = steal ? jp.stealWinner : jp.buzzWinner;
      before = (steal ? jp.stealBuzzer : jp.buzzer) ?? { open: false, winnerId, excludedPlayerIds: steal && jp.currentField.firstResponderId ? [jp.currentField.firstResponderId] : [] };
      const next = overrideBuzzerWinner(before, target.id, { actorId: actor.participantId, reason: payload.reason, atMs: now });
      if (next === before) return;
      const key = (id: string) => `${fieldKey(jp.currentBoard, jp.currentField!.categoryIndex, jp.currentField!.value)}:${steal ? 'steal' : 'first'}:${id}`;
      jp.submissions ??= {};
      const previous = winnerId ? jp.submissions[key(winnerId)] : undefined;
      if (previous) jp.submissions[key(winnerId!)] = judgeSubmission(previous, 'CANCELLED', now);
      const oldTarget = jp.submissions[key(target.id)];
      if (oldTarget && oldTarget.decision !== 'CANCELLED') throw new CoreRuleError('ALREADY_ANSWERED');
      jp.timer ??= createTimer('UNLIMITED', now);
      jp.submissions[key(target.id)] = submitOnce({ participantId: target.id, roundId: key(target.id), value: null, timer: jp.timer, now });
      jp.submissions[key(target.id)].matchStatus = 'NEEDS_JUDGE';
      if (steal) { jp.stealBuzzer = next; jp.stealWinner = target.id; }
      else { jp.buzzer = next; jp.buzzWinner = target.id; }
    } else {
      const wid = state as WerIstDasState;
      if (wid.phase !== 'ANSWERING') throw new CoreRuleError('INVALID_PHASE');
      before = wid.buzzer;
      const next = overrideBuzzerWinner(before, target.id, { actorId: actor.participantId, reason: payload.reason, atMs: now });
      if (next === before) return;
      wid.buzzer = next;
    }
    state.answerTurn = createTurn([target.id]);
    await saveGameStateIfRevision(tx, { roomId, gameSlug: slug, expectedRevision: row.revision, state, phase: state.phase });
    const metadata = { fromParticipantId: before.winnerId, toParticipantId: target.id, reason: payload.reason ?? null, stateVersion: row.revision + 1 };
    await audit(tx, roomId, actor.userId, 'BUZZER_WINNER_OVERRIDDEN', metadata);
    await feed(tx, roomId, actor.participantId, 'BUZZER_OVERRIDE', `Buzzer-Gewinner auf ${target.displayName} korrigiert.`);
  });
  // Clients resync their own role projection; no private snapshot is broadcast.
  io.to(roomChannel(roomId)).emit('game:core:changed');
  return { success: true };
}

export function registerBuzzerOverride(io: Server, socket: Socket) {
  socket.on('game:buzzer:override', (data: unknown, callback?: (result: { success: boolean; error?: string }) => void) => {
    void (async () => {
      const parsed = wireSchema.safeParse(data);
      if (!parsed.success) { callback?.({ success: false, error: 'INVALID_PAYLOAD' }); return; }
      try {
        const { roomId } = await socketRoomActor(socket);
        const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true } });
        await runGuardedCriticalAction({ io, socket, gameSlug: room.gameDefinition.slug, action: 'buzzerOverride', permission: 'BUZZER_CONTROL',
          payload: parsed.data, handler: async () => {
            const { getGameEngineContract } = await import('./engineContract.js');
            return getGameEngineContract(room.gameDefinition.slug)!.handleCommand({ io, socket }, { action: 'buzzerOverride', payload: parsed.data });
          } }, callback);
      } catch (error) { callback?.({ success: false, error: gameErrorCode(error) }); }
    })();
  });
}
