import { useCallback, useEffect, useRef, useState } from 'react';
import { CoreRuntimeProjectionSchema, type CoreActionKey, type CoreRuntimeProjection } from '@quiz/shared';
import { observeSocket } from '../lib/socket';

/**
 * - `ready`: a fresh valid projection is held and drives the available actions.
 * - `loading`: no answer yet (initial read, reconnect, socket replacement).
 * - `throttled`: the read was refused only provisionally (RATE_LIMITED). Authority stays withdrawn until a fresh
 *   read succeeds; a bounded number of reads is retried after the server's hint, `refresh` is always available.
 * - `denied`: membership or permission is gone (NOT_IN_ROOM, FORBIDDEN …). Never retried automatically.
 * - `error`: any other failure or an invalid projection. Only a manual `refresh` retries.
 */
export type CoreReadStatus = 'loading' | 'ready' | 'throttled' | 'denied' | 'error';
/** Consecutive automatic re-reads after a provisional refusal; the next event or `refresh` starts a new series. */
export const MAX_AUTOMATIC_READ_RETRIES = 3;
const DENIED = new Set(['NOT_IN_ROOM', 'FORBIDDEN', 'NO_PARTICIPATION', 'NOT_AUTHENTICATED', 'NOT_AUTHORIZED', 'RESOURCE_NOT_ACCESSIBLE', 'SESSION_REQUIRED', 'KICKED', 'BANNED']);
type ReadResponse = { success: boolean; projection?: unknown; error?: string; code?: string; details?: { retryAfterMs?: number } };

/** Membership and commands stay with the page; this hook reads public runtime metadata only. */
export function useGameCore(roomCode: string) {
  const [projection, setProjection] = useState<CoreRuntimeProjection | null>(null);
  const [status, setStatus] = useState<CoreReadStatus>('loading');
  const [retryAfterMs, setRetryAfterMs] = useState<number | null>(null);
  const reread = useRef<() => void>(() => {});
  useEffect(() => {
    setProjection(null); setStatus('loading'); setRetryAfterMs(null);
    reread.current = () => {};
    if (!roomCode) return;
    let disposed = false, request = 0, retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detach = () => {};
    const reset = (next: CoreReadStatus) => { ++request; clearTimeout(timer); setProjection(null); setStatus(next); setRetryAfterMs(null); };
    const stop = observeSocket(socket => {
      detach(); reset('loading'); retries = 0;
      const refresh = (automatic = false) => {
        clearTimeout(timer);
        if (!automatic) retries = 0;
        const current = ++request;
        socket.emit('game:core:read', {}, (response: ReadResponse) => {
          if (disposed || current !== request) return;
          if (response.success) {
            const parsed = CoreRuntimeProjectionSchema.safeParse(response.projection);
            if (parsed.success && parsed.data.roomCode === roomCode) { retries = 0; setProjection(parsed.data); setStatus('ready'); setRetryAfterMs(null); }
            else { setProjection(null); setStatus('error'); setRetryAfterMs(null); }
            return;
          }
          // Any refusal withdraws the old authority; only a fresh valid projection brings it back.
          setProjection(null);
          const code = response.code ?? response.error ?? '';
          if (code === 'RATE_LIMITED') {
            const wait = Math.min(Math.max(Number(response.details?.retryAfterMs) || 1000, 100), 30_000);
            setStatus('throttled'); setRetryAfterMs(wait);
            if (retries < MAX_AUTOMATIC_READ_RETRIES) { retries++; timer = setTimeout(() => { if (!disposed && current === request) refresh(true); }, wait + 50); }
          } else { setStatus(DENIED.has(code) ? 'denied' : 'error'); setRetryAfterMs(null); }
        });
      };
      const onEvent = () => refresh();
      const events = ['connect', 'room:snapshot', 'game:core:changed', 'room:core:changed', 'geo:question', 'geo:reveal', 'geo:paused', 'geo:resumed', 'geo:timer-expired', 'game:pause', 'game:resume', 'game:end'] as const;
      for (const event of events) socket.on(event, onEvent);
      const disconnected = () => reset('loading');
      socket.on('disconnect', disconnected);
      detach = () => { for (const event of events) socket.off(event, onEvent); socket.off('disconnect', disconnected); };
      reread.current = () => refresh();
      if (socket.connected) refresh();
    });
    return () => { disposed = true; ++request; clearTimeout(timer); reread.current = () => {}; stop(); detach(); };
  }, [roomCode]);
  const refresh = useCallback(() => reread.current(), []);
  return { projection, status, retryAfterMs, refresh, can: (key: CoreActionKey) => projection?.availableActions.some(action => action.key === key) ?? false };
}
