import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContentPoolView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';

export interface ContentSelectionOptions { language: string; difficulty: string; category: string; repeatRule: string; tagIds: string[]; poolCounts?: Record<string, number> }
export const DEFAULT_CONTENT_OPTIONS: ContentSelectionOptions = { language: 'de-DE', difficulty: '', category: '', repeatRule: 'NO_REPEAT_IN_ROOM', tagIds: [] };
export function contentSelectionPayload(poolIds: string[], count: number, options: ContentSelectionOptions) {
  return { poolIds, count: options.poolCounts ? Object.values(options.poolCounts).reduce((sum, n) => sum + n, 0) : count,
    ...options, difficulty: options.difficulty || undefined, category: options.category.trim() || undefined };
}

export function ContentPoolPicker({ gameSlug, selected, onChange, options, onOptionsChange }: { gameSlug: string; selected: string[]; onChange: (ids: string[]) => void;
  options?: ContentSelectionOptions; onOptionsChange?: (options: ContentSelectionOptions) => void }) {
  const [pools, setPools] = useState<ContentPoolView[]>([]), [error, setError] = useState('');
  const [tags, setTags] = useState<Awaited<ReturnType<typeof contentApi.tags>>>([]);
  useEffect(() => {
    let current = true;
    contentApi.pools(gameSlug).then(data => { if (current) { setPools(data); setError(''); } }, () => { if (current) setError('Pools konnten nicht geladen werden.'); });
    contentApi.tags().then(data => { if (current) setTags(data); }, () => undefined);
    return () => { current = false; };
  }, [gameSlug]);
  return <fieldset style={{ padding: '1rem', marginBlock: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
    <legend>Fragen aus deinen Pools</legend>
    {error && <p role="status">{error}</p>}
    {!error && !pools.length && <p>Noch keine Pools vorhanden.</p>}
    {pools.map(pool => <label key={pool.id} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minHeight: 44 }}>
      <input type="checkbox" checked={selected.includes(pool.id)} onChange={e => {
        const ids = e.target.checked ? [...selected, pool.id] : selected.filter(id => id !== pool.id); onChange(ids);
        if (options?.poolCounts && onOptionsChange) onOptionsChange({ ...options, poolCounts: Object.fromEntries(ids.map(id => [id, options.poolCounts?.[id] ?? 1])) });
      }} />{pool.name} · {pool.scope}
    </label>)}
    {!!selected.length && options && onOptionsChange && <>
      <label style={{ display: 'grid', gap: 4, marginBlock: 12 }}>Inhaltssprache<select value={options.language} onChange={e => onOptionsChange({ ...options, language: e.target.value })}>{['de-DE', 'en-US', 'tr-TR'].map(l => <option key={l}>{l}</option>)}</select></label>
      <label style={{ display: 'grid', gap: 4, marginBlock: 12 }}>Schwierigkeitsfilter<select value={options.difficulty} onChange={e => onOptionsChange({ ...options, difficulty: e.target.value })}><option value="">Alle Schwierigkeiten</option>{['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'].map(d => <option key={d}>{d}</option>)}</select></label>
      <label style={{ display: 'grid', gap: 4, marginBlock: 12 }}>Kategorie (optional)<input value={options.category} onChange={e => onOptionsChange({ ...options, category: e.target.value })} /></label>
      <label style={{ display: 'grid', gap: 4, marginBlock: 12 }}>Tag-Filter<select multiple value={options.tagIds} onChange={e => onOptionsChange({ ...options, tagIds: Array.from(e.target.selectedOptions, o => o.value) })}>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label style={{ display: 'grid', gap: 4, marginBlock: 12 }}>Wiederholungen<select value={options.repeatRule} onChange={e => onOptionsChange({ ...options, repeatRule: e.target.value })}><option value="NO_REPEAT_IN_ROOM">Keine Wiederholungen im Raum</option><option value="PREFER_UNSEEN">Neue Fragen bevorzugen</option><option value="ALLOW_REPEATS">Wiederholungen erlauben</option></select></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}><input type="checkbox" checked={!!options.poolCounts} onChange={e => onOptionsChange({ ...options, poolCounts: e.target.checked ? Object.fromEntries(selected.map(id => [id, 1])) : undefined })} />Feste Fragenzahl pro Pool</label>
      {options.poolCounts && selected.map(id => <label key={id} style={{ display: 'grid', gap: 4, marginBlock: 8 }}>{pools.find(p => p.id === id)?.name} · Anzahl<input type="number" min={0} max={100} value={options.poolCounts?.[id] ?? 0} onChange={e => onOptionsChange({ ...options, poolCounts: { ...options.poolCounts, [id]: Number(e.target.value) } })} /></label>)}
    </>}
    <p>{selected.length ? 'Nur freigegebene Inhalte werden zufällig ausgewählt und für die Partie fest gespeichert.' : 'Ohne Poolauswahl bleibt die bisherige Spielvorbereitung aktiv.'}</p>
    <Link to="/inhalte">Pools und Fragen bearbeiten →</Link>
  </fieldset>;
}
