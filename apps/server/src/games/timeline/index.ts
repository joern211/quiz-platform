// ============================================================
// Timeline Game Engine (Server)
// ============================================================

import { Server, Socket } from 'socket.io';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';

interface TimelineState {
  items: Array<{ id: string; value: number; displayText: string; imageUrl?: string }>;
  gallery: Array<{ id: string; value: number; displayText: string; imageUrl?: string }>;
  players: Record<string, { lives: number; currentTurn: boolean; ko: boolean }>;
  currentPlayer: string | null;
  currentItem: { id: string; value: number; displayText: string; imageUrl?: string } | null;
  minAnchor: { value: number; displayText: string };
  maxAnchor: { value: number; displayText: string };
}

const states = new Map<string, TimelineState>();

export function initTimelineHandlers(io: Server, socket: Socket) {
  const { roomCode } = socket.data;

  socket.on('timeline:start', async () => {
    const room = await prisma.room.findUnique({ where: { code: roomCode } });
    if (!room || room.status !== 'RUNNING') return;

    const setup = room.setupSnapshotJson as any;
    const items = setup?.items || [];

    const state: TimelineState = {
      items: [],
      gallery: items.map((item: any) => ({
        id: item.id,
        value: item.value,
        displayText: item.displayText,
        imageUrl: item.imageUrl,
      })),
      players: {},
      currentPlayer: null,
      currentItem: null,
      minAnchor: setup?.minAnchor || { value: 0, displayText: '0' },
      maxAnchor: setup?.maxAnchor || { value: 100, displayText: '100' },
    };

    // Initialize player lives
    const participations = await prisma.participation.findMany({
      where: { roomId: room.id, role: 'PLAYER' },
    });

    const livesPerPlayer = setup?.lives || 3;
    for (const p of participations) {
      state.players[p.id] = { lives: livesPerPlayer, currentTurn: false, ko: false };
    }

    // Set first player
    if (participations.length > 0) {
      state.currentPlayer = participations[0].id;
      state.players[participations[0].id].currentTurn = true;
    }

    // Draw first item
    if (state.gallery.length > 0) {
      const idx = Math.floor(Math.random() * state.gallery.length);
      state.currentItem = state.gallery.splice(idx, 1)[0];
    }

    states.set(roomCode, state);

    io.to(`room:${roomCode}`).emit('timeline:start', {
      galleryCount: state.gallery.length,
      players: state.players,
      minAnchor: state.minAnchor,
      maxAnchor: state.maxAnchor,
    });
  });

  socket.on('timeline:select', async (data: { position: number }) => {
    const state = states.get(roomCode);
    if (!state) return;

    const playerId = socket.data.participationId;
    if (state.currentPlayer !== playerId) return;

    const item = state.currentItem;
    if (!item) return;

    // Check if position is valid (between min and max)
    const isCorrect = data.position >= state.minAnchor.value && data.position <= state.maxAnchor.value;

    if (isCorrect) {
      // Place item in timeline
      state.items.push(item);

      io.to(`room:${roomCode}`).emit('timeline:update', {
        item: item,
        position: data.position,
        correct: true,
        players: state.players,
      });
    } else {
      // Lose a life
      const playerState = state.players[playerId];
      playerState.lives--;

      if (playerState.lives <= 0) {
        playerState.ko = true;
      }

      io.to(`room:${roomCode}`).emit('timeline:lives', {
        playerId,
        lives: playerState.lives,
        ko: playerState.ko,
      });

      if (!playerState.ko) {
        // Return item to gallery
        state.gallery.push(item);
      }
    }

    // Next player
    const playerIds = Object.keys(state.players).filter(id => !state.players[id].ko);
    const currentIdx = playerIds.indexOf(playerId);
    const nextIdx = (currentIdx + 1) % playerIds.length;
    state.currentPlayer = playerIds[nextIdx];
    state.players[state.currentPlayer].currentTurn = true;

    // Next item
    if (state.gallery.length > 0) {
      const idx = Math.floor(Math.random() * state.gallery.length);
      state.currentItem = state.gallery.splice(idx, 1)[0];
    } else {
      state.currentItem = null;
    }

    io.to(`room:${roomCode}`).emit('timeline:select', {
      nextPlayer: state.currentPlayer,
      item: state.currentItem,
      galleryCount: state.gallery.length,
    });

    // Check end condition
    if (!state.currentItem || playerIds.length <= 1) {
      io.to(`room:${roomCode}`).emit('timeline:end', {
        winner: playerIds.length === 1 ? playerIds[0] : null,
        items: state.items,
      });
    }

    logger.info('Timeline select', { roomCode, playerId, position: data.position, correct: isCorrect });
  });

  return () => {
    states.delete(roomCode);
  };
}

export function initTimelineState(_roomCode: string) {
  // Timeline state is initialized when game starts
}
