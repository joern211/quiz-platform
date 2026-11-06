// TEST-ONLY harness page for the N11 BoardView. Never served by the app: it lives outside src/ and index.html and is not part of any build.
// It is NOT an engine integration. One page = ONE recipient (?recipient=P1|P2|P3|VIEWER|DISPLAY|HOST): the check script opens several of them in SEPARATE browser
// contexts. The page polls the harness backend for its own projection and hands it to the REAL component; the independent minimum (`minStateVersion`) is held by the
// page itself (window.__harness.setMin), like a snapshot channel of its own. The commandId of an intent is created ONCE per distinct intent and reused when the SAME
// intent is sent again — never swapped behind the user's back (the real intent/receipt contract).
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@quiz/ui';
import '@quiz/ui/styles/tokens.css';
import '../../src/index.css';
import type { BoardExpectedContext, BoardMoveIntent, BoardProjection } from '@quiz/shared/board';
import { BoardView } from '../../src/components/BoardView';

const params = new URLSearchParams(window.location.search);
const recipient = params.get('recipient') ?? 'VIEWER';
const LONG = 'Ein sehr langer Name mit einem noch längeren Titel, der auf kleinen Bildschirmen mehrfach umbrechen muss ' + 'Donaudampfschifffahrtsgesellschaftskapitänsmütze'.repeat(2);
const NAMES: Record<string, string> = params.get('long') === '1' ? { P1: `Ada ${LONG}`, P2: `Bo ${LONG}`, P3: `Cy ${LONG}` } : { P1: 'Ada', P2: 'Bo', P3: 'Cy' };

type Sent = { intent: Record<string, unknown>; commandId: string; attemptId: string };
interface Settled { commandId: string; attemptId: string; ok: boolean }
interface Received { stateVersion: number; sequenceVersion: number; turnNumber: number; boardVersion: number; release: string; boardId: string; scope: { runIndex: number; sequenceId: string; rosterRevision: string; unit: string }; roll: { diceId: string; rollCount: number; spent: boolean } | null }
declare global { interface Window { __harness: { calls: Sent[]; settled: Settled[]; received: Received | null; polls: number; ackDelayMs: number; failNext: number;
  holdSends: boolean; pending: Array<() => void>; releaseSends: () => void;
  context: { runIndex: number; sequenceId: string; rosterRevision: string; unit: string; boardId: string } | null;
  deliver: (raw: unknown) => void; freeze: (on: boolean) => void; setMin: (n: number) => void; errors: string[] } } }
window.__harness = { calls: [], settled: [], holdSends: false, context: null, pending: [], releaseSends: () => undefined, received: null, polls: 0, ackDelayMs: 0, failNext: 0, deliver: () => undefined, freeze: () => undefined, setMin: () => undefined, errors: [] };
window.__harness.releaseSends = () => { window.__harness.holdSends = false; for (const resume of window.__harness.pending.splice(0)) resume(); };

const commandIds = new Map<string, string>();
const idFor = (key: string): string => { let id = commandIds.get(key); if (id === undefined) { id = crypto.randomUUID(); commandIds.set(key, id); } return id; };
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

function App() {
  const [context, setContext] = useState<Omit<BoardExpectedContext, 'minStateVersion'> | null>(null);
  const [payload, setPayload] = useState<BoardProjection | null>(null);
  const [min, setMin] = useState(Number(params.get('min') ?? 1));
  const [frozen, setFrozen] = useState(false);

  useEffect(() => {
    window.__harness.deliver = raw => { setPayload(raw as BoardProjection | null); };
    window.__harness.freeze = on => setFrozen(on);
    window.__harness.setMin = n => setMin(n);
  }, []);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const info = await (await fetch(`/api/context?recipient=${recipient}`)).json() as { scope: { runIndex: number; sequenceId: string; rosterRevision: string; unit: 'PLAYER' | 'TEAM' }; boardId: string; recipientId: string | null };
        if (live) { setContext({ ...info.scope, boardId: info.boardId, recipientId: info.recipientId }); window.__harness.context = { ...info.scope, boardId: info.boardId }; }
      } catch (error) { window.__harness.errors.push(String(error)); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 400); // a new board / sequence (reset) is a new context; the page follows its own authenticated context
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (frozen) return undefined;
    let live = true;
    const poll = async () => {
      try {
        const raw = await (await fetch(`/api/projection?recipient=${recipient}`)).json() as BoardProjection;
        if (!live) return;
        window.__harness.polls++;
        window.__harness.received = {
          stateVersion: raw.stateVersion, sequenceVersion: raw.sequenceVersion, turnNumber: raw.turnNumber, boardVersion: raw.boardVersion, release: raw.release, boardId: raw.boardId, scope: { ...raw.scope },
          roll: raw.release === 'FIGURES' && raw.roll ? { diceId: raw.roll.diceId, rollCount: raw.roll.rollCount, spent: raw.roll.spent } : null,
        };
        setPayload(raw);
      } catch (error) { if (live) window.__harness.errors.push(String(error)); }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 120);
    return () => { live = false; window.clearInterval(timer); };
  }, [frozen]);

  if (context === null) return null;
  const expected: BoardExpectedContext = { ...context, minStateVersion: min };
  const onMove = async (intent: BoardMoveIntent, attempt: { attemptId: string }) => {
    const key = JSON.stringify(intent);
    const sent: Sent = { intent: { ...intent }, commandId: idFor(key), attemptId: attempt.attemptId };
    window.__harness.calls.push(sent);
    const delay = window.__harness.ackDelayMs;
    const fail = window.__harness.failNext > 0;
    if (fail) window.__harness.failNext--;
    try {
      // a DELAYED send: the intent was built (with its origin) when the user clicked; the request leaves only when the check releases it — after the context may have changed
      if (window.__harness.holdSends) await new Promise<void>(resume => { window.__harness.pending.push(resume); });
      const response = await fetch('/api/intent', { method: 'POST', body: JSON.stringify({ recipient, commandId: sent.commandId, intent }) });
      const result = await response.json() as { ok?: boolean; code?: string };
      if (delay > 0) await sleep(delay); // a LATE acknowledgement
      if (fail) throw new Error('NETWORK');
      if (result.ok !== true) throw new Error(result.code ?? 'REFUSED'); // a refused send releases the same attempt in the view
      window.__harness.settled.push({ commandId: sent.commandId, attemptId: sent.attemptId, ok: true });
    } catch (error) { window.__harness.settled.push({ commandId: sent.commandId, attemptId: sent.attemptId, ok: false }); throw error; }
  };
  const readOnly = recipient === 'VIEWER' || recipient === 'DISPLAY';
  return (
    <ThemeProvider>
      <main style={{ padding: 16, display: 'grid', gap: 16, maxWidth: 720 }} data-recipient={recipient}>
        <BoardView expected={expected} projection={payload} names={NAMES} onMove={readOnly ? undefined : onMove} label={`Brett für ${recipient}`} />
      </main>
    </ThemeProvider>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
