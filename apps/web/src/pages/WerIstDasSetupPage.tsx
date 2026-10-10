import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GAME_SLUGS } from '@quiz/shared';
import styles from './WerIstDasSetupPage.module.css';

interface RoundDraft {
  id: string;
  personAImageAssetId: string;
  personBImageAssetId: string;
  gameImageAssetId: string;
  gameImageUrl: string;
  personAName: string;
  personBName: string;
  fileNameA?: string;
  fileNameB?: string;
  statusA: 'idle' | 'uploading' | 'done' | 'error';
  statusB: 'idle' | 'uploading' | 'done' | 'error';
  fusionStatus: 'idle' | 'generating' | 'ready' | 'error';
  /** 11-05: wie oft die Vorschau-URL nach ihrem Ablauf erneuert wurde. */
  renewals: number;
}

const newRound = (): RoundDraft => ({
  id: crypto.randomUUID(),
  personAImageAssetId: '',
  personBImageAssetId: '',
  gameImageAssetId: '',
  gameImageUrl: '',
  personAName: '',
  personBName: '',
  statusA: 'idle',
  statusB: 'idle',
  fusionStatus: 'idle',
  renewals: 0,
});

export function WerIstDasSetupPage() {
  const navigate = useNavigate();
  const [rounds, setRounds] = useState<RoundDraft[]>([newRound()]);
  const [roomName, setRoomName] = useState('Wer ist das?');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (index: number, patch: Partial<RoundDraft>) =>
    setRounds(previous => previous.map((round, i) => (i === index ? { ...round, ...patch } : round)));

  async function upload(index: number, which: 'A' | 'B', file?: File) {
    if (!file) return;
    setError('');
    update(index, which === 'A' ? { statusA: 'uploading' } : { statusB: 'uploading' });
    const body = new FormData();
    body.set('file', file);
    try {
      const response = await fetch('/api/v1/media', { method: 'POST', credentials: 'include', body });
      const result = await response.json();
      if (!response.ok || !result.success || result.data?.type !== 'image') {
        throw new Error(result.error?.message ?? 'Das Bild konnte nicht verarbeitet werden.');
      }
      update(index, which === 'A'
        ? { personAImageAssetId: result.data.id, fileNameA: file.name, statusA: 'done' }
        : { personBImageAssetId: result.data.id, fileNameB: file.name, statusB: 'done' });
      // Ersetzte Quelle → altes Fusion-Bild gilt für diese Runde nicht mehr.
      update(index, { gameImageAssetId: '', gameImageUrl: '', fusionStatus: 'idle' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload fehlgeschlagen');
      update(index, which === 'A' ? { statusA: 'error' } : { statusB: 'error' });
    }
  }

  async function createFusion(index: number) {
    const round = rounds[index];
    if (!round.personAImageAssetId || !round.personBImageAssetId) return;
    setError('');
    update(index, { fusionStatus: 'generating' });
    try {
      const response = await fetch('/api/v1/media/composite', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personAImageAssetId: round.personAImageAssetId,
          personBImageAssetId: round.personBImageAssetId,
          roundId: round.id,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error?.message ?? 'Das Spielbild konnte nicht erzeugt werden.');
      }
      update(index, {
        gameImageAssetId: result.data.gameImageAssetId,
        gameImageUrl: result.data.gameImageUrl,
        fusionStatus: 'ready',
        renewals: 0,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Fusion fehlgeschlagen');
      update(index, { fusionStatus: 'error' });
    }
  }

  /**
   * 11-05: Vorschau-URL-Erneuerung im Setup. Die host-Signed-URL läuft nach
   * ihrer TTL ab (Setup kann länger dauern). Lädt das Bild nicht mehr, wird
   * das Composite neu angefordert: gleiche Quellen + roundId → gleiche
   * (idempotente) Asset-ID, aber eine FRESHE Signatur. Kein Game-Resync
   * (es gibt im Setup keinen Raum), begrenzte Wiederholungen.
   */
  async function renewPreview(index: number) {
    const round = rounds[index];
    if (round.renewals >= 3) return;
    try {
      const response = await fetch('/api/v1/media/composite', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personAImageAssetId: round.personAImageAssetId,
          personBImageAssetId: round.personBImageAssetId,
          roundId: round.id,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message ?? 'Erneuerung fehlgeschlagen.');
      update(index, {
        gameImageAssetId: result.data.gameImageAssetId,
        gameImageUrl: result.data.gameImageUrl,
        renewals: round.renewals + 1,
      });
    } catch {
      /* Vorschau bleibt im Fehlerzustand; Raum-Erstellung ist davon unabhängig. */
    }
  }

  function validate(): string | null {
    if (rounds.length === 0) return 'Bitte mindestens eine Runde anlegen.';
    for (const [i, round] of rounds.entries()) {
      if (!round.personAImageAssetId || !round.personBImageAssetId) {
        return `Runde ${i + 1}: Bitte beide Bilder auswählen.`;
      }
      if (!round.personAName.trim() || !round.personBName.trim()) {
        return `Runde ${i + 1}: Bitte beide Namen eingeben.`;
      }
      if (!round.gameImageAssetId) {
        return `Runde ${i + 1}: Bitte zuerst das Spielbild aus beiden Bildern erzeugen.`;
      }
    }
    return null;
  }

  // Audit 11-06: STABILES Idempotency-Token pro Erstellungsabsicht.
  // Erzeugt beim Klick, für die zugehörigen HTTP-Versuche dieses Klicks
  // wiederverwendet (Retry/Proxy-Duplicate), danach entsorgt → ein neuer
  // Klick ist eine neue Absicht und erhält ein neues Token (ein bewusst
  // neuer Raum bleibt möglich).
  const idempotencyRef = useRef<string | null>(null);

  async function create() {
    const problem = validate();
    if (problem) { setError(problem); return; }
    if (!idempotencyRef.current) idempotencyRef.current = crypto.randomUUID();
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/rooms', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameSlug: GAME_SLUGS.werIstDas, roomName, pin: pin || undefined,
          maxPlayers: 10, allowViewers: true, viewerRequiresPin: false,
          idempotencyKey: idempotencyRef.current,
          setupSnapshotJson: {
            // PR11-Nacharbeit D: Setup-Schema-Version EHRLICH. Der Reader liest
            // `setupSchemaVersion` (top-level) — 2 = v1+v2-Runden möglich.
            // (Fehlerteufel vorher: hieß `setupVersion` und fiel auf 1 zurück.)
            setupSchemaVersion: 2,
            rounds: rounds.map(round => ({
              id: round.id,
              personAImageAssetId: round.personAImageAssetId,
              personBImageAssetId: round.personBImageAssetId,
              gameImageAssetId: round.gameImageAssetId,
              personAName: round.personAName.trim(),
              personBName: round.personBName.trim(),
              setupVersion: 2,
            })),
          },
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message ?? 'Raum konnte nicht erstellt werden.');
      idempotencyRef.current = null; // Raum erstellt → Absicht erfüllt
      navigate(`/moderator/raum/${result.data.code}/lobby`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Verbindungsfehler'); }
    finally { setBusy(false); }
  }

  return <div className={styles.page}>
    <h1>Wer ist das? einrichten</h1>
    <p>Für jede Runde zwei Bilder und zwei Namen angeben. Aus den beiden Bildern wird ein
      fusioniertes Spielbild erzeugt — dieses sehen die Spieler, die Originale und Namen
      bleiben bis zur Auflösung geheim.</p>
    <label>Raumname <input value={roomName} onChange={event => setRoomName(event.target.value)} /></label>
    <label>Spieler-PIN (optional) <input value={pin} onChange={event => setPin(event.target.value)} /></label>
    {rounds.map((round, index) => <fieldset key={round.id} className={styles.round}>
      <legend>Runde {index + 1}</legend>
      <div className={styles.imagePair}>
        <label>Bild A <input type="file" accept="image/jpeg,image/png,image/webp"
          onChange={event => void upload(index, 'A', event.target.files?.[0])} /></label>
        {round.fileNameA && <p className={round.statusA === 'error' ? styles.errorText : styles.okText}>
          {round.statusA === 'uploading' ? 'Bild A wird verarbeitet …' : `Bild A: ${round.fileNameA}`}</p>}
        <label>Bild B <input type="file" accept="image/jpeg,image/png,image/webp"
          onChange={event => void upload(index, 'B', event.target.files?.[0])} /></label>
        {round.fileNameB && <p className={round.statusB === 'error' ? styles.errorText : styles.okText}>
          {round.statusB === 'uploading' ? 'Bild B wird verarbeitet …' : `Bild B: ${round.fileNameB}`}</p>}
      </div>
      <div className={styles.namePair}>
        <label>Name A <input value={round.personAName} onChange={event => update(index, { personAName: event.target.value })} /></label>
        <label>Name B <input value={round.personBName} onChange={event => update(index, { personBName: event.target.value })} /></label>
      </div>
      {round.personAImageAssetId && round.personBImageAssetId &&
        <button type="button" disabled={round.fusionStatus === 'generating'}
          onClick={() => void createFusion(index)}>
          {round.fusionStatus === 'ready' ? 'Spielbild neu erzeugen'
            : round.fusionStatus === 'generating' ? 'Spielbild wird erzeugt …'
            : 'Spielbild aus beiden Bildern erzeugen'}
        </button>}
      {round.fusionStatus === 'ready' && round.gameImageUrl &&
        <p className={styles.okText}>
          <img className={styles.preview} src={round.gameImageUrl} alt="Vorschau des Spielbilds"
            onError={() => { void renewPreview(index); }} />
          Das ist das Spielbild, das die Spieler in dieser Runde sehen.
        </p>}
      {rounds.length > 1 && <button type="button" onClick={() => setRounds(previous => previous.filter((_, i) => i !== index))}>Runde entfernen</button>}
    </fieldset>)}
    {rounds.length < 50 && <button type="button" onClick={() => setRounds(previous => [...previous, newRound()])}>Runde hinzufügen</button>}
    {error && <p role="alert" className={styles.errorText}>{error}</p>}
    <button type="button" disabled={busy} onClick={() => void create()}>{busy ? 'Erstelle Raum …' : 'Raum erstellen'}</button>
  </div>;
}
