import { expect, it } from 'vitest';
import { activeTurn, advanceRound, advanceTurn, createTurn, matchAnswer, rankScores, requireWinningTurn, shuffleServer } from './roundFlow.js';

it('keeps turn ownership and rotation stable across serialization; disconnect does not alter order', () => {
  let turn = createTurn(['a', 'b', 'c'], 'ROTATING_START', 'a');
  expect(turn.order).toEqual(['b', 'c', 'a']);
  turn = JSON.parse(JSON.stringify(advanceTurn(turn)));
  expect(activeTurn(turn)).toBe('c');
  expect(() => requireWinningTurn(turn, 'b')).toThrow('TURN_OWNER_CONFLICT');
  expect(() => requireWinningTurn(undefined, 'old-persisted-winner')).not.toThrow();
  expect(activeTurn(advanceTurn(advanceTurn(turn)))).toBe('b');
  expect(() => createTurn(['a', 'a'])).toThrow('INVALID_TURN');
});
it('never silently awards a random winner or turns a fuzzy suggestion into an accepted answer', () => {
  expect(rankScores([{ id: 'a', score: 100 }, { id: 'b', score: 100 }, { id: 'c', score: 50 }]).map(e => [e.id, e.rank])).toEqual([['a', 1], ['b', 1], ['c', 3]]);
  expect(matchAnswer('  BERLIN  ', 'Berlin', 'NORMALIZED')).toBe('MATCH');
  expect(matchAnswer('Cologne', 'Köln', 'SYNONYM', ['Cologne'])).toBe('MATCH');
  expect(matchAnswer('Berln', 'Berlin', 'FUZZY')).toBe('NEEDS_JUDGE');
  expect(matchAnswer(null, 'Answer', 'MANUAL_ONLY')).toBe('NEEDS_JUDGE');
  expect(matchAnswer('A', 'a', 'EXACT')).toBe('NO_MATCH');
});
it('preserves random choices as an independent permutation and enforces round boundaries', () => {
  const source = ['a', 'b', 'c']; const chosen = shuffleServer(source);
  expect([...chosen].sort()).toEqual(source); expect(source).toEqual(['a', 'b', 'c']);
  expect(chosen).not.toBe(source);
  expect(advanceRound(0, 2)).toEqual({ nextIndex: 1, ended: false });
  expect(advanceRound(1, 2)).toEqual({ nextIndex: 2, ended: true });
  expect(() => advanceRound(2, 2)).toThrow('INVALID_ROUND_INDEX');
});
