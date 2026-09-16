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
  const [phase, setPhase] = useState<string>('WAITING');
  const [question, setQuestion] = useState<any>(null);
  const [endsAt, setEndsAt] = useState(0);
  const [players, setPlayers] = useState<any[]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const socket = io(window.location.origin, { withCredentials: true });
    
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    
    socket.emit('room:subscribe', { roomCode: code, role: 'viewer' });
    
    socket.on('room:snapshot', (data) => {
      setPlayers(data.players || []);
      setScores(data.scores || {});
    });

    socket.on('geo:show', (data) => {
      setQuestion(data.question);
      setEndsAt(data.endsAt);
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
            
            {!revealed && <Timer endsAt={endsAt} size="lg" />}
            
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
