// ============================================================
// Wer-ist-das? Game Engine (Server)
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';

interface WerIstDasState {
  rounds: Array<{
    id: string;
    imageUrl: string;
    personA: { name: string; aliases: string[] };
    personB: { name: string; aliases: string[] };
    hint?: string;
    hintActive: boolean;
  }>;
  currentIndex: number;
  buzzOpen: boolean;
  buzzWinner: string | null;
  phase: 'showing' | 'hint' | 'buzzed' | 'judging' | 'reveal';
  scores: Record<string, number>;
  wrongPlayers: Set<string>; // Players who buzzed wrong
}

const states = new Map<string, WerIstDasState>();

export function initWerIstDasHandlers(io: Server, socket: Socket) {
  const { roomCode } = socket.data;

  socket.on('weristdas:start', async () => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const setup = room.setupSnapshotJson as any;
    const rounds = setup?.rounds || [];

    const state: WerIstDasState = {
      rounds,
      currentIndex: 0,
      buzzOpen: false,
      buzzWinner: null,
      phase: 'showing',
      scores: {},
      wrongPlayers: new Set(),
    };

    states.set(roomCode, state);

    io.to(`room:${roomCode}`).emit('weristdas:start', {
      total: rounds.length,
    });

    logger.info('WerIstDas started', { roomCode, rounds: rounds.length });
  });

  socket.on('weristdas:show', async () => {
    const state = states.get(roomCode);
    if (!state || state.phase !== 'showing') return;

    const currentRound = state.rounds[state.currentIndex];
    if (!currentRound) return;

    state.buzzOpen = true;
    state.phase = 'hint';

    io.to(`room:${roomCode}`).emit('weristdas:show', {
      imageUrl: currentRound.imageUrl,
      round: state.currentIndex + 1,
      total: state.rounds.length,
      hint: currentRound.hint,
      hintActive: false,
    });
  });

  socket.on('weristdas:hint', async () => {
    const state = states.get(roomCode);
    if (!state || state.phase !== 'hint') return;

    const currentRound = state.rounds[state.currentIndex];
    currentRound.hintActive = true;

    io.to(`room:${roomCode}`).emit('weristdas:hint', {
      hint: currentRound.hint,
    });
  });

  socket.on('weristdas:buzz', async () => {
    const state = states.get(roomCode);
    if (!state || !state.buzzOpen || state.buzzWinner) return;

    const playerId = socket.data.participationId;

    // Check if player already buzzed wrong
    if (state.wrongPlayers.has(playerId)) {
      socket.emit('error', { message: 'Du hast bereits gebuzzert!' });
      return;
    }

    state.buzzWinner = playerId;
    state.buzzOpen = false;
    state.phase = 'buzzed';

    io.to(`room:${roomCode}`).emit('buzz:won', {
      playerId,
      playerName: socket.data.displayName,
    });

    logger.info('WerIstDas buzzed', { roomCode, playerId });
  });

  socket.on('weristdas:judge', async (data: { result: 'both' | 'one' | 'wrong' }) => {
    const state = states.get(roomCode);
    if (!state || state.phase !== 'buzzed' || !state.buzzWinner) return;

    const winnerId = state.buzzWinner;
    const currentRound = state.rounds[state.currentIndex];
    let points = 0;

    if (data.result === 'both') {
      points = 3;
    } else if (data.result === 'one') {
      points = 1;
    } else {
      points = -1;
      state.wrongPlayers.add(winnerId);
      // Reopen buzz
      state.buzzWinner = null;
      state.buzzOpen = true;
      state.phase = 'hint';

      io.to(`room:${roomCode}`).emit('weristdas:reopen', {
        playerId: winnerId,
      });
      return;
    }

    state.scores[winnerId] = (state.scores[winnerId] || 0) + points;
    state.phase = 'reveal';

    io.to(`room:${roomCode}`).emit('weristdas:reveal', {
      personA: currentRound.personA.name,
      personB: currentRound.personB.name,
      aliasesA: currentRound.personA.aliases,
      aliasesB: currentRound.personB.aliases,
      winner: winnerId,
      points,
      scores: state.scores,
    });
  });

  socket.on('weristdas:next', async () => {
    const state = states.get(roomCode);
    if (!state) return;

    state.currentIndex++;
    state.wrongPlayers.clear();
    state.buzzWinner = null;
    state.buzzOpen = false;

    if (state.currentIndex >= state.rounds.length) {
      io.to(`room:${roomCode}`).emit('weristdas:end', {
        scores: state.scores,
      });
      return;
    }

    state.phase = 'showing';

    io.to(`room:${roomCode}`).emit('weristdas:next', {
      index: state.currentIndex,
      total: state.rounds.length,
    });
  });

  return () => {
    states.delete(roomCode);
  };
}

export function initWerIstDasState(roomCode: string) {
  // State initialized when game starts
}
