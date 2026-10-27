import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ViewerLobbyPage } from '../ViewerLobbyPage';

const mocks = vi.hoisted(() => ({ listeners: new Map<string, (value: unknown) => void>(), emit: vi.fn(), disconnect: vi.fn() }));
vi.mock('../../lib/socket', () => ({
  getSocket: () => ({ connected: true, on: (event: string, handler: (value: unknown) => void) => mocks.listeners.set(event, handler), emit: mocks.emit }),
  connectSocket: vi.fn(), disconnectSocket: mocks.disconnect,
}));
vi.mock('../../lib/sessionStore', () => ({ getSession: () => ({ roomCode: '123-456', role: 'VIEWER', rejoinToken: 'waiting-token' }), setSession: vi.fn() }));
beforeEach(() => {
  mocks.listeners.clear(); mocks.emit.mockReset();
  mocks.emit.mockImplementation((_event, _data, ack) => ack?.({ success: true }));
});
it('keeps a pending viewer in the lobby during a running game and navigates only on admission', () => {
  render(<MemoryRouter initialEntries={['/zuschauen/123-456/lobby']}><Routes>
    <Route path="/zuschauen/:code/lobby" element={<ViewerLobbyPage />} />
    <Route path="/jeopardy/zuschauer/:code" element={<p>Admitted game</p>} />
  </Routes></MemoryRouter>);
  act(() => mocks.listeners.get('room:snapshot')?.({ status: 'RUNNING', admission: 'PENDING_JOIN', players: [], gameSlug: 'jeopardy' }));
  expect(screen.getByRole('status')).toHaveTextContent('Du wartest auf die Freigabe');
  act(() => mocks.listeners.get('game:start')?.({ status: 'RUNNING', gameSlug: 'jeopardy' }));
  expect(screen.queryByText('Admitted game')).not.toBeInTheDocument();
  act(() => mocks.listeners.get('room:admission')?.({ admission: 'ACTIVE', status: 'RUNNING', gameSlug: 'jeopardy' }));
  expect(screen.getByText('Admitted game')).toBeVisible();
});
