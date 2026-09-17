// ============================================================
// Player Lobby Page
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
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
  const rejoinToken = localStorage.getItem('rejoinToken');

  useEffect(() => {
    const socket = io(window.location.origin, {
      withCredentials: true,
      auth: { rejoinToken },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('room:subscribe', { roomCode: code, rejoinToken });
    });

    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);
      if (data.status === 'RUNNING') {
        navigate(`/raum/${code}/spiel`);
      }
    });

    socket.on('room:updated', (data) => {
      setPlayers(data.players || []);
    });

    socket.on('player:ready:set', (data) => {
      if (data.playerId === rejoinToken) {
        setReady(data.ready);
      }
      setPlayers(prev => prev.map(p => 
        p.id === data.playerId ? { ...p, ready: data.ready } : p
      ));
    });

    socket.on('lobby:chat:message', (msg) => {
      setChatMessages(prev => [...prev, msg]);
    });

    socket.on('game:start', () => {
      navigate(`/raum/${code}/spiel`);
    });

    socket.on('session:replaced', () => {
      alert('Du wurdest von einem neuen Gerät ersetzt');
    });

    return () => {
      socket.disconnect();
    };
  }, [code, navigate, rejoinToken]);

  const handleToggleReady = () => {
    socketRef.current?.emit('player:ready:set', {
      roomCode: code,
      ready: !ready,
      rejoinToken,
    });
    setReady(!ready);
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    
    socketRef.current?.emit('lobby:chat:send', {
      roomCode: code,
      content: chatInput.trim(),
      rejoinToken,
    });
    setChatInput('');
  };

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
            {players.map((player) => (
              <div 
                key={player.id} 
                className={`${styles.playerRow} ${player.ready ? styles.ready : ''}`}
              >
                <span className={styles.playerName}>{player.displayName}</span>
                {player.ready ? (
                  <Badge variant="success">Bereit ✓</Badge>
                ) : (
                  <Badge variant="muted">Wartet...</Badge>
                )}
              </div>
            ))}
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
                  <div key={i} className={styles.chatMessage}>
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
        <Button onClick={handleToggleReady} size="lg">
          {ready ? 'Nicht mehr bereit' : 'Ich bin bereit!'}
        </Button>
      </div>
    </div>
  );
}
