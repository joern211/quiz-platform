import { expect, it } from 'vitest';
import { resolveTie } from './tie.js';
const scores = [{ id: 'a', score: 10 }, { id: 'b', score: 10 }, { id: 'c', score: 5 }];
it('keeps equal places and joint winners under the declared ALLOW_TIE rule', () => {
  expect(resolveTie(scores, 'ALLOW_TIE')).toMatchObject({ status: 'RESOLVED', winnerIds: ['a', 'b'], rankings: [{ rank: 1 }, { rank: 1 }, { rank: 3 }] });
  expect(resolveTie([], 'ALLOW_TIE').winnerIds).toEqual([]);
});
it('leaves sudden death, questions, missing metrics and missing host decisions explicitly unresolved', () => {
  for (const strategy of ['SUDDEN_DEATH', 'TIEBREAKER_QUESTION', 'SECONDARY_METRIC', 'HOST_DECIDES'] as const) {
    expect(resolveTie(scores, strategy)).toMatchObject({ status: 'PENDING', winnerIds: [], requiredAction: strategy, tiedParticipantIds: ['a', 'b'] });
    expect(resolveTie([scores[0], scores[2]], strategy)).toMatchObject({ status: 'RESOLVED', winnerIds: ['a'] });
  }
});
it('accepts only a tied host winner or the pinned secondary metric, preserving stable ranks', () => {
  expect(() => resolveTie(scores, 'HOST_DECIDES', { hostWinnerId: 'c' })).toThrow('INVALID_TIE_WINNER');
  expect(resolveTie(scores, 'HOST_DECIDES', { hostWinnerId: 'b' })).toMatchObject({ winnerIds: ['b'], rankings: [{ id: 'b', rank: 1 }, { id: 'a', rank: 2 }, { id: 'c', rank: 3 }] });
  expect(resolveTie(scores, 'SECONDARY_METRIC', { secondaryMetric: { a: 2, b: 3 } })).toMatchObject({ status: 'RESOLVED', winnerIds: ['b'] });
  expect(resolveTie(scores, 'SECONDARY_METRIC', { secondaryMetric: { a: 2, b: 2 } }).status).toBe('PENDING');
  expect(() => resolveTie([scores[0], scores[0]], 'ALLOW_TIE')).toThrow('INVALID_TIE_PARTICIPANTS');
});
