// ============================================================
// Moderator Game Page (Geo Quiz)
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket, connectSocket, disconnectSocket } from '../lib/socket.ts';
import { Card, Button, Badge } from '@quiz/ui';
import { Timer } from '@quiz/ui';
import styles from './ModeratorGamePage.module.css';

export function ModeratorGamePage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [question, setQuestion] = useState<any>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [endsAt, setEndsAt] = useState(0);
  const [answerStats, setAnswerStats] = useState<Record<string, number>>({});
  const [players, setPlayers] = useState<any[]>([]);
  const [buzzerWinner, setBuzzerWinner] = useState<any>(null);
  const [gameEnded, setGameEnded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [timerPaused, setTimerPaused] = useState(false);

  useEffect(() => {
    socketRef.current = getSocket();
    const socket = socketRef.current;

    connectSocket();

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.emit('room:subscribe', { roomCode: code });

    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);
      if (data.setup?.questions) {
        setTotalQuestions(data.setup.questions.length);
      }
    });

    socket.on('geo:question', (data) => {
      setQuestion(data.question);
      setEndsAt(data.timerEndMs);
      setRevealed(false);
      setBuzzerWinner(null);
      setAnswerStats({});
      setCurrentIndex(data.roundIndex);
      if (data.totalRounds) setTotalQuestions(data.totalRounds);
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
      setScores(data.scores || {});
    });

    socket.on('game:end', (data) => {
      if (data.status === 'ENDED') {
        setGameEnded(true);
      }
    });

    return () => {
      disconnectSocket();
    };
  }, [code]);

  const handlePauseTimer = () => {
    socketRef.current?.emit('game:pause', { roomCode: code });
    setTimerPaused(true);
  };

  const handleResumeTimer = () => {
    socketRef.current?.emit('game:resume', { roomCode: code });
    setTimerPaused(false);
  };

  const handleReveal = () => {
    socketRef.current?.emit('geo:reveal', { roomCode: code });
  };

  const handleNextQuestion = () => {
    socketRef.current?.emit('geo:next', { roomCode: code });
  };

  const handleEndGame = () => {
    socketRef.current?.emit('game:end', { roomCode: code });
    navigate(`/moderator/raum/${code}/ergebnis`);
  };

  const getPlayerName = (playerId: string) => {
    const player = players.find(p => p.id === playerId);
    return player?.displayName || 'Unbekannt';
  };

  const [timerPaused, setTimerPaused] = useState(false);
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

        <div className={styles.solution}>
          <h3>Lösung: {['A', 'B', 'C', 'D'][question.options.findIndex((o: any) => o.id === question.correctOptionId)]}</h3>
          <p>{question.options.find((o: any) => o.id === question.correctOptionId)?.text}</p>
          {question.explanation && <p className={styles.explanation}>{question.explanation}</p>}
        </div>
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
