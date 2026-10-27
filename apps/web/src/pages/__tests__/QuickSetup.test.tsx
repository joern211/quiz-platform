import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { contentApi } from '../../lib/contentApi';
import { QuickSetupPage } from '../QuickSetupPage';
import type { SetupBlueprintView } from '@quiz/shared';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.spyOn(contentApi, 'pools').mockResolvedValue([{ id: 'p', name: 'Quick Pool', gameSlug: 'wissensduell', description: '', scope: 'PRIVATE', ownerId: 'u', revision: 1, defaults: { language: 'de-DE', difficulty: null, tagIds: [] }, canEdit: true }]);
  vi.spyOn(contentApi, 'tags').mockResolvedValue([]); vi.spyOn(contentApi, 'difficultyPresets').mockResolvedValue([]); vi.spyOn(contentApi, 'setupBlueprints').mockResolvedValue([]);
});
function mount() { render(<MemoryRouter initialEntries={['/moderator/schnellstart/wissensduell']}><Routes><Route path="/moderator/schnellstart/:gameSlug" element={<QuickSetupPage />} /><Route path="/moderator/raum/:code/lobby" element={<p>Lobby erreicht</p>} /></Routes></MemoryRouter>); }
async function review(loadPreset = false) {
  mount();
  if (loadPreset) {
    await userEvent.click(screen.getByText('Vorhandene Spiel- oder Raumvorlage verwenden'));
    await screen.findByRole('option', { name: 'Quick preset · V1' }); await userEvent.selectOptions(screen.getByLabelText('Spiel-Preset', { exact: true }), 'preset');
    await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
  }
  await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  const pool = await screen.findByRole('checkbox', { name: 'Quick Pool · PRIVATE' }); if (!(pool as HTMLInputElement).checked) await userEvent.click(pool);
  await userEvent.click(screen.getByRole('button', { name: 'Weiter' })); await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  await userEvent.clear(screen.getByLabelText('Anzahl Fragen')); await userEvent.type(screen.getByLabelText('Anzahl Fragen'), '1');
  await userEvent.click(screen.getByRole('button', { name: 'Zurück' })); await userEvent.click(screen.getByRole('button', { name: 'Weiter' })); expect(screen.getByLabelText('Anzahl Fragen')).toHaveValue(1);
  await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  await userEvent.clear(screen.getByLabelText('Antwortzeit (Sekunden)')); await userEvent.type(screen.getByLabelText('Antwortzeit (Sekunden)'), '15');
  await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  await userEvent.clear(screen.getByLabelText('Maximale Spielerzahl')); await userEvent.type(screen.getByLabelText('Maximale Spielerzahl'), '6');
  await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
}
it('walks all seven steps, retains fields on back navigation and never replaces an explicit question count with a later default', async () => {
  const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { code: '123-456' } }) }); vi.stubGlobal('fetch', request);
  await review(); expect(screen.getByRole('region', { name: 'Vorbereitungsübersicht' })).toHaveTextContent('Fragen1');
  await userEvent.click(screen.getByRole('button', { name: 'Raum erstellen' })); expect(await screen.findByText('Lobby erreicht')).toBeVisible();
  const body = JSON.parse(request.mock.calls[0][1].body); expect(body).toMatchObject({ gameSlug: 'wissensduell', maxPlayers: 6, setupSnapshotJson: { questionCount: 1, timerDuration: 15, contentSelection: { poolIds: ['p'], count: 1 } } }); expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
});
it('guards a double click and retries an unconfirmed create with the same intent and preserved preparation', async () => {
  let reject!: (error: Error) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { code: '123-456' } }) }); vi.stubGlobal('fetch', request);
  await review(); await userEvent.click(screen.getByRole('button', { name: 'Raum erstellen' }));
  expect(screen.getByRole('button', { name: 'Raum wird erstellt …' })).toBeDisabled(); expect(request).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Offline'))); expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
  await userEvent.click(screen.getByRole('button', { name: 'Raum erstellen' })); await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual(JSON.parse(request.mock.calls[0][1].body));
});

it('uses later explicit question counts above a loaded full preset instead of its stale selection fields', async () => {
  const preset: SetupBlueprintView = { id: 'preset', revision: 1, scope: 'PRIVATE', kind: 'GAME_PRESET', gameSlug: 'wissensduell', favorite: false, name: 'Quick preset', configuration: { room: { maxPlayers: 4 }, setup: { questionCount: 3, timerDuration: 20, contentSelection: { poolIds: ['p'], count: 3, language: 'de-DE', repeatRule: 'NO_REPEAT_IN_ROOM', mode: 'RANDOM', tagIds: [], itemIds: [], visibility: 'HOST_PREVIEW' } } } };
  vi.mocked(contentApi.setupBlueprints).mockResolvedValue([preset]); vi.spyOn(contentApi, 'loadSetupBlueprint').mockResolvedValue({ blueprint: preset }); vi.spyOn(window, 'confirm').mockReturnValue(true);
  const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { code: '123-456' } }) }); vi.stubGlobal('fetch', request);
  await review(true); await userEvent.click(screen.getByRole('button', { name: 'Raum erstellen' }));
  expect(await screen.findByText('Lobby erreicht')).toBeVisible(); expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ gamePreset: { id: 'preset', revision: 1 }, setupSnapshotJson: { questionCount: 1, contentSelection: { count: 1 } } });
});
