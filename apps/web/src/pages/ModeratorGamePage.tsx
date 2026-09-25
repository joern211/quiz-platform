// ============================================================
// Moderator Game Page (Geo Quiz)
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { getSocket, connectSocket, disconnectSocket } from '../lib/socket';
import { Card, Button, Badge } from '@quiz/ui';
import { Timer } from '@quiz/ui';
import styles from './ModeratorGamePage.module.css';

export function ModeratorGamePage() {
  const { code } = useParams<{ code: string }>();
  const roomCode = code ?? '';
  const navigate = useNavigate();
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);
  const [connected, setConnected] = useState(false);
  const [question, setQuestion] = useState<any>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [endsAt, setEndsAt] = useState(0);
  const [answerStats, setAnswerStats] = useState<Record<string, number>>({});
  const [players, setPlayers] = useState<any[]>([]);
  const [, setBuzzerWinner] = useState<any>(null);
  const [, setGameEnded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [timerPaused, setTimerPaused] = useState(false);
  const [correctOptionId, setCorrectOptionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    connectSocket();

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.emit('room:subscribe', { roomCode }, (response) => {
      if (!response.success) setActionError(`Raumverbindung fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
    });

    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);
    });

    socket.on('geo:question', (data) => {
      setQuestion(data.question);
      setEndsAt(data.timerEndMs);
      setRevealed(false);
      setBuzzerWinner(null);
      setAnswerStats({});
      setCorrectOptionId(null);
      setActionError('');
      setCurrentIndex(data.roundIndex);
      setTotalQuestions(data.totalQuestions);
    });

    socket.on('geo:answered', (data) => {
      setAnswerStats(prev => ({
        ...prev,
        [data.optionId]: (prev[data.optionId] || 0) + 1,
      }));
    });

    socket.on('buzz:won', (data) => {
      setBuzzerWinner(data);
    });

    socket.on('geo:reveal', (data) => {
      setRevealed(true);
      setCorrectOptionId(data.correctOptionId ?? null);
      setScores(Object.fromEntries(data.scores.map(entry => [entry.participationId, entry.score])));
    });

    socket.on('game:end', (data) => {
      if (data.status === 'ENDED') {
        setGameEnded(true);
        navigate(`/moderator/raum/${roomCode}/ergebnis`);
      }
    });

    return () => {
      disconnectSocket();
    };
  }, [navigate, roomCode]);

  const handlePauseTimer = () => {
    if (!socketRef.current) return setActionError('Socket-Verbindung ist nicht verfügbar.');
    socketRef.current.emit('game:pause', { roomCode }, (response) => {
      if (response.success) setTimerPaused(true);
      else setActionError(`Pause fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
    });
  };

  const handleResumeTimer = () => {
    if (!socketRef.current) return setActionError('Socket-Verbindung ist nicht verfügbar.');
    socketRef.current.emit('game:resume', { roomCode }, (response) => {
      if (response.success) setTimerPaused(false);
      else setActionError(`Fortsetzen fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
    });
  };

  const handleReveal = () => {
    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    socketRef.current.emit('geo:reveal', { roomCode }, (response) => {
      if (!response.success) setActionError(`Auflösung fehlgeschlagen: ${response.error ?? 'Unbekannter Fehler'}`);
    });
  };

  const handleNextQuestion = () => {
    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    socketRef.current.emit('geo:next', { roomCode }, (response) => {
      if (!response.success) setActionError(`Nächste Frage konnte nicht geladen werden: ${response.error ?? 'Unbekannter Fehler'}`);
      if (response.ended) navigate(`/moderator/raum/${roomCode}/ergebnis`);
    });
  };

  const handleEndGame = () => {
    if (!socketRef.current) {
      setActionError('Socket-Verbindung ist nicht verfügbar.');
      return;
    }
    socketRef.current.emit('game:end', { roomCode }, (response) => {
      if (response.success) navigate(`/moderator/raum/${roomCode}/ergebnis`);
      else setActionError('Spiel konnte nicht beendet werden.');
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getPlayerName = (playerId: string) => {
    const player = players.find(p => p.id === playerId);
    return player?.displayName || 'Unbekannt';
  };

  if (!question) {
    return (
      <div className={styles.page}>
        <div className={styles.waiting}>
          <h1>Warte auf Spielstart...</h1>
          <Badge variant={connected ? 'success' : 'danger'}>
            {connected ? 'Verbunden' : 'Getrennt'}
          </Badge>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.progress}>
          <span>Frage {currentIndex + 1} / {totalQuestions}</span>
        </div>
        <Badge variant={connected ? 'success' : 'danger'}>
          {connected ? 'Verbunden' : 'Getrennt'}
        </Badge>
      </div>

      {actionError && <p role="alert">{actionError}</p>}

      <Card padding="lg" className={styles.questionCard}>
        <p className={styles.category}>{question.category}</p>
        <h2 className={styles.prompt}>{question.prompt}</h2>
        
        {!revealed && <Timer endsAt={endsAt} size="lg" />}
        
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
        {!revealed ? (
          <>
            <Button variant="secondary" onClick={timerPaused ? handleResumeTimer : handlePauseTimer}>
              {timerPaused ? '▶ Weiter' : '⏸ Pause'}
            </Button>
            <Button onClick={handleReveal}>✓ Auflösen</Button>
          </>
        ) : (
          <Button onClick={handleNextQuestion}>Nächste Frage →</Button>
        )}
        <Button variant="danger" onClick={handleEndGame}>Spiel beenden</Button>
      </div>
    </div>
  );
}
