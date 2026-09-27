import { useCallback, useEffect, useState } from 'react';
import { connectSocket, disconnectSocket, getSessionData, getSocket,
  type PlayerRole, type WerIstDasView } from '../lib/socket';

export function useWerIstDas(roomCode: string, role: PlayerRole) {
  const [state, setState] = useState<WerIstDasView | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const socket = getSocket();
    const subscribe = () => {
      setConnected(true);
      socket.emit('room:subscribe', {
        roomCode, role, rejoinToken: getSessionData().rejoinToken ?? undefined,
      }, response => {
        if (!response.success) { setError(response.error ?? 'Raumverbindung fehlgeschlagen'); return; }
        socket.emit('weristdas:resync', {}, res => {
          if (res.success && res.state) { setState(res.state); setError(''); }
          else setError(res.error ?? 'Spielstand konnte nicht geladen werden');
        });
      });
    };
    socket.on('connect', subscribe);
    socket.on('disconnect', () => setConnected(false));
    socket.on('weristdas:update', setState);
    if (socket.connected) subscribe();
    connectSocket();
    return () => { socket.off('connect', subscribe); socket.off('weristdas:update', setState); disconnectSocket(); };
  }, [roomCode, role]);

  const act = useCallback((event: 'weristdas:buzzer:open' | 'weristdas:buzz' | 'weristdas:hint' |
    'weristdas:reveal' | 'weristdas:next', data: Record<string, never> = {}) => {
    getSocket().emit(event, data, res => { if (!res.success) setError(res.error ?? 'Aktion fehlgeschlagen'); else setError(''); });
  }, []);
  const judge = useCallback((result: 'BOTH_CORRECT' | 'ONE_CORRECT' | 'WRONG') => {
    getSocket().emit('weristdas:judge', { result }, res => {
      if (!res.success) setError(res.error ?? 'Bewertung fehlgeschlagen'); else setError('');
    });
  }, []);
  const end = useCallback(() => {
    getSocket().emit('game:end', { roomCode }, res => {
      if (!res.success) setError(res.error ?? 'Spielende fehlgeschlagen');
    });
  }, [roomCode]);
  return { state, connected, error, act, judge, end };
}
