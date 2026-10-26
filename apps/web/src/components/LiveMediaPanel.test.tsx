import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveMediaPanel } from './LiveMediaPanel';
import { LiveMediaPolicySchema, type LiveMediaSnapshot } from '@quiz/shared';
const state = vi.hoisted(() => ({ handlers: new Map<string, (data?: unknown) => void>(), emit: vi.fn() }));
vi.mock('../lib/socket', () => ({ getSocket: vi.fn(), observeSocket: (listener: (value: unknown) => void) => { listener({ connected: true, emit: state.emit, on: (event: string, callback: (data?: unknown) => void) => state.handlers.set(event, callback), off: (event: string) => state.handlers.delete(event) }); return vi.fn(); } }));
afterEach(() => { state.handlers.clear(); state.emit.mockReset(); vi.unstubAllGlobals(); localStorage.clear(); });
it('cancels a pending microphone permission when host mute arrives and a later release never enables hardware', async () => {
  state.emit.mockImplementation((_event, _data, ack) => ack?.({ success: true }));
  const stop = vi.fn(); let resolve!: (value: MediaStream) => void;
  const capture = vi.fn().mockReturnValue(new Promise<MediaStream>(done => { resolve = done; }));
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: capture, enumerateDevices: vi.fn().mockResolvedValue([]) } });
  const self = { id: 'self', name: 'Alice', role: 'PLAYER', teamId: null, hostMuted: false, cameraHidden: false, mic: false, camera: false };
  const snapshot: LiveMediaSnapshot = { roomCode: '123-456', selfId: 'self', revision: 1, self, members: [self], routes: [], iceServers: [], canManage: false, policy: LiveMediaPolicySchema.parse({}) };
  const view = render(<MemoryRouter initialEntries={['/raum/123-456/lobby']}><LiveMediaPanel /></MemoryRouter>);
  await act(async () => state.handlers.get('media:snapshot')?.(snapshot));
  await userEvent.click(screen.getByRole('button', { name: 'Mikrofon einschalten' })); expect(capture).toHaveBeenCalledOnce();
  await act(async () => state.handlers.get('media:snapshot')?.({ ...snapshot, self: { ...self, hostMuted: true } }));
  await act(async () => resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream));
  expect(stop).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: 'Mikrofon einschalten' })).toBeDisabled();
  await act(async () => state.handlers.get('media:snapshot')?.(snapshot));
  expect(screen.getByRole('button', { name: 'Mikrofon einschalten' })).toBeEnabled(); expect(capture).toHaveBeenCalledOnce();
  expect(state.emit.mock.calls.filter(call => call[0] === 'media:self' && call[1].mic)).toHaveLength(0); view.unmount();
});

it('exposes an exact channel label and sends the selected channel without changing the browser contract', async () => {
  state.emit.mockImplementation((_event, _data, ack) => ack?.({ success: true }));
  const self = { id: 'host', name: 'Host', role: 'HOST', teamId: null, hostMuted: false, cameraHidden: false, mic: false, camera: false };
  const snapshot: LiveMediaSnapshot = { roomCode: '123-456', selfId: 'host', revision: 3, self, members: [self], routes: [], iceServers: [], canManage: true, policy: LiveMediaPolicySchema.parse({}) };
  const view = render(<MemoryRouter initialEntries={['/raum/123-456/lobby']}><LiveMediaPanel /></MemoryRouter>);
  await act(async () => state.handlers.get('media:snapshot')?.(snapshot));
  await userEvent.selectOptions(screen.getByLabelText('Raumsprachkanal', { exact: true }), 'TEAM');
  expect(state.emit).toHaveBeenCalledWith('media:control', { expectedRevision: 3, policy: { channel: 'TEAM' } }, expect.any(Function)); view.unmount();
});
