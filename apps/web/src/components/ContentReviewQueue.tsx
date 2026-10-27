import { useEffect, useRef, useState } from 'react';
import { contentApi, type ReviewView } from '../lib/contentApi';
import styles from '../pages/ContentPage.module.css';

export function ContentReviewQueue({ reviews, actorId, onChanged }: { reviews: ReviewView[]; actorId: string; onChanged: () => Promise<unknown> }) {
  const key = `qp_review_cursor:${actorId}`, [cursor, setCursor] = useState(() => localStorage.getItem(key) ?? '');
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const writing = useRef(false), review = reviews.find(r => r.id === cursor) ?? reviews[0];
  const reviewId = review?.id;
  useEffect(() => { if (reviewId) { localStorage.setItem(key, reviewId); setReason(''); setError(''); } }, [reviewId, key]);
  const next = () => { if (!review || busy) return; const index = reviews.findIndex(r => r.id === review.id); setCursor(reviews[(index + 1) % reviews.length]?.id ?? ''); setReason(''); setError(''); };
  const decide = async (approve: boolean) => {
    if (!review?.canDecide || writing.current) return;
    if (!approve && !reason.trim()) { setError('Bitte einen Ablehnungsgrund angeben.'); return; }
    if (!window.confirm(approve ? 'Die angezeigte Prüfung verbindlich freigeben?' : 'Für diese Prüfung Änderungen anfordern?')) return;
    writing.current = true; setBusy(true); setError('');
    try { await contentApi.decide(review.id, approve, reason); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Prüfung konnte nicht gespeichert werden.'); }
    finally { writing.current = false; setBusy(false); }
  };
  return <section aria-label="Einzelprüfung der Warteschlange" tabIndex={0} onKeyDown={e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable)) return;
    const action = e.key.toLocaleLowerCase(); if (!['a', 'r', 's', 'n'].includes(action)) return; e.preventDefault();
    if (action === 'a') void decide(true); else if (action === 'r') void decide(false); else next();
  }}>
    <h3>Einzeln prüfen · {reviews.length} offen</h3><p>A: freigeben · R: Änderungen anfordern · S / N: überspringen. Die angefangene Prüfung wird für dein Konto gemerkt.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {review ? <><h4>{review.poolName}</h4><p>{review.kind}</p>
      <h4>Gespeicherte Fassung</h4><pre className={styles.preview}>{JSON.stringify(review.current ?? [], null, 2)}</pre>
      <h4>Vorschlag</h4><pre className={styles.preview}>{JSON.stringify(review.proposed, null, 2)}</pre>
      <label>Begründung für die Einzelprüfung<textarea value={reason} maxLength={2000} disabled={busy} onChange={e => setReason(e.target.value)} /></label>
      <div className={styles.actions}><button disabled={busy || !review.canDecide} onClick={() => void decide(true)}>Angezeigte Prüfung freigeben</button>
        <button disabled={busy || !review.canDecide || !reason.trim()} onClick={() => void decide(false)}>Änderungen für diese Prüfung anfordern</button>
        <button disabled={busy} onClick={next}>Überspringen und nächste prüfen</button></div>
      {!review.canDecide && <p>Diese Prüfung darfst du ansehen; die abschließende Entscheidung liegt beim berechtigten Eigentümer oder Admin.</p>}
    </> : <p>Keine offenen Prüfungen.</p>}
  </section>;
}
