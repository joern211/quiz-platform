import { useCallback, useEffect, useRef, useState } from 'react';
import { connectSocket, disconnectSocket, getSessionData, getSocket, withCommandEnvelope,
  type PlayerRole, type WerIstDasView } from '../lib/socket';

export function useWerIstDas(roomCode: string, role: PlayerRole) {
  const [state, setState] = useState<WerIstDasView | null>(null);
  // BASIS-STANDARDS: Intent-Kontext (aktuelle Runde) per Ref.
  const stateRef = useRef<WerIstDasView | null>(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const roundKey = () => stateRef.current?.roundIndex ?? 0;
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
    // Basis-Intent je Aktion + Runde; 'buzz' erhält pro Runde ein Token,
    // damit ein Buzzer-Retry (Doppelklick) dieselbe Absicht bleibt.
    getSocket().emit(event, withCommandEnvelope(data, `${roomCode}:wid:${event}:r${roundKey()}`), res => {
      if (!res.success) setError(res.error ?? 'Aktion fehlgeschlagen'); else setError('');
    });
  }, [roomCode]);
  const judge = useCallback((result: 'BOTH_CORRECT' | 'ONE_CORRECT' | 'WRONG') => {
    // Bewertung je Runde + Ergebnis = Absicht (anderes Ergebnis = neuer Key).
    getSocket().emit('weristdas:judge', withCommandEnvelope({ result }, `${roomCode}:wid:judge:r${roundKey()}:${result}`), res => {
      if (!res.success) setError(res.error ?? 'Bewertung fehlgeschlagen'); else setError('');
    });
  }, [roomCode]);
  const end = useCallback(() => {
    getSocket().emit('game:end', withCommandEnvelope({ roomCode }, `${roomCode}:game:end`), res => {
      if (!res.success) setError(res.error ?? 'Spielende fehlgeschlagen');
    });
  }, [roomCode]);
  return { state, connected, error, act, judge, end };
}
