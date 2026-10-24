import { EngineRoundResultSchema, EngineGameResultSchema, type EngineRoundResult, type EngineGameResult } from '@quiz/game-sdk';
import { rankScores } from './roundFlow.js';

/** Inputs are pinned run data/ledger, not UI-computed scores. Unknown durations stay null. */
export interface EngineResultContext {
  roomId: string; runIndex: number; gameSlug: string; engineVersion: number; roundIndex: number; roundCount: number;
  participants: Array<{ id: string; displayName: string; teamId: string | null }>;
  scores: Record<string, number>;
  scoreEvents: Array<{ participationId: string; delta: number; roundIndex: number }>;
  contentRefs: string[]; durationMs: number | null;
  gameEndReason: EngineGameResult['endReason']; roundEndReason: EngineRoundResult['endReason'];
}
function entries(context: EngineResultContext, roundOnly: boolean) {
  const events = context.scoreEvents.filter(event => !roundOnly || event.roundIndex === context.roundIndex);
  return rankScores(context.participants.map(player => {
    const delta = events.filter(event => event.participationId === player.id).reduce((sum, event) => sum + event.delta, 0);
    return { participantId: player.id, displayName: player.displayName, teamId: player.teamId, score: roundOnly ? delta : context.scores[player.id] ?? 0, delta };
  }));
}
function base(context: EngineResultContext, roundOnly: boolean) {
  const participants = entries(context, roundOnly);
  const aborted = roundOnly ? ['HOST_ABORTED', 'TECHNICAL_ABORT'].includes(context.roundEndReason)
    : ['HOST_ABORTED', 'TECHNICAL_ABORT', 'INSUFFICIENT_PLAYERS', 'ERROR_RECOVERY_FAILED'].includes(context.gameEndReason);
  const skipped = roundOnly && context.roundEndReason === 'HOST_SKIPPED';
  return { schemaVersion: 1 as const, roomId: context.roomId, runIndex: context.runIndex, gameSlug: context.gameSlug, engineVersion: context.engineVersion,
    participants, winnerIds: aborted || skipped ? [] : participants.filter(p => p.rank === 1).map(p => p.participantId), contentRefs: [...context.contentRefs], durationMs: context.durationMs,
    aborted, skipped };
}
export function buildEngineRoundResult(context: EngineResultContext): EngineRoundResult {
  return EngineRoundResultSchema.parse({ ...base(context, true), roundIndex: context.roundIndex, endReason: context.roundEndReason });
}
export function buildEngineGameResult(context: EngineResultContext): EngineGameResult {
  return EngineGameResultSchema.parse({ ...base(context, false), roundCount: context.roundCount, endReason: context.gameEndReason });
}
