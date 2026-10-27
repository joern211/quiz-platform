// ============================================================
// Viewer Lobby Page
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { gamePath } from '../lib/gamePaths';
import { useEffect, useRef, useState } from 'react';
import { getSession, setSession } from '../lib/sessionStore';
import { getSocket, connectSocket, disconnectSocket } from '../lib/socket';
import { Card, Badge } from '@quiz/ui';
import styles from './ViewerLobbyPage.module.css';

export function ViewerLobbyPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [players, setPlayers] = useState<any[]>([]);
  const [roomInfo, setRoomInfo] = useState<any>(null);
  const [admitted, setAdmitted] = useState(false);
  const admittedRef = useRef(false);

  useEffect(() => {
    const socket = getSocket();

    connectSocket();
    
    const subscribe = () => {
      admittedRef.current = false; setAdmitted(false);
      const session = getSession();
      socket.emit('room:subscribe', { roomCode: code ?? '', role: 'VIEWER', rejoinToken: session.roomCode === code && session.role === 'VIEWER' ? session.rejoinToken ?? undefined : undefined, pin: sessionStorage.getItem(`qp_viewerPin:${code}`) ?? undefined, inviteToken: sessionStorage.getItem(`qp_viewerInvite:${code}`) ?? undefined }, response => {
        setConnected(response.success);
        if (!response.success) setError(`Zuschauen nicht möglich: ${response.error ?? 'Bitte erneut versuchen'}`);
        else { setSession({ roomCode: code, role: 'VIEWER', ...(response.rejoinToken ? { rejoinToken: response.rejoinToken } : {}) }); }
      });
    };
    socket.on('connect', subscribe);
    socket.on('disconnect', () => setConnected(false));
    
    if (socket.connected) subscribe();
    
    socket.on('room:snapshot', (data) => {
      setRoomInfo(data);
      setPlayers(data.players || []);
      const active = !data.admission || data.admission === 'ACTIVE';
      admittedRef.current = active;
      setAdmitted(active);
      if (active && data.status === 'RUNNING') {
        const path = gamePath(data.gameSlug, 'VIEWER', code ?? '');
        navigate(path);
      }
    });

    socket.on('room:admission', data => {
      admittedRef.current = true;
      setAdmitted(true);
      if (data.status === 'RUNNING') navigate(gamePath(data.gameSlug, 'VIEWER', code ?? ''));
    });
    socket.on('room:kicked', () => { admittedRef.current = false; setAdmitted(false); setError('Die Teilnahme wurde vom Host beendet oder abgelehnt.'); });

    socket.on('game:start', (data) => {
      if (admittedRef.current && data.status === 'RUNNING') {
        navigate(gamePath(data.gameSlug, 'VIEWER', code ?? ''));
      }
    });

    socket.on('room:updated', (data) => {
      setPlayers(data.players || []);
    });

    return () => { disconnectSocket(); };
  }, [code, navigate]);

  return (
    <div className={styles.page}>
      {error && <p role="alert">{error}</p>}
      <Badge variant={connected ? 'success' : 'danger'} className={styles.status}>
        {connected ? 'Verbunden' : 'Getrennt'}
      </Badge>

      <Card padding="lg" className={styles.lobby}>
        <h1>Zuschauer-Lobby</h1>
        {connected && !admitted && <p role="status">Du wartest auf die Freigabe durch den Host.</p>}
        <p className={styles.roomName}>{roomInfo?.roomName || 'Warte auf Spielstart...'}</p>
        <p className={styles.game}>{roomInfo?.game?.name}</p>

        <div className={styles.playerList}>
          <h2>Spieler ({players.length})</h2>
          <div className={styles.players}>
            {players.map((player: any) => (
              <div key={player.id} className={styles.playerRow}>
                <span>{player.displayName}</span>
                <Badge variant={player.connected ? 'success' : 'muted'} size="sm">
                  {player.connected ? 'Verbunden' : 'Getrennt'}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
