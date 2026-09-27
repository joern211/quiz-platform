// ============================================================
// Viewer Game Page (Geo Quiz)
// ============================================================

import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { Card, Badge } from '@quiz/ui';
import { Timer } from '@quiz/ui';
import styles from './ViewerGamePage.module.css';

export function ViewerGamePage() {
  const { code } = useParams<{ code: string }>();
  const [connected, setConnected] = useState(false);
  const [, setPhase] = useState<string>('WAITING');
  const [question, setQuestion] = useState<any>(null);
  const [timerEndMs, setTimerEndMs] = useState(0);
  const [players, setPlayers] = useState<any[]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const socket = io(window.location.origin, { withCredentials: true });
    
    const subscribe = () => {
      socket.emit('room:subscribe', { roomCode: code, role: 'VIEWER' }, (response: { success: boolean }) => {
        if (!response.success) return;
        socket.emit('geo:resync', {}, (res: {
          success: boolean; question?: typeof question; timerEndMs?: number | null;
          revealed?: boolean; phase?: string; scores?: Record<string, number>;
        }) => {
          if (!res.success) return;
          setQuestion(res.question ?? null);
          setTimerEndMs(res.timerEndMs ?? 0);
          setRevealed(res.revealed ?? false);
          setPhase(res.phase ?? 'WAITING');
          setScores(res.scores ?? {});
        });
      });
    };
    socket.on('connect', () => { setConnected(true); subscribe(); });
    socket.on('disconnect', () => setConnected(false));
    if (socket.connected) subscribe();
    
    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);
      setScores(data.scores || {});
    });

    // P0-11: Listen for geo:question (not geo:show)
    socket.on('geo:question', (data) => {
      setQuestion(data.question);
      setTimerEndMs(data.timerEndMs ?? 0);
      setRevealed(false);
      setPhase('INPUT_OPEN');
    });

    socket.on('geo:reveal', (data) => {
      setRevealed(true);
      setScores(data.scores || {});
    });

    return () => { socket.disconnect(); };
  }, [code]);

  return (
    <div className={styles.page}>
      <Badge variant={connected ? 'success' : 'danger'} className={styles.status}>
        {connected ? 'Verbunden' : 'Getrennt'}
      </Badge>

      {question ? (
        <>
          <Card padding="lg" className={styles.questionCard}>
            <p className={styles.category}>{question.category}</p>
            <h2 className={styles.prompt}>{question.prompt}</h2>
            
            {!revealed && <Timer endsAt={timerEndMs} size="lg" />}
            
            <div className={styles.options}>
              {question.options.map((opt: any, i: number) => {
                const isCorrect = revealed && opt.id === question.correctOptionId;
                return (
                  <div 
                    key={opt.id} 
                    className={`${styles.option} ${isCorrect ? styles.correct : ''}`}
                  >
                    <span className={styles.optionLetter}>{['A', 'B', 'C', 'D'][i]}</span>
                    <span className={styles.optionText}>{opt.text}</span>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card padding="lg" className={styles.scoreCard}>
            <h2>Spieler-Stände</h2>
            <div className={styles.scoreList}>
              {players
                .sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0))
                .map((player: any, i: number) => (
                  <div key={player.id} className={styles.scoreRow}>
                    <span className={styles.rank}>{i + 1}.</span>
                    <span className={styles.name}>{player.displayName}</span>
                    <span className={styles.score}>{scores[player.id] || 0}</span>
                  </div>
                ))}
            </div>
          </Card>
        </>
      ) : (
        <Card padding="lg" className={styles.waiting}>
          <h2>Warte auf nächste Frage...</h2>
        </Card>
      )}
    </div>
  );
}
