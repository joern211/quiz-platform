import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ModeratorLobbyPage } from '../ModeratorLobbyPage';

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (data?: unknown) => void>(),
  permissions: ['GAME_START'], blockers: [] as string[], warnings: [] as string[],
}));
vi.mock('../../components/MediaDeviceCheck', () => ({ MediaDeviceCheck: () => null }));
vi.mock('../../lib/sessionStore', () => ({ setSession: vi.fn() }));
vi.mock('../../lib/socket', () => ({
  getSocket: () => ({ connected: true,
    on: (event: string, run: (data?: unknown) => void) => transport.handlers.set(event, run),
    off: (event: string) => transport.handlers.delete(event),
    emit: (event: string, _data: unknown, ack: (data: unknown) => void) => {
      if (event === 'room:subscribe') ack({ success: true });
      if (event === 'room:core:read') ack({ success: true, view: {
        permissions: transport.permissions, policy: { readyRule: 'READY_CHECK_DISABLED' },
        preflight: { blockers: transport.blockers, warnings: transport.warnings },
      } });
    },
  }), connectSocket: vi.fn(), disconnectSocket: vi.fn(), emitCommand: vi.fn(),
}));
beforeEach(() => { transport.handlers.clear(); transport.permissions = ['GAME_START']; transport.blockers = []; transport.warnings = []; });
function mount() {
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<ModeratorLobbyPage />} /></Routes></MemoryRouter>);
}
it('uses server preflight instead of requiring two ready players when the configured policy permits starting', () => {
  mount();
  expect(screen.getByRole('button', { name: 'Spiel starten' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Erzwingen' })).not.toBeInTheDocument();
});
it('removes start authority on a live revocation and offers no override for hard blockers', async () => {
  mount();
  transport.permissions = [];
  await act(async () => transport.handlers.get('room:core:changed')?.());
  expect(screen.getByRole('button', { name: 'Spiel starten' })).toBeDisabled();
  transport.permissions = ['GAME_START']; transport.blockers = ['CONTENT_NOT_READY']; transport.warnings = ['NOT_ALL_READY'];
  await act(async () => transport.handlers.get('room:core:changed')?.());
  expect(screen.getByRole('button', { name: 'Spiel starten' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Erzwingen' })).not.toBeInTheDocument();
});
it('offers warning acknowledgement only with current start authority and no blockers', () => {
  transport.warnings = ['TEAMS_NOT_EQUAL']; mount();
  expect(screen.getByRole('button', { name: 'Spiel starten' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Erzwingen' })).toBeEnabled();
});
