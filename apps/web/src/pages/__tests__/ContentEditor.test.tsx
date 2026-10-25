import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentItemView, ContentPoolView } from '@quiz/shared';
import { ContentEditor, ContentPage } from '../ContentPage';
import { MemoryRouter } from 'react-router-dom';
import { ContentApiError, contentApi } from '../../lib/contentApi';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
const pool: ContentPoolView = { id: 'p', gameSlug: 'wissensduell', name: 'Pool', description: '', scope: 'PRIVATE', ownerId: 'u', revision: 1,
  defaults: { language: 'de-DE', difficulty: null, tagIds: [] }, canEdit: true };
const item: ContentItemView = { id: 'q', poolId: 'p', gameSlug: 'wissensduell', revision: 1, status: 'DRAFT', title: 'Original',
  payload: { prompt: 'Frage?', category: 'Test', options: [{ id: 'a', text: 'Ja' }, { id: 'b', text: 'Nein' }], correctOptionId: 'b', explanation: 'Geheim', durationMs: 20000, points: 100, wrongPoints: 0 },
  language: null, difficulty: null, tagIds: null, source: '', sourceUrl: '', license: '', reviewState: 'NOT_REVIEWED', lockState: 'EDITABLE',
  effective: { language: 'de-DE', difficulty: null, tagIds: [] }, validation: [], updatedAt: new Date().toISOString() };
it('autosaves after inactivity as DRAFT and never implicitly releases content', async () => {
  const save = vi.spyOn(contentApi, 'save').mockImplementation(async (_id, _rev, draft) => ({ ...item, ...(draft as object), revision: 2 }));
  const release = vi.spyOn(contentApi, 'status');
  render(<ContentEditor initial={item} pool={pool} onSaved={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Frage'), ' Neu');
  expect(screen.getByRole('status')).toHaveTextContent('Ungespeichert');
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2500 });
  expect(save).toHaveBeenCalledWith('q', 1, expect.objectContaining({ payload: expect.objectContaining({ prompt: 'Frage? Neu' }) }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Gespeichert'));
  expect(release).not.toHaveBeenCalled();
});
it('preserves local text after a revision conflict and pauses automatic retry', async () => {
  const save = vi.spyOn(contentApi, 'save').mockRejectedValue(new ContentApiError('REVISION_CONFLICT', 'conflict'));
  render(<ContentEditor initial={item} pool={pool} onSaved={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Frage'), ' Mein Entwurf');
  expect(await screen.findByRole('alert', {}, { timeout: 2500 })).toHaveTextContent('inzwischen geändert');
  expect(screen.getByLabelText('Frage')).toHaveValue('Frage? Mein Entwurf');
  expect(screen.getByRole('button', { name: 'Aktuelle Version vergleichen' })).toBeVisible();
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Für Spiele freigeben' })).toBeDisabled();
});
it('does not overwrite text typed while the previous save is in flight', async () => {
  let resolveFirst!: (v: ContentItemView) => void;
  const save = vi.spyOn(contentApi, 'save').mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
    .mockImplementation(async (_id, _rev, draft) => ({ ...item, ...(draft as object), revision: 3 }));
  render(<ContentEditor initial={item} pool={pool} onSaved={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Frage'), ' A');
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2500 });
  await userEvent.type(screen.getByLabelText('Frage'), ' B');
  resolveFirst({ ...item, revision: 2, payload: { ...item.payload, prompt: 'Frage? A' } });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 2500 });
  expect(save).toHaveBeenLastCalledWith('q', 2, expect.objectContaining({ payload: expect.objectContaining({ prompt: 'Frage? A B' }) }));
  expect(screen.getByLabelText('Frage')).toHaveValue('Frage? A B');
});
it('retains advanced values across quick-mode switches', async () => {
  render(<ContentEditor initial={item} pool={pool} onSaved={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Erweiterte Optionen' }));
  await userEvent.type(screen.getByLabelText('Quelle'), 'Buch');
  await userEvent.click(screen.getByRole('button', { name: 'Einfache Ansicht' }));
  await userEvent.click(screen.getByRole('button', { name: 'Erweiterte Optionen' }));
  expect(screen.getByLabelText('Quelle')).toHaveValue('Buch');
});
it('renders Jeopardy-specific fields and read-only public content', () => {
  const clue = { ...item, gameSlug: 'jeopardy', payload: { question: 'Frage', answer: 'Lösung', category: 'Kategorie', value: 100 } };
  render(<ContentEditor initial={clue} pool={{ ...pool, gameSlug: 'jeopardy', canEdit: false, scope: 'PUBLIC' }} onSaved={vi.fn()} />);
  expect(screen.getByLabelText('Lösung')).toBeDisabled();
  expect(screen.getByLabelText('Punktwert')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Für Spiele freigeben' })).not.toBeInTheDocument();
});
it('enables pool creation using the real session endpoint and its nested user envelope', async () => {
  const fetch = vi.fn(async (path: string) => ({ ok: path === '/api/v1/auth/session' || path === '/api/v1/content/pools', headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => ({ success: true, data: path === '/api/v1/auth/session' ? { user: { id: 'host-id', role: 'HOST', displayName: 'Host' } } : [] }) }));
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter><ContentPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pool erstellen' })).toBeEnabled());
  expect(fetch).toHaveBeenCalledWith('/api/v1/auth/session', expect.objectContaining({ credentials: 'include' }));
});
