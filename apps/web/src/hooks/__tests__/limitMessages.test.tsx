import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { RATE_LIMITED_TEXT } from '../../lib/commandErrors';
import { useJeopardy } from '../useJeopardy';
import { useWerIstDas } from '../useWerIstDas';

const transport = vi.hoisted(() => ({ commands: [] as Array<{ event: string; ack: (response: unknown) => void }>, resyncAck: null as null | ((response: unknown) => void) }));
vi.mock('../../lib/socket', () => {
  const socket = { connected: true, on: vi.fn(), off: vi.fn(), emit: (event: string, _data: unknown, ack?: (response: unknown) => void) => {
    if (event === 'room:subscribe') ack?.({ success: true });
    else if (event.endsWith(':resync')) transport.resyncAck = ack ?? null;
  } };
  return { getSocket: () => socket, connectSocket: vi.fn(), disconnectSocket: vi.fn(), getSessionData: () => ({ rejoinToken: 'proof' }),
    emitCommand: (_socket: unknown, event: string, _payload: unknown, _key: string, ack: (response: unknown) => void) => transport.commands.push({ event, ack }) };
});
beforeEach(() => { transport.commands.length = 0; transport.resyncAck = null; });
const refusal = { success: false, error: 'RATE_LIMITED', code: 'RATE_LIMITED', retryable: true, details: { retryAfterMs: 300 } };

it.each([
  ['open field', (r: ReturnType<typeof useJeopardy>) => r.actions.openField(1, 0, 100)],
  ['next', (r: ReturnType<typeof useJeopardy>) => r.actions.next()],
  ['board switch', (r: ReturnType<typeof useJeopardy>) => r.actions.switchBoard(2)],
  ['judge', (r: ReturnType<typeof useJeopardy>) => r.actions.judge(true)],
  ['buzz', (r: ReturnType<typeof useJeopardy>) => r.actions.buzz()],
  ['steal buzz', (r: ReturnType<typeof useJeopardy>) => r.actions.stealBuzz()],
  ['steal judge', (r: ReturnType<typeof useJeopardy>) => r.actions.stealJudge(false)],
])('Jeopardy: a refused %s shows the protection text, not a raw code', (_name, act1) => {
  const { result } = renderHook(() => useJeopardy('123-456', 'HOST'));
  act(() => act1(result.current));
  expect(transport.commands).toHaveLength(1);
  act(() => transport.commands[0].ack(refusal));
  expect(result.current.error).toBe(RATE_LIMITED_TEXT);
  expect(result.current.error).not.toContain('RATE_LIMITED');
});

it('Jeopardy: other failures keep their own message', () => {
  const { result } = renderHook(() => useJeopardy('123-456', 'HOST'));
  act(() => result.current.actions.next());
  act(() => transport.commands[0].ack({ success: false, error: 'PHASE_NOT_FIELD_DONE' }));
  expect(result.current.error).toContain('PHASE_NOT_FIELD_DONE');
});

it('Wer ist das?: refused actions, judgement, end and a refused resync show the protection text', () => {
  const { result } = renderHook(() => useWerIstDas('123-456', 'HOST'));
  act(() => result.current.act('weristdas:reveal'));
  act(() => transport.commands[0].ack(refusal)); expect(result.current.error).toBe(RATE_LIMITED_TEXT);
  act(() => result.current.judge('WRONG'));
  act(() => transport.commands[1].ack({ success: false, error: 'HINT_REQUIRED' })); expect(result.current.error).toBe('HINT_REQUIRED');
  act(() => result.current.judge('BOTH_CORRECT'));
  act(() => transport.commands[2].ack(refusal)); expect(result.current.error).toBe(RATE_LIMITED_TEXT);
  act(() => result.current.end());
  act(() => transport.commands[3].ack(refusal)); expect(result.current.error).toBe(RATE_LIMITED_TEXT);
  act(() => transport.resyncAck?.(refusal)); expect(result.current.error).toBe(RATE_LIMITED_TEXT);
});
