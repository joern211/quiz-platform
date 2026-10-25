import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Link } from 'react-router-dom';
import { CONTENT_TEMPLATES, validateContentPayload, type ContentItemView, type ContentPoolView } from '@quiz/shared';
import { authApi } from '../lib/api';
import { ContentApiError, contentApi } from '../lib/contentApi';
import styles from './ContentPage.module.css';
import { ContentImportTools, ContentReviewInbox } from '../components/ContentTools';
import { ContentPoolSettings } from '../components/ContentPoolSettings';

type Draft = { title: string; payload: Record<string, unknown>; language: string | null; difficulty: string | null; tagIds: string[] | null; source: string; sourceUrl: string; license: string };
function fromItem(item: ContentItemView): Draft { return { title: item.title, payload: item.payload, language: item.language, difficulty: item.difficulty, tagIds: item.tagIds, source: item.source, sourceUrl: item.sourceUrl, license: item.license }; }
function newDraft(slug: string): Draft { return { ...JSON.parse(JSON.stringify(CONTENT_TEMPLATES[slug as keyof typeof CONTENT_TEMPLATES])), language: null, difficulty: null, tagIds: null, source: '', sourceUrl: '', license: '' }; }
const errorMessage = (error: unknown) => error instanceof ContentApiError && error.code === 'REVISION_CONFLICT'
  ? 'Jemand hat diese Frage inzwischen geändert. Dein Entwurf bleibt erhalten. Lade die aktuelle Version und vergleiche die Änderungen.'
  : error instanceof Error ? error.message : 'Speichern fehlgeschlagen.';

export function ContentEditor({ initial, pool, onSaved, dirtyFlag, actorId }: { initial: ContentItemView | null; pool: ContentPoolView; onSaved: (item: ContentItemView) => void; dirtyFlag?: MutableRefObject<boolean>; actorId?: string }) {
  const [draft, setDraft] = useState<Draft>(() => initial ? fromItem(initial) : newDraft(pool.gameSlug));
  const [item, setItem] = useState(initial), [status, setStatus] = useState(initial ? 'Gespeichert' : 'Ungespeichert');
  const [error, setError] = useState(''), [paused, setPaused] = useState(false), [busy, setBusy] = useState(false);
  const [conflictCurrent, setConflictCurrent] = useState<ContentItemView | null>(null);
  const modeKey = `qp_content_editor_mode:${actorId ?? pool.ownerId ?? 'anonymous'}`;
  const [mode, setMode] = useState(() => localStorage.getItem(modeKey) ?? 'QUICK');
  const [tags, setTags] = useState<Awaited<ReturnType<typeof contentApi.tags>>>([]), [tagError, setTagError] = useState('');
  const [history, setHistory] = useState<Awaited<ReturnType<typeof contentApi.history>>>([]), [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [previewRole, setPreviewRole] = useState('PLAYER'), [reveal, setReveal] = useState(false);
  const saved = useRef(initial ? JSON.stringify(fromItem(initial)) : ''), alive = useRef(true), writing = useRef(false);
  const draftRef = useRef(draft); draftRef.current = draft;
  const json = JSON.stringify(draft), dirty = json !== saved.current;
  const canWrite = (pool.canEdit || !!pool.canPropose) && (!item || item.lockState === 'EDITABLE');
  if (dirtyFlag) dirtyFlag.current = dirty || busy;
  const validation = validateContentPayload(pool.gameSlug, draft.payload);
  const valid = validation.success;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (mode !== 'ADVANCED') return; let current = true;
    contentApi.tags().then(data => { if (current) { setTags(data); setTagError(''); } }, () => { if (current) setTagError('Tags konnten nicht geladen werden.'); });
    return () => { current = false; }; }, [mode]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => { if (JSON.stringify(draftRef.current) !== saved.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, []);
  useEffect(() => {
    if (!dirty || !item || paused || busy || !pool.canEdit || !canWrite) return;
    setStatus('Ungespeichert');
    const timer = setTimeout(async () => {
      if (writing.current) return;
      writing.current = true; setBusy(true); setStatus('Speichert …');
      try {
        const result = await contentApi.save(item.id, item.revision, JSON.parse(json));
        if (!alive.current) return;
        saved.current = json; setItem(result); onSaved(result); setStatus('Gespeichert'); setError('');
      } catch (e) { if (alive.current) { setError(errorMessage(e)); setPaused(true); setStatus('Fehler'); } }
      finally { writing.current = false; if (alive.current) setBusy(false); }
    }, 800);
    return () => clearTimeout(timer);
  }, [json, dirty, item, paused, busy, pool.canEdit, canWrite, onSaved]);
  const patch = (values: Partial<Draft>) => { setDraft(v => ({ ...v, ...values })); setStatus('Ungespeichert'); setPreview(null); };
  const field = (key: string, value: unknown) => patch({ payload: { ...draft.payload, [key]: value } });
  const run = async (action: () => Promise<ContentItemView>) => {
    if (writing.current) return; writing.current = true; setBusy(true); setError('');
    try { const result = await action(); if (alive.current) { setItem(result); setDraft(fromItem(result)); saved.current = JSON.stringify(fromItem(result)); setStatus('Gespeichert'); setPaused(false); setConflictCurrent(null); onSaved(result); } }
    catch (e) { if (alive.current) { setError(errorMessage(e)); setStatus('Fehler'); } }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const input = (label: string, key: string, multiline = false) => <label>{label}{multiline
    ? <textarea disabled={!canWrite || busy && !item} value={String(draft.payload[key] ?? '')} onChange={e => field(key, e.target.value)} />
    : <input disabled={!canWrite || busy && !item} value={String(draft.payload[key] ?? '')} onChange={e => field(key, e.target.value)} />}</label>;
  const options = (draft.payload.options ?? []) as Array<{ id: string; text: string }>;
  return <section className={styles.panel} aria-label="Frageneditor">
    <h2>{item ? 'Frage bearbeiten' : 'Neue Frage'}</h2>
    <p className={styles.status} role="status">{status} · {item?.status ?? 'DRAFT'}{item ? ` · Version ${item.revision}` : ''}</p>
    {!pool.canEdit && <p>{pool.canPropose ? 'Änderungen an veröffentlichten Fragen werden vom Admin geprüft.' : 'Dieser Pool ist schreibgeschützt. Erstelle eine private Kopie, um Inhalte zu ändern.'}</p>}
    <div className={styles.actions}><button onClick={() => { const next = mode === 'QUICK' ? 'ADVANCED' : 'QUICK'; setMode(next); localStorage.setItem(modeKey, next); }}>{mode === 'QUICK' ? 'Erweiterte Optionen' : 'Einfache Ansicht'}</button></div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {paused && <div className={styles.actions}>
      <button onClick={() => setPaused(false)}>Speichern erneut versuchen</button>
      <button onClick={async () => {
        if (!item) return;
        try { const current = (await contentApi.pool(pool.id)).items.find(q => q.id === item.id); if (current) {
          setConflictCurrent(current);
        } } catch (e) { setError(errorMessage(e)); }
      }}>Aktuelle Version vergleichen</button>
    </div>}
    {conflictCurrent && <section aria-label="Bearbeitungskonflikt"><h3>Dein Entwurf und Version {conflictCurrent.revision}</h3>
      <details open><summary>Aktuelle gespeicherte Fassung</summary><pre className={styles.preview}>{JSON.stringify(fromItem(conflictCurrent), null, 2)}</pre></details>
      <details><summary>Dein lokaler Entwurf</summary><pre className={styles.preview}>{JSON.stringify(draft, null, 2)}</pre></details>
      <div className={styles.actions}><button disabled={busy} onClick={() => {
        if (!window.confirm('Deinen lokalen Entwurf verwerfen und die aktuelle gespeicherte Fassung übernehmen?')) return;
        setItem(conflictCurrent); setDraft(fromItem(conflictCurrent)); saved.current = JSON.stringify(fromItem(conflictCurrent));
        setPaused(false); setError(''); setStatus('Gespeichert'); onSaved(conflictCurrent); setConflictCurrent(null);
      }}>Aktuelle Fassung übernehmen</button>
      <button disabled={busy || !pool.canEdit} onClick={() => {
        if (window.confirm('Deinen Entwurf als neue Version auf Basis der angezeigten aktuellen Fassung speichern?')) void run(() => contentApi.save(conflictCurrent.id, conflictCurrent.revision, draftRef.current));
      }}>Meinen Entwurf als neue Version speichern</button></div>
    </section>}
    <label>Interner Titel<input disabled={!canWrite} value={draft.title} onChange={e => patch({ title: e.target.value })} /></label>
    {input('Kategorie', 'category')}
    {pool.gameSlug === 'wissensduell' ? <>
      {input('Frage', 'prompt', true)}
      <div className={styles.options}>{options.map((option, index) => <label key={option.id}>Antwort {index + 1}<input disabled={!canWrite} value={option.text} onChange={e => field('options', options.map((o, i) => i === index ? { ...o, text: e.target.value } : o))} /></label>)}</div>
      <label>Richtige Antwort<select disabled={!canWrite} value={String(draft.payload.correctOptionId)} onChange={e => field('correctOptionId', e.target.value)}>{options.map((o, i) => <option key={o.id} value={o.id}>Antwort {i + 1}</option>)}</select></label>
    </> : <>{input('Frage', 'question', true)}{input('Lösung', 'answer', true)}<label>Punktwert<input disabled={!canWrite} type="number" min={1} value={Number(draft.payload.value)} onChange={e => field('value', Number(e.target.value))} /></label></>}
    {mode === 'ADVANCED' && <>
      {pool.gameSlug === 'wissensduell' && <>{input('Erklärung', 'explanation', true)}<label>Punkte<input disabled={!canWrite} type="number" min={0} value={Number(draft.payload.points)} onChange={e => field('points', Number(e.target.value))} /></label><label>Dauer in Sekunden<input disabled={!canWrite} type="number" min={1} value={Number(draft.payload.durationMs) / 1000} onChange={e => field('durationMs', Number(e.target.value) * 1000)} /></label></>}
      <label>Sprache<select disabled={!canWrite} value={draft.language ?? ''} onChange={e => patch({ language: e.target.value || null })}><option value="">Pool-Standard ({pool.defaults.language})</option>{['de-DE', 'en-US', 'tr-TR'].map(l => <option key={l}>{l}</option>)}</select></label>
      <label>Schwierigkeit<select disabled={!canWrite} value={draft.difficulty ?? ''} onChange={e => patch({ difficulty: e.target.value || null })}><option value="">Pool-Standard ({pool.defaults.difficulty ?? 'nicht gesetzt'})</option>{['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'].map(l => <option key={l}>{l}</option>)}</select></label>
      {tagError && <p>{tagError}</p>}
      <label>Tags {draft.tagIds === null ? '(vom Pool übernommen)' : '(eigene Auswahl)'}<select aria-label="Fragen-Tags" multiple disabled={!canWrite} value={draft.tagIds ?? pool.defaults.tagIds} onChange={e => patch({ tagIds: Array.from(e.target.selectedOptions, o => o.value) })}>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <button disabled={!canWrite || draft.tagIds === null} onClick={() => patch({ tagIds: null })}>Pool-Tags übernehmen</button>
      <label>Quelle<input disabled={!canWrite} value={draft.source} onChange={e => patch({ source: e.target.value })} /></label>
      <label>Quellen-URL<input disabled={!canWrite} type="url" value={draft.sourceUrl} onChange={e => patch({ sourceUrl: e.target.value })} /></label>
      <label>Lizenz / Nutzungserlaubnis<input disabled={!canWrite} value={draft.license} onChange={e => patch({ license: e.target.value })} /></label>
    </>}
    {!valid && <ul className={styles.meta} aria-label="Offene Pflichtfelder">{validation.error.issues.map((e, i) => <li key={i}>{e.path.join('.')}: {e.message}</li>)}</ul>}
    <div className={styles.actions}>
      {!item && <button disabled={busy || !pool.canEdit} onClick={() => run(() => contentApi.create(pool.id, draft))}>Entwurf speichern</button>}
      {item && pool.canEdit && <><button disabled={busy || dirty || !valid || item.status === 'READY'} onClick={() => { if (window.confirm('Diese Frage für Spiele freigeben?')) void run(() => contentApi.status(item, 'READY')); }}>Für Spiele freigeben</button>
        <button disabled={busy || dirty || item.status === 'ARCHIVED'} onClick={() => { if (window.confirm('Frage archivieren? Bestehende Partien bleiben erhalten.')) void run(() => contentApi.status(item, 'ARCHIVED')); }}>Archivieren</button></>}
      {item && pool.canPropose && canWrite && <button disabled={busy || !valid || (pool.canEdit && dirty)} onClick={() => {
        if (window.confirm('Diesen Vorschlag zur Prüfung einreichen?')) void run(async () => (await contentApi.propose(item, draft)).item);
      }}>{pool.canEdit ? 'Zur Prüfung einreichen' : 'Änderung zur Prüfung einreichen'}</button>}
      {item && <button disabled={dirty || busy} onClick={() => contentApi.history(item.id).then(setHistory).catch(e => setError(errorMessage(e)))}>Versionsverlauf</button>}
    </div>
    {item && <fieldset><legend>Vorschau der gespeicherten Version</legend><label>Perspektive<select value={previewRole} onChange={e => { setPreviewRole(e.target.value); setPreview(null); }}>{['PLAYER', 'VIEWER', 'HOST', 'TEAM'].map(r => <option key={r}>{r}</option>)}</select></label>
      <label>Auflösung<select value={String(reveal)} onChange={e => { setReveal(e.target.value === 'true'); setPreview(null); }}><option value="false">Vor Auflösung</option><option value="true">Nach Auflösung</option></select></label>
      <button disabled={dirty || busy} onClick={() => contentApi.preview(item.id, previewRole, reveal).then(setPreview).catch(e => setError(errorMessage(e)))}>Vorschau laden</button>
      {preview && <div className={styles.preview}>{Object.entries(preview).map(([key, value]) => <p key={key}><strong>{{ prompt: 'Frage', question: 'Frage', category: 'Kategorie', answer: 'Lösung', correctOptionId: 'Richtige Antwort', explanation: 'Erklärung', options: 'Antwortmöglichkeiten', value: 'Punktwert' }[key] ?? key}:</strong> {Array.isArray(value) ? value.map(v => `${v.id}: ${v.text}`).join(' · ') : String(value)}</p>)}</div>}
    </fieldset>}
    {history.length > 0 && <section aria-label="Versionsverlauf"><h3>Versionen vergleichen</h3>{history.map(v => <details key={v.revision}><summary>Version {v.revision} · {v.kind} · {new Date(v.createdAt).toLocaleString()}</summary><pre className={styles.preview}>{JSON.stringify(v.snapshot, null, 2)}</pre>{pool.canEdit && item && <button disabled={dirty || busy} onClick={() => { if (window.confirm('Als neuen Entwurf übernehmen? Die Historie bleibt erhalten.')) void run(() => contentApi.restore(item, v.revision)); }}>Als neue Version wiederherstellen</button>}</details>)}</section>}
  </section>;
}

export function ContentPage() {
  const [pools, setPools] = useState<ContentPoolView[]>([]), [pool, setPool] = useState<ContentPoolView | null>(null), [items, setItems] = useState<ContentItemView[]>([]);
  const [selected, setSelected] = useState<ContentItemView | null>(null), [editing, setEditing] = useState(false), [editorKey, setEditorKey] = useState(0);
  const [slug, setSlug] = useState('wissensduell'), [name, setName] = useState(''), [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState('');
  const generation = useRef(0);
  const dirtyFlag = useRef(false);
  const maySwitch = () => !dirtyFlag.current || window.confirm('Ungespeicherte Änderungen verwerfen?');
  useEffect(() => { let current = true;
    Promise.all([contentApi.pools(), authApi.me()]).then(([data, me]) => {
      if (!me.success || !me.data?.user?.id) throw new Error('Anmeldung konnte nicht bestätigt werden. Bitte erneut anmelden.');
      if (current) { setPools(data); setUserId(me.data.user.id); setLoading(false); }
    }).catch(e => { if (current) { setError(errorMessage(e)); setLoading(false); } });
    return () => { current = false; };
  }, []);
  const load = async (id: string) => { if (!maySwitch()) return; const gen = ++generation.current; setError(''); try { const data = await contentApi.pool(id); if (gen !== generation.current) return; dirtyFlag.current = false; setPool(data.pool); setItems(data.items); setEditing(false); setSelected(null); } catch (e) { if (gen === generation.current) setError(errorMessage(e)); } };
  const open = (item: ContentItemView | null) => { if (!maySwitch()) return; setSelected(item); setEditing(true); setEditorKey(v => v + 1); };
  const onSaved = (item: ContentItemView) => { setSelected(item); setItems(rows => [item, ...rows.filter(r => r.id !== item.id)]); };
  return <div className={styles.page}>
    <header className={styles.heading}><div><h1>Fragen und Pools</h1><p>Inhalte vorbereiten, prüfen und für deine Spiele freigeben.</p></div><Link to="/kategorien">Spiel vorbereiten →</Link></header>
    {userId && <ContentReviewInbox onChanged={() => { if (pool) void load(pool.id); }} />}
    {error && <p className={styles.error} role="alert">{error} {!userId && <Link to="/moderator/anmelden?returnTo=%2Finhalte">Als Host anmelden</Link>}</p>}
    {loading ? <p role="status">Pools werden geladen …</p> : <div className={styles.layout}>
      <aside className={styles.panel}><h2>Deine Pools</h2><ul className={styles.list}>{pools.map(p => <li key={p.id}><button className={pool?.id === p.id ? styles.selected : ''} onClick={() => load(p.id)}>{p.name}<br /><small>{p.gameSlug} · {p.scope}</small></button></li>)}</ul>
        <form onSubmit={async e => { e.preventDefault(); try { const p = await contentApi.createPool(slug, name); setPools(rows => [p, ...rows]); setName(''); await load(p.id); } catch (err) { setError(errorMessage(err)); } }}>
          <h3>Neuer privater Pool</h3><label>Spiel<select aria-label="Spiel" value={slug} onChange={e => setSlug(e.target.value)}><option value="wissensduell">Wissensduell</option><option value="jeopardy">Jeopardy</option></select></label>
          <label>Poolname<input required maxLength={150} value={name} onChange={e => setName(e.target.value)} /></label><button disabled={!userId}>Pool erstellen</button>
        </form>
      </aside>
      <div>{pool ? <>
        <section className={styles.panel}><h2>{pool.name}</h2><p className={styles.meta}>{pool.gameSlug} · {pool.scope} · Version {pool.revision}</p>
          <div className={styles.actions}>{pool.canEdit && <button onClick={() => open(null)}>Neue Frage</button>}<button onClick={async () => { try { const p = await contentApi.fork(pool.id); setPools(rows => [p, ...rows]); await load(p.id); } catch (e) { setError(errorMessage(e)); } }}>Private Kopie erstellen</button></div>
          <label>Fragen durchsuchen<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <ul className={styles.list}>{items.filter(q => `${q.title} ${JSON.stringify(q.payload)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(q => <li key={q.id}><button onClick={() => open(q)}>{q.title || String(q.payload.prompt ?? q.payload.question ?? 'Unbenannter Entwurf')} · {q.status} · V{q.revision}</button></li>)}</ul>
          {!items.length && <p>Noch keine Fragen. Starte mit einer neuen Frage.</p>}
        </section>
        <ContentPoolSettings key={`${pool.id}:${pool.revision}`} pool={pool} onSaved={updated => { setPool(updated); setPools(rows => rows.map(p => p.id === updated.id ? updated : p)); void load(updated.id); }} />
        <ContentImportTools key={pool.id} pool={pool} onChanged={() => void load(pool.id)} />
        {editing && <ContentEditor key={`${pool.id}:${editorKey}`} initial={selected} pool={pool} onSaved={onSaved} dirtyFlag={dirtyFlag} actorId={userId} />}
      </> : <section className={styles.panel}><h2>Ein guter Spieleabend beginnt mit guten Fragen</h2><p>Erstelle einen Pool für Wissensduell oder Jeopardy. Neue Fragen bleiben Entwürfe, bis du sie ausdrücklich freigibst.</p></section>}</div>
    </div>}
  </div>;
}
