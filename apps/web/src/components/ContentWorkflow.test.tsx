import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentPoolView, ContentItemView, ContentTemplateView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import { ContentTemplates, SaveContentTemplate } from './ContentTemplates';
import { ContentReviewAssignments } from './ContentReviewAssignments';
import { ContentReviewQueue } from './ContentReviewQueue';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const pool: ContentPoolView = { id: 'p', name: 'Pool', gameSlug: 'wissensduell', ownerId: 'u', scope: 'PRIVATE', description: '', revision: 1, canEdit: true, canPropose: true, canManage: true, defaults: { language: 'de-DE', difficulty: null, tagIds: [] } };
const item = { id: 'new-id', poolId: 'p', status: 'DRAFT', revision: 1 } as ContentItemView;
const template = { id: 't', name: 'Meine Vorlage', scope: 'PRIVATE', revision: 1, gameSlug: 'wissensduell', item: {} } as ContentTemplateView;
it('creates a distinct saved draft from a template only after allowing the editor switch', async () => {
  vi.spyOn(contentApi, 'templates').mockResolvedValue([template]); const apply = vi.spyOn(contentApi, 'useTemplate').mockResolvedValue(item);
  const change = vi.fn().mockReturnValue(false), created = vi.fn();
  render(<ContentTemplates pool={pool} mayChange={change} onCreated={created} />);
  await userEvent.click(screen.getByText('Fragenvorlagen')); await userEvent.click(screen.getByRole('button', { name: 'Vorlagen laden' }));
  const button = await screen.findByRole('button', { name: 'Neuen Entwurf aus „Meine Vorlage“ erstellen' });
  await userEvent.click(button); expect(apply).not.toHaveBeenCalled(); change.mockReturnValue(true); await userEvent.click(button);
  await waitFor(() => expect(created).toHaveBeenCalledWith(item)); expect(apply).toHaveBeenCalledWith(template, pool);
});
it('requires an explicit decision before omitting a concrete file from a reusable template', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false), save = vi.spyOn(contentApi, 'saveTemplate').mockResolvedValue({});
  render(<SaveContentTemplate gameSlug="wissensduell" disabled={false} item={{ title: 'Test', payload: { prompt: 'Bleibt erhalten', mediaAssetId: 'private-id', mediaType: 'image' } }} />);
  await userEvent.click(screen.getByText('Als private Vorlage speichern')); await userEvent.type(screen.getByLabelText('Vorlagenname'), 'Vorlage');
  await userEvent.click(screen.getByRole('button', { name: 'Vorlage speichern' })); expect(save).not.toHaveBeenCalled();
  confirm.mockReturnValue(true); await userEvent.click(screen.getByRole('button', { name: 'Vorlage speichern' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('wissensduell', 'Vorlage', { title: 'Test', payload: { prompt: 'Bleibt erhalten', mediaType: 'image' } }));
});
it('disables stale review tasks and never uses content release to complete editorial work', async () => {
  vi.spyOn(contentApi, 'assignments').mockResolvedValue([{ id: 'task', itemId: 'q', poolId: 'p', assigneeId: 'u', assignedBy: 'u', revision: 1, itemRevision: 1, currentRevision: 2, status: 'OPEN', note: '', itemTitle: 'Geändert', poolName: 'Pool', stale: true, canAdvance: true }]);
  const release = vi.spyOn(contentApi, 'status'), advance = vi.spyOn(contentApi, 'advanceAssignment');
  render(<ContentReviewAssignments actorId="u" />); await userEvent.click(screen.getByText('Meine Prüfaufgaben')); await userEvent.click(screen.getByRole('button', { name: 'Prüfaufgaben laden' }));
  expect(await screen.findByRole('button', { name: 'Prüfung beginnen' })).toBeDisabled();
  expect(screen.getByText(/inzwischen geändert oder verschoben/)).toBeVisible(); expect(advance).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
});
it('resumes the review cursor and ignores decision shortcuts while typing or when permission is absent', async () => {
  const decide = vi.spyOn(contentApi, 'decide'), changed = vi.fn();
  const rows = [{ id: 'a', kind: 'ITEM_REVIEW', poolName: 'Erste Prüfung', canDecide: true, proposed: {}, current: [], createdAt: '' }, { id: 'b', kind: 'PUBLIC_POOL', poolName: 'Admin-Prüfung', canDecide: false, proposed: {}, current: [], createdAt: '' }];
  const { unmount } = render(<ContentReviewQueue reviews={rows} actorId="u" onChanged={changed} />);
  await userEvent.type(screen.getByLabelText('Begründung für die Einzelprüfung'), 'a r s n'); expect(decide).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Überspringen und nächste prüfen' }));
  expect(screen.getByRole('heading', { name: 'Admin-Prüfung' })).toBeVisible();
  screen.getByRole('region', { name: 'Einzelprüfung der Warteschlange' }).focus(); await userEvent.keyboard('a'); expect(decide).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Angezeigte Prüfung freigeben' })).toBeDisabled();
  unmount(); render(<ContentReviewQueue reviews={rows} actorId="u" onChanged={changed} />); expect(screen.getByRole('heading', { name: 'Admin-Prüfung' })).toBeVisible();
});
