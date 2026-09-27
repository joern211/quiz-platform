import type { GameRole } from '../core/access.js';
import type { WerIstDasSetup } from './contracts.js';
import type { WerIstDasState } from './state.js';

/** Explicit allowlist: the setup and stored game state are never sent to clients. */
export function projectWerIstDas(
  state: WerIstDasState, setup: WerIstDasSetup, role: GameRole, participationId?: string,
) {
  const round = setup.rounds[state.roundIndex];
  const solution = role === 'MODERATOR' || state.revealed;
  return {
    phase: state.phase,
    roundIndex: state.roundIndex,
    roundCount: state.roundCount,
    roundId: round.id,
    imageAssetId: round.imageAssetId,
    scores: state.scores,
    playerNames: state.playerNames,
    buzzerOpen: state.buzzer.open,
    winnerId: state.buzzer.winnerId,
    winnerName: state.buzzer.winnerId ? state.playerNames[state.buzzer.winnerId] : null,
    hintActive: state.hintActive,
    excludedPlayerIds: role === 'MODERATOR' ? state.buzzer.excludedPlayerIds : undefined,
    excluded: role === 'PLAYER' ? state.buzzer.excludedPlayerIds.includes(participationId ?? '') : undefined,
    solvedBy: state.solvedBy,
    lastDelta: state.lastDelta,
    revealed: state.revealed,
    person1: solution ? round.person1 : undefined,
    person2: solution ? round.person2 : undefined,
    aliases1: role === 'MODERATOR' ? round.aliases1 : undefined,
    aliases2: role === 'MODERATOR' ? round.aliases2 : undefined,
    description: solution ? round.description : undefined,
  };
}
