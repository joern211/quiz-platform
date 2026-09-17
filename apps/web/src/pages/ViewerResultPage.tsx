// ============================================================
// Viewer Result Page - v0.3.0
// ============================================================

import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Button } from '@quiz/ui';
import styles from './ViewerResultPage.module.css';

interface ScoreEntry {
  rank: number;
  participationId: string;
  displayName: string;
  role: string;
  score: number;
}

interface ResultsData {
  roomCode: string;
  roomName: string;
  status: string;
  runPhase: string;
  game: { slug: string; name: string } | null;
  scores: ScoreEntry[];
  endedAt: string | null;
}

export function ViewerResultPage() {
  const { code } = useParams<{ code: string }>();
  const [results, setResults] = useState<ResultsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Quick load from sessionStorage
  useEffect(() => {
    const saved = sessionStorage.getItem(`result_${code}`);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        setResults(data);
      } catch {
        // ignore
      }
    }
  }, [code]);

  // Fetch from server
  useEffect(() => {
    async function fetchResults() {
      if (!code) return;

      try {
        const res = await fetch(`/api/v1/rooms/${code}/results`, {
          credentials: 'include',
        });
        const json = await res.json();

        if (json.success && json.data) {
          setResults(json.data);
        } else {
          if (!results) {
            setError(json.error?.message || 'Ergebnisse konnten nicht geladen werden.');
          }
        }
      } catch {
        if (!results) {
          setError('Verbindungsfehler');
        }
      } finally {
        setLoading(false);
      }
    }

    fetchResults();
  }, [code]);

  if (loading && !results) return <div className={styles.page}>Lädt…</div>;

  const scores = results?.scores || [];
  const gameName = results?.game?.name || 'Spiel';

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Spiel beendet</h1>
      <p className={styles.subtitle}>{gameName} — Raum {code}</p>

      {error && !results && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      <Card padding="lg">
        <h2 className={styles.heading}>Rangliste</h2>
        {scores.length === 0 ? (
          <p>Keine Ergebnisse verfügbar.</p>
        ) : (
          <div className={styles.ranking}>
            {scores.map((entry) => (
              <div
                key={entry.participationId}
                className={`${styles.row} ${entry.rank === 1 ? styles.gold : entry.rank === 2 ? styles.silver : entry.rank === 3 ? styles.bronze : ''}`}
              >
                <span className={styles.rank}>
                  {entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : `${entry.rank}.`}
                </span>
                <span className={styles.name}>{entry.displayName}</span>
                <span className={styles.score}>{entry.score} pts</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className={styles.actions}>
        <Link to="/"><Button variant="ghost">Startseite</Button></Link>
        <Link to="/zuschauen"><Button variant="secondary">Neues Spiel zuschauen</Button></Link>
      </div>
    </div>
  );
}
