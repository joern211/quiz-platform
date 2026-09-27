import type { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { authorizeGameAction, type GameActor } from '../core/access.js';
import { loadGameState } from '../core/state.js';

type GeoRound = {
  question: { id: string; prompt: string; category: string; options: Array<{ id: string; text: string }> };
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
};

/** Only return public state plus the actor's own data. Never serialize questions[] to a socket. */
export function projectGeoStateForClient(state: GeoState, actor: GameActor) {
  const round = state.roundStates[state.currentRoundIndex];
  const own = actor.role === 'PLAYER' && actor.participationId
    ? round?.playerStates[actor.participationId] : undefined;
  const revealed = round?.revealed ?? false;
  return {
    success: true as const,
    phase: state.phase,
    roundIndex: state.currentRoundIndex,
    totalQuestions: state.questions.length,
    question: round?.question ? {
      ...round.question,
      ...(revealed || actor.role === 'MODERATOR'
        ? { correctOptionId: state.questions[state.currentRoundIndex]?.correctOptionId } : {}),
    } : null,
    timerEndMs: state.phase === 'PAUSED' ? null : round?.timerEndMs ?? null,
    pauseRemainingMs: state.phase === 'PAUSED' ? round?.pauseRemainingMs ?? null : null,
    revealed,
    scores: state.scores,
    ownAnswer: own?.selectedOptionId ?? null,
    ownAnswered: own?.answered ?? false,
    ownJokers: own?.jokers ?? null,
    ownEliminatedOptions: own?.eliminatedOptions ?? [],
    ownSpyDistribution: own?.spyDistribution ?? null,
  };
}

export function registerGeoResync(_io: Server, socket: Socket): void {
  socket.on('geo:resync', async (_data, callback) => {
    try {
      const auth = authorizeGameAction(socket, { roles: ['MODERATOR', 'PLAYER', 'VIEWER'] });
      if (!auth.ok) { callback?.({ success: false, error: auth.error }); return; }
      const room = await prisma.room.findUnique({
        where: { id: auth.actor.roomId }, include: { gameDefinition: true },
      });
      if (!room) { callback?.({ success: false, error: 'ROOM_NOT_FOUND' }); return; }
      if (room.gameDefinition.slug !== 'geo') {
        callback?.({ success: false, error: 'WRONG_GAME' }); return;
      }
      const loaded = await loadGameState<GeoState>(room.id);
      if (!loaded) { callback?.({ success: false, error: 'GAME_NOT_FOUND' }); return; }
      callback?.(projectGeoStateForClient(loaded.state, auth.actor));
    } catch (error) {
      logger.error('geo:resync failed', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  });
}
