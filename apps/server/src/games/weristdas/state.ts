import { claimBuzzer, createBuzzerState, openBuzzer, resetBuzzerState, type BuzzerState } from '../core/buzzer.js';
import { applyScoreDelta, ensureScoreEntries } from '../core/score.js';
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
  solvedBy: string | null;
  lastDelta: number | null;
  revealed: boolean;
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
    solvedBy: null,
    lastDelta: null,
    revealed: false,
  };
}

export class InvalidGameAction extends Error {
  constructor(readonly code: string) { super(code); }
}

function requirePhase(state: WerIstDasState, ...phases: WerIstDasPhase[]) {
  if (!phases.includes(state.phase)) throw new InvalidGameAction('INVALID_PHASE');
}

export function openRoundBuzzer(state: WerIstDasState): WerIstDasState {
  requirePhase(state, WerIstDasPhase.ROUND_READY);
  if (Object.keys(state.playerNames).every(id => state.buzzer.excludedPlayerIds.includes(id))) {
    throw new InvalidGameAction('NO_ELIGIBLE_PLAYERS');
  }
  return { ...state, phase: WerIstDasPhase.BUZZ_OPEN,
    buzzer: openBuzzer(state.buzzer, { excludePlayerIds: state.buzzer.excludedPlayerIds }) };
}

export function buzz(state: WerIstDasState, playerId: string): WerIstDasState {
  requirePhase(state, WerIstDasPhase.BUZZ_OPEN);
  if (!(playerId in state.playerNames)) throw new InvalidGameAction('PLAYER_NOT_IN_GAME');
  const result = claimBuzzer(state.buzzer, playerId);
  if (!result.accepted) throw new InvalidGameAction(result.error);
  return { ...state, phase: WerIstDasPhase.ANSWERING, buzzer: result.state };
}

export function activateHint(state: WerIstDasState): WerIstDasState {
  requirePhase(state, WerIstDasPhase.ROUND_READY, WerIstDasPhase.BUZZ_OPEN, WerIstDasPhase.ANSWERING);
  if (state.hintActive) throw new InvalidGameAction('INVALID_PHASE');
  return { ...state, hintActive: true };
}

export function judge(state: WerIstDasState, result: 'BOTH_CORRECT' | 'ONE_CORRECT' | 'WRONG'):
  { state: WerIstDasState; delta: number; playerId: string } {
  requirePhase(state, WerIstDasPhase.ANSWERING);
  const playerId = state.buzzer.winnerId;
  if (!playerId) throw new InvalidGameAction('BUZZ_CLOSED');
  if (result === 'ONE_CORRECT' && !state.hintActive) throw new InvalidGameAction('HINT_REQUIRED');
  const delta = result === 'WRONG' ? -1 : result === 'BOTH_CORRECT' ? 3 : 1;
  const next = { ...state, scores: applyScoreDelta(state.scores, playerId, delta), lastDelta: delta };
  if (result !== 'WRONG') return {
    state: { ...next, phase: WerIstDasPhase.REVEAL, revealed: true, solvedBy: playerId,
      buzzer: { ...next.buzzer, open: false } }, delta, playerId,
  };
  return { state: { ...next, phase: WerIstDasPhase.ROUND_READY,
    buzzer: { open: false, winnerId: null,
      excludedPlayerIds: [...new Set([...state.buzzer.excludedPlayerIds, playerId])] } }, delta, playerId };
}

export function revealRound(state: WerIstDasState): WerIstDasState {
  requirePhase(state, WerIstDasPhase.ROUND_READY, WerIstDasPhase.BUZZ_OPEN);
  return { ...state, phase: WerIstDasPhase.REVEAL, revealed: true,
    buzzer: { ...state.buzzer, open: false, winnerId: null } };
}

export function nextRound(state: WerIstDasState, currentRoundId: string): WerIstDasState {
  requirePhase(state, WerIstDasPhase.REVEAL);
  if (state.roundIndex + 1 >= state.roundCount) throw new InvalidGameAction('LAST_ROUND');
  return { ...state, roundIndex: state.roundIndex + 1, phase: WerIstDasPhase.ROUND_READY,
    playedRoundIds: [...state.playedRoundIds, currentRoundId],
    buzzer: resetBuzzerState(), hintActive: false, solvedBy: null, lastDelta: null, revealed: false };
}
