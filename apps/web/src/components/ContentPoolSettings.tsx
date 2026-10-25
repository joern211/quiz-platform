import { useState } from 'react';
import type { ContentPoolView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';

export function ContentPoolSettings({ pool, onSaved }: { pool: ContentPoolView; onSaved: (pool: ContentPoolView) => void }) {
  const [name, setName] = useState(pool.name), [description, setDescription] = useState(pool.description), [scope, setScope] = useState(pool.scope);
  const [language, setLanguage] = useState(pool.defaults.language), [difficulty, setDifficulty] = useState<string>(pool.defaults.difficulty ?? '');
  const [editorIds, setEditorIds] = useState(pool.editorIds ?? []), [query, setQuery] = useState(''), [found, setFound] = useState<Array<{ id: string; displayName: string }>>([]);
  const [tags, setTags] = useState<Awaited<ReturnType<typeof contentApi.tags>>>([]), [tagIds, setTagIds] = useState(pool.defaults.tagIds);
  const [tagName, setTagName] = useState(''), [tagSlug, setTagSlug] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  if (!pool.canManage || !['PRIVATE', 'SHARED'].includes(pool.scope)) return null;
  return <details className={styles.panel} onToggle={e => { if (e.currentTarget.open) Promise.all([contentApi.tags(), contentApi.poolEditors(pool.id)])
    .then(([t, editors]) => { setTags(t); setFound(editors); }).catch(() => setError('Tags oder Mitbearbeiter konnten nicht geladen werden.')); }}>
    <summary>Pool-Einstellungen und Zusammenarbeit</summary>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <label>Poolname ändern<input value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Beschreibung<textarea value={description} onChange={e => setDescription(e.target.value)} /></label>
    <label>Standardsprache<select value={language} onChange={e => setLanguage(e.target.value as typeof language)}>{['de-DE', 'en-US', 'tr-TR'].map(l => <option key={l}>{l}</option>)}</select></label>
    <label>Standard-Schwierigkeit<select value={difficulty} onChange={e => setDifficulty(e.target.value)}><option value="">Nicht gesetzt</option>{['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'].map(d => <option key={d}>{d}</option>)}</select></label>
    <label>Standard-Tags<select multiple value={tagIds} onChange={e => setTagIds(Array.from(e.target.selectedOptions, o => o.value))}>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    <p>Fragen übernehmen diese Standards, solange du dort keinen eigenen Wert setzt. Bereits vorbereitete Partien bleiben unverändert.</p>
    <fieldset><legend>Neuen Tag anlegen</legend><label>Tagname<input value={tagName} onChange={e => { setTagName(e.target.value); setTagSlug(e.target.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }} /></label>
      <label>Tag-Schlüssel<input value={tagSlug} onChange={e => setTagSlug(e.target.value)} /></label><button disabled={busy || !tagName || !tagSlug} onClick={async () => { setBusy(true); try { const tag = await contentApi.createTag(tagName, tagSlug); setTags(rows => [...rows.filter(t => t.id !== tag.id), tag]); setTagIds(ids => [...new Set([...ids, tag.id])]); setTagName(''); setTagSlug(''); } catch (e) { setError(e instanceof Error ? e.message : 'Tag konnte nicht erstellt werden.'); } finally { setBusy(false); } }}>Tag erstellen</button>
    </fieldset>
    <label>Zugriff<select value={scope} onChange={e => setScope(e.target.value)}><option value="PRIVATE">Nur ich</option><option value="SHARED">Ausgewählte Mitbearbeiter</option></select></label>
    {scope === 'SHARED' && <fieldset><legend>Mitbearbeiter</legend><p>Mitbearbeiter können Fragen lesen und bearbeiten. Pool-Zugriffe verwaltet weiterhin der Eigentümer.</p>
      <label>Host suchen<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name oder genaue E-Mail" /></label>
      <button disabled={query.trim().length < 3 || busy} onClick={async () => { try { setFound(await contentApi.findEditors(query)); } catch (e) { setError(e instanceof Error ? e.message : 'Suche fehlgeschlagen.'); } }}>Hosts suchen</button>
      {found.map(user => <label key={user.id}><span><input type="checkbox" checked={editorIds.includes(user.id)} onChange={e => setEditorIds(ids => e.target.checked ? [...ids, user.id] : ids.filter(id => id !== user.id))} /> {user.displayName}</span></label>)}
      <p>{editorIds.length} Mitbearbeiter ausgewählt.</p><button onClick={() => setEditorIds([])}>Alle Mitbearbeiter entfernen</button>
    </fieldset>}
    <div className={styles.actions}><button disabled={busy || !name.trim()} onClick={async () => {
      if (!window.confirm('Pool-Standards und Zugriffe speichern?')) return; setBusy(true); setError('');
      try { onSaved(await contentApi.updatePool(pool, { name, description, scope, editorIds: scope === 'SHARED' ? editorIds : [], defaults: { language, difficulty: difficulty || null, tagIds } })); }
      catch (e) { setError(e instanceof Error ? e.message : 'Einstellungen konnten nicht gespeichert werden.'); } finally { setBusy(false); }
    }}>Pool-Einstellungen speichern</button></div>
  </details>;
}
