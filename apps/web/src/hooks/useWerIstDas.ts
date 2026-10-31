import { failureText } from '../lib/commandErrors';
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectSocket, disconnectSocket, emitCommand, getSessionData, getSocket,
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
    const refresh = () => {
        socket.emit('weristdas:resync', {}, res => {
          if (res.success && res.state) { setState(res.state); setError(''); }
          else setError(failureText(res, res.error ?? 'Spielstand konnte nicht geladen werden'));
        });
    };
    const subscribe = () => {
      setConnected(true);
      socket.emit('room:subscribe', {
        roomCode, role, rejoinToken: getSessionData().rejoinToken ?? undefined,
      }, response => {
        if (!response.success) { setError(response.error ?? 'Raumverbindung fehlgeschlagen'); return; }
        refresh();
      });
    };
    socket.on('game:core:changed', refresh);
    socket.on('game:pause', refresh);
    socket.on('game:resume', refresh);
    socket.on('connect', subscribe);
    socket.on('disconnect', () => setConnected(false));
    socket.on('weristdas:update', setState);
    if (socket.connected) subscribe();
    connectSocket();
    return () => { socket.off('game:core:changed', refresh); socket.off('game:pause', refresh); socket.off('game:resume', refresh); socket.off('connect', subscribe); socket.off('weristdas:update', setState); disconnectSocket(); };
  }, [roomCode, role]);

  const act = useCallback((event: 'weristdas:buzzer:open' | 'weristdas:buzz' | 'weristdas:hint' |
    'weristdas:reveal' | 'weristdas:next', data: Record<string, never> = {}) => {
    // Audit PR14, 14-01: Token-Lebenszyklus über emitCommand — der Token wird
    // nach bestätigtem Erfolg verbraucht. Doppelklick/ACK-Verlust → gleiches
    // Token (Replay); erneutes Öffnen derselben Runde nach einer
    // WRONG-Bewertung → frisches Token, damit die neue zulässige Absicht
    // ausgeführt wird.
    emitCommand(getSocket(), event, data, `${roomCode}:wid:${event}:r${roundKey()}`, res => {
      if (!res.success) setError(failureText(res, res.error ?? 'Aktion fehlgeschlagen')); else setError('');
    });
  }, [roomCode]);
  const judge = useCallback((result: 'BOTH_CORRECT' | 'ONE_CORRECT' | 'WRONG') => {
    // Bewertung je Runde + Antwortversuch + Ergebnis = Absicht (anderes Ergebnis/anderer Versuch = neuer Key).
    const attemptId = stateRef.current?.attemptId ?? undefined;
    emitCommand(getSocket(), 'weristdas:judge', { result, ...(attemptId ? { attemptId } : {}) }, `${roomCode}:wid:judge:r${roundKey()}:${attemptId ?? ''}:${result}`, res => {
      if (!res.success) setError(failureText(res, res.error ?? 'Bewertung fehlgeschlagen')); else setError('');
    });
  }, [roomCode]);
  const end = useCallback(() => {
    emitCommand(getSocket(), 'game:end', { roomCode }, `${roomCode}:game:end`, res => {
      if (!res.success) setError(failureText(res, res.error ?? 'Spielende fehlgeschlagen'));
    });
  }, [roomCode]);
  return { state, connected, error, act, judge, end };
}
