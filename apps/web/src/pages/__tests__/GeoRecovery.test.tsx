import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeratorGamePage } from '../ModeratorGamePage';
import { PlayerGamePage } from '../PlayerGamePage';
import { ViewerGamePage } from '../ViewerGamePage';

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => void>(),
  recovery: true,
  phase: 'INPUT_OPEN',
  actions: [] as string[],
  hasQuestion: true,
  throttleCoreRead: false,
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
      if (event === 'game:core:read') ack(transport.throttleCoreRead
        ? { success: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED', retryable: true, details: { retryAfterMs: 100 } }
        : { success: true, projection: { roomCode: '123-456', runIndex: 1, gameSlug: 'wissensduell', engineVersion: 1, stateVersion: 2, enginePhase: transport.phase, corePhase: 'ROUND_ACTIVE', informationRole: 'PLAYER', timer: null, progress: { currentRound: 1, totalRounds: 2, remainingRounds: 2, progressPercent: 0 }, availableActions: transport.actions.map(key => ({ key, event: `geo:${key}`, label: key })) } });
      if (event === 'room:subscribe') ack({ success: true });
      if (event === 'geo:resync') ack({
        success: true,
        phase: transport.recovery ? 'ERROR_RECOVERY' : transport.phase,
        recoveryError: transport.recovery ? 'CONFIG_SNAPSHOT_INVALID' : undefined,
        timerEndMs: null, scores: {},
        question: transport.hasQuestion ? { id: 'q1', prompt: 'Beispielfrage', options: [{ id: 'a', text: 'Antwort A' }] } : null,
      });
    },
  };
  return {
    getSocket: () => socket,
    observeSocket: (listener: (s: typeof socket) => void) => { listener(socket); return () => {}; },
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
  transport.recovery = true; transport.phase = 'INPUT_OPEN'; transport.actions = [];
  transport.hasQuestion = true;
  transport.throttleCoreRead = false;
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

it('Player keeps an open answer disabled after the server removes the action', async () => {
  transport.recovery = false;
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<PlayerGamePage />} /></Routes></MemoryRouter>);
  const answer = await screen.findByRole('button', { name: /Antwort A/ });
  expect(answer).toBeDisabled();
  transport.actions = ['answer'];
  await act(async () => transport.handlers.get('game:core:changed')?.({}));
  expect(answer).toBeEnabled();
});
it('Player can use the server-approved Spy action after input locks', async () => {
  transport.recovery = false; transport.phase = 'INPUT_LOCKED'; transport.actions = ['jokerSpy'];
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<PlayerGamePage />} /></Routes></MemoryRouter>);
  const spy = await screen.findByRole('button', { name: 'Spy' }); expect(spy).toBeEnabled();
  await userEvent.click(spy);
  expect(transport.command).toHaveBeenCalledWith(expect.anything(), 'geo:joker:spy', expect.objectContaining({ roomCode: '123-456' }), expect.any(String), expect.any(Function));
  expect(screen.getByRole('button', { name: /Antwort A/ })).toBeDisabled();
});


it('REVIEW Player: an old successful answer ACK cannot mark the new round submitted', async () => {
  transport.recovery=false; transport.phase='INPUT_OPEN'; transport.actions=['answer'];
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<PlayerGamePage />} /></Routes></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button',{name:/Antwort A/}));
  const ack=transport.command.mock.calls[0][4] as (r:unknown)=>void;
  await act(async()=>transport.handlers.get('geo:question')?.({roundIndex:1,question:{id:'q2',prompt:'Neue Frage',options:[{id:'a',text:'Neue Antwort'}]},timerEndMs:Date.now()+60000}));
  expect(screen.queryByText('Antwort gespeichert.')).not.toBeInTheDocument();
  await act(async()=>ack({success:true}));
  expect(screen.queryByText('Antwort gespeichert.')).not.toBeInTheDocument();
});

it('REVIEW Player: an old rejected answer ACK cannot unlock the new round submission', async () => {
  transport.recovery=false; transport.phase='INPUT_OPEN'; transport.actions=['answer'];
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<PlayerGamePage />} /></Routes></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button',{name:/Antwort A/}));
  const oldAck=transport.command.mock.calls[0][4] as (r:unknown)=>void;
  await act(async()=>transport.handlers.get('geo:question')?.({roundIndex:1,question:{id:'q2',prompt:'Neue Frage',options:[{id:'a',text:'Neue Antwort'}]},timerEndMs:Date.now()+60000}));
  const answer=await screen.findByRole('button',{name:/Neue Antwort/});
  await userEvent.click(answer); expect(answer).toBeDisabled();
  await act(async()=>oldAck({success:false,error:'STALE_ROUND'}));
  expect(answer).toBeDisabled();
});

const nextQuestion = (run: number, round: number, id: string, label: string) => ({ roundIndex: round, runIndex: run,
  question: { id, prompt: 'Frage', options: [{ id: 'a', text: label }] }, timerEndMs: Date.now() + 60000 });

it('Player: sends the run and round the question was shown for and keeps current acknowledgements working', async () => {
  transport.recovery = false; transport.phase = 'INPUT_OPEN'; transport.actions = ['answer'];
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<PlayerGamePage />} /></Routes></MemoryRouter>);
  await screen.findByRole('button', { name: /Antwort A/ });
  await act(async () => transport.handlers.get('geo:question')?.(nextQuestion(2, 3, 'q9', 'Neue Antwort')));
  await userEvent.click(await screen.findByRole('button', { name: /Neue Antwort/ }));
  expect(transport.command).toHaveBeenCalledWith(expect.anything(), 'geo:answer',
    expect.objectContaining({ optionId: 'a', questionIndex: 3, runIndex: 2 }), expect.stringContaining('q9'), expect.any(Function));
  const ack = transport.command.mock.calls.at(-1)![4] as (r: unknown) => void;
  await act(async () => ack({ success: true }));
  expect(screen.getByText('Antwort gespeichert.')).toBeInTheDocument();
});

it('Player: an acknowledgement from an earlier run with the same question cannot touch the rematch question', async () => {
  transport.recovery = false; transport.phase = 'INPUT_OPEN'; transport.actions = ['answer'];
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<PlayerGamePage />} /></Routes></MemoryRouter>);
  await act(async () => transport.handlers.get('geo:question')?.(nextQuestion(1, 0, 'q1', 'Alt')));
  await userEvent.click(await screen.findByRole('button', { name: /Alt/ }));
  const oldAck = transport.command.mock.calls.at(-1)![4] as (r: unknown) => void;
  await act(async () => transport.handlers.get('geo:question')?.(nextQuestion(2, 0, 'q1', 'Revanche')));
  expect(screen.queryByText('Antwort gespeichert.')).not.toBeInTheDocument();
  await act(async () => oldAck({ success: true }));
  expect(screen.queryByText('Antwort gespeichert.')).not.toBeInTheDocument();
  const answer = await screen.findByRole('button', { name: /Revanche/ });
  expect(answer).not.toBeDisabled();
});

it('Player: a refusal by the action protection is explained and the answer stays selectable for a later try', async () => {
  transport.recovery = false; transport.phase = 'INPUT_OPEN'; transport.actions = ['answer'];
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<PlayerGamePage />} /></Routes></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: /Antwort A/ }));
  const ack = transport.command.mock.calls.at(-1)![4] as (r: unknown) => void;
  await act(async () => ack({ success: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED', retryable: true, details: { retryAfterMs: 400 } }));
  expect(screen.getByText(/Zu viele Aktionen in kurzer Zeit/)).toBeInTheDocument();
  expect(screen.queryByText('Antwort gespeichert.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Antwort A/ })).not.toBeDisabled();
});

it('Independent G5 review: a temporary core-read refusal on the real host page is visible and offers a fresh read', async () => {
  transport.recovery = false; transport.actions = ['pause', 'reveal', 'end'];
  render(<MemoryRouter initialEntries={['/123-456']}><Routes><Route path=":code" element={<ModeratorGamePage />} /></Routes></MemoryRouter>);
  const reveal = await screen.findByRole('button', { name: /Auflösen/ });
  expect(reveal).toBeEnabled();
  transport.throttleCoreRead = true;
  await act(async () => transport.handlers.get('room:core:changed')?.({}));
  expect(reveal).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Spiel beenden' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(/Zu viele|erneut|geladen/i);
  expect(screen.getByRole('button', { name: /erneut|neu laden|aktualisieren/i })).toBeEnabled();
  // a fresh successful read makes the same controls usable again (no reload, no other event)
  transport.throttleCoreRead = false;
  await userEvent.click(screen.getByRole('button', { name: 'Erneut laden' }));
  await waitFor(() => expect(screen.getByRole('button', { name: /Auflösen/ })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Spiel beenden' })).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
