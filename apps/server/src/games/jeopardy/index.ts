// ============================================================
// Jeopardy Game Engine (Server)
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../persistence/prisma.js';
import { logger } from '../observability/logger.js';

interface JeopardyState {
  currentBoard: 1 | 2;
  selectedCategory: number | null;
  selectedValue: number | null;
  openFields: Set<string>;
  currentSelectorId: string | null;
  buzzOpen: boolean;
  buzzWinner: string | null;
  scores: Record<string, number>;
}

const states = new Map<string, JeopardyState>();

export function initJeopardyHandlers(io: Server, socket: Socket) {
  const { roomCode } = socket.data;

  socket.on('jeopardy:field:open', async (data: { categoryIndex: number; value: number }) => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const state = states.get(roomCode)!;
    const fieldKey = `${data.categoryIndex}-${data.value}`;

    if (state.openFields.has(fieldKey)) return;

    state.openFields.add(fieldKey);
    state.selectedCategory = data.categoryIndex;
    state.selectedValue = data.value;
    state.buzzOpen = false;
    state.buzzWinner = null;

    // Get the clue
    const setup = room.setupSnapshot as any;
    const board = data.categoryIndex < 6 ? setup.board1 : setup.board2;
    const catIndex = data.categoryIndex % 6;
    const clue = board?.categories[catIndex]?.clues.find((c: any) => c.value === data.value);

    io.to(`room:${roomCode}`).emit('jeopardy:field:opened', {
      categoryIndex: data.categoryIndex,
      value: data.value,
      question: clue?.question || '',
      type: clue?.type || 'text',
    });

    logger.info('Jeopardy field opened', { roomCode, categoryIndex: data.categoryIndex, value: data.value });
  });

  socket.on('jeopardy:buzz', async () => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const state = states.get(roomCode)!;
    if (!state.buzzOpen || state.buzzWinner) return;

    state.buzzWinner = socket.data.participationId;
    state.buzzOpen = false;

    io.to(`room:${roomCode}`).emit('buzz:won', {
      playerId: socket.data.participationId,
      playerName: socket.data.displayName,
    });

    logger.info('Jeopardy buzz', { roomCode, playerId: socket.data.participationId });
  });

  socket.on('jeopardy:judge', async (data: { correct: boolean }) => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const state = states.get(roomCode)!;
    if (!state.buzzWinner) return;

    const setup = room.setupSnapshot as any;
    const value = state.selectedValue || 0;

    // Main player judgment
    if (data.correct) {
      state.scores[state.buzzWinner] = (state.scores[state.buzzWinner] || 0) + value;
    } else {
      state.scores[state.buzzWinner] = (state.scores[state.buzzWinner] || 0) - Math.floor(value / 2);
      
      // Open buzzer for steal
      state.buzzOpen = true;
      state.buzzWinner = null;
      io.to(`room:${roomCode}`).emit('jeopardy:steal:open');
    }

    // Get answer for reveal
    const board = (state.selectedCategory || 0) < 6 ? setup.board1 : setup.board2;
    const catIndex = (state.selectedCategory || 0) % 6;
    const clue = board?.categories[catIndex]?.clues.find((c: any) => c.value === value);

    io.to(`room:${roomCode}`).emit('jeopardy:reveal', {
      answer: clue?.answer || '',
      scores: state.scores,
    });

    logger.info('Jeopardy judge', { roomCode, correct: data.correct, buzzWinner: state.buzzWinner });
  });

  socket.on('jeopardy:steal:buzz', async () => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const state = states.get(roomCode)!;
    if (!state.buzzOpen || state.buzzWinner) return;

    state.buzzWinner = socket.data.participationId;
    state.buzzOpen = false;

    io.to(`room:${roomCode}`).emit('buzz:won', {
      playerId: socket.data.participationId,
      playerName: socket.data.displayName,
    });
  });

  socket.on('jeopardy:steal:judge', async (data: { correct: boolean }) => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const state = states.get(roomCode)!;
    if (!state.buzzWinner) return;

    const value = state.selectedValue || 0;
    const setup = room.setupSnapshot as any;

    if (data.correct) {
      // Half points for steal
      const halfPoints = Math.floor(value / 2);
      state.scores[state.buzzWinner] = (state.scores[state.buzzWinner] || 0) + halfPoints;
    } else {
      const halfPoints = Math.floor(value / 2);
      state.scores[state.buzzWinner] = (state.scores[state.buzzWinner] || 0) - halfPoints;
    }

    // Get answer for reveal
    const board = (state.selectedCategory || 0) < 6 ? setup.board1 : setup.board2;
    const catIndex = (state.selectedCategory || 0) % 6;
    const clue = board?.categories[catIndex]?.clues.find((c: any) => c.value === value);

    io.to(`room:${roomCode}`).emit('jeopardy:steal:close', {
      answer: clue?.answer || '',
      scores: state.scores,
    });
  });

  socket.on('jeopardy:select:next', async () => {
    const state = states.get(roomCode);
    if (!state) return;

    // Reset for next selection
    state.selectedCategory = null;
    state.selectedValue = null;
    state.buzzOpen = false;
    state.buzzWinner = null;
  });

  return () => {
    states.delete(roomCode);
  };
}

export function createJeopardyState(): JeopardyState {
  return {
    currentBoard: 1,
    selectedCategory: null,
    selectedValue: null,
    openFields: new Set(),
    currentSelectorId: null,
    buzzOpen: false,
    buzzWinner: null,
    scores: {},
  };
}

export function initJeopardyState(roomCode: string) {
  states.set(roomCode, createJeopardyState());
}
