// ============================================================
// Jeopardy Game Engine (Phase 4)
// Server-authoritative game flow
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { roomChannel } from '../../sockets/index.js';
import { getSocketDataIdentity } from '../../sockets/auth.js';
import {
  JeopardyPhase,
  JEOPARDY_PHASES,
  pointsForCorrect,
  pointsForWrongFirst,
  pointsForCorrectSteal,
  pointsForWrongSteal,
  JeopardyInitEvent,
  JeopardyFieldOpenEvent,
  JeopardyBuzzLockedEvent,
  JeopardyStealOpenEvent,
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
  countOpenFields,
  isBoardComplete,
  applyScoreDelta,
  lockBuzzer,
  openStealBuzzer,
  lockStealBuzzer,
  resetBuzzer,
  markFieldAnswered,
  JeopardyFieldDef,
} from './state.js';

// ============================================================
// Entry point: initialize a Jeopardy game in a room
// ============================================================

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

    // Get all PLAYER participations
    const participations = await prisma.participation.findMany({
      where: { roomId: room.id, role: 'PLAYER' },
    });

    const playerIds = participations.map((p) => p.id);
    const playerNames: Record<string, string> = {};
    for (const p of participations) {
      playerNames[p.id] = p.displayName;
    }

    // Build initial state
    let state = createJeopardyGameState(1, playerIds, playerNames);

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
    if (setup.board2) {
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

    // Persist to RoomGameState
    await prisma.roomGameState.upsert({
      where: { roomId: room.id },
      create: {
        roomId: room.id,
        engineVersion: 1,
        phase: JEOPARDY_PHASES.SELECTING,
        stateJson: JSON.stringify(state),
        revision: 1,
      },
      update: {
        phase: JEOPARDY_PHASES.SELECTING,
        stateJson: JSON.stringify(state),
        revision: { increment: 1 },
      },
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

    io.to(roomChannel(room.id)).emit('jeopardy:init', initEvent);

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
   * - Only MODERATOR or PLAYER may open fields
   * - Field must not have been played already
   * - Board index must match currentBoard
   * - Phase must be SELECTING
   */
  async handleFieldOpen(
    io: Server,
    socket: Socket,
    data: { boardIndex: 1 | 2; categoryIndex: number; value: number }
  ): Promise<{ success: boolean; error?: string }> {
    const identity = getSocketDataIdentity(socket);
    if (!identity?.roomId) return { success: false, error: 'NOT_IN_ROOM' };
    if (identity.role === 'VIEWER') return { success: false, error: 'VIEWERS_CANNOT_MODIFY' };

    const roomId = identity.roomId;
    const participationId = identity.participationId;
    if (!participationId) return { success: false, error: 'NO_PARTICIPATION' };

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
    const clue = category.clues.find((c) => c.value === data.value);
    if (!clue) return { success: false, error: 'CLUE_NOT_FOUND' };

    // Update state
    state = {
      ...state,
      currentField: {
        categoryIndex: data.categoryIndex,
        value: data.value,
        fieldDef: {
          categoryIndex: data.categoryIndex,
          value: data.value,
          question: clue.question,
          answer: clue.answer,
        },
      },
      phase: JEOPARDY_PHASES.BUZZ_OPEN,
      buzzOpen: true,
      buzzWinner: null,
    };

    // Persist atomically
    await prisma.$transaction(async (tx) => {
      await tx.roomGameState.update({
        where: { roomId },
        data: {
          stateJson: JSON.stringify(state),
          phase: JEOPARDY_PHASES.BUZZ_OPEN,
          revision: { increment: 1 },
        },
      });
    });

    // Emit question to ALL (no answer)
    const fieldOpenEvent: JeopardyFieldOpenEvent = {
      categoryIndex: data.categoryIndex,
      value: data.value,
      question: clue.question,
      mediaType: clue.mediaType,
      mediaAssetId: clue.mediaAssetId,
    };
    io.to(roomChannel(roomId)).emit('jeopardy:field:open', fieldOpenEvent);

    // Emit answer ONLY to the moderator socket
    socket.emit('jeopardy:answer:secret', {
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
    const identity = getSocketDataIdentity(socket);
    if (!identity?.roomId) return { success: false, error: 'NOT_IN_ROOM' };
    if (identity.role === 'VIEWER') return { success: false, error: 'VIEWERS_CANNOT_MODIFY' };

    const roomId = identity.roomId;
    const participationId = identity.participationId;
    if (!participationId) return { success: false, error: 'NO_PARTICIPATION' };

    // Atomic transaction: check + update in one step
    const result = await prisma.$transaction(async (tx) => {
      const gameStateData = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!gameStateData) throw new Error('GAME_NOT_FOUND');

      let state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

      // Phase guard
      if (state.phase !== JEOPARDY_PHASES.BUZZ_OPEN) {
        throw new Error('PHASE_NOT_BUZZ_OPEN');
      }

      // Already has a winner guard
      if (state.buzzWinner !== null) {
        throw new Error('BUZZER_ALREADY_WON');
      }

      // Mark buzz winner
      state.buzzWinner = participationId;
      state.phase = JEOPARDY_PHASES.BUZZ_LOCKED;

      await tx.roomGameState.update({
        where: { roomId },
        data: {
          stateJson: JSON.stringify(state),
          phase: JEOPARDY_PHASES.BUZZ_LOCKED,
          revision: { increment: 1 },
        },
      });

      return { state, displayName: identity.displayName };
    });

    // Broadcast buzz:won event
    const buzzEvent: JeopardyBuzzLockedEvent = {
      playerId: participationId,
      playerName: result.displayName ?? 'Unknown',
    };
    io.to(roomChannel(roomId)).emit('buzz:won', buzzEvent);

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
   * - Only MODERATOR
   * - Phase must be BUZZ_LOCKED
   * - A buzzWinner must exist
   */
  async handleJudge(
    io: Server,
    socket: Socket,
    data: { correct: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    const identity = getSocketDataIdentity(socket);
    if (!identity?.roomId) return { success: false, error: 'NOT_IN_ROOM' };
    if (identity.role !== 'MODERATOR') return { success: false, error: 'UNAUTHORIZED' };

    const roomId = identity.roomId;

    const result = await prisma.$transaction(async (tx) => {
      const gameStateData = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!gameStateData) throw new Error('GAME_NOT_FOUND');

      let state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

      // Phase guard
      if (state.phase !== JEOPARDY_PHASES.BUZZ_LOCKED) {
        throw new Error('PHASE_NOT_BUZZ_LOCKED');
      }

      // Idempotency: check if already judged
      if (!state.buzzWinner) {
        throw new Error('NO_BUZZ_WINNER');
      }

      const buzzWinnerId = state.buzzWinner;
      const value = state.currentField?.value ?? 0;
      const categoryIndex = state.currentField?.categoryIndex ?? 0;

      // Calculate score delta
      const delta = data.correct ? pointsForCorrect(value) : pointsForWrongFirst(value);
      state.scores = applyScoreDelta(state.scores, buzzWinnerId, delta);

      // Persist state
      await tx.roomGameState.update({
        where: { roomId },
        data: {
          stateJson: JSON.stringify(state),
          revision: { increment: 1 },
        },
      });

      // Update participation score in DB
      await tx.participation.update({
        where: { id: buzzWinnerId },
        data: { score: state.scores[buzzWinnerId] },
      });

      return { state, buzzWinnerId, delta, value, categoryIndex, correct: data.correct };
    });

    const { state, buzzWinnerId, delta, value, categoryIndex, correct } = result;
    const board = state.currentBoard;

    if (!correct) {
      // Wrong answer → open steal phase
      const newState = await prisma.$transaction(async (tx) => {
        const gs = await tx.roomGameState.findUnique({ where: { roomId } });
        if (!gs) return null;
        let st: JeopardyGameState = JSON.parse(gs.stateJson);
        st.phase = JEOPARDY_PHASES.STEAL_OPEN;
        st.buzzWinner = null;
        st.stealOpen = true;
        await tx.roomGameState.update({
          where: { roomId },
          data: { stateJson: JSON.stringify(st), phase: JEOPARDY_PHASES.STEAL_OPEN, revision: { increment: 1 } },
        });
        return st;
      });

      // Emit steal:open to all
      io.to(roomChannel(roomId)).emit('jeopardy:steal:open', {
        categoryIndex,
        value,
      } as JeopardyStealOpenEvent);

      // Emit answer to moderator only
      const answer = state.currentField?.fieldDef.answer ?? '';
      socket.emit('jeopardy:reveal', {
        answer,
        correct,
        playerId: buzzWinnerId,
        playerName: state.playerNames[buzzWinnerId],
        fieldValue: value,
        delta,
        scores: state.scores,
      } as JeopardyRevealEvent);

      logger.info('Jeopardy judge: wrong → steal open', { roomId, buzzWinnerId, value });
    } else {
      // Correct answer → field done
      const newState = await prisma.$transaction(async (tx) => {
        const gs = await tx.roomGameState.findUnique({ where: { roomId } });
        if (!gs) return null;
        let st: JeopardyGameState = JSON.parse(gs.stateJson);
        st = markFieldAnswered(st, categoryIndex, value, buzzWinnerId, true, delta);
        st = resetBuzzer(st);

        // Check board completion
        const setup = JSON.parse((await tx.room.findUnique({ where: { id: roomId } }))?.setupSnapshotJson ?? '{}') as {
          board1?: { categories: Array<{ name: string; clues: Array<{ value: number }> }> };
        };
        const boardCategories = st.currentBoard === 1 ? setup.board1?.categories : [];

        if (isBoardComplete(st, st.currentBoard)) {
          st.phase = JEOPARDY_PHASES.BOARD_COMPLETE;
        } else {
          st.phase = JEOPARDY_PHASES.FIELD_DONE;
        }

        await tx.roomGameState.update({
          where: { roomId },
          data: { stateJson: JSON.stringify(st), phase: st.phase, revision: { increment: 1 } },
        });
        return st;
      });

      // Emit reveal to all (answer to moderator only)
      const answer = state.currentField?.fieldDef.answer ?? '';
      const allScores = Object.entries(state.scores).map(([pid, score]) => ({
        playerId: pid,
        playerName: state.playerNames[pid] ?? 'Unknown',
        score,
      }));

      io.to(roomChannel(roomId)).emit('jeopardy:reveal', {
        answer: '••••••',
        correct,
        playerId: buzzWinnerId,
        playerName: state.playerNames[buzzWinnerId],
        fieldValue: value,
        delta,
        scores: Object.fromEntries(
          Object.entries(state.scores).map(([pid, score]) => [
            pid,
            { score, playerName: state.playerNames[pid] },
          ])
        ),
      });

      socket.emit('jeopardy:reveal', {
        answer,
        correct,
        playerId: buzzWinnerId,
        playerName: state.playerNames[buzzWinnerId],
        fieldValue: value,
        delta,
        scores: allScores.reduce((acc, s) => ({ ...acc, [s.playerId]: s.score }), {}),
      } as JeopardyRevealEvent);

      io.to(roomChannel(roomId)).emit('jeopardy:field:done', {
        categoryIndex,
        value,
      } as JeopardyFieldDoneEvent);

      logger.info('Jeopardy judge: correct', { roomId, buzzWinnerId, value, delta });
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
    const identity = getSocketDataIdentity(socket);
    if (!identity?.roomId) return { success: false, error: 'NOT_IN_ROOM' };
    if (identity.role === 'VIEWER') return { success: false, error: 'VIEWERS_CANNOT_MODIFY' };

    const roomId = identity.roomId;
    const participationId = identity.participationId;
    if (!participationId) return { success: false, error: 'NO_PARTICIPATION' };

    const result = await prisma.$transaction(async (tx) => {
      const gameStateData = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!gameStateData) throw new Error('GAME_NOT_FOUND');

      let state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

      if (state.phase !== JEOPARDY_PHASES.STEAL_OPEN) {
        throw new Error('PHASE_NOT_STEAL_OPEN');
      }

      if (state.stealWinner !== null) {
        throw new Error('STEAL_ALREADY_WON');
      }

      state.stealWinner = participationId;
      state.phase = JEOPARDY_PHASES.STEAL_LOCKED;

      await tx.roomGameState.update({
        where: { roomId },
        data: {
          stateJson: JSON.stringify(state),
          phase: JEOPARDY_PHASES.STEAL_LOCKED,
          revision: { increment: 1 },
        },
      });

      return { displayName: identity.displayName };
    });

    io.to(roomChannel(roomId)).emit('steal:buzz:won', {
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
   * Guards: Only MODERATOR, STEAL_LOCKED phase.
   */
  async handleStealJudge(
    io: Server,
    socket: Socket,
    data: { correct: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    const identity = getSocketDataIdentity(socket);
    if (!identity?.roomId) return { success: false, error: 'NOT_IN_ROOM' };
    if (identity.role !== 'MODERATOR') return { success: false, error: 'UNAUTHORIZED' };

    const roomId = identity.roomId;

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
      const value = state.currentField?.value ?? 0;
      const categoryIndex = state.currentField?.categoryIndex ?? 0;

      const delta = data.correct ? pointsForCorrectSteal(value) : pointsForWrongSteal(value);
      state.scores = applyScoreDelta(state.scores, stealWinnerId, delta);

      // Mark field as answered
      state = markFieldAnswered(state, categoryIndex, value, stealWinnerId, data.correct, delta);
      state = resetBuzzer(state);

      // Check board completion
      const setup = JSON.parse((await tx.room.findUnique({ where: { id: roomId } }))?.setupSnapshotJson ?? '{}') as {
        board1?: { categories: Array<{ name: string; clues: Array<{ value: number }> }> };
      };
      const boardCategories = state.currentBoard === 1 ? setup.board1?.categories : [];

      if (isBoardComplete(state, state.currentBoard)) {
        state.phase = JEOPARDY_PHASES.BOARD_COMPLETE;
      } else {
        state.phase = JEOPARDY_PHASES.FIELD_DONE;
      }

      await tx.roomGameState.update({
        where: { roomId },
        data: {
          stateJson: JSON.stringify(state),
          phase: state.phase,
          revision: { increment: 1 },
        },
      });

      await tx.participation.update({
        where: { id: stealWinnerId },
        data: { score: state.scores[stealWinnerId] },
      });

      return { state, stealWinnerId, delta, value, categoryIndex, correct: data.correct };
    });

    const { state, stealWinnerId, delta, value, categoryIndex } = result;
    const answer = state.currentField?.fieldDef.answer ?? '';
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
    const identity = getSocketDataIdentity(socket);
    if (!identity?.roomId) return { success: false, error: 'NOT_IN_ROOM' };
    if (identity.role !== 'MODERATOR') return { success: false, error: 'UNAUTHORIZED' };

    const roomId = identity.roomId;

    await prisma.$transaction(async (tx) => {
      const gameStateData = await tx.roomGameState.findUnique({ where: { roomId } });
      if (!gameStateData) throw new Error('GAME_NOT_FOUND');

      let state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

      // Valid phases: FIELD_DONE, BOARD_COMPLETE, GAME_END
      const validPhases = [JEOPARDY_PHASES.FIELD_DONE, JEOPARDY_PHASES.BOARD_COMPLETE];
      if (!validPhases.includes(state.phase)) {
        throw new Error('PHASE_NOT_FIELD_DONE');
      }

      state = {
        ...state,
        currentField: null,
        phase: JEOPARDY_PHASES.SELECTING,
      };
      state = resetBuzzer(state);

      await tx.roomGameState.update({
        where: { roomId },
        data: {
          stateJson: JSON.stringify(state),
          phase: JEOPARDY_PHASES.SELECTING,
          revision: { increment: 1 },
        },
      });
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

    let state: JeopardyGameState = JSON.parse(gameStateData.stateJson);

    if (state.phase !== JEOPARDY_PHASES.BOARD_COMPLETE) {
      return { success: false, error: 'PHASE_NOT_BOARD_COMPLETE' };
    }

    if (state.currentBoard === 1) {
      // Switch to board 2
      const setup = JSON.parse(room.setupSnapshotJson ?? '{}') as {
        board2?: { categories: Array<{ name: string; clues: Array<{ value: number; question: string; answer: string }> }> };
      };

      if (!setup.board2) {
        // No board 2 → game ends
        return this.handleGameEnd(io, room, state);
      }

      // Register board 2 fields
      let newState = { ...state, currentBoard: 2 as 1 | 2 };
      for (let ci = 0; ci < setup.board2.categories.length; ci++) {
        for (const clue of setup.board2.categories[ci].clues) {
          const fieldDef: JeopardyFieldDef = {
            categoryIndex: ci,
            value: clue.value,
            question: clue.question,
            answer: clue.answer,
          };
          newState = registerField(newState, 2, ci, clue.value, fieldDef);
        }
      }

      newState = resetBuzzer(newState);
      newState.phase = JEOPARDY_PHASES.SELECTING;

      await prisma.roomGameState.update({
        where: { roomId: room.id },
        data: {
          stateJson: JSON.stringify(newState),
          phase: JEOPARDY_PHASES.SELECTING,
          revision: { increment: 1 },
        },
      });

      const categories = setup.board2.categories.map((cat) => ({
        name: cat.name,
        clueCount: cat.clues.length,
      }));
      const values = [...new Set(setup.board2.categories.flatMap((c) => c.clues.map((cl) => cl.value)))].sort(
        (a, b) => a - b
      );

      io.to(roomChannel(room.id)).emit('jeopardy:board:switch', {
        fromBoard: 1,
        toBoard: 2,
        categories,
        values,
        scores: newState.scores,
      } as JeopardyBoardCompleteEvent & { categories: Array<{ name: string; clueCount: number }>; values: number[]; scores: Record<string, number> });

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
    _state?: JeopardyGameState
  ): Promise<{ success: boolean; error?: string }> {
    const gameStateData = await prisma.roomGameState.findUnique({ where: { roomId: room.id } });
    const state = gameStateData ? (JSON.parse(gameStateData.stateJson) as JeopardyGameState) : null;

    await prisma.$transaction(async (tx) => {
      await tx.room.update({
        where: { id: room.id },
        data: {
          status: 'ENDED',
          runPhase: 'RESULTS',
          endedAt: new Date(),
        },
      });

      await tx.roomGameState.update({
        where: { roomId: room.id },
        data: { phase: JEOPARDY_PHASES.GAME_END },
      });
    });

    const scores = state?.scores ?? {};
    const finalScores = Object.entries(scores)
      .map(([playerId, score]) => ({
        playerId,
        playerName: state?.playerNames[playerId] ?? 'Unknown',
        score,
      }))
      .sort((a, b) => b.score - a.score);

    const topScore = finalScores[0]?.score ?? 0;
    const winnerIds = finalScores.filter((s) => s.score === topScore).map((s) => s.playerId);

    const endEvent: JeopardyGameEndEvent = {
      finalScores,
      winnerIds,
    };

    io.to(roomChannel(room.id)).emit('jeopardy:game:end', endEvent);

    logger.info('Jeopardy game ended', { roomId: room.id, finalScores });

    return { success: true };
  },
};
