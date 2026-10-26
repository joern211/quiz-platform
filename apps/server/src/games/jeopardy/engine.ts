import { refreshLiveMedia } from '../../media/live.js';
// ============================================================
// Jeopardy Game Engine (Phase 4)
// Server-authoritative game flow
// ============================================================

import { roomContentMediaUrl } from '../../content/media.js';
import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { finishRunningGame, saveGameStateIfRevision, upsertGameState } from '../core/state.js';
import { loadInitialGameCount, loadInitialTieStrategy, ConfigSnapshotError } from '../core/config.js';
import { logger } from '../../observability/logger.js';
import { roomChannel } from '../../sockets/index.js';
import { authorizeGameContext } from '../core/access.js';
import { claimBuzzer, openBuzzer, createBuzzerState, resolveBuzzer } from '../core/buzzer.js';
import { recordScoreMutation } from '../core/score.js';
import { createTimer, submitOnce, judgeSubmission, scoreJudgement } from '../core/runtimePrimitives.js';
import { createTurn, requireWinningTurn, matchAnswer } from '../core/roundFlow.js';
import { prepareRoundRuntime, transitionRoundState } from '../core/roundTransition.js';
import { resolveTie } from '../core/tie.js';
import { openRoundBuzzerForRoom } from '../core/buzzerRoster.js';
import {
  JEOPARDY_PHASES,
  pointsForCorrect,
  pointsForWrongFirst,
  pointsForCorrectSteal,
  pointsForWrongSteal,
  JeopardyInitEvent,
  JeopardyFieldOpenEvent,
  JeopardyBuzzLockedEvent,
  JeopardyStealLockedEvent,
  JeopardyRevealEvent,
  JeopardyFieldDoneEvent,
  JeopardyBoardCompleteEvent,
  JeopardyGameEndEvent,
} from './contracts.js';
import {
  JeopardyGameState,
  createJeopardyGameState,
  fieldKey,
  registerField,
  isBoardComplete,
  applyScoreDelta,
  resetBuzzer,
  markFieldAnswered,
  JeopardyFieldDef,
} from './state.js';

// ============================================================
// Entry point: initialize a Jeopardy game in a room
// ============================================================

function verbalSubmissionKey(state: JeopardyGameState, participantId: string, steal: boolean): string {
  if (!state.currentField) throw new Error('NO_CURRENT_FIELD');
  return `${fieldKey(state.currentBoard, state.currentField.categoryIndex, state.currentField.value)}:${steal ? 'steal' : 'first'}:${participantId}`;
}
function submitVerbal(state: JeopardyGameState, participantId: string, steal: boolean): void {
  const now = Date.now(), key = verbalSubmissionKey(state, participantId, steal);
  state.timer ??= createTimer('UNLIMITED', now);
  state.submissions ??= {};
  state.submissions[key] = submitOnce({ previous: state.submissions[key], participantId, roundId: key, value: null, timer: state.timer, now });
  state.submissions[key].matchStatus = matchAnswer(null, state.currentField!.fieldDef.answer, 'MANUAL_ONLY');
  state.answerTurn = createTurn([participantId]);
}
function judgeVerbal(state: JeopardyGameState, participantId: string, steal: boolean, correct: boolean): void {
  requireWinningTurn(state.answerTurn, participantId);
  const key = verbalSubmissionKey(state, participantId, steal), submission = state.submissions?.[key];
  // Legacy rounds have no trustworthy submission timestamp; do not invent one.
  if (submission) state.submissions![key] = judgeSubmission(submission, correct ? 'CORRECT' : 'WRONG', Date.now());
}

export const handleJeopardyGame = {
  /**
   * Initialize Jeopardy game:
   * - Load board1/board2 from setupSnapshotJson
   * - Initialize player states
   * - Save to RoomGameState
   * - Emit jeopardy:init to all clients
   */
  async initialize(io: Server, room: { id: string; code: string; setupSnapshotJson: string | null }): Promise<void> {
    const setup = JSON.parse(room.setupSnapshotJson ?? '{}') as {
      board1?: { categories: Array<{ name: string; clues: Array<{ value: number; question: string; answer: string }> }> };
      board2?: { categories: Array<{ name: string; clues: Array<{ value: number; question: string; answer: string }> }> };
    };

    if (!setup.board1) {
      throw new Error('JeopardySetupMissing: No board1 in setupSnapshotJson');
    }

    const boardCount = await loadInitialGameCount(room.id, 'jeopardy', 'boardCount');
    if (boardCount > (setup.board2 ? 2 : 1)) throw new ConfigSnapshotError(room.id, 'boardCount exceeds setup');

    // Get all PLAYER participations
    const participations = await prisma.participation.findMany({
      where: { roomId: room.id, role: 'PLAYER', admission: 'ACTIVE', leftAt: null, kickedAt: null, bannedAt: null },
    });

    const playerIds = participations.map((p) => p.id);
    const playerNames: Record<string, string> = {};
    for (const p of participations) {
      playerNames[p.id] = p.displayName;
    }

    // Build initial state
    let state = createJeopardyGameState(1, playerIds, playerNames);
    state.contentRunIndex = (await prisma.room.findUniqueOrThrow({ where: { id: room.id }, select: { runIndex: true } })).runIndex;
    state.tieStrategy = await loadInitialTieStrategy(room.id, 'jeopardy');
    state.boardCount = boardCount;

    // Register all fields from board 1
    for (let ci = 0; ci < setup.board1.categories.length; ci++) {
      for (const clue of setup.board1.categories[ci].clues) {
        const fieldDef: JeopardyFieldDef = {
          categoryIndex: ci,
          value: clue.value,
          question: clue.question,
          answer: clue.answer,
        };
        state = registerField(state, 1, ci, clue.value, fieldDef);
      }
    }

    // Register all fields from board 2
    if (setup.board2 && boardCount === 2) {
      for (let ci = 0; ci < setup.board2.categories.length; ci++) {
        for (const clue of setup.board2.categories[ci].clues) {
          const fieldDef: JeopardyFieldDef = {
            categoryIndex: ci,
            value: clue.value,
            question: clue.question,
            answer: clue.answer,
          };
          state = registerField(state, 2, ci, clue.value, fieldDef);
        }
      }
    }

    state.phase = JEOPARDY_PHASES.SELECTING;

    // Persist through the shared game-state core.
    await upsertGameState({ gameSlug: 'jeopardy',
      roomId: room.id,
      engineVersion: 1,
      phase: JEOPARDY_PHASES.SELECTING,
      state,
    });

    // Build init payload
    const categories = setup.board1.categories.map((cat) => ({
      name: cat.name,
      clueCount: cat.clues.length,
    }));
    const values = [...new Set(setup.board1.categories.flatMap((c) => c.clues.map((cl) => cl.value)))].sort(
      (a, b) => a - b
    );

    const initEvent: JeopardyInitEvent = {
      boardNumber: 1,
      categories,
      values,
      scores: state.scores,
    };

    // Emit jeopardy:init to ALL clients in the room (P0-07 fix: emit to all, not just socket)
    // Clients check their own role when deciding whether to reveal sensitive data
    io.to(roomChannel(room.id)).emit('jeopardy:init', initEvent);
    logger.info('P0-16: Jeopardy jeopardy:init emitted', {
      roomId: room.id,
      board: initEvent.boardNumber,
      categories: initEvent.categories.length,
    });

    logger.info('Jeopardy game initialized', {
      roomId: room.id,
      playerCount: playerIds.length,
      board1Categories: setup.board1.categories.length,
    });
  },

  // ============================================================
  // Field Open (SELECTING → BUZZ_OPEN)
  // ============================================================

  /**
   * Open a field and reveal the question to all.
   * Answer is sent ONLY to the moderator socket.
   *
   * Guards:
   * - Only HOST or PLAYER may open fields
   * - Field must not have been played already
   * - Board index must match currentBoard
   * - Phase must be SELECTING
   */
  async handleFieldOpen(
    io: Server,
    socket: Socket,
    data: { boardIndex: 1 | 2; categoryIndex: number; value: number }
  ): Promise<{ success: boolean; error?: string }> {
    const auth = await authorizeGameContext(socket, { roles: ['HOST'], requireParticipation: true, gameSlug: 'jeopardy', requireRunning: true, controlPermission: 'REVEAL_CONTENT', });
    if (!auth.ok) {
      return { success: false, error: auth.error === 'FORBIDDEN' ? 'HOST_ONLY' : auth.error };
    }

    const roomId = auth.actor.roomId;
    const participationId = auth.actor.participationId!;

    // Load room + state
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) return { success: false, error: 'ROOM_NOT_FOUND' };

    const gameStateData = await prisma.roomGameState.findUnique({ where: { roomId } });
    if (!gameStateData) return { success: false, error: 'GAME_NOT_FOUND' };

    let state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

    // Phase guard
    if (state.phase !== JEOPARDY_PHASES.SELECTING) {
      return { success: false, error: 'PHASE_NOT_SELECTING' };
    }

    // Board index guard
    if (data.boardIndex !== state.currentBoard) {
      return { success: false, error: 'WRONG_BOARD' };
    }

    // Already played guard
    const key = fieldKey(data.boardIndex, data.categoryIndex, data.value);
    if (!state.openFields[key]) {
      return { success: false, error: 'FIELD_ALREADY_PLAYED' };
    }

    // Load setup to find the field
    const setup = JSON.parse(room.setupSnapshotJson ?? '{}') as {
      board1?: { categories: Array<{ name: string; clues: Array<{ value: number; question: string; answer: string }> }> };
      board2?: { categories: Array<{ name: string; clues: Array<{ value: number; question: string; answer: string }> }> };
    };

    const board = data.boardIndex === 1 ? setup.board1 : setup.board2;
    if (!board) return { success: false, error: 'BOARD_NOT_FOUND' };
    const category = board.categories[data.categoryIndex];
    if (!category) return { success: false, error: 'CATEGORY_NOT_FOUND' };
    const clue = category.clues.find(
      (c) => c.value === data.value
    ) as { value: number; question: string; answer: string; mediaType?: string; mediaAssetId?: string; contentId?: string };
    if (!clue) return { success: false, error: 'CLUE_NOT_FOUND' };

    // Update state
    state = {
      ...state,
      timer: createTimer('UNLIMITED', Date.now()),
      submissions: {},
      buzzer: openBuzzer(state.buzzer ?? createBuzzerState(), { mode: 'SELECTED', eligiblePlayerIds: Object.keys(state.scores) }),
      stealBuzzer: createBuzzerState(),
      currentField: {
        categoryIndex: data.categoryIndex,
        value: data.value,
        fieldDef: {
          categoryIndex: data.categoryIndex,
          value: data.value,
          question: clue.question,
          answer: clue.answer, mediaAssetId: clue.mediaAssetId, mediaType: clue.mediaType, contentId: clue.contentId,
        },
      },
      phase: JEOPARDY_PHASES.BUZZ_OPEN,
      buzzOpen: true,
      buzzWinner: null,
    };

    // Persist atomically
    await prisma.$transaction(async (tx) => {
      state.buzzer = await openRoundBuzzerForRoom(tx, roomId, Object.keys(state.scores));
      await saveGameStateIfRevision(tx, { gameSlug: 'jeopardy', roomId, expectedRevision: gameStateData.revision, state, phase: state.phase });
    });

    await refreshLiveMedia(io);

    // Emit question to ALL (no answer — P0-07 fix: using io.to broadcasts to the correct room channel)
    const fieldOpenEvent: JeopardyFieldOpenEvent = {
      categoryIndex: data.categoryIndex,
      value: data.value,
      question: clue.question,
      mediaType: clue.mediaType,
      mediaAssetId: clue.mediaAssetId,
      mediaUrl: roomContentMediaUrl(roomId, state.contentRunIndex, clue.contentId, clue.mediaAssetId),
    };
    io.to(roomChannel(roomId)).emit('jeopardy:field:open', fieldOpenEvent);

    // Emit answer ONLY to the moderator socket (P0-07: sensitive data stays server→moderator)
    if (auth.actor.role === 'HOST' && !auth.actor.blindHost) socket.emit('jeopardy:answer:secret', {
      categoryIndex: data.categoryIndex,
      value: data.value,
      answer: clue.answer,
    });

    logger.info('Jeopardy field opened', {
      roomId,
      participationId,
      boardIndex: data.boardIndex,
      categoryIndex: data.categoryIndex,
      value: data.value,
    });

    return { success: true };
  },

  // ============================================================
  // Buzz (BUZZ_OPEN → BUZZ_LOCKED)
  // ============================================================

  /**
   * Atomary buzzer: the first valid buzz wins.
   * All other buzzes are rejected.
   *
   * Guards:
   * - Phase must be BUZZ_OPEN
   * - No existing buzzWinner
   * - Player not already buzzed this question
   */
  async handleBuzz(
    io: Server,
    socket: Socket,
    _data: Record<string, never> = {}
  ): Promise<{ success: boolean; error?: string }> {
    const auth = await authorizeGameContext(socket, { roles: ['PLAYER'], requireParticipation: true, gameSlug: 'jeopardy', requireRunning: true });
    if (!auth.ok) {
      return { success: false, error: auth.error === 'FORBIDDEN' ? 'PLAYER_ONLY' : auth.error };
    }

    const roomId = auth.actor.roomId;
    const participationId = auth.actor.participationId!;

    // Atomic transaction: check + update in one step
    const result = await prisma.$transaction(async (tx) => {
      const gameStateData = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!gameStateData) throw new Error('GAME_NOT_FOUND');

      const state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

      // Phase guard
      if (state.phase !== JEOPARDY_PHASES.BUZZ_OPEN) {
        throw new Error('PHASE_NOT_BUZZ_OPEN');
      }

      if (!Object.hasOwn(state.scores, participationId)) throw new Error('PLAYER_NOT_IN_GAME');
      const claim = claimBuzzer(
        state.buzzer ?? { open: state.buzzOpen, winnerId: state.buzzWinner, excludedPlayerIds: [] },
        participationId
      );
      if (!claim.accepted) throw new Error(claim.error);
      state.buzzer = claim.state;
      submitVerbal(state, participationId, false);
      state.buzzOpen = claim.state.open;
      state.buzzWinner = claim.state.winnerId;
      state.phase = JEOPARDY_PHASES.BUZZ_LOCKED;
      await saveGameStateIfRevision(tx, { gameSlug: 'jeopardy', roomId, expectedRevision: gameStateData.revision, state, phase: state.phase });

      return { state, displayName: auth.actor.displayName };
    });

    // Broadcast buzz:won event (namespaced to avoid collision with geo)
    const buzzEvent: JeopardyBuzzLockedEvent = {
      playerId: participationId,
      playerName: result.displayName ?? 'Unknown',
    };
    io.to(roomChannel(roomId)).emit('jeopardy:buzz:won', buzzEvent);

    logger.info('Jeopardy buzz won', { roomId, participationId });

    return { success: true };
  },

  // ============================================================
  // Judge (BUZZ_LOCKED → FIELD_DONE or STEAL_OPEN)
  // ============================================================

  /**
   * Moderator judges the current buzz.
   * Idempotent: double calls have no extra effect.
   *
   * Guards:
   * - Only HOST
   * - Phase must be BUZZ_LOCKED
   * - A buzzWinner must exist
   */
  async handleJudge(
    io: Server,
    socket: Socket,
    data: { correct: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    const auth = await authorizeGameContext(socket, { roles: ['HOST'], requireParticipation: true, gameSlug: 'jeopardy', requireRunning: true, controlPermission: 'JUDGE_ANSWER', });
    if (!auth.ok) {
      return { success: false, error: auth.error === 'FORBIDDEN' ? 'UNAUTHORIZED' : auth.error };
    }
    const roomId = auth.actor.roomId;

    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!row) throw new Error('GAME_NOT_FOUND');
      let state: JeopardyGameState = JSON.parse(row.stateJson);
      if (state.phase !== JEOPARDY_PHASES.BUZZ_LOCKED || !state.buzzWinner || !state.currentField) {
        throw new Error('PHASE_NOT_BUZZ_LOCKED');
      }
      const playerId = state.buzzWinner;
      const { categoryIndex, value, fieldDef } = state.currentField;
      judgeVerbal(state, playerId, false, data.correct);
      const delta = scoreJudgement(data.correct ? 'CORRECT' : 'WRONG', { correct: pointsForCorrect(value), wrong: pointsForWrongFirst(value) });
      state.scores = applyScoreDelta(state.scores, playerId, delta);
      if (data.correct) {
        state = resetBuzzer(markFieldAnswered(state, categoryIndex, value, playerId, true, delta));
        state.phase = isBoardComplete(state, state.currentBoard) ? JEOPARDY_PHASES.BOARD_COMPLETE : JEOPARDY_PHASES.FIELD_DONE;
      } else {
        state.phase = JEOPARDY_PHASES.STEAL_OPEN;
        state.answerTurn = null;
        state.currentField!.firstResponderId = playerId;
        state.buzzWinner = null;
        state.buzzOpen = false;
        state.stealOpen = true;
        state.buzzer = resolveBuzzer(state.buzzer ?? { open: false, winnerId: playerId, excludedPlayerIds: [] }, true);
        state.stealBuzzer = openBuzzer(createBuzzerState(), { mode: state.buzzer.mode ?? 'SELECTED',
          eligiblePlayerIds: state.buzzer.eligiblePlayerIds ?? Object.keys(state.scores),
          teamByPlayer: state.buzzer.teamByPlayer, excludePlayerIds: state.buzzer.excludedPlayerIds });
      }
      await recordScoreMutation(tx, {
        roomId, participationId: playerId, score: state.scores[playerId], delta,
        reason: data.correct ? 'JEOPARDY_CORRECT' : 'JEOPARDY_WRONG_FIRST',
        roundIndex: state.currentBoard - 1, roundKey: `field:${fieldKey(state.currentBoard, categoryIndex, value)}`,
      });
      await saveGameStateIfRevision(tx, { gameSlug: 'jeopardy', roomId, expectedRevision: row.revision, state, phase: state.phase });

      return { state, playerId, delta, categoryIndex, value, answer: fieldDef.answer };
    });

    const { state, playerId, delta, categoryIndex, value, answer } = result;
    if (!data.correct) {
      io.to(roomChannel(roomId)).emit('jeopardy:steal:open', { categoryIndex, value, scores: state.scores, excludedPlayerId: playerId, excludedPlayerIds: state.stealBuzzer?.excludedPlayerIds });
    } else {
      io.to(roomChannel(roomId)).emit('jeopardy:reveal', {
        answer: '••••••', correct: true, playerId,
        playerName: state.playerNames[playerId], fieldValue: value, delta, scores: state.scores,
      });
      socket.emit('jeopardy:reveal', {
        answer, correct: true, playerId,
        playerName: state.playerNames[playerId], fieldValue: value, delta, scores: state.scores,
      } as JeopardyRevealEvent);
      io.to(roomChannel(roomId)).emit('jeopardy:field:done', { categoryIndex, value } as JeopardyFieldDoneEvent);
      if (state.phase === JEOPARDY_PHASES.BOARD_COMPLETE) {
        io.to(roomChannel(roomId)).emit('jeopardy:board:complete', {
          boardNumber: state.currentBoard, nextBoard: state.currentBoard === 1 ? 2 : null,
        } as JeopardyBoardCompleteEvent);
      }
    }
    return { success: true };
  },

  // ============================================================
  // Steal Buzz (STEAL_OPEN → STEAL_LOCKED)
  // ============================================================

  /**
   * Same atomic buzzer logic as handleBuzz, but for steal phase.
   */
  async handleStealBuzz(
    io: Server,
    socket: Socket,
    _data: Record<string, never> = {}
  ): Promise<{ success: boolean; error?: string }> {
    const auth = await authorizeGameContext(socket, { roles: ['PLAYER'], requireParticipation: true, gameSlug: 'jeopardy', requireRunning: true });
    if (!auth.ok) {
      return { success: false, error: auth.error === 'FORBIDDEN' ? 'PLAYER_ONLY' : auth.error };
    }

    const roomId = auth.actor.roomId;
    const participationId = auth.actor.participationId!;

    const result = await prisma.$transaction(async (tx) => {
      const gameStateData = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!gameStateData) throw new Error('GAME_NOT_FOUND');

      const state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

      if (state.phase !== JEOPARDY_PHASES.STEAL_OPEN) {
        throw new Error('PHASE_NOT_STEAL_OPEN');
      }

      if (!Object.hasOwn(state.scores, participationId)) throw new Error('PLAYER_NOT_IN_GAME');
      const claim = claimBuzzer(
        state.stealBuzzer ?? {
          open: state.stealOpen,
          winnerId: state.stealWinner,
          excludedPlayerIds: state.currentField?.firstResponderId ? [state.currentField.firstResponderId] : [],
        },
        participationId
      );
      if (!claim.accepted) throw new Error(claim.error);
      state.stealBuzzer = claim.state;
      submitVerbal(state, participationId, true);
      state.stealOpen = claim.state.open;
      state.stealWinner = claim.state.winnerId;
      state.phase = JEOPARDY_PHASES.STEAL_LOCKED;

      await saveGameStateIfRevision(tx, { gameSlug: 'jeopardy', roomId, expectedRevision: gameStateData.revision, state, phase: state.phase });

      return { displayName: auth.actor.displayName };
    });

    io.to(roomChannel(roomId)).emit('jeopardy:steal:buzz:won', {
      playerId: participationId,
      playerName: result.displayName ?? 'Unknown',
    } as JeopardyStealLockedEvent);

    logger.info('Jeopardy steal buzz won', { roomId, participationId });

    return { success: true };
  },

  // ============================================================
  // Steal Judge (STEAL_LOCKED → FIELD_DONE)
  // ============================================================

  /**
   * Moderator judges the steal attempt.
   * Always 50% points (or 50% penalty).
   * Guards: Only HOST, STEAL_LOCKED phase.
   */
  async handleStealJudge(
    io: Server,
    socket: Socket,
    data: { correct: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    const auth = await authorizeGameContext(socket, { roles: ['HOST'], requireParticipation: true, gameSlug: 'jeopardy', requireRunning: true, controlPermission: 'JUDGE_ANSWER', });
    if (!auth.ok) {
      return { success: false, error: auth.error === 'FORBIDDEN' ? 'UNAUTHORIZED' : auth.error };
    }

    const roomId = auth.actor.roomId;

    const result = await prisma.$transaction(async (tx) => {
      const gameStateData = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!gameStateData) throw new Error('GAME_NOT_FOUND');

      let state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

      if (state.phase !== JEOPARDY_PHASES.STEAL_LOCKED) {
        throw new Error('PHASE_NOT_STEAL_LOCKED');
      }

      if (!state.stealWinner) {
        throw new Error('NO_STEAL_WINNER');
      }

      const stealWinnerId = state.stealWinner;
      const answer = state.currentField?.fieldDef.answer ?? '';
      const value = state.currentField?.value ?? 0;
      const categoryIndex = state.currentField?.categoryIndex ?? 0;

      judgeVerbal(state, stealWinnerId, true, data.correct);
      const delta = scoreJudgement(data.correct ? 'CORRECT' : 'WRONG', { correct: pointsForCorrectSteal(value), wrong: pointsForWrongSteal(value) });
      state.scores = applyScoreDelta(state.scores, stealWinnerId, delta);

      // Mark field as answered
      state = markFieldAnswered(state, categoryIndex, value, stealWinnerId, data.correct, delta);
      state = resetBuzzer(state);


      if (isBoardComplete(state, state.currentBoard)) {
        state.phase = JEOPARDY_PHASES.BOARD_COMPLETE;
      } else {
        state.phase = JEOPARDY_PHASES.FIELD_DONE;
      }

      await recordScoreMutation(tx, {
        roomId, participationId: stealWinnerId, score: state.scores[stealWinnerId], delta,
        reason: data.correct ? 'JEOPARDY_CORRECT_STEAL' : 'JEOPARDY_WRONG_STEAL',
        roundIndex: state.currentBoard - 1, roundKey: `field:${fieldKey(state.currentBoard, categoryIndex, value)}`,
      });
      await saveGameStateIfRevision(tx, { gameSlug: 'jeopardy', roomId, expectedRevision: gameStateData.revision, state, phase: state.phase });


      return { state, stealWinnerId, delta, value, categoryIndex, correct: data.correct, answer };
    });

    const { state, stealWinnerId, delta, value, categoryIndex } = result;
    const answer = result.answer;
    const allScores = Object.entries(state.scores).map(([pid, score]) => ({
      playerId: pid,
      playerName: state.playerNames[pid] ?? 'Unknown',
      score,
    }));

    // Reveal to all (answer masked for non-moderators)
    io.to(roomChannel(roomId)).emit('jeopardy:steal:close', {
      answer: '••••••',
      thiefCorrect: result.correct,
      thiefDelta: delta,
      scores: allScores.reduce((acc, s) => ({ ...acc, [s.playerId]: s.score }), {}),
    });

    socket.emit('jeopardy:steal:close', {
      answer,
      thiefCorrect: result.correct,
      thiefDelta: delta,
      scores: allScores.reduce((acc, s) => ({ ...acc, [s.playerId]: s.score }), {}),
    });

    io.to(roomChannel(roomId)).emit('jeopardy:field:done', {
      categoryIndex,
      value,
    } as JeopardyFieldDoneEvent);

    if (state.phase === JEOPARDY_PHASES.BOARD_COMPLETE) {
      io.to(roomChannel(roomId)).emit('jeopardy:board:complete', {
        boardNumber: state.currentBoard, nextBoard: state.currentBoard === 1 ? 2 : null,
      } as JeopardyBoardCompleteEvent);
    }

    logger.info('Jeopardy steal judged', { roomId, stealWinnerId, value, delta, correct: result.correct });

    return { success: true };
  },

  // ============================================================
  // Next (FIELD_DONE → SELECTING)
  // ============================================================

  /**
   * Reset current question and return to selecting.
   * Moderator action.
   */
  async handleNext(
    io: Server,
    socket: Socket,
    _data: Record<string, never> = {}
  ): Promise<{ success: boolean; error?: string }> {
    const auth = await authorizeGameContext(socket, { roles: ['HOST'], requireParticipation: true, gameSlug: 'jeopardy', requireRunning: true, controlPermission: 'ROUND_ADVANCE', });
    if (!auth.ok) {
      return { success: false, error: auth.error === 'FORBIDDEN' ? 'UNAUTHORIZED' : auth.error };
    }

    const roomId = auth.actor.roomId;

    await prisma.$transaction(async (tx) => {
      const gameStateData = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!gameStateData) throw new Error('GAME_NOT_FOUND');

      let state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

      if (state.phase !== JEOPARDY_PHASES.FIELD_DONE) {
        throw new Error('PHASE_NOT_FIELD_DONE');
      }

      state = transitionRoundState({ gameSlug: 'jeopardy', current: state,
        completedRoundId: state.currentField ? fieldKey(state.currentBoard, state.currentField.categoryIndex, state.currentField.value) : state.lastResolvedFieldKey ?? `legacy-board:${state.currentBoard}`,
        prepared: resetBuzzer({ ...state, ...prepareRoundRuntime(), currentField: null, phase: JEOPARDY_PHASES.SELECTING }) });

      await saveGameStateIfRevision(tx, { gameSlug: 'jeopardy', roomId, expectedRevision: gameStateData.revision, state, phase: state.phase });
    });

    io.to(roomChannel(roomId)).emit('jeopardy:next', { phase: JEOPARDY_PHASES.SELECTING });

    logger.info('Jeopardy next', { roomId });

    return { success: true };
  },

  // ============================================================
  // Board Switch (BOARD_COMPLETE → SELECTING on board 2)
  // ============================================================

  /**
   * Switch from board 1 to board 2 (or end game after board 2).
   * Must be called when BOARD_COMPLETE phase is reached.
   */
  async handleBoardSwitch(
    io: Server,
    room: { id: string; code: string; setupSnapshotJson: string | null }
  ): Promise<{ success: boolean; error?: string }> {
    const gameStateData = await prisma.roomGameState.findUnique({ where: { roomId: room.id } });
    if (!gameStateData) return { success: false, error: 'GAME_NOT_FOUND' };

    const state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

    if (state.phase !== JEOPARDY_PHASES.BOARD_COMPLETE) {
      return { success: false, error: 'PHASE_NOT_BOARD_COMPLETE' };
    }

    if (state.currentBoard === 1) {
      // Switch to board 2
      const setup = JSON.parse(room.setupSnapshotJson ?? '{}') as {
        board2?: { categories: Array<{ name: string; clues: Array<{ value: number; question: string; answer: string }> }> };
      };

      if (!setup.board2 || state.boardCount === 1) {
        // No board 2 → game ends
        return this.handleGameEnd(io, room, state);
      }

      // Board 2 fields were registered at initialization; never reinsert played fields.
      const newState = transitionRoundState({ gameSlug: 'jeopardy', current: state,
        completedRoundId: state.currentField ? fieldKey(state.currentBoard, state.currentField.categoryIndex, state.currentField.value) : state.lastResolvedFieldKey ?? `legacy-board:${state.currentBoard}`,
        prepared: resetBuzzer({ ...state, ...prepareRoundRuntime(), currentBoard: 2 as const, currentField: null, phase: JEOPARDY_PHASES.SELECTING }) });
      await prisma.$transaction(async (tx) => saveGameStateIfRevision(tx, { gameSlug: 'jeopardy', roomId: room.id, expectedRevision: gameStateData.revision, state: newState, phase: newState.phase }));

      const categories = setup.board2.categories.map((cat) => ({
        name: cat.name,
        clueCount: cat.clues.length,
      }));
      const values = [...new Set(setup.board2.categories.flatMap((c) => c.clues.map((cl) => cl.value)))].sort(
        (a, b) => a - b
      );

      io.to(roomChannel(room.id)).emit('jeopardy:board:switch', {
        fromBoard: 1 as 1 | 2,
        toBoard: 2 as 1 | 2,
        categories,
        values,
        scores: newState.scores,
      } as unknown as JeopardyBoardCompleteEvent & { categories: Array<{ name: string; clueCount: number }>; values: number[]; scores: Record<string, number> });

      logger.info('Jeopardy board switch', { roomId: room.id, from: 1, to: 2 });
    } else {
      // Already on board 2 → game ends
      return this.handleGameEnd(io, room, state);
    }

    return { success: true };
  },

  // ============================================================
  // Game End
  // ============================================================

  async handleGameEnd(
    io: Server,
    room: { id: string; code: string },
    _state?: JeopardyGameState,
    manual = false
  ): Promise<{ success: boolean; error?: string; ended?: boolean }> {
    const result = await finishRunningGame<JeopardyGameState>({ gameSlug: 'jeopardy',
      roomId: room.id, endReason: manual ? 'HOST_ABORTED' : 'COMPLETED',
      ...(!manual ? { requiredPhase: JEOPARDY_PHASES.BOARD_COMPLETE, nextState: (state: JeopardyGameState) => transitionRoundState({ gameSlug: 'jeopardy', current: state,
        completedRoundId: state.currentField ? fieldKey(state.currentBoard, state.currentField.categoryIndex, state.currentField.value) : state.lastResolvedFieldKey ?? `legacy-board:${state.currentBoard}`,
        prepared: resetBuzzer({ ...state, ...prepareRoundRuntime(), phase: JEOPARDY_PHASES.GAME_END }) }) } : {}),
    });
    if (!result.ended) return { success: true, ended: false };
    const state = result.state;

    const scores = state?.scores ?? {};
    const tie = resolveTie(Object.entries(scores)
      .map(([playerId, score]) => ({
        id: playerId,
        playerId,
        playerName: state?.playerNames[playerId] ?? 'Unknown',
        score,
      })), state.tieStrategy ?? 'ALLOW_TIE');
    const finalScores = tie.rankings.map(({ id: _id, ...entry }) => { void _id; return entry; });
    const winnerIds = tie.winnerIds;

    const endEvent: JeopardyGameEndEvent = {
      finalScores,
      winnerIds,
    };

    io.to(roomChannel(room.id)).emit('jeopardy:game:end', endEvent);
    io.to(roomChannel(room.id)).emit('game:end', {
      roomCode: room.code, status: 'ENDED', runPhase: 'RESULTS',
    });

    logger.info('Jeopardy game ended', { roomId: room.id, finalScores });

    return { success: true, ended: true };
  },
};
