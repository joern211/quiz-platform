// ============================================================
// Shared Score Primitives
// Games own scoring rules; the core owns score mutation mechanics.
// ============================================================

export type ScoreMap = Record<string, number>;

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
