// ============================================================
// Geo Quiz Game Engine
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { finishRunningGame, saveGameStateIfRevision, upsertGameState } from '../core/state.js';
import { authorizeGameContext } from '../core/access.js';
import { gameErrorCode } from '../core/errors.js';
import { applyScoreDelta, recordScoreMutation } from '../core/score.js';
import { logger } from '../../observability/logger.js';
import { roomChannel } from '../../sockets/index.js';

interface GeoPlayerState {
  answered: boolean;
  selectedOptionId: string | null;
  locked: boolean;
  score: number;
  eliminatedOptions: string[];
  spyDistribution?: Record<string, number> | null;
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
  pauseRemainingMs: number | null;
  playerStates: Record<string, GeoPlayerState>;
  // P0-17: Store answers keyed by participationId for score updates
  answers: Record<string, { selectedOptionId: string; correct: boolean; bonus: number }>;
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

export function cancelGeoTimer(roomId: string): void {
  const timer = activeTimers.get(roomId);
  if (timer) clearTimeout(timer);
  activeTimers.delete(roomId);
}

// P0-16: Rekonstruiere aktive Timer nach Server-Restart aus der DB
export async function restoreActiveTimers(io: Server): Promise<void> {
  try {
    const roomsWithActiveRound = await prisma.room.findMany({
      where: { status: 'RUNNING', runPhase: 'ROUND_ACTIVE', gameDefinition: { slug: 'geo' } },
      include: {
        gameState: true,
      },
    });

    logger.info('P0-16: Restauriere aktive Timer', { count: roomsWithActiveRound.length });

    for (const room of roomsWithActiveRound) {
      try {
        if (!room.gameState) continue;
        const state: GeoGameState = JSON.parse(room.gameState.stateJson);
        if (state.phase !== 'INPUT_OPEN' || !state.roundStates || !Number.isInteger(state.currentRoundIndex)) continue;
        const roundState = state.roundStates[state.currentRoundIndex];
        if (!roundState || typeof roundState.timerEndMs !== 'number' || !Number.isFinite(roundState.timerEndMs)) continue;

        const remaining = roundState.timerEndMs - Date.now();
        if (remaining <= 0) {
          logger.info('P0-16: Timer bereits abgelaufen, beende Runde', { roomId: room.id });
          await handleGeoGame.handleTimerExpired(io, room);
          continue;
        }

        cancelGeoTimer(room.id);
        const timer = setTimeout(() => {
          activeTimers.delete(room.id);
          void handleGeoGame.handleTimerExpired(io, room).catch((error) => {
            logger.error('P0-16: Fehler beim Ablauf des restaurierten Timers', { roomId: room.id, error });
          });
        }, remaining);
        activeTimers.set(room.id, timer);
        logger.info('P0-16: Timer restauriert', { roomId: room.id, remainingMs: remaining });
      } catch (error) {
        logger.error('P0-16: Fehler beim Restaurieren eines Raum-Timers', { roomId: room.id, error });
      }
    }
  } catch (error) {
    logger.error('P0-16: Fehler beim Restaurieren der Timer', { error });
  }
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
      // P0-08: Get specific questions
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
    } else {
      // P0-08: No questions selected AND no pool - use default pool (first pack)
      const firstPack = await prisma.questionPack.findFirst({
        where: { gameSlug: 'geo' },
        orderBy: { createdAt: 'asc' },
      });
      
      if (firstPack) {
        const geoQuestions = await prisma.geoQuestion.findMany({
          where: {
            packId: firstPack.id,
            enabled: true,
          },
          include: { pack: true },
        });
        
        const shuffled = geoQuestions.sort(() => Math.random() - 0.5);
        const count = setup.questionCount || 10;
        questions = shuffled.slice(0, Math.min(count, shuffled.length));
      }
    }

    // P0-08: Validate minimum 1 question before allowing game:start
    if (questions.length === 0) {
      io.to(roomChannel(room.id)).emit('game:start:error', {
        error: 'NO_QUESTIONS',
        message: 'Keine Fragen für dieses Spiel verfügbar',
      });
      logger.error('Geo game initialize failed: no questions', { roomId: room.id });
      throw new Error('NO_QUESTIONS');
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
        eliminatedOptions: [],
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

    // Save through the shared game-state core.
    await upsertGameState({
      roomId: room.id,
      engineVersion: 1,
      phase: initialPhase,
      state: gameState,
    });

    // Emit initial state
    io.to(roomChannel(room.id)).emit('geo:init', {
      questionCount: questions.length,
      phase: initialPhase,
    });

    // P0-09: DO NOT call startRound() here - only the INTRO timeout should trigger startRound()
    // The setTimeout in handleGameStart() for 'after 3 seconds' is the ONLY startRound trigger
    // Removed: await this.startRound(io, room);

    logger.info('Geo game initialized', { roomId: room.id, questionCount: questions.length });
  },

  // ============================================================
  // Start Round (show question)
  // ============================================================

  async startRound(io: Server, room: any) {
    // Accept either room object or roomCode string for backwards compat
    let roomRecord: any;
    let roomChannelName: string;
    
    if (typeof room === 'string') {
      // Backwards compat: passed roomCode string
      roomRecord = await prisma.room.findUnique({
        where: { code: room },
      });
      if (!roomRecord || roomRecord.status !== 'RUNNING') return;
      roomChannelName = roomChannel(roomRecord.id);
    } else {
      // Room object passed directly
      roomRecord = room;
      roomChannelName = roomChannel(roomRecord.id);
    }

    const gameStateData = await prisma.roomGameState.findUnique({
      where: { roomId: roomRecord.id },
    });

    if (!gameStateData) return;

    const state: GeoGameState = JSON.parse(gameStateData.stateJson);
    const question = state.questions[state.currentRoundIndex];

    if (!question) {
      const ended = await finishRunningGame<GeoGameState>({
        roomId: roomRecord.id, expectedRevision: gameStateData.revision,
      });
      if (ended.ended) await this.handleGameEnd(io, roomRecord, ended.state);
      return;
    }

    // Parse options
    const options = JSON.parse(question.options);

    // P0-16: Use setup.timerDuration (in seconds) or default to 20
    const setup = JSON.parse(roomRecord.setupSnapshotJson || '{}');
    const timerDuration = (setup.timerDuration || 20) * 1000; // Convert to ms
    const timerStartMs = Date.now();
    const timerEndMs = timerStartMs + timerDuration;

    // Create each player's round state before answers or jokers arrive.
    const players = await prisma.participation.findMany({
      where: { roomId: roomRecord.id, role: 'PLAYER' }, select: { id: true },
    });
    const playerStates: Record<string, GeoPlayerState> = {};
    for (const player of players) {
      playerStates[player.id] = {
        answered: false, selectedOptionId: null, locked: false,
        score: state.scores[player.id] ?? 0,
        eliminatedOptions: [],
        jokers: { used5050: false, usedSpy: false, usedRisk: false },
      };
    }

    // Initialize round state
    state.roundStates[state.currentRoundIndex] = {
      questionIndex: state.currentRoundIndex,
      question: {
        id: question.id,
        prompt: question.prompt,
        category: question.category,
        mediaType: question.mediaType,
        mediaAssetId: question.mediaAssetId,
        options: options.map((o: any) => ({ id: o.id, label: o.label || o.id, text: o.text, imageUrl: o.imageUrl })),
      },
      revealed: false,
      timerStartMs,
      timerEndMs,
      pauseRemainingMs: null,
      playerStates,
      answers: {},
    };

    state.phase = 'INPUT_OPEN';

    // A concurrent game:end must prevent both the state transition and event.
    await prisma.$transaction(async (tx) => {
      await saveGameStateIfRevision(tx, {
        roomId: roomRecord.id, expectedRevision: gameStateData.revision, state, phase: 'INPUT_OPEN',
      });
      const updated = await tx.room.updateMany({
        where: { id: roomRecord.id, status: 'RUNNING' },
        data: { runPhase: 'ROUND_ACTIVE', revision: { increment: 1 } },
      });
      if (updated.count !== 1) throw new Error('GAME_NOT_RUNNING');
    });

    // P0-04/P0-17: Emit 'geo:question' with correct structure (NO correctOptionId!)
    // P0-16: Include timerEndMs in geo:question event
    io.to(roomChannelName).emit('geo:question', {
      roundIndex: state.currentRoundIndex,
      totalQuestions: state.questions.length,
      question: {
        id: question.id,
        prompt: question.prompt,
        category: question.category,
        imageUrl: question.imageUrl || undefined,
        options: options.map((o: any) => ({ 
          id: o.id, 
          label: o.label || o.id, 
          text: o.text, 
          imageUrl: o.imageUrl || undefined 
        })),
        timerEndMs,
      },
      timerMs: timerDuration,
      timerEndMs,
    });

    // P0-16: Set server-side timeout to auto-close answers and reveal
    const existingTimer = activeTimers.get(roomRecord.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      activeTimers.delete(roomRecord.id);
      await this.handleTimerExpired(io, roomRecord);
    }, timerDuration);

    activeTimers.set(roomRecord.id, timer);

    logger.info('Geo round started', { roomId: roomRecord.id, round: state.currentRoundIndex, timerEndMs });
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
      if (roundState?.revealed || state.phase !== 'INPUT_OPEN') return;

      // Close input phase
      state.phase = 'INPUT_LOCKED';

      await prisma.$transaction(async (tx) => saveGameStateIfRevision(tx, {
        roomId: room.id, expectedRevision: gameStateData.revision, state, phase: 'INPUT_LOCKED',
      }));

      io.to(roomChannel(room.id)).emit('geo:timer-expired', {
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
  // Handle Answer (P0-10: Use socket identity not token)
  // ============================================================

  async handleAnswer(
    io: Server,
    socket: Socket,
    data: { questionIndex?: number; optionId: string },
    callback?: (result: any) => void
  ) {
    try {
      const auth = await authorizeGameContext(socket, {
        roles: ['PLAYER'], requireParticipation: true, gameSlug: 'geo', requireRunning: true,
      });
      if (!auth.ok) { callback?.({ success: false, error: auth.error }); return; }
      const participationId = auth.actor.participationId!;
      const room = auth.room;

      // P0-12: Atomare Antwort-Speicherung mit revision check (optimistic locking)
      const gameStateData = await prisma.$transaction(async (tx) => {
        const existing = await tx.roomGameState.findUnique({
          where: { roomId: room.id },
        });
        if (!existing) return null;

        const parsed: GeoGameState = JSON.parse(existing.stateJson);
        const roundState = parsed.roundStates[parsed.currentRoundIndex];
        const ps = roundState.playerStates[participationId];

        // P0-16: Check timer hasn't expired
        if (roundState.timerEndMs && Date.now() > roundState.timerEndMs) {
          throw new Error('TIME_EXPIRED');
        }

        // P0-10: Check player hasn't already answered
        const playerState = ps || {
          answered: false,
          selectedOptionId: null,
          locked: false,
          score: 0,
          eliminatedOptions: [],
          jokers: { used5050: false, usedSpy: false, usedRisk: false },
        };

        if (playerState.answered || playerState.locked) {
          throw new Error('ALREADY_ANSWERED');
        }

        // P0-10: Validate optionId is valid for current question
        const currentQuestion = parsed.questions[parsed.currentRoundIndex];
        const options = JSON.parse(currentQuestion.options);
        const validOptionIds = options.map((o: any) => o.id);
        if (!validOptionIds.includes(data.optionId)) {
          throw new Error('INVALID_OPTION');
        }

        // State mutation
        playerState.answered = true;
        playerState.selectedOptionId = data.optionId;
        roundState.playerStates[participationId] = playerState;

        await saveGameStateIfRevision(tx, {
          roomId: room.id, expectedRevision: existing.revision, state: parsed, phase: parsed.phase,
        });

        return { existing, roundIndex: parsed.currentRoundIndex };
      });

      if (!gameStateData) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND' });
        return;
      }

      const { roundIndex } = gameStateData;

      // All room members may know who has answered, but only moderators may
      // see the selected option before reveal. In particular, this must not
      // bypass the player-private Spy joker.
      io.to(roomChannel(room.id)).emit('geo:answered', {
        questionIndex: roundIndex,
        participantId: participationId,
        answered: true,
      });
      const roomSockets = await io.in(roomChannel(room.id)).fetchSockets();
      for (const moderator of roomSockets) {
        if (moderator.data.role === 'MODERATOR' && moderator.data.roomId === room.id) {
          moderator.emit('geo:answered:moderator', {
            questionIndex: roundIndex, participantId: participationId, optionId: data.optionId,
          });
        }
      }

      callback?.({ success: true });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'TIME_EXPIRED') {
        callback?.({ success: false, error: 'TIME_EXPIRED' });
        return;
      }
      if (msg === 'ALREADY_ANSWERED') {
        callback?.({ success: false, error: 'ALREADY_ANSWERED' });
        return;
      }
      if (msg === 'INVALID_OPTION') {
        callback?.({ success: false, error: 'INVALID_OPTION' });
        return;
      }
      logger.error('Geo answer error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
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
      const auth = await authorizeGameContext(socket, { roles: ['PLAYER'], requireParticipation: true, gameSlug: 'geo', requireRunning: true });
      if (!auth.ok) {
        callback?.({ success: false, error: auth.error });
        return;
      }
      const participation = await prisma.participation.findFirst({
        where: { id: auth.actor.participationId, roomId: auth.actor.roomId, role: 'PLAYER' },
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
      playerState.eliminatedOptions = eliminated;

      // P0-17: Keep original option IDs; mark eliminated with eliminated:true
      // Client renders all 4 options but crosses out eliminated ones
      // Labels stay A/B/C/D - don't renumber
      const optionsWithEliminated = options.map((o: any) => ({
        id: o.id,
        label: o.label || o.id,
        text: o.text,
        eliminated: eliminated.includes(o.id),
      }));

      await prisma.$transaction(async (tx) => saveGameStateIfRevision(tx, {
        roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
      }));
      const result = { roundIndex: state.currentRoundIndex, options: optionsWithEliminated, eliminated };
      socket.emit('geo:joker:5050:result', result);
      socket.emit('geo:joker:applied', { type: '5050', result });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo 50/50 joker error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
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
      const auth = await authorizeGameContext(socket, { roles: ['PLAYER'], requireParticipation: true, gameSlug: 'geo', requireRunning: true });
      if (!auth.ok) {
        callback?.({ success: false, error: auth.error });
        return;
      }
      const participation = await prisma.participation.findFirst({
        where: { id: auth.actor.participationId, roomId: auth.actor.roomId, role: 'PLAYER' },
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

      playerState.spyDistribution = distribution;

      await prisma.$transaction(async (tx) => saveGameStateIfRevision(tx, {
        roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
      }));
      const result = { roundIndex: state.currentRoundIndex, distribution };
      socket.emit('geo:joker:spy:result', result);
      socket.emit('geo:joker:applied', { type: 'spy', result });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo spy joker error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
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
      const auth = await authorizeGameContext(socket, { roles: ['PLAYER'], requireParticipation: true, gameSlug: 'geo', requireRunning: true });
      if (!auth.ok) {
        callback?.({ success: false, error: auth.error });
        return;
      }
      const participation = await prisma.participation.findFirst({
        where: { id: auth.actor.participationId, roomId: auth.actor.roomId, role: 'PLAYER' },
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

      await prisma.$transaction(async (tx) => saveGameStateIfRevision(tx, {
        roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
      }));
      const result = { roundIndex: state.currentRoundIndex, active: true };
      socket.emit('geo:joker:risk:result', result);
      socket.emit('geo:joker:applied', { type: 'risk', result });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo risk joker error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
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

        const auth = await authorizeGameContext(socket, {
          roles: ['MODERATOR'], requireParticipation: true, gameSlug: 'geo', requireRunning: true,
        });
        if (!auth.ok || auth.room.id !== roomRecord.id) {
          callback?.({ success: false, error: auth.ok ? 'WRONG_ROOM' : auth.error });
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
      // 4. Store answers in roundState.answers
      await prisma.$transaction(async (tx) => {
        // Calculate scores for each player
        for (const [pid, playerState] of Object.entries(roundState.playerStates)) {
          const ps = playerState as GeoPlayerState;
          if (!ps.answered) continue;

          const isCorrect = ps.selectedOptionId === question.correctOptionId;
          let points = 0;
          let bonus = 0;

          if (isCorrect) {
            // Points with potential risk multiplier
            let questionPoints = question.points || 100;
            if (ps.jokers.usedRisk) {
              questionPoints *= 2;
              bonus = questionPoints / 2;
            }
            points = questionPoints;
            state.scores = applyScoreDelta(state.scores, pid, points);
          } else {
            // Wrong answer
            let wrongPoints = question.wrongPoints || 0;
            if (ps.jokers.usedRisk) {
              wrongPoints *= 2;
              bonus = -Math.abs(wrongPoints);
            }
            points = wrongPoints;
            state.scores = applyScoreDelta(state.scores, pid, points);
          }

          // P0-17: Store answer in roundState.answers keyed by participationId
          roundState.answers[pid] = {
            selectedOptionId: ps.selectedOptionId!,
            correct: isCorrect,
            bonus,
          };

          await recordScoreMutation(tx, {
            roomId: room.id, participationId: pid, score: state.scores[pid],
            roundIndex: state.currentRoundIndex, delta: points,
            reason: isCorrect ? 'Richtige Antwort' : 'Falsche Antwort',
          });
        }

        // Mark round as revealed
        roundState.revealed = true;
        state.phase = 'REVEAL';

        // Update game state
        await saveGameStateIfRevision(tx, {
          roomId: room.id, expectedRevision: gameStateData.revision, state, phase: 'REVEAL',
        });

        await tx.room.update({
          where: { id: room.id },
          data: { runPhase: 'REVEAL', revision: { increment: 1 } },
        });
      });

      // P0-17: Cancel active timer if any
      const existingTimer = activeTimers.get(room.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        activeTimers.delete(room.id);
      }

      // P0-17: Get participation details for scores
      const participations = await prisma.participation.findMany({
        where: { roomId: room.id },
        select: { id: true, displayName: true, score: true },
      });

      // The answer becomes public only after the persisted REVEAL transition.
      io.to(roomChannel(room.id)).emit('geo:reveal', {
        roundIndex: state.currentRoundIndex,
        correctOptionId: question.correctOptionId,
        correctOptionText: correctOption?.text,
        explanation: question.explanation,
        scores: participations.map((p: any) => {
          const answer = roundState.answers[p.id];
          return {
            participationId: p.id,
            displayName: p.displayName,
            score: state.scores[p.id] || 0,
            correct: answer?.correct || false,
            bonus: answer?.bonus || 0,
          };
        }),
      });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo reveal error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
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
      const auth = await authorizeGameContext(socket, {
        roles: ['MODERATOR'], requireParticipation: true, gameSlug: 'geo', requireRunning: true,
      });
      if (!auth.ok || auth.room.id !== room.id) {
        callback?.({ success: false, error: auth.ok ? 'WRONG_ROOM' : auth.error });
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
      if (state.phase !== 'REVEAL') {
        callback?.({ success: false, error: 'INVALID_PHASE' });
        return;
      }
      state.currentRoundIndex++;
      state.phase = 'PROMPT';

      // Check if game ended
      if (state.currentRoundIndex >= state.questions.length) {
        const ended = await finishRunningGame<GeoGameState>({
          roomId: room.id, expectedRevision: gameStateData.revision, requiredPhase: 'REVEAL',
          nextState: (current) => ({ ...current, currentRoundIndex: current.currentRoundIndex + 1 }),
        });
        if (ended.ended) await this.handleGameEnd(io, room, ended.state);
        callback?.({ success: true, ended: true });
        return;
      }

      await prisma.$transaction(async (tx) => saveGameStateIfRevision(tx, {
        roomId: room.id, expectedRevision: gameStateData.revision, state, phase: 'PROMPT',
      }));

      // P0-04: Emit 'geo:next' (after reveal, to trigger next round)
      io.to(roomChannel(room.id)).emit('geo:next', {
        nextRoundIndex: state.currentRoundIndex,
        totalQuestions: state.questions.length,
      });

      // Start the round automatically
      await this.startRound(io, room);

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo next error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  },

  // ============================================================
  // Handle Pause (P0-20: Only visual, store remaining time)
  // ============================================================

  async handlePause(
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

      const auth = await authorizeGameContext(socket, {
        roles: ['MODERATOR'], requireParticipation: true, gameSlug: 'geo', requireRunning: true,
      });
      if (!auth.ok || auth.room.id !== room.id) {
        callback?.({ success: false, error: auth.ok ? 'WRONG_ROOM' : auth.error });
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
      const roundState = state.roundStates[state.currentRoundIndex];

      if (!roundState || !roundState.timerEndMs || state.phase !== 'INPUT_OPEN') {
        callback?.({ success: false, error: 'NO_ACTIVE_TIMER' });
        return;
      }

      // P0-20: Calculate remaining time and store it
      const pauseRemainingMs = Math.max(0, roundState.timerEndMs - Date.now());
      roundState.pauseRemainingMs = pauseRemainingMs;
      roundState.timerEndMs = null;
      state.phase = 'PAUSED';

      await prisma.$transaction(async (tx) => {
        await saveGameStateIfRevision(tx, {
          roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
        });
        const updated = await tx.room.updateMany({
          where: { id: room.id, revision: room.revision, status: 'RUNNING' },
          data: { runPhase: 'PAUSED', revision: { increment: 1 } },
        });
        if (updated.count !== 1) throw new Error('STATE_CONFLICT');
      });
      cancelGeoTimer(room.id);

      // Emit pause event
      io.to(roomChannel(room.id)).emit('geo:paused', {
        roundIndex: state.currentRoundIndex,
        remainingMs: pauseRemainingMs,
      });

      callback?.({ success: true, remainingMs: pauseRemainingMs });
    } catch (error) {
      logger.error('Geo pause error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  },

  // ============================================================
  // Handle Resume (P0-20: Use stored remaining time to set new timer)
  // ============================================================

  async handleResume(
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

      const auth = await authorizeGameContext(socket, {
        roles: ['MODERATOR'], requireParticipation: true, gameSlug: 'geo', requireRunning: true,
      });
      if (!auth.ok || auth.room.id !== room.id) {
        callback?.({ success: false, error: auth.ok ? 'WRONG_ROOM' : auth.error });
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
      const roundState = state.roundStates[state.currentRoundIndex];

      if (!roundState || roundState.pauseRemainingMs === null || state.phase !== 'PAUSED') {
        callback?.({ success: false, error: 'NOT_PAUSED' });
        return;
      }

      // P0-20: Capture remaining time BEFORE clearing pause state
      const remainingTime = Math.max(1, roundState.pauseRemainingMs);
      roundState.pauseRemainingMs = null;
      const newTimerEndMs = Date.now() + remainingTime;
      roundState.timerEndMs = newTimerEndMs;
      state.phase = 'INPUT_OPEN';
      await prisma.$transaction(async (tx) => {
        await saveGameStateIfRevision(tx, {
          roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
        });
        const updated = await tx.room.updateMany({
          where: { id: room.id, revision: room.revision, status: 'RUNNING', runPhase: 'PAUSED' },
          data: { runPhase: 'ROUND_ACTIVE', revision: { increment: 1 } },
        });
        if (updated.count !== 1) throw new Error('STATE_CONFLICT');
      });
      const existingTimer = activeTimers.get(room.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(async () => {
        activeTimers.delete(room.id);
        await this.handleTimerExpired(io, room);
      }, remainingTime);

      activeTimers.set(room.id, timer);

      io.to(roomChannel(room.id)).emit('geo:resumed', { timerEndMs: newTimerEndMs });
      callback?.({ success: true, timerEndMs: newTimerEndMs });
    } catch (error) {
      logger.error('Geo resume error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
  },

  // ============================================================
  // End Game
  // ============================================================

  async end(io: Server, room: { id: string; code: string }): Promise<{ ended: boolean }> {
    const result = await finishRunningGame<GeoGameState>({ roomId: room.id });
    if (result.ended) await this.handleGameEnd(io, room, result.state);
    return { ended: result.ended };
  },

  async handleGameEnd(io: Server, room: any, _state: GeoGameState) {
    cancelGeoTimer(room.id);

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

    io.to(roomChannel(room.id)).emit('game:end', {
      roomCode: room.code,
      status: 'ENDED',
      runPhase: 'RESULTS',
      finalScores,
    });

    logger.info('Geo game ended', { roomId: room.id });
  },
};
