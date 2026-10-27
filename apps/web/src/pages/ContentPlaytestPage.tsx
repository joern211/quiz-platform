import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Timer } from '@quiz/ui';
import type { ContentPlaytestView } from '@quiz/shared';
import { contentApi, ContentApiError } from '../lib/contentApi';
import { ContentMedia } from '../components/ContentMedia';
import styles from './ContentPage.module.css';

type Role = ContentPlaytestView['role'];
const roles: Array<{ id: Role; name: string }> = [{ id: 'PLAYER', name: 'Spieler' }, { id: 'VIEWER', name: 'Zuschauer' }, { id: 'TEAM', name: 'Team' }];
function clientIdentity(code: string) {
  const key = `qp_playtest_client:${code}`;
  try { const prior = localStorage.getItem(key); if (prior && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prior)) return prior;
    const id = crypto.randomUUID(); localStorage.setItem(key, id); return id;
  } catch { return crypto.randomUUID(); }
}
function message(e: unknown) {
  return e instanceof ContentApiError && ['PLAYTEST_NOT_ACCESSIBLE', 'NOT_AUTHORIZED'].includes(e.code)
    ? 'Der Playtest ist beendet, abgelaufen oder für diese Perspektive nicht verfügbar.'
    : e instanceof Error ? e.message : 'Playtest konnte nicht geladen werden.';
}
export function ContentPlaytestPage() {
  const { code = '' } = useParams(), [query] = useSearchParams();
  const [role, setRole] = useState<Role>(query.get('role') === 'HOST' ? 'HOST' : 'PLAYER'), [canControl, setCanControl] = useState(false);
  return <div className={styles.page}><section className={styles.panel} aria-label="Playtest">
    <h1>Playtest</h1><p>Temporärer Fragentest · keine echten Punkte oder Statistiken</p>
    <label>Perspektive<select value={role} onChange={e => setRole(e.target.value as Role)}>
      {(canControl || role === 'HOST' ? [{ id: 'HOST', name: 'Host' }, ...roles] : roles).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select></label>
    <PlaytestSession key={`${code}:${role}`} code={code} role={role} onControl={setCanControl} />
    <Link to="/inhalte">Zum Frageneditor</Link>
  </section></div>;
}
function PlaytestSession({ code, role, onControl }: { code: string; role: Role; onControl: (value: boolean) => void }) {
  const [clientKey] = useState(() => clientIdentity(code)), [view, setView] = useState<ContentPlaytestView | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true), request = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    try { const data = await contentApi.playtest(code, role, clientKey); if (alive.current && sequence === request.current) { setView(data); setError(''); onControl(data.canControl); } }
    catch (e) { if (alive.current && sequence === request.current) { setView(null); setError(message(e)); onControl(false); } }
  }, [code, role, clientKey, onControl]);
  useEffect(() => { alive.current = true; let pending = false;
    const poll = async () => { if (pending) return; pending = true; try { await refresh(); } finally { pending = false; } };
    void poll(); const timer = setInterval(() => void poll(), 2000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);
  const run = async (work: () => Promise<unknown>, success: string) => {
    if (busy) return false; setBusy(true); setError('');
    try { await work(); if (alive.current) { setNotice(success); await refresh(); } return true; }
    catch (e) { if (alive.current) setError(message(e)); return false; }
    finally { if (alive.current) setBusy(false); }
  };
  return <>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {!view && !error && <p role="status">Playtest wird geladen …</p>}
    {view && <><p>Frage {view.position + 1} von {view.total} · {{ QUESTION: 'Frage offen', REVEAL: 'Auflösung', CLOSED: 'Beendet' }[view.phase]}</p>
      {view.phase === 'CLOSED' ? <p>Dieser Playtest ist beendet.</p> : <PlaytestQuestion key={view.position} view={view} busy={busy} refresh={refresh}
        submit={(kind, value) => run(() => contentApi.playtestFeedback(code, { clientKey, version: view.version, role, kind, value }), kind === 'REPORT' ? 'Hinweis gespeichert.' : 'Testantwort gespeichert.')} />}
      {view.canControl && role === 'HOST' && view.phase !== 'CLOSED' && <div className={styles.actions}>
        <button disabled={busy || view.phase !== 'QUESTION'} onClick={() => void run(() => contentApi.controlPlaytest(code, view.version, 'REVEAL'), 'Auflösung geöffnet.')}>Auflösen</button>
        <button disabled={busy || view.position + 1 >= view.total} onClick={() => void run(() => contentApi.controlPlaytest(code, view.version, 'NEXT'), 'Nächste Testfrage.')}>Nächste Frage</button>
        <button disabled={busy} onClick={() => void run(() => contentApi.controlPlaytest(code, view.version, 'CLOSE'), 'Playtest beendet.')}>Playtest beenden</button>
      </div>}
      {view.canControl && role === 'HOST' && <section aria-label="Gesammelte Playtest-Hinweise"><h2>Gesammelte Hinweise</h2>
        {view.reports.length ? <ul>{view.reports.map((r, i) => <li key={i}>Frage {r.position + 1}: {r.message}</li>)}</ul> : <p>Noch keine Hinweise.</p>}
      </section>}
    </>}
  </>;
}
function PlaytestQuestion({ view, busy, refresh, submit }: { view: ContentPlaytestView; busy: boolean; refresh: () => Promise<void>; submit: (kind: 'ANSWER' | 'REPORT', value: string) => Promise<boolean> }) {
  const [answer, setAnswer] = useState(''), [report, setReport] = useState(''), [expired, setExpired] = useState(false);
  const q = view.question ?? {}, options = Array.isArray(q.options) ? q.options as Array<{ id: string; text: string }> : [];
  const answerClosed = busy || view.phase !== 'QUESTION' || view.ownAnswer !== null || expired || view.endsAt !== null && view.endsAt <= Date.now();
  return <section aria-label="Testfrage"><h2>{String(q.prompt ?? q.question ?? 'Unvollständiger Entwurf')}</h2>
    <p>{String(q.category ?? '')}</p>
    {view.warnings.length > 0 && <div role="status"><h3>Prüfhinweise zum Entwurf</h3><ul>{view.warnings.map((w, i) => <li key={i}>{w.path}: {w.message}</li>)}</ul></div>}
    <ContentMedia mediaUrl={typeof q.mediaUrl === 'string' ? q.mediaUrl : undefined} mediaType={typeof q.mediaType === 'string' ? q.mediaType : undefined} onRefresh={() => void refresh()} />
    {view.endsAt !== null && view.phase === 'QUESTION' && <Timer key={view.position} endsAt={view.endsAt} onExpire={() => setExpired(true)} />}
    {options.length > 0 && <ul className={styles.list}>{options.map((o, i) => <li key={`${o.id}:${i}`}>
      {view.role === 'PLAYER' ? <label className={styles.check}><input type="radio" name="test-answer" value={o.id} disabled={answerClosed} checked={(view.ownAnswer ?? answer) === o.id} onChange={() => setAnswer(o.id)} />{o.text}</label> : <span>{o.text}</span>}
    </li>)}</ul>}
    {view.role === 'PLAYER' && <form onSubmit={e => { e.preventDefault(); void submit('ANSWER', answer); }}>
      {view.gameSlug === 'jeopardy' && <label>Testantwort<textarea disabled={answerClosed} value={view.ownAnswer ?? answer} maxLength={10000} onChange={e => setAnswer(e.target.value)} /></label>}
      <button disabled={answerClosed || !answer.trim()}>Testantwort abgeben</button>
      {view.ownAnswer !== null && <p>Deine Testantwort: {view.ownAnswer}</p>}
    </form>}
    {(typeof q.answer === 'string' || typeof q.correctOptionId === 'string') && <div aria-label="Lösung"><h3>Lösung</h3><p>{typeof q.answer === 'string' ? q.answer : options.find(o => o.id === q.correctOptionId)?.text ?? String(q.correctOptionId)}</p><p>{typeof q.explanation === 'string' ? q.explanation : ''}</p></div>}
    {(view.role === 'PLAYER' || view.role === 'HOST' && view.canControl) && <form onSubmit={e => { e.preventDefault(); void submit('REPORT', report).then(accepted => { if (accepted) setReport(''); }); }}>
      <label>Fehler oder Warnung melden<textarea maxLength={2000} disabled={busy || view.ownReport} value={report} onChange={e => setReport(e.target.value)} /></label>
      <button disabled={busy || view.ownReport || !report.trim()}>Hinweis speichern</button>
      {view.ownReport && <p>Dein Hinweis zu dieser Frage ist gespeichert.</p>}
    </form>}
  </section>;
}
