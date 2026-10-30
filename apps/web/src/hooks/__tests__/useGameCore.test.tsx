import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CoreRuntimeProjectionSchema } from '@quiz/shared';
import { useGameCore } from '../useGameCore';

const transport = vi.hoisted(() => ({ handlers: new Map<string, Set<() => void>>(), requests: [] as Array<(response: unknown) => void>, replace: null as null | (() => void) }));
vi.mock('../../lib/socket', () => {
  const makeSocket = () => ({ connected: true,
    emit: (_event: string, _data: unknown, ack: (response: unknown) => void) => transport.requests.push(ack),
    on: (event: string, listener: () => void) => { const listeners = transport.handlers.get(event) ?? new Set(); listeners.add(listener); transport.handlers.set(event, listeners); },
    off: (event: string, listener: () => void) => transport.handlers.get(event)?.delete(listener),
  });
  let socket = makeSocket(); const observers = new Set<(value: typeof socket) => void>();
  transport.replace = () => { socket = makeSocket(); for (const observer of observers) observer(socket); };
  return { observeSocket: (listener: (value: typeof socket) => void) => { observers.add(listener); listener(socket); return () => { observers.delete(listener); }; } };
});
beforeEach(() => { transport.handlers.clear(); transport.requests.length = 0; });
function projection(roomCode = '123-456') { return CoreRuntimeProjectionSchema.parse({ roomCode, runIndex: 1, gameSlug: 'wissensduell', engineVersion: 1, stateVersion: 2, enginePhase: 'INPUT_OPEN', corePhase: 'ROUND_ACTIVE', informationRole: 'HOST', timer: null, progress: { currentRound: 1, totalRounds: 2, remainingRounds: 2, progressPercent: 0 }, availableActions: [{ key: 'reveal', event: 'geo:reveal', label: 'Auflösen' }] }); }
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

it('clears old authority and ignores old acknowledgements when a persistent consumer follows a recreated socket', () => {
  const { result } = renderHook(() => useGameCore('123-456'));
  act(() => transport.requests[0]({ success: true, projection: projection() }));
  expect(result.current.can('reveal')).toBe(true);
  act(() => fire('game:core:changed'));
  act(() => transport.replace?.());
  expect(result.current.can('reveal')).toBe(false);
  act(() => transport.requests[1]({ success: true, projection: projection() }));
  expect(result.current.can('reveal')).toBe(false);
  act(() => transport.requests[2]({ success: true, projection: { ...projection(), availableActions: [] } }));
  expect(result.current.can('reveal')).toBe(false);
});
