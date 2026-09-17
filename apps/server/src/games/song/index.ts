// ============================================================
// Song Recognition (Erkenne den Song) Game Engine (Server)
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';

interface SongState {
  clips: Array<{
    id: string;
    audioUrl: string;
    startTime: number;
    duration: number;
    title: string;
    artist: string;
    aliases: Array<{ title: string; artist: string }>;
  }>;
  currentIndex: number;
  currentClip: any;
  buzzOpen: boolean;
  buzzWinner: string | null;
  phase: 'intro' | 'playing' | 'buzzed' | 'judging' | 'reveal';
  scores: Record<string, number>;
  judgeMode: 'strict' | 'partial'; // strict = both title and artist, partial = either
}

const states = new Map<string, SongState>();

export function initSongHandlers(io: Server, socket: Socket) {
  const { roomCode } = socket.data;

  socket.on('song:start', async () => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const setup = room.setupSnapshotJson as any;
    const clips = setup?.clips || [];
    const judgeMode = setup?.judgeMode || 'strict';

    const state: SongState = {
      clips,
      currentIndex: 0,
      currentClip: clips[0] || null,
      buzzOpen: false,
      buzzWinner: null,
      phase: 'intro',
      scores: {},
      judgeMode,
    };

    states.set(roomCode, state);

    io.to(`room:${roomCode}`).emit('song:start', {
      total: clips.length,
      judgeMode,
    });

    logger.info('Song game started', { roomCode, clipCount: clips.length });
  });

  socket.on('song:play', async () => {
    const state = states.get(roomCode);
    if (!state || state.phase !== 'intro') return;

    state.phase = 'playing';
    state.buzzOpen = true;

    io.to(`room:${roomCode}`).emit('song:playing', {
      clip: {
        audioUrl: state.currentClip.audioUrl,
        startTime: state.currentClip.startTime,
        duration: state.currentClip.duration,
      },
    });
  });

  socket.on('song:buzz', async () => {
    const state = states.get(roomCode);
    if (!state || !state.buzzOpen || state.buzzWinner) return;

    const playerId = socket.data.participationId;
    state.buzzWinner = playerId;
    state.buzzOpen = false;
    state.phase = 'buzzed';

    io.to(`room:${roomCode}`).emit('buzz:won', {
      playerId,
      playerName: socket.data.displayName,
    });

    logger.info('Song buzzed', { roomCode, playerId });
  });

  socket.on('song:judge', async (data: { result: 'correct' | 'partial' | 'wrong' }) => {
    const state = states.get(roomCode);
    if (!state || state.phase !== 'buzzed' || !state.buzzWinner) return;

    const winnerId = state.buzzWinner;
    let points = 0;

    if (data.result === 'correct') {
      points = 1;
    } else if (data.result === 'partial') {
      points = state.judgeMode === 'strict' ? 0 : 1;
    } else {
      points = 0;
      // Open buzz for others
      state.buzzOpen = true;
      state.buzzWinner = null;
      state.phase = 'playing';
      
      io.to(`room:${roomCode}`).emit('song:buzz:reopen', {});
      return;
    }

    state.scores[winnerId] = (state.scores[winnerId] || 0) + points;
    state.phase = 'reveal';

    io.to(`room:${roomCode}`).emit('song:reveal', {
      title: state.currentClip.title,
      artist: state.currentClip.artist,
      winner: winnerId,
      points,
      scores: state.scores,
    });
  });

  socket.on('song:next', async () => {
    const state = states.get(roomCode);
    if (!state) return;

    state.currentIndex++;
    if (state.currentIndex >= state.clips.length) {
      io.to(`room:${roomCode}`).emit('song:end', {
        scores: state.scores,
      });
      return;
    }

    state.currentClip = state.clips[state.currentIndex];
    state.buzzOpen = false;
    state.buzzWinner = null;
    state.phase = 'intro';

    io.to(`room:${roomCode}`).emit('song:next', {
      index: state.currentIndex,
      total: state.clips.length,
    });
  });

  return () => {
    states.delete(roomCode);
  };
}

export function initSongState(_roomCode: string) {
  // State initialized when game starts
}
