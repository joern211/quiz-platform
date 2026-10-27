import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentItemView, ContentPoolView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import { ContentBatchTools } from './ContentBatchTools';
import { ContentCollaboration } from './ContentCollaboration';

afterEach(() => vi.restoreAllMocks());
const pool: ContentPoolView = { id: 'p', gameSlug: 'wissensduell', name: 'P', description: '', scope: 'PRIVATE', ownerId: 'u', revision: 4, canEdit: true, canManage: true, defaults: { language: 'de-DE', difficulty: null, tagIds: [] } };
const item = { id: 'q', title: 'Frage eins', revision: 2, status: 'READY', lockState: 'EDITABLE' } as ContentItemView;
it('requires an impact preview and confirmation, keeps previewed revisions and shows partial failures', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const preview = vi.spyOn(contentApi, 'batchPreview').mockResolvedValue({ total: 1, eligible: 1, historicallyUsed: 1, rows: [{ id: 'q', title: 'Frage eins', revision: 2, uses: 1, effect: 'ARCHIVED', error: null }] });
  const commit = vi.spyOn(contentApi, 'batchCommit').mockResolvedValue({ results: [{ id: 'q', status: 'FAILED', error: 'REVISION_CONFLICT' }] });
  const changed = vi.fn(); render(<ContentBatchTools pool={pool} items={[item]} pools={[pool]} onChanged={changed} mayChange={() => true} />);
  await userEvent.click(screen.getByText('Sammelbearbeitung'));
  expect(screen.queryByRole('button', { name: 'Sammelaktion bestätigen' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('checkbox')); await userEvent.click(screen.getByRole('button', { name: 'Auswirkungen prüfen' }));
  const impact = await screen.findByRole('region', { name: 'Auswirkungen der Sammelaktion' }); expect(impact).toHaveTextContent('1 Fragen wurden bereits verwendet');
  expect(commit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Sammelaktion bestätigen' }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(commit).toHaveBeenCalledWith(preview.mock.calls[0][0]);
  expect(screen.getByRole('status')).toHaveTextContent('0 erfolgreich, 1 fehlgeschlagen');
  expect(screen.getByRole('status')).toHaveTextContent('REVISION_CONFLICT');
});
it('invalidates an impact preview whenever the intended action changes', async () => {
  vi.spyOn(contentApi, 'batchPreview').mockResolvedValue({ total: 1, eligible: 1, historicallyUsed: 0, rows: [] });
  render(<ContentBatchTools pool={pool} items={[item]} pools={[pool]} onChanged={vi.fn()} mayChange={() => true} />);
  await userEvent.click(screen.getByText('Sammelbearbeitung')); await userEvent.click(screen.getByRole('checkbox'));
  await userEvent.click(screen.getByRole('button', { name: 'Auswirkungen prüfen' })); await screen.findByRole('button', { name: 'Sammelaktion bestätigen' });
  await userEvent.selectOptions(screen.getByLabelText('Neuer Status'), 'DISABLED');
  expect(screen.queryByRole('button', { name: 'Sammelaktion bestätigen' })).not.toBeInTheDocument();
});
it('shows simultaneous editors without replacing local content and releases its own presence on unmount', async () => {
  const presence = vi.spyOn(contentApi, 'presence').mockResolvedValue([{ id: 'other', displayName: 'Andere Editorin' }]);
  const { unmount } = render(<ContentCollaboration item={item} pool={pool} actorId="u" dirty onSaved={vi.fn()} />);
  expect(await screen.findByText(/Andere Editorin/)).toBeInTheDocument();
  await userEvent.click(screen.getByText('Zusammenarbeit und Verwendung'));
  expect(screen.getByRole('button', { name: 'Bearbeitung sperren' })).toBeDisabled();
  expect(presence).toHaveBeenCalledWith('q', expect.any(String), true);
  const editorKey = presence.mock.calls[0][1]; unmount(); expect(presence).toHaveBeenLastCalledWith('q', editorKey, false);
});
