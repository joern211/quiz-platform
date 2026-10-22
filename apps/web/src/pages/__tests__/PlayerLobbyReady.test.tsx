import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { PlayerLobbyPage } from '../PlayerLobbyPage';

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => void>(),
  emit: vi.fn(),
}));
vi.mock('../../lib/socket', () => ({
  getSocket: () => ({ connected: true, emit: transport.emit, on: (event: string, handler: (data: unknown) => void) => transport.handlers.set(event, handler) }),
  connectSocket: vi.fn(), disconnectSocket: vi.fn(),
}));
vi.mock('../../lib/sessionStore', () => ({
  getSession: () => ({ participationId: 'p1', rejoinToken: 'test-token' }),
  setSession: vi.fn(),
}));

beforeEach(() => { transport.emit.mockReset(); transport.handlers.clear(); });

it('waits for room membership, serializes ready changes and allows retry after rejection', async () => {
  render(<MemoryRouter initialEntries={['/123-456']}>
    <Routes><Route path="/:code" element={<PlayerLobbyPage />} /></Routes>
  </MemoryRouter>);
  const readyButton = screen.getByRole('button', { name: 'Ich bin bereit!' });
  expect(readyButton).toBeDisabled();
  const subscribe = transport.emit.mock.calls.find(call => call[0] === 'room:subscribe')!;
  await act(async () => {
    transport.handlers.get('room:snapshot')?.({ status: 'LOBBY', players: [{ id: 'p1', displayName: 'Alice', role: 'PLAYER', ready: false, connected: true }] });
    subscribe[2]({ success: true });
  });
  expect(readyButton).toBeEnabled();
  await userEvent.click(readyButton);
  expect(readyButton).toBeDisabled();
  const readyCalls = () => transport.emit.mock.calls.filter(call => call[0] === 'player:ready:set');
  expect(readyCalls()).toHaveLength(1);
  expect(readyCalls()[0][1]).toMatchObject({ ready: true });
  await act(async () => { readyCalls()[0][2]({ success: false }); });
  expect(readyButton).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Bereitschaft konnte nicht gespeichert werden.');
  await userEvent.click(readyButton);
  expect(readyCalls()).toHaveLength(2);
  await act(async () => { readyCalls()[1][2]({ success: true }); });
  expect(screen.getByRole('button', { name: 'Nicht mehr bereit' })).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps ready disabled when subscription is rejected', async () => {
  render(<MemoryRouter initialEntries={['/123-456']}>
    <Routes><Route path="/:code" element={<PlayerLobbyPage />} /></Routes>
  </MemoryRouter>);
  await act(async () => { transport.emit.mock.calls[0][2]({ success: false, error: 'INVALID_REJOIN_TOKEN' }); });
  expect(screen.getByRole('button', { name: 'Ich bin bereit!' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('Raumbeitritt fehlgeschlagen');
});
