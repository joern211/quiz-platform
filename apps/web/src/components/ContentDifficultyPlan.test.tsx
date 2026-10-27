import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { SYSTEM_DIFFICULTY_PRESETS, type ContentDifficultyPlan as Plan } from '@quiz/shared';
import { ContentDifficultyPlan } from './ContentDifficultyPlan';
import { contentApi } from '../lib/contentApi';
import { contentSelectionPayload } from './ContentPoolPicker';

afterEach(() => vi.restoreAllMocks());
function Editor({ count = 3, gameSlug = 'wissensduell' }: { count?: number; gameSlug?: string }) { const [plan, setPlan] = useState<Plan>(); return <ContentDifficultyPlan gameSlug={gameSlug} count={count} plan={plan} onChange={setPlan} />; }
function catalog() { return vi.spyOn(contentApi, 'difficultyPresets').mockResolvedValue(SYSTEM_DIFFICULTY_PRESETS.map(p => ({ ...p, gameSlug: 'wissensduell', scope: 'SYSTEM', revision: 1 }))); }
it('shows the exact rounded count, validates percentages and saves a private preset without changing selection', async () => {
  catalog(); const save = vi.spyOn(contentApi, 'saveDifficultyPreset').mockResolvedValue({ preset: { id: 'mine', name: 'Mein Verlauf', gameSlug: 'wissensduell', revision: 1, scope: 'PRIVATE', plan: SYSTEM_DIFFICULTY_PRESETS[1].plan } });
  render(<Editor />); await screen.findByRole('option', { name: 'Normal · System' });
  await userEvent.selectOptions(screen.getByLabelText('Schwierigkeitsvorlage'), 'system:normal');
  expect(screen.getByRole('status')).toHaveTextContent('3 Fragen: 1 Leicht · 2 Mittel');
  await userEvent.type(screen.getByLabelText('Name der eigenen Schwierigkeitsvorlage'), 'Mein Verlauf');
  await userEvent.click(screen.getByRole('button', { name: 'Schwierigkeitsvorlage speichern' }));
  expect(save).toHaveBeenCalledWith('wissensduell', 'Mein Verlauf', SYSTEM_DIFFICULTY_PRESETS[1].plan);
  await userEvent.clear(screen.getByLabelText('Leicht (%)')); await userEvent.type(screen.getByLabelText('Leicht (%)'), '30');
  expect(screen.getByRole('alert')).toHaveTextContent('100 Prozent'); expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('rejects ranges that no longer cover the question count and keeps manual ranges out of Jeopardy', async () => {
  catalog(); const page = render(<Editor count={4} />);
  await userEvent.selectOptions(screen.getByLabelText('Schwierigkeitsvorlage'), 'ranges');
  expect(screen.getByRole('status')).toHaveTextContent('4 Fragen: 4 Mittel');
  await userEvent.clear(screen.getByLabelText('Bis Frage')); await userEvent.type(screen.getByLabelText('Bis Frage'), '2');
  expect(screen.getByRole('alert')).toHaveTextContent('1 bis 4');
  await userEvent.click(screen.getByRole('button', { name: 'Bereich hinzufügen' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent('2 Mittel · 2 Schwer');
  page.unmount(); render(<Editor gameSlug="jeopardy" />); await screen.findByRole('option', { name: 'Normal · System' }); expect(screen.queryByRole('option', { name: 'Eigene Rundenbereiche' })).not.toBeInTheDocument();
});
it('uses the fixed pool total for range validation before attempting room creation', () => {
  const options = { language: 'de-DE', difficulty: '', category: '', repeatRule: 'NO_REPEAT_IN_ROOM', tagIds: [], poolCounts: { a: 2, b: 1 }, difficultyPlan: { kind: 'RANGES' as const, ranges: [{ from: 1, to: 3, difficulty: 'EASY' as const }] } };
  expect(contentSelectionPayload(['a', 'b'], 10, options).count).toBe(3);
  expect(() => contentSelectionPayload(['a', 'b'], 10, { ...options, poolCounts: { a: 2, b: 2 } })).toThrow('1 bis 4');
});
