import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CoreRuntimeProjectionSchema } from '@quiz/shared';
import { MAX_AUTOMATIC_READ_RETRIES, useGameCore } from '../useGameCore';

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

const refused = (retryAfterMs = 100) => ({ success: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED', retryable: true, details: { retryAfterMs } });
it('Independent G5 review: a temporarily throttled core read offers a way to restore controls after the cooldown', async () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useGameCore('123-456'));
    act(() => transport.requests[0]({ success: true, projection: projection() }));
    expect(result.current.can('reveal')).toBe(true);
    act(() => fire('game:core:changed'));
    act(() => transport.requests[1](refused()));
    // authority is withdrawn, the state is distinguishable and a manual re-read is exposed
    expect(result.current).toMatchObject({ status: 'throttled', retryAfterMs: 100 });
    expect(result.current.can('reveal')).toBe(false);
    const count = transport.requests.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(transport.requests.length).toBeGreaterThan(count);
    expect(typeof result.current.refresh).toBe('function');
  } finally { vi.useRealTimers(); }
});
it('re-reads automatically only a bounded number of times, then waits for refresh; a fresh projection restores the actions', async () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useGameCore('123-456'));
    act(() => transport.requests[0](refused()));
    for (let i = 1; i <= MAX_AUTOMATIC_READ_RETRIES; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(transport.requests).toHaveLength(i + 1);
      act(() => transport.requests[i](refused()));
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(transport.requests).toHaveLength(MAX_AUTOMATIC_READ_RETRIES + 1); // no endless loop
    expect(result.current.status).toBe('throttled'); expect(result.current.can('reveal')).toBe(false);
    act(() => result.current.refresh());
    expect(transport.requests).toHaveLength(MAX_AUTOMATIC_READ_RETRIES + 2);
    act(() => transport.requests[MAX_AUTOMATIC_READ_RETRIES + 1]({ success: true, projection: projection() }));
    expect(result.current).toMatchObject({ status: 'ready', retryAfterMs: null }); expect(result.current.can('reveal')).toBe(true);
  } finally { vi.useRealTimers(); }
});
it('treats withdrawn membership as denied: no automatic re-read, controls stay off, old acknowledgements and socket replacement cannot revive them', async () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useGameCore('123-456'));
    act(() => transport.requests[0]({ success: true, projection: projection() }));
    act(() => fire('game:core:changed'));
    act(() => transport.requests[1]({ success: false, error: 'NOT_IN_ROOM' }));
    expect(result.current.status).toBe('denied');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(transport.requests).toHaveLength(2);
    // a throttled retry pending on the old socket is cancelled when the socket is replaced
    act(() => fire('game:core:changed')); act(() => transport.requests[2](refused()));
    act(() => transport.replace!());
    expect(result.current).toMatchObject({ status: 'loading' });
    const count = transport.requests.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(transport.requests.length).toBe(count);
    act(() => transport.requests[1]({ success: true, projection: projection() })); // stale acknowledgement
    expect(result.current.can('reveal')).toBe(false);
  } finally { vi.useRealTimers(); }
});
