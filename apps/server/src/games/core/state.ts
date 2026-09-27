// ============================================================
// Shared Game State Persistence
// Central helpers for RoomGameState with optimistic concurrency.
// ============================================================

import type { Prisma, RoomGameState } from '@prisma/client';
import { prisma } from '../../persistence/prisma.js';

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
}): Promise<void> {
  const { roomId, state, phase, engineVersion = 1 } = params;
  const stateJson = JSON.stringify(state);

  await prisma.roomGameState.upsert({
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
  }
): Promise<void> {
  const { roomId, expectedRevision, state, phase } = params;

  const result = await tx.roomGameState.updateMany({
    where: { roomId, revision: expectedRevision },
    data: {
      stateJson: JSON.stringify(state),
      phase,
      revision: { increment: 1 },
    },
  });

  if (result.count !== 1) {
    throw new GameStateConflictError(roomId);
  }
}
