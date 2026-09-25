// ============================================================
// Game Registry
// Central registration for all game modules
// ============================================================

// All game modules export a single handle object per convention.
// Each game handler must implement the contract expected by game.ts.
// ============================================================

import { handleGeoGame } from './geo/index.js';
import { handleJeopardy } from './jeopardy/index.js';

// Placeholders until each game exports its handle object
// TODO GATE-5: wire up each game's handle object
const handleWerIstDas = { name: 'weristdas', initialize: async () => {} };
const handleTimeline = { name: 'timeline', initialize: async () => {} };
const handleLuegen = { name: 'luegen', initialize: async () => {} };
const handleSong = { name: 'song', initialize: async () => {} };

export interface GameHandle {
  name: string;
  initialize: (io: any, room: any) => Promise<void>;
}

export const gameRegistry: Record<string, GameHandle> = {
  geo: handleGeoGame as unknown as GameHandle,
  jeopardy: handleJeopardy,
  weristdas: handleWerIstDas,
  timeline: handleTimeline,
  luegen: handleLuegen,
  song: handleSong,
};

export function getGameHandler(slug: string): GameHandle | null {
  return gameRegistry[slug] || null;
}

export function listGames(): string[] {
  return Object.keys(gameRegistry);
}
