import { RoomPolicySchema } from '@quiz/shared';
import { StrictMode } from 'react';
import { RoomPanel } from './RoomPanel';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { ResultScreen } from './ResultScreen';
const transport = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), command: vi.fn(), subscriptions: vi.fn(), owner: false, permissions: [] as string[] }));
vi.mock('../lib/socket', () => {
  const socket = { connected: true, emit: (event: string, _payload: unknown, callback: (result: unknown) => void) => {
    if (event === 'room:subscribe') { transport.subscriptions(); callback({ success: true }); }
    if (event === 'room:core:read') callback({ success: true, view: { gameSlug: 'jeopardy', permissions: transport.permissions, history: [], switchOptions: [], revision: 1, lifecycle: 'IDLE', policy: RoomPolicySchema.parse({}), scheduledAt: null, hostStatus: 'ONLINE', canManage: transport.owner, isOwner: transport.owner, selfId: 'a', selfAdmission: 'ACTIVE', teams: [], participants: [], feed: [], preflight: { status: 'BLOCKED', blockers: [], warnings: [] }, runIndex: 1 } });
  }, on: (event: string, handler: () => void) => transport.handlers.set(event, handler), off: (event: string) => transport.handlers.delete(event) };
  return { getSocket: () => socket, observeSocket: (listener: (value: typeof socket) => void) => { listener(socket); return () => {}; },
  connectSocket: vi.fn(), emitCommand: transport.command, };
});
vi.mock('../lib/sessionStore', () => ({ getSession: () => ({ roomCode: '123-456', role: 'PLAYER', rejoinToken: 'proof' }) }));
const data = { roomCode: '123-456', roomName: 'Result', status: 'ENDED', runPhase: 'GAME_END', runIndex: 1, resultRevision: 1, resultStatus: 'GAME_END',
  game: { slug: 'jeopardy', name: 'Jeopardy' }, scores: [{ rank: 1, participationId: 'a', displayName: 'Alice', role: 'PLAYER', score: 100 }, { rank: 1, participationId: 'b', displayName: 'Bob', role: 'PLAYER', score: 100 }], endedAt: new Date().toISOString() };
function mount() { return render(<MemoryRouter><ResultScreen roomCode="123-456" role="HOST" /></MemoryRouter>); }
beforeEach(() => { transport.handlers.clear(); transport.command.mockReset(); transport.subscriptions.mockReset(); transport.owner = false; transport.permissions = [];
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

it('keeps one room admission owner with the shared panel mounted on a result route', async () => {
  render(<MemoryRouter initialEntries={['/raum/123-456/ergebnis']}><ResultScreen roomCode="123-456" role="PLAYER" /><RoomPanel /></MemoryRouter>);
  expect(await screen.findByRole('heading', { name: 'Spiel beendet' })).toBeInTheDocument();
  expect(transport.subscriptions).toHaveBeenCalledTimes(1);
});
it('settles the authoritative result after StrictMode effect replay', async () => {
  render(<StrictMode><MemoryRouter><ResultScreen roomCode="123-456" role="PLAYER" /></MemoryRouter></StrictMode>);
  expect(await screen.findByText('Alice: 100 Punkte')).toBeInTheDocument();
  expect(screen.queryByText('Lädt …')).not.toBeInTheDocument();
});

it('shows one shared rematch control and pins its intent to the displayed run', async () => {
  transport.owner = true; transport.permissions = ['SCORE_ADJUST'];
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { ...data, resultStatus: 'FINALIZED' } }) } as Response);
  render(<MemoryRouter initialEntries={['/moderator/raum/123-456/ergebnis']}><ResultScreen roomCode="123-456" role="HOST" /><RoomPanel /></MemoryRouter>);
  await screen.findByText('Verbindlich bestätigt');
  const buttons = screen.getAllByRole('button', { name: 'Revanche vorbereiten' }); expect(buttons).toHaveLength(1);
  await userEvent.click(buttons[0]); expect(transport.command.mock.calls[0][2].operation).toEqual({ type: 'REMATCH', runIndex: 1 });
});

it('explains a refused result command as protection, not as an unconfirmed correction, and allows a later retry', async () => {
  transport.permissions = ['SCORE_ADJUST']; mount(); const button = await screen.findByRole('button', { name: 'Ergebnisprüfung beginnen' });
  await userEvent.click(button);
  await act(async () => transport.command.mock.calls[0][4]({ success: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED', retryable: true, details: { retryAfterMs: 800 } }));
  expect(screen.getByRole('alert')).toHaveTextContent('Zu viele Aktionen');
  expect(screen.getByRole('alert')).not.toHaveTextContent('Aktion nicht bestätigt');
  expect(button).not.toBeDisabled();
});

it('separates a historical revision from the live status and never offers corrections on it', async () => {
  transport.permissions = ['SCORE_ADJUST'];
  vi.mocked(fetch).mockImplementation(async (url) => ({ ok: true, json: async () => ({ success: true, data: String(url).includes('revision=1')
    ? { ...data, resultRevision: 1, resultStatus: 'FINALIZED', latestRevision: 3, isLatestRevision: false, statusAtRevision: 'GAME_END', revisionKind: 'GAME_ENDED',
        versions: [{ revision: 1, kind: 'GAME_ENDED', createdAt: '' }, { revision: 2, kind: 'FINALIZE', createdAt: '' }, { revision: 3, kind: 'RESULT_AMENDMENT', createdAt: '' }] }
    : { ...data, resultRevision: 3, resultStatus: 'FINALIZED', latestRevision: 3, isLatestRevision: true, statusAtRevision: 'FINALIZED', revisionKind: 'RESULT_AMENDMENT',
        versions: [{ revision: 1, kind: 'GAME_ENDED', createdAt: '' }, { revision: 2, kind: 'FINALIZE', createdAt: '' }, { revision: 3, kind: 'RESULT_AMENDMENT', createdAt: '' }] } }) }) as Response);
  mount(); await screen.findByText('Verbindlich bestätigt');
  await userEvent.selectOptions(screen.getByLabelText('Ergebnisversion'), '1');
  expect(await screen.findByText(/Historische Version 1 von 3 · damals: Spiel beendet, noch nicht bestätigt/)).toBeInTheDocument();
  expect(screen.queryByText('Verbindlich bestätigt')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Korrektur speichern' })).not.toBeInTheDocument();
});

it('ignores a slow read that was overtaken by a newer one, so an old answer cannot overwrite the current result', async () => {
  const base = { ...data, resultRevision: 2, resultStatus: 'FINALIZED', latestRevision: 2, isLatestRevision: true, statusAtRevision: 'FINALIZED', versions: [] };
  const stale = { ...base, scores: [{ rank: 1, participationId: 'a', displayName: 'Veraltet', role: 'PLAYER', score: 9 }] };
  const current = { ...base, scores: [{ rank: 1, participationId: 'a', displayName: 'Aktuell', role: 'PLAYER', score: 1 }] };
  let release: (value: Response) => void = () => {}, calls = 0;
  vi.mocked(fetch).mockImplementation(() => ++calls === 1
    ? new Promise<Response>(resolve => { release = resolve; })        // the first read is slow
    : Promise.resolve({ ok: true, json: async () => ({ success: true, data: current }) } as Response));
  mount();
  await act(async () => transport.handlers.get('game:result:changed')?.());       // a newer read overtakes it
  await screen.findByText('Aktuell: 1 Punkte');
  await act(async () => release({ ok: true, json: async () => ({ success: true, data: stale }) } as Response));
  expect(screen.queryByText('Veraltet: 9 Punkte')).not.toBeInTheDocument();
  expect(screen.getByText('Aktuell: 1 Punkte')).toBeInTheDocument();
});
