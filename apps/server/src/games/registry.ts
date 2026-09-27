// ============================================================
// Game Registry
// Single entry point for game lifecycle integration.
// ============================================================

import type { Server } from 'socket.io';
import { handleGeoGame } from './geo/index.js';
import { handleJeopardyGame } from './jeopardy/engine.js';

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
      void handleGeoGame.startRound(io, room.code);
    }, 3000);
  },
};

const jeopardyHandle: GameHandle = {
  slug: 'jeopardy',
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
