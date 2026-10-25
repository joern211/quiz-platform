import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContentPoolView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';

export function ContentPoolPicker({ gameSlug, selected, onChange }: { gameSlug: string; selected: string[]; onChange: (ids: string[]) => void }) {
  const [pools, setPools] = useState<ContentPoolView[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    contentApi.pools(gameSlug).then(data => { if (current) { setPools(data); setError(''); } }, () => { if (current) setError('Pools konnten nicht geladen werden.'); });
    return () => { current = false; };
  }, [gameSlug]);
  return <fieldset style={{ padding: '1rem', marginBlock: '1rem', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
    <legend>Fragen aus deinen Pools</legend>
    {error && <p role="status">{error}</p>}
    {!error && !pools.length && <p>Noch keine Pools vorhanden.</p>}
    {pools.map(pool => <label key={pool.id} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', minHeight: 44 }}>
      <input type="checkbox" checked={selected.includes(pool.id)} onChange={e => onChange(e.target.checked ? [...selected, pool.id] : selected.filter(id => id !== pool.id))} />{pool.name} · {pool.scope}
    </label>)}
    <p>{selected.length ? 'Nur freigegebene Inhalte werden zufällig ausgewählt und für die Partie fest gespeichert.' : 'Ohne Poolauswahl bleibt die bisherige Spielvorbereitung aktiv.'}</p>
    <Link to="/inhalte">Pools und Fragen bearbeiten →</Link>
  </fieldset>;
}
