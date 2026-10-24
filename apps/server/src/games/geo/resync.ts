import type { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { authorizeGameAction, type GameActor } from '../core/access.js';
import { loadGameState } from '../core/state.js';
import { resolveCanonicalSlug } from '@quiz/shared';
import { canView, visibleValue } from '../core/visibility.js';
import { ensureGameStateSafe } from '../core/recovery.js';

type GeoRound = {
  question: { id: string; prompt: string; category: string; mediaType?: string; mediaAssetId?: string; imageUrl?: string;
    options: Array<{ id: string; text: string; label?: string; imageUrl?: string }> };
  timerEndMs: number | null;
  pauseRemainingMs: number | null;
  revealed: boolean;
  playerStates: Record<string, {
    answered: boolean; selectedOptionId: string | null;
    eliminatedOptions?: string[];
    spyDistribution?: Record<string, number> | null;
    jokers: { used5050: boolean; usedSpy: boolean; usedRisk: boolean };
  }>;
};

type GeoState = {
  phase: string;
  currentRoundIndex: number;
  questions: Array<{ correctOptionId: string; explanation?: string }>;
  roundStates: Record<number, GeoRound>;
  scores: Record<string, number>;
  recoveryError?: 'CONFIG_SNAPSHOT_INVALID' | 'STATE_INVARIANT_FAILED';
};

/** Only return public state plus the actor's own data. Never serialize questions[] to a socket. */
export function projectGeoStateForClient(state: GeoState, actor: GameActor) {
  if (state.phase === 'ERROR_RECOVERY' && state.recoveryError === 'STATE_INVARIANT_FAILED') return {
    success: true as const, phase: 'ERROR_RECOVERY', recoveryError: state.recoveryError,
    question: null, timerEndMs: null, pauseRemainingMs: null, scores: {}, revealed: false,
    roundIndex: 0, totalQuestions: 0,
  };
  if (state.phase === 'GAME_END') {
    return {
      success: true as const, phase: 'GAME_END', gameEnded: true,
      roundIndex: state.currentRoundIndex, totalQuestions: state.questions.length,
      question: null, timerEndMs: null, pauseRemainingMs: null,
      revealed: true, scores: state.scores,
    };
  }
  const round = state.roundStates[state.currentRoundIndex];
  const audience = { role: actor.role, participantId: actor.participationId };
  const own = canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: actor.participationId }) && actor.participationId
    ? round?.playerStates[actor.participationId] : undefined;
  const revealed = round?.revealed ?? false;
  const answerStats: Record<string, number> = {};
  if (actor.role === 'HOST') {
    for (const player of Object.values(round?.playerStates ?? {})) {
      if (player.answered && player.selectedOptionId) {
        answerStats[player.selectedOptionId] = (answerStats[player.selectedOptionId] ?? 0) + 1;
      }
    }
  }
  return {
    success: true as const,
    phase: state.phase,
    roundIndex: state.currentRoundIndex,
    totalQuestions: state.questions.length,
    question: round?.question ? {
      id: round.question.id, prompt: round.question.prompt, category: round.question.category,
      mediaType: round.question.mediaType, mediaAssetId: round.question.mediaAssetId, imageUrl: round.question.imageUrl,
      options: round.question.options.map(option => ({ id: option.id, text: option.text,
        ...(option.label !== undefined ? { label: option.label } : {}), ...(option.imageUrl !== undefined ? { imageUrl: option.imageUrl } : {}) })),
      ...((revealed || actor.role === 'HOST') ? { correctOptionId: visibleValue(audience,
        { scope: 'HOST_PRIVATE', publiclyRevealed: revealed }, () => state.questions[state.currentRoundIndex]?.correctOptionId) } : {}),
    } : null,
    recoveryError: state.recoveryError,
    timerEndMs: ['PAUSED', 'ERROR_RECOVERY'].includes(state.phase) ? null : round?.timerEndMs ?? null,
    pauseRemainingMs: state.phase === 'PAUSED' ? round?.pauseRemainingMs ?? null : null,
    revealed,
    scores: state.scores,
    ownAnswer: own?.selectedOptionId ?? null,
    ownAnswered: own?.answered ?? false,
    ownJokers: own?.jokers ?? null,
    ownEliminatedOptions: own?.eliminatedOptions ?? [],
    ownSpyDistribution: own?.spyDistribution ?? null,
    ...(actor.role === 'HOST' ? { answerStats } : {}),
  };
}

export function registerGeoResync(_io: Server, socket: Socket): void {
  socket.on('geo:resync', async (_data, callback) => {
    try {
      const auth = authorizeGameAction(socket, { roles: ['HOST', 'PLAYER', 'VIEWER'] });
      if (!auth.ok) { callback?.({ success: false, error: auth.error }); return; }
      const room = await prisma.room.findUnique({
        where: { id: auth.actor.roomId }, include: { gameDefinition: true },
      });
      if (!room) { callback?.({ success: false, error: 'ROOM_NOT_FOUND' }); return; }
      if (resolveCanonicalSlug(room.gameDefinition.slug) !== resolveCanonicalSlug('geo')) {
        callback?.({ success: false, error: 'WRONG_GAME' }); return;
      }
      await ensureGameStateSafe(room.id);
      const loaded = await loadGameState<GeoState>(room.id);
      if (!loaded) { callback?.({ success: false, error: 'GAME_NOT_FOUND' }); return; }
      callback?.(projectGeoStateForClient(loaded.state, auth.actor));
    } catch (error) {
      logger.error('geo:resync failed', { error });
      callback?.({ success: false, error: error instanceof Error && error.message === 'STATE_INVARIANT_FAILED' ? 'STATE_INVARIANT_FAILED' : 'INTERNAL_ERROR' });
    }
  });
}
