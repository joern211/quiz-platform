// ============================================================
// Wer Luegt Am Besten (Who Lies Best) Game Engine (Server)
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';

interface LuegenState {
  currentRound: number;
  totalRounds: number;
  currentQuestion: { id: string; text: string; answer: string; explanation?: string };
  submissions: Map<string, { text: string; submitted: boolean }>;
  votes: Map<string, string>; // voterId -> submissionId
  phase: 'question' | 'submission' | 'voting' | 'reveal';
  timeLimit: number;
}

const states = new Map<string, LuegenState>();

export function initLuegenHandlers(io: Server, socket: Socket) {
  const { roomCode } = socket.data;

  socket.on('luegen:start', async () => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const setup = room.setupSnapshotJson as any;
    const questions = setup?.questions || [];
    const totalRounds = Math.min(questions.length, setup?.rounds || 10);

    const state: LuegenState = {
      currentRound: 0,
      totalRounds,
      currentQuestion: questions[0] || { id: '1', text: 'Sample Question', answer: 'Truth', explanation: '' },
      submissions: new Map(),
      votes: new Map(),
      phase: 'question',
      timeLimit: setup?.submissionTime || 60000,
    };

    states.set(roomCode, state);

    io.to(`room:${roomCode}`).emit('luegen:question', {
      round: 1,
      total: totalRounds,
      question: state.currentQuestion.text,
      timeLimit: state.timeLimit,
    });

    // Start submission phase after showing question
    setTimeout(() => {
      state.phase = 'submission';
      io.to(`room:${roomCode}`).emit('luegen:submission:start', { timeLimit: state.timeLimit });
    }, 3000);

    logger.info('Luegen started', { roomCode, totalRounds });
  });

  socket.on('luegen:submit', async (data: { text: string }) => {
    const state = states.get(roomCode);
    if (!state || state.phase !== 'submission') return;

    const playerId = socket.data.participationId;

    // One submission per player
    if (state.submissions.has(playerId)) return;

    // Don't accept the truth as a lie
    if (data.text.toLowerCase().trim() === state.currentQuestion.answer.toLowerCase().trim()) {
      socket.emit('error', { message: 'Du musst eine Luege einreichen!' });
      return;
    }

    state.submissions.set(playerId, { text: data.text.trim(), submitted: true });

    socket.emit('luegen:submit:ack', { success: true });

    // Check if all submissions received
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    const participations = await prisma.participation.findMany({
      where: { roomId: room!.id, role: 'PLAYER' },
    });

    if (state.submissions.size >= participations.length) {
      startVotingPhase(io, roomCode, state);
    }
  });

  socket.on('luegen:vote', async (data: { submissionId: string }) => {
    const state = states.get(roomCode);
    if (!state || state.phase !== 'voting') return;

    const voterId = socket.data.participationId;

    // Can't vote for own submission
    if (data.submissionId === voterId) return;

    // One vote per player
    if (state.votes.has(voterId)) return;

    state.votes.set(voterId, data.submissionId);

    socket.emit('luegen:vote:ack', { success: true });

    // Check if all votes received
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    const participations = await prisma.participation.findMany({
      where: { roomId: room!.id, role: 'PLAYER' },
    });

    if (state.votes.size >= participations.length) {
      startRevealPhase(io, roomCode, state);
    }
  });

  return () => {
    states.delete(roomCode);
  };
}

function startVotingPhase(io: Server, roomCode: string, state: LuegenState) {
  state.phase = 'voting';

  // Shuffle submissions for anonymous display
  const submissions = Array.from(state.submissions.entries())
    .map(([id, data]) => ({ id, text: data.text }))
    .sort(() => Math.random() - 0.5);

  io.to(`room:${roomCode}`).emit('luegen:vote:start', {
    submissions,
    timeLimit: state.timeLimit,
  });
}

function startRevealPhase(io: Server, roomCode: string, state: LuegenState) {
  state.phase = 'reveal';

  // Calculate scores
  const scores: Record<string, { correctVotes: number; earnedVotes: number; totalScore: number }> = {};

  for (const [submissionId] of state.submissions) {
    scores[submissionId] = { correctVotes: 0, earnedVotes: 0, totalScore: 0 };
  }

  // Count who picked the truth (correct votes)
  for (const [voterId, submissionId] of state.votes) {
    if (submissionId === 'truth') {
      scores[voterId].correctVotes++;
      scores[voterId].totalScore++;
    }
  }

  // Count who got votes on their lie
  for (const [, submissionId] of state.votes) {
    if (submissionId !== 'truth' && scores[submissionId]) {
      scores[submissionId].earnedVotes++;
      scores[submissionId].totalScore++;
    }
  }

  const allSubmissions = Array.from(state.submissions.entries()).map(([id, data]) => ({
    id,
    text: data.text,
    votes: Array.from(state.votes.entries()).filter(([, sId]) => sId === id).length,
  }));

  io.to(`room:${roomCode}`).emit('luegen:reveal', {
    truth: state.currentQuestion.answer,
    explanation: state.currentQuestion.explanation,
    submissions: allSubmissions,
    scores,
  });

  logger.info('Luegen reveal', { roomCode, submissions: allSubmissions.length });
}

export function initLuegenState(_roomCode: string) {
  // State initialized when game starts
}
