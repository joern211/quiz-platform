import { useState } from 'react';
import type { ContentPoolView, ContentItemView, ContentTemplateView } from '@quiz/shared';
import { contentApi } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';
const message = (e: unknown) => e instanceof Error ? e.message : 'Vorlage konnte nicht verarbeitet werden.';

export function ContentTemplates({ pool, mayChange, onCreated }: { pool: ContentPoolView; mayChange: () => boolean; onCreated: (item: ContentItemView) => void }) {
  const [rows, setRows] = useState<ContentTemplateView[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = async () => { setRows(await contentApi.templates(pool.gameSlug)); };
  return <details className={styles.panel}><summary>Fragenvorlagen</summary><p>Systemvorlagen und deine privaten Vorlagen erzeugen immer eine neue Frage als Entwurf.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>Vorlagen laden</button>
    {rows && <ul className={styles.list}>{rows.map(t => <li key={t.id}><strong>{t.name}</strong> · {t.scope === 'SYSTEM' ? 'Systemvorlage' : 'Privat'}
      <div className={styles.actions}><button disabled={busy || !pool.canEdit} onClick={async () => { if (!mayChange()) return; setBusy(true); setError(''); try { onCreated(await contentApi.useTemplate(t, pool)); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>Neuen Entwurf aus „{t.name}“ erstellen</button>
      {t.scope === 'PRIVATE' && <button disabled={busy} onClick={async () => { if (!window.confirm('Diese Vorlage archivieren? Bereits erstellte Fragen bleiben erhalten.')) return; setBusy(true); try { await contentApi.archiveTemplate(t); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>Vorlage archivieren</button>}</div>
    </li>)}</ul>}
  </details>;
}
export function SaveContentTemplate({ gameSlug, item, disabled }: { gameSlug: string; item: unknown; disabled: boolean }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  return <details><summary>Als private Vorlage speichern</summary><p>Text, Tags, Schwierigkeit, Zeit und Medienoptionen übernehmen. Eine konkrete Bild- oder Audiodatei wird nur nach deiner Bestätigung ausgelassen.</p>
    <label>Vorlagenname<input maxLength={150} value={name} disabled={busy || disabled} onChange={e => setName(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}{notice && <p>{notice}</p>}
    <button disabled={disabled || busy || !name.trim()} onClick={async () => { setBusy(true); setError(''); setNotice('');
      try {
        const recipe = structuredClone(item) as { payload?: Record<string, unknown> };
        if (recipe.payload?.mediaAssetId !== undefined) {
          if (!window.confirm('Die Vorlage ohne die konkrete Mediendatei speichern? Quelle und Medienoptionen bleiben als Vorgaben erhalten.')) return;
          delete recipe.payload.mediaAssetId;
        }
        await contentApi.saveTemplate(gameSlug, name, recipe); setNotice('Private Vorlage gespeichert. Neue Fragen daraus bleiben Entwürfe.'); setName('');
      } catch (e) { setError(message(e)); } finally { setBusy(false); }
    }}>Vorlage speichern</button>
  </details>;
}
