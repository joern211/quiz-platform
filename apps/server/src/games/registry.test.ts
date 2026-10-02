import { describe, expect, it } from 'vitest';
import { getGameHandler, listGames, startableSlugs } from './registry.js';
import { GAME_SLUGS } from '@quiz/shared';

describe('game registry', () => {
  it('registers only implemented game engines (kanonische Slugs, §14)', () => {
    // Nur tatsächlich startbare Engines – keine no-op-Placeholders (Regelwerk §13.1)
    expect(listGames().sort()).toEqual(
      [GAME_SLUGS.wissensduell, GAME_SLUGS.jeopardy, GAME_SLUGS.werIstDas].sort(),
    );
  });

  it('resolves known game engines (kanonisch)', () => {
    expect(getGameHandler(GAME_SLUGS.wissensduell)?.slug).toBe(GAME_SLUGS.wissensduell);
    expect(getGameHandler(GAME_SLUGS.jeopardy)?.slug).toBe(GAME_SLUGS.jeopardy);
    expect(getGameHandler(GAME_SLUGS.werIstDas)?.slug).toBe(GAME_SLUGS.werIstDas);
  });

  it('resolves legacy slugs to their canonical engine (§5.23)', () => {
    expect(getGameHandler('geo')?.slug).toBe(GAME_SLUGS.wissensduell);
    expect(getGameHandler('weristdas')?.slug).toBe(GAME_SLUGS.werIstDas);
  });

  it('startableSlugs == listGames (nur echte Engines)', () => {
    expect([...startableSlugs()].sort()).toEqual([...listGames()].sort());
  });

  it('rejects unknown or not-yet-implemented games', () => {
    expect(getGameHandler('unknown')).toBeNull();
    // geplante Spiele haben KEINEN Handler
    expect(getGameHandler(GAME_SLUGS.timeline)).toBeNull();
    expect(getGameHandler(GAME_SLUGS.songQuiz)).toBeNull();
  });
});
