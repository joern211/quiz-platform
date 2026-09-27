import { describe, expect, it } from 'vitest';
import { getGameHandler, listGames } from './registry.js';

describe('game registry', () => {
  it('registers only implemented game engines', () => {
    expect(listGames().sort()).toEqual(['geo', 'jeopardy']);
  });

  it('resolves known game engines', () => {
    expect(getGameHandler('geo')?.slug).toBe('geo');
    expect(getGameHandler('jeopardy')?.slug).toBe('jeopardy');
  });

  it('rejects unknown or not-yet-implemented games', () => {
    expect(getGameHandler('weristdas')).toBeNull();
    expect(getGameHandler('unknown')).toBeNull();
  });
});
