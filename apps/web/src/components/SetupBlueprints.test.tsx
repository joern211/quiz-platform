import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { RoomPolicySchema } from '@quiz/shared';
import type { GamePresetConfiguration, SetupBlueprintView } from '@quiz/shared';
import { SetupBlueprints } from './SetupBlueprints';
import { contentApi } from '../lib/contentApi';
import { blueprintConfiguration, blueprintRoomInput, roomSettingsAfterPin } from '../lib/setupBlueprints';
afterEach(() => vi.restoreAllMocks());
const current: GamePresetConfiguration = { room: { maxPlayers: 4, allowViewers: false, cameraEnabled: false }, setup: { questionCount: 3, timerDuration: 15 } };
const preset: SetupBlueprintView = { id: 'preset', revision: 1, scope: 'PRIVATE', kind: 'GAME_PRESET', gameSlug: 'wissensduell', favorite: false, name: 'Eigene Runde', configuration: current };
it('stores the full configuration as a private favorite-capable preset and loads it only after explicit confirmation', async () => {
  vi.spyOn(contentApi, 'setupBlueprints').mockResolvedValue([]);
  const save = vi.spyOn(contentApi, 'saveSetupBlueprint').mockResolvedValue({ blueprint: preset }), apply = vi.fn();
  vi.spyOn(contentApi, 'loadSetupBlueprint').mockResolvedValue({ blueprint: preset }); vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<SetupBlueprints gameSlug="wissensduell" current={() => current} onApply={apply} />);
  await userEvent.type(screen.getByLabelText('Presetname'), preset.name); await userEvent.click(screen.getByRole('button', { name: 'Aktuelle Konfiguration als Preset speichern' }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ kind: 'GAME_PRESET', configuration: current }), undefined); expect(apply).not.toHaveBeenCalled();
  await userEvent.click(await screen.findByRole('button', { name: 'Übernehmen' }));
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ room: expect.objectContaining({ allowViewers: false }) }), expect.objectContaining({ gamePreset: { id: 'preset', revision: 1 } }));
});
it('keeps false/zero overrides and passes only actual changes above a saved preset to room creation', () => {
  const { configuration, application } = blueprintConfiguration(current, preset, null);
  expect(blueprintRoomInput(configuration, application)).toEqual({ setupSnapshotJson: {}, gamePreset: { id: preset.id, revision: 1 }, roomTemplate: undefined });
  const changed = blueprintRoomInput({ ...configuration, room: { ...configuration.room, viewerLimit: 0 }, setup: { ...configuration.setup, timerDuration: 20 } }, application);
  expect(changed).toMatchObject({ viewerLimit: 0, setupSnapshotJson: { timerDuration: 20 } }); expect(changed).not.toHaveProperty('allowViewers');
});
it('keeps manually edited settings when a favorite changes the loaded revision', async () => {
  vi.spyOn(contentApi, 'setupBlueprints').mockResolvedValue([preset]); vi.spyOn(contentApi, 'loadSetupBlueprint').mockResolvedValue({ blueprint: preset });
  vi.spyOn(window, 'confirm').mockReturnValue(true); vi.spyOn(contentApi, 'saveSetupBlueprint').mockResolvedValue({ blueprint: { ...preset, revision: 2, favorite: true } });
  let value = current; const apply = vi.fn(); render(<SetupBlueprints gameSlug="wissensduell" current={() => value} onApply={apply} />);
  await screen.findByRole('option', { name: 'Eigene Runde · V1' }); await userEvent.selectOptions(screen.getByLabelText('Spiel-Preset', { exact: true }), preset.id);
  await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' })); await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  value = { ...current, setup: { ...current.setup, timerDuration: 23 } }; await userEvent.click(screen.getByRole('button', { name: 'Als Favorit pinnen' }));
  expect(apply).toHaveBeenLastCalledWith(value, expect.objectContaining({ gamePreset: { id: preset.id, revision: 2 } }));
});

it('preserves PIN access when team or template rules are active, without storing the PIN in a preset', () => {
  const room = { roomPolicy: RoomPolicySchema.parse({ teamMode: 'SELF_SELECT', viewerAccess: 'INVITE_ONLY' }) };
  const protectedRoom = roomSettingsAfterPin(room, '1234');
  expect(protectedRoom.roomPolicy).toMatchObject({ playerAccess: 'PIN_PROTECTED', viewerAccess: 'INVITE_ONLY', teamMode: 'SELF_SELECT' });
  expect(JSON.stringify(protectedRoom)).not.toContain('1234');
  expect(roomSettingsAfterPin(protectedRoom, '').roomPolicy?.playerAccess).toBe('PUBLIC_JOIN');
});
it('switches an explicitly confirmed manual selection to RANDOM-only when enabling blind moderation', async () => {
  const { MemoryRouter } = await import('react-router-dom'); const { ContentPoolPicker, DEFAULT_CONTENT_OPTIONS } = await import('./ContentPoolPicker');
  vi.spyOn(contentApi, 'pools').mockResolvedValue([]); vi.spyOn(contentApi, 'tags').mockResolvedValue([]); vi.spyOn(contentApi, 'difficultyPresets').mockResolvedValue([]); vi.spyOn(window, 'confirm').mockReturnValue(true);
  const change = vi.fn(); render(<MemoryRouter><ContentPoolPicker gameSlug="wissensduell" selected={['p']} onChange={vi.fn()} options={{ ...DEFAULT_CONTENT_OPTIONS, mode: 'MANUAL', itemIds: ['q'] }} onOptionsChange={change} /></MemoryRouter>);
  await userEvent.selectOptions(screen.getByLabelText('Inhaltssicht des Hosts', { exact: true }), 'BLIND_HOST');
  expect(window.confirm).toHaveBeenCalled(); expect(change).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'BLIND_HOST', mode: 'RANDOM', itemIds: [] }));
});
