// ============================================================
// Player Lobby Page - v0.3.0
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { getSocket, connectSocket, disconnectSocket } from '../lib/socket';
import { getSession, setSession } from '../lib/sessionStore';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './PlayerLobbyPage.module.css';

export function PlayerLobbyPage() {
  const { code } = useParams<{ code: string }>();
  const roomCode = code ?? '';
  const navigate = useNavigate();
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);
  const [connected, setConnected] = useState(false);
  const [players, setPlayers] = useState<any[]>([]);
  const [ready, setReady] = useState(false);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [kicked, setKicked] = useState(false);
  const [actionError, setActionError] = useState('');

  const session = getSession();
  const rejoinToken = session.rejoinToken;

  useEffect(() => {
    if (code) {
      setSession({ roomCode: code, role: 'PLAYER' });
    }
  }, [code]);

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    connectSocket();

    // If socket is already connected (singleton reused from previous page),
    // 'connect' event won't fire — send room:subscribe immediately.
    socket.on('connect', () => {
      setConnected(true);
      socket.emit('room:subscribe', { roomCode, rejoinToken: rejoinToken || undefined }, (response) => {
        if (!response.success) setActionError(`Raumbeitritt fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
      });
    });

    if (socket.connected) {
      setConnected(true);
      socket.emit('room:subscribe', { roomCode, rejoinToken: rejoinToken || undefined }, (response) => {
        if (!response.success) setActionError(`Raumbeitritt fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
      });
    }

    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);

      // Restore ready state from stored session
      const selfId = session.participationId;
      const selfPlayer = data.players?.find((p: any) => p.id === selfId);
      if (selfPlayer) setReady(selfPlayer.ready);

      // If game already running, go to game
      if (data.status === 'RUNNING') {
        const path = data.gameSlug === 'jeopardy'
          ? `/jeopardy/spiel/${roomCode}`
          : `/raum/${roomCode}/spiel`;
        navigate(path);
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
        const path = data.gameSlug === 'jeopardy'
          ? `/jeopardy/spiel/${roomCode}`
          : `/raum/${roomCode}/spiel`;
        navigate(path);
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
  }, [navigate, rejoinToken, roomCode, session.participationId]);

  const handleToggleReady = () => {
    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    const newReady = !ready;
    setActionError('');
    setReady(newReady); // Optimistic update
    socketRef.current.emit('player:ready:set', {
      roomCode,
      ready: newReady,
      rejoinToken: rejoinToken || undefined,
    }, (response) => {
      if (!response.success) {
        setReady(!newReady); // Revert on failure
        setActionError('Bereitschaft konnte nicht gespeichert werden.');
      }
    });
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    socketRef.current.emit('lobby:chat:send', {
      roomCode,
      content: chatInput.trim(),
    }, (response) => {
      if (!response.success) setActionError('Nachricht konnte nicht gesendet werden.');
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

      {actionError && <p role="alert">{actionError}</p>}

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
