import { createBuzzerState, type BuzzerState } from '../core/buzzer.js';
import { ensureScoreEntries } from '../core/score.js';
import { WerIstDasPhase } from './contracts.js';

export interface WerIstDasState {
  phase: WerIstDasPhase;
  roundIndex: number;
  roundCount: number;
  scores: Record<string, number>;
  playerNames: Record<string, string>;
  buzzer: BuzzerState;
  hintActive: boolean;
  playedRoundIds: string[];
}

export function createWerIstDasState(
  roundCount: number,
  playerNames: Record<string, string>,
  initialScores: Record<string, number> = {},
): WerIstDasState {
  if (!Number.isInteger(roundCount) || roundCount < 1) throw new Error('INVALID_SETUP');
  return {
    phase: WerIstDasPhase.ROUND_READY,
    roundIndex: 0,
    roundCount,
    scores: ensureScoreEntries(initialScores, Object.keys(playerNames)),
    playerNames,
    buzzer: createBuzzerState(),
    hintActive: false,
    playedRoundIds: [],
  };
}
