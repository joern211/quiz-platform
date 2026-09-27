import { describe, expect, it } from 'vitest';
import { applyScoreDelta, ensureScoreEntries } from './score.js';

describe('shared score primitives', () => {
  it('applies positive and negative game-owned deltas immutably', () => {
    const initial = { p1: 100 };
    const plus = applyScoreDelta(initial, 'p1', 50);
    const minus = applyScoreDelta(plus, 'p1', -25);

    expect(initial).toEqual({ p1: 100 });
    expect(plus).toEqual({ p1: 150 });
    expect(minus).toEqual({ p1: 125 });
  });

  it('initializes missing participants without changing existing scores', () => {
    expect(ensureScoreEntries({ p1: 42 }, ['p1', 'p2'])).toEqual({
      p1: 42,
      p2: 0,
    });
  });
});
