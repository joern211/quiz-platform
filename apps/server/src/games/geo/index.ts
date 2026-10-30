import { refreshLiveMedia } from '../../media/live.js';
// ============================================================
// Geo Quiz Game Engine
// ============================================================

import { Server, Socket } from 'socket.io';
import { roomContentMediaUrl } from '../../content/media.js';
import { readPinnedContent } from '../../content/core.js';
import { prisma } from '../../persistence/prisma.js';
import { resolveCanonicalSlug, slugWithLegacy, type CoreTimer, type SubmissionRecord, type CoreRoundTransition } from '@quiz/shared';
import { createTimer, legacyRoundTimer, timerAcceptsInput, pauseTimer, resumeTimer, endTimer, submitOnce, lockSubmission, judgeSubmission, scoreJudgement } from '../core/runtimePrimitives.js';
import { advanceRound, matchAnswer, shuffleServer } from '../core/roundFlow.js';
import { transitionRoundState } from '../core/roundTransition.js';
import { resolveTie } from '../core/tie.js';
import { ensureGameStateSafe } from '../core/recovery.js';
import { finishRunningGame, saveGameStateIfRevision, upsertGameState } from '../core/state.js';
import { withoutCommandExecution } from '../core/commandExecution.js';
import { loadGameConfig, loadInitialGameCount, loadInitialTieStrategy } from '../core/config.js';
import { authorizeGameContext } from '../core/access.js';
import { gameErrorCode } from '../core/errors.js';
import { serializeRoom } from '../../rooms/queue.js';
import { feed } from '../../rooms/core.js';
import { changed } from '../../rooms/socket.js';
import { applyScoreDelta, recordScoreMutation } from '../core/score.js';
import { logger } from '../../observability/logger.js';
import { roomChannel } from '../../sockets/index.js';

interface GeoPlayerState {
  submission?: SubmissionRecord;
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
  timer?: CoreTimer;
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
  contentRunIndex?: number;
  tieStrategy?: 'ALLOW_TIE';
  lastRoundTransition?: CoreRoundTransition;
  phase: string;
  currentRoundIndex: number;
  questions: any[];
  roundStates: Record<number, GeoRoundState>;
  scores: Record<string, number>;
  recoveryError?: 'CONFIG_SNAPSHOT_INVALID';
}

// Store active timer handles by persistent roomId (for cancellation).
const activeTimers = new Map<string, NodeJS.Timeout>();

export function cancelGeoTimer(roomId: string): void {
  const timer = activeTimers.get(roomId);
  if (timer) clearTimeout(timer);
  activeTimers.delete(roomId);
}

/** Intro transitions share the same cancellable lifecycle as round timers. */
export async function scheduleGeoIntro(roomId: string, start: () => Promise<void>): Promise<void> {
  return serializeRoom(roomId, async () => {
  const room = await prisma.room.findUnique({ where: { id: roomId }, include: { gameState: true } });
  if (!room || room.status !== 'RUNNING' || room.gameState?.phase !== 'INTRO') return;
  cancelGeoTimer(roomId);
  const revision = room.gameState.revision;
  const handle = withoutCommandExecution(() => setTimeout(() => {
    if (activeTimers.get(roomId) !== handle) return;
    activeTimers.delete(roomId);
    void serializeRoom(roomId, async () => {
      const live = await prisma.room.findUnique({ where: { id: roomId }, include: { gameState: true } });
      if (live?.status === 'RUNNING' && live.runIndex === room.runIndex && live.gameState?.phase === 'INTRO' && live.gameState.revision === revision) await start();
    }).catch(error => logger.error('Geo intro failed', { roomId, error }));
  }, 3000));
  activeTimers.set(roomId, handle);
  });
}

/** Keep native timer installation/cancellation in the same room lease as its
 * persisted transition. The existing queue is reentrant; DB CAS/fences remain
 * authoritative across processes. */
function serializeGeoAction<T>(socket: Socket | null, work: () => Promise<T>): Promise<T> {
  return socket?.data.roomId ? serializeRoom(socket.data.roomId, work) : work();
}

interface GeoDeadline { runIndex: number; roundIndex: number; endsAtMs: number }

/** A dequeued callback may outlive clearTimeout; bind it to its persisted round. */
function scheduleGeoDeadline(io: Server, room: { id: string; code: string }, deadline: GeoDeadline): void {
  cancelGeoTimer(room.id);
  const handle = withoutCommandExecution(() => setTimeout(async () => {
    if (activeTimers.get(room.id) !== handle) return;
    activeTimers.delete(room.id);
    await handleGeoGame.handleTimerExpired(io, room, deadline).catch(error =>
      logger.error('Geo timer failed', { roomId: room.id, error }));
  }, Math.max(0, deadline.endsAtMs - Date.now())));
  activeTimers.set(room.id, handle);
}

/** Test-Hook: IDs der Räume mit aktuell gesetztem (in-Memory) Timer. */
export function __activeTimerRoomIdsForTest(): string[] {
  return [...activeTimers.keys()];
}

// P0-16: Rekonstruiere aktive Timer nach Server-Restart aus der DB.
// Filtert über die kanonische Identität UND erkannte Legacy-Slugs (z.B. "geo"):
// Solange die Migration noch nicht lief oder fehlgeschlagen ist, tragen aktive
// Räume ggf. den Legacy-Slug — die Timer müssen in beiden Fällen laufen.
export async function restoreActiveTimers(io: Server): Promise<void> {
  try {
    const slugFilter = slugWithLegacy(resolveCanonicalSlug('geo')!);
    const roomsWithActiveRound = await prisma.room.findMany({
      where: {
        status: 'RUNNING',
        gameDefinition: { slug: { in: slugFilter } },
      },
      include: {
        gameState: true,
      },
    });

    logger.info('P0-16: Restauriere aktive Timer', { count: roomsWithActiveRound.length });

    for (const candidate of roomsWithActiveRound) {
      try {
        await serializeRoom(candidate.id, async () => {
        const room = await prisma.room.findFirst({ where: { id: candidate.id, status: 'RUNNING', gameDefinition: { slug: { in: slugFilter } } }, include: { gameState: true } });
        if (!room?.gameState) return;
        await ensureGameStateSafe(room.id);
        const state: GeoGameState = JSON.parse(room.gameState.stateJson);
        if (['INTRO', 'PROMPT'].includes(state.phase)) {
          await handleGeoGame.startRound(io, room);
          return;
        }
        const round = state.roundStates[state.currentRoundIndex];
        if (state.phase === 'INPUT_LOCKED' && round && !round.revealed && typeof round.timerEndMs === 'number' && round.timerEndMs <= Date.now()) {
          await handleGeoGame.handleReveal(io, null as unknown as Socket, { roomCode: room.code }, undefined,
            { runIndex: room.runIndex, roundIndex: state.currentRoundIndex, endsAtMs: round.timerEndMs });
          return;
        }
        if (state.phase !== 'INPUT_OPEN') return;
        if (!round) return;
        const timer = legacyRoundTimer(round, state.phase);
        if (timer.status !== 'RUNNING' || timer.endsAtMs === null) return;
        const deadline = { runIndex: room.runIndex, roundIndex: state.currentRoundIndex, endsAtMs: timer.endsAtMs };
        if (timer.endsAtMs <= Date.now()) await handleGeoGame.handleTimerExpired(io, room, deadline);
        else scheduleGeoDeadline(io, room, deadline);
        });
      } catch (error) {
        logger.error('P0-16: Fehler beim Restaurieren eines Raum-Timers', { roomId: candidate.id, error });
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
    const questionCount = await loadInitialGameCount(room.id, 'wissensduell', 'questionCount');
    
    // Get questions based on setup
    let questions: any[] = [];
    
    const pinned = await readPinnedContent(room.id);
    if (pinned.length) {
      questions = pinned.map(q => ({ ...q.payload, id: q.id, contentRevision: q.revision, options: JSON.stringify(q.payload.options) }));
    } else if (setup.selectedQuestionIds && setup.selectedQuestionIds.length > 0) {
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
      const shuffled = shuffleServer(geoQuestions);
      const count = questionCount;
      questions = shuffled.slice(0, Math.min(count, shuffled.length));
    } else {
      // P0-08: No questions selected AND no pool - use default pool (first pack)
      const firstPack = await prisma.questionPack.findFirst({
        where: { gameSlug: resolveCanonicalSlug('geo')! },
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
        
        const shuffled = shuffleServer(geoQuestions);
        const count = questionCount;
        questions = shuffled.slice(0, Math.min(count, shuffled.length));
      }
    }

    questions = questions.slice(0, questionCount);

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
      where: { roomId: room.id, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, kickedAt: null, bannedAt: null },
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
      contentRunIndex: (await prisma.room.findUniqueOrThrow({ where: { id: room.id }, select: { runIndex: true } })).runIndex,
      tieStrategy: await loadInitialTieStrategy(room.id, 'wissensduell'),
      phase: initialPhase,
      currentRoundIndex: 0,
      questions,
      roundStates: {},
      scores,
    };

    // Save through the shared game-state core.
    await upsertGameState({ gameSlug: 'wissensduell',
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

    // Initialization persists INTRO. The registry owns its live delay; restart
    // restoration may open an interrupted INTRO without repeating initialization.

    logger.info('Geo game initialized', { roomId: room.id, questionCount: questions.length });
  },

  // ============================================================
  // Start Round (show question)
  // ============================================================

  async startRound(io: Server, room: string | { id: string }, transition?: { expectedRevision: number; prepared: GeoGameState }): Promise<boolean> {
    const target = typeof room === 'string' ? await prisma.room.findUnique({ where: { code: room }, select: { id: true } }) : room;
    if (!target) return false;
    return serializeRoom(target.id, async () => {
    const roomRecord = await prisma.room.findUnique({ where: typeof room === 'string' ? { code: room } : { id: room.id } });
    if (!roomRecord || roomRecord.status !== 'RUNNING') return false;
    const roomChannelName = roomChannel(roomRecord.id);
    const gameStateData = await prisma.roomGameState.findUnique({ where: { roomId: roomRecord.id } });
    if (!gameStateData) return false;
    const persisted: GeoGameState = JSON.parse(gameStateData.stateJson);
    if (transition) {
      if (gameStateData.revision !== transition.expectedRevision || persisted.phase !== 'REVEAL') return false;
    } else if (!['INTRO', 'PROMPT'].includes(persisted.phase)) return false;
    const state = transition?.prepared ?? persisted;
    const question = state.questions[state.currentRoundIndex];

    if (!question) {
      const ended = await finishRunningGame<GeoGameState>({ gameSlug: 'wissensduell',
        roomId: roomRecord.id, expectedRevision: gameStateData.revision,
      });
      if (ended.ended) await this.handleGameEnd(io, roomRecord, ended.state);
      return false;
    }

    // Parse options
    const options = JSON.parse(question.options);

    // BASIS-STANDARDS (E) + Audit PR14, 14-04 (Nacharbeit): Timer kommt aus
    // der zentralen Config-Auflösung (Start-Snapshot, falls vorhanden;
    // sonst Legacy-Setup via loadGameConfig, die setup.timerDuration in
    // Sekunden → ms umrechnet und den zentralen Default 20000 ms anwendet).
    // Der KANONISCHE Slug wird übergeben — der Reader normalisiert Legacy
    // intern; der Geo-Reader darf keine eigene Slug-Anlage mehr pflegen.
    //
    // Never replace an incompatible snapshot with today's defaults. Persist
    // a safe recovery state so reconnects/restarts retain the failure and the
    // host can end the game without exposing configuration or solutions.
    let timerDuration: number;
    try {
      const loaded = await loadGameConfig(roomRecord, 'wissensduell');
      timerDuration = loaded?.values.timerDurationMs?.value as number;
      if (typeof timerDuration !== 'number' || !Number.isFinite(timerDuration) || timerDuration <= 0) {
        throw new Error(`CONFIG_SNAPSHOT_INVALID: nicht gültiger timerDurationMs-Wert (${String(timerDuration)})`);
      }
    } catch (error) {
      // No new round or scoring; enter a durable, read-only recovery phase.
      logger.error('Geo startRound: ungültige Spielkonfiguration — Runde wird nicht gestartet (14-04)', {
        roomId: roomRecord.id,
        error: error instanceof Error ? error.message : String(error),
      });
      state.phase = 'ERROR_RECOVERY';
      state.recoveryError = 'CONFIG_SNAPSHOT_INVALID';
      await prisma.$transaction(async (tx) => {
        await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
          roomId: roomRecord.id, expectedRevision: gameStateData.revision,
          state, phase: 'ERROR_RECOVERY',
        });
        const updated = await tx.room.updateMany({
          where: { id: roomRecord.id, status: 'RUNNING', revision: roomRecord.revision },
          data: { runPhase: 'ERROR_RECOVERY', revision: { increment: 1 } },
        });
        if (updated.count !== 1) throw new Error('STATE_CONFLICT');
      });
      cancelGeoTimer(roomRecord.id);
      io.to(roomChannelName).emit('geo:round:error', { error: state.recoveryError });
      return false;
    }
    const timer = createTimer('COUNTDOWN', Date.now(), timerDuration);
    const timerStartMs = timer.startedAtMs!;
    const timerEndMs = timer.endsAtMs!;

    // Create each player's round state before answers or jokers arrive.
    const players = await prisma.participation.findMany({
      where: { roomId: roomRecord.id, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, kickedAt: null, bannedAt: null }, select: { id: true },
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
      timer,
      pauseRemainingMs: null,
      playerStates,
      answers: {},
    };

    state.phase = 'INPUT_OPEN';
    delete state.recoveryError;

    // A concurrent game:end must prevent both the state transition and event.
    await prisma.$transaction(async (tx) => {
      await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
        roomId: roomRecord.id, expectedRevision: gameStateData.revision, state, phase: 'INPUT_OPEN',
      });
      const updated = await tx.room.updateMany({
        where: { id: roomRecord.id, status: 'RUNNING', runIndex: roomRecord.runIndex, revision: roomRecord.revision },
        data: { runPhase: 'ROUND_ACTIVE', revision: { increment: 1 } },
      });
      if (updated.count !== 1) throw new Error('GAME_NOT_RUNNING');
    });

    if (transition) io.to(roomChannelName).emit('geo:next', {
      nextRoundIndex: state.currentRoundIndex, totalQuestions: state.questions.length,
    });

    // P0-04/P0-17: Emit 'geo:question' with correct structure (NO correctOptionId!)
    // P0-16: Include timerEndMs in geo:question event
    await refreshLiveMedia(io);
    io.to(roomChannelName).emit('geo:question', {
      roundIndex: state.currentRoundIndex,
      totalQuestions: state.questions.length,
      question: {
        id: question.id,
        prompt: question.prompt,
        category: question.category,
        imageUrl: question.imageUrl || undefined,
        mediaType: question.mediaType,
        mediaUrl: roomContentMediaUrl(roomRecord.id, state.contentRunIndex, question.id, question.mediaAssetId),
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

    scheduleGeoDeadline(io, roomRecord, { runIndex: roomRecord.runIndex, roundIndex: state.currentRoundIndex, endsAtMs: timerEndMs });

    logger.info('Geo round started', { roomId: roomRecord.id, round: state.currentRoundIndex, timerEndMs });
    return true;
    });
  },

  // ============================================================
  // Timer Expired Handler (P0-16)
  // ============================================================

  async handleTimerExpired(io: Server, room: { id: string; code: string }, expected?: GeoDeadline) {
    return serializeRoom(room.id, async () => {
    try { await ensureGameStateSafe(room.id); }
    catch (error) {
      if (gameErrorCode(error) === 'STATE_INVARIANT_FAILED') io.to(roomChannel(room.id)).emit('game:core:changed');
      throw error;
    }
    try {
      const result = await prisma.$transaction(async tx => {
        const live = await tx.room.findUnique({ where: { id: room.id } });
        const row = await tx.roomGameState.findUnique({ where: { roomId: room.id } });
        if (!live || live.status !== 'RUNNING' || !row) return null;
        const state: GeoGameState = JSON.parse(row.stateJson);
        const round = state.roundStates[state.currentRoundIndex];
        if (state.phase !== 'INPUT_OPEN' || !round || round.revealed) return null;
        const timer = legacyRoundTimer(round, state.phase);
        if (timer.status !== 'RUNNING' || timer.endsAtMs === null) return null;
        const deadline = { runIndex: live.runIndex, roundIndex: state.currentRoundIndex, endsAtMs: timer.endsAtMs };
        if (expected && (expected.runIndex !== deadline.runIndex || expected.roundIndex !== deadline.roundIndex || expected.endsAtMs !== deadline.endsAtMs)) return null;
        const now = Date.now();
        if (now < timer.endsAtMs) return { expired: false as const, deadline };
        state.phase = 'INPUT_LOCKED';
        round.timer = endTimer(timer, now);
        for (const player of Object.values(round.playerStates)) if (player.submission) player.submission = lockSubmission(player.submission);
        await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell', roomId: room.id, expectedRevision: row.revision, state, phase: 'INPUT_LOCKED' });
        return { expired: true as const, deadline };
      });
      if (!result) return;
      if (!result.expired) { scheduleGeoDeadline(io, room, result.deadline); return; }
      cancelGeoTimer(room.id);
      io.to(roomChannel(room.id)).emit('geo:timer-expired', { roundIndex: result.deadline.roundIndex });
      await this.handleReveal(io, null as unknown as Socket, { roomCode: room.code }, undefined, result.deadline);
    } catch (error) { logger.error('Geo timer expiry error', { error }); }
    });
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
    return serializeGeoAction(socket, async () => {
    try {
      const auth = await authorizeGameContext(socket, {
        roles: ['PLAYER'], requireParticipation: true, gameSlug: resolveCanonicalSlug('geo')!, requireRunning: true,
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
        if (parsed.phase !== 'INPUT_OPEN' || !roundState || roundState.revealed) throw new Error('INVALID_PHASE');
        const ps = roundState.playerStates[participationId];

        // P0-16: Check timer hasn't expired
        const timer = legacyRoundTimer(roundState, parsed.phase);
        const now = Date.now();
        if (!timerAcceptsInput(timer, now)) {
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
        playerState.submission = submitOnce({ previous: playerState.submission, participantId: participationId, roundId: String(parsed.currentRoundIndex), value: data.optionId, timer, now });
        playerState.answered = true;
        playerState.selectedOptionId = data.optionId;
        roundState.playerStates[participationId] = playerState;

        await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
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
        if (room.contentVisibility !== 'BLIND_HOST' && moderator.data.role === 'HOST' && moderator.data.roomId === room.id && moderator.data.userId === room.hostUserId) {
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
    });
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
    return serializeGeoAction(socket, async () => {
    try {
      const auth = await authorizeGameContext(socket, { roles: ['PLAYER'], requireParticipation: true, gameSlug: resolveCanonicalSlug('geo')!, requireRunning: true });
      if (!auth.ok) {
        callback?.({ success: false, error: auth.error });
        return;
      }
      const participation = await prisma.participation.findFirst({
        where: { id: auth.actor.participationId, roomId: auth.actor.roomId, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, kickedAt: null, bannedAt: null },
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
      const shuffled = shuffleServer(wrongOptions);
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

      await prisma.$transaction(async tx => {
        if (state.phase !== 'INPUT_OPEN' || !timerAcceptsInput(legacyRoundTimer(roundState, state.phase), Date.now())) throw new Error('TIME_EXPIRED');
        await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
          roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
        });
      });
      const result = { roundIndex: state.currentRoundIndex, options: optionsWithEliminated, eliminated };
      socket.emit('geo:joker:5050:result', result);
      socket.emit('geo:joker:applied', { type: '5050', result });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo 50/50 joker error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
    });
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
    return serializeGeoAction(socket, async () => {
    try {
      const auth = await authorizeGameContext(socket, { roles: ['PLAYER'], requireParticipation: true, gameSlug: resolveCanonicalSlug('geo')!, requireRunning: true });
      if (!auth.ok) {
        callback?.({ success: false, error: auth.error });
        return;
      }
      const participation = await prisma.participation.findFirst({
        where: { id: auth.actor.participationId, roomId: auth.actor.roomId, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, kickedAt: null, bannedAt: null },
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

      await prisma.$transaction(async (tx) => saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
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
    });
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
    return serializeGeoAction(socket, async () => {
    try {
      const auth = await authorizeGameContext(socket, { roles: ['PLAYER'], requireParticipation: true, gameSlug: resolveCanonicalSlug('geo')!, requireRunning: true });
      if (!auth.ok) {
        callback?.({ success: false, error: auth.error });
        return;
      }
      const participation = await prisma.participation.findFirst({
        where: { id: auth.actor.participationId, roomId: auth.actor.roomId, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, kickedAt: null, bannedAt: null },
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

      await prisma.$transaction(async tx => {
        if (state.phase !== 'INPUT_OPEN' || !timerAcceptsInput(legacyRoundTimer(roundState, state.phase), Date.now())) throw new Error('TIME_EXPIRED');
        await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
          roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
        });
      });
      const result = { roundIndex: state.currentRoundIndex, active: true };
      socket.emit('geo:joker:risk:result', result);
      socket.emit('geo:joker:applied', { type: 'risk', result });

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo risk joker error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
    });
  },

  // ============================================================
  // Handle Reveal (Moderator) - P0-17 Idempotency + Authorization
  // ============================================================

  async handleReveal(
    io: Server,
    socket: Socket,
    data: { roomCode: string },
    callback?: (result: any) => void,
    expected?: GeoDeadline,
  ) {
    return serializeGeoAction(socket, async () => {
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
          roles: ['HOST'], requireParticipation: true, gameSlug: resolveCanonicalSlug('geo')!, requireRunning: true, controlPermission: 'REVEAL_CONTENT',
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
      if (room.status !== 'RUNNING') return;
      if (expected && (room.runIndex !== expected.runIndex || state.currentRoundIndex !== expected.roundIndex || state.phase !== 'INPUT_LOCKED')) return;
      const question = state.questions[state.currentRoundIndex];
      const roundState = state.roundStates[state.currentRoundIndex];

      if (expected && roundState.timerEndMs !== expected.endsAtMs) return;

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

          const match = matchAnswer(ps.selectedOptionId, question.correctOptionId, 'EXACT');
          const isCorrect = match === 'MATCH';
          if (ps.submission) ps.submission.matchStatus = match;
          if (ps.submission) ps.submission = judgeSubmission(ps.submission, isCorrect ? 'CORRECT' : 'WRONG', Date.now());
          let points = 0;
          let bonus = 0;

          if (isCorrect) {
            // Points with potential risk multiplier
            let questionPoints = question.points ?? 100;
            if (ps.jokers.usedRisk) {
              questionPoints *= 2;
              bonus = questionPoints / 2;
            }
            points = scoreJudgement('CORRECT', { correct: questionPoints, wrong: 0 });
            state.scores = applyScoreDelta(state.scores, pid, points);
          } else {
            // Wrong answer
            let wrongPoints = question.wrongPoints || 0;
            if (ps.jokers.usedRisk) {
              wrongPoints *= 2;
              bonus = -Math.abs(wrongPoints);
            }
            points = scoreJudgement('WRONG', { correct: 0, wrong: wrongPoints });
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
            roundIndex: state.currentRoundIndex, roundKey: `question:${state.currentRoundIndex}`, delta: points,
            reason: isCorrect ? 'Richtige Antwort' : 'Falsche Antwort',
          });
        }

        // Mark round as revealed
        roundState.revealed = true;
        state.phase = 'REVEAL';

        // Update game state
        await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
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
    });
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
    return serializeGeoAction(socket, async () => {
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
        roles: ['HOST'], requireParticipation: true, gameSlug: resolveCanonicalSlug('geo')!, requireRunning: true, controlPermission: 'ROUND_ADVANCE',
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
      const transition = advanceRound(state.currentRoundIndex, state.questions.length);
      const prepared = transitionRoundState({ gameSlug: 'wissensduell', current: state, completedRoundId: String(state.currentRoundIndex),
        nextRoundId: transition.ended ? null : String(transition.nextIndex),
        prepared: { ...state, currentRoundIndex: transition.nextIndex, phase: transition.ended ? 'GAME_END' : 'PROMPT' } });

      // Check if game ended
      if (transition.ended) {
        const ended = await finishRunningGame<GeoGameState>({ gameSlug: 'wissensduell',
          roomId: room.id, expectedRevision: gameStateData.revision, requiredPhase: 'REVEAL',
          nextState: () => prepared,
        });
        if (ended.ended) await this.handleGameEnd(io, room, ended.state);
        callback?.({ success: true, ended: true });
        return;
      }

      const opened = await this.startRound(io, room, { expectedRevision: gameStateData.revision, prepared });
      if (!opened) throw new Error('STATE_CONFLICT');

      callback?.({ success: true });
    } catch (error) {
      logger.error('Geo next error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
    });
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
    return serializeGeoAction(socket, async () => {
    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      const auth = await authorizeGameContext(socket, {
        roles: ['HOST'], requireParticipation: true, gameSlug: resolveCanonicalSlug('geo')!, requireRunning: true, controlPermission: 'GAME_PAUSE',
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

      if (!roundState || state.phase !== 'INPUT_OPEN') {
        callback?.({ success: false, error: 'NO_ACTIVE_TIMER' });
        return;
      }

      // P0-20: Calculate remaining time and store it
      const now = Date.now();
      const runningTimer = legacyRoundTimer(roundState, state.phase);
      if (!timerAcceptsInput(runningTimer, now)) { callback?.({ success: false, error: 'TIME_EXPIRED' }); return; }
      roundState.timer = pauseTimer(runningTimer, now);
      const pauseRemainingMs = roundState.timer.remainingMs!;
      roundState.pauseRemainingMs = pauseRemainingMs;
      roundState.timerEndMs = null;
      state.phase = 'PAUSED';

      await prisma.$transaction(async (tx) => {
        await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
          roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
        });
        const updated = await tx.room.updateMany({
          where: { id: room.id, revision: room.revision, status: 'RUNNING' },
          data: { runPhase: 'PAUSED', revision: { increment: 1 } },
        });
        await feed(tx, room.id, null, 'PAUSE', 'Spiel pausiert');
        if (updated.count !== 1) throw new Error('STATE_CONFLICT');
      });
      cancelGeoTimer(room.id);

      // Emit pause event
      changed(io, room.id);
      io.to(roomChannel(room.id)).emit('geo:paused', {
        roundIndex: state.currentRoundIndex,
        remainingMs: pauseRemainingMs,
      });

      callback?.({ success: true, remainingMs: pauseRemainingMs });
    } catch (error) {
      logger.error('Geo pause error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
    });
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
    return serializeGeoAction(socket, async () => {
    try {
      const room = await prisma.room.findUnique({
        where: { code: data.roomCode },
      });

      if (!room) {
        callback?.({ success: false, error: 'ROOM_NOT_FOUND' });
        return;
      }

      const auth = await authorizeGameContext(socket, {
        roles: ['HOST'], requireParticipation: true, gameSlug: resolveCanonicalSlug('geo')!, requireRunning: true, controlPermission: 'GAME_PAUSE',
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
      roundState.timer = resumeTimer(legacyRoundTimer(roundState, state.phase), Date.now());
      roundState.pauseRemainingMs = null;
      const newTimerEndMs = roundState.timer.endsAtMs!;
      roundState.timerEndMs = newTimerEndMs;
      state.phase = 'INPUT_OPEN';
      await prisma.$transaction(async (tx) => {
        await saveGameStateIfRevision(tx, { gameSlug: 'wissensduell',
          roomId: room.id, expectedRevision: gameStateData.revision, state, phase: state.phase,
        });
        const updated = await tx.room.updateMany({
          where: { id: room.id, revision: room.revision, status: 'RUNNING', runPhase: 'PAUSED' },
          data: { runPhase: 'ROUND_ACTIVE', revision: { increment: 1 } },
        });
        await feed(tx, room.id, null, 'RESUME', 'Spiel fortgesetzt');
        if (updated.count !== 1) throw new Error('STATE_CONFLICT');
      });
      scheduleGeoDeadline(io, room, { runIndex: room.runIndex, roundIndex: state.currentRoundIndex, endsAtMs: newTimerEndMs });

      changed(io, room.id);
      io.to(roomChannel(room.id)).emit('geo:resumed', { timerEndMs: newTimerEndMs });
      callback?.({ success: true, timerEndMs: newTimerEndMs });
    } catch (error) {
      logger.error('Geo resume error', { error });
      callback?.({ success: false, error: gameErrorCode(error) });
    }
    });
  },

  // ============================================================
  // End Game
  // ============================================================

  async end(io: Server, room: { id: string; code: string }): Promise<{ ended: boolean }> {
    return serializeRoom(room.id, async () => {
    const result = await finishRunningGame<GeoGameState>({ gameSlug: 'wissensduell', roomId: room.id, endReason: 'HOST_ABORTED' });
    if (result.ended) await this.handleGameEnd(io, room, result.state);
    return { ended: result.ended };
    });
  },

  async handleGameEnd(io: Server, room: any, state: GeoGameState) {
    cancelGeoTimer(room.id);

    // Get final scores with participation details
    const participations = await prisma.participation.findMany({
      where: { roomId: room.id, role: 'PLAYER', id: { in: Object.keys(state.scores) } },
      select: { id: true, displayName: true, score: true },
    });

    const tie = resolveTie(participations
      .map(p => ({ 
        id: p.id,
        participationId: p.id, 
        displayName: p.displayName,
        score: p.score,
      })), state.tieStrategy ?? 'ALLOW_TIE');
    const finalScores = tie.rankings.map(({ id: _id, ...entry }) => { void _id; return entry; });

    io.to(roomChannel(room.id)).emit('game:end', {
      roomCode: room.code,
      status: 'ENDED',
      runPhase: 'RESULTS',
      finalScores,
      winnerIds: tie.winnerIds,
    });

    logger.info('Geo game ended', { roomId: room.id });
  },
};
