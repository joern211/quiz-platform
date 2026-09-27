// ============================================================
// Shared Score Primitives
// Games own scoring rules; the core owns score mutation mechanics.
// ============================================================

import type { Prisma } from '@prisma/client';

export type ScoreMap = Record<string, number>;

/** Keep the displayed participation score and audit trail in the same transaction as game state. */
export async function recordScoreMutation(
  tx: Prisma.TransactionClient,
  params: {
    roomId: string;
    participationId: string;
    score: number;
    delta: number;
    reason: string;
    roundIndex?: number;
  }
): Promise<void> {
  const updated = await tx.participation.updateMany({
    where: { id: params.participationId, roomId: params.roomId, role: 'PLAYER' },
    data: { score: params.score },
  });
  if (updated.count !== 1) throw new Error('PLAYER_NOT_IN_ROOM');
  await tx.scoreEvent.create({
    data: {
      roomId: params.roomId, participationId: params.participationId,
      roundIndex: params.roundIndex ?? 0, delta: params.delta,
      reason: params.reason, source: 'auto',
    },
  });
}

export function applyScoreDelta(
  scores: ScoreMap,
  participationId: string,
  delta: number
): ScoreMap {
  return {
    ...scores,
    [participationId]: (scores[participationId] ?? 0) + delta,
  };
}

export function ensureScoreEntries(scores: ScoreMap, participationIds: string[]): ScoreMap {
  const next = { ...scores };
  for (const participationId of participationIds) {
    if (next[participationId] === undefined) next[participationId] = 0;
  }
  return next;
}
