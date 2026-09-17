// ============================================================
// Moderator Lobby Page
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Card, Button, Badge } from '@quiz/ui';
import { Scoreboard } from '../components/Scoreboard';
import styles from './ModeratorLobbyPage.module.css';

export function ModeratorLobbyPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [players, setPlayers] = useState<any[]>([]);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [canStart, setCanStart] = useState(false);
  const [roomInfo, setRoomInfo] = useState<any>(null);

  useEffect(() => {
    // Connect to socket
    const socket = io(window.location.origin, {
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      // Subscribe to room
      socket.emit('room:subscribe', { roomCode: code });
    });

    socket.on('room:snapshot', (data) => {
      setRoomInfo(data);
      setPlayers(data.players || []);
      updateCanStart(data.players || []);
    });

    socket.on('room:updated', (data) => {
      setPlayers(data.players || []);
      updateCanStart(data.players || []);
    });

    socket.on('player:join', (data) => {
      setPlayers(prev => [...prev, data.player]);
    });

    socket.on('player:ready:set', (data) => {
      setPlayers(prev => prev.map(p => 
        p.id === data.playerId ? { ...p, ready: data.ready } : p
      ));
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    return () => {
      socket.disconnect();
    };
  }, [code]);

  const updateCanStart = (playerList: any[]) => {
    const connectedPlayers = playerList.filter(p => p.connected);
    const allReady = connectedPlayers.every(p => p.ready);
    setCanStart(connectedPlayers.length >= 2 && allReady);
  };

  const handleStart = () => {
    socketRef.current?.emit('game:start', { roomCode: code }, (response: any) => {
      if (response.success) {
        navigate(`/moderator/raum/${code}/spiel`);
      } else {
        alert(response.error || 'Start nicht möglich');
      }
    });
  };

  const handleForceStart = () => {
    if (confirm('Wirklich ohne alle Spieler starten?')) {
      handleStart();
    }
  };

  const handleKick = (playerId: string) => {
    socketRef.current?.emit('room:kick', { roomCode: code, playerId });
  };

  const handleLockChat = () => {
    socketRef.current?.emit('lobby:chat:lock', { roomCode: code, locked: !chatEnabled });
    setChatEnabled(!chatEnabled);
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Mod-Lobby</h1>
          <p className={styles.subtitle}>Raum: {code}</p>
        </div>
        <Badge variant={connected ? 'success' : 'danger'}>
          {connected ? 'Verbunden' : 'Getrennt'}
        </Badge>
      </div>

      <div className={styles.grid}>
        <Card padding="lg">
          <h2>Spieler ({players.length})</h2>
          
          <div className={styles.playerList}>
            {players.length === 0 ? (
              <p className={styles.empty}>Warte auf Spieler...</p>
            ) : (
              players.map((player) => (
                <div key={player.id} className={styles.playerRow}>
                  <div className={styles.playerInfo}>
                    <span className={styles.playerName}>{player.displayName}</span>
                    {!player.connected && (
                      <Badge variant="muted" size="sm">Getrennt</Badge>
                    )}
                    {player.ready && player.connected && (
                      <Badge variant="success" size="sm">Bereit ✓</Badge>
                    )}
                  </div>
                  <Button 
                    variant="ghost" 
                    size="sm"
                    onClick={() => handleKick(player.id)}
                  >
                    ✕
                  </Button>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card padding="lg">
          <h2>Einladung</h2>
          
          <div className={styles.inviteSection}>
            <p>Teile diesen Code mit deinen Freunden:</p>
            <div className={styles.codeDisplay}>
              <span className={styles.code}>{code}</span>
              <Button 
                variant="secondary"
                size="sm"
                onClick={() => navigator.clipboard.writeText(code || '')}
              >
                Kopieren
              </Button>
            </div>
            
            <div className={styles.qrPlaceholder}>
              <p>QR-Code Coming Soon</p>
            </div>
          </div>
        </Card>
      </div>

      <Card padding="lg" className={styles.controls}>
        <div className={styles.controlButtons}>
          <Button variant="secondary" onClick={handleLockChat}>
            {chatEnabled ? 'Chat sperren' : 'Chat entsperren'}
          </Button>
          <Button variant="secondary" onClick={() => navigate('/kategorien')}>
            Raum schließen
          </Button>
        </div>

        <div className={styles.startSection}>
          <p className={styles.hint}>
            {players.filter(p => p.connected).length} Spieler verbunden,{' '}
            {players.filter(p => p.ready).length} bereit
          </p>
          <div className={styles.startButtons}>
            <Button onClick={handleStart} disabled={!canStart}>
              Starten
            </Button>
            <Button variant="danger" onClick={handleForceStart}>
              Trotzdem starten
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
