import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CoreRuntimeProjectionSchema } from '@quiz/shared';
import { useGameCore } from '../useGameCore';

const transport = vi.hoisted(() => ({ handlers: new Map<string, Set<() => void>>(), requests: [] as Array<(response: unknown) => void> }));
vi.mock('../../lib/socket', () => ({ getSocket: () => ({ connected: true,
  emit: (_event: string, _data: unknown, ack: (response: unknown) => void) => transport.requests.push(ack),
  on: (event: string, listener: () => void) => { const listeners = transport.handlers.get(event) ?? new Set(); listeners.add(listener); transport.handlers.set(event, listeners); },
  off: (event: string, listener: () => void) => transport.handlers.get(event)?.delete(listener),
}) }));
beforeEach(() => { transport.handlers.clear(); transport.requests.length = 0; });
function projection(roomCode = '123-456') { return CoreRuntimeProjectionSchema.parse({ roomCode, runIndex: 1, gameSlug: 'wissensduell', engineVersion: 1, stateVersion: 2, enginePhase: 'INPUT_OPEN', informationRole: 'HOST', timer: null, progress: { currentRound: 1, totalRounds: 2, remainingRounds: 2, progressPercent: 0 }, availableActions: [{ key: 'reveal', event: 'geo:reveal', label: 'Auflösen' }] }); }
function fire(event: string) { for (const listener of transport.handlers.get(event) ?? []) listener(); }
it('ignores late snapshots and clears privileged actions on a failed refresh', () => {
  const { result } = renderHook(() => useGameCore('123-456'));
  act(() => fire('game:core:changed'));
  act(() => transport.requests[1]({ success: true, projection: projection() }));
  expect(result.current.can('reveal')).toBe(true);
  act(() => transport.requests[0]({ success: true, projection: { ...projection(), availableActions: [] } }));
  expect(result.current.can('reveal')).toBe(true);
  act(() => fire('room:core:changed'));
  act(() => transport.requests[2]({ success: false, error: 'NOT_IN_ROOM' }));
  expect(result.current.can('reveal')).toBe(false);
});
it('rejects another room, invalidates pending reads on disconnect and removes listeners on unmount', () => {
  const { result, unmount } = renderHook(() => useGameCore('123-456'));
  act(() => transport.requests[0]({ success: true, projection: projection('999-999') }));
  expect(result.current.projection).toBeNull();
  act(() => fire('connect'));
  act(() => fire('disconnect'));
  act(() => transport.requests[1]({ success: true, projection: projection() }));
  expect(result.current.projection).toBeNull();
  unmount();
  expect([...transport.handlers.values()].every(listeners => listeners.size === 0)).toBe(true);
});
