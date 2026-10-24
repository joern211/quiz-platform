// ============================================================
// Shared Game State Persistence
// Central helpers for RoomGameState with optimistic concurrency.
// ============================================================

import type { Prisma, RoomGameState } from '@prisma/client';
import { prisma } from '../../persistence/prisma.js';
import { assertCommandMutation } from './commandExecution.js';
import { assertGameInvariants } from './invariants.js';
import { materializeGameEvent } from './events.js';

export class GameStateConflictError extends Error {
  readonly code = 'STATE_CONFLICT';

  constructor(roomId: string) {
    super(`Game state revision conflict for room ${roomId}`);
    this.name = 'GameStateConflictError';
  }
}

export interface LoadedGameState<TState> {
  state: TState;
  revision: number;
  phase: string;
  engineVersion: number;
}

export function parseGameState<TState>(row: RoomGameState): LoadedGameState<TState> {
  return {
    state: JSON.parse(row.stateJson) as TState,
    revision: row.revision,
    phase: row.phase,
    engineVersion: row.engineVersion,
  };
}

export async function loadGameState<TState>(roomId: string): Promise<LoadedGameState<TState> | null> {
  const row = await prisma.roomGameState.findUnique({ where: { roomId } });
  return row ? parseGameState<TState>(row) : null;
}

export async function upsertGameState<TState>(params: {
  roomId: string;
  state: TState;
  phase: string;
  engineVersion?: number;
  gameSlug?: string;
}): Promise<void> {
  const { roomId, state, phase, engineVersion = 1 } = params;
  if (params.gameSlug) assertGameInvariants(params.gameSlug, state, phase);

  await prisma.$transaction(async (tx) => {
    await assertCommandMutation(tx, roomId);
    const before = params.gameSlug ? await tx.roomGameState.findUnique({ where: { roomId } }) : null;
    const stateJson = params.gameSlug ? await materializeGameEvent(tx, { roomId, gameSlug: params.gameSlug,
      engineVersion, before, nextState: state, type: before ? undefined : 'GAME_INITIALIZED' }) : JSON.stringify(state);
    await tx.roomGameState.upsert({
      where: { roomId },
      create: {
        roomId,
        engineVersion,
        phase,
        stateJson,
        revision: 1,
      },
      update: {
        engineVersion,
        phase,
        stateJson,
        revision: { increment: 1 },
      },
    });
  });
}

/**
 * Persist a state only if the caller still owns the expected revision.
 * This is the shared CAS primitive for race-sensitive game actions.
 */
export async function saveGameStateIfRevision<TState>(
  tx: Prisma.TransactionClient,
  params: {
    roomId: string;
    expectedRevision: number;
    state: TState;
    phase: string;
    gameSlug?: string;
  }
): Promise<void> {
  const { roomId, expectedRevision, state, phase } = params;

  await assertCommandMutation(tx, roomId);
  if (params.gameSlug) assertGameInvariants(params.gameSlug, state, phase);
  let stateJson = JSON.stringify(state);
  if (params.gameSlug) {
    const before = await tx.roomGameState.findUnique({ where: { roomId } });
    if (!before || before.revision !== expectedRevision) throw new GameStateConflictError(roomId);
    stateJson = await materializeGameEvent(tx, { roomId, gameSlug: params.gameSlug, engineVersion: before.engineVersion, before, nextState: state });
  }

  const result = await tx.roomGameState.updateMany({
    where: { roomId, revision: expectedRevision },
    data: {
      stateJson,
      phase,
      revision: { increment: 1 },
    },
  });

  if (result.count !== 1) {
    throw new GameStateConflictError(roomId);
  }
}

/** End a running room and its engine state in one optimistic transaction. */
export async function finishRunningGame<TState extends { phase: string }>(params: {
  roomId: string;
  expectedRevision?: number;
  requiredPhase?: string;
  nextState?: (state: TState) => TState;
  gameSlug?: string;
}): Promise<{ ended: boolean; state: TState }> {
  return prisma.$transaction(async (tx) => {
    const room = await tx.room.findUniqueOrThrow({ where: { id: params.roomId } });
    const row = await tx.roomGameState.findUnique({ where: { roomId: params.roomId } });
    if (!row) throw new Error('GAME_NOT_FOUND');
    const state = JSON.parse(row.stateJson) as TState;
    if (room.status === 'ENDED' && row.phase === 'GAME_END' && state.phase === 'GAME_END') {
      return { ended: false, state };
    }
    if (room.status !== 'RUNNING') throw new GameStateConflictError(params.roomId);
    if (params.expectedRevision !== undefined && row.revision !== params.expectedRevision) {
      throw new GameStateConflictError(params.roomId);
    }
    if (params.requiredPhase && state.phase !== params.requiredPhase) {
      throw new GameStateConflictError(params.roomId);
    }
    const endedState = { ...(params.nextState?.(state) ?? state), phase: 'GAME_END' } as TState;
    await saveGameStateIfRevision(tx, {
      roomId: params.roomId, expectedRevision: row.revision, state: endedState, phase: 'GAME_END',
      gameSlug: params.gameSlug,
    });
    const updated = await tx.room.updateMany({
      where: { id: params.roomId, status: 'RUNNING', revision: room.revision },
      data: { status: 'ENDED', runPhase: 'RESULTS', endedAt: new Date(), revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new GameStateConflictError(params.roomId);
    return { ended: true, state: endedState };
  });
}
