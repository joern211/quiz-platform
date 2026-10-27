import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { type RoomState, getSocket, connectSocket, disconnectSocket } from '../lib/socket';
import styles from './BroadcastPage.module.css';
type PublicState = { phase: string; prompt?: string; options?: { id: string; text: string }[]; image?: string; mediaType?: string; mediaUrl?: string; scores: Record<string, number>; names: Record<string, string>; end: number | null; answer?: string };
const initial: PublicState = { phase: 'LOBBY', scores: {}, names: {}, end: null };
export function BroadcastPage() {
  const { code = '' } = useParams(); const [error, setError] = useState(''), [name, setName] = useState('Broadcast'), [state, setState] = useState(initial), [now, setNow] = useState(Date.now());
  useEffect(() => {
    const socket = getSocket(); let live = true;
    const resync = (slug: string) => {
      socket.emit('game:core:read', {}, result => { if (live && result.success && result.projection) setState(old => ({ ...old, end: result.projection!.timer?.endsAtMs ?? null })); });
      if (slug === 'wissensduell' || slug === 'geo') socket.emit('geo:resync', {}, r => { if (live && r.success) setState(old => ({ ...old, phase: r.phase ?? 'LOBBY', prompt: r.question?.prompt, options: r.question?.options, mediaUrl: r.question?.mediaUrl, mediaType: r.question?.mediaType, scores: r.scores ?? {}, end: r.timerEndMs ?? null })); });
      else if (slug === 'jeopardy') socket.emit('jeopardy:resync', {}, r => { if (live && r.success) setState(old => ({ ...old, phase: r.phase ?? 'LOBBY', prompt: r.currentField?.question, mediaUrl: r.currentField?.mediaUrl, mediaType: r.currentField?.mediaType, scores: Object.fromEntries((r.scores ?? []).map(row => [row.playerId, row.score])), names: r.playerNames ?? old.names, end: null })); });
      else socket.emit('weristdas:resync', {}, r => { if (live && r.success && r.state) setState(old => ({ ...old, phase: r.state!.phase, image: r.state!.gameImageUrl, scores: r.state!.scores, names: r.state!.playerNames })); });
    };
    let slug = '';
    const subscribe = () => socket.emit('room:display:subscribe', { roomCode: code, token: window.location.hash.slice(1) }, result => { if (!live) return; if (!result.success || !result.data) setError('Display-Link ungültig oder abgelaufen. Bitte neuen Link vom Host öffnen.'); else { setError(''); setName(result.data.roomName); slug = result.data.gameSlug; resync(slug); } });
    const room = (snapshot: RoomState) => { if (live) setState(old => ({ ...old, names: Object.fromEntries(snapshot.players.map(p => [p.id, p.displayName])), scores: Object.fromEntries(snapshot.players.map(p => [p.id, p.score])) })); };
    const refresh = () => resync(slug), closed = () => { setError('Dieser Raum ist geschlossen.'); setState(initial); };
    socket.on('connect', subscribe); socket.on('room:snapshot', room); socket.on('room:closed', closed); socket.on('game:started', refresh); socket.on('game:core:changed', refresh);
    socket.on('geo:question', refresh); socket.on('geo:reveal', refresh); socket.on('geo:timer-expired', refresh); socket.on('jeopardy:field:open', refresh); socket.on('jeopardy:reveal', refresh); socket.on('weristdas:update', refresh);
    connectSocket(); if (socket.connected) subscribe();
    const poll = window.setInterval(refresh, 2000), clock = window.setInterval(() => setNow(Date.now()), 250);
    return () => { live = false; clearInterval(poll); clearInterval(clock); socket.off('connect', subscribe); socket.off('room:snapshot', room); socket.off('room:closed', closed); socket.off('game:started', refresh); socket.off('game:core:changed', refresh); socket.off('geo:question', refresh); socket.off('geo:reveal', refresh); socket.off('geo:timer-expired', refresh); socket.off('jeopardy:field:open', refresh); socket.off('jeopardy:reveal', refresh); socket.off('weristdas:update', refresh); disconnectSocket(); };
  }, [code]);
  return <section className={styles.page} aria-label="Broadcast"><header><h1>{name}</h1><p>Raum {code} · DISPLAY · {state.phase}</p></header>{error && <p role="alert">{error}</p>}
    {state.end && <p className={styles.timer}>{Math.max(0, Math.ceil((state.end - now) / 1000))} s</p>}
    {state.prompt && <h2>{state.prompt}</h2>}{state.image && <img src={state.image} alt="Aktuelles Spielbild" />}
    {state.mediaUrl && (state.mediaType === 'audio' ? <audio src={state.mediaUrl} controls /> : <img src={state.mediaUrl} alt="Medium zur aktuellen Frage" />)}
    {state.options && <ol>{state.options.map(option => <li key={option.id}>{option.text}</li>)}</ol>}
    <div className={styles.scores}>{Object.entries(state.scores).sort((a, b) => b[1] - a[1]).map(([id, score]) => <div key={id}><strong>{state.names[id] ?? 'Spieler'}</strong><span>{score}</span></div>)}</div>
  </section>;
}
