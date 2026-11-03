// TEST-ONLY harness page for the N10 BiddingPanel. Never served by the app: it lives outside src/ and index.html and is not part of any build.
// It is NOT an engine integration. One page = ONE recipient (?recipient=B1|B2|B3|P1|P2|P3|VIEWER|DISPLAY|HOST|HOSTP): the check script opens several of them in SEPARATE
// browser contexts. The page polls the harness backend for its own projection and hands it to the REAL component; the independent minimum (`minStateVersion`) is held by
// the page itself (window.__harness.setMin), like a snapshot channel of its own. The commandId of an intent is created ONCE per distinct intent and reused when the SAME
// intent is sent again — never swapped behind the user's back (the real intent/receipt contract).
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import { biddingActionBindingKey, type BiddingBidIntent, type BiddingExpectedContext, type BiddingPassIntent, type BiddingProjection, type BiddingScope } from '@quiz/shared/bidding';
import { BiddingPanel, type BiddingFeedback } from '../../src/components/BiddingPanel';

const params = new URLSearchParams(window.location.search);
const recipient = params.get('recipient') ?? 'VIEWER';
const LONG = 'Ein sehr langer Name mit einem noch längeren Titel, der auf kleinen Bildschirmen mehrfach umbrechen muss ' + 'Donaudampfschifffahrtsgesellschaftskapitänsmütze'.repeat(2);
const NAMES: Record<string, string> = params.get('long') === '1'
  ? { T1: `Team 1 ${LONG}`, T2: `Team 2 ${LONG}`, T3: `Team 3 ${LONG}` }
  : { T1: 'Rote Rakete', T2: 'Blaue Bande', T3: 'Grüne Gams' };

type Sent = { kind: 'BID' | 'PASS'; intent: Record<string, unknown>; commandId: string };
interface Settled { commandId: string; ok: boolean; code?: string }
interface Received { release: string; stateVersion: number; keys: string[]; json: string }
declare global { interface Window { __harness: { calls: Sent[]; settled: Settled[]; received: Received | null; polls: number; ackDelayMs: number; failNext: number;
  holdSends: boolean; pending: Array<() => void>; releaseSends: () => void; context: BiddingScope | null; recipientId: string | null;
  deliver: (raw: unknown) => void; freeze: (on: boolean) => void; setMin: (n: number) => void; errors: string[] } } }
window.__harness = { calls: [], settled: [], holdSends: false, context: null, recipientId: null, pending: [], releaseSends: () => undefined, received: null, polls: 0, ackDelayMs: 0, failNext: 0, deliver: () => undefined, freeze: () => undefined, setMin: () => undefined, errors: [] };
window.__harness.releaseSends = () => { window.__harness.holdSends = false; for (const resume of window.__harness.pending.splice(0)) resume(); };

let reports = 0;
const commandIds = new Map<string, string>();
const idFor = (key: string): string => { let id = commandIds.get(key); if (id === undefined) { id = crypto.randomUUID(); commandIds.set(key, id); } return id; };
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

function App() {
  const [context, setContext] = useState<{ scope: BiddingScope; recipientId: string | null } | null>(null);
  const [payload, setPayload] = useState<BiddingProjection | null>(null);
  const [min, setMin] = useState(Number(params.get('min') ?? 1));
  const [frozen, setFrozen] = useState(false);
  const [feedback, setFeedback] = useState<BiddingFeedback | null>(null);

  useEffect(() => {
    window.__harness.deliver = raw => { setPayload(raw as BiddingProjection | null); };
    window.__harness.freeze = on => setFrozen(on);
    window.__harness.setMin = n => setMin(n);
  }, []);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const info = await (await fetch(`/api/context?recipient=${recipient}`)).json() as { scope: BiddingScope; recipientId: string | null };
        if (live) { setContext(current => (current !== null && JSON.stringify(current) === JSON.stringify(info) ? current : { scope: info.scope, recipientId: info.recipientId })); window.__harness.context = { ...info.scope }; window.__harness.recipientId = info.recipientId; }
      } catch (error) { window.__harness.errors.push(String(error)); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 400); // a new bidding (reset) is a new context; the page follows its own authenticated context
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (frozen) return undefined;
    let live = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/projection?recipient=${recipient}`);
        const raw = await response.json() as BiddingProjection;
        if (!live) return;
        window.__harness.polls++;
        window.__harness.received = { release: raw.release, stateVersion: raw.stateVersion, keys: Object.keys(raw).sort(), json: JSON.stringify(raw) };
        setPayload(raw);
      } catch (error) { if (live) window.__harness.errors.push(String(error)); }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 120);
    return () => { live = false; window.clearInterval(timer); };
  }, [frozen]);

  if (context === null) return null;
  const expected: BiddingExpectedContext = { ...context.scope, recipientId: context.recipientId, minStateVersion: min };
  const post = async (kind: 'BID' | 'PASS', intent: Record<string, unknown>) => {
    const key = `${kind}|${JSON.stringify(intent)}`;
    const sent: Sent = { kind, intent, commandId: idFor(key) };
    window.__harness.calls.push(sent);
    const bindingKey = biddingActionBindingKey(intent as unknown as BiddingPassIntent);
    setFeedback({ bindingKey, status: 'PENDING' });
    const delay = window.__harness.ackDelayMs;
    const fail = window.__harness.failNext > 0;
    if (fail) window.__harness.failNext--;
    try {
      // a DELAYED send: the intent was built (with its origin) when the user clicked; the request leaves only when the check releases it — after the context may have changed
      if (window.__harness.holdSends) await new Promise<void>(resume => { window.__harness.pending.push(resume); });
      const response = await fetch('/api/intent', { method: 'POST', body: JSON.stringify({ kind, recipient, commandId: sent.commandId, intent }) });
      const result = await response.json() as { ok?: boolean; code?: string };
      if (delay > 0) await sleep(delay); // a LATE acknowledgement: the answer reaches the panel long after the server has moved on
      if (fail) throw new Error('NETWORK');
      if (result.ok !== true) throw Object.assign(new Error(result.code ?? 'REFUSED'), { code: result.code });
      window.__harness.settled.push({ commandId: sent.commandId, ok: true });
      setFeedback({ bindingKey, status: 'ACCEPTED' });
    } catch (error) {
      window.__harness.settled.push({ commandId: sent.commandId, ok: false, code: (error as { code?: string }).code ?? String((error as Error).message) });
      setFeedback({ bindingKey, status: 'REJECTED', message: 'Das hat nicht geklappt. Bitte warte kurz und versuche es erneut.', id: ++reports });
      throw error;
    }
  };
  // every recipient gets the callbacks: a viewer, a display, a host and a host who plays as performer must show NO control even though callbacks exist
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 16, maxWidth: 640 }} data-recipient={recipient}>
        <BiddingPanel
          expected={expected} projection={payload} names={NAMES} label={`Bieten für ${recipient}`} feedback={feedback}
          onBid={(intent: BiddingBidIntent) => post('BID', { ...intent })} onPass={(intent: BiddingPassIntent) => post('PASS', { ...intent })}
        />
      </main>
    </ThemeProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
