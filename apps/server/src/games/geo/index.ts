// ============================================================
// Geo Quiz Game Engine
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { requireRoomRole } from '../../http/middleware/auth.js';

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

// Store active timer handles per roomCode (for cancellation)
const activeTimers = new Map<string, NodeJS.Timeout>();

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

    // P0-03: Automatically start the first round after initialization
    // Pass room object so startRound can use it directly
    await this.startRound(io, room);

    logger.info('Geo game initialized', { roomId: room.id, questionCount: questions.length });
  },

  // ============================================================
  // Start Round (show question)
  // ============================================================

  async startRound(io: Server, room: any) {
    // Accept either room object or roomCode string for backwards compat
    const roomCode = typeof room === 'string' ? room : room.code;

    const roomRecord = await prisma.room.findUnique({
      where: { code: roomCode },
    });

    if (!roomRecord) return;

    const gameStateData = await prisma.roomGameState.findUnique({
      where: { roomId: roomRecord.id },
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

    // P0-16: Calculate server-side timer
    const timerMs = question.durationMs || 20000;
    const timerStartMs = Date.now();
    const timerEndMs = timerStartMs + timerMs;

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
      timerStartMs,
      timerEndMs,
      buzzWinnerId: null,
      buzzOpen: false,
      playerStates: {},
      spyDistribution: null,
    };

    state.phase = 'INPUT_OPEN';

    // Update database
    await prisma.roomGameState.update({
      where: { roomId: roomRecord.id },
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

    // P0-04: Emit 'geo:question' (not 'geo:show')
    io.to(roomCode).emit('geo:question', {
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
      timerEndMs,
      totalQuestions: state.questions.length,
    });

    // P0-16: Set server-side timeout to auto-close answers
    const existingTimer = activeTimers.get(roomCode);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      activeTimers.delete(roomCode);
      await this.handleTimerExpired(io, roomRecord);
    }, timerMs);

    activeTimers.set(roomCode, timer);

    logger.info('Geo round started', { roomCode, round: state.currentRoundIndex, timerEndMs });
  },

  // ============================================================
  // Timer Expired Handler (P0-16)
  // ============================================================

  async handleTimerExpired(io: Server, room: any) {
    try {
      const gameStateData = await prisma.roomGameState.findUnique({
        where: { roomId: room.id },
      });

      if (!gameStateData) return;

      const state: GeoGameState = JSON.parse(gameStateData.stateJson);
      const roundState = state.roundStates[state.currentRoundIndex];

      // Skip if already revealed
      if (roundState?.revealed) return;

      // Close input phase
      state.phase = 'INPUT_LOCKED';

      await prisma.roomGameState.update({
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(state),
          phase: 'INPUT_LOCKED',
          revision: { increment: 1 },
        },
      });

      io.to(room.code).emit('geo:timer-expired', {
        roundIndex: state.currentRoundIndex,
      });

      // Auto-reveal after timer
      await this.handleReveal(io, null as any, { roomCode: room.code });

      logger.info('Geo timer expired', { roomCode: room.code, round: state.currentRoundIndex });
    } catch (error) {
      logger.error('Geo timer expiry error', { error });
    }
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
      // P0-04: Validate rejoinToken belongs to THIS room
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

      // P0-04: Ensure participation belongs to the requested room
      if (participation.room.code !== data.roomCode) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
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

      // P0-04: Validate round is active (not revealed, timer not expired)
      if (state.phase !== 'INPUT_OPEN') {
        callback?.({ success: false, error: 'INPUT_CLOSED' });
        return;
      }

      // P0-16: Check timer hasn't expired
      if (roundState.timerEndMs && Date.now() > roundState.timerEndMs) {
        callback?.({ success: false, error: 'TIME_EXPIRED' });
        return;
      }

      // P0-04: Check player hasn't already answered
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

      // P0-04: Validate optionId is valid for current question
      const currentQuestion = state.questions[state.currentRoundIndex];
      const options = JSON.parse(currentQuestion.options);
      const validOptionIds = options.map((o: any) => o.id);
      if (!validOptionIds.includes(data.optionId)) {
        callback?.({ success: false, error: 'INVALID_OPTION' });
        return;
      }

      // Check if risk joker active (usedRisk = playerState.jokers.usedRisk)

      // Update player state
      playerState.answered = true;
      playerState.selectedOptionId = data.optionId;

      roundState.playerStates[participation.id] = playerState;

      // P0-04: Broadcast using correct event name
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

      if (participation.room.code !== data.roomCode) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
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

      // P0-05: Keep original option IDs; mark eliminated with hidden:true
      const optionsWithHidden = options.map((o: any) => ({
        id: o.id,
        text: o.text,
        hidden: eliminated.includes(o.id),
      }));

      // Send full options list with hidden flags to this player only (private)
      socket.emit('geo:joker:5050:result', {
        roundIndex: state.currentRoundIndex,
        options: optionsWithHidden,
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

      if (participation.room.code !== data.roomCode) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
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

      // Calculate distribution (from roundState, not question options)
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
        roundIndex: state.currentRoundIndex,
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

      if (participation.room.code !== data.roomCode) {
        callback?.({ success: false, error: 'WRONG_ROOM' });
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
        roundIndex: state.currentRoundIndex,
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
  // Handle Reveal (Moderator) - P0-17 Idempotency + Authorization
  // ============================================================

  async handleReveal(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void
  ) {
    try {
      // P0-17: Authorization check
      if (socket) {
        const roomRecord = await prisma.room.findUnique({
          where: { code: data.roomCode },
        });
        if (!roomRecord) {
          callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
          return;
        }

        const authorized = await requireRoomRole(socket, roomRecord.id, 'MODERATOR');
        if (!authorized) {
          callback?.({ success: false, error: 'UNAUTHORIZED' });
          return;
        }
      }

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

      // P0-17: Idempotency check - return ALREADY_REVEALED if already revealed
      if (roundState.revealed) {
        callback?.({ success: false, error: 'ALREADY_REVEALED' });
        return;
      }

      // Parse options and find correct
      const options = JSON.parse(question.options);
      const correctOption = options.find((o: any) => o.id === question.correctOptionId);

      // P0-17: Use Prisma transaction to atomically:
      // 1. Mark round as revealed
      // 2. Calculate and update scores
      // 3. Create ScoreEvents
      await prisma.$transaction(async (tx) => {
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
          await tx.participation.update({
            where: { id: pid },
            data: { score: state.scores[pid] },
          });

          // Create score event
          await tx.scoreEvent.create({
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

        // Mark round as revealed
        roundState.revealed = true;
        state.phase = 'REVEAL';

        // Update game state
        await tx.roomGameState.update({
          where: { roomId: room.id },
          data: {
            stateJson: JSON.stringify(state),
            phase: 'REVEAL',
            revision: { increment: 1 },
          },
        });

        await tx.room.update({
          where: { code: data.roomCode },
          data: { runPhase: 'REVEAL', revision: { increment: 1 } },
        });
      });

      // Cancel active timer if any
      const existingTimer = activeTimers.get(data.roomCode);
      if (existingTimer) {
        clearTimeout(existingTimer);
        activeTimers.delete(data.roomCode);
      }

      // P0-04: Emit 'geo:reveal' with correctOptionId and scores
      io.to(data.roomCode).emit('geo:reveal', {
        roundIndex: state.currentRoundIndex,
        correctOptionId: question.correctOptionId,
        correctOptionText: correctOption?.text,
        explanation: question.explanation,
        scores: Object.entries(state.scores).map(([participationId, totalScore]) => ({
          participationId,
          totalScore,
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

      // P0-17: Authorization check
      const authorized = await requireRoomRole(socket, room.id, 'MODERATOR');
      if (!authorized) {
        callback?.({ success: false, error: 'UNAUTHORIZED' });
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

      // P0-04: Emit 'geo:next' (after reveal, to trigger next round)
      io.to(data.roomCode).emit('geo:next', {
        nextRoundIndex: state.currentRoundIndex,
        totalQuestions: state.questions.length,
      });

      // Start the round automatically
      await this.startRound(io, room);

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo next error', { error });
      callback?.({ success: false, error: 'INTERNAL_ERROR' });
    }
  },

  // ============================================================
  // End Game
  // ============================================================

  async handleGameEnd(io: Server, room: any, _state: GeoGameState) {
    // Cancel any active timer
    const existingTimer = activeTimers.get(room.code);
    if (existingTimer) {
      clearTimeout(existingTimer);
      activeTimers.delete(room.code);
    }

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

    // Get final scores with participation details
    const participations = await prisma.participation.findMany({
      where: { roomId: room.id },
      select: { id: true, displayName: true, score: true },
    });

    const finalScores = participations
      .map(p => ({ 
        participationId: p.id, 
        displayName: p.displayName,
        score: p.score,
      }))
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
