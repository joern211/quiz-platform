import { failureText } from '../lib/commandErrors';
import { ContentMedia } from '../components/ContentMedia';
import { RecoveryControl } from '../components/RecoveryControl';
// ============================================================
// Moderator Game Page (Geo Quiz)
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { getSocket, connectSocket, disconnectSocket, emitCommand } from '../lib/socket';
import { Card, Button } from '@quiz/ui';
import { Timer } from '@quiz/ui';
import { GameShell } from '../components/GameShell';
import styles from './ModeratorGamePage.module.css';
import { useGameCore } from '../hooks/useGameCore';

export function ModeratorGamePage() {
  const { code } = useParams<{ code: string }>();
  const roomCode = code ?? '';
  const core = useGameCore(roomCode);
  const navigate = useNavigate();
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);
  const [connected, setConnected] = useState(false);
  const [question, setQuestion] = useState<any>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [endsAt, setEndsAt] = useState(0);
  const [answerStats, setAnswerStats] = useState<Record<string, number>>({});
  const [players, setPlayers] = useState<any[]>([]);
  const [, setGameEnded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [timerPaused, setTimerPaused] = useState(false);
  const [correctOptionId, setCorrectOptionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [recoveryError, setRecoveryError] = useState(false);
  const recoveryMessage = 'Die Spielkonfiguration konnte nicht geladen werden. Das Spiel ist angehalten. Bitte beende es und erstelle einen neuen Raum.';

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    const refresh = () => {
        socket.emit('geo:resync', {}, (res) => {
          if (!res.success) return;
          if (res.phase === 'GAME_END') {
            navigate(`/moderator/raum/${roomCode}/ergebnis`, { replace: true });
            return;
          }
          setRecoveryError(Boolean(res.recoveryError));
          if (res.recoveryError) setActionError(recoveryMessage); else setActionError('');
          if (res.question) setQuestion(res.question);
          setEndsAt(res.timerEndMs ?? 0);
          setRevealed(res.revealed ?? false);
          setTimerPaused(res.phase === 'PAUSED');
          setCurrentIndex(res.roundIndex ?? 0);
          setTotalQuestions(res.totalQuestions ?? 0);
          setScores(res.scores ?? {});
          setCorrectOptionId(res.question?.correctOptionId ?? null);
          setAnswerStats(res.answerStats ?? {});
        });
    };
    const subscribe = () => {
      socket.emit('room:subscribe', { roomCode, role: 'HOST' }, (response) => {
        if (!response.success) {
          setActionError(`Raumverbindung fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
          return;
        }
        refresh();
      });
    };

    socket.on('game:core:changed', refresh);
    socket.on('connect', () => {
      setConnected(true);
      subscribe();
    });
    socket.on('disconnect', () => setConnected(false));
    if (socket.connected) {
      setConnected(true);
      subscribe();
    }
    connectSocket();

    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);
    });

    socket.on('geo:round:error', () => {
      setRecoveryError(true);
      setEndsAt(0);
      setActionError(recoveryMessage);
    });

    socket.on('geo:question', (data) => {
      setRecoveryError(false);
      setQuestion(data.question);
      setEndsAt(data.timerEndMs);
      setRevealed(false);
      setAnswerStats({});
      setCorrectOptionId(null);
      setActionError('');
      setCurrentIndex(data.roundIndex);
      setTotalQuestions(data.totalQuestions);
    });

    socket.on('geo:answered:moderator', (data) => {
      setAnswerStats(prev => ({
        ...prev,
        [data.optionId]: (prev[data.optionId] || 0) + 1,
      }));
    });

    socket.on('geo:reveal', (data) => {
      setRevealed(true);
      setCorrectOptionId(data.correctOptionId ?? null);
      setScores(Object.fromEntries(data.scores.map(entry => [entry.participationId, entry.score])));
    });
    socket.on('geo:paused', () => setTimerPaused(true));
    socket.on('geo:resumed', (data: { timerEndMs: number }) => {
      setTimerPaused(false);
      setEndsAt(data.timerEndMs);
    });

    socket.on('game:end', (data) => {
      if (data.status === 'ENDED') {
        setGameEnded(true);
        navigate(`/moderator/raum/${roomCode}/ergebnis`);
      }
    });

    return () => {
      socket.off('game:core:changed', refresh);
      disconnectSocket();
    };
  }, [navigate, roomCode]);

  const handlePauseTimer = () => {
    if (!socketRef.current) return setActionError('Socket-Verbindung ist nicht verfügbar.');
    // Audit PR14, 14-01: emitCommand — der Pause-Token wird nach
    // bestätigtem Erfolg verbraucht; die nächste Pause erhält ein frisches
    // Token (Replay der ersten Pause würde sonst stattlaufen).
    emitCommand(socketRef.current, 'game:pause', { roomCode }, `${roomCode}:game:pause`, (response) => {
      if (response.success) setTimerPaused(true);
      else setActionError(failureText(response, `Pause fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`));
    });
  };

  const handleResumeTimer = () => {
    if (!socketRef.current) return setActionError('Socket-Verbindung ist nicht verfügbar.');
    emitCommand(socketRef.current, 'game:resume', { roomCode }, `${roomCode}:game:resume`, (response) => {
      if (response.success) setTimerPaused(false);
      else setActionError(failureText(response, `Fortsetzen fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`));
    });
  };

  const handleReveal = () => {
    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    emitCommand(socketRef.current, 'geo:reveal', { roomCode }, `${roomCode}:geo:reveal:${question?.id ?? 'q'}`, (response) => {
      if (!response.success) setActionError(failureText(response, `Auflösung fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`));
    });
  };

  const handleNextQuestion = () => {
    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    emitCommand(socketRef.current!, 'geo:next', { roomCode }, `${roomCode}:geo:next:${question?.id ?? 'q'}`, (response) => {
      if (!response.success) setActionError(failureText(response, `Nächste Frage konnte nicht geladen werden: ${response.error ?? 'Unbekannter Fehler'}`));
      if (response.ended) navigate(`/moderator/raum/${roomCode}/ergebnis`);
    });
  };

  const handleEndGame = () => {
    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    emitCommand(socketRef.current, 'game:end', { roomCode }, `${roomCode}:game:end`, (response) => {
      if (response.success) navigate(`/moderator/raum/${roomCode}/ergebnis`);
      else setActionError(failureText(response, 'Spiel konnte nicht beendet werden.'));
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getPlayerName = (playerId: string) => {
    const player = players.find(p => p.id === playerId);
    return player?.displayName || 'Unbekannt';
  };

  if (!question) {
    return (
      <GameShell role="moderator" roomCode={roomCode} phase={recoveryError ? 'ERROR_RECOVERY' : 'WAITING'} connected={connected} error={actionError}>
      <div className={styles.page}>
        <div className={styles.waiting}>
          <h1>{recoveryError ? 'Spiel angehalten' : 'Warte auf Spielstart...'}</h1>
          {recoveryError && <Button variant="danger" onClick={handleEndGame}>Spiel beenden</Button>}
        </div>
      </div>
      </GameShell>
    );
  }

  return (
    <GameShell role="moderator" roomCode={roomCode} phase={recoveryError ? 'ERROR_RECOVERY' : timerPaused ? 'PAUSED' : revealed ? 'REVEAL' : 'INPUT_OPEN'} connected={connected} error={actionError}>
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.progress}>
          <span>Frage {currentIndex + 1} / {totalQuestions}</span>
        </div>
      </div>

      <Card padding="lg" className={styles.questionCard}>
        <p className={styles.category}>{question.category}</p>
        <h2 className={styles.prompt}>{question.prompt}</h2>
        <ContentMedia mediaUrl={question.mediaUrl} mediaType={question.mediaType} onRefresh={() => socketRef.current?.emit('geo:resync', {}, res => { if (res.success && res.question) setQuestion(res.question); })} />
        
        {!recoveryError && !revealed && !timerPaused && <Timer endsAt={endsAt} size="lg" />}
        
        <div className={styles.answerStats}>
          {question.options.map((opt: any, i: number) => (
            <div key={opt.id} className={styles.statRow}>
              <span className={styles.optionLetter}>{['A', 'B', 'C', 'D'][i]}</span>
              <span>{opt.text}</span>
              <span className={styles.statCount}>{answerStats[opt.id] || 0}</span>
            </div>
          ))}
        </div>

        {revealed && correctOptionId && (
          <div className={styles.solution}>
            <h3>Lösung: {['A', 'B', 'C', 'D'][question.options.findIndex((o: any) => o.id === correctOptionId)]}</h3>
            <p>{question.options.find((o: any) => o.id === correctOptionId)?.text}</p>
          </div>
        )}
      </Card>

      <Card padding="lg" className={styles.controls}>
        <h3>Spieler-Stände</h3>
        <div className={styles.scoreList}>
          {players.map(player => (
            <div key={player.id} className={styles.scoreRow}>
              <span>{player.displayName}</span>
              <span className={styles.scoreValue}>{scores[player.id] || 0}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className={styles.actions}>
        {core.projection && <progress aria-label="Spielfortschritt" max={100} value={core.projection.progress.progressPercent ?? undefined} />}
        {core.projection?.recoveryRequired && <RecoveryControl projection={core.projection} />}
        {!recoveryError && (!revealed ? (
          <>
            <Button variant="secondary" disabled={!core.can(timerPaused ? 'resume' : 'pause')} onClick={timerPaused ? handleResumeTimer : handlePauseTimer}>
              {timerPaused ? '▶ Weiter' : '⏸ Pause'}
            </Button>
            <Button disabled={!core.can('reveal')} onClick={handleReveal}>✓ Auflösen</Button>
          </>
        ) : (
          <Button disabled={!core.can('next')} onClick={handleNextQuestion}>Nächste Frage →</Button>
        ))}
        <Button variant="danger" disabled={!core.can('end')} onClick={handleEndGame}>Spiel beenden</Button>
      </div>
    </div>
    </GameShell>
  );
}
