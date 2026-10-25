import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, it, expect, vi } from 'vitest';
import type { ContentPoolView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import { ContentImportTools, ContentReviewInbox } from './ContentTools';

afterEach(() => vi.restoreAllMocks());
const pool: ContentPoolView = { id: 'p', name: 'Pool', description: '', scope: 'PRIVATE', ownerId: 'u', gameSlug: 'wissensduell', revision: 1,
  canEdit: true, defaults: { language: 'de-DE', difficulty: null, tagIds: [] } };
it('never overwrites an existing duplicate by default and requires explicit unknown-tag decisions', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(contentApi, 'importPreview').mockResolvedValue({ importId: 'import-id', rows: [
    { index: 0, classification: 'EXACT', title: 'Existing', errors: [], unknownTags: [], targetId: 'q', targetRevision: 1, proposed: {}, current: {} },
    { index: 1, classification: 'NEW', title: 'New', errors: [], unknownTags: ['science'], targetId: null, targetRevision: null, proposed: {}, current: null },
  ] });
  const commit = vi.spyOn(contentApi, 'importCommit').mockResolvedValue({ results: [{ index: 0, status: 'SKIPPED' }, { index: 1, status: 'IMPORTED_DRAFT' }] });
  render(<ContentImportTools pool={pool} onChanged={vi.fn()} />);
  await userEvent.click(screen.getByText('Import, Export und Qualität'));
  await userEvent.upload(screen.getByLabelText('Importdatei'), new File(['{}'], 'questions.json', { type: 'application/json' }));
  await screen.findByRole('region', { name: 'Importvorschau' });
  expect(screen.getByLabelText('Aktion für Eintrag 1')).toHaveValue('SKIP');
  expect(screen.getByRole('button', { name: 'Import bestätigen' })).toBeDisabled();
  expect(commit).not.toHaveBeenCalled();
  await userEvent.selectOptions(screen.getByLabelText('Unbekannter Tag „science“'), 'IGNORE');
  await userEvent.click(screen.getByRole('button', { name: 'Import bestätigen' }));
  await waitFor(() => expect(commit).toHaveBeenCalledWith(expect.objectContaining({ decisions: [{ index: 0, action: 'SKIP' }, { index: 1, action: 'IMPORT_NEW' }],
    tagDecisions: [{ name: 'science', action: 'IGNORE' }] })));
});
it('shows pending reviews but offers no approval controls to an unauthorized host', async () => {
  vi.spyOn(contentApi, 'reviews').mockResolvedValue([{ id: 'r', kind: 'PUBLIC_POOL', poolName: 'Mein Pool', canDecide: false, proposed: {}, createdAt: new Date().toISOString() }]);
  vi.spyOn(contentApi, 'inbox').mockResolvedValue([]);
  render(<ContentReviewInbox onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Prüfungen & Inbox' }));
  expect(await screen.findByRole('heading', { name: 'Mein Pool' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Freigeben' })).not.toBeInTheDocument();
});
it('keeps failed import preview separate from a successful import', async () => {
  vi.spyOn(contentApi, 'importPreview').mockRejectedValue(new Error('Dateiformat prüfen'));
  render(<ContentImportTools pool={pool} onChanged={vi.fn()} />);
  await userEvent.click(screen.getByText('Import, Export und Qualität'));
  await userEvent.upload(screen.getByLabelText('Importdatei'), new File(['bad'], 'questions.csv', { type: 'text/csv' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Dateiformat prüfen');
  expect(screen.queryByRole('region', { name: 'Importvorschau' })).not.toBeInTheDocument();
});
