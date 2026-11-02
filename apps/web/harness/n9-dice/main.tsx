// TEST-ONLY harness page for the N9 DiceTray. Never served by the app: it lives outside src/ and index.html and is not part of any build.
// It is NOT an engine integration. One page = ONE recipient (?recipient=A|B|C|D|E|VIEWER|DISPLAY): the check script opens several of them in SEPARATE browser
// contexts. The page polls the harness backend for its own projection and hands it to the REAL component; the independent minimum (`minStateVersion`) is
// held by the page itself (window.__harness.setMin), like a snapshot channel of its own. The commandId of an intent is created ONCE per distinct intent and
// reused when the SAME intent is sent again — never swapped behind the user's back (the real intent/receipt contract).
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import type { DiceExpectedContext, DiceHoldIntent, DiceProjection, DiceRollIntent } from '@quiz/shared/dice';
import { DiceTray } from '../../src/components/DiceTray';

const params = new URLSearchParams(window.location.search);
const recipient = params.get('recipient') ?? 'VIEWER';
const LONG = 'Ein sehr langer Name mit einem noch längeren Titel, der auf kleinen Bildschirmen mehrfach umbrechen muss ' + 'Donaudampfschifffahrtsgesellschaftskapitänsmütze'.repeat(2);
const NAMES: Record<string, string> = params.get('long') === '1'
  ? { T1: `Team 1 ${LONG}`, T2: `Team 2 ${LONG}`, A: `Ada ${LONG}`, B: `Bo ${LONG}`, C: `Cy ${LONG}`, D: `Di ${LONG}`, E: `Eli ${LONG}` }
  : { T1: 'Rote Rakete', T2: 'Blaue Bande', A: 'Ada', B: 'Bo', C: 'Cy', D: 'Di', E: 'Eli' };

type Sent = { kind: 'ROLL' | 'HOLD'; intent: Record<string, unknown>; commandId: string };
interface Settled { commandId: string; ok: boolean }
interface Received { stateVersion: number; sequenceVersion: number; turnNumber: number; diceVersion: number; rollCount: number; release: string }
declare global { interface Window { __harness: { calls: Sent[]; settled: Settled[]; received: Received | null; polls: number; ackDelayMs: number; failNext: number;
  deliver: (raw: unknown) => void; freeze: (on: boolean) => void; setMin: (n: number) => void; errors: string[]; animationEnds: number } } }
window.__harness = { calls: [], settled: [], received: null, polls: 0, ackDelayMs: 0, failNext: 0, deliver: () => undefined, freeze: () => undefined, setMin: () => undefined, errors: [], animationEnds: 0 };
document.addEventListener('animationend', () => { window.__harness.animationEnds++; }, true); // observation only: the component itself has no such handler

const commandIds = new Map<string, string>();
const idFor = (key: string): string => { let id = commandIds.get(key); if (id === undefined) { id = crypto.randomUUID(); commandIds.set(key, id); } return id; };
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

function App() {
  const [context, setContext] = useState<{ scope: DiceExpectedContext } | null>(null);
  const [payload, setPayload] = useState<DiceProjection | null>(null);
  const [min, setMin] = useState(Number(params.get('min') ?? 1));
  const [frozen, setFrozen] = useState(false);

  useEffect(() => {
    window.__harness.deliver = raw => { setPayload(raw as DiceProjection | null); };
    window.__harness.freeze = on => setFrozen(on);
    window.__harness.setMin = n => setMin(n);
  }, []);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const info = await (await fetch(`/api/context?recipient=${recipient}`)).json() as { scope: Omit<DiceExpectedContext, 'recipientId' | 'minStateVersion'>; recipientId: string | null };
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
        const raw = await (await fetch(`/api/projection?recipient=${recipient}`)).json() as DiceProjection;
        if (!live) return;
        window.__harness.polls++;
        window.__harness.received = { stateVersion: raw.stateVersion, sequenceVersion: raw.sequenceVersion, turnNumber: raw.turnNumber, diceVersion: raw.diceVersion, rollCount: raw.rollCount, release: raw.release };
        setPayload(raw);
      } catch (error) { if (live) window.__harness.errors.push(String(error)); }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 120);
    return () => { live = false; window.clearInterval(timer); };
  }, [frozen]);

  if (context === null) return null;
  const expected: DiceExpectedContext = { ...context.scope, minStateVersion: min };
  const post = async (kind: 'ROLL' | 'HOLD', intent: Record<string, unknown>) => {
    const key = `${kind}|${JSON.stringify(intent)}`;
    const sent: Sent = { kind, intent, commandId: idFor(key) };
    window.__harness.calls.push(sent);
    const delay = window.__harness.ackDelayMs;
    const fail = window.__harness.failNext > 0;
    if (fail) window.__harness.failNext--;
    try {
      const response = await fetch('/api/intent', { method: 'POST', body: JSON.stringify({ kind, recipient, commandId: sent.commandId, intent }) });
      const result = await response.json() as { ok?: boolean; code?: string };
      if (delay > 0) await sleep(delay); // a LATE acknowledgement: the answer reaches the tray long after the server has moved on
      if (fail) throw new Error('NETWORK');
      if (result.ok !== true) throw new Error(result.code ?? 'REFUSED'); // a refused send unlocks the same binding in the tray
      window.__harness.settled.push({ commandId: sent.commandId, ok: true });
    } catch (error) { window.__harness.settled.push({ commandId: sent.commandId, ok: false }); throw error; }
  };
  const onRoll = (intent: DiceRollIntent) => post('ROLL', { ...intent });
  const onHold = (intent: DiceHoldIntent) => post('HOLD', { ...intent });
  const readOnly = recipient === 'VIEWER' || recipient === 'DISPLAY';
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 16, maxWidth: 640 }} data-recipient={recipient}>
        <DiceTray expected={expected} projection={payload} names={NAMES} onRoll={readOnly ? undefined : onRoll} onHold={readOnly ? undefined : onHold} label={`Würfel für ${recipient}`} />
      </main>
    </ThemeProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
