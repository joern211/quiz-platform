// ============================================================
// Game Registry
// Central registration for all game modules
// ============================================================

import { initGeoHandlers, initGeoState } from './geo/index';
import { initJeopardyHandlers, initJeopardyState } from './jeopardy/index';
import { initWerIstDasHandlers, initWerIstDasState } from './weristdas/index';
import { initTimelineHandlers, initTimelineState } from './timeline/index';
import { initLuegenHandlers, initLuegenState } from './luegen/index';
import { initSongHandlers, initSongState } from './song/index';

export interface GameHandlers {
  initState: (roomCode: string) => void;
  initSocket: (io: any, socket: any) => () => void;
}

export const gameRegistry: Record<string, GameHandlers> = {
  geo: {
    initState: initGeoState,
    initSocket: initGeoHandlers,
  },
  jeopardy: {
    initState: initJeopardyState,
    initSocket: initJeopardyHandlers,
  },
  weristdas: {
    initState: initWerIstDasState,
    initSocket: initWerIstDasHandlers,
  },
  timeline: {
    initState: initTimelineState,
    initSocket: initTimelineHandlers,
  },
  luegen: {
    initState: initLuegenState,
    initSocket: initLuegenHandlers,
  },
  song: {
    initState: initSongState,
    initSocket: initSongHandlers,
  },
};

export function getGameHandler(slug: string): GameHandlers | null {
  return gameRegistry[slug] || null;
}

export function listGames(): string[] {
  return Object.keys(gameRegistry);
}
