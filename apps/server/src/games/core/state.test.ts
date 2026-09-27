import { describe, expect, it, vi } from 'vitest';
import type { Prisma, RoomGameState } from '@prisma/client';
import { GameStateConflictError, parseGameState, saveGameStateIfRevision } from './state.js';

describe('shared game state persistence', () => {
  it('parses persisted state with revision metadata', () => {
    const row = {
      id: 'state-1',
      roomId: 'room-1',
      engineVersion: 2,
      phase: 'ROUND_ACTIVE',
      stateJson: JSON.stringify({ score: 7 }),
      revision: 4,
      updatedAt: new Date(),
    } satisfies RoomGameState;

    expect(parseGameState<{ score: number }>(row)).toEqual({
      state: { score: 7 },
      revision: 4,
      phase: 'ROUND_ACTIVE',
      engineVersion: 2,
    });
  });

  it('saves only the expected revision', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = { roomGameState: { updateMany } } as unknown as Prisma.TransactionClient;

    await saveGameStateIfRevision(tx, {
      roomId: 'room-1',
      expectedRevision: 5,
      phase: 'BUZZ_OPEN',
      state: { phase: 'BUZZ_OPEN' },
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { roomId: 'room-1', revision: 5 },
      data: {
        stateJson: JSON.stringify({ phase: 'BUZZ_OPEN' }),
        phase: 'BUZZ_OPEN',
        revision: { increment: 1 },
      },
    });
  });

  it('raises STATE_CONFLICT when the revision changed', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = { roomGameState: { updateMany } } as unknown as Prisma.TransactionClient;

    await expect(
      saveGameStateIfRevision(tx, {
        roomId: 'room-1',
        expectedRevision: 2,
        phase: 'SELECTING',
        state: { phase: 'SELECTING' },
      })
    ).rejects.toBeInstanceOf(GameStateConflictError);
  });
});
