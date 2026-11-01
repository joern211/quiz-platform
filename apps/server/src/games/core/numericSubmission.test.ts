import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SubmissionRecordSchema, type CoreTimer } from '@quiz/shared';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { numericConfigKey, type NumericInputConfig, type NumericValue } from '@quiz/shared/numeric';
import { gameErrorCode } from './errors.js';
import { getGameEngineContract } from './engineContract.js';
import { createTimer, pauseTimer, resumeTimer, submitOnce, endTimer } from './runtimePrimitives.js';
import { createWerIstDasState } from '../weristdas/state.js';
import type { CoreActionContext } from './actionRules.js';
import {
  NumericRoundStateSchema, createNumericRound, judgeNumeric, lockNumericRound, numericScopeOf, parseNumericRoundState, projectNumericRound,
  submitNumeric, type NumericRoundState,
} from './numericSubmission.js';

const v = (units: number, scale: 0 | 1 = 0): NumericValue => ({ units, scale });
const config: NumericInputConfig = { schemaVersion: 1, scale: 1, min: v(-1000, 1), max: v(77777, 1), unit: { label: 'Mio. Euro', factor: 1_000_000 }, boundsDisclosure: 'PRIVATE' };
const fresh = (over: Partial<{ runIndex: number; roundId: string }> = {}) => createNumericRound({ runIndex: 2, roundId: 'round-7', config, ...over });
const timer = createTimer('COUNTDOWN', 1000, 20000); // closed at 21000
const submit = (state: NumericRoundState, participantId: string, input: unknown, now = 5000, t: CoreTimer = timer) =>
  submitNumeric(state, { scope: numericScopeOf(state), participantId, input, timer: t, now });
const rule = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return 'NO_ERROR'; };

describe('N1 numeric submission lifecycle', () => {
  it('stores a validated value bound to participant, run, round and config; 0 and negatives are real answers', () => {
    const s0 = fresh();
    const s1 = submit(s0, 'p-zero', v(0, 1));
    const s2 = submit(s1, 'p-neg', v(-25, 1));
    expect(s2.submissions['p-zero']).toMatchObject({ kind: 'NUMERIC', value: v(0, 1), status: 'SUBMITTED', submittedAtMs: 5000, judgedAtMs: null, decision: null });
    expect(s2.submissions['p-neg'].value).toEqual(v(-25, 1));
    expect(Object.keys(s2.submissions)).toEqual(['p-zero', 'p-neg']);
    expect(s0.submissions).toEqual({}); // inputs are never mutated
    expect(s1.submissions).not.toHaveProperty('p-neg');
  });
  it('rejects invalid values as technical errors without storing anything and without a score effect', () => {
    const s0 = fresh();
    expect(rule(() => submit(s0, 'p', v(77778, 1)))).toBe('NUMERIC_OUT_OF_RANGE');
    expect(rule(() => submit(s0, 'p', v(5, 0)))).toBe('NUMERIC_SCALE_MISMATCH');
    expect(rule(() => submit(s0, 'p', null))).toBe('NUMERIC_MISSING');
    expect(rule(() => submit(s0, 'p', '12'))).toBe('NUMERIC_WRONG_TYPE');
    expect(rule(() => submit(s0, 'p', 12))).toBe('NUMERIC_WRONG_TYPE');
    expect(rule(() => submit(s0, 'p', { units: 1.5, scale: 1 }))).toBe('NUMERIC_INVALID_FORMAT');
    expect(rule(() => submit(s0, 'p', { units: 1, scale: 1, target: 5 }))).toBe('NUMERIC_INVALID_FORMAT');
    expect(s0.submissions).toEqual({});
    for (const input of [v(77778, 1), { units: 1.5, scale: 1 }]) {
      try { submit(s0, 'p', input); } catch (e) { expect(JSON.stringify([gameErrorCode(e), (e as Error).message])).not.toMatch(/77777|77778/); }
    }
  });
  it('allows the answer exactly up to the last open millisecond; the deadline itself, pause and expiry reject', () => {
    const s0 = fresh();
    expect(submit(s0, 'a', v(1, 1), 20999).submissions.a.submittedAtMs).toBe(20999);
    expect(rule(() => submit(s0, 'a', v(1, 1), 21000))).toBe('TIME_EXPIRED');
    expect(rule(() => submit(s0, 'a', v(1, 1), 99999))).toBe('TIME_EXPIRED');
    const paused = pauseTimer(timer, 3000);
    expect(rule(() => submit(s0, 'a', v(1, 1), 3500, paused))).toBe('TIME_EXPIRED');
    const resumed = resumeTimer(paused, 10000);
    expect(submit(s0, 'a', v(1, 1), 10500, resumed).submissions.a.submittedAtMs).toBe(10500);
    expect(rule(() => submit(s0, 'a', v(1, 1), 4000, endTimer(timer, 4000)))).toBe('TIME_EXPIRED');
    expect(rule(() => submit(s0, 'a', v(1, 1), -1))).toBe('INVALID_TIME');
    expect(rule(() => submit(s0, 'a', v(1, 1), 1.5))).toBe('INVALID_TIME');
  });
  it('does not let a second ordinary submission overwrite a binding one', () => {
    const s1 = submit(fresh(), 'a', v(100, 1));
    expect(rule(() => submit(s1, 'a', v(200, 1)))).toBe('ALREADY_ANSWERED');
    expect(rule(() => submit(lockNumericRound(s1, numericScopeOf(s1)), 'a', v(200, 1)))).toBe('ALREADY_ANSWERED');
    expect(s1.submissions.a.value).toEqual(v(100, 1));
  });
  it('rejects a wrong scope instead of re-attaching: other run, other round, changed config', () => {
    const s = fresh(), scope = numericScopeOf(s);
    const attempt = (over: Partial<typeof scope>) => rule(() => submitNumeric(s, { scope: { ...scope, ...over }, participantId: 'a', input: v(1, 1), timer, now: 5000 }));
    expect(attempt({ runIndex: 1 })).toBe('STALE_ROUND');
    expect(attempt({ runIndex: 3 })).toBe('STALE_ROUND');
    expect(attempt({ roundId: 'round-6' })).toBe('STALE_ROUND');
    expect(attempt({ configKey: numericConfigKey({ ...config, max: v(77778, 1) }) })).toBe('NUMERIC_CONFIG_STALE');
    expect(attempt({ configKey: numericConfigKey({ ...config, unit: { label: 'Mio. Euro', factor: 1_000 } }) })).toBe('NUMERIC_CONFIG_STALE');
    expect(attempt({})).toBe('NO_ERROR');
    expect(rule(() => lockNumericRound(s, { ...scope, runIndex: 1 }))).toBe('STALE_ROUND');
    expect(rule(() => judgeNumeric(submit(s, 'a', v(1, 1)), { ...scope, roundId: 'x' }, 'a', 'CORRECT', 9000))).toBe('STALE_ROUND');
  });
  it('locks reproducibly and judges once: repetition has no second effect, a different decision is refused', () => {
    const s1 = submit(submit(fresh(), 'a', v(100, 1)), 'b', v(200, 1), 6000);
    const scope = numericScopeOf(s1);
    const locked = lockNumericRound(s1, scope);
    expect(Object.values(locked.submissions).map(r => r.status)).toEqual(['LOCKED', 'LOCKED']);
    expect(Object.values(s1.submissions).map(r => r.status)).toEqual(['SUBMITTED', 'SUBMITTED']);
    expect(lockNumericRound(locked, scope)).toEqual(locked);
    const first = judgeNumeric(locked, scope, 'a', 'CORRECT', 9000);
    expect(first.applied).toBe(true);
    expect(first.state.submissions.a).toMatchObject({ status: 'JUDGED', decision: 'CORRECT', judgedAtMs: 9000, submittedAtMs: 5000 });
    expect(locked.submissions.a.status).toBe('LOCKED');
    const again = judgeNumeric(first.state, scope, 'a', 'CORRECT', 12345);
    expect(again.applied).toBe(false);
    expect(again.state).toEqual(first.state);
    expect(again.state.submissions.a.judgedAtMs).toBe(9000);
    expect(rule(() => judgeNumeric(first.state, scope, 'a', 'WRONG', 12345))).toBe('NUMERIC_ALREADY_JUDGED');
    expect(rule(() => judgeNumeric(first.state, scope, 'ghost', 'WRONG', 12345))).toBe('SUBMISSION_NOT_JUDGEABLE');
    expect(rule(() => judgeNumeric(first.state, scope, '__proto__', 'WRONG', 12345))).toBe('SUBMISSION_NOT_JUDGEABLE');
    expect(lockNumericRound(first.state, scope).submissions.a.status).toBe('JUDGED'); // locking never downgrades
    expect(judgeNumeric(s1, scope, 'b', 'PARTIAL', 7000).applied).toBe(true); // SUBMITTED may be judged directly
  });
  it('roundtrips the persisted state through JSON unchanged', () => {
    const state = judgeNumeric(lockNumericRound(submit(submit(fresh(), 'a', v(-1000, 1)), 'b', v(0, 1), 5100), numericScopeOf(fresh())), numericScopeOf(fresh()), 'a', 'WRONG', 9000).state;
    const decoded = JSON.parse(JSON.stringify(state));
    expect(decoded).toEqual(state);
    expect(NumericRoundStateSchema.parse(decoded)).toEqual(state);
    expect(JSON.stringify(parseNumericRoundState(decoded))).toBe(JSON.stringify(state));
  });
  it('rejects corrupt, foreign, legacy or tampered stored data in a controlled way', () => {
    const good = submit(fresh(), 'a', v(1, 1));
    const bad: unknown[] = [null, undefined, 'x', [], {}, { ...good, kind: 'ROUND' }, { ...good, schemaVersion: 2 }, { ...good, runIndex: 0 },
      { ...good, extra: 1 }, { ...good, config: { ...config, min: v(10, 1), max: v(1, 1) } },
      { ...good, submissions: { a: { ...good.submissions.a, value: v(99999, 1) } } }, // outside pinned bounds
      { ...good, submissions: { a: { ...good.submissions.a, value: v(5, 0) } } }, // wrong scale
      { ...good, submissions: { a: { ...good.submissions.a, value: '5' } } },
      { ...good, submissions: { a: { ...good.submissions.a, value: { units: NaN, scale: 1 } } } },
      { ...good, submissions: { b: good.submissions.a } }, // key ≠ participant
      { ...good, submissions: { a: { ...good.submissions.a, status: 'JUDGED' } } }, // judged without decision
      { ...good, submissions: { a: { ...good.submissions.a, status: 'DRAFT' } } },
      { ...good, submissions: { a: { ...good.submissions.a, decision: 'CORRECT' } } },
      { ...good, submissions: { a: { participantId: 'a', roundId: 'round-7', value: 'A', status: 'SUBMITTED', submittedAtMs: 1, judgedAtMs: null, decision: null } } }]; // legacy record
    for (const raw of bad) {
      expect(rule(() => parseNumericRoundState(raw)), JSON.stringify(raw)).toBe('NUMERIC_STATE_INVALID');
      expect(rule(() => submitNumeric(raw, { scope: numericScopeOf(good), participantId: 'z', input: v(1, 1), timer, now: 5000 })), JSON.stringify(raw)).toBe('NUMERIC_STATE_INVALID');
    }
    expect(rule(() => createNumericRound({ runIndex: 1, roundId: 'r', config: { ...config, min: v(5, 1), max: v(1, 1) } }))).toBe('NUMERIC_CONFIG_INVALID');
    expect(rule(() => createNumericRound({ runIndex: 0, roundId: 'r', config }))).toBe('NUMERIC_STATE_INVALID');
    expect(gameErrorCode(new Error('NUMERIC_STATE_INVALID'))).toBe('NUMERIC_STATE_INVALID');
    expect(gameErrorCode(new Error('NUMERIC_OUT_OF_RANGE'))).toBe('NUMERIC_OUT_OF_RANGE');
  });
});

describe('N1 replay through the existing SDK state events', () => {
  const snapshot = (state: Record<string, unknown>, stateVersion = 0): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 2, gameSlug: 'future-numeric', engineVersion: 1, stateVersion, state });
  it('replays to an identical state without clock, randomness or re-evaluation', () => {
    const s0 = fresh(), s1 = submit(s0, 'a', v(-5, 1)), s2 = judgeNumeric(lockNumericRound(s1, numericScopeOf(s1)), numericScopeOf(s1), 'a', 'CORRECT', 9000).state;
    const base = snapshot({ phase: 'INPUT_OPEN', numeric: s0, scores: { a: 0 } });
    const e1 = createStateEvent(base, { phase: 'INPUT_OPEN', numeric: s1, scores: { a: 0 } }, { eventId: randomUUID(), type: 'NUMERIC_SUBMITTED', commandId: 'c1', actorId: 'a', occurredAtMs: 5000 });
    const after1 = snapshot({ phase: 'INPUT_OPEN', numeric: s1, scores: { a: 0 } }, 1);
    const e2 = createStateEvent(after1, { phase: 'REVEAL', numeric: s2, scores: { a: 100 } }, { eventId: randomUUID(), type: 'NUMERIC_JUDGED', commandId: 'c2', actorId: 'host', occurredAtMs: 9000 });
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const wire = JSON.parse(JSON.stringify([e1, e2]));
      const replayed = applyStateEvent(applyStateEvent(base, wire[0]), wire[1]);
      const replayedAgain = applyStateEvent(applyStateEvent(base, wire[0]), wire[1]);
      expect(replayed).toEqual(replayedAgain);
      expect(replayed.stateVersion).toBe(2);
      expect(parseNumericRoundState(replayed.state.numeric)).toEqual(s2);
      expect(replayed.state.numeric).toEqual(JSON.parse(JSON.stringify(s2)));
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); }
    expect(e1.changes.map(c => c.key)).toEqual(['numeric']); // compact: only the changed top-level key
    expect(JSON.stringify(e1)).not.toMatch(/target/i);
  });
  it('refuses events of another run, game or version, and replay of tampered numeric data is caught on read', () => {
    const base = snapshot({ numeric: fresh() });
    const e = createStateEvent(base, { numeric: submit(fresh(), 'a', v(1, 1)) }, { eventId: randomUUID(), type: 'X', commandId: null, actorId: null, occurredAtMs: 1 });
    expect(() => applyStateEvent({ ...base, runIndex: 3 }, e)).toThrow('EVENT_SCOPE_MISMATCH');
    expect(() => applyStateEvent({ ...base, stateVersion: 5 }, e)).toThrow('EVENT_VERSION_CONFLICT');
    const tampered = { ...e, changes: [{ key: 'numeric', value: { ...submit(fresh(), 'a', v(1, 1)), submissions: { a: { kind: 'NUMERIC' } } } }] };
    const replayed = applyStateEvent(base, tampered);
    expect(rule(() => parseNumericRoundState(replayed.state.numeric))).toBe('NUMERIC_STATE_INVALID');
  });
});

describe('N1 legacy compatibility and secrets', () => {
  it('keeps string/null submissions readable and refuses numeric objects in the legacy contract', () => {
    const legacy = { participantId: 'p', roundId: 'r', value: 'A', status: 'SUBMITTED', submittedAtMs: 1, judgedAtMs: null, decision: null };
    expect(SubmissionRecordSchema.parse(legacy)).toEqual(legacy);
    expect(SubmissionRecordSchema.parse({ ...legacy, value: null }).value).toBeNull();
    const numeric = submit(fresh(), 'a', v(1, 1)).submissions.a;
    expect(SubmissionRecordSchema.safeParse(numeric).success).toBe(false);
    expect(SubmissionRecordSchema.safeParse({ ...legacy, value: v(1, 1) }).success).toBe(false);
    expect(() => submitOnce({ participantId: 'p', roundId: 'r', value: v(1, 1) as never, timer, now: 5000 })).toThrow();
    expect(submitOnce({ participantId: 'p', roundId: 'r', value: '7', timer, now: 5000 }).value).toBe('7');
  });
  it('gives the three real engines no numeric entry point and no numeric value as a choice answer', () => {
    const werIstDas = getGameEngineContract('wer-ist-das')!;
    const context: CoreActionContext = { gameSlug: 'wer-ist-das', roomStatus: 'RUNNING', state: createWerIstDasState(1, { alice: 'Alice' }),
      informationRole: 'PLAYER', participantId: 'alice', active: true, permissions: new Set(['BUZZER_CONTROL']), now: 100 };
    for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) {
      const contract = getGameEngineContract(slug)!;
      for (const action of ['numericSubmit', 'numeric:submit', 'estimate']) {
        expect(contract.validateCommand({ ...context, gameSlug: slug }, { action, payload: { value: v(1, 0) } }), `${slug}/${action}`).toMatchObject({ success: false });
      }
    }
    expect(werIstDas.validateCommand({ ...context, buzzerController: true }, { action: 'judge', payload: { result: v(1, 0) } })).toMatchObject({ success: false });
  });
  it('shows a submission only to its owner until the reveal; never config, target or bounds beyond public metadata', () => {
    let state = fresh();
    state = submit(state, 'alice', v(111, 1));
    state = submit(state, 'bob', v(222, 1), 5100);
    const scope = numericScopeOf(state);
    state = judgeNumeric(lockNumericRound(state, scope), scope, 'alice', 'CORRECT', 9000).state;
    const roles = {
      alice: { role: 'PLAYER', participantId: 'alice' }, bob: { role: 'PLAYER', participantId: 'bob' }, outsider: { role: 'PLAYER', participantId: 'zed' },
      host: { role: 'HOST' }, blindHost: { role: 'HOST', blindHost: true }, viewer: { role: 'VIEWER' }, display: { role: 'DISPLAY' },
    } as const;
    const ids = (r: keyof typeof roles, revealed: boolean) => projectNumericRound({ ...roles[r] }, state, { revealed }).submissions.map(s => s.participantId);
    expect(ids('alice', false)).toEqual(['alice']);
    expect(ids('bob', false)).toEqual(['bob']);
    for (const r of ['outsider', 'host', 'blindHost', 'viewer', 'display'] as const) expect(ids(r, false), r).toEqual([]);
    for (const r of Object.keys(roles) as Array<keyof typeof roles>) expect(ids(r, true), r).toEqual(['alice', 'bob']);
    expect(projectNumericRound(roles.alice, state, { revealed: false }).submissions[0].decision).toBeNull();
    expect(projectNumericRound(roles.alice, state, { revealed: true }).submissions[0].decision).toBe('CORRECT');
    for (const r of Object.keys(roles) as Array<keyof typeof roles>) {
      const projection = projectNumericRound({ ...roles[r] }, state, { revealed: true });
      expect(projection.input).toEqual({ schemaVersion: 1, scale: 1, unit: { label: 'Mio. Euro', factor: 1_000_000 }, allowNegative: true, bounds: null });
      expect(JSON.stringify(projection)).not.toMatch(/boundsDisclosure|"min"|"max"|configKey|77777/);
    }
  });
});
