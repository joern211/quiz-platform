// TEST-ONLY backend for the N8 turn harness. It binds the REAL server domain (turnSequence.ts) to a tiny HTTP API so that several real Chromium
// contexts can receive the projection of ONE sequence. It is not a product endpoint, has no authentication and lives outside src/: it is never
// part of a build. The "recipient" query parameter stands in for the admitted session of a later consumer (identity and team come from the
// server-side table below, never from the request body); the real authentication/admission/phase checks are NOT exercised here.
// It is NOT an engine consumer. Run: node --import tsx apps/web/harness/n8-turn/server.ts [port]
import http from 'node:http';
import {
  advanceTurnSequence, authorizeTurnAction, closeTurnSequence, currentTurnHolder, overrideTurnSequence, prepareTurnSequence, projectTurnSequence, startTurnSequence,
  turnSequenceScopeOf, withholdCurrentHolder, type TurnEligibility, type TurnSequenceState,
} from '../../../server/src/games/core/turnSequence.js';
import type { ProjectionAudience } from '../../../server/src/games/core/visibility.js';
import type { TurnSequenceRelease } from '@quiz/shared/turnSequence';

const port = Number(process.argv[2] ?? 5194);
const TEAMS = [{ teamId: 'T1', members: ['A', 'B'] }, { teamId: 'T2', members: ['C', 'D', 'E'] }];
const AUDIENCES: Record<string, ProjectionAudience> = {
  A: { role: 'PLAYER', participantId: 'A', teamId: 'T1' }, B: { role: 'PLAYER', participantId: 'B', teamId: 'T1' }, C: { role: 'PLAYER', participantId: 'C', teamId: 'T2' },
  D: { role: 'PLAYER', participantId: 'D', teamId: 'T2' }, E: { role: 'PLAYER', participantId: 'E', teamId: 'T2' }, VIEWER: { role: 'VIEWER' }, DISPLAY: { role: 'DISPLAY' }, HOST: { role: 'HOST' },
};
const DEFAULT_RELEASE: Record<string, TurnSequenceRelease> = { A: 'CURRENT', B: 'CURRENT', C: 'CURRENT', D: 'CURRENT', E: 'CURRENT', VIEWER: 'ORDER', DISPLAY: 'ORDER', HOST: 'CURRENT' };

let state: TurnSequenceState;
let stateVersion = 1;
let counter = 0;
let eligibility: { teams: string[]; members: string[]; version: number };
let release: Record<string, TurnSequenceRelease>;
let paused = false;
/** What the SERVER really did, for the browser check to read back (a label or a sent command proves nothing). */
let log: Array<{ kind: string; ok: boolean; code?: string; turnNumber?: number; version?: number }> = [];

const elig = (): TurnEligibility => ({
  actors: { trackId: 'teams-track', rosterRevision: 'track-roster-1', version: eligibility.version, knownIds: ['T1', 'T2'], activeIds: eligibility.teams },
  members: { trackId: 'members-track', rosterRevision: 'track-roster-1', version: eligibility.version, knownIds: ['A', 'B', 'C', 'D', 'E'], activeIds: eligibility.members },
});
function reset(): void {
  counter++;
  eligibility = { teams: ['T1', 'T2'], members: ['A', 'B', 'C', 'D', 'E'], version: 1 };
  release = { ...DEFAULT_RELEASE };
  paused = false; log = [];
  const prepared = prepareTurnSequence({ runIndex: 1, sequenceId: `seq-${counter}`, rosterRevision: 'roster-1', unit: 'TEAM', mode: 'FIXED', order: ['T1', 'T2'], teams: TEAMS });
  state = startTurnSequence(prepared, { scope: turnSequenceScopeOf(prepared), expectedVersion: 0, eligibility: elig() }).state;
  stateVersion++;
}
const view = () => {
  const holder = currentTurnHolder(state);
  return {
    stateVersion, version: state.version, turnNumber: state.turnNumber, phase: state.phase, completedTurns: state.completedTurns, cycle: state.cycle, entitlementRevision: state.entitlementRevision,
    holder: holder === null ? null : `${holder.teamId}/${holder.playerId}`, cursors: (state.teams ?? []).map(t => t.cursor), release, paused, log,
  };
};
const binding = () => ({ expectedVersion: state.version, expectedTurnNumber: state.turnNumber });

function apply(kind: string, run: () => { state: TurnSequenceState; changed: boolean }): object {
  try {
    const result = run();
    if (result.changed) { state = result.state; stateVersion++; }
    log.push({ kind, ok: true, turnNumber: state.turnNumber, version: state.version });
    return { ok: true, changed: result.changed, ...view() };
  } catch (error) {
    const code = (error as { code?: string }).code ?? String((error as Error).message);
    log.push({ kind, ok: false, code });
    return { ok: false, code, ...view() };
  }
}

function host(body: Record<string, unknown>): object {
  const scope = turnSequenceScopeOf(state);
  switch (body.type) {
    case 'reset': reset(); return { ok: true, ...view() };
    case 'skip': return apply('skip', () => advanceTurnSequence(state, { scope, ...binding(), outcome: 'SKIP', eligibility: elig() }));
    case 'complete': return apply('host-complete', () => advanceTurnSequence(state, { scope, ...binding(), outcome: 'COMPLETE', eligibility: elig() }));
    case 'withhold': return apply('withhold', () => withholdCurrentHolder(state, { scope, ...binding(), eligibility: elig() }));
    case 'override': return apply('override', () => overrideTurnSequence(state, { scope, ...binding(), target: { teamId: String(body.teamId), playerId: String(body.playerId) }, eligibility: elig(), now: Date.now(), reason: 'harness' }));
    case 'close': return apply('close', () => closeTurnSequence(state, { scope, expectedVersion: state.version }));
    case 'eligibility': {
      eligibility = { teams: body.teams as string[], members: body.members as string[], version: eligibility.version + 1 };
      return { ok: true, ...view() };
    }
    case 'release': release[String(body.recipient)] = body.release as TurnSequenceRelease; stateVersion++; return { ok: true, ...view() };
    case 'pause': paused = body.on === true; return { ok: true, ...view() };
    default: throw new Error('unknown host command');
  }
}
/** The recipient's own intent: authorise through the real check (identity from the server-side table, NOT from the body), then complete the turn. */
function advance(body: { recipient: string; turnNumber: number; sequenceVersion: number }): object {
  const audience = AUDIENCES[body.recipient];
  if (!audience) throw new Error('unknown recipient');
  const scope = turnSequenceScopeOf(state);
  return apply('advance', () => {
    authorizeTurnAction(state, {
      scope, expectedVersion: body.sequenceVersion, expectedTurnNumber: body.turnNumber,
      caller: { role: audience.role as 'PLAYER', participantId: audience.participantId ?? 'none', teamId: audience.teamId ?? null },
      gate: { admitted: true, phaseOpen: true, paused }, eligibility: elig(),
    });
    return advanceTurnSequence(state, { scope, expectedVersion: body.sequenceVersion, expectedTurnNumber: body.turnNumber, outcome: 'COMPLETE', eligibility: elig() });
  });
}

const send = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req: http.IncomingMessage) => new Promise<string>(resolve => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); });

reset();
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/state') return send(res, 200, view());
    if (url.pathname === '/api/context') {
      const recipient = url.searchParams.get('recipient') ?? 'VIEWER';
      return send(res, 200, { scope: turnSequenceScopeOf(state), recipientId: AUDIENCES[recipient]?.participantId ?? null });
    }
    if (url.pathname === '/api/projection') {
      const recipient = url.searchParams.get('recipient') ?? 'VIEWER';
      return send(res, 200, projectTurnSequence(AUDIENCES[recipient], state, { scope: turnSequenceScopeOf(state), release: release[recipient] ?? 'NONE', stateVersion }));
    }
    if (url.pathname === '/api/host' && req.method === 'POST') return send(res, 200, host(JSON.parse(await readBody(req))));
    if (url.pathname === '/api/advance' && req.method === 'POST') return send(res, 200, advance(JSON.parse(await readBody(req))));
    res.writeHead(404); res.end();
  } catch (error) { send(res, 400, { error: String((error as Error).message) }); }
// eslint-disable-next-line no-console -- test-only harness: the check script waits for this port
}).listen(port, '127.0.0.1', () => console.log(`n8 harness backend on ${port}`));
