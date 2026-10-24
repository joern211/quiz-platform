import { randomInt } from 'node:crypto';
import { CoreTurnSchema, type CoreTurn } from '@quiz/shared';
import { CoreRuleError } from './runtimePrimitives.js';

/** Unbiased server randomness. Persist the resulting choices in engine state. */
export function shuffleServer<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function createTurn(order: readonly string[], mode: CoreTurn['mode'] = 'FIXED', previousStartId?: string): CoreTurn {
  let selected = mode === 'RANDOM' ? shuffleServer(order) : [...order];
  if (mode === 'ROTATING_START' && previousStartId) {
    const previous = selected.indexOf(previousStartId);
    if (previous < 0) throw new CoreRuleError('PLAYER_NOT_IN_TURN');
    const start = (previous + 1) % selected.length;
    selected = [...selected.slice(start), ...selected.slice(0, start)];
  }
  return CoreTurnSchema.parse({ mode, order: selected, index: 0, cycle: 0 });
}
export function activeTurn(turn: CoreTurn): string { return CoreTurnSchema.parse(turn).order[turn.index]; }
export function advanceTurn(turn: CoreTurn): CoreTurn {
  CoreTurnSchema.parse(turn);
  return { ...turn, index: (turn.index + 1) % turn.order.length, cycle: turn.cycle + (turn.index + 1 === turn.order.length ? 1 : 0) };
}
export function requireWinningTurn(turn: CoreTurn | null | undefined, winnerId: string): void {
  // Explicit compatibility: old games already persisted the buzzer winner.
  // No random order or newly chosen participant is invented during recovery.
  if (turn && activeTurn(turn) !== winnerId) throw new CoreRuleError('TURN_OWNER_CONFLICT');
}
export function advanceRound(currentIndex: number, totalRounds: number): { nextIndex: number; ended: boolean } {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(totalRounds) || currentIndex < 0 || totalRounds < 1 || currentIndex >= totalRounds) throw new CoreRuleError('INVALID_ROUND_INDEX');
  return { nextIndex: currentIndex + 1, ended: currentIndex + 1 === totalRounds };
}
export type MatchMode = 'EXACT' | 'NORMALIZED' | 'SYNONYM' | 'FUZZY' | 'MANUAL_ONLY';
export type MatchResult = 'MATCH' | 'NO_MATCH' | 'NEEDS_JUDGE';
function normalized(value: string) { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE'); }
function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[right.length];
}
/** Fuzzy similarity is only a judge proposal, never an automatic correct answer. */
export function matchAnswer(value: string | null, expected: string, mode: MatchMode, synonyms: readonly string[] = []): MatchResult {
  if (mode === 'MANUAL_ONLY') return 'NEEDS_JUDGE';
  if (value === null) return 'NO_MATCH';
  if (value.length > 10000 || expected.length > 10000) throw new CoreRuleError('ANSWER_TOO_LONG');
  if (mode === 'EXACT') return value === expected ? 'MATCH' : 'NO_MATCH';
  const candidate = normalized(value), correct = normalized(expected);
  if (candidate === correct) return 'MATCH';
  if (mode === 'SYNONYM') return synonyms.some(s => normalized(s) === candidate) ? 'MATCH' : 'NO_MATCH';
  if (mode !== 'FUZZY' || !candidate || !correct) return 'NO_MATCH';
  // Bound quadratic work independently of request size limits.
  if (candidate.length > 256 || correct.length > 256) return 'NEEDS_JUDGE';
  return 1 - distance(candidate, correct) / Math.max(candidate.length, correct.length) >= 0.8 ? 'NEEDS_JUDGE' : 'NO_MATCH';
}
/** Competition ranks (1,1,3), deterministic order within ties, no random winner. */
export function rankScores<T extends { score: number }>(entries: readonly T[]): Array<T & { rank: number }> {
  if (entries.some(entry => !Number.isFinite(entry.score))) throw new CoreRuleError('INVALID_SCORE');
  const ordered = [...entries].sort((a, b) => b.score - a.score);
  let rank = 0;
  return ordered.map((entry, index) => { if (!index || entry.score !== ordered[index - 1].score) rank = index + 1; return { ...entry, rank }; });
}
