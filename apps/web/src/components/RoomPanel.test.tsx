import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { RoomPolicySchema, type RoomCoreView } from '@quiz/shared';
import { RoomPanel } from './RoomPanel';

const transport = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), read: null as unknown, command: vi.fn() }));
vi.mock('../lib/socket', () => ({
  getSocket: () => ({ connected: true, emit: (event: string, _payload: unknown, callback: (result: unknown) => void) => { if (event === 'room:core:read') callback({ success: true, view: transport.read }); }, on: (event: string, handler: () => void) => transport.handlers.set(event, handler), off: (event: string) => transport.handlers.delete(event) }),
  connectSocket: vi.fn(), emitCommand: transport.command,
}));
vi.mock('../lib/sessionStore', () => ({ getSession: () => ({ role: 'VIEWER' }), setSession: vi.fn() }));
function view(overrides: Partial<RoomCoreView> = {}): RoomCoreView {
  return { gameSlug: 'jeopardy', history: [], switchOptions: [], revision: 1, lifecycle: 'LOBBY_OPEN', policy: RoomPolicySchema.parse({}), scheduledAt: null, hostStatus: 'ONLINE', canManage: false, isOwner: false, permissions: [], selfId: 'p1', selfAdmission: 'ACTIVE', teams: [], participants: [{ id: 'p1', displayName: 'Alice', role: 'PLAYER', admission: 'ACTIVE', connected: true, ready: false, teamId: null, score: 0, banned: false }], feed: [], preflight: { status: 'BLOCKED', blockers: ['NOT_ENOUGH_PLAYERS'], warnings: [] }, runIndex: 1, ...overrides };
}
beforeEach(() => { transport.handlers.clear(); transport.command.mockReset(); transport.read = view(); });
function mount() { return render(<MemoryRouter initialEntries={['/raum/123-456/lobby']}><RoomPanel /></MemoryRouter>); }
it('shows admission and feed to a viewer without management or credential controls', async () => {
  transport.read = view({ selfAdmission: 'WAITLIST', feed: [{ id: 'f1', kind: 'MESSAGE', message: 'Gleich geht es los', createdAt: new Date().toISOString() }] });
  mount();
  expect(await screen.findByText('Du stehst auf der Warteliste.')).toBeInTheDocument();
  expect(screen.queryByText('Raumeinstellungen')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Gerätewechsel' })).not.toBeInTheDocument();
  expect(screen.getByText('Gleich geht es los', { exact: false })).toBeInTheDocument();
});
it('saves an explicit ready policy and prevents another command while the response is pending', async () => {
  transport.read = view({ isOwner: true, canManage: true }); mount();
  await userEvent.click(screen.getByText('Raumeinstellungen'));
  await userEvent.selectOptions(screen.getByLabelText('Bereitschaft'), 'HOST_CAN_OVERRIDE');
  await userEvent.click(screen.getByRole('button', { name: 'Einstellungen speichern' }));
  expect(transport.command).toHaveBeenCalledTimes(1);
  expect(transport.command.mock.calls[0][2]).toMatchObject({ roomCode: '123-456', operation: { type: 'POLICY', policy: { readyRule: 'HOST_CAN_OVERRIDE' } } });
  expect(screen.getByRole('button', { name: 'Lobby sperren' })).toBeDisabled();
  await act(async () => { transport.command.mock.calls[0][4]({ success: false, error: 'NOT_AUTHORIZED' }); });
  expect(screen.getByRole('alert')).toHaveTextContent('Für diese Aktion fehlt die Berechtigung.');
  expect(screen.getByRole('button', { name: 'Lobby sperren' })).toBeEnabled();
});
it('uses the ordinary player role for self selection and shows a disconnect warning', async () => {
  transport.read = view({ policy: RoomPolicySchema.parse({ teamMode: 'SELF_SELECT' }), hostStatus: 'DISCONNECTED', teams: [{ id: 'team1', name: 'Blau', icon: '👥', color: '#2563eb', score: 3 }] }); mount();
  expect(await screen.findByText('Host vorübergehend getrennt.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Team wählen' }));
  expect(transport.command.mock.calls[0][2]).toMatchObject({ operation: { type: 'TEAM_SELECT', teamId: 'team1' } });
  expect(screen.queryByText('Verwaltung delegieren')).not.toBeInTheDocument();
});
