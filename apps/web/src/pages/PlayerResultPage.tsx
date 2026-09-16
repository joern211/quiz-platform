// ============================================================
// Player Result Page
// ============================================================

import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button, Badge } from '@quiz/ui';
import styles from './PlayerResultPage.module.css';

interface ScoreEntry {
  participationId: string;
  displayName: string;
  score: number;
  rank: number;
}

export function PlayerResultPage() {
  const { code } = useParams<{ code: string }>();
  const [scores, setScores] = useState<ScoreEntry[]>([]);
  const [gameName, setGameName] = useState('');
  const [myRank, setMyRank] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const saved = sessionStorage.getItem(`result_${code}`);
    if (saved) {
      const data = JSON.parse(saved);
      setScores(data.scores || []);
      setGameName(data.gameName || '');
      setMyRank(data.myRank || 0);
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [code]);

  if (loading) return <div className={styles.page}>Lädt…</div>;

  const medal = myRank === 1 ? '🥇' : myRank === 2 ? '🥈' : myRank === 3 ? '🥉' : null;

  return (
    <div className={styles.page}>
      {medal && <div className={styles.medal}>{medal}</div>}
      <h1 className={styles.title}>
        {myRank === 1 ? 'Du hast gewonnen!' : myRank <= 3 ? 'Top 3!' : 'Spiel beendet'}
      </h1>
      <p className={styles.subtitle}>{gameName}</p>

      <Card padding="lg">
        <h2 className={styles.heading}>Rangliste</h2>
        {scores.length === 0 ? (
          <p>Keine Ergebnisse verfügbar.</p>
        ) : (
          <div className={styles.ranking}>
            {scores.map((entry, i) => (
              <div key={entry.participationId} className={`${styles.row} ${i === 0 ? styles.gold : i === 1 ? styles.silver : i === 2 ? styles.bronze : ''}`}>
                <span className={styles.rank}>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}</span>
                <span className={styles.name}>{entry.displayName}</span>
                <Badge variant="accent">{entry.score} pts</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className={styles.actions}>
        <Link to="/"><Button variant="ghost">Startseite</Button></Link>
        <Link to="/beitreten"><Button variant="primary">Nochmal spielen</Button></Link>
      </div>
    </div>
  );
}
