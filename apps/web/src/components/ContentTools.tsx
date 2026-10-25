import { useRef, useState } from 'react';
import type { ContentPoolView } from '@quiz/shared';
import { ContentReviewQueue } from './ContentReviewQueue';
import { contentApi, type ImportPreviewRow, type ReviewView } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';

const message = (e: unknown) => e instanceof Error ? e.message : 'Aktion fehlgeschlagen.';
const classifications: Record<string, string> = { NEW: 'Neu', EXACT: 'Identisches Duplikat', SIMILAR: 'Ähnliche Frage', CONFLICT: 'Widerspruch zur vorhandenen Frage', INVALID: 'Fehlerhaft' };
export function ContentImportTools({ pool, onChanged }: { pool: ContentPoolView; onChanged: () => void }) {
  const [preview, setPreview] = useState<{ importId: string; rows: ImportPreviewRow[] } | null>(null), [decisions, setDecisions] = useState<Record<number, string>>({});
  const [tagDecisions, setTagDecisions] = useState<Record<string, string>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [quality, setQuality] = useState<Awaited<ReturnType<typeof contentApi.quality>> | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const unknownTags = [...new Set(preview?.rows.filter(row => decisions[row.index] !== 'SKIP').flatMap(row => row.unknownTags) ?? [])];
  const readFile = async (file: File) => {
    setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Die Datei darf höchstens 5 MB groß sein.');
      const format = file.name.split('.').at(-1)?.toLocaleUpperCase(); if (!format || !['JSON', 'CSV', 'XLSX'].includes(format)) throw new Error('Bitte JSON, CSV oder XLSX auswählen.');
      const base64 = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onerror = reject; r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(file); });
      const result = await contentApi.importPreview(pool.id, format, base64); setPreview(result);
      setDecisions(Object.fromEntries(result.rows.map(row => [row.index, row.classification === 'NEW' ? 'IMPORT_NEW' : 'SKIP']))); setTagDecisions({});
    } catch (e) { setError(message(e)); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return <details className={styles.panel}><summary>Import, Export und Qualität</summary>
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <h3>Pool exportieren</h3><div className={styles.actions}>{['JSON', 'CSV', 'XLSX'].map(format => <a key={format} href={`/api/v1/content/pools/${encodeURIComponent(pool.id)}/export?format=${format}`} download>{format} herunterladen</a>)}</div>
    {pool.canEdit && <>
      <h3>Datei importieren</h3><p>Bis zu 500 Fragen pro Datei. Neue und geänderte Inhalte bleiben Entwürfe. Exportiere einen Pool als Vorlage für das Dateiformat.</p>
      <label>Importdatei<input ref={input} type="file" accept=".json,.csv,.xlsx" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (file) void readFile(file); }} /></label>
      {preview && <section aria-label="Importvorschau"><h3>{preview.rows.length} Einträge prüfen</h3>
        <p>Vorhandene Fragen werden nur mit „Vorhandene Frage aktualisieren“ geändert. Ein fehlender oder veralteter Abgleich stoppt den Import.</p>
        {preview.rows.map(row => <div key={row.index} className={styles.panel}><strong>{row.index + 1}. {row.title || 'Ohne Titel'} · {classifications[row.classification]}</strong>
          {row.errors.map((e, i) => <p key={i}>{e}</p>)}
          <label>Aktion für Eintrag {row.index + 1}<select value={decisions[row.index]} onChange={e => setDecisions(v => ({ ...v, [row.index]: e.target.value }))}>
            <option value="SKIP">Überspringen</option>
            {row.classification === 'INVALID' ? <option value="IMPORT_DRAFT">Fehlerhaften Entwurf übernehmen</option> : <><option value="IMPORT_NEW">Als neue Frage importieren</option>{row.targetId && <option value="UPDATE_EXISTING">Vorhandene Frage aktualisieren</option>}</>}
          </select></label>
          <details><summary>Änderungen vergleichen</summary><p>Vorgeschlagene Daten</p><pre className={styles.preview}>{JSON.stringify(row.proposed, null, 2)}</pre>{row.current !== null && <><p>Vorhandene Daten</p><pre className={styles.preview}>{JSON.stringify(row.current, null, 2)}</pre></>}</details>
        </div>)}
        {unknownTags.map(name => <label key={name}>Unbekannter Tag „{name}“<select value={tagDecisions[name] ?? ''} onChange={e => setTagDecisions(v => ({ ...v, [name]: e.target.value }))}><option value="">Bitte entscheiden</option><option value="IGNORE">Tag nicht übernehmen</option><option value="CREATE">Tag neu erstellen</option></select></label>)}
        <button disabled={busy || unknownTags.some(tag => !tagDecisions[tag])} onClick={async () => {
          if (!window.confirm('Die gewählten Einträge als Entwürfe importieren?')) return;
          setBusy(true); setError('');
          try { const result = await contentApi.importCommit({ commandId: crypto.randomUUID(), importId: preview.importId,
            decisions: preview.rows.map(row => ({ index: row.index, action: decisions[row.index] })), tagDecisions: unknownTags.map(name => ({ name, action: tagDecisions[name] })) });
            setPreview(null); setNotice(`${result.results.filter(r => r.status !== 'SKIPPED').length} Fragen als Entwurf übernommen.`); onChanged();
          } catch (e) { setError(message(e)); } finally { setBusy(false); }
        }}>Import bestätigen</button>
      </section>}
      <div className={styles.actions}><button disabled={busy} onClick={async () => { try { setQuality(await contentApi.quality(pool.id)); } catch (e) { setError(message(e)); } }}>Qualität prüfen</button>
        <button disabled={busy} onClick={async () => { if (!window.confirm('Pool zur öffentlichen Prüfung einreichen? Alle Fragen brauchen Quelle und Nutzungsrechte.')) return; setBusy(true);
          try { await contentApi.submitPublic(pool); setNotice('Zur Admin-Prüfung eingereicht. Der Pool ist bis zur Entscheidung gesperrt.'); onChanged(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
        }}>Öffentliche Freigabe beantragen</button></div>
      {quality && <section aria-label="Poolqualität"><h3>Poolqualität: {quality.health}</h3><p>{quality.counts.READY} freigegebene Fragen · {quality.counts.DRAFT} Entwürfe · {quality.duplicateCount} mögliche Duplikate</p>
        <p>{quality.warnings.filter(w => w.kind === 'INVALID_CONTENT').length} Fragen mit Pflichtfeldfehlern, {quality.warnings.filter(w => w.kind === 'MISSING_SOURCE').length} ohne Quelle, {quality.warnings.filter(w => w.kind === 'MISSING_TAGS').length} ohne Tags.</p></section>}
    </>}
  </details>;
}

export function ContentReviewInbox({ onChanged, actorId }: { onChanged: () => void; actorId?: string }) {
  const [sequential, setSequential] = useState(false);
  const [open, setOpen] = useState(false), [reviews, setReviews] = useState<ReviewView[]>([]), [inbox, setInbox] = useState<Awaited<ReturnType<typeof contentApi.inbox>>>([]);
  const [error, setError] = useState(''), [reason, setReason] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false);
  const load = async () => { const [r, i] = await Promise.all([contentApi.reviews(), contentApi.inbox()]); setReviews(r); setInbox(i); };
  return <section className={styles.panel}><button disabled={busy} onClick={async () => { setError(''); setBusy(true); try { await load(); setOpen(v => !v); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>Prüfungen & Inbox</button>
    {error && <p role="alert">{error}</p>}
    {open && <><h2>Offene Prüfungen ({reviews.length})</h2><button disabled={busy} onClick={() => setSequential(v => !v)}>{sequential ? 'Alle Prüfungen anzeigen' : 'Einzeln prüfen'}</button>
      {sequential && <ContentReviewQueue reviews={reviews} actorId={actorId ?? 'session'} onChanged={async () => { await load(); onChanged(); }} />}
      {(sequential ? [] : reviews).map(review => <article key={review.id} className={styles.panel}>
      <h3>{review.poolName}</h3><p>{{ PUBLIC_POOL: 'Öffentliche Freigabe', CONTENT_CHANGE: 'Änderung an veröffentlichtem Inhalt', ITEM_REVIEW: 'Fragenprüfung', CORRECTION: 'Korrekturvorschlag' }[review.kind] ?? 'Prüfung'} · {new Date(review.createdAt).toLocaleString()}</p>
      <details><summary>Gespeicherte Fassung vergleichen</summary><pre className={styles.preview}>{JSON.stringify(review.current ?? [], null, 2)}</pre></details>
      <details><summary>Vorschlag ansehen</summary><pre className={styles.preview}>{JSON.stringify(review.proposed, null, 2)}</pre></details>
      {review.canDecide && <><label>Prüfanmerkung / Ablehnungsgrund<input value={reason[review.id] ?? ''} onChange={e => setReason(v => ({ ...v, [review.id]: e.target.value }))} /></label><div className={styles.actions}>{[true, false].map(approve => <button key={String(approve)} disabled={busy || !approve && !reason[review.id]?.trim()} onClick={async () => {
        if (!window.confirm(approve ? 'Diesen Vorschlag verbindlich freigeben?' : 'Änderungen anfordern?')) return; setBusy(true);
        try { await contentApi.decide(review.id, approve, reason[review.id] ?? ''); await load(); onChanged(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
      }}>{approve ? 'Freigeben' : 'Änderungen anfordern'}</button>)}</div></>}
    </article>)}<h2>Inbox</h2>{!inbox.length && <p>Noch keine Benachrichtigungen.</p>}{inbox.map(note => <div key={note.id}><p>{note.message}</p>{!note.readAt && <button onClick={async () => { try { await contentApi.markRead(note.id); await load(); } catch (e) { setError(message(e)); } }}>Als gelesen markieren</button>}</div>)}</>}
  </section>;
}
