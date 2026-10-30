import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { RoomCoreView, RoomOperation, RoomPolicy } from '@quiz/shared';
import { Button, Card } from '@quiz/ui';
import { getSocket, observeSocket, emitCommand } from '../lib/socket';
import { useGameCore } from '../hooks/useGameCore';
import { gamePath } from '../lib/gamePaths';
import { getSession, setSession } from '../lib/sessionStore';
import styles from './RoomPanel.module.css';

const accessLabels = { PUBLIC_JOIN: 'Offen', PIN_PROTECTED: 'Mit PIN', APPROVAL_REQUIRED: 'Mit Freigabe', INVITE_ONLY: 'Nur mit Einladung' };
const messages: Record<string, string> = { NOT_ALL_READY: 'Noch nicht alle Spieler sind bereit.', NOT_ENOUGH_PLAYERS: 'Es fehlen Spieler.', TEAM_CONFIGURATION_INVALID: 'Bitte alle Spieler gültigen Teams zuordnen und die Teamgrößen prüfen.', TEAMS_NOT_EQUAL: 'Die Teams sind unterschiedlich groß.', CONTENT_NOT_READY: 'Die Spielinhalte sind noch nicht vollständig.', MEDIA_NOT_READY: 'Benötigte Medien sind nicht bereit.', NAME_TAKEN: 'Dieser Name ist bereits vergeben.', ROUND_BOUNDARY_REQUIRED: 'Diese Änderung ist erst zwischen zwei Runden möglich.', TEAMS_LOCKED: 'Teams sind während des Spiels gesperrt.', NOT_AUTHORIZED: 'Für diese Aktion fehlt die Berechtigung.', OWNER_REQUIRED: 'Diese Aktion ist dem Raum-Host vorbehalten.', ROOM_FULL: 'Alle Spielerplätze sind belegt.', HOST_MISSING: 'Kein berechtigter, eingeloggter Teilnehmer für die Übernahme verfügbar.', COHOST_DISABLED: 'Co-Hosts sind deaktiviert.', HOST_TRANSFER_NOT_ALLOWED: 'Die Frist ist noch nicht abgelaufen oder die Übernahme ist nicht erlaubt.' };
export function RoomPanel() {
  const location = useLocation(), navigate = useNavigate();
  const code = location.pathname.match(/(?:raum|zuschauen|spiel|zuschauer)\/(\d{3}-\d{3})/)?.[1];
  const core = useGameCore(code ?? '');
  const [view, setView] = useState<RoomCoreView | null>(null);
  const [draft, setDraft] = useState<RoomPolicy | null>(null);
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [message, setMessage] = useState(''), [name, setName] = useState('');
  const [delegated, setDelegated] = useState<string[]>(['GAME_PAUSE', 'PLAYER_MANAGE', 'TEAM_MANAGE']);
  const [userId, setUserId] = useState(''), [schedule, setSchedule] = useState('');
  const [privateResult, setPrivateResult] = useState('');
  const [sourceRoomId, setSourceRoomId] = useState('');
  useEffect(() => {
    setView(null); setDraft(null); setError(''); setPrivateResult('');
    if (!code) return;
    let socket: ReturnType<typeof getSocket> | null = null, generation = 0, disposed = false;
    const refresh = () => {
      const current = getSocket(), expected = generation;
      current.emit('room:core:read', {}, response => {
        if (!disposed && current === socket && expected === generation && response.success && response.view) {
          setView(response.view); setDraft(old => old ?? response.view!.policy);
        }
      });
    };
    const toLobby = () => { const session = getSession(); navigate(session.role === 'HOST' ? `/moderator/raum/${code}/lobby` : session.role === 'VIEWER' ? `/zuschauen/${code}/lobby` : `/raum/${code}/lobby`); };
    const closed = () => { setSession({ roomCode: null, participationId: null, rejoinToken: null, role: null }); navigate('/kategorien'); };
    const probe = (ack: () => void) => ack();
    const detach = () => {
      if (!socket) return;
      socket.off('room:probe', probe); socket.off('game:end', refresh); socket.off('room:snapshot', refresh);
      socket.off('room:core:changed', refresh); socket.off('room:lobby', toLobby); socket.off('room:closed', closed); socket.off('connect', refresh);
    };
    // Pages own admission. This persistent panel follows client replacement across routes.
    const stopObserving = observeSocket(current => {
      detach(); socket = current; ++generation;
      socket.on('room:probe', probe); socket.on('game:end', refresh); socket.on('room:snapshot', refresh);
      socket.on('room:core:changed', refresh); socket.on('room:lobby', toLobby); socket.on('room:closed', closed); socket.on('connect', refresh);
      refresh();
    });
    const interval = window.setInterval(refresh, 10000);
    return () => { disposed = true; ++generation; stopObserving(); window.clearInterval(interval); detach(); };
  }, [code, location.pathname, navigate]);
  useEffect(() => {
    if (code && view?.selfAdmission === 'ACTIVE' && ['GAME_ACTIVE', 'PAUSED'].includes(view.lifecycle) && /lobby$/.test(location.pathname) && getSession().role === 'PLAYER') navigate(gamePath(view.gameSlug, 'PLAYER', code));
  }, [code, view?.selfAdmission, view?.lifecycle, view?.gameSlug, location.pathname, navigate]);
  if (!code || !view || !draft) return null;
  const send = (operation: RoomOperation) => {
    if (pending) return;
    setPending(true); setError(''); setPrivateResult('');
    emitCommand(getSocket(), 'room:command', { roomCode: code, operation }, `${code}:room:${JSON.stringify(operation)}`, response => {
      setPending(false);
      if (!response.success) setError(messages[response.error ?? ''] ?? `Aktion fehlgeschlagen: ${response.error ?? 'Bitte erneut versuchen.'}`);
      if (response.rejoinToken) setPrivateResult(`Neues Geräte-Token: ${String(response.rejoinToken)}`);
      if (response.inviteToken) setPrivateResult(`${window.location.origin}/${operation.type === 'INVITE' && operation.role === 'VIEWER' ? 'zuschauen' : 'beitreten'}?code=${code}&invite=${String(response.inviteToken)}`);
      getSocket().emit('room:core:read', {}, r => { if (r.success && r.view) setView(r.view); });
    });
  };
  const lobby = ['LOBBY_OPEN', 'LOBBY_LOCKED', 'SCHEDULED', 'DRAFT_ROOM'].includes(view.lifecycle);
  const own = view.participants.find(p => p.id === view.selfId);
  return <section className={styles.panel} aria-label="Raum und Teams">
    <Card padding="lg">
      <h2>Raum & Teams</h2>
    {view.contentVisibility === 'BLIND_HOST' && <p role="status">Blindmoderation: Lösungen erst nach Auflösung. Inhaltseditor und private Vorschauen bleiben bis zum Spielende gesperrt.</p>}
      <p>{view.lifecycle === 'IDLE' ? 'Spiel beendet' : view.lifecycle === 'SCHEDULED' ? 'Geplanter Raum' : view.lifecycle === 'LOBBY_LOCKED' ? 'Lobby gesperrt' : lobby ? 'Lobby geöffnet' : 'Spiel läuft'} · Spiel {view.runIndex}</p>
      {view.scheduledAt && <p>Geplant: {new Date(view.scheduledAt).toLocaleString('de-DE')} — der Host startet das Spiel.</p>}
      {view.hostStatus !== 'ONLINE' && <p role="status">{view.hostStatus === 'HOST_MISSING' ? 'Host fehlt. Ein berechtigter Co-Host kann übernehmen.' : 'Host vorübergehend getrennt.'}</p>}
      {view.selfAdmission && view.selfAdmission !== 'ACTIVE' && <p role="status">{view.selfAdmission === 'WAITLIST' ? 'Du stehst auf der Warteliste.' : 'Du wartest auf die Freigabe durch den Host.'}</p>}
      {error && <p role="alert">{error}</p>}
      {privateResult && <p className={styles.privateResult}>{privateResult}</p>}
      {lobby && view.canManage && <div aria-label="Startprüfung"><strong>Startprüfung</strong>{view.preflight.blockers.length + view.preflight.warnings.length === 0 ? <p>Startbereit</p> : <ul>{[...view.preflight.blockers, ...view.preflight.warnings].map(x => <li key={x}>{messages[x] ?? x}</li>)}</ul>}</div>}
      <div className={styles.teams}>{view.teams.map(team => <div key={team.id} className={styles.team} style={{ borderColor: team.color }}>
        <h3>{team.icon} {team.name} · {team.score} Punkte</h3>
        <ul>{view.participants.filter(p => p.teamId === team.id && p.admission === 'ACTIVE').map(p => <li key={p.id}>{p.displayName} · {p.connected ? 'Online' : 'Getrennt'}</li>)}</ul>
        {lobby && view.policy.teamMode === 'SELF_SELECT' && own?.role === 'PLAYER' && <Button disabled={pending || own.teamId === team.id} onClick={() => send({ type: 'TEAM_SELECT', teamId: team.id })}>Team wählen</Button>}
        {view.canManage && lobby && <form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); send({ type: 'TEAM_EDIT', teamId: team.id, name: String(data.get('name')), color: String(data.get('color')), icon: String(data.get('icon')) }); }}><label>Teamname<input name="name" defaultValue={team.name} maxLength={50} required /></label><label>Farbe<input name="color" type="color" defaultValue={team.color} /></label><label>Symbol<input name="icon" defaultValue={team.icon} maxLength={16} required /></label><Button disabled={pending} type="submit">Team speichern</Button></form>}
      </div>)}</div>
      {view.canManage && <div className={styles.people}>{view.participants.filter(p => p.role !== 'HOST').map(p => <div key={p.id}><strong>{p.displayName} · {p.role === 'PLAYER' ? 'Spieler' : 'Zuschauer'}</strong> · {p.ready ? 'Bereit' : 'Nicht bereit'} · Verbindung: {p.connectionQuality === 'UNKNOWN' ? 'noch nicht gemessen' : p.connectionQuality === 'GUT' ? 'gut' : p.connectionQuality === 'INSTABIL' ? 'instabil' : 'schlecht'} · {p.admission === 'WAITLIST' ? 'Warteliste' : p.admission === 'PENDING_JOIN' ? 'Freigabe ausstehend' : p.connected ? 'Online' : 'Getrennt'}
        {lobby && p.role === 'PLAYER' && p.admission === 'ACTIVE' && view.policy.teamMode !== 'OFF' && <label>Team<select value={p.teamId ?? ''} disabled={pending} onChange={e => send({ type: 'TEAMS_ASSIGN', mode: 'MANUAL', override: false, assignments: { [p.id]: e.target.value || null } })}><option value="">Nicht zugewiesen</option>{view.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>}
        {['WAITLIST', 'PENDING_JOIN'].includes(p.admission) && <><Button disabled={pending} onClick={() => send({ type: 'ADMIT', participantId: p.id, approve: true, teamId: view.policy.teamMode === 'SELF_SELECT' ? undefined : view.teams[0]?.id })}>Zulassen</Button><Button disabled={pending} onClick={() => send({ type: 'ADMIT', participantId: p.id, approve: false })}>Ablehnen</Button></>}
        {!p.banned && <><Button disabled={pending} variant="ghost" onClick={() => send({ type: 'KICK', participantId: p.id })}>Entfernen</Button><Button disabled={pending} variant="ghost" onClick={() => { if (window.confirm(`${p.displayName} für diesen Raum sperren?`)) send({ type: 'BAN', participantId: p.id }); }}>Sperren</Button><Button disabled={pending} variant="ghost" onClick={() => send({ type: 'TOKEN_ROTATE', participantId: p.id })}>Gerätewechsel</Button></>}
        {p.banned && <Button disabled={pending} onClick={() => send({ type: 'UNBAN', participantId: p.id })}>Entsperren</Button>}
      </div>)}</div>}
      {own?.role === 'PLAYER' && lobby && <form onSubmit={e => { e.preventDefault(); send({ type: 'RENAME', participantId: own.id, name }); }}><label>Dein Name<input value={name} placeholder={own.displayName} onChange={e => setName(e.target.value)} required maxLength={100} /></label><Button disabled={pending} type="submit">Name ändern</Button></form>}
      {view.isOwner && <details><summary>Raumeinstellungen</summary>
        {lobby && <form className={styles.settings} onSubmit={e => { e.preventDefault(); send({ type: 'POLICY', policy: draft }); }}>
          {(['playerAccess', 'viewerAccess'] as const).map(key => <label key={key}>{key === 'playerAccess' ? 'Spielerzugang' : 'Zuschauerzugang'}<select value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })}>{Object.entries(accessLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}
          <label>Bereitschaft<select value={draft.readyRule} onChange={e => setDraft({ ...draft, readyRule: e.target.value as RoomPolicy['readyRule'] })}><option value="ALL_READY_REQUIRED">Alle müssen bereit sein</option><option value="HOST_CAN_OVERRIDE">Host darf fehlendes Ready übergehen</option><option value="READY_CHECK_DISABLED">Ohne Ready-Prüfung</option></select></label>
          <label>Teamzuweisung<select value={draft.teamMode} onChange={e => setDraft({ ...draft, teamMode: e.target.value as RoomPolicy['teamMode'] })}>{[['OFF', 'Ohne Teams'], ['MANUAL', 'Manuell'], ['RANDOM', 'Zufällig'], ['SELF_SELECT', 'Spieler wählen'], ['ROTATION', 'Neue Paarungen']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Teamanzahl<input type="number" min={2} max={100} value={draft.teamCount} onChange={e => setDraft({ ...draft, teamCount: Number(e.target.value) })} /></label>
          <label>Min. Spieler pro Team<input type="number" min={1} max={100} value={draft.minTeamSize} onChange={e => setDraft({ ...draft, minTeamSize: Number(e.target.value) })} /></label>
          <label>Max. Spieler pro Team<input type="number" min={1} max={100} value={draft.maxTeamSize} onChange={e => setDraft({ ...draft, maxTeamSize: Number(e.target.value) })} /></label>
          <label>Teamgrößen<select value={draft.equality} onChange={e => setDraft({ ...draft, equality: e.target.value as RoomPolicy['equality'] })}><option value="ANY">Beliebig</option><option value="WARN">Warnen bei Ungleichheit</option><option value="REQUIRED">Gleich große Teams</option></select></label>
          <label>Wertung<select aria-label="Wertung" value={draft.scoring} onChange={e => setDraft({ ...draft, scoring: e.target.value as RoomPolicy['scoring'] })}><option value="INDIVIDUAL_SCORE">Einzelwertung</option><option value="TEAM_SCORE">Teamwertung</option></select></label>
          {(['waitlist', 'allowLateJoin', 'coHostEnabled', 'allowTeamReshuffleBetweenRounds'] as const).map((key, i) => <label key={key}><input type="checkbox" checked={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.checked })} />{['Warteliste', 'Später Beitritt mit Freigabe', 'Co-Hosts erlauben', 'Notfall-Teamwechsel zwischen Runden erlauben'][i]}</label>)}
          <Button type="submit" disabled={pending}>Einstellungen speichern</Button>
        </form>}
        {lobby && <div className={styles.actions}><Button disabled={pending} onClick={() => send({ type: 'LOCK', locked: view.lifecycle !== 'LOBBY_LOCKED' })}>{view.lifecycle === 'LOBBY_LOCKED' ? 'Lobby öffnen' : 'Lobby sperren'}</Button><label>Geplanter Beginn<input type="datetime-local" value={schedule} onChange={e => setSchedule(e.target.value)} /></label><Button disabled={pending || !schedule} onClick={() => send({ type: 'SCHEDULE', scheduledAt: new Date(schedule).toISOString() })}>Planen</Button><Button disabled={pending} onClick={() => send({ type: 'OPEN' })}>Jetzt öffnen</Button><Button disabled={pending} onClick={() => send({ type: 'DRAFT' })}>Als Entwurf speichern</Button></div>}
        <div className={styles.actions}><Button disabled={pending} onClick={() => send({ type: 'INVITE', role: 'PLAYER' })}>Spielereinladung erstellen</Button><Button disabled={pending} onClick={() => send({ type: 'INVITE', role: 'VIEWER' })}>Zuschauereinladung erstellen</Button></div>
        <label>Eingeloggter Teilnehmer<select value={userId} onChange={e => setUserId(e.target.value)}><option value="">Bitte wählen</option>{view.participants.filter(p => p.userId).map(p => <option key={p.id} value={p.userId!}>{p.displayName}</option>)}</select></label>
        <fieldset><legend>Delegierte Rechte</legend>{[['GAME_START', 'Spiel starten'], ['GAME_PAUSE', 'Pause/Fortsetzen'], ['ROUND_ADVANCE', 'Runde weiter'], ['JUDGE_ANSWER', 'Antworten bewerten'], ['SCORE_ADJUST', 'Punkte korrigieren'], ['BUZZER_CONTROL', 'Buzzer verwalten'], ['TIMER_CONTROL', 'Timer verwalten'], ['REVEAL_CONTENT', 'Inhalte auflösen'], ['TEAM_MANAGE', 'Teams verwalten'], ['PLAYER_MANAGE', 'Teilnehmer verwalten'], ['GAME_ABORT', 'Spiel abbrechen']].map(([right, label]) => <label key={right}><input type="checkbox" checked={delegated.includes(right)} onChange={e => setDelegated(old => e.target.checked ? [...old, right] : old.filter(r => r !== right))} />{label}</label>)}</fieldset>
        <div className={styles.actions}><Button disabled={pending || !userId} onClick={() => send({ type: 'COHOST', userId, permissions: delegated as import('@quiz/shared').GamePermission[] })}>Verwaltung delegieren</Button><Button disabled={pending || !userId} onClick={() => send({ type: 'COHOST', userId, permissions: [] })}>Delegation entziehen</Button><Button disabled={pending || !userId} onClick={() => { if (window.confirm('Host-Verwaltung an diesen Teilnehmer übertragen?')) send({ type: 'TRANSFER', userId, claim: false }); }}>Host übertragen</Button></div>
      </details>}
      {view.canManage && !view.isOwner && view.hostStatus === 'HOST_MISSING' && own?.userId && <Button disabled={pending} onClick={() => send({ type: 'TRANSFER', userId: own.userId!, claim: true })}>Host-Verwaltung übernehmen</Button>}
      {view.canManage && view.teams.length > 0 && <div className={styles.actions}><Button disabled={pending} onClick={() => send({ type: 'TEAMS_ASSIGN', mode: 'RANDOM', override: !lobby })}>Teams zufällig verteilen</Button><Button disabled={pending} onClick={() => send({ type: 'TEAMS_ASSIGN', mode: 'ROTATION', override: !lobby })}>Neue Paarungen bilden</Button></div>}
      {view.isOwner && view.lifecycle === 'IDLE' && <div className={styles.actions}><Button disabled={pending} onClick={() => send({ type: 'REMATCH', runIndex: view.runIndex })}>Revanche vorbereiten</Button><Button disabled={pending} onClick={() => send({ type: 'LOBBY' })}>Zurück zur Lobby</Button><label>Vorbereitetes Spiel<select value={sourceRoomId} onChange={e => setSourceRoomId(e.target.value)}><option value="">Wissensduell mit Standard-Pool</option>{view.switchOptions.map(option => <option key={option.id} value={option.id}>{option.roomName} · {option.gameSlug}</option>)}</select></label><Button disabled={pending} onClick={() => send({ type: 'SWITCH_GAME', gameSlug: view.switchOptions.find(o => o.id === sourceRoomId)?.gameSlug ?? 'wissensduell', sourceRoomId: sourceRoomId || undefined })}>Spiel wechseln</Button></div>}
      {lobby && getSession().role !== 'HOST' && view.permissions.includes('GAME_START') && <Button disabled={pending || view.preflight.blockers.length > 0} onClick={() => { setPending(true); emitCommand(getSocket(), 'game:start', { roomCode: code, overrideReady: view.policy.readyRule === 'HOST_CAN_OVERRIDE', acknowledgeWarnings: view.preflight.warnings.length > 0 && window.confirm('Startwarnungen bestätigen?') }, `${code}:start:${view.runIndex}`, r => { setPending(false); if (!r.success) setError(messages[r.error ?? ''] ?? 'Spielstart nicht möglich.'); }); }}>Spiel starten</Button>}
      {(view.isOwner || view.permissions.includes('GAME_PAUSE')) && ['GAME_ACTIVE', 'PAUSED'].includes(view.lifecycle) && <Button disabled={pending || !core.can(view.lifecycle === 'PAUSED' ? 'resume' : 'pause')} onClick={() => { setPending(true); emitCommand(getSocket(), view.lifecycle === 'PAUSED' ? 'game:resume' : 'game:pause', { roomCode: code }, `${code}:pause:${view.lifecycle}`, r => { setPending(false); if (!r.success) setError('Pause konnte nicht geändert werden.'); }); }}>{view.lifecycle === 'PAUSED' ? 'Spiel fortsetzen' : 'Spiel pausieren'}</Button>}
      {view.canManage && !lobby && view.lifecycle !== 'IDLE' && <Button variant="danger" disabled={pending} onClick={() => { if (window.confirm('Spiel abbrechen und Punkte behalten?')) send({ type: 'EMERGENCY', action: 'ABORT_GAME', points: 'KEEP_POINTS' }); }}>Spiel abbrechen</Button>}
      {view.isOwner && (lobby || view.lifecycle === 'IDLE') && <Button variant="danger" disabled={pending} onClick={() => { if (window.confirm('Raum endgültig schließen? Danach ist kein Rejoin mehr möglich.')) send({ type: 'CLOSE' }); }}>Raum endgültig schließen</Button>}
      {view.canManage && <form onSubmit={e => { e.preventDefault(); send({ type: 'MESSAGE', message }); setMessage(''); }}><label>Nachricht an den Raum<input value={message} onChange={e => setMessage(e.target.value)} maxLength={300} required /></label><Button disabled={pending} type="submit">Senden</Button></form>}
      {view.history.length > 0 && <details><summary>Bisherige Ergebnisse</summary>{view.history.map(run => <div key={run.runIndex}><h3>Spiel {run.runIndex}</h3><ul>{run.players.map((player, index) => <li key={index}>{player.displayName}: {player.score} Punkte</li>)}</ul></div>)}</details>}
      <details><summary>Raumverlauf</summary><ol>{view.feed.map(entry => <li key={entry.id}><time>{new Date(entry.createdAt).toLocaleTimeString('de-DE')}</time> {entry.message}</li>)}</ol></details>
    </Card>
  </section>;
}
