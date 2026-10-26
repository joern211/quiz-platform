import { readMediaPreferences, saveMediaPreferences, defaultFilters, type MicrophoneFilters } from '../lib/mediaPreferences';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { LiveMediaPolicy, LiveMediaRoute, LiveMediaSnapshot } from '@quiz/shared';
import { getSocket, observeSocket } from '../lib/socket';
import { LiveMediaTransport } from '../lib/liveMedia';
import styles from './LiveMediaPanel.module.css';

type Kind = 'audio' | 'video';
type Remote = { stream: MediaStream; route: LiveMediaRoute };
const stop = (stream?: MediaStream) => stream?.getTracks().forEach(track => track.stop());
function RemoteMedia({ item, enabled, outputDevice }: { item: Remote; enabled: boolean; outputDevice: string }) {
  const element = useRef<HTMLVideoElement>(null); const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    const media = element.current; if (!media) return; media.srcObject = item.stream;
    const sink = media as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }; if (sink.setSinkId) void sink.setSinkId(outputDevice).catch(() => { void sink.setSinkId?.('').catch(() => {}); });
    if (enabled) void media.play().catch(() => {});
    let context: AudioContext | null = null, frame = 0;
    if (item.route.kind === 'audio' && typeof AudioContext !== 'undefined') {
      try { context = new AudioContext(); const source = context.createMediaStreamSource(item.stream), analyser = context.createAnalyser(); source.connect(analyser); analyser.fftSize = 256;
        const data = new Uint8Array(analyser.fftSize); const tick = () => { analyser.getByteTimeDomainData(data); setSpeaking(data.some(x => Math.abs(x - 128) > 10)); frame = requestAnimationFrame(tick); }; tick();
      } catch { /* Indicator is optional if browser audio processing is unavailable. */ }
    }
    return () => { cancelAnimationFrame(frame); if (context) void context.close().catch(() => {}); media.srcObject = null; };
  }, [item.stream, item.route.kind, enabled, outputDevice]);
  return <figure className={styles.tile}><video ref={element} autoPlay={enabled} playsInline controls={item.route.kind === 'audio'} className={item.route.kind === 'video' ? styles.video : styles.audio} aria-label={`${item.route.kind === 'video' ? 'Livekamera' : 'Liveaudio'} ${item.route.name}`} /><figcaption>{item.route.name}{speaking ? ' · spricht' : ''}</figcaption></figure>;
}
export function LiveMediaPanel() {
  const location = useLocation(); const code = location.pathname.match(/(?:raum|zuschauen|spiel|zuschauer)\/(\d{3}-\d{3})/)?.[1];
  const [view, setView] = useState<LiveMediaSnapshot | null>(null), [error, setError] = useState('');
  const [remotes, setRemotes] = useState<Record<string, Remote>>({}), [pending, setPending] = useState<Kind | null>(null);
  const [wants, setWants] = useState({ audio: false, video: false }), [listen, setListen] = useState(false), [ptt, setPtt] = useState(false), [held, setHeld] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]), [audioDevice, setAudioDevice] = useState(''), [videoDevice, setVideoDevice] = useState('');
  const [outputDevice, setOutputDevice] = useState(() => readMediaPreferences().outputDevice);
  const [filters, setFilters] = useState<MicrophoneFilters>(() => { const saved = readMediaPreferences(); return saved.filtersByDevice[saved.audioDevice] ?? { echoCancellation: saved.echoCancellation, noiseSuppression: saved.noiseSuppression, autoGainControl: saved.autoGainControl }; });
  const [quality, setQuality] = useState<'AUTO' | 'DATA_SAVER' | 'HIGH_QUALITY'>('AUTO');
  const [displayLink, setDisplayLink] = useState('');
  const qualityRef = useRef(quality); qualityRef.current = quality;
  const [teamListen, setTeamListen] = useState<string | null>(null);
  const streams = useRef<Partial<Record<Kind, MediaStream>>>({}), controller = useRef<LiveMediaTransport | null>(null), socket = useRef<ReturnType<typeof getSocket> | null>(null);
  const currentView = useRef<LiveMediaSnapshot | null>(null), wantsRef = useRef(wants), pttRef = useRef(false), heldRef = useRef(false), teamRef = useRef<string | null>(null);
  const generation = useRef({ audio: 0, video: 0 });
  const updateSelf = () => {
    const self = currentView.current; if (!self || !socket.current?.connected) return;
    const forced = self.policy.voiceMode === 'PUSH_TO_TALK' || self.policy.forcePushToTalk;
    const talking = forced || (self.policy.voiceMode === 'PLAYER_CHOICE' && pttRef.current) ? heldRef.current : true;
    for (const track of streams.current.audio?.getAudioTracks() ?? []) track.enabled = wantsRef.current.audio && !self.self.hostMuted && talking;
    socket.current.emit('media:self', { mic: wantsRef.current.audio, camera: wantsRef.current.video, talking, teamListen: teamRef.current }, result => { if (!result.success) setError(result.error === 'HOST_MUTED' ? 'Dein Mikrofon ist durch den Host gesperrt.' : `Medienänderung abgewiesen: ${result.error}`); });
  };
  const updateSelfRef = useRef(updateSelf); updateSelfRef.current = updateSelf;
  useEffect(() => {
    if (!code) return;
    let disposed = false, joined = false, joining = false, client: ReturnType<typeof getSocket> | null = null;
    const stopCapture = () => { generation.current.audio++; generation.current.video++; stop(streams.current.audio); stop(streams.current.video); streams.current = {}; wantsRef.current = { audio: false, video: false }; setWants(wantsRef.current); setPending(null); };
    const closed = () => { joined = false; currentView.current = null; setView(null); stopCapture(); controller.current?.close(); setRemotes({}); };
    const transport = (client: ReturnType<typeof getSocket>) => new LiveMediaTransport(signal => client.emit('media:signal', signal, result => { if (result && !result.success && result.error !== 'MEDIA_ROUTE_REVOKED') setError('Medienverbindung konnte nicht aufgebaut werden.'); }), (id, stream, route) => { if (!disposed) setRemotes(old => { const next = { ...old }; if (stream) next[id] = { stream, route }; else delete next[id]; return next; }); }, message => { if (!disposed) setError(message); });
    const snapshot = (state: LiveMediaSnapshot) => {
      if (disposed || state.roomCode !== code) return;
      const previous = currentView.current; const first = !previous; const modeChanged = previous && (previous.policy.voiceMode !== state.policy.voiceMode || previous.policy.forcePushToTalk !== state.policy.forcePushToTalk);
      if (modeChanged) { heldRef.current = false; setHeld(false); }
      currentView.current = state; setView(state);
      if (state.self.hostMuted || !state.policy.voiceEnabled) { generation.current.audio++; stop(streams.current.audio); delete streams.current.audio; controller.current?.setStream('audio'); wantsRef.current.audio = false; setWants({ ...wantsRef.current }); setPending(old => old === 'audio' ? null : old); }
      if (!state.policy.camerasEnabled || !state.policy.camerasVisible || state.self.cameraHidden) {
        stop(streams.current.video); delete streams.current.video; controller.current?.setStream('video'); wantsRef.current.video = false; setWants({ ...wantsRef.current }); generation.current.video++; setPending(old => old === 'video' ? null : old);
      }
      controller.current?.update(state);
      const forced = state.policy.voiceMode === 'PUSH_TO_TALK' || state.policy.forcePushToTalk;
      for (const track of streams.current.audio?.getTracks() ?? []) track.enabled = wantsRef.current.audio && !state.self.hostMuted && (!(forced || state.policy.voiceMode === 'PLAYER_CHOICE' && pttRef.current) || heldRef.current);
      if (first || modeChanged) updateSelfRef.current();
    };
    const signal = (message: Parameters<LiveMediaTransport['signal']>[0]) => controller.current?.signal(message);
    const join = () => { if (!client?.connected || joined || joining) return; joining = true; const expected = client;
      client.emit('media:join', {}, result => { if (disposed || client !== expected) return; joining = false; if (result.success) { joined = true; updateSelfRef.current(); } }); };
    const disconnected = () => { joined = false; joining = false; currentView.current = null; setView(null); controller.current?.close(); setRemotes({}); for (const track of streams.current.audio?.getTracks() ?? []) track.enabled = false; };
    const detach = () => { if (!client) return; client.off('media:snapshot', snapshot); client.off('media:signal', signal); client.off('media:closed', closed); client.off('room:snapshot', join); client.off('room:closed', closed); client.off('session:replaced', closed); client.off('room:kicked', closed); client.off('disconnect', disconnected); };
    const unobserve = observeSocket(next => { detach(); controller.current?.close(); client = next; socket.current = next; joined = false; joining = false; currentView.current = null;
      controller.current = transport(next); void controller.current.quality(qualityRef.current, document.hidden); for (const kind of ['audio', 'video'] as const) controller.current.setStream(kind, streams.current[kind]);
      next.on('media:snapshot', snapshot); next.on('media:signal', signal); next.on('media:closed', closed); next.on('room:snapshot', join); next.on('room:closed', closed); next.on('session:replaced', closed); next.on('room:kicked', closed); next.on('disconnect', disconnected); join(); });
    const release = () => { heldRef.current = false; setHeld(false); updateSelfRef.current(); };
    const visibility = () => { if (document.hidden) release(); void controller.current?.quality(qualityRef.current, document.hidden); };
    window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; unobserve(); detach(); client?.emit('media:leave', {}); stopCapture(); controller.current?.close(); controller.current = null; socket.current = null; currentView.current = null; window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); };
  }, [code]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => { const target = event.target as HTMLElement | null; if (event.code !== 'Space' || event.repeat || target?.closest('input,textarea,select,button,[contenteditable="true"]') || !(pttRef.current && currentView.current?.policy.voiceMode === 'PLAYER_CHOICE' || currentView.current?.policy.voiceMode === 'PUSH_TO_TALK' || currentView.current?.policy.forcePushToTalk)) return; event.preventDefault(); heldRef.current = true; setHeld(true); updateSelfRef.current(); };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') { heldRef.current = false; setHeld(false); updateSelfRef.current(); } };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);
  async function capture(kind: Kind, device = kind === 'audio' ? audioDevice : videoDevice, filterOverride?: MicrophoneFilters) {
    if (!view) return; const version = ++generation.current[kind]; setPending(kind); setError('');
    try {
      const prefs = readMediaPreferences(); const requestedFilters = filterOverride ?? filters;
      const selected = device || String(prefs[kind === 'audio' ? 'audioDevice' : 'videoDevice'] ?? '');
      const constraints = (id: string) => kind === 'audio' ? { audio: { ...requestedFilters, ...(id ? { deviceId: { exact: id } } : {}) }, video: false } : { video: { width: { ideal: 640 }, height: { ideal: 360 }, ...(id ? { deviceId: { exact: id } } : {}) }, audio: false };
      let stream: MediaStream;
      try { stream = await navigator.mediaDevices.getUserMedia(constraints(selected)); } catch (error) { if (!selected || !['NotFoundError', 'OverconstrainedError'].includes((error as Error).name) || generation.current[kind] !== version) throw error; stream = await navigator.mediaDevices.getUserMedia(constraints('')); setError('Gespeichertes Gerät nicht verfügbar; Standardgerät wird verwendet.'); }
      if (generation.current[kind] !== version || !currentView.current) { stop(stream); return; }
      const actualDevice = stream.getTracks()[0].getSettings().deviceId ?? '';
      const saved = readMediaPreferences(); saveMediaPreferences({ ...saved, [kind === 'audio' ? 'audioDevice' : 'videoDevice']: actualDevice, ...(kind === 'audio' ? { ...requestedFilters, filtersByDevice: { ...saved.filtersByDevice, [actualDevice]: requestedFilters } } : {}) });
      if (kind === 'audio') setAudioDevice(actualDevice); else setVideoDevice(actualDevice);
      stop(streams.current[kind]); streams.current[kind] = stream; controller.current?.setStream(kind, stream);
      stream.getTracks()[0].addEventListener('ended', () => { if (generation.current[kind] === version) disable(kind); }, { once: true });
      wantsRef.current[kind] = true; setWants({ ...wantsRef.current }); updateSelfRef.current();
      if (currentView.current) controller.current?.update(currentView.current);
      try { setDevices(await navigator.mediaDevices.enumerateDevices()); } catch { /* capture still works */ }
    } catch { if (generation.current[kind] === version) setError('Gerät nicht freigegeben oder nicht verfügbar. Du kannst weiter mitspielen.'); }
    finally { if (generation.current[kind] === version) setPending(null); }
  }
  function disable(kind: Kind) { generation.current[kind]++; stop(streams.current[kind]); delete streams.current[kind]; controller.current?.setStream(kind); wantsRef.current[kind] = false; setWants({ ...wantsRef.current }); setPending(null); updateSelfRef.current(); }
  function control(change: { policy?: Partial<LiveMediaPolicy>; targetId?: string; hostMuted?: boolean; cameraHidden?: boolean; muteAll?: boolean }) { if (!view) return; socket.current?.emit('media:control', { expectedRevision: view.revision, ...change }, result => { if (!result.success) setError(`Änderung nicht übernommen: ${result.error}. Bitte erneut versuchen.`); }); }
  if (!code || !view) return null;
  const receiveOnly = ['VIEWER', 'DISPLAY'].includes(view.self.role), forcedPtt = view.policy.voiceMode === 'PUSH_TO_TALK' || view.policy.forcePushToTalk;
  return <section className={styles.panel} aria-label="Live-Medien">
    <h2>Sprache und Kamera</h2><p>Sprachkanal: {view.policy.channel}{view.self.hostMuted ? ' · Mikrofon durch Host gesperrt' : ''}</p>
    {error && <p role="alert">{error}</p>}
    <div className={styles.controls}>
      <button type="button" onClick={() => { setListen(true); void navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {}); }}>Live-Audio hören</button>
      {!receiveOnly && <><button type="button" disabled={!navigator.mediaDevices?.getUserMedia || !!pending || view.self.hostMuted || !view.policy.voiceEnabled} onClick={() => wants.audio ? disable('audio') : void capture('audio')}>{wants.audio ? 'Mikrofon ausschalten' : 'Mikrofon einschalten'}</button>
      <button type="button" disabled={!navigator.mediaDevices?.getUserMedia || !!pending || !view.policy.camerasEnabled || !view.policy.camerasVisible || view.self.cameraHidden} onClick={() => wants.video ? disable('video') : void capture('video')}>{wants.video ? 'Kamera ausschalten' : 'Kamera einschalten'}</button>
      <label><input type="checkbox" checked={forcedPtt || view.policy.voiceMode === 'PLAYER_CHOICE' && ptt} disabled={forcedPtt || view.policy.voiceMode === 'OPEN_MIC'} onChange={e => { pttRef.current = e.target.checked; setPtt(e.target.checked); heldRef.current = false; setHeld(false); updateSelf(); }} />Push-to-Talk</label>
      {(forcedPtt || view.policy.voiceMode === 'PLAYER_CHOICE' && ptt) && <button type="button" disabled={!wants.audio || view.self.hostMuted} aria-pressed={held} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); heldRef.current = true; setHeld(true); updateSelf(); }} onPointerUp={() => { heldRef.current = false; setHeld(false); updateSelf(); }} onLostPointerCapture={() => { heldRef.current = false; setHeld(false); updateSelf(); }} onPointerCancel={() => { heldRef.current = false; setHeld(false); updateSelf(); }}>Zum Sprechen halten (Leertaste)</button>}
      {(['audio', 'video'] as const).map(kind => <label key={kind}>{kind === 'audio' ? 'Mikrofongerät live' : 'Kameragerät live'}<select value={kind === 'audio' ? audioDevice : videoDevice} onChange={e => { const savedFilters = readMediaPreferences().filtersByDevice[e.target.value] ?? defaultFilters; if (kind === 'audio') { setAudioDevice(e.target.value); setFilters(savedFilters); } else setVideoDevice(e.target.value); if (wants[kind]) void capture(kind, e.target.value, kind === 'audio' ? savedFilters : undefined); }}><option value="">Standardgerät</option>{devices.filter(d => d.kind === (kind === 'audio' ? 'audioinput' : 'videoinput')).map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Gerät'}</option>)}</select></label>)}</>}
      <label>Lautsprecher live<select disabled={!('setSinkId' in HTMLMediaElement.prototype)} value={outputDevice} onChange={e => { setOutputDevice(e.target.value); saveMediaPreferences({ ...readMediaPreferences(), outputDevice: e.target.value }); }}><option value="">Standardlautsprecher</option>{devices.filter(d => d.kind === 'audiooutput' && d.deviceId).map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Lautsprecher'}</option>)}</select></label>
      {!receiveOnly && (['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const).map((key, index) => <label key={key}><input type="checkbox" checked={filters[key]} onChange={e => { const next = { ...filters, [key]: e.target.checked }; setFilters(next); const saved = readMediaPreferences(); saveMediaPreferences({ ...saved, ...next, filtersByDevice: { ...saved.filtersByDevice, [audioDevice || saved.audioDevice]: next } }); if (wants.audio) void capture('audio', audioDevice, next); }} />{['Echo filtern', 'Rauschen filtern', 'Verstärkung automatisch'][index]}</label>)}
      <label>Videoqualität<select aria-label="Videoqualität" value={quality} onChange={e => { const value = e.target.value as typeof quality; setQuality(value); void controller.current?.quality(value, document.hidden); }}><option value="AUTO">Automatisch</option><option value="DATA_SAVER">Daten sparen</option><option value="HIGH_QUALITY">Hohe Qualität</option></select></label>
      <button type="button" onClick={() => { controller.current?.close(); if (view) controller.current?.update(view); setError(''); }}>Medien neu verbinden</button>
    </div>
    {view.self.role === 'HOST' && !view.self.teamId && <label>Teamkanal moderieren<select aria-label="Teamkanal moderieren" value={teamListen ?? ''} onChange={e => { teamRef.current = e.target.value || null; setTeamListen(teamRef.current); updateSelf(); }}><option value="">Kein Team</option>{[...new Set(view.members.map(m => m.teamId).filter((id): id is string => !!id))].map(id => <option key={id} value={id}>{id}</option>)}</select></label>}
    {view.canManage && <fieldset><legend>Medien moderieren</legend><div className={styles.controls}>
      <button type="button" onClick={() => socket.current?.emit('media:display-link', {}, r => { if (r.success && r.data) setDisplayLink(window.location.origin + r.data.path); else setError('Display-Link konnte nicht erzeugt werden.'); })}>Display-Link erzeugen</button>
      {displayLink && <label>Display-Link (12 Stunden)<input readOnly value={displayLink} /></label>}
      <button type="button" onClick={() => control({ muteAll: true })}>Alle Mikrofone sperren</button>
      <label>Sprachmodus<select aria-label="Sprachmodus" value={view.policy.voiceMode} onChange={e => control({ policy: { voiceMode: e.target.value as LiveMediaPolicy['voiceMode'] } })}><option value="OPEN_MIC">Offenes Mikrofon</option><option value="PUSH_TO_TALK">Push-to-Talk</option><option value="PLAYER_CHOICE">Spieler wählen</option></select></label>
      <label>Raumsprachkanal<select aria-label="Raumsprachkanal" value={view.policy.channel} onChange={e => control({ policy: { channel: e.target.value as 'MAIN' | 'TEAM' } })}><option value="MAIN">MAIN</option><option value="TEAM">TEAM</option></select></label>
      {(['voiceEnabled', 'viewerAudio', 'camerasEnabled', 'camerasVisible', 'autoTeamDuringRound', 'autoPttDuringRound'] as const).map((key, i) => <label key={key}><input type="checkbox" checked={view.policy[key]} onChange={e => control({ policy: { [key]: e.target.checked } })} />{['Sprache erlauben', 'Zuschauer dürfen MAIN hören', 'Kameras erlauben', 'Kameras im Raum anzeigen', 'Während der Runde TEAM, sonst MAIN', 'Während der Runde Push-to-Talk erzwingen'][i]}</label>)}
    </div></fieldset>}
    <div className={styles.tiles}>{view.members.map(m => <div key={m.id} className={styles.member}><span>{m.name} · {m.mic ? 'Mikrofon an' : 'Mikrofon aus'} · {m.camera ? 'Kamera an' : 'Initialen: ' + m.name.slice(0, 2).toUpperCase()}</span>{view.canManage && m.id !== view.selfId && !['VIEWER', 'DISPLAY'].includes(m.role) && <div className={styles.controls}><button type="button" onClick={() => control({ targetId: m.id, hostMuted: !m.hostMuted })}>{m.hostMuted ? 'Mikrofon freigeben' : 'Mikrofon sperren'}: {m.name}</button><button type="button" onClick={() => control({ targetId: m.id, cameraHidden: !m.cameraHidden })}>{m.cameraHidden ? 'Kamera freigeben' : 'Kamera verbergen'}: {m.name}</button></div>}</div>)}</div>
    <div className={styles.tiles}>{Object.entries(remotes).map(([id, item]) => <RemoteMedia key={id} item={item} enabled={listen || item.route.kind === 'video'} outputDevice={outputDevice} />)}</div>
  </section>;
}
