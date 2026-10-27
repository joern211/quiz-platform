import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentPlaytestView } from '@quiz/shared';
import { ContentPlaytestPage } from '../ContentPlaytestPage';
import { contentApi, ContentApiError } from '../../lib/contentApi';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const view = (role: ContentPlaytestView['role'] = 'PLAYER'): ContentPlaytestView => ({ code: 'abcdefghijklmnopqrstuv', gameSlug: 'wissensduell', role, canControl: true, phase: 'QUESTION',
  version: 1, position: 0, total: 1, expiresAt: new Date(Date.now() + 3600000).toISOString(), endsAt: null, ownAnswer: null, ownReport: false, reports: [], warnings: [],
  question: { prompt: 'Testfrage?', options: [{ id: 'a', text: 'Antwort A' }, { id: 'b', text: 'Antwort B' }], ...(role === 'HOST' ? { correctOptionId: 'b', explanation: 'HOST_SECRET' } : {}) } });
function mount(query = '') { return render(<MemoryRouter initialEntries={[`/inhalte/playtest/abcdefghijklmnopqrstuv${query}`]}><Routes><Route path="/inhalte/playtest/:code" element={<ContentPlaytestPage />} /></Routes></MemoryRouter>); }
it('removes Host secrets immediately when perspective changes and discards an old in-flight Host response', async () => {
  let pending!: (v: ContentPlaytestView) => void;
  const read = vi.spyOn(contentApi, 'playtest').mockImplementation(async (_code, role) => view(role as ContentPlaytestView['role']));
  mount('?role=HOST'); expect(await screen.findByText('HOST_SECRET')).toBeVisible();
  read.mockImplementationOnce(() => new Promise(resolve => { pending = resolve; }));
  await userEvent.selectOptions(screen.getByLabelText('Perspektive'), 'VIEWER');
  expect(screen.queryByText('HOST_SECRET')).not.toBeInTheDocument();
  await waitFor(() => expect(pending).toBeTypeOf('function'));
  await userEvent.selectOptions(screen.getByLabelText('Perspektive'), 'TEAM');
  expect(await screen.findByText('Testfrage?')).toBeVisible();
  await act(async () => pending(view('HOST')));
  expect(screen.queryByText('HOST_SECRET')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Testantwort abgeben' })).not.toBeInTheDocument();
});
it('persists a guest client identity for rejoin and submits the selected answer without a normal room', async () => {
  const read = vi.spyOn(contentApi, 'playtest').mockResolvedValue(view());
  const submit = vi.spyOn(contentApi, 'playtestFeedback').mockImplementation(async () => { read.mockResolvedValue({ ...view(), ownAnswer: 'a' }); return {}; });
  const page = mount(); await screen.findByText('Testfrage?');
  await userEvent.click(screen.getByRole('radio', { name: 'Antwort A' }));
  await userEvent.click(screen.getByRole('button', { name: 'Testantwort abgeben' }));
  expect(await screen.findByText('Deine Testantwort: a')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Testantwort abgeben' })).toBeDisabled();
  const clientKey = submit.mock.calls[0][1].clientKey; expect(clientKey).toMatch(/^[0-9a-f-]{36}$/);
  page.unmount(); mount(); await screen.findByText('Deine Testantwort: a');
  expect(read).toHaveBeenLastCalledWith('abcdefghijklmnopqrstuv', 'PLAYER', clientKey);
});
it('clears question data on revoked capability and shows a useful closed/expired message', async () => {
  vi.spyOn(contentApi, 'playtest').mockRejectedValue(new ContentApiError('PLAYTEST_NOT_ACCESSIBLE', 'denied'));
  mount(); expect(await screen.findByRole('alert')).toHaveTextContent('beendet, abgelaufen'); expect(screen.queryByText('Testfrage?')).not.toBeInTheDocument();
});
it('preserves a report after a failed submission and sends no duplicate report after acceptance', async () => {
  const read = vi.spyOn(contentApi, 'playtest').mockResolvedValue(view());
  const submit = vi.spyOn(contentApi, 'playtestFeedback').mockRejectedValueOnce(new Error('Offline')).mockImplementation(async () => { read.mockResolvedValue({ ...view(), ownReport: true }); return {}; });
  mount(); await screen.findByText('Testfrage?');
  await userEvent.type(screen.getByLabelText('Fehler oder Warnung melden'), 'Bitte prüfen');
  await userEvent.click(screen.getByRole('button', { name: 'Hinweis speichern' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
  expect(screen.getByLabelText('Fehler oder Warnung melden')).toHaveValue('Bitte prüfen');
  await userEvent.click(screen.getByRole('button', { name: 'Hinweis speichern' }));
  await screen.findByText('Dein Hinweis zu dieser Frage ist gespeichert.'); expect(screen.getByRole('button', { name: 'Hinweis speichern' })).toBeDisabled();
  expect(submit).toHaveBeenCalledTimes(2);
});
