// ============================================================
// Player Lobby Page - v0.3.0
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket, connectSocket, disconnectSocket } from '../lib/socket';
import { getSession, setSession } from '../lib/sessionStore';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './PlayerLobbyPage.module.css';

export function PlayerLobbyPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [players, setPlayers] = useState<any[]>([]);
  const [ready, setReady] = useState(false);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [kicked, setKicked] = useState(false);

  const session = getSession();
  const rejoinToken = session.rejoinToken;

  useEffect(() => {
    if (code) {
      setSession({ roomCode: code, role: 'PLAYER' });
    }
  }, [code]);

  // FLOW-007: redirect to /join if session is missing required data
  useEffect(() => {
    if (!session.participationId || !session.roomCode || session.roomCode !== code) {
      navigate('/');
    }
  }, [session, code, navigate]);

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    connectSocket();

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('room:subscribe', { roomCode: code, rejoinToken: rejoinToken || undefined });
    });

    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);

      // Restore ready state from stored session
      const selfId = session.participationId;
      const selfPlayer = data.players?.find((p: any) => p.id === selfId);
      if (selfPlayer) setReady(selfPlayer.ready);

      // If game already running, go to game
      if (data.status === 'RUNNING') {
        navigate(`/raum/${code}/spiel`);
      }
    });

    socket.on('room:updated', (data) => {
      setPlayers(data.players || []);
    });

    socket.on('room:kicked', (data: { participationId?: string }) => {
      // P0-12: Only react if kicked participationId matches self
      if (data.participationId && data.participationId !== session.participationId) {
        return; // Not this player
      }
      setKicked(true);
      setTimeout(() => {
        setSession({});
        navigate('/');
      }, 3000);
    });

    socket.on('player:ready:set', (data) => {
      setPlayers(prev => prev.map(p =>
        p.id === data.playerId ? { ...p, ready: data.ready } : p
      ));
    });

    socket.on('lobby:chat:message', (msg) => {
      setChatMessages(prev => [...prev, msg]);
    });

    socket.on('game:start', (data) => {
      if (data.status === 'RUNNING') {
        navigate(`/raum/${code}/spiel`);
      }
    });

    socket.on('session:replaced', () => {
      alert('Du wurdest von einem neuen Gerät ersetzt');
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    return () => {
      disconnectSocket();
    };
  }, [code, navigate, rejoinToken, session.participationId]);

  const handleToggleReady = () => {
    const newReady = !ready;
    setReady(newReady); // Optimistic update
    socketRef.current?.emit('player:ready:set', {
      roomCode: code,
      ready: newReady,
      rejoinToken: rejoinToken || undefined,
    }, (response: any) => {
      if (!response.success) {
        setReady(!newReady); // Revert on failure
      }
    });
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    socketRef.current?.emit('lobby:chat:send', {
      roomCode: code,
      content: chatInput.trim(),
    });
    setChatInput('');
  };

  if (kicked) {
    return (
      <div className={styles.page}>
        <Card padding="lg" className={styles.kickedCard}>
          <h1>Du wurdest entfernt</h1>
          <p>Du wirst in Kürze zur Startseite weitergeleitet...</p>
        </Card>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Warte auf Start</h1>
        <p className={styles.code}>Raum: {code}</p>
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
                <div
                  key={player.id}
                  className={`${styles.playerRow} ${player.ready && player.connected ? styles.ready : ''}`}
                >
                  <span className={styles.playerName}>
                    {player.displayName}
                    {player.id === session.participationId && ' (Du)'}
                    {!player.connected && (
                      <Badge variant="muted" size="sm">Getrennt</Badge>
                    )}
                  </span>
                  {player.ready && player.connected ? (
                    <Badge variant="success">Bereit ✓</Badge>
                  ) : (
                    <Badge variant="muted">Wartet...</Badge>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>

        <Card padding="lg">
          <h2>Chat</h2>

          <div className={styles.chatArea}>
            <div className={styles.chatMessages}>
              {chatMessages.length === 0 ? (
                <p className={styles.chatEmpty}>Noch keine Nachrichten</p>
              ) : (
                chatMessages.map((msg, i) => (
                  <div key={msg.id || i} className={styles.chatMessage}>
                    <strong>{msg.senderName}:</strong> {msg.content}
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleSendChat} className={styles.chatForm}>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Nachricht..."
                maxLength={300}
                className={styles.chatInput}
              />
              <Button type="submit" size="sm">Senden</Button>
            </form>
          </div>
        </Card>
      </div>

      <div className={styles.actions}>
        <Button onClick={handleToggleReady} size="lg" variant={ready ? 'secondary' : 'primary'}>
          {ready ? 'Nicht mehr bereit' : 'Ich bin bereit!'}
        </Button>
      </div>
    </div>
  );
}
