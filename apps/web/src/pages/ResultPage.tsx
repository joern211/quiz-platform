// ============================================================
// Result Page (for all roles)
// ============================================================

import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { io } from 'socket.io-client';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './ResultPage.module.css';

export function ResultPage() {
  const { code } = useParams<{ code: string }>();
  const [results, setResults] = useState<any[]>([]);
  const [roomInfo, setRoomInfo] = useState<any>(null);

  useEffect(() => {
    const socket = io(window.location.origin, { withCredentials: true });
    
    socket.emit('room:subscribe', { roomCode: code });
    
    socket.on('room:snapshot', (data) => {
      setRoomInfo(data);
      if (data.finalScores) {
        setResults(data.finalScores);
      } else {
        // Calculate from players
        const scores = (data.players || []).map((p: any) => ({
          id: p.id,
          name: p.displayName,
          score: p.score || 0,
          avatar: p.avatar,
        })).sort((a: any, b: any) => b.score - a.score);
        setResults(scores);
      }
    });

    return () => { socket.disconnect(); };
  }, [code]);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>
        {roomInfo?.status === 'ENDED' ? 'Spiel beendet!' : 'Ergebnisse'}
      </h1>
      <p className={styles.game}>{roomInfo?.game?.name}</p>

      <Card padding="lg" className={styles.resultsCard}>
        <h2>Rangliste</h2>
        
        <div className={styles.ranking}>
          {results.map((player: any, i: number) => (
            <div 
              key={player.id} 
              className={`${styles.playerRow} ${i === 0 ? styles.first : ''} ${i === 1 ? styles.second : ''} ${i === 2 ? styles.third : ''}`}
            >
              <span className={styles.rank}>
                {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}
              </span>
              <span className={styles.name}>{player.name}</span>
              <span className={styles.score}>{player.score}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className={styles.actions}>
        <Button onClick={() => window.location.href = '/'}>
          Zur Startseite
        </Button>
      </div>
    </div>
  );
}
