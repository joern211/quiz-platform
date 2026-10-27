import { SetupBlueprints } from '../components/SetupBlueprints';
import { SetupRoomRules } from '../components/SetupRoomRules';
import { blueprintRoomInput, roomSettingsAfterPin, ROOM_SETUP_DEFAULTS, type BlueprintApplication } from '../lib/setupBlueprints';
import type { BlueprintRoomSettings, GamePresetConfiguration } from '@quiz/shared';
import { ContentPoolPicker, DEFAULT_CONTENT_OPTIONS, contentSelectionPayload } from '../components/ContentPoolPicker';
// ============================================================
// Moderator Setup Page
// ============================================================

import { useParams, useNavigate } from 'react-router-dom';
import { useState, useRef } from 'react';
import { Card, Button, Input } from '@quiz/ui';
import styles from './ModeratorSetupPage.module.css';

export function ModeratorSetupPage() {
  const [roomExtra, setRoomExtra] = useState<BlueprintRoomSettings>({});
  const [application, setApplication] = useState<BlueprintApplication | null>(null);
  const [contentPools, setContentPools] = useState<string[]>([]);
  const [contentOptions, setContentOptions] = useState(DEFAULT_CONTENT_OPTIONS);
  const { gameSlug } = useParams<{ gameSlug: string }>();
  const navigate = useNavigate();
  const [roomName, setRoomName] = useState('');
  const [pin, setPin] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(10);
  const [allowViewers, setAllowViewers] = useState(true);
  const [loading, setLoading] = useState(false);
  // Audit 11-06: stabiles Idempotency-Token pro Erstellungsabsicht.
  // Diese generische Setup-Seite ist der eigentliche Pfad für Geo
  // (/moderator/vorbereitung/:gameSlug) — ohne Token würde hier der
  // serverseitige Fingerprint greifen und mehrere identische
  // Erstellungen (gleicher Host/Name/Spiel/Setup, z. B. E2E-Batch)
  // in EINEN Raum mergen. Ein frisches Token pro Klick trennt das:
  // derselbe Klick/Retry → gleiche Absicht; neuer Klick → neuer Raum.
  const idempotencyRef = useRef<string | null>(null);

  // Geo-specific setup
  const [selectedQuestions, setSelectedQuestions] = useState<string[]>([]);
  const [legacyPool, setLegacyPool] = useState<string | undefined>();
  const [questionCount, setQuestionCount] = useState(10);
  const [timerDuration, setTimerDuration] = useState(20);

  const currentConfiguration = (): GamePresetConfiguration => ({ room: { ...ROOM_SETUP_DEFAULTS, ...roomExtra, maxPlayers, allowViewers }, setup: {
    questionCount, timerDuration, ...(legacyPool ? { questionPoolId: legacyPool } : {}), ...(selectedQuestions.length ? { selectedQuestionIds: selectedQuestions } : {}),
    ...(contentPools.length ? { contentSelection: contentSelectionPayload(contentPools, questionCount, contentOptions) } : {}),
  } });
  const handleCreateRoom = async () => {
    if (loading) return;
    setLoading(true);

    try {
      // Audit 11-06: stabiles Idempotency-Token pro Erstellungsabsicht.
      // Doppelklick/Timeout-Retry desselben Klicks → gleiche Absicht
      // (derselbe Raum); ein neuer Klick erzeugt ein frisches Token
      // (neuer Raum). Ohne Token würde der serverseitige Fingerprint
      // greifen und identische Erstellungen in einen Raum mergen.
      if (!idempotencyRef.current) idempotencyRef.current = crypto.randomUUID();

      // P0-02: send setupSnapshotJson instead of setup; server stores JSON string
      const res = await fetch('/api/v1/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          gameSlug,
          roomName: roomName || `${gameSlug} Raum`,
          pin: pin || undefined,
          ...blueprintRoomInput(currentConfiguration(), application),
          idempotencyKey: idempotencyRef.current,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        alert(data.error?.message || 'Raum konnte nicht erstellt werden');
        setLoading(false);
        return;
      }

      // Raum erstellt → Absicht erfüllt, nächster Klick erhält frisches Token.
      idempotencyRef.current = null;
      // data.data.code is the room code
      navigate(`/moderator/raum/${data.data.code}/lobby`);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Verbindungsfehler');
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Raum vorbereiten</h1>
      <p className={styles.subtitle}>
        Konfiguriere den Raum und die Spieloptionen für {gameSlug}
      </p>

      {(gameSlug === 'wissensduell' || gameSlug === 'geo') && <SetupBlueprints gameSlug="wissensduell" current={currentConfiguration} onApply={(configuration, applied) => {
        setApplication(applied); setRoomExtra(configuration.room); setMaxPlayers(configuration.room.maxPlayers ?? 10); setAllowViewers(configuration.room.allowViewers ?? true);
        setSelectedQuestions(configuration.setup.selectedQuestionIds ?? []); setLegacyPool(configuration.setup.questionPoolId);
        setQuestionCount(configuration.setup.contentSelection?.count ?? configuration.setup.questionCount ?? 10); setTimerDuration(configuration.setup.timerDuration ?? 20);
        const selection = configuration.setup.contentSelection; setContentPools(selection?.poolIds ?? []);
        setContentOptions(selection ? { ...DEFAULT_CONTENT_OPTIONS, ...selection, difficulty: selection.difficulty ?? '', category: selection.category ?? '' } : DEFAULT_CONTENT_OPTIONS);
        idempotencyRef.current = null;
      }} />}
      <SetupRoomRules pinPresent={!!pin} value={{ ...ROOM_SETUP_DEFAULTS, ...roomExtra, maxPlayers, allowViewers }} onChange={setRoomExtra} />
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
              onChange={(e) => { setPin(e.target.value); setRoomExtra(value => roomSettingsAfterPin(value, e.target.value)); }}
              placeholder="••••"
              maxLength={4}
              hint="4-stelliger Code für zusätzlichen Schutz"
            />

            <div className={styles.inputGroup}>
              <label className={styles.label}>Max. Spieler</label>
              <div className={styles.rangeWrapper}>
                <input
                  type="range"
                  aria-label="Maximale Spieler"
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
          {(gameSlug === 'wissensduell' || gameSlug === 'geo') && <ContentPoolPicker count={questionCount} gameSlug="wissensduell" selected={contentPools} onChange={setContentPools} options={contentOptions} onOptionsChange={setContentOptions} />}
          
          <div className={styles.form}>
            <div className={styles.inputGroup}>
              <label className={styles.label}>Anzahl Fragen</label>
              <div className={styles.rangeWrapper}>
                <input
                  type="range"
                  aria-label="Anzahl Fragen"
                  min="1"
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
                  aria-label="Timer in Sekunden"
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
