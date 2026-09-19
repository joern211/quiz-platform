// ============================================================
// Moderator Lobby Page - v0.3.0
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket, connectSocket, disconnectSocket } from '../lib/socket';
import { setSession } from '../lib/sessionStore';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './ModeratorLobbyPage.module.css';

export function ModeratorLobbyPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [players, setPlayers] = useState<any[]>([]);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [gameStarted, setGameStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [kickError, setKickError] = useState('');

  // Store active room in session
  useEffect(() => {
    if (code) {
      setSession({ roomCode: code, role: 'MODERATOR' });
    }
    return () => {
      // Don't clear on unmount - user might navigate to game page
    };
  }, [code]);

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    connectSocket();

    // E2E-Fix + App-Quality: room:subscribe MUSS nach jedem Page-Reload neu gesendet werden.
    // Problem: socket.io-client Singleton → nach page.reload() ist das Socket bereits
    // verbunden, das 'connect'-Event wird NICHT mehr gefeuert → room:subscribe wird nicht
    // emitted → Moderator-Socket subscription geht verloren → game:start → NOT_IN_ROOM.
    // Fix: room:subscribe direkt aufrufen wenn das Socket bereits verbunden ist.
    const doSubscribe = () => {
      socket.emit('room:subscribe', { roomCode: code, role: 'MODERATOR' });
    };

    if (socket.connected) {
      doSubscribe();
    }

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('room:subscribe', { roomCode: code, role: 'MODERATOR' });
    });

    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);
      setChatEnabled(data.runPhase !== 'LOCKED');

      // If game already running, redirect to game page
      if (data.status === 'RUNNING') {
        setGameStarted(true);
      }
    });

    socket.on('room:updated', (data) => {
      setPlayers(data.players || []);
    });

    socket.on('player:join', (data) => {
      setPlayers(prev => {
        const exists = prev.find(p => p.id === data.player.id);
        if (exists) return prev;
        return [...prev, data.player];
      });
    });

    socket.on('player:ready:set', (data) => {
      setPlayers(prev => prev.map(p =>
        p.id === data.playerId ? { ...p, ready: data.ready } : p
      ));
    });

    socket.on('game:start', (data) => {
      if (data.status === 'RUNNING') {
        setGameStarted(true);
        navigate(`/moderator/raum/${code}/spiel`);
      }
    });

    socket.on('lobby:chat:lock', (data) => {
      setChatEnabled(!data.locked);
    });

    socket.on('error', (data) => {
      console.error('Socket error:', data.message);
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    return () => {
      disconnectSocket();
    };
  }, [code, navigate]);

  // Redirect if game already started
  useEffect(() => {
    if (gameStarted && code) {
      navigate(`/moderator/raum/${code}/spiel`);
    }
  }, [gameStarted, code, navigate]);

  const handleStart = () => {
    setLoading(true);
    socketRef.current?.emit('game:start', { roomCode: code }, (response: any) => {
      setLoading(false);
      if (response.success) {
        navigate(`/moderator/raum/${code}/spiel`);
      } else {
        alert(response.error || 'Start nicht möglich');
      }
    });
  };

  const handleForceStart = () => {
    if (confirm('Wirklich ohne alle Spieler starten?')) {
      setLoading(true);
      socketRef.current?.emit('game:start', { roomCode: code }, (response: any) => {
        setLoading(false);
        if (response.success) {
          navigate(`/moderator/raum/${code}/spiel`);
        } else {
          alert(response.error || 'Start nicht möglich');
        }
      });
    }
  };

  const handleKick = (playerId: string, displayName: string) => {
    if (!confirm(`${displayName} wirklich aus dem Raum entfernen?`)) return;
    setKickError('');
    socketRef.current?.emit('room:kick', { roomCode: code, playerId }, (response: any) => {
      if (!response.success) {
        setKickError(response.error || 'Spieler konnte nicht entfernt werden');
      }
    });
  };

  const handleCloseRoom = async () => {
    if (!confirm('Raum wirklich schließen? Alle Teilnehmer werden getrennt.')) return;

    try {
      await fetch(`/api/v1/rooms/${code}`, {
        method: 'DELETE',
        credentials: 'include',
      });
    } catch {
      // Server will handle cleanup
    }

    setSession({}); // Clear session
    navigate('/kategorien');
  };

  const handleLockChat = () => {
    socketRef.current?.emit('lobby:chat:lock', { roomCode: code, locked: !chatEnabled });
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(code || '').catch(() => {});
  };

  const connectedCount = players.filter(p => p.connected).length;
  const readyCount = players.filter(p => p.ready && p.connected).length;
  const canStart = connectedCount >= 2 && readyCount === connectedCount;

  // Generate QR code URL for room link
  const roomUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/beitreten`
    : '';
  const qrCodeUrl = roomUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(roomUrl + '?code=' + code)}`
    : '';

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Spielleiter-Lobby</h1>
          <p className={styles.subtitle}>Raum: {code}</p>
        </div>
        <div className={styles.headerRight}>
          <Badge variant={connected ? 'success' : 'danger'}>
            {connected ? 'Verbunden' : 'Getrennt'}
          </Badge>
          <Button variant="ghost" size="sm" onClick={() => navigate('/kategorien')}>
            ← Zurück
          </Button>
        </div>
      </div>

      {kickError && (
        <div className={styles.errorBanner} role="alert">
          {kickError}
        </div>
      )}

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
                    {player.role === 'MODERATOR' && (
                      <Badge variant="accent" size="sm">Host</Badge>
                    )}
                    {!player.connected && (
                      <Badge variant="muted" size="sm">Getrennt</Badge>
                    )}
                    {player.ready && player.connected && (
                      <Badge variant="success" size="sm">Bereit ✓</Badge>
                    )}
                    {player.ready === false && player.connected && (
                      <Badge variant="muted" size="sm">Wartet...</Badge>
                    )}
                  </div>
                  {player.role !== 'MODERATOR' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleKick(player.id, player.displayName)}
                      title="Spieler entfernen"
                    >
                      ✕
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>

        <Card padding="lg">
          <h2>Einladung</h2>

          <div className={styles.inviteSection}>
            <p className={styles.inviteHint}>Teile diesen Code mit deinen Freunden:</p>
            <div className={styles.codeDisplay}>
              <span className={styles.code}>{code}</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCopyCode}
              >
                Kopieren
              </Button>
            </div>

            <div className={styles.qrSection}>
              {qrCodeUrl ? (
                <>
                  <img
                    src={qrCodeUrl}
                    alt="QR-Code zum Beitreten"
                    className={styles.qrCode}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <p className={styles.qrHint}>QR-Code scannen zum Beitreten</p>
                </>
              ) : (
                <div className={styles.qrPlaceholder}>
                  <span>QR-Code wird geladen...</span>
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>

      <Card padding="lg" className={styles.controls}>
        <div className={styles.controlButtons}>
          <Button variant="secondary" onClick={handleLockChat}>
            {chatEnabled ? 'Chat sperren' : 'Chat entsperren'}
          </Button>
          <Button variant="danger" onClick={handleCloseRoom}>
            Raum schließen
          </Button>
        </div>

        <div className={styles.startSection}>
          <p className={styles.hint}>
            {connectedCount} Spieler verbunden, {readyCount} bereit
            {!canStart && connectedCount < 2 && ' — Mindestens 2 Spieler benötigt'}
            {!canStart && connectedCount >= 2 && readyCount < connectedCount && ' — Alle Spieler müssen bereit sein'}
          </p>
          <div className={styles.startButtons}>
            <Button onClick={handleStart} disabled={!canStart || loading}>
              {loading ? 'Startet...' : 'Spiel starten'}
            </Button>
            {connectedCount >= 1 && (
              <Button variant="secondary" onClick={handleForceStart}>
                Erzwingen
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
