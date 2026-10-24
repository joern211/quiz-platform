import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeratorGamePage } from '../ModeratorGamePage';
import { PlayerGamePage } from '../PlayerGamePage';
import { ViewerGamePage } from '../ViewerGamePage';

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => void>(),
  recovery: true,
  hasQuestion: true,
  command: vi.fn(),
}));

vi.mock('../../lib/sessionStore', () => ({
  getSession: () => ({ rejoinToken: 'test-token', participationId: 'p1' }),
}));

vi.mock('../../lib/socket', () => {
  const socket = {
    connected: true,
    on: (event: string, handler: (data: unknown) => void) => transport.handlers.set(event, handler),
    off: (event: string, handler: (data: unknown) => void) => { if (transport.handlers.get(event) === handler) transport.handlers.delete(event); },
    disconnect: vi.fn(),
    emit: (event: string, _data: unknown, ack: (data: unknown) => void) => {
      if (event === 'room:subscribe') ack({ success: true });
      if (event === 'geo:resync') ack({
        success: true,
        phase: transport.recovery ? 'ERROR_RECOVERY' : 'INPUT_OPEN',
        recoveryError: transport.recovery ? 'CONFIG_SNAPSHOT_INVALID' : undefined,
        timerEndMs: null, scores: {},
        question: transport.hasQuestion ? { id: 'q1', prompt: 'Beispielfrage', options: [{ id: 'a', text: 'Antwort A' }] } : null,
      });
    },
  };
  return {
    getSocket: () => socket,
    connectSocket: vi.fn(), disconnectSocket: vi.fn(),
    emitCommand: transport.command,
    __testSocket: socket,
  };
});

vi.mock('socket.io-client', async () => {
  const client = await import('../../lib/socket') as unknown as { __testSocket: unknown };
  return { io: () => client.__testSocket };
});

const roles = [
  ['Host', ModeratorGamePage], ['Player', PlayerGamePage], ['Viewer', ViewerGamePage],
] as const;

beforeEach(() => {
  transport.handlers.clear();
  transport.recovery = true;
  transport.hasQuestion = true;
  transport.command.mockReset();
});

describe('Geo configuration recovery across roles', () => {
  it.each(roles)('%s restores the persistent error on reload', async (_role, Component) => {
    render(<MemoryRouter initialEntries={['/123-456']}>
      <Routes><Route path="/:code" element={<Component />} /></Routes>
    </MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent(/angehalten/i);
    for (const button of screen.queryAllByRole('button')) {
      if (button.textContent !== 'Spiel beenden') expect(button).toBeDisabled();
    }
    expect(screen.queryByText(/CONFIG_SNAPSHOT/)).not.toBeInTheDocument();
  });

  it.each(roles)('%s shows a live failure and locks gameplay', async (_role, Component) => {
    transport.recovery = false;
    render(<MemoryRouter initialEntries={['/123-456']}>
      <Routes><Route path=":code" element={<Component />} /></Routes>
    </MemoryRouter>);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(transport.handlers.has('geo:round:error')).toBe(true);
    await act(async () => { transport.handlers.get('geo:round:error')?.({ error: 'CONFIG_SNAPSHOT_INVALID' }); });
    expect(screen.getByRole('alert')).toHaveTextContent(/angehalten/i);
  });

  it('Host can end a failed game even if the first question never loaded', async () => {
    transport.hasQuestion = false;
    render(<MemoryRouter initialEntries={['/123-456']}>
      <Routes><Route path="/:code" element={<ModeratorGamePage />} /></Routes>
    </MemoryRouter>);
    await userEvent.click(await screen.findByRole('button', { name: 'Spiel beenden' }));
    expect(transport.command).toHaveBeenCalledWith(
      expect.anything(), 'game:end', { roomCode: '123-456' }, '123-456:game:end', expect.any(Function),
    );
    expect(screen.queryByRole('button', { name: /Auflösen/ })).not.toBeInTheDocument();
  });
});
