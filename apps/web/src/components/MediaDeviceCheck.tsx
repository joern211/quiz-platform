import { useEffect, useRef, useState } from 'react';
import styles from './MediaDeviceCheck.module.css';

type Kind = 'audio' | 'video';
type Preferences = { audioDevice: string; videoDevice: string; echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
const defaults: Preferences = { audioDevice: '', videoDevice: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const storageKey = 'qp:media-devices:v1';
function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof saved?.[key] === typeof value ? saved[key] : value])) as Preferences;
  } catch { return defaults; }
}
const stop = (stream?: MediaStream) => stream?.getTracks().forEach(track => track.stop());

/** Local preview only. Permission and capture always follow an explicit click. */
export function MediaDeviceCheck({ microphone = true }: { microphone?: boolean }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [active, setActive] = useState({ audio: false, video: false });
  const [pending, setPending] = useState({ audio: false, video: false });
  const [messages, setMessages] = useState({ audio: '', video: '', speaker: '' });
  const [level, setLevel] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const streams = useRef<Partial<Record<Kind, MediaStream>>>({});
  const versions = useRef({ audio: 0, video: 0 });
  const alive = useRef(false);
  const meterCleanup = useRef<() => void>(() => {});
  const speakerCleanup = useRef<() => void>(() => {});
  const speakerVersion = useRef({ value: 0 });
  const supported = typeof navigator.mediaDevices?.getUserMedia === 'function';

  useEffect(() => {
    alive.current = true;
    const captureVersions = versions.current, capturedStreams = streams.current, speakerGeneration = speakerVersion.current;
    return () => {
      alive.current = false;
      captureVersions.audio++; captureVersions.video++;
      stop(capturedStreams.audio); stop(capturedStreams.video);
      meterCleanup.current(); speakerGeneration.value++; speakerCleanup.current();
    };
  }, []);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Preview works without storage. */ } }, [preferences]);
  useEffect(() => {
    const refresh = async () => {
      try { const found = await navigator.mediaDevices?.enumerateDevices(); if (alive.current && found) setDevices(found); } catch { /* No permission required to join. */ }
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, []);

  function disable(kind: Kind) {
    versions.current[kind]++;
    stop(streams.current[kind]); delete streams.current[kind];
    if (kind === 'audio') { meterCleanup.current(); setLevel(0); }
    if (kind === 'video' && video.current) video.current.srcObject = null;
    setActive(old => ({ ...old, [kind]: false })); setPending(old => ({ ...old, [kind]: false }));
  }
  async function start(kind: Kind) {
    disable(kind);
    const version = ++versions.current[kind];
    setPending(old => ({ ...old, [kind]: true })); setMessages(old => ({ ...old, [kind]: '' }));
    const chosen = kind === 'audio' ? preferences.audioDevice : preferences.videoDevice;
    const constraints = (deviceId: string): MediaStreamConstraints => kind === 'audio'
      ? { audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: preferences.echoCancellation, noiseSuppression: preferences.noiseSuppression, autoGainControl: preferences.autoGainControl }, video: false }
      : { video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 640 }, height: { ideal: 360 } }, audio: false };
    try {
      let stream: MediaStream;
      try { stream = await navigator.mediaDevices.getUserMedia(constraints(chosen)); }
      catch (error) {
        if (!chosen || !['NotFoundError', 'OverconstrainedError'].includes((error as Error).name) || !alive.current || versions.current[kind] !== version) throw error;
        stream = await navigator.mediaDevices.getUserMedia(constraints(''));
        if (alive.current && versions.current[kind] === version) setMessages(old => ({ ...old, [kind]: 'Gespeichertes Gerät nicht verfügbar. Standardgerät wird verwendet.' }));
      }
      if (!alive.current || versions.current[kind] !== version) { stop(stream); return; }
      streams.current[kind] = stream;
      const track = stream.getTracks()[0];
      const actualDevice = track?.getSettings().deviceId ?? '';
      setPreferences(old => ({ ...old, [kind === 'audio' ? 'audioDevice' : 'videoDevice']: actualDevice }));
      track?.addEventListener('ended', () => {
        if (alive.current && versions.current[kind] === version) { disable(kind); setMessages(old => ({ ...old, [kind]: 'Gerät getrennt. Du kannst ein anderes Gerät testen.' })); }
      }, { once: true });
      setActive(old => ({ ...old, [kind]: true }));
      if (kind === 'video' && video.current) video.current.srcObject = stream;
      if (kind === 'audio' && typeof AudioContext !== 'undefined') {
        try {
          const context = new AudioContext(); const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser();
          analyser.fftSize = 256; source.connect(analyser); // No connection to speakers: no microphone feedback.
          const samples = new Uint8Array(analyser.fftSize); let frame = 0;
          const update = () => { analyser.getByteTimeDomainData(samples); setLevel(Math.min(100, Math.round(Math.sqrt(samples.reduce((sum, x) => sum + ((x - 128) / 128) ** 2, 0) / samples.length) * 300))); frame = requestAnimationFrame(update); };
          meterCleanup.current = () => { cancelAnimationFrame(frame); source.disconnect(); void context.close().catch(() => {}); };
          void context.resume().catch(() => {}); update();
        } catch { /* Capture remains usable without a level meter. */ }
      }
      try { const found = await navigator.mediaDevices.enumerateDevices(); if (alive.current && versions.current[kind] === version) setDevices(found); } catch { /* Device names can remain unavailable. */ }
    } catch (error) {
      if (alive.current && versions.current[kind] === version) setMessages(old => ({ ...old, [kind]: (error as Error).name === 'NotAllowedError' ? 'Freigabe verweigert. Du kannst trotzdem beitreten.' : 'Gerät nicht verfügbar. Du kannst trotzdem beitreten.' }));
    } finally { if (alive.current && versions.current[kind] === version) setPending(old => ({ ...old, [kind]: false })); }
  }
  async function speakerTest() {
    const version = ++speakerVersion.current.value;
    speakerCleanup.current();
    setMessages(old => ({ ...old, speaker: '' }));
    try {
      const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain();
      speakerCleanup.current = () => { void context.close().catch(() => {}); };
      oscillator.connect(gain); gain.connect(context.destination);
      await context.resume();
      if (!alive.current || version !== speakerVersion.current.value || context.state === 'closed') { await context.close().catch(() => {}); return; }
      gain.gain.setValueAtTime(0, context.currentTime); gain.gain.linearRampToValueAtTime(0.08, context.currentTime + 0.02); gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.45);
      oscillator.frequency.value = 440; oscillator.onended = () => { void context.close().catch(() => {}); }; oscillator.start(); oscillator.stop(context.currentTime + 0.5);
      setMessages(old => ({ ...old, speaker: 'Testton am Standardlautsprecher. Ausgabe in den Browser-/Systemeinstellungen wählen.' }));
    } catch { if (alive.current) setMessages(old => ({ ...old, speaker: 'Lautsprechertest nicht verfügbar. Du kannst trotzdem beitreten.' })); }
  }
  return <details className={styles.panel} onToggle={event => { if (!event.currentTarget.open) { disable('audio'); disable('video'); speakerVersion.current.value++; speakerCleanup.current(); } }}>
    <summary>Geräte vorab testen (optional)</summary>
    <p>Lokaler Test: Bild und Ton werden nicht in den Raum übertragen. Beim Verlassen endet die Vorschau.</p>
    {!supported && <p role="status">Gerätetest hier nicht verfügbar. Du kannst trotzdem beitreten.</p>}
    {(microphone ? ['audio', 'video'] as const : ['video'] as const).map(kind => <div key={kind} className={styles.device}>
      <label>{kind === 'audio' ? 'Mikrofon' : 'Kamera'}<select aria-label={kind === 'audio' ? 'Mikrofongerät' : 'Kameragerät'} value={kind === 'audio' ? preferences.audioDevice : preferences.videoDevice} onChange={event => { disable(kind); setPreferences(old => ({ ...old, [kind === 'audio' ? 'audioDevice' : 'videoDevice']: event.target.value })); }}>
        <option value="">Standardgerät</option>
        {devices.filter(device => device.kind === (kind === 'audio' ? 'audioinput' : 'videoinput') && device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Gerät ${index + 1}`}</option>)}
      </select></label>
      <div className={styles.buttons}><button type="button" disabled={!supported || pending[kind]} onClick={() => void start(kind)}>{pending[kind] ? 'Freigabe läuft …' : `${kind === 'audio' ? 'Mikrofon' : 'Kamera'} testen`}</button>
      {(active[kind] || pending[kind]) && <button type="button" onClick={() => disable(kind)}>Test stoppen</button>}</div>
      {kind === 'audio' && active.audio && <meter aria-label="Mikrofonpegel" min={0} max={100} value={level} />}
      {messages[kind] && <p role="status">{messages[kind]}</p>}
    </div>)}
    <video ref={video} autoPlay playsInline muted hidden={!active.video} className={styles.preview} aria-label="Lokale Kameravorschau" />
    {microphone && <fieldset><legend>Mikrofonfilter</legend>{(['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const).map((key, index) => <label key={key} className={styles.check}><input type="checkbox" checked={preferences[key]} onChange={event => { disable('audio'); setPreferences(old => ({ ...old, [key]: event.target.checked })); }} />{['Echounterdrückung', 'Rauschunterdrückung', 'Automatische Verstärkung'][index]}</label>)}<p>Änderungen gelten beim nächsten lokalen Test.</p></fieldset>}
    <button type="button" onClick={() => void speakerTest()}>Standardlautsprecher testen</button>
    {messages.speaker && <p role="status">{messages.speaker}</p>}
  </details>;
}
