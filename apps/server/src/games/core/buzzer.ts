// ============================================================
// Shared Buzzer State
// Pure primitives; persistence and phase transitions stay game-owned.
// ============================================================

export interface BuzzerState {
  open: boolean;
  winnerId: string | null;
  excludedPlayerIds: string[];
}

export type ClaimBuzzerResult =
  | { accepted: true; state: BuzzerState }
  | { accepted: false; error: 'BUZZ_CLOSED' | 'ALREADY_CLAIMED' | 'PLAYER_EXCLUDED'; state: BuzzerState };

export function createBuzzerState(): BuzzerState {
  return { open: false, winnerId: null, excludedPlayerIds: [] };
}

export function openBuzzer(
  state: BuzzerState,
  options: { excludePlayerIds?: string[] } = {}
): BuzzerState {
  return {
    ...state,
    open: true,
    winnerId: null,
    excludedPlayerIds: [...new Set(options.excludePlayerIds ?? [])],
  };
}

export function claimBuzzer(state: BuzzerState, playerId: string): ClaimBuzzerResult {
  if (!state.open) return { accepted: false, error: 'BUZZ_CLOSED', state };
  if (state.winnerId) return { accepted: false, error: 'ALREADY_CLAIMED', state };
  if (state.excludedPlayerIds.includes(playerId)) {
    return { accepted: false, error: 'PLAYER_EXCLUDED', state };
  }

  return {
    accepted: true,
    state: {
      ...state,
      open: false,
      winnerId: playerId,
    },
  };
}

export function resetBuzzerState(): BuzzerState {
  return createBuzzerState();
}
