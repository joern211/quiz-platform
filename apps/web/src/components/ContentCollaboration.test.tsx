import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentItemView, ContentPoolView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import { ContentCollaboration } from './ContentCollaboration';

afterEach(() => vi.restoreAllMocks());
const pool: ContentPoolView = { id: 'p', gameSlug: 'wissensduell', name: 'Pool', description: '', scope: 'PRIVATE', ownerId: 'u', revision: 1, defaults: { language: 'de-DE', difficulty: null, tagIds: [] }, canEdit: true };
const item: ContentItemView = { id: 'q', poolId: 'p', gameSlug: 'wissensduell', revision: 1, status: 'DRAFT', title: 'Question', payload: {}, language: null, difficulty: null, tagIds: null, source: '', sourceUrl: '', license: '', reviewState: 'NOT_REVIEWED', lockState: 'EDITABLE', effective: { language: 'de-DE', difficulty: null, tagIds: [] }, validation: [], updatedAt: '2026-10-26T00:00:00Z' };

it('orders active/cleanup/remount requests so a delayed StrictMode cleanup cannot erase a live editor', async () => {
  let complete!: (rows: Array<{ id: string; displayName: string }>) => void;
  const presence = vi.spyOn(contentApi, 'presence').mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
    .mockImplementation(async (_id, _key, active) => active ? [{ id: 'other', displayName: 'Other editor' }] : []);
  const view = render(<StrictMode><ContentCollaboration item={item} pool={pool} actorId="u" dirty={false} onSaved={vi.fn()} /></StrictMode>);
  await waitFor(() => expect(presence).toHaveBeenCalledTimes(1));
  await act(async () => complete([]));
  expect(await screen.findByText(/Gerade ebenfalls geöffnet: Other editor/)).toBeVisible();
  expect(presence.mock.calls.map(call => call[2])).toEqual([true, false, true]);
  view.unmount(); await waitFor(() => expect(presence).toHaveBeenCalledTimes(4));
  expect(presence.mock.calls.map(call => call[2])).toEqual([true, false, true, false]);
  expect(new Set(presence.mock.calls.map(call => call[1])).size).toBe(1);
});
