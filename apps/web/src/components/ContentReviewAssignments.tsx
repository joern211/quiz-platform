import { useState } from 'react';
import type { ContentItemView, ContentPoolView } from '@quiz/shared';
import { contentApi, type ContentAssignmentView } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';

export function ContentReviewAssignments({ item, pool, actorId }: { item?: ContentItemView; pool?: ContentPoolView; actorId: string }) {
  const [tasks, setTasks] = useState<ContentAssignmentView[] | null>(null), [editors, setEditors] = useState<Array<{ id: string; displayName: string }>>([]);
  const [assignee, setAssignee] = useState(actorId), [note, setNote] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const canAssign = !!item && !!(pool?.canAssignReview ?? pool?.canPropose);
  const load = async () => {
    setTasks(await contentApi.assignments(item?.id));
    if (pool?.canAssignReview ?? pool?.canManage) setEditors(await contentApi.poolEditors(pool.id));
  };
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Prüfaufgaben konnten nicht geladen werden.'); } finally { setBusy(false); } };
  return <details className={styles.panel}><summary>{item ? 'Prüfaufgabe zu dieser Frage' : 'Meine Prüfaufgaben'}</summary>
    <p>Eine abgeschlossene Prüfaufgabe gibt Inhalte nicht automatisch für Spiele oder öffentlich frei.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button disabled={busy} onClick={() => void run(load)}>Prüfaufgaben laden</button>
    {tasks && <>{!tasks.length && <p>Keine Prüfaufgaben vorhanden.</p>}<ul className={styles.list}>{tasks.map(t => <li key={t.id}><h3>{t.itemTitle || 'Unbenannte Frage'}</h3><p>{t.poolName} · Version {t.itemRevision} · {{ OPEN: 'Offen', IN_REVIEW: 'In Prüfung', DONE: 'Erledigt' }[t.status] ?? t.status}</p><p>{t.note}</p>
      {t.stale && <p>Die Frage wurde inzwischen geändert oder verschoben. Der Eigentümer muss die Aufgabe ausdrücklich auf die aktuelle Version neu zuweisen.</p>}
      {t.canAdvance && t.status !== 'DONE' && <button disabled={busy || t.stale} onClick={() => void run(async () => {
        if (t.status === 'IN_REVIEW' && !window.confirm('Die Prüfung dieser angezeigten Version als erledigt markieren? Der Inhalt wird nicht automatisch freigegeben.')) return;
        await contentApi.advanceAssignment(t, t.status === 'OPEN' ? 'IN_REVIEW' : 'DONE'); await load();
      })}>{t.status === 'OPEN' ? 'Prüfung beginnen' : 'Prüfung abschließen'}</button>}
    </li>)}</ul>
    {canAssign && <><h3>Prüfung zuweisen</h3><label>Prüfende Person<select disabled={busy} value={assignee} onChange={e => setAssignee(e.target.value)}><option value={actorId}>Ich selbst</option>{editors.filter(u => u.id !== actorId).map(u => <option key={u.id} value={u.id}>{u.displayName}</option>)}</select></label>
      <label>Prüfauftrag<textarea maxLength={2000} disabled={busy} value={note} onChange={e => setNote(e.target.value)} /></label>
      <button disabled={busy} onClick={() => void run(async () => { const old = tasks.find(t => t.itemId === item!.id && t.assigneeId === assignee);
        if (old && !window.confirm('Die bestehende Aufgabe auf die aktuelle Fragenversion neu öffnen?')) return;
        await contentApi.assignReview(item!, assignee, note, old?.revision ?? null); setNote(''); await load();
      })}>Prüfaufgabe zuweisen</button></>}
    </>}
  </details>;
}
