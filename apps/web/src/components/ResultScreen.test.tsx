import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ResultScreen } from './ResultScreen';
const transport = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), command: vi.fn(), permissions: [] as string[] }));
vi.mock('../lib/socket', () => ({
  getSocket: () => ({ connected: true, emit: (event: string, _payload: unknown, callback: (result: unknown) => void) => {
    if (event === 'room:subscribe') callback({ success: true });
    if (event === 'room:core:read') callback({ success: true, view: { permissions: transport.permissions, history: [], isOwner: false, runIndex: 1 } });
  }, on: (event: string, handler: () => void) => transport.handlers.set(event, handler), off: (event: string) => transport.handlers.delete(event) }),
  connectSocket: vi.fn(), emitCommand: transport.command,
}));
vi.mock('../lib/sessionStore', () => ({ getSession: () => ({ roomCode: '123-456', role: 'PLAYER', rejoinToken: 'proof' }) }));
const data = { roomCode: '123-456', roomName: 'Result', status: 'ENDED', runPhase: 'GAME_END', runIndex: 1, resultRevision: 1, resultStatus: 'GAME_END',
  game: { slug: 'jeopardy', name: 'Jeopardy' }, scores: [{ rank: 1, participationId: 'a', displayName: 'Alice', role: 'PLAYER', score: 100 }, { rank: 1, participationId: 'b', displayName: 'Bob', role: 'PLAYER', score: 100 }], endedAt: new Date().toISOString() };
function mount() { return render(<MemoryRouter><ResultScreen roomCode="123-456" role="HOST" /></MemoryRouter>); }
beforeEach(() => { transport.handlers.clear(); transport.command.mockReset(); transport.permissions = [];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data }) })); });
it('shows tied authoritative ranks, supplies protected-read proof and hides management without permission', async () => {
  mount(); expect(await screen.findByText('Alice: 100 Punkte')).toBeInTheDocument();
  expect(screen.getAllByRole('listitem').map(x => x.getAttribute('value'))).toEqual(['1', '1']);
  expect(screen.queryByRole('button', { name: 'Ergebnisprüfung beginnen' })).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/results'), expect.objectContaining({ headers: { 'X-Rejoin-Token': 'proof' } }));
});
it('fences double-clicks until the result command is confirmed and sends the result revision', async () => {
  transport.permissions = ['SCORE_ADJUST']; mount(); const button = await screen.findByRole('button', { name: 'Ergebnisprüfung beginnen' });
  await userEvent.dblClick(button); expect(transport.command).toHaveBeenCalledTimes(1); expect(button).toBeDisabled();
  expect(transport.command.mock.calls[0][2]).toMatchObject({ roomCode: '123-456', runIndex: 1, resultRevision: 1, operation: { type: 'REVIEW' } });
  await act(async () => transport.command.mock.calls[0][4]({ success: false })); expect(screen.getByRole('alert')).toBeInTheDocument();
});
it('uses amendments for finalized results and never sends an absolute replacement score', async () => {
  transport.permissions = ['SCORE_ADJUST']; vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { ...data, resultStatus: 'FINALIZED' } }) } as Response);
  mount(); await screen.findByText('Verbindlich bestätigt');
  await userEvent.selectOptions(screen.getByLabelText('Teilnehmer'), 'a'); await userEvent.type(screen.getByLabelText('Punkteänderung'), '-20'); await userEvent.type(screen.getByLabelText('Grund'), 'Antwort neu bewertet');
  await userEvent.click(screen.getByRole('button', { name: 'Korrektur speichern' }));
  expect(transport.command.mock.calls[0][2].operation).toEqual({ type: 'AMEND', participantId: 'a', delta: -20, reason: 'Antwort neu bewertet' });
});
it('shows a failed authoritative fetch instead of silently displaying an old result from sessionStorage', async () => {
  sessionStorage.setItem('result_123-456', JSON.stringify({ scores: [{ displayName: 'Stale answer' }] }));
  vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({ success: false, error: { message: 'Nicht verfügbar' } }) } as Response);
  mount(); expect(await screen.findByText('Nicht verfügbar')).toBeInTheDocument(); expect(screen.queryByText('Stale answer')).not.toBeInTheDocument();
});
