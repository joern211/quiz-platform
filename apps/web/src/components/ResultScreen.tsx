import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PublicResultViewSchema, type PublicResultView, type ResultOperation, type RoomCoreView } from '@quiz/shared';
import { Card, Button } from '@quiz/ui';
import { connectSocket, emitCommand, getSocket, type PlayerRole } from '../lib/socket';
import { getSession } from '../lib/sessionStore';
import styles from '../pages/ModeratorResultPage.module.css';

export function ResultScreen({ roomCode, role }: { roomCode: string; role: PlayerRole }) {
  const navigate = useNavigate();
  const [result, setResult] = useState<PublicResultView | null>(null), [room, setRoom] = useState<RoomCoreView | null>(null);
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [loading, setLoading] = useState(true);
  const [participantId, setParticipantId] = useState(''), [delta, setDelta] = useState(''), [reason, setReason] = useState('');
  const [runIndex, setRunIndex] = useState<number | null>(null), [revision, setRevision] = useState<number | null>(null);
  const busy = useRef(false), request = useRef(0), alive = useRef(true);
  const refresh = useCallback(async () => {
    const current = ++request.current, session = getSession();
    try {
      const query = new URLSearchParams(); if (runIndex) query.set('runIndex', String(runIndex)); if (revision) query.set('revision', String(revision));
      const response = await fetch(`/api/v1/rooms/${roomCode}/results?${query}`, { credentials: 'include',
        headers: session.roomCode === roomCode && session.rejoinToken ? { 'X-Rejoin-Token': session.rejoinToken } : {} });
      let data = await response.json();
      if (response.status === 403 && getSocket().connected) data = await new Promise(resolve => {
        getSocket().timeout(8000).emit('game:result:read', { roomCode, ...(runIndex ? { runIndex } : {}), ...(revision ? { revision } : {}) }, (error, value) => resolve(error ? { success: false, error: { message: 'Ergebniszugriff nicht bestätigt.' } } : value));
      });
      if (!alive.current || current !== request.current) return;
      const parsed = PublicResultViewSchema.safeParse(data.data);
      if (!data.success || !parsed.success) { setResult(null); setError(data.error?.message ?? 'Ergebnis konnte nicht geladen werden.'); }
      else { setResult(parsed.data); setError(''); }
    } catch { if (alive.current && current === request.current) setError('Verbindungsfehler. Bitte erneut laden.'); }
    finally { if (alive.current && current === request.current) setLoading(false); }
  }, [roomCode, runIndex, revision]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => { alive.current = true; setResult(null); setLoading(true); void refresh(); return () => { alive.current = false; ++request.current; }; }, [refresh]);
  useEffect(() => {
    const socket = getSocket(); let disposed = false;
    const readRoom = () => socket.emit('room:core:read', {}, response => { if (!disposed) setRoom(response.success ? response.view ?? null : null); });
    const subscribe = () => {
      const session = getSession();
      socket.emit('room:subscribe', { roomCode, rejoinToken: session.roomCode === roomCode ? session.rejoinToken ?? undefined : undefined,
        ...(role === 'VIEWER' ? { role: 'VIEWER' as const, pin: sessionStorage.getItem(`qp_viewerPin:${roomCode}`) ?? undefined } : {}) }, response => { if (!disposed && response.success) { readRoom(); void refreshRef.current(); } });
    };
    const disconnected = () => setRoom(null);
    const lobby = (data: { roomCode: string }) => { if (data.roomCode === roomCode) navigate(role === 'HOST' ? `/moderator/raum/${roomCode}/lobby` : role === 'PLAYER' ? `/raum/${roomCode}/lobby` : `/zuschauen/${roomCode}/lobby`); };
    socket.on('connect', subscribe); socket.on('room:core:changed', readRoom); socket.on('disconnect', disconnected); socket.on('room:lobby', lobby);
    if (socket.connected) subscribe(); else connectSocket();
    return () => { disposed = true; socket.off('connect', subscribe); socket.off('room:core:changed', readRoom); socket.off('disconnect', disconnected); socket.off('room:lobby', lobby); };
  }, [roomCode, role, navigate]);
  useEffect(() => { const s = getSocket(), changed = () => { void refresh(); }; s.on('game:result:changed', changed); s.on('connect', changed); return () => { s.off('game:result:changed', changed); s.off('connect', changed); }; }, [refresh]);
  const canManage = !loading && room?.permissions.includes('SCORE_ADJUST') && !!result?.resultStatus && !revision;
  const execute = (operation: ResultOperation) => {
    if (busy.current || !result?.resultRevision) return;
    busy.current = true; setPending(true); setError('');
    emitCommand(getSocket(), 'game:result:command', { roomCode, runIndex: result.runIndex, resultRevision: result.resultRevision, operation },
      `${roomCode}:result:${result.runIndex}:${result.resultRevision}:${JSON.stringify(operation)}`, response => {
        busy.current = false; if (!alive.current) return; setPending(false);
        if (response.success) { setReason(''); setDelta(''); void refresh(); }
        else setError('Aktion nicht bestätigt. Lade den aktuellen Stand und prüfe deine Berechtigung; bei Verbindungsabbruch kannst du dieselbe Aktion erneut senden.');
      });
  };
  if (loading && !result) return <p>Lädt …</p>;
  return <div className={styles.page}>
    <h1 className={styles.title}>Ergebnis</h1><p>{result?.game.name ?? 'Spiel'} · Raum {roomCode}{result && ` · Partie ${result.runIndex}`}</p>
    {error && <div role="alert"><p>{error}</p><Button onClick={() => void refresh()}>Erneut laden</Button></div>}
    {result && <>
      <p role="status">{revision ? `Historische Version ${revision}` : result.resultStatus === 'FINALIZED' ? 'Verbindlich bestätigt' : result.resultStatus === 'RESULT_REVIEW' ? 'In Ergebnisprüfung' : result.resultStatus === 'GAME_END' ? 'Spiel beendet · noch nicht bestätigt' : 'Historisches Ergebnis ohne Finalisierungsnachweis'}</p>
      {result.aborted && <p>Abgebrochene Partie · kein reguläres Siegergebnis.</p>}
      {result.requiresReview && <p role="alert">Punkteprotokoll und Spielzustand müssen vor einer Bestätigung geprüft werden.</p>}
      {result.scoring === 'TEAM_SCORE' && <Card padding="lg"><h2>Teamwertung</h2><ol>{result.teams.map(t => <li key={t.id} value={t.rank}>{t.name}: {t.score} Punkte</li>)}</ol></Card>}
      <Card padding="lg"><h2>{result.scoring === 'TEAM_SCORE' ? 'Persönliche Beiträge' : 'Rangliste'}</h2>
        <ol>{result.scores.map(p => <li key={p.participationId} value={p.rank}>{p.displayName}: {p.score} Punkte</li>)}</ol>
      </Card>
      {result.versions.length > 1 && <label>Ergebnisversion <select value={revision ?? ''} onChange={e => setRevision(e.target.value ? Number(e.target.value) : null)} disabled={pending}>
        <option value="">Aktuelle Version</option>{result.versions.map(v => <option key={v.revision} value={v.revision}>Version {v.revision} · {v.kind === 'RESULT_AMENDMENT' ? 'Nachträgliche Korrektur' : v.kind === 'FINALIZE' ? 'Bestätigt' : v.kind === 'GAME_ENDED' ? 'Ursprüngliches Ergebnis' : 'Ergebnisprüfung'}</option>)}
      </select></label>}
      {canManage && <Card padding="lg"><h2>Ergebnis prüfen</h2>
        {result.resultStatus === 'GAME_END' && <Button disabled={pending} onClick={() => execute({ type: 'REVIEW' })}>Ergebnisprüfung beginnen</Button>}
        {result.resultStatus === 'RESULT_REVIEW' && <Button disabled={pending || result.requiresReview} onClick={() => execute({ type: 'FINALIZE' })}>Ergebnis verbindlich bestätigen</Button>}
        {['RESULT_REVIEW', 'FINALIZED'].includes(result.resultStatus ?? '') && <form onSubmit={event => {
          event.preventDefault(); const value = Number(delta);
          if (!result.scores.some(p => p.participationId === participantId) || !Number.isSafeInteger(value) || value === 0 || Math.abs(value) > 1000000 || !reason.trim()) return;
          execute({ type: result.resultStatus === 'FINALIZED' ? 'AMEND' : 'ADJUST', participantId, delta: value, reason: reason.trim() });
        }}>
          <h3>{result.resultStatus === 'FINALIZED' ? 'Nachträgliche Korrektur mit neuer Version' : 'Punkte korrigieren'}</h3>
          <label>Teilnehmer <select required value={participantId} disabled={pending} onChange={e => setParticipantId(e.target.value)}><option value="">Auswählen</option>{result.scores.map(p => <option key={p.participationId} value={p.participationId}>{p.displayName}</option>)}</select></label>
          <label>Punkteänderung <input type="number" required min={-1000000} max={1000000} step={1} value={delta} disabled={pending} onChange={e => setDelta(e.target.value)} /></label>
          <label>Grund <input required maxLength={500} value={reason} disabled={pending} onChange={e => setReason(e.target.value)} /></label>
          <Button type="submit" disabled={pending || result.requiresReview}>Korrektur speichern</Button>
        </form>}
      </Card>}
      {room?.history.length ? <label>Frühere Partie <select value={runIndex ?? ''} onChange={e => { setRevision(null); setRunIndex(e.target.value ? Number(e.target.value) : null); }} disabled={pending}><option value="">Aktuelle Partie</option>{room.history.map(h => <option key={h.runIndex} value={h.runIndex}>Partie {h.runIndex}</option>)}</select></label> : null}
      {room?.isOwner && result.resultStatus === 'FINALIZED' && result.runIndex === room.runIndex && !revision && <Button disabled={pending} onClick={() => {
        if (busy.current) return; busy.current = true; setPending(true);
        emitCommand(getSocket(), 'room:command', { roomCode, operation: { type: 'REMATCH' } }, `${roomCode}:rematch:${result.runIndex}`, response => { busy.current = false; setPending(false); if (!response.success) setError('Revanche konnte nicht vorbereitet werden.'); });
      }}>Revanche vorbereiten</Button>}
    </>}
    <Link to="/"><Button variant="ghost">Startseite</Button></Link>
  </div>;
}
