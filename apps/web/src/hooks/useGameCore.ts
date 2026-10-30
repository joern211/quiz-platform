import { useEffect, useState } from 'react';
import { CoreRuntimeProjectionSchema, type CoreActionKey, type CoreRuntimeProjection } from '@quiz/shared';
import { observeSocket } from '../lib/socket';

/** Membership and commands stay with the page; this hook reads public runtime metadata only. */
export function useGameCore(roomCode: string) {
  const [projection, setProjection] = useState<CoreRuntimeProjection | null>(null);
  useEffect(() => {
    setProjection(null);
    if (!roomCode) return;
    let disposed = false, request = 0;
    let detach = () => {};
    const stop = observeSocket(socket => {
      detach(); ++request; setProjection(null);
      const refresh = () => {
        const current = ++request;
        socket.emit('game:core:read', {}, (response: { success: boolean; projection?: unknown }) => {
          if (disposed || current !== request) return;
          if (!response.success) { setProjection(null); return; }
          const parsed = CoreRuntimeProjectionSchema.safeParse(response.projection);
          setProjection(parsed.success && parsed.data.roomCode === roomCode ? parsed.data : null);
        });
      };
      const events = ['connect', 'room:snapshot', 'game:core:changed', 'room:core:changed', 'geo:question', 'geo:reveal', 'geo:paused', 'geo:resumed', 'geo:timer-expired', 'game:pause', 'game:resume', 'game:end'] as const;
      for (const event of events) socket.on(event, refresh);
      const disconnected = () => { ++request; setProjection(null); };
      socket.on('disconnect', disconnected);
      detach = () => { for (const event of events) socket.off(event, refresh); socket.off('disconnect', disconnected); };
      if (socket.connected) refresh();
    });
    return () => { disposed = true; ++request; stop(); detach(); };
  }, [roomCode]);
  return { projection, can: (key: CoreActionKey) => projection?.availableActions.some(action => action.key === key) ?? false };
}
