import { useEffect, useRef, useState } from 'react';
import { contentApi } from '../lib/contentApi';
import { getSession } from '../lib/sessionStore';
import styles from '../pages/ContentPage.module.css';

const labels: Record<string, string> = { prompt: 'Frage', question: 'Frage', answer: 'Lösung', correctOptionId: 'Richtige Antwortoption', explanation: 'Erklärung', category: 'Kategorie' };
export function ContentCorrection({ roomCode, runIndex }: { roomCode: string; runIndex: number }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof contentApi.correctionContent>>>([]), [selected, setSelected] = useState(''), [field, setField] = useState('prompt');
  const [value, setValue] = useState(''), [comment, setComment] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const generation = useRef(0), intent = useRef<{ key: string; commandId: string } | null>(null);
  useEffect(() => { const requests = generation; ++requests.current; setItems([]); setLoaded(false); setSelected(''); setError(''); return () => { ++requests.current; }; }, [roomCode, runIndex]);
  const item = items.find(i => i.itemId === selected), fields = item ? Object.keys(labels).filter(key => typeof item.payload[key] === 'string') : [];
  const access = () => { const session = getSession(); if (session.roomCode !== roomCode || !session.participationId || !session.rejoinToken) throw new Error('Bitte den Raum erneut verbinden.');
    return { roomCode, participantId: session.participationId, rejoinToken: session.rejoinToken, runIndex }; };
  return <details className={styles.panel} onToggle={async e => {
    if (!e.currentTarget.open || loaded || busy) return;
    const current = ++generation.current; setBusy(true); setError('');
    try { const rows = await contentApi.correctionContent(access()); if (current !== generation.current) return; setItems(rows); setLoaded(true);
      if (rows[0]) { setSelected(rows[0].itemId); setField(Object.keys(labels).find(key => typeof rows[0].payload[key] === 'string') ?? 'prompt'); }
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Fragen konnten nicht geladen werden.'); }
    finally { if (current === generation.current) setBusy(false); }
  }}><summary>Fehler an einer gespielten Frage melden</summary>
    <p>Dein Vorschlag geht zur Prüfung an den Eigentümer des Pools. Bestehende Ergebnisse bleiben erhalten.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loaded && !items.length && <p>Für diese Partie liegen keine aufgelösten Fragen aus einem Fragenpool vor.</p>}
    {items.length > 0 && <>
      <label>Gespielte Frage<select aria-label="Gespielte Frage" value={selected} onChange={e => { setSelected(e.target.value); const row = items.find(i => i.itemId === e.target.value); setField(Object.keys(labels).find(key => typeof row?.payload[key] === 'string') ?? 'prompt'); setValue(''); setNotice(''); }}>{items.map((i, n) => <option key={i.itemId} value={i.itemId}>{n + 1}. {String(i.payload.prompt ?? i.payload.question ?? 'Frage').slice(0, 120)}</option>)}</select></label>
      <label>Feld korrigieren<select aria-label="Feld korrigieren" value={field} onChange={e => { setField(e.target.value); setValue(''); }}>{fields.map(key => <option key={key} value={key}>{labels[key]}</option>)}</select></label>
      <label>Bisheriger Wert<textarea readOnly value={String(item?.payload[field] ?? '')} /></label>
      <label>Dein Korrekturvorschlag<textarea value={value} onChange={e => setValue(e.target.value)} maxLength={10000} /></label>
      <label>Anmerkung (optional)<textarea value={comment} onChange={e => setComment(e.target.value)} maxLength={2000} /></label>
      <button disabled={busy || !value.trim() || !item} onClick={async () => {
        if (!item) return; const current = generation.current; setBusy(true); setError('');
        try {
          const payload = { ...access(), itemId: item.itemId, field, currentValue: String(item.payload[field]), proposedValue: value, comment };
          const key = JSON.stringify(payload); if (intent.current?.key !== key) intent.current = { key, commandId: crypto.randomUUID() };
          await contentApi.submitCorrection({ ...payload, commandId: intent.current.commandId });
          if (current === generation.current) { setNotice('Dein Vorschlag wurde zur Prüfung gespeichert.'); setValue(''); setComment(''); intent.current = null; }
        } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Vorschlag konnte nicht gespeichert werden.'); }
        finally { if (current === generation.current) setBusy(false); }
      }}>Korrekturvorschlag senden</button>
    </>}
  </details>;
}
