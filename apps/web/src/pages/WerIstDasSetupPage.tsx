import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './WerIstDasSetupPage.module.css';

interface RoundDraft { id: string; imageAssetId: string; person1: string; person2: string; fileName?: string }
const newRound = (): RoundDraft => ({ id: crypto.randomUUID(), imageAssetId: '', person1: '', person2: '' });

export function WerIstDasSetupPage() {
  const navigate = useNavigate();
  const [rounds, setRounds] = useState<RoundDraft[]>([newRound()]);
  const [roomName, setRoomName] = useState('Wer ist das?');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (index: number, patch: Partial<RoundDraft>) => setRounds(previous =>
    previous.map((round, i) => i === index ? { ...round, ...patch } : round));

  async function upload(index: number, file?: File) {
    if (!file) return;
    setError('');
    const body = new FormData();
    body.set('file', file);
    try {
      const response = await fetch('/api/v1/media', { method: 'POST', credentials: 'include', body });
      const result = await response.json();
      if (!response.ok || !result.success || result.data?.type !== 'image') throw new Error(result.error?.message ?? 'Bild nicht akzeptiert');
      update(index, { imageAssetId: result.data.id, fileName: file.name });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Upload fehlgeschlagen'); }
  }

  async function create() {
    if (rounds.some(round => !round.imageAssetId || !round.person1.trim() || !round.person2.trim())) {
      setError('Bitte für jede Runde ein Bild und beide Personen angeben.'); return;
    }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/rooms', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameSlug: 'weristdas', roomName, pin: pin || undefined,
          maxPlayers: 10, allowViewers: true, viewerRequiresPin: false,
          setupSnapshotJson: { rounds: rounds.map(({ id, imageAssetId, person1, person2 }) =>
            ({ id, imageAssetId, person1: person1.trim(), person2: person2.trim() })) } }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error?.message ?? 'Raum konnte nicht erstellt werden');
      navigate(`/moderator/raum/${result.data.code}/lobby`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Verbindungsfehler'); }
    finally { setBusy(false); }
  }

  return <div className={styles.page}>
    <h1>Wer ist das? einrichten</h1>
    <p>Für jede Runde ein vorbereitetes Bild und die beiden gesuchten Personen hochladen.</p>
    <label>Raumname <input value={roomName} onChange={event => setRoomName(event.target.value)} /></label>
    <label>Spieler-PIN (optional) <input value={pin} onChange={event => setPin(event.target.value)} /></label>
    {rounds.map((round, index) => <fieldset key={round.id} className={styles.round}>
      <legend>Runde {index + 1}</legend>
      <label>Bild <input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => void upload(index, event.target.files?.[0])} /></label>
      {round.fileName && <p>Hochgeladen: {round.fileName}</p>}
      <label>Person 1 <input value={round.person1} onChange={event => update(index, { person1: event.target.value })} /></label>
      <label>Person 2 <input value={round.person2} onChange={event => update(index, { person2: event.target.value })} /></label>
      {rounds.length > 1 && <button type="button" onClick={() => setRounds(previous => previous.filter((_, i) => i !== index))}>Runde entfernen</button>}
    </fieldset>)}
    {rounds.length < 50 && <button type="button" onClick={() => setRounds(previous => [...previous, newRound()])}>Runde hinzufügen</button>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void create()}>{busy ? 'Erstelle Raum …' : 'Raum erstellen'}</button>
  </div>;
}
