// TEST-ONLY harness for the N6 ParticipationStatusCard with ARTIFICIAL data. Never served by the app: it lives outside src/ and
// index.html and is not part of any build. It is NOT an engine integration. Run: see docs/implementation/n6-participation-foundation/acceptance.md.
import React, { Profiler, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import { PARTICIPATION_CONTRACT, type ParticipationActorView, type ParticipationExpectedContext, type ParticipationProjection } from '@quiz/shared/participation';
import { ParticipationStatusCard } from '../../src/components/ParticipationStatusCard';

const SCOPE = { runIndex: 1, trackId: 'track-1', rosterRevision: 'roster-1', actorKind: 'PARTICIPANT' as const };
const EXPECTED: ParticipationExpectedContext = { ...SCOPE, actorId: 'p1', minStateVersion: 1 };
type Lives = number | 'HIDDEN' | 'NO_MODEL';
const view = (actorId: string, status: 'ACTIVE' | 'ELIMINATED', lives: Lives): ParticipationActorView =>
  ({ actorId, status, lives: lives === 'HIDDEN' ? { state: 'HIDDEN' } : lives === 'NO_MODEL' ? { state: 'NO_MODEL' } : { state: 'VALUE', value: lives } });
const projection = (own: ParticipationActorView | null, publicPart: ParticipationActorView[] = [], stateVersion = 5, scope = SCOPE): ParticipationProjection =>
  ({ contract: PARTICIPATION_CONTRACT, scope: { ...scope }, stateVersion, own, public: publicPart });
const solo = (own: ParticipationActorView, actorId = 'p1') => ({ expected: { ...EXPECTED, actorId }, projection: projection(own) });

declare global { interface Window { __log: string[] } }
window.__log = [];

/** Context switching with a late old snapshot, another run, another actor, a withdrawal and a viewer-like projection. */
function Switching() {
  // the caller's own, independent expectation: actor, run and the oldest snapshot it accepts (kept apart, as a real caller's snapshot channel would)
  const [target, setTarget] = useState({ actorId: 'p1', runIndex: 1 });
  const [min, setMin] = useState(1);
  const expected: ParticipationExpectedContext = { ...EXPECTED, ...target, minStateVersion: min };
  const [payload, setPayload] = useState<ParticipationProjection | null>(projection(view('p1', 'ACTIVE', 2), [view('p1', 'ACTIVE', 'HIDDEN'), view('p2', 'ELIMINATED', 'HIDDEN')], 4));
  return (
    <section data-case="switch">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button type="button" data-action="newer" onClick={() => setPayload(projection(view('p1', 'ELIMINATED', 0), [view('p1', 'ELIMINATED', 'HIDDEN'), view('p2', 'ELIMINATED', 'HIDDEN')], 6))}>Neuerer Snapshot (v6)</button>
        <button type="button" data-action="late" onClick={() => setPayload(projection(view('p1', 'ACTIVE', 2), [view('p1', 'ACTIVE', 'HIDDEN'), view('p2', 'ELIMINATED', 'HIDDEN')], 4))}>Später alter Snapshot (v4)</button>
        <button type="button" data-action="raise" onClick={() => setMin(6)}>Erwarteten Stand anheben (min 6)</button>
        <button type="button" data-action="other-actor" onClick={() => setTarget(t => ({ ...t, actorId: 'p2' }))}>Anderer Akteur (p2)</button>
        <button type="button" data-action="back" onClick={() => setTarget({ actorId: 'p1', runIndex: 1 })}>Zurück zu p1</button>
        <button type="button" data-action="new-run" onClick={() => setTarget(t => ({ ...t, runIndex: 2 }))}>Neuer Run, alte Projektion bleibt</button>
        <button type="button" data-action="withdraw" onClick={() => setPayload(null)}>Entziehen</button>
        <button type="button" data-action="regain" onClick={() => setPayload(projection(view('p1', 'ACTIVE', 3), [], 3))}>Wieder erhalten (v3)</button>
        <button type="button" data-action="viewer" onClick={() => setPayload(projection(null, [view('p1', 'ELIMINATED', 'HIDDEN')], 7))}>Viewer-Sicht</button>
      </div>
      <Profiler id="switch" onRender={() => { window.__log.push(document.querySelector('[data-case=switch] > section')?.textContent ?? ''); }}>
        <ParticipationStatusCard expected={expected} projection={payload} label="Wechselnder Kontext" />
      </Profiler>
    </section>
  );
}

const LONG = 'Ein sehr langer Name mit einem noch längeren Titel der Karte, der auf kleinen Bildschirmen mehrfach umbrechen muss ' + 'Donaudampfschifffahrtsgesellschaftskapitänsmütze'.repeat(3);
function App() {
  const c = {
    active: solo(view('p1', 'ACTIVE', 3)), zero: solo(view('p1', 'ACTIVE', 0)), eliminatedLives: solo(view('p1', 'ELIMINATED', 3)), eliminatedZero: solo(view('p1', 'ELIMINATED', 0)),
    nomodel: solo(view('p1', 'ACTIVE', 'NO_MODEL')),
    hidden: { expected: { ...EXPECTED, actorId: 'p2' }, projection: projection(view('p1', 'ACTIVE', 777), [view('p1', 'ACTIVE', 'HIDDEN'), view('p2', 'ELIMINATED', 'HIDDEN')]) },
    unavailable: { expected: EXPECTED, projection: null },
    stale: { expected: { ...EXPECTED, minStateVersion: 9 }, projection: projection(view('p1', 'ACTIVE', 3), [], 4) },
  };
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 24, maxWidth: 640 }}>
        <section data-case="active"><ParticipationStatusCard {...c.active} label="Aktiv mit Leben" /></section>
        <section data-case="zero"><ParticipationStatusCard {...c.zero} label="Aktiv bei 0 Leben" /></section>
        <section data-case="eliminated-lives"><ParticipationStatusCard {...c.eliminatedLives} label="Ausgeschieden mit Restleben" /></section>
        <section data-case="eliminated-zero"><ParticipationStatusCard {...c.eliminatedZero} label="Ausgeschieden bei 0 Leben" /></section>
        <section data-case="nomodel"><ParticipationStatusCard {...c.nomodel} label="Ohne Lebensmodell" /></section>
        <section data-case="hidden"><ParticipationStatusCard {...c.hidden} label="Öffentlich, Leben verborgen" /></section>
        <section data-case="unavailable"><ParticipationStatusCard {...c.unavailable} label="Nicht verfügbar" /></section>
        <section data-case="stale"><ParticipationStatusCard {...c.stale} label="Veralteter Snapshot" /></section>
        <section data-case="long"><ParticipationStatusCard {...c.active} label={LONG} /></section>
        <Switching />
      </main>
    </ThemeProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
