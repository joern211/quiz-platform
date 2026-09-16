// ============================================================
// Viewer Lobby Page
// ============================================================

import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getSocket, connectSocket, disconnectSocket } from '../lib/socket';
import { Card, Badge } from '@quiz/ui';
import styles from './ViewerLobbyPage.module.css';

export function ViewerLobbyPage() {
  const { code } = useParams<{ code: string }>();
  const [connected, setConnected] = useState(false);
  const [players, setPlayers] = useState<any[]>([]);
  const [roomInfo, setRoomInfo] = useState<any>(null);

  useEffect(() => {
    const socket = getSocket();

    connectSocket();
    
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    
    socket.emit('room:subscribe', { roomCode: code, role: 'VIEWER' }, () => {});
    
    socket.on('room:snapshot', (data) => {
      setRoomInfo(data);
      setPlayers(data.players || []);
      if (data.status === 'RUNNING') {
        window.location.href = `/zuschauen/${code}/spiel`;
      }
    });

    socket.on('room:updated', (data) => {
      setPlayers(data.players || []);
    });

    return () => { disconnectSocket(); };
  }, [code]);

  return (
    <div className={styles.page}>
      <Badge variant={connected ? 'success' : 'danger'} className={styles.status}>
        {connected ? 'Verbunden' : 'Getrennt'}
      </Badge>

      <Card padding="lg" className={styles.lobby}>
        <h1>Zuschauer-Lobby</h1>
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
