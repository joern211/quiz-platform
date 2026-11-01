import type { RoomCoreView } from '@quiz/shared';
import { MediaDeviceCheck } from '../components/MediaDeviceCheck';
// ============================================================
// Moderator Lobby Page - v0.3.0
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { gamePath } from '../lib/gamePaths';
import { useEffect, useState, useRef } from 'react';
import { getSocket, connectSocket, disconnectSocket, emitCommand } from '../lib/socket';
import { setSession } from '../lib/sessionStore';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './ModeratorLobbyPage.module.css';

export function ModeratorLobbyPage() {
  const { code } = useParams<{ code: string }>();
  const roomCode = code ?? '';
  const navigate = useNavigate();
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);
  const [control, setControl] = useState<RoomCoreView | null>(null);
  const [connected, setConnected] = useState(false);
  const [players, setPlayers] = useState<any[]>([]);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [gameStarted, setGameStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [kickError, setKickError] = useState('');

  // Store active room in session
  useEffect(() => {
    if (code) {
      setSession({ roomCode: code, role: 'HOST' });
    }
    return () => {
      // Don't clear on unmount - user might navigate to game page
    };
  }, [code]);

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    connectSocket();

    let disposed = false, request = 0;
    setControl(null);
    const refreshControl = () => {
      const current = ++request;
      socket.emit('room:core:read', {}, response => {
        if (!disposed && current === request) setControl(response.success && response.view ? response.view : null);
      });
    };
    socket.on('room:core:changed', refreshControl);

    // E2E-Fix + App-Quality: room:subscribe MUSS nach jedem Page-Reload neu gesendet werden.
    // Problem: socket.io-client Singleton → nach page.reload() ist das Socket bereits
    // verbunden, das 'connect'-Event wird NICHT mehr gefeuert → room:subscribe wird nicht
    // emitted → Moderator-Socket subscription geht verloren → game:start → NOT_IN_ROOM.
    // Fix: room:subscribe direkt aufrufen wenn das Socket bereits verbunden ist.
    const doSubscribe = () => {
      socket.emit('room:subscribe', { roomCode, role: 'HOST' }, (response) => {
        refreshControl();
        if (!response.success) {
          setKickError(`Raumverbindung fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
        }
      });
    };

    if (socket.connected) {
      doSubscribe();
    }

    socket.on('connect', () => {
      setConnected(true);
      doSubscribe();
    });

    socket.on('room:snapshot', (data) => {
      refreshControl();
      setPlayers(data.players || []);
      setChatEnabled(data.runPhase !== 'LOCKED');

      // If game already running, redirect to game page
      if (data.status === 'RUNNING') {
        setGameStarted(true);
        const path = gamePath(data.gameSlug, 'HOST', roomCode);
        navigate(path);
      }
    });

    socket.on('room:updated', (data) => {
      refreshControl();
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
        const path = gamePath(data.gameSlug, 'HOST', roomCode);
        navigate(path);
      }
    });

    socket.on('lobby:chat:lock', (data) => {
      setChatEnabled(!data.locked);
    });

    socket.on('error', (data) => {
      setKickError(data.message || data.code);
    });

    socket.on('disconnect', () => {
      setConnected(false); ++request; setControl(null);
    });

    return () => {
      disposed = true; ++request;
      socket.off('room:core:changed', refreshControl);
      disconnectSocket();
    };
  }, [navigate, roomCode]);

  // Redirect if game already started
  useEffect(() => {
    if (gameStarted && code) {
      // gameSlug is set by game:start event handler above
    }
  }, [gameStarted, code]);

  const handleStart = () => {
    if (!socketRef.current) {
      setKickError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    setLoading(true);
    setKickError('');
    emitCommand(socketRef.current, 'game:start', { roomCode }, `${roomCode}:game:start`, (response) => {
      setLoading(false);
      if (response.success) {
        const gameSlug = (response.gameSlug as string | undefined) ?? '';
        const path = gamePath(gameSlug, 'HOST', roomCode);
        navigate(path);
      } else {
        setKickError(response.error || 'Start nicht möglich');
      }
    });
  };

  const handleForceStart = () => {
    if (confirm('Warnungen bestätigen und bei erlaubter Ready-Regel starten? Mindestspieler und andere Blocker bleiben verbindlich.')) {
      setLoading(true);
      if (!socketRef.current) {
        setLoading(false);
        setKickError('Socket-Verbindung ist nicht verfügbar.');
        return;
      }
      emitCommand(socketRef.current, 'game:start', { roomCode, overrideReady: control?.policy.readyRule === 'HOST_CAN_OVERRIDE', acknowledgeWarnings: true }, `${roomCode}:game:start:override`, (response) => {
        setLoading(false);
        if (response.success) {
          const gameSlug = (response.gameSlug as string | undefined) ?? '';
          const path = gamePath(gameSlug, 'HOST', roomCode);
          navigate(path);
        } else {
          setKickError(response.error || 'Start nicht möglich');
        }
      });
    }
  };

  const handleLockChat = () => {
    if (!socketRef.current) return setKickError('Socket-Verbindung ist nicht verfügbar.');
    socketRef.current.emit('lobby:chat:lock', { roomCode, locked: !chatEnabled }, (response) => {
      if (!response.success) setKickError('Chat-Status konnte nicht geändert werden.');
    });
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(code || '').catch(() => {});
  };

  const connectedCount = players.filter(p => p.role === 'PLAYER' && p.connected).length;
  const readyCount = players.filter(p => p.role === 'PLAYER' && p.ready && p.connected).length;
  const canControlStart = control?.permissions.includes('GAME_START') && control.preflight.blockers.length === 0;
  const canStart = canControlStart && control?.preflight.warnings.length === 0;

  // Generate QR code URL for room link
  const roomUrl = typeof window !== 'undefined' ? `${window.location.origin}/beitreten` : '';
  const qrCodeUrl = roomUrl ? `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(roomUrl + '?code=' + code)}` : '';
  const gameName = control?.gameSlug === 'jeopardy' ? 'Jeopardy' : control?.gameSlug === 'wer-ist-das' ? 'Wer ist das?' : control?.gameSlug === 'wissensduell' ? 'Wissensduell' : 'Spiel';
  const startHint = !canStart && connectedCount < 2 ? 'Mindestens 2 Spieler benötigt.' : !canStart && connectedCount >= 2 && readyCount < connectedCount ? 'Alle Spieler müssen bereit sein.' : '';

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{gameName} / Lobby</p>
          <h1 className={styles.title}>Spielleiter-Lobby</h1>
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
        <div className="notice notice--error" role="alert">
          {kickError}
        </div>
      )}

      <div className={styles.layout}>
        <div className={styles.mainCol}>
          <section className={styles.codeBanner} aria-label="Einladung">
            <div>
              <p className={styles.codeLabel}>Euer Raumcode</p>
              <p className={styles.subtitle}><span className="sr-only">Raum: </span><span className={styles.code}>{code}</span></p>
              <p className={styles.inviteHint}>Teile diesen Code mit deinen Freunden – Beitritt unter <strong>/beitreten</strong>.</p>
            </div>
            <div className={styles.codeActions}>
              <Button variant="secondary" onClick={handleCopyCode}>Kopieren</Button>
              {qrCodeUrl && (
                <figure className={styles.qr}>
                  <img src={qrCodeUrl} alt="QR-Code zum Beitreten" className={styles.qrCode} onError={(e) => { (e.target as HTMLImageElement).closest('figure')?.setAttribute('hidden', ''); }} />
                  <figcaption className={styles.qrHint}>QR-Code scannen zum Beitreten</figcaption>
                </figure>
              )}
            </div>
          </section>

          <section aria-labelledby="lobby-players">
            <div className={styles.sectionHead}>
              <h2 id="lobby-players">Die Runde</h2>
              <span className={styles.count}>Spieler ({players.length})</span>
            </div>
            {players.length === 0 ? (
              <p className={styles.empty}>Warte auf Spieler …</p>
            ) : (
              <ul className={styles.playerGrid}>
                {players.map((player) => (
                  <li key={player.id} className={styles.playerCard} data-ready={player.ready && player.connected ? 'true' : undefined}>
                    <span className={styles.avatar} aria-hidden="true">{String(player.displayName ?? '?').slice(0, 1).toUpperCase()}</span>
                    <span className={styles.playerName}>{player.displayName}</span>
                    <span className={styles.badges}>
                      {player.role === 'HOST' && <Badge variant="accent" size="sm">Host</Badge>}
                      {!player.connected && <Badge variant="muted" size="sm">Getrennt</Badge>}
                      {player.ready && player.connected && <Badge variant="success" size="sm">Bereit ✓</Badge>}
                      {player.ready === false && player.connected && <Badge variant="muted" size="sm">Wartet...</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <MediaDeviceCheck />
        </div>

        <aside className={styles.sideCol}>
          <Card padding="lg" className={styles.startCard}>
            <h2>Euer Spiel</h2>
            <p className={styles.gameName}>{gameName}</p>
            <dl className={styles.facts}>
              <div><dt>Verbunden</dt><dd>{connectedCount}</dd></div>
              <div><dt>Bereit</dt><dd>{readyCount}</dd></div>
            </dl>
            <p className={styles.hint} role="status">
              {connectedCount} Spieler verbunden, {readyCount} bereit
              {startHint && <> — {startHint}</>}
            </p>
            <div className={styles.startButtons}>
              <Button onClick={handleStart} disabled={!canStart || loading} loading={loading} fullWidth size="lg">
                Spiel starten
              </Button>
              {canControlStart && (control?.preflight.warnings.length ?? 0) > 0 && (
                <Button variant="secondary" disabled={loading} onClick={handleForceStart} fullWidth>
                  Erzwingen
                </Button>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={handleLockChat}>
              {chatEnabled ? 'Chat sperren' : 'Chat entsperren'}
            </Button>
          </Card>
        </aside>
      </div>
    </div>
  );
}
