import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicRoomSummarySchema, type PublicRoomSummary } from '@quiz/shared';
import { RoomsPage } from '../RoomsPage';

afterEach(() => vi.unstubAllGlobals());
function room(overrides: Partial<PublicRoomSummary> = {}) {
  return PublicRoomSummarySchema.parse({ id: 'r1', code: '123-456', roomName: 'Quizabend', status: 'LOBBY', runPhase: 'OPEN', lifecycle: 'LOBBY_OPEN', scheduledAt: null, maxPlayers: 2, allowViewers: true, cameraEnabled: false, playerCount: 1, viewerCount: 2, canJoin: true, waitlist: false, accessMode: 'PUBLIC_JOIN', game: { slug: 'jeopardy', name: 'Jeopardy', category: 'buzzer-reaktion' }, createdAt: new Date().toISOString(), ...overrides });
}
function respond(data: unknown, success = true) {
  return { ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => ({ success, data }) };
}
function mount() { render(<MemoryRouter><RoomsPage /></MemoryRouter>); }
it('renders the real API array contract and carries the room code into the join URL', async () => {
  const fetch = vi.fn().mockResolvedValue(respond([room()])); vi.stubGlobal('fetch', fetch); mount();
  expect(await screen.findByText('Quizabend')).toBeVisible();
  expect(screen.getByText('👥 1/2')).toBeVisible();
  expect(screen.getByText('2 Zuschauer')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Beitreten' })).toHaveAttribute('href', '/beitreten?code=123-456');
  expect(fetch).toHaveBeenCalledWith('/api/v1/rooms/public', expect.objectContaining({ credentials: 'include' }));
});
it('distinguishes scheduled, locked and waitlisted rooms without offering a closed join', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond([
    room({ id: 'scheduled', roomName: 'Später', code: '111-111', lifecycle: 'SCHEDULED', canJoin: false, scheduledAt: new Date().toISOString() }),
    room({ id: 'locked', roomName: 'Geschlossen', code: '222-222', lifecycle: 'LOBBY_LOCKED', canJoin: false }),
    room({ id: 'full', roomName: 'Warten', code: '333-333', playerCount: 2, waitlist: true }),
  ]))); mount();
  await screen.findByText('Später');
  expect(screen.getByText('Geplant', { exact: true })).toBeVisible();
  expect(screen.getByText('Gesperrt', { exact: true })).toBeVisible();
  expect(screen.queryByRole('link', { name: 'Beitreten' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Auf die Warteliste' })).toHaveAttribute('href', '/beitreten?code=333-333');
  expect(within(screen.getByText('Später').closest('div')!.parentElement!).queryByRole('link')).not.toBeInTheDocument();
});
it('shows a load failure separately from an empty list and allows retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(respond([room()]))); mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Räume konnten nicht geladen werden');
  expect(screen.queryByText('Keine aktiven Räume')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Erneut laden' }));
  expect(await screen.findByText('Quizabend')).toBeVisible();
});
