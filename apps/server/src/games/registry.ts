// ============================================================
// Game Registry
// Single entry point for game lifecycle integration.
// ============================================================

import type { Server, Socket } from 'socket.io';
import { handleGeoGame, cancelGeoTimer } from './geo/index.js';
import { handleJeopardyGame } from './jeopardy/engine.js';
import { registerGeoEvents } from './geo/events.js';
import { registerJeopardyEvents } from './jeopardy/events.js';
import { logger } from '../observability/logger.js';

export interface GameRoom {
  id: string;
  code: string;
  setupSnapshotJson: string | null;
}

export interface GameInitializeContext {
  io: Server;
  room: GameRoom;
  initialPhase: string;
}

export interface GameHandle {
  slug: string;
  initialize(context: GameInitializeContext): Promise<void>;
  afterStart?(context: GameInitializeContext): Promise<void> | void;
  pause?(context: GameActionContext): Promise<void>;
  resume?(context: GameActionContext): Promise<void>;
  cleanup?(roomId: string): void;
  registerEvents?(io: Server, socket: Socket): void;
}

export interface GameActionContext {
  io: Server;
  socket: Socket;
  roomCode: string;
  callback?: (result: { success: boolean; error?: string }) => void;
}

const geoHandle: GameHandle = {
  slug: 'geo',
  async initialize({ io, room, initialPhase }) {
    await handleGeoGame.initialize(io, room, initialPhase);
  },
  afterStart({ io, room }) {
    // Geo owns its intro-to-first-round transition. Keeping this lifecycle
    // hook in the adapter prevents generic socket code from knowing Geo rules.
    setTimeout(() => {
      void handleGeoGame.startRound(io, room.code).catch((error) => {
        logger.error('Geo intro transition failed', { roomId: room.id, error });
      });
    }, 3000);
  },
  async pause({ io, socket, roomCode, callback }) {
    await handleGeoGame.handlePause(io, socket, { roomCode }, callback);
  },
  async resume({ io, socket, roomCode, callback }) {
    await handleGeoGame.handleResume(io, socket, { roomCode }, callback);
  },
  cleanup(roomId) { cancelGeoTimer(roomId); },
  registerEvents: registerGeoEvents,
};

const jeopardyHandle: GameHandle = {
  slug: 'jeopardy',
  registerEvents: registerJeopardyEvents,
  async initialize({ io, room }) {
    await handleJeopardyGame.initialize(io, room);
  },
};

// Future games are registered when their engines implement the lifecycle
// contract. Do not register no-op placeholders: starting an unsupported game
// must fail explicitly instead of leaving a RUNNING room without game state.
const gameRegistry = new Map<string, GameHandle>([
  [geoHandle.slug, geoHandle],
  [jeopardyHandle.slug, jeopardyHandle],
]);

export function getGameHandler(slug: string): GameHandle | null {
  return gameRegistry.get(slug) ?? null;
}

export function listGames(): string[] {
  return [...gameRegistry.keys()];
}

export function registerGameSocketHandlers(io: Server, socket: Socket): void {
  for (const handle of gameRegistry.values()) handle.registerEvents?.(io, socket);
}
