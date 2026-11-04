import { describe, expect, it } from 'vitest';
import type { BoardExpectedContext } from '@quiz/shared/board';
import { emptyBoardMemo, intakeBoardProjection, type BoardIntakeMemo, type BoardIntakeResult } from './boardIntake';
import { EXPECTED, OFFERED, SCOPE, T1, valid, view } from './boardTestFixtures';

/** Feeds a sequence of observations through the intake like a component would (memo carried over). */
function feed(steps: unknown[], expected: BoardExpectedContext = EXPECTED): { results: BoardIntakeResult[]; memo: BoardIntakeMemo | null } {
  let memo: BoardIntakeMemo | null = null;
  const results: BoardIntakeResult[] = [];
  for (const raw of steps) { const result = intakeBoardProjection(memo, expected, raw); results.push(result); memo = result.memo; }
  return { results, memo };
}
const bv = (result: BoardIntakeResult) => (result.held === null ? null : result.held.boardVersion);
const deepFreeze = <T>(value: T): T => { if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); } return value; };

describe('N11 board intake: fixtures and binding', () => {
  it('every builder variant is a valid client projection (so a rejection below is about the intake, not the fixture)', () => {
    expect(valid(view(T1()))).toBe(true);
    expect(valid(view(T1(), { targets: OFFERED }))).toBe(true);
    expect(valid(view(T1({ roll: null })))).toBe(true);
    expect(valid(view(T1({ roll: { dv: 1, count: 1, steps: 3, spent: true } })))).toBe(true);
    expect(valid(view(T1(), { release: 'NONE' }))).toBe(true);
    expect(valid(view(T1(), { recipient: null }))).toBe(true);
  });
  it('accepts a valid projection of the expected context and holds an independent copy', () => {
    const source = deepFreeze(view(T1(), { targets: OFFERED }));
    const { results } = feed([source]);
    expect(results[0].outcome).toBe('ACCEPTED');
    expect(results[0].held).toEqual(source);
    expect(results[0].held).not.toBe(source);
  });
  it('refuses invalid, foreign and too-old input: nothing is shown, no knowledge moves — also not with a huge counter', () => {
    const good = view(T1({ state: 5, bv: 2 }));
    const huge = { ...view(T1()), boardVersion: 9_999_999_999, stateVersion: 9_999_999_999 };
    const foreign = [
      view(T1(), { boardId: 'board-2' }), view(T1(), { recipient: 'p2' }), view(T1(), { recipient: null }), view(T1(), { scope: { ...SCOPE, runIndex: 2 } }),
      view(T1(), { scope: { ...SCOPE, sequenceId: 'seq-2' } }), view(T1(), { scope: { ...SCOPE, rosterRevision: 'roster-2' } }), view(T1(), { scope: { ...SCOPE, unit: 'TEAM' }, recipient: 'p1' }),
      huge, { ...good, extra: 1 }, { ...good, release: 'ALL' }, 'text', 42, [], {},
    ];
    for (const raw of foreign) {
      const { results } = feed([good, raw]);
      expect(results[1].outcome, JSON.stringify(raw).slice(0, 60)).toBe('WITHDRAWN');
      expect(results[1].held).toBeNull();
      expect(results[1].memo.seenBoardVersion).toBe(2); // the knowledge of the good view stays, the foreign one moved nothing
      expect(results[1].memo.seenStateVersion).toBe(5);
    }
    expect(feed([view(T1({ state: 0 }))], { ...EXPECTED, minStateVersion: 3 }).results[0].outcome).toBe('WITHDRAWN'); // older than the INDEPENDENT minimum
    expect(feed([view(T1({ state: 3 }))], { ...EXPECTED, minStateVersion: 3 }).results[0].outcome).toBe('ACCEPTED');
  });
  it('a packet made for recipient A is no packet for B — at every release level (also NONE)', () => {
    const asB = { ...EXPECTED, recipientId: 'p2' };
    expect(feed([view(T1(), { recipient: 'p1' })], asB).results[0].outcome).toBe('WITHDRAWN');
    expect(feed([view(T1(), { recipient: 'p1', release: 'NONE' })], asB).results[0].outcome).toBe('WITHDRAWN');
    expect(feed([view(T1(), { recipient: 'p2' })], asB).results[0].outcome).toBe('ACCEPTED');
  });
});

describe('N11 board intake: ordering chains, one level at a time', () => {
  it('new → null → older: an older packet after an empty / withdrawn view never restores the old board', () => {
    const { results } = feed([view(T1({ state: 6, bv: 1 })), null, view(T1({ state: 5, bv: 0 })), undefined, view(T1({ state: 6, bv: 1 }))]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'WITHDRAWN', 'STALE', 'WITHDRAWN', 'ACCEPTED']);
    expect(results[2].held).toBeNull(); // the stale packet is not shown after the withdrawal
  });
  it('a foreign view, then an EMPTY view (release NONE), then an older packet: the floor stays; the NONE view itself raises it', () => {
    const { results } = feed([view(T1({ state: 8, bv: 2 })), view(T1({ state: 8 }), { boardId: 'board-2' }), view(T1({ state: 9, bv: 2 }), { release: 'NONE' }), view(T1({ state: 8, bv: 2 })), view(T1({ state: 9, bv: 2 })), view(T1({ state: 10, bv: 2 }))]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'WITHDRAWN', 'RELEASE_NONE', 'STALE', 'STALE', 'ACCEPTED']); // a wider view at the very stand of the NONE view is refused too
    expect(results[2].memo.seenStateVersion).toBe(9);
    expect(results[3].held).toBeNull();
  });
  it.each([
    ['snapshot version', { state: 4 }], ['sequence version', { seq: 1 }], ['board version', { bv: 1 }], ['turn', { turn: 1 }],
  ])('older in the %s ALONE is stale, whatever the other levels say', (_name, older) => {
    const newest = T1({ state: 9, seq: 4, turn: 3, bv: 2, roll: { dv: 1, count: 1, steps: 3 } });
    const { results } = feed([view(newest), view({ ...newest, ...older })]);
    expect(results[1].outcome).toBe('STALE');
    expect(bv(results[1])).toBe(2);
  });
  it('the board outlives turns: A turn 1 → B turn 2 → A turn 3 → a LATE packet of turn 1 is stale although its local counters are equal or higher', () => {
    const t1 = view(T1({ state: 5, seq: 2, turn: 1, bv: 0, roll: { dv: 9, count: 1, steps: 3 } }));
    const t2 = view(T1({ state: 6, seq: 3, turn: 2, bv: 1, roll: { dv: 1, count: 1, steps: 2 } }), { holder: 'p2' });
    const t3 = view(T1({ state: 7, seq: 4, turn: 3, bv: 1, roll: { dv: 1, count: 1, steps: 5 } }));
    const { results } = feed([t1, t2, t3, t1]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED', 'STALE']);
    expect(results[3].held?.turnNumber).toBe(3);
  });
  it('inside one turn the roll is monotonic; another roll PROCESS in a known turn is foreign and moves nothing', () => {
    const a = view(T1({ state: 5, roll: { dv: 2, count: 1, steps: 3 } }));
    const olderRoll = view(T1({ state: 6, roll: { dv: 1, count: 1, steps: 3 } }));
    const foreign = view(T1({ state: 7, roll: { dv: 5, count: 3, steps: 3 } }), { diceId: 'dice-other' });
    const { results } = feed([a, olderRoll, foreign]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'STALE', 'STALE']);
    expect(results[2].memo.seenStateVersion).toBe(5);
    expect(results[2].memo.seenDiceId).toBe('dice-t1');
  });
  it('a view without a roll inside a known turn keeps the knowledge about the roll process', () => {
    const { results } = feed([view(T1({ state: 5, roll: { dv: 2, count: 1, steps: 3 } })), view(T1({ state: 6, roll: null })), view(T1({ state: 7, roll: { dv: 1, count: 1, steps: 3 } }))]);
    expect(results.map(r => r.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'STALE']);
    expect(results[1].memo.seenDiceVersion).toBe(2);
  });
  it('a wider release at the very same stand is refused (a withdrawal cannot be undone by its own earlier packet); the same or a narrower one is accepted', () => {
    const full = view(T1({ state: 5, bv: 1 }));
    const none = view(T1({ state: 5, bv: 1 }), { release: 'NONE' });
    const { results } = feed([none, full, none, full]);
    expect(results.map(r => r.outcome)).toEqual(['RELEASE_NONE', 'STALE', 'RELEASE_NONE', 'STALE']);
    expect(feed([full, none, none]).results.map(r => r.outcome)).toEqual(['ACCEPTED', 'RELEASE_NONE', 'RELEASE_NONE']);
  });
  it('another context (here: another board) starts with empty knowledge and never inherits the floor', () => {
    const first = intakeBoardProjection(null, EXPECTED, view(T1({ state: 50, bv: 9 })));
    const other = { ...EXPECTED, boardId: 'board-2' };
    const next = intakeBoardProjection(first.memo, other, view(T1({ state: 2, bv: 0 }), { boardId: 'board-2' }));
    expect(next.outcome).toBe('ACCEPTED');
    expect(next.memo.seenBoardVersion).toBe(0);
    expect(emptyBoardMemo('k').seenBoardVersion).toBe(-1);
  });
});
