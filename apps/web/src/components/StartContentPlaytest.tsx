import { useState } from 'react';
import type { ContentItemView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';

export function StartContentPlaytest({ item, disabled }: { item: ContentItemView; disabled: boolean }) {
  const [test, setTest] = useState<{ code: string; expiresAt: string } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const path = test ? `/inhalte/playtest/${encodeURIComponent(test.code)}` : '';
  return <fieldset><legend>Playtest</legend>
    <p>Teste die gespeicherte Version, auch als Entwurf. Der Test läuft eine Stunde ohne echte Punkte oder Statistiken. Ein geteilter Testlink gibt diese Fragen für die Testdauer frei.</p>
    <button disabled={disabled || busy || item.status === 'TRASHED'} onClick={async () => {
      setBusy(true); setError(''); try { setTest(await contentApi.startPlaytest(item.poolId, [{ id: item.id, revision: item.revision }])); }
      catch (e) { setError(e instanceof Error ? e.message : 'Playtest konnte nicht gestartet werden.'); } finally { setBusy(false); }
    }}>Playtest starten</button>
    {error && <p role="alert">{error}</p>}
    {test && <div className={`${styles.actions} ${styles.playtestLinks}`}><a href={`${path}?role=HOST`} target="_blank" rel="noreferrer">Playtest als Host öffnen</a>
      <label>Testlink für andere Geräte<input readOnly value={`${window.location.origin}${path}`} onFocus={e => e.currentTarget.select()} /></label>
      <p>Gültig bis {new Date(test.expiresAt).toLocaleString()}. Der Host kann den Test vorher beenden.</p></div>}
  </fieldset>;
}
