import { CoreBuzzerSchema, type CoreBuzzer } from '@quiz/shared';
import { CoreRuleError } from './runtimePrimitives.js';

export type BuzzerState = CoreBuzzer;
export type ClaimBuzzerResult =
  | { accepted: true; state: BuzzerState }
  | { accepted: false; error: 'BUZZ_CLOSED' | 'ALREADY_CLAIMED' | 'PLAYER_EXCLUDED'; state: BuzzerState };

export function createBuzzerState(): BuzzerState {
  return { open: false, winnerId: null, excludedPlayerIds: [], status: 'CLOSED', mode: 'INDIVIDUAL', fairness: 'SERVER_ARRIVAL' };
}
export function openBuzzer(state: BuzzerState, options: {
  excludePlayerIds?: string[]; eligiblePlayerIds?: string[]; mode?: NonNullable<BuzzerState['mode']>; teamByPlayer?: Record<string, string>;
} = {}): BuzzerState {
  const next: BuzzerState = { ...state, open: true, status: 'OPEN', winnerId: null, winnerTeamId: null, claimedAtMs: null,
    fairness: 'SERVER_ARRIVAL', mode: options.mode ?? state.mode ?? 'INDIVIDUAL',
    excludedPlayerIds: [...new Set(options.excludePlayerIds ?? [])],
    ...(options.eligiblePlayerIds ? { eligiblePlayerIds: [...new Set(options.eligiblePlayerIds)] } : {}),
    ...(options.teamByPlayer ? { teamByPlayer: { ...options.teamByPlayer } } : {}),
  };
  return CoreBuzzerSchema.parse(next);
}
function eligible(state: BuzzerState, playerId: string) {
  return !state.excludedPlayerIds.includes(playerId) && (!state.eligiblePlayerIds || state.eligiblePlayerIds.includes(playerId))
    && (state.mode !== 'TEAM' || !!state.teamByPlayer && Object.hasOwn(state.teamByPlayer, playerId));
}
/** Persist the first accepted server arrival. Rejoin never calls this operation. */
export function claimBuzzer(state: BuzzerState, playerId: string, now = Date.now()): ClaimBuzzerResult {
  CoreBuzzerSchema.parse(state);
  if (!state.open) return { accepted: false, error: 'BUZZ_CLOSED', state };
  if (state.winnerId) return { accepted: false, error: 'ALREADY_CLAIMED', state };
  if (!eligible(state, playerId)) return { accepted: false, error: 'PLAYER_EXCLUDED', state };
  return { accepted: true, state: CoreBuzzerSchema.parse({ ...state, open: false, status: 'LOCKED', winnerId: playerId,
    winnerTeamId: state.mode === 'TEAM' ? state.teamByPlayer![playerId] : null, claimedAtMs: now }) };
}
export function resolveBuzzer(state: BuzzerState, excludeWinner = false): BuzzerState {
  const excluded = new Set(state.excludedPlayerIds);
  if (excludeWinner && state.winnerId) {
    if (state.mode === 'TEAM') {
      const teamId = state.teamByPlayer?.[state.winnerId];
      for (const [id, team] of Object.entries(state.teamByPlayer ?? {})) if (team === teamId) excluded.add(id);
    } else excluded.add(state.winnerId);
  }
  return CoreBuzzerSchema.parse({ ...state, open: false, status: 'RESOLVED', excludedPlayerIds: [...excluded] });
}
export function overrideBuzzerWinner(state: BuzzerState, playerId: string, audit: { actorId: string; reason?: string; atMs: number }): BuzzerState {
  CoreBuzzerSchema.parse(state);
  if (state.open || !state.winnerId || state.status === 'RESOLVED') throw new CoreRuleError('INVALID_PHASE');
  if (!eligible(state, playerId)) throw new CoreRuleError('PLAYER_EXCLUDED');
  if (state.winnerId === playerId) return state;
  return CoreBuzzerSchema.parse({ ...state, status: 'LOCKED', winnerId: playerId,
    winnerTeamId: state.mode === 'TEAM' ? state.teamByPlayer![playerId] : null,
    overrides: [...state.overrides ?? [], { actorId: audit.actorId, fromPlayerId: state.winnerId, toPlayerId: playerId, reason: audit.reason ?? null, atMs: audit.atMs }] });
}
export function resetBuzzerState(): BuzzerState { return createBuzzerState(); }
