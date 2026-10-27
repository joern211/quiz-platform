import { randomUUID } from 'node:crypto';
import type { Prisma, RoomGameState } from '@prisma/client';
import { createStateEvent, applyStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { resolveCanonicalSlug } from '@quiz/shared';
import { currentCommandMetadata } from './commandExecution.js';
import { assertGameInvariants } from './invariants.js';
import { CoreRuleError } from './runtimePrimitives.js';

/** Event creation and state materialization always share the caller's transaction. */
export async function materializeGameEvent(tx: Prisma.TransactionClient, params: {
  roomId: string; gameSlug: string; engineVersion: number; before: RoomGameState | null; nextState: unknown; type?: string;
}): Promise<string> {
  const room = await tx.room.findUniqueOrThrow({ where: { id: params.roomId }, select: { runIndex: true } });
  if (params.before && params.before.engineVersion !== params.engineVersion) throw new CoreRuleError('UNSUPPORTED_ENGINE_VERSION');
  const snapshot: EngineStateSnapshot = { roomId: params.roomId, runIndex: room.runIndex,
    gameSlug: resolveCanonicalSlug(params.gameSlug) ?? params.gameSlug, engineVersion: params.engineVersion,
    stateVersion: params.before?.revision ?? 0, state: params.before ? JSON.parse(params.before.stateJson) : {} };
  const command = currentCommandMetadata();
  const last = await tx.gameDomainEvent.findFirst({ where: { roomId: params.roomId, runIndex: room.runIndex }, orderBy: { stateVersion: 'desc' } });
  if (last && last.stateVersion > snapshot.stateVersion) throw new CoreRuleError('STATE_CONFLICT');
  const event = createStateEvent(snapshot, params.nextState, { eventId: randomUUID(), type: params.type ?? command.action ?? 'ENGINE_TRANSITION',
    commandId: command.commandId, actorId: command.actorId, occurredAtMs: Date.now(),
    // Legacy states and explicit recovery gaps get an honest complete checkpoint.
    checkpoint: !last || last.stateVersion !== snapshot.stateVersion });
  const next = applyStateEvent(snapshot, event);
  if (typeof next.state.phase !== 'string') throw new CoreRuleError('INVALID_GAME_STATE');
  assertGameInvariants(snapshot.gameSlug, next.state, next.state.phase);
  await tx.gameDomainEvent.create({ data: { id: event.eventId, roomId: event.roomId, runIndex: event.runIndex,
    gameSlug: event.gameSlug, engineVersion: event.engineVersion, baseStateVersion: event.baseStateVersion,
    stateVersion: event.stateVersion, type: event.type, commandId: event.commandId, actorId: event.actorId,
    payloadJson: JSON.stringify(event), occurredAt: new Date(event.occurredAtMs) } });
  return JSON.stringify(next.state);
}
