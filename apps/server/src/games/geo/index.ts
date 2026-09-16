// ============================================================
// Geo Quiz Game Engine
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';

interface GeoPlayerState {
  answered: boolean;
  selectedOptionId: string | null;
  locked: boolean;
  score: number;
  jokers: {
    used5050: boolean;
    usedSpy: boolean;
    usedRisk: boolean;
  };
}

interface GeoRoundState {
  questionIndex: number;
  question: any;
  revealed: boolean;
  timerStartMs: number | null;
  timerEndMs: number | null;
  buzzWinnerId: string | null;
  buzzOpen: boolean;
  playerStates: Record<string, GeoPlayerState>;
  spyDistribution: Record<string, number> | null;
}

interface GeoGameState {
  phase: string;
  currentRoundIndex: number;
  questions: any[];
  roundStates: Record<number, GeoRoundState>;
  scores: Record<string, number>;
}

export const handleGeoGame = {
  // ============================================================
  // Initialize Game
  // ============================================================

  async initialize(io: Server, room: any, initialPhase: string = 'INTRO') {
    // Get setup from room
    const setup = JSON.parse(room.setupSnapshotJson || '{}');
    
    // Get questions based on setup
    let questions: any[] = [];
    
    if (setup.selectedQuestionIds && setup.selectedQuestionIds.length > 0) {
      // Get specific questions
      const geoQuestions = await prisma.geoQuestion.findMany({
        where: {
          id: { in: setup.selectedQuestionIds },
          enabled: true,
        },
        include: { pack: true },
      });
      questions = geoQuestions;
    } else if (setup.questionPoolId) {
      // Get from pool with random selection
      const geoQuestions = await prisma.geoQuestion.findMany({
        where: {
          packId: setup.questionPoolId,
          enabled: true,
        },
        include: { pack: true },
      });
      
      // Shuffle and take configured amount
      const shuffled = geoQuestions.sort(() => Math.random() - 0.5);
      const count = setup.questionCount || 10;
      questions = shuffled.slice(0, Math.min(count, shuffled.length));
    }

    // Get participations
    const participations = await prisma.participation.findMany({
      where: { roomId: room.id, role: 'PLAYER' },
    });

    // Initialize player states
    const playerStates: Record<string, GeoPlayerState> = {};
    const scores: Record<string, number> = {};
    
    for (const p of participations) {
      playerStates[p.id] = {
        answered: false,
        selectedOptionId: null,
        locked: false,
        score: 0,
        jokers: {
          used5050: false,
          usedSpy: false,
          usedRisk: false,
        },
      };
      scores[p.id] = 0;
    }

    // Create initial game state
    const gameState: GeoGameState = {
      phase: initialPhase,
      currentRoundIndex: 0,
      questions,
      roundStates: {},
      scores,
    };

    // Save to database
    await prisma.roomGameState.upsert({
      where: { roomId: room.id },
      create: {
        roomId: room.id,
        engineVersion: 1,
        phase: initialPhase,
        stateJson: JSON.stringify(gameState),
        revision: 1,
      },
      update: {
        phase: initialPhase,
        stateJson: JSON.stringify(gameState),
        revision: { increment: 1 },
      },
    });

    // Emit initial state
    io.to(room.code).emit('geo:init', {
      questionCount: questions.length,
      phase: initialPhase,
    });

    logger.info('Geo game initialized', { roomId: room.id, questionCount: questions.length });
  },

  // ============================================================
  // Start Round (show question)
  // ============================================================

  async startRound(io: Server, roomCode: string) {
    const room = await prisma.room.findUnique({
      where: { code: roomCode },
    });

    if (!room) return;

    const gameStateData = await prisma.roomGameState.findUnique({
      where: { roomId: room.id },
    });

    if (!gameStateData) return;

    const state: GeoGameState = JSON.parse(gameStateData.stateJson);
    const question = state.questions[state.currentRoundIndex];

    if (!question) {
      // No more questions - end game
      io.to(roomCode).emit('game:end', { reason: 'NO_MORE_QUESTIONS' });
      return;
    }

    // Parse options
    const options = JSON.parse(question.options);

    // Initialize round state
    state.roundStates[state.currentRoundIndex] = {
      questionIndex: state.currentRoundIndex,
      question: {
        id: question.id,
        prompt: question.prompt,
        category: question.category,
        mediaType: question.mediaType,
        mediaAssetId: question.mediaAssetId,
        options: options.map((o: any) => ({ id: o.id, text: o.text })),
      },
      revealed: false,
      timerStartMs: null,
      timerEndMs: null,
      buzzWinnerId: null,
      buzzOpen: false,
      playerStates: {},
      spyDistribution: null,
    };

    state.phase = 'INPUT_OPEN';

    // Calculate timer
    const timerMs = question.durationMs || 20000;

    // Update and emit
    await prisma.roomGameState.update({
      where: { roomId: room.id },
      data: {
        stateJson: JSON.stringify(state),
        phase: 'INPUT_OPEN',
        revision: { increment: 1 },
      },
    });

    await prisma.room.update({
      where: { code: roomCode },
      data: { runPhase: 'ROUND_ACTIVE', revision: { increment: 1 } },
    });

    // Emit question to players (without correct answer)
    io.to(roomCode).emit('geo:show', {
      roundIndex: state.currentRoundIndex,
      question: {
        id: question.id,
        prompt: question.prompt,
        category: question.category,
        mediaType: question.mediaType,
        mediaAssetId: question.mediaAssetId,
        options: options.map((o: any) => ({ id: o.id, text: o.text })),
      },
      timerMs,
      endsAt: Date.now() + timerMs,
      totalQuestions: state.questions.length,
    });

    // Emit to moderator (with solution)
    // TODO: Send moderator-specific event with solution

    logger.info('Geo round started', { roomCode, round: state.currentRoundIndex });
  },

  // ============================================================
  // Handle Answer
  // ============================================================

  async handleAnswer(
    io: Server,
    socket: Socket,
    data: { roomCode: string; optionId: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      if (!data.rejoinToken) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      const participation = await prisma.participation.findUnique({
        where: { rejoinToken: data.rejoinToken },
        include: { room: true },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
        return;
      }

      const room = participation.room;
      const gameStateData = await prisma.roomGameState.findUnique({
        where: { roomId: room.id },
      });

      if (!gameStateData) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND' });
        return;
      }

      const state: GeoGameState = JSON.parse(gameStateData.stateJson);

      if (state.phase !== 'INPUT_OPEN') {
        callback?.({ success: false, error: 'INPUT_CLOSED' });
        return;
      }

      const roundState = state.roundStates[state.currentRoundIndex];
      const playerState = roundState.playerStates[participation.id] || {
        answered: false,
        selectedOptionId: null,
        locked: false,
        score: 0,
        jokers: { used5050: false, usedSpy: false, usedRisk: false },
      };

      if (playerState.answered || playerState.locked) {
        callback?.({ success: false, error: 'ALREADY_ANSWERED' });
        return;
      }

      // Check if risk joker active
      const isRisk = playerState.jokers.usedRisk;

      // Update player state
      playerState.answered = true;
      playerState.selectedOptionId = data.optionId;

      roundState.playerStates[participation.id] = playerState;

      // Broadcast player answered (no answer content)
      io.to(room.code).emit('geo:answered', {
        playerId: participation.id,
        questionIndex: state.currentRoundIndex,
      });

      await prisma.roomGameState.update({
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(state),
          revision: { increment: 1 },
        },
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo answer error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  // ============================================================
  // Handle 50/50 Joker
  // ============================================================

  async handleJoker5050(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      if (!data.rejoinToken) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      const participation = await prisma.participation.findUnique({
        where: { rejoinToken: data.rejoinToken },
        include: { room: true },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
        return;
      }

      const room = participation.room;
      const gameStateData = await prisma.roomGameState.findUnique({
        where: { roomId: room.id },
      });

      if (!gameStateData) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND' });
        return;
      }

      const state: GeoGameState = JSON.parse(gameStateData.stateJson);
      const roundState = state.roundStates[state.currentRoundIndex];
      const playerState = roundState?.playerStates?.[participation.id];

      if (!playerState) {
        callback?.({ success: false, error: 'PLAYER_NOT_IN_ROUND' });
        return;
      }

      if (playerState.jokers.used5050) {
        callback?.({ success: false, error: 'JOKER_ALREADY_USED' });
        return;
      }

      if (playerState.answered) {
        callback?.({ success: false, error: 'ALREADY_ANSWERED' });
        return;
      }

      // Mark joker as used
      playerState.jokers.used5050 = true;

      // Get question and find two wrong options to eliminate
      const question = state.questions[state.currentRoundIndex];
      const options = JSON.parse(question.options);
      const wrongOptions = options.filter((o: any) => o.id !== question.correctOptionId);
      
      // Randomly select two wrong options
      const shuffled = wrongOptions.sort(() => Math.random() - 0.5);
      const eliminated = shuffled.slice(0, 2).map((o: any) => o.id);

      // Send only to this player (private)
      socket.emit('geo:joker:5050:result', {
        eliminated,
      });

      await prisma.roomGameState.update({
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(state),
          revision: { increment: 1 },
        },
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo 50/50 joker error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  // ============================================================
  // Handle Spy Joker
  // ============================================================

  async handleJokerSpy(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      if (!data.rejoinToken) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      const participation = await prisma.participation.findUnique({
        where: { rejoinToken: data.rejoinToken },
        include: { room: true },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
        return;
      }

      const room = participation.room;
      const gameStateData = await prisma.roomGameState.findUnique({
        where: { roomId: room.id },
      });

      if (!gameStateData) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND' });
        return;
      }

      const state: GeoGameState = JSON.parse(gameStateData.stateJson);
      const roundState = state.roundStates[state.currentRoundIndex];
      const playerState = roundState?.playerStates?.[participation.id];

      if (!playerState) {
        callback?.({ success: false, error: 'PLAYER_NOT_IN_ROUND' });
        return;
      }

      if (playerState.jokers.usedSpy) {
        callback?.({ success: false, error: 'JOKER_ALREADY_USED' });
        return;
      }

      // Spy can only be used after all others answered or time ended
      const allOthersAnswered = Object.entries(roundState.playerStates)
        .filter(([id]) => id !== participation.id)
        .every(([, ps]) => (ps as GeoPlayerState).answered);

      if (!allOthersAnswered && state.phase !== 'INPUT_LOCKED') {
        callback?.({ success: false, error: 'NOT_ALL_ANSWERED' });
        return;
      }

      // Mark joker as used
      playerState.jokers.usedSpy = true;

      // Calculate distribution
      const options = JSON.parse(state.questions[state.currentRoundIndex].options);
      const distribution: Record<string, number> = {};
      
      // Count answers per option
      for (const [pid, ps] of Object.entries(roundState.playerStates)) {
        if (pid === participation.id) continue;
        const pState = ps as GeoPlayerState;
        if (pState.selectedOptionId) {
          distribution[pState.selectedOptionId] = (distribution[pState.selectedOptionId] || 0) + 1;
        }
      }

      // Convert to percentages
      const total = Object.values(distribution).reduce((a, b) => a + b, 0);
      if (total > 0) {
        for (const optId of Object.keys(distribution)) {
          distribution[optId] = Math.round((distribution[optId] / total) * 100);
        }
      }

      roundState.spyDistribution = distribution;

      // Send only to this player
      socket.emit('geo:joker:spy:result', {
        distribution,
      });

      await prisma.roomGameState.update({
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(state),
          revision: { increment: 1 },
        },
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo spy joker error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  // ============================================================
  // Handle Risk Joker
  // ============================================================

  async handleJokerRisk(
    io: Server,
    socket: Socket,
    data: { roomCode: string; rejoinToken?: string },
    callback?: (result: any) => void
  ) {
    try {
      if (!data.rejoinToken) {
        callback?.({ success: false, error: 'TOKEN_REQUIRED' });
        return;
      }

      const participation = await prisma.participation.findUnique({
        where: { rejoinToken: data.rejoinToken },
        include: { room: true },
      });

      if (!participation) {
        callback?.({ success: false, error: 'PARTICIPATION_NOT_FOUND' });
        return;
      }

      const room = participation.room;
      const gameStateData = await prisma.roomGameState.findUnique({
        where: { roomId: room.id },
      });

      if (!gameStateData) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND' });
        return;
      }

      const state: GeoGameState = JSON.parse(gameStateData.stateJson);
      const roundState = state.roundStates[state.currentRoundIndex];
      const playerState = roundState?.playerStates?.[participation.id];

      if (!playerState) {
        callback?.({ success: false, error: 'PLAYER_NOT_IN_ROUND' });
        return;
      }

      if (playerState.jokers.usedRisk) {
        callback?.({ success: false, error: 'JOKER_ALREADY_USED' });
        return;
      }

      if (playerState.answered) {
        callback?.({ success: false, error: 'ALREADY_ANSWERED' });
        return;
      }

      // Mark joker as used
      playerState.jokers.usedRisk = true;

      // Confirm to player
      socket.emit('geo:joker:risk:result', {
        active: true,
      });

      await prisma.roomGameState.update({
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(state),
          revision: { increment: 1 },
        },
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo risk joker error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  // ============================================================
  // Handle Reveal (Moderator)
  // ============================================================

  async handleReveal(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      const gameStateData = await prisma.roomGameState.findUnique({
        where: { roomId: room.id },
      });

      if (!gameStateData) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND' });
        return;
      }

      const state: GeoGameState = JSON.parse(gameStateData.stateJson);
      const question = state.questions[state.currentRoundIndex];
      const roundState = state.roundStates[state.currentRoundIndex];

      // Parse options and find correct
      const options = JSON.parse(question.options);
      const correctOption = options.find((o: any) => o.id === question.correctOptionId);

      // Calculate scores for each player
      const scoreEvents: Array<{ participationId: string; delta: number; reason: string }> = [];

      for (const [pid, playerState] of Object.entries(roundState.playerStates)) {
        const ps = playerState as GeoPlayerState;
        if (!ps.answered) continue;

        const isCorrect = ps.selectedOptionId === question.correctOptionId;
        let points = 0;

        if (isCorrect) {
          // Points with potential risk multiplier
          let questionPoints = question.points || 100;
          if (ps.jokers.usedRisk) {
            questionPoints *= 2;
          }
          points = questionPoints;
          state.scores[pid] = (state.scores[pid] || 0) + points;
        } else {
          // Wrong answer
          let wrongPoints = question.wrongPoints || 0;
          if (ps.jokers.usedRisk) {
            wrongPoints *= 2;
          }
          points = wrongPoints;
          state.scores[pid] = (state.scores[pid] || 0) + points;
        }

        scoreEvents.push({
          participationId: pid,
          delta: points,
          reason: isCorrect ? 'CORRECT_ANSWER' : 'WRONG_ANSWER',
        });

        // Update participation score
        await prisma.participation.update({
          where: { id: pid },
          data: { score: state.scores[pid] },
        });

        // Create score event
        await prisma.scoreEvent.create({
          data: {
            roomId: room.id,
            participationId: pid,
            roundIndex: state.currentRoundIndex,
            delta: points,
            reason: isCorrect ? 'Richtige Antwort' : 'Falsche Antwort',
            source: 'auto',
          },
        });
      }

      roundState.revealed = true;
      state.phase = 'REVEAL';

      await prisma.roomGameState.update({
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(state),
          phase: 'REVEAL',
          revision: { increment: 1 },
        },
      });

      await prisma.room.update({
        where: { code: data.roomCode },
        data: { runPhase: 'REVEAL', revision: { increment: 1 } },
      });

      // Emit reveal to all
      io.to(data.roomCode).emit('geo:reveal', {
        roundIndex: state.currentRoundIndex,
        correctOptionId: question.correctOptionId,
        correctOptionText: correctOption.text,
        explanation: question.explanation,
        scores: scoreEvents.map(e => ({
          participationId: e.participationId,
          delta: e.delta,
          totalScore: state.scores[e.participationId],
        })),
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo reveal error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  // ============================================================
  // Handle Next Question (Moderator)
  // ============================================================

  async handleNext(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      const gameStateData = await prisma.roomGameState.findUnique({
        where: { roomId: room.id },
      });

      if (!gameStateData) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND' });
        return;
      }

      const state: GeoGameState = JSON.parse(gameStateData.stateJson);
      state.currentRoundIndex++;
      state.phase = 'PROMPT';

      // Check if game ended
      if (state.currentRoundIndex >= state.questions.length) {
        await this.handleGameEnd(io, room, state);
        callback?.({ success: true, ended: true });
        return;
      }

      await prisma.roomGameState.update({
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(state),
          phase: 'PROMPT',
          revision: { increment: 1 },
        },
      });

      io.to(data.roomCode).emit('geo:next', {
        nextRoundIndex: state.currentRoundIndex,
        totalQuestions: state.questions.length,
      });

      // Start the round automatically
      await this.startRound(io, data.roomCode);

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo next error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  // ============================================================
  // End Game
  // ============================================================

  async handleGameEnd(io: Server, room: any, state: GeoGameState) {
    await prisma.room.update({
      where: { id: room.id },
      data: {
        status: 'ENDED',
        runPhase: 'RESULTS',
        endedAt: new Date(),
      },
    });

    await prisma.roomGameState.update({
      where: { roomId: room.id },
      data: { phase: 'GAME_END' },
    });

    // Get final scores
    const finalScores = Object.entries(state.scores)
      .map(([pid, score]) => ({ participationId: pid, score }))
      .sort((a, b) => b.score - a.score);

    io.to(room.code).emit('game:end', {
      roomCode: room.code,
      status: 'ENDED',
      runPhase: 'RESULTS',
      finalScores,
    });

    logger.info('Geo game ended', { roomId: room.id });
  },
};
