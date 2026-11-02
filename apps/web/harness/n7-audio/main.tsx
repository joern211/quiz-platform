// TEST-ONLY harness for the N7 ServerAudioPlayer. It lives outside src/ and index.html and is never part of a build. It is NOT an engine
// integration: it only joins the REAL server helpers (via server.ts), the projection, a round-trip clock and the REAL browser controller
// on real HTMLAudioElements. Run: see docs/implementation/n7-audio-playback-foundation/acceptance.md.
//
// URL parameters: role=PLAYER|VIEWER|DISPLAY|HOST|BLIND_HOST (recipient), gate=1 (polling starts only after a real click, which is the user
// activation a real app has from "join room"), analyse=1 (route the element through an AnalyserNode to measure signal level/frequency —
// only in contexts where autoplay is allowed, because a suspended AudioContext would stall the element).
import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import type { AudioPlaybackExpectedContext } from '@quiz/shared/audioPlayback';
import { ServerAudioPlayer } from '../../src/components/ServerAudioPlayer';
import { createServerClock } from '../../src/audioPlayback/serverClock';
import type { AudioLike } from '../../src/audioPlayback/AudioPlaybackController';

interface Rec { el: HTMLAudioElement; analyser: AnalyserNode | null }
interface ProbeEntry { index: number; src: string | null; paused: boolean; currentTimeMs: number; readyState: number; rms: number | null; freqHz: number | null }
declare global { interface Window { __recs: Rec[]; __probe: () => ProbeEntry[]; __log: Array<{ t: number; status: string }>; __renewCalls: number; __errors: string[] } }
window.__recs = []; window.__log = []; window.__renewCalls = 0; window.__errors = [];
window.addEventListener('error', e => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__errors.push(String(e.reason)));

const params = new URLSearchParams(location.search);
const role = params.get('role') ?? 'VIEWER', gated = params.get('gate') === '1', analyse = params.get('analyse') === '1';
let audioContext: AudioContext | null = null;

function createAudio(): AudioLike {
  const el = new Audio();
  let analyser: AnalyserNode | null = null;
  if (analyse) {
    audioContext ??= new AudioContext();
    const source = audioContext.createMediaElementSource(el);
    analyser = audioContext.createAnalyser(); analyser.fftSize = 4096;
    source.connect(analyser); analyser.connect(audioContext.destination);
  }
  window.__recs.push({ el, analyser });
  return el as unknown as AudioLike;
}
window.__probe = () => window.__recs.map((r, index) => {
  let rms: number | null = null, freqHz: number | null = null;
  if (r.analyser && audioContext) {
    const buf = new Float32Array(r.analyser.fftSize); r.analyser.getFloatTimeDomainData(buf);
    rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
    let crossings = 0; for (let i = 1; i < buf.length; i++) if (buf[i - 1] <= 0 && buf[i] > 0) crossings++;
    freqHz = rms > 0.01 ? crossings / (buf.length / audioContext.sampleRate) : null;
  }
  return { index, src: r.el.getAttribute('src'), paused: r.el.paused, currentTimeMs: Math.round(r.el.currentTime * 1000), readyState: r.el.readyState, rms, freqHz };
});

const clock = createServerClock();
async function sample(): Promise<void> {
  const sent = performance.now();
  const body = await (await fetch('/api/time')).json() as { serverMs: number };
  clock.addSample({ sentMonoMs: sent, receivedMonoMs: performance.now(), serverMs: body.serverMs });
}

function App() {
  const [started, setStarted] = useState(!gated);
  const [expected, setExpected] = useState<AudioPlaybackExpectedContext | null>(null);
  const [projection, setProjection] = useState<unknown>(null);
  useEffect(() => {
    if (!started) return;
    let alive = true;
    for (let i = 0; i < 4; i++) setTimeout(() => { void sample(); }, i * 120);
    const sampler = setInterval(() => { void sample(); }, 3000);
    const poll = async () => {
      try {
        const [c, p] = await Promise.all([fetch('/api/context').then(r => r.json()), fetch(`/api/projection?role=${role}`).then(r => r.json())]);
        if (alive) { setExpected({ ...c.scope, minStateVersion: c.minStateVersion }); setProjection(p); }
      } catch { /* backend restarting: keep what we have */ }
    };
    void poll();
    const poller = setInterval(() => { void poll(); }, 150);
    return () => { alive = false; clearInterval(poller); clearInterval(sampler); };
  }, [started]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const status = document.querySelector('[data-status]')?.getAttribute('data-status') ?? 'none';
      if (window.__log.at(-1)?.status !== status) window.__log.push({ t: performance.now(), status });
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-status'], childList: true });
    return () => observer.disconnect();
  }, []);
  const onRenewUrl = useMemo(() => () => { window.__renewCalls++; void fetch('/api/cmd', { method: 'POST', body: JSON.stringify({ type: 'renew' }) }); }, []);
  return (
    <main style={{ padding: 16, maxWidth: 560 }}>
      <p data-role>Empfänger: {role}</p>
      {!started && <button type="button" data-action="join" onClick={() => { void audioContext?.resume(); setStarted(true); }}>Raum betreten</button>}
      {expected && <ServerAudioPlayer expected={expected} projection={projection} clock={clock} label={params.get('label') ?? 'Audio zur Runde'} onRenewUrl={onRenewUrl} createAudio={createAudio} />}
    </main>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ThemeProvider><App /></ThemeProvider></React.StrictMode>);
