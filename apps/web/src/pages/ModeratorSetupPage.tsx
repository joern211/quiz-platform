// ============================================================
// Moderator Setup Page
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Card, Button, Input } from '@quiz/ui';
import styles from './ModeratorSetupPage.module.css';

export function ModeratorSetupPage() {
  const { gameSlug } = useParams<{ gameSlug: string }>();
  const navigate = useNavigate();
  const [roomName, setRoomName] = useState('');
  const [pin, setPin] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(10);
  const [allowViewers, setAllowViewers] = useState(true);
  const [loading, setLoading] = useState(false);

  // Geo-specific setup
  const [selectedQuestions] = useState<string[]>([]);
  const [questionCount, setQuestionCount] = useState(10);
  const [timerDuration, setTimerDuration] = useState(20);

  const handleCreateRoom = async () => {
    setLoading(true);

    try {
      // P0-02: send setupSnapshotJson instead of setup; server stores JSON string
      const res = await fetch('/api/v1/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          gameSlug,
          roomName: roomName || `${gameSlug} Raum`,
          pin: pin || undefined,
          maxPlayers,
          allowViewers,
          setupSnapshotJson: JSON.stringify({
            questionCount,
            timerDuration,
            selectedQuestionIds: selectedQuestions,
          }),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        alert(data.error?.message || 'Raum konnte nicht erstellt werden');
        setLoading(false);
        return;
      }

      // data.data.code is the room code
      navigate(`/moderator/raum/${data.data.code}/lobby`);
    } catch {
      alert('Verbindungsfehler');
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Raum vorbereiten</h1>
      <p className={styles.subtitle}>
        Konfiguriere den Raum und die Spieloptionen für {gameSlug}
      </p>

      <div className={styles.grid}>
        <Card padding="lg">
          <h2>Raumoptionen</h2>
          
          <div className={styles.form}>
            <Input
              label="Raumname (optional)"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Mein Quiz-Abend"
            />

            <Input
              label="PIN (optional)"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••"
              maxLength={4}
              hint="4-stelliger Code für zusätzlichen Schutz"
            />

            <div className={styles.inputGroup}>
              <label className={styles.label}>Max. Spieler</label>
              <div className={styles.rangeWrapper}>
                <input
                  type="range"
                  min="2"
                  max="10"
                  value={maxPlayers}
                  onChange={(e) => setMaxPlayers(Number(e.target.value))}
                  className={styles.range}
                />
                <span className={styles.rangeValue}>{maxPlayers}</span>
              </div>
            </div>

            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={allowViewers}
                onChange={(e) => setAllowViewers(e.target.checked)}
              />
              <span>Zuschauer erlauben</span>
            </label>
          </div>
        </Card>

        <Card padding="lg">
          <h2>Spieloptionen</h2>
          
          <div className={styles.form}>
            <div className={styles.inputGroup}>
              <label className={styles.label}>Anzahl Fragen</label>
              <div className={styles.rangeWrapper}>
                <input
                  type="range"
                  min="5"
                  max="30"
                  value={questionCount}
                  onChange={(e) => setQuestionCount(Number(e.target.value))}
                  className={styles.range}
                />
                <span className={styles.rangeValue}>{questionCount}</span>
              </div>
            </div>

            <div className={styles.inputGroup}>
              <label className={styles.label}>Timer (Sekunden)</label>
              <div className={styles.rangeWrapper}>
                <input
                  type="range"
                  min="10"
                  max="60"
                  step="5"
                  value={timerDuration}
                  onChange={(e) => setTimerDuration(Number(e.target.value))}
                  className={styles.range}
                />
                <span className={styles.rangeValue}>{timerDuration}s</span>
              </div>
            </div>

            <p className={styles.hint}>
              Joker (50/50, Spy, Risk) werden für alle Spieler aktiviert.
            </p>
          </div>
        </Card>
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => navigate(-1)}>
          Zurück
        </Button>
        <Button onClick={handleCreateRoom} loading={loading}>
          Raum erstellen
        </Button>
      </div>
    </div>
  );
}
