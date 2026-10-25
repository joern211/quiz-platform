import { useEffect, useRef, useState } from 'react';
import type { ContentItemView, ContentPoolView } from '@quiz/shared';
import { contentApi, type CommentView } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';

export function ContentCollaboration({ item, pool, actorId, dirty, onSaved }: { item: ContentItemView; pool: ContentPoolView; actorId?: string; dirty: boolean; onSaved: (item: ContentItemView) => void }) {
  const key = useRef(crypto.randomUUID()), [others, setOthers] = useState<Array<{ id: string; displayName: string }>>([]);
  const [presenceError, setPresenceError] = useState(''), [comments, setComments] = useState<CommentView[] | null>(null), [text, setText] = useState('');
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof contentApi.usage>> | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const internal = pool.canEdit || pool.canPropose;
  useEffect(() => {
    if (!actorId || !internal) return;
    let current = true, pending = false;
    const editorKey = key.current;
    const heartbeat = async () => { if (pending) return; pending = true;
      try { const data = await contentApi.presence(item.id, editorKey, true); if (current) { setOthers(data); setPresenceError(''); } }
      catch { if (current) setPresenceError('Weitere Bearbeiter können gerade nicht angezeigt werden. Versionsschutz bleibt aktiv.'); }
      finally { pending = false; }
    };
    void heartbeat(); const timer = setInterval(() => void heartbeat(), 15000);
    return () => { current = false; clearInterval(timer); void contentApi.presence(item.id, editorKey, false).catch(() => {}); };
  }, [item.id, actorId, internal]);
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Aktion fehlgeschlagen.'); } finally { setBusy(false); } };
  if (!internal) return null;
  return <section aria-label="Zusammenarbeit und Verwendung">
    {!!others.length && <p>Gerade ebenfalls geöffnet: {others.map(u => u.displayName).join(', ')}. Änderungen bleiben durch Versionsprüfung geschützt.</p>}
    {presenceError && <p>{presenceError}</p>}
    <details><summary>Zusammenarbeit und Verwendung</summary>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <p>Bearbeitung: {item.lockState === 'EDITABLE' ? 'Freigegeben' : item.lockState === 'LOCKED_MANUAL' ? 'Manuell gesperrt' : 'Während Prüfung gesperrt'}</p>
      {pool.canManage && ['EDITABLE', 'LOCKED_MANUAL'].includes(item.lockState) && <button disabled={busy || dirty} onClick={() => {
        const locked = item.lockState === 'EDITABLE'; if (window.confirm(locked ? 'Bearbeitung sperren? Die Frage bleibt weiterhin für Spiele nutzbar.' : 'Manuelle Bearbeitungssperre aufheben?')) void run(async () => onSaved(await contentApi.lock(item, locked)));
      }}>{item.lockState === 'EDITABLE' ? 'Bearbeitung sperren' : 'Bearbeitung entsperren'}</button>}
      <h3>Interne Prüfkommentare</h3>
      <button disabled={busy} onClick={() => void run(async () => setComments(await contentApi.comments(item.id)))}>Kommentare laden</button>
      {comments && <><p>{comments.filter(c => c.status === 'OPEN').length} offene Kommentare</p><ul className={styles.list}>{comments.map(c => <li key={c.id}><p>{c.message}</p><small>{c.status} · {new Date(c.createdAt).toLocaleString()}</small>
        {(pool.canManage || c.actorId === actorId) && <div className={styles.actions}>{['OPEN', 'RESOLVED', 'REJECTED'].filter(s => s !== c.status).map(status => <button key={status} disabled={busy} onClick={() => void run(async () => { await contentApi.resolveComment(c.id, status); setComments(await contentApi.comments(item.id)); })}>{{ OPEN: 'Wieder öffnen', RESOLVED: 'Erledigt', REJECTED: 'Ablehnen' }[status]}</button>)}</div>}
      </li>)}</ul></>}
      <label>Neuer interner Kommentar<textarea disabled={busy} maxLength={2000} value={text} onChange={e => setText(e.target.value)} /></label>
      <button disabled={busy || !text.trim()} onClick={() => void run(async () => { await contentApi.comment(item.id, text); setText(''); setComments(await contentApi.comments(item.id)); })}>Kommentar senden</button>
      <h3>Verwendungsnachweise</h3><button disabled={busy} onClick={() => void run(async () => setUsage(await contentApi.usage(item.id)))}>Verwendung laden</button>
      {usage && <><p>{usage.total} gespeicherte Spielverwendungen. Änderungen überschreiben keine dieser Fassungen.</p><ul>{usage.uses.map((u, i) => <li key={i}>{u.room?.roomName ?? 'Archivierte Partie'} · {u.room?.status ?? 'Archiv'} · Partie {u.runIndex + 1} · Version {u.itemRevision} · {new Date(u.createdAt).toLocaleString()}</li>)}</ul></>}
    </details>
  </section>;
}
