// TEST-ONLY harness page for the N8 TurnStatusCard. Never served by the app: it lives outside src/ and index.html and is not part of any build.
// It is NOT an engine integration. One page = ONE recipient (?recipient=A|B|C|D|E|VIEWER|DISPLAY): the check script opens several of them in
// SEPARATE browser contexts. The page polls the harness backend for its own projection and hands it to the REAL component; the independent
// minimum (`minStateVersion`) is held by the page itself (window.__harness.setMin), like a snapshot channel of its own.
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import type { TurnSequenceProjection, TurnSequenceExpectedContext } from '@quiz/shared/turnSequence';
import { TurnStatusCard } from '../../src/components/TurnStatusCard';

const params = new URLSearchParams(window.location.search);
const recipient = params.get('recipient') ?? 'VIEWER';
const LONG = 'Ein sehr langer Name mit einem noch längeren Titel, der auf kleinen Bildschirmen mehrfach umbrechen muss ' + 'Donaudampfschifffahrtsgesellschaftskapitänsmütze'.repeat(2);
const NAMES: Record<string, string> = params.get('long') === '1'
  ? { T1: `Team 1 ${LONG}`, T2: `Team 2 ${LONG}`, A: `Ada ${LONG}`, B: `Bo ${LONG}`, C: `Cy ${LONG}`, D: `Di ${LONG}`, E: `Eli ${LONG}` }
  : { T1: 'Rote Rakete', T2: 'Blaue Bande', A: 'Ada', B: 'Bo', C: 'Cy', D: 'Di', E: 'Eli' };

declare global { interface Window { __harness: { calls: Array<{ turnNumber: number; sequenceVersion: number }>; received: { stateVersion: number; sequenceVersion: number; turnNumber: number; release: string } | null; polls: number;
  deliver: (raw: unknown) => void; freeze: (on: boolean) => void; setMin: (n: number) => void; errors: string[] } } }
window.__harness = { calls: [], received: null, polls: 0, deliver: () => undefined, freeze: () => undefined, setMin: () => undefined, errors: [] };

function App() {
  const [context, setContext] = useState<{ scope: TurnSequenceExpectedContext; } | null>(null);
  const [payload, setPayload] = useState<TurnSequenceProjection | null>(null);
  const [min, setMin] = useState(Number(params.get('min') ?? 1));
  const [frozen, setFrozen] = useState(false);

  useEffect(() => {
    window.__harness.deliver = raw => { setPayload(raw as TurnSequenceProjection | null); };
    window.__harness.freeze = on => setFrozen(on);
    window.__harness.setMin = n => setMin(n);
  }, []);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const info = await (await fetch(`/api/context?recipient=${recipient}`)).json() as { scope: Omit<TurnSequenceExpectedContext, 'recipientId' | 'minStateVersion'>; recipientId: string | null };
        if (live) setContext({ scope: { ...info.scope, recipientId: info.recipientId, minStateVersion: 0 } });
      } catch (error) { window.__harness.errors.push(String(error)); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 400); // a new sequence (reset) is a new context; the page follows its own authenticated context
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (frozen) return undefined;
    let live = true;
    const poll = async () => {
      try {
        const raw = await (await fetch(`/api/projection?recipient=${recipient}`)).json() as TurnSequenceProjection;
        if (!live) return;
        window.__harness.polls++;
        window.__harness.received = { stateVersion: raw.stateVersion, sequenceVersion: raw.sequenceVersion, turnNumber: raw.turnNumber, release: raw.release };
        setPayload(raw);
      } catch (error) { window.__harness.errors.push(String(error)); }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 120);
    return () => { live = false; window.clearInterval(timer); };
  }, [frozen]);

  if (context === null) return null;
  const expected: TurnSequenceExpectedContext = { ...context.scope, minStateVersion: min };
  const onAdvance = async (binding: { turnNumber: number; sequenceVersion: number }) => {
    window.__harness.calls.push(binding);
    const result = await (await fetch('/api/advance', { method: 'POST', body: JSON.stringify({ recipient, ...binding }) })).json() as { ok?: boolean; code?: string };
    if (result.ok !== true) throw new Error(result.code ?? 'REFUSED'); // a refused send unlocks the same binding in the card
  };
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 16, maxWidth: 640 }} data-recipient={recipient}>
        <TurnStatusCard expected={expected} projection={payload} names={NAMES} onAdvance={recipient === 'VIEWER' || recipient === 'DISPLAY' ? undefined : onAdvance} label={`Zugfolge für ${recipient}`} />
      </main>
    </ThemeProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
