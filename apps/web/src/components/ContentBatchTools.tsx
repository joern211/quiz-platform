import { useState } from 'react';
import type { z } from 'zod';
import { ContentBatchSchema, type ContentItemView, type ContentPoolView } from '@quiz/shared';
import { contentApi, type BatchPreview } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';

type Batch = z.infer<typeof ContentBatchSchema>;
export function ContentBatchTools({ pool, items, pools, onChanged, mayChange }: { pool: ContentPoolView; items: ContentItemView[]; pools: ContentPoolView[]; onChanged: () => void; mayChange: () => boolean }) {
  const [ids, setIds] = useState<string[]>([]), [kind, setKind] = useState('STATUS'), [value, setValue] = useState('ARCHIVED');
  const [tags, setTags] = useState<Awaited<ReturnType<typeof contentApi.tags>>>([]), [tagIds, setTagIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ batch: Batch; result: BatchPreview } | null>(null), [results, setResults] = useState<Array<{ id: string; status: string; error?: string }>>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const targets = pools.filter(p => p.id !== pool.id && p.canEdit && p.scope === 'PRIVATE' && p.gameSlug === pool.gameSlug);
  const choices = kind === 'STATUS' ? ['READY', 'DRAFT', 'DISABLED', 'ARCHIVED', 'TRASHED'] : kind === 'DIFFICULTY' ? ['', 'VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'] : targets.map(p => p.id);
  const reset = () => { setPreview(null); setResults([]); setError(''); };
  const build = (): Batch => {
    const refs = items.filter(q => ids.includes(q.id)).map(q => ({ id: q.id, revision: q.revision }));
    const target = targets.find(p => p.id === value);
    const operation = kind === 'STATUS' ? { kind, status: value } : kind === 'DIFFICULTY' ? { kind, difficulty: value || null }
      : kind === 'TAGS' ? { kind, tagIds } : { kind, targetPoolId: value, targetRevision: target?.revision ?? 0 };
    return ContentBatchSchema.parse({ poolId: pool.id, poolRevision: pool.revision, items: refs, operation });
  };
  if (!pool.canEdit) return null;
  return <details className={styles.panel}><summary>Sammelbearbeitung</summary>
    <p>Wähle Fragen und prüfe vor der Bestätigung die Auswirkungen. Änderungen an Schwierigkeit, Tags oder Pool erzeugen Entwürfe. Gespeicherte Partien behalten ihre ursprünglichen Inhalte.</p>
    <div className={styles.actions}><button disabled={busy} onClick={() => { reset(); setIds(items.slice(0, 100).map(q => q.id)); }}>Bis zu 100 Fragen auswählen</button><button disabled={busy} onClick={() => { reset(); setIds([]); }}>Auswahl aufheben</button></div>
    <ul className={styles.list}>{items.map(q => <li key={q.id}><label className={styles.check}><input type="checkbox" disabled={busy || !ids.includes(q.id) && ids.length >= 100} checked={ids.includes(q.id)} onChange={e => { reset(); setIds(v => e.target.checked ? [...v, q.id] : v.filter(id => id !== q.id)); }} />{q.title || q.id} · {q.status}</label></li>)}</ul>
    <label>Sammelaktion<select disabled={busy} value={kind} onChange={e => { reset(); setKind(e.target.value); setValue(e.target.value === 'STATUS' ? 'ARCHIVED' : e.target.value === 'DIFFICULTY' ? '' : targets[0]?.id ?? ''); if (e.target.value === 'TAGS') void contentApi.tags().then(setTags).catch(e => setError(String(e))); }}>
      <option value="STATUS">Status ändern</option><option value="DIFFICULTY">Schwierigkeit ersetzen</option><option value="TAGS">Tags ersetzen</option><option value="COPY">In privaten Pool kopieren</option><option value="MOVE">In privaten Pool verschieben</option>
    </select></label>
    {kind === 'TAGS' ? <label>Neue Tags<select multiple disabled={busy} value={tagIds} onChange={e => { reset(); setTagIds(Array.from(e.target.selectedOptions, o => o.value)); }}>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      : <label>{kind === 'STATUS' ? 'Neuer Status' : kind === 'DIFFICULTY' ? 'Neue Schwierigkeit' : 'Zielpool'}<select disabled={busy} value={value} onChange={e => { reset(); setValue(e.target.value); }}>{choices.map(v => <option key={v} value={v}>{targets.find(t => t.id === v)?.name ?? (v || 'Pool-Standard')}</option>)}</select></label>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button disabled={busy || !ids.length} onClick={async () => { setBusy(true); reset(); try { const batch = build(); setPreview({ batch, result: await contentApi.batchPreview(batch) }); } catch (e) { setError(e instanceof Error ? e.message : 'Vorschau fehlgeschlagen.'); } finally { setBusy(false); } }}>Auswirkungen prüfen</button>
    {preview && <section aria-label="Auswirkungen der Sammelaktion"><h3>{preview.result.eligible} von {preview.result.total} Fragen bearbeitbar</h3><p>{preview.result.historicallyUsed} Fragen wurden bereits verwendet. Historische Ergebnisse bleiben erhalten.</p>
      <ul>{preview.result.rows.map(r => <li key={r.id}>{r.title || r.id}: {r.error ?? r.effect} · {r.uses} Verwendungen</li>)}</ul>
      <button disabled={busy || !preview.result.eligible} onClick={async () => { if (!mayChange() || !window.confirm('Die angezeigte Sammelaktion jetzt ausführen? Nicht bearbeitbare Fragen bleiben unverändert.')) return; setBusy(true);
        try { const r = await contentApi.batchCommit(preview.batch); setResults(r.results); setPreview(null); setIds([]); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Sammelaktion fehlgeschlagen.'); } finally { setBusy(false); }
      }}>Sammelaktion bestätigen</button>
    </section>}
    {!!results.length && <div role="status"><p>{results.filter(r => r.status !== 'FAILED').length} erfolgreich, {results.filter(r => r.status === 'FAILED').length} fehlgeschlagen.</p><ul>{results.map(r => <li key={r.id}>{r.id}: {r.error ?? r.status}</li>)}</ul></div>}
  </details>;
}
