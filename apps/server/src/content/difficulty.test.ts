import { expect, it } from 'vitest';
import { ContentDifficultyPlanSchema, ContentSelectionSchema, contentDifficultySequence, SYSTEM_DIFFICULTY_PRESETS } from '@quiz/shared';
import { selectByDifficulty } from './difficulty.js';

const distribution = (easy: number, hard: number) => ({ kind: 'DISTRIBUTION' as const, percentages: { VERY_EASY: 0, EASY: easy, MEDIUM: 0, HARD: hard, VERY_HARD: 0 } });
it('allocates exact integer counts, including small and uneven percentages, without losing or fabricating questions', () => {
  for (let count = 1; count <= 100; count++) for (const preset of SYSTEM_DIFFICULTY_PRESETS) {
    const result = contentDifficultySequence(preset.plan, count); expect(result).toHaveLength(count);
    if (preset.plan.kind === 'DISTRIBUTION') for (const [difficulty, percentage] of Object.entries(preset.plan.percentages)) expect(Math.abs(result.filter(d => d === difficulty).length - count * percentage / 100)).toBeLessThan(1.000001);
  }
  expect(contentDifficultySequence(distribution(50, 50), 3)).toEqual(['EASY', 'EASY', 'HARD']);
});
it('refuses incomplete or overlapping ranges, malformed distributions and conflicting selection intent', () => {
  for (const plan of [distribution(40, 50), distribution(-10, 110), { kind: 'RANGES', ranges: [{ from: 2, to: 3, difficulty: 'EASY' }] },
    { kind: 'RANGES', ranges: [{ from: 1, to: 2, difficulty: 'EASY' }, { from: 2, to: 3, difficulty: 'HARD' }] }]) expect(ContentDifficultyPlanSchema.safeParse(plan).success).toBe(false);
  expect(() => contentDifficultySequence({ kind: 'RANGES', ranges: [{ from: 1, to: 2, difficulty: 'EASY' }] }, 3)).toThrow('DIFFICULTY_RANGE_COUNT');
  for (const intent of [{ difficulty: 'EASY' }, { mode: 'MANUAL', itemIds: ['q'] }]) expect(ContentSelectionSchema.safeParse({ poolIds: ['p'], difficultyPlan: distribution(50, 50), ...intent }).success).toBe(false);
});
it('satisfies both pool and difficulty quotas when a greedy first pick would make a feasible selection fail', () => {
  const candidates = [{ id: 'ae', poolId: 'a', difficulty: 'EASY' }, { id: 'ah', poolId: 'a', difficulty: 'HARD' }, { id: 'be', poolId: 'b', difficulty: 'EASY' }];
  for (let i = 0; i < 30; i++) {
    const selected = selectByDifficulty(candidates, ['a', 'b'], 2, { kind: 'RANGES', ranges: [{ from: 1, to: 1, difficulty: 'EASY' }, { from: 2, to: 2, difficulty: 'HARD' }] }, { a: 1, b: 1 }, undefined);
    expect(selected.map(q => q.id)).toEqual(['be', 'ah']);
  }
});
it('globally prefers unseen questions across both quotas and refuses insufficient/unknown difficulties', () => {
  const candidates = [{ id: 'ae', poolId: 'a', difficulty: 'EASY' }, { id: 'ah', poolId: 'a', difficulty: 'HARD' }, { id: 'be', poolId: 'b', difficulty: 'EASY' }, { id: 'bh', poolId: 'b', difficulty: 'HARD' }];
  for (let i = 0; i < 30; i++) expect(new Set(selectByDifficulty(candidates, ['a', 'b'], 2, distribution(50, 50), { a: 1, b: 1 }, new Set(['ah', 'be'])).map(q => q.id))).toEqual(new Set(['ah', 'be']));
  expect(() => selectByDifficulty(candidates.filter(q => q.id !== 'bh'), ['a', 'b'], 2, distribution(0, 100), undefined, undefined)).toThrow('DIFFICULTY_CONTENT_NOT_READY');
  expect(() => selectByDifficulty([{ id: 'unknown', poolId: 'a', difficulty: null }], ['a'], 1, distribution(100, 0), undefined, undefined)).toThrow();
});
