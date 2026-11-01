import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SubmissionRecordSchema, type CoreTimer } from '@quiz/shared';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { textCardConfigKey, type TextCardConfig, type TextCardFieldDef } from '@quiz/shared/textcard';
import { gameErrorCode } from './errors.js';
import { getGameEngineContract } from './engineContract.js';
import { createTimer, endTimer, pauseTimer, resumeTimer, submitOnce } from './runtimePrimitives.js';
import { createWerIstDasState } from '../weristdas/state.js';
import { createNumericRound, parseNumericRoundState } from './numericSubmission.js';
import type { CoreActionContext } from './actionRules.js';
import { matchTextField } from './textCardMatching.js';
import {
  closeTextCardRound, createTextCardRound, findSharedAnswers, judgeTextCardField, parseTextCardRoundState, projectTextCardRound,
  submitTextCard, textCardRef, textCardScopeOf, textCardStatus, type TextCardRoundState,
} from './textCardSubmission.js';

// Synthetic fixtures: ids and limits are NOT game presets.
const field = (fieldId: string, over: Partial<TextCardFieldDef> = {}): TextCardFieldDef => ({ fieldId, label: `Feld ${fieldId}`, help: null, required: false, ...over });
const config: TextCardConfig = { schemaVersion: 1, fields: [field('alpha', { required: true }), field('beta'), field('gamma')], maxCodePointsPerField: 20, maxTotalCodePoints: 60 };
const card = (a: string | null, b: string | null = null, c: string | null = null) => ({ schemaVersion: 1, answers: [{ fieldId: 'alpha', value: a }, { fieldId: 'beta', value: b }, { fieldId: 'gamma', value: c }] });
const fresh = (over: Partial<{ runIndex: number; roundId: string }> = {}) => createTextCardRound({ runIndex: 2, roundId: 'round-7', config, ...over });
const timer = createTimer('COUNTDOWN', 1000, 20000); // closed at 21000
const submit = (state: TextCardRoundState, participantId: string, input: unknown, now = 5000, t: CoreTimer = timer) =>
  submitTextCard(state, { scope: textCardScopeOf(state), participantId, input, timer: t, now });
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return 'NO_ERROR'; };
const judge = (state: TextCardRoundState, participantId: string, fieldId: string, decision: 'CORRECT' | 'WRONG' | 'PARTIAL' | 'CANCELLED', now = 9000) =>
  judgeTextCardField(state, textCardScopeOf(state), { participantId, fieldId, cardRef: textCardRef(state, participantId) as string, decision, now });

describe('N2 atomic submission', () => {
  it('accepts one complete card bound to owner, run, round and config; nothing else changes', () => {
    const s0 = fresh();
    const s1 = submit(s0, 'p1', card('eins', null, 'drei'));
    expect(s1.cards).toHaveLength(1);
    expect(s1.cards[0]).toMatchObject({ participantId: 'p1', submittedAtMs: 5000, judgements: [] });
    expect(s1.cards[0].card.answers).toEqual([{ fieldId: 'alpha', value: 'eins' }, { fieldId: 'beta', value: null }, { fieldId: 'gamma', value: 'drei' }]);
    expect(s0.cards).toEqual([]); // the previous state is untouched
    expect(textCardStatus(s1, 'p1')).toBe('SUBMITTED');
    expect(textCardStatus(s1, 'nobody')).toBeNull();
  });
  it('is all-or-nothing: an invalid field leaves no partial card, no event data and an unchanged state', () => {
    const s1 = submit(fresh(), 'p1', card('eins'));
    const before = JSON.stringify(s1);
    for (const bad of [card(null, 'x', 'y'), card('ok', '   ', 'y'), card('ok', 'x'.repeat(21)), { ...card('ok'), extra: 1 }, { schemaVersion: 1, answers: [{ fieldId: 'alpha', value: 'ok' }] }]) {
      let thrown: unknown;
      try { submit(s1, 'p2', bad); } catch (e) { thrown = e; }
      expect((thrown as Error).message).toBe('TEXT_CARD_INVALID');
      expect((thrown as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
      expect(gameErrorCode(thrown)).toBe('TEXT_CARD_INVALID');
    }
    expect(JSON.stringify(s1)).toBe(before);
    expect(submit(s1, 'p2', card('jetzt gültig')).cards.map(c => c.participantId)).toEqual(['p1', 'p2']); // the failed attempts did not burn the slot
  });
  it('error issues carry configured fieldIds only — never the submitted texts', () => {
    try { submit(fresh(), 'p1', card('GEHEIM-ANTWORT', 'x'.repeat(50))); } catch (e) {
      const text = JSON.stringify([(e as Error).message, (e as { issues: unknown }).issues]);
      expect(text).toContain('beta');
      expect(text).not.toMatch(/GEHEIM-ANTWORT|xxxx/);
    }
  });
  it('never lets a second ordinary submission replace an accepted card', () => {
    const s1 = submit(fresh(), 'p1', card('erste'));
    expect(err(() => submit(s1, 'p1', card('zweite')))).toBe('ALREADY_ANSWERED');
    expect(s1.cards[0].card.answers[0].value).toBe('erste');
  });
  it('rejects a wrong scope instead of re-attaching: other run, other round, changed or reordered config', () => {
    const s = fresh(), scope = textCardScopeOf(s);
    const attempt = (over: Partial<typeof scope>) => err(() => submitTextCard(s, { scope: { ...scope, ...over }, participantId: 'p', input: card('x'), timer, now: 5000 }));
    expect(attempt({ runIndex: 1 })).toBe('STALE_ROUND');
    expect(attempt({ roundId: 'round-6' })).toBe('STALE_ROUND');
    const [a, b, c] = config.fields;
    const key = (over: Partial<TextCardConfig>) => textCardConfigKey({ ...config, ...over });
    expect(attempt({ configKey: key({ fields: [b, a, c] }) })).toBe('TEXT_CARD_CONFIG_STALE'); // order is part of the identity
    expect(attempt({ configKey: key({ fields: [{ ...a, required: false }, b, c] }) })).toBe('TEXT_CARD_CONFIG_STALE');
    expect(attempt({ configKey: key({ fields: [a, b, { ...c, fieldId: 'gamma2' }] }) })).toBe('TEXT_CARD_CONFIG_STALE');
    expect(attempt({ configKey: key({ maxCodePointsPerField: 19 }) })).toBe('TEXT_CARD_CONFIG_STALE');
    expect(attempt({})).toBe('NO_ERROR');
    expect(err(() => closeTextCardRound(s, { ...scope, runIndex: 9 }, 6000))).toBe('STALE_ROUND');
  });
  it('allows a card up to the last open millisecond; deadline, pause and expiry reject', () => {
    const s0 = fresh();
    expect(submit(s0, 'a', card('x'), 20999).cards[0].submittedAtMs).toBe(20999);
    expect(err(() => submit(s0, 'a', card('x'), 21000))).toBe('TIME_EXPIRED');
    expect(err(() => submit(s0, 'a', card('x'), 3500, pauseTimer(timer, 3000)))).toBe('TIME_EXPIRED');
    expect(submit(s0, 'a', card('x'), 10500, resumeTimer(pauseTimer(timer, 3000), 10000)).cards).toHaveLength(1);
    expect(err(() => submit(s0, 'a', card('x'), 4000, endTimer(timer, 4000)))).toBe('TIME_EXPIRED');
    expect(err(() => submit(s0, 'a', card('x'), -1))).toBe('INVALID_TIME');
    expect(err(() => submit(s0, 'a', card('x'), 1.5))).toBe('INVALID_TIME');
  });
});

describe('N2 lock: the round closes, not just the existing records', () => {
  it('after closing, nobody can submit — also a participant without a record, while the external timer still runs', () => {
    const open = submit(fresh(), 'p1', card('x'));
    const closed = closeTextCardRound(open, textCardScopeOf(open), 8000);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAtMs).toBe(8000);
    expect(timer.status).toBe('RUNNING'); // the external timer has not expired
    expect(err(() => submit(closed, 'late-player', card('zu spät'), 9000))).toBe('TEXT_CARD_ROUND_CLOSED');
    expect(err(() => submit(closed, 'p1', card('nochmal'), 9000))).toBe('TEXT_CARD_ROUND_CLOSED');
    expect(closed.cards.map(c => c.participantId)).toEqual(['p1']);
  });
  it('locking an empty round closes the acceptance path as well', () => {
    const closed = closeTextCardRound(fresh(), textCardScopeOf(fresh()), 6000);
    expect(closed.cards).toEqual([]);
    expect(err(() => submit(closed, 'first', card('x'), 7000))).toBe('TEXT_CARD_ROUND_CLOSED');
  });
  it('closing is idempotent and does not move the close time', () => {
    const s = submit(fresh(), 'p1', card('x'));
    const once = closeTextCardRound(s, textCardScopeOf(s), 8000);
    const twice = closeTextCardRound(once, textCardScopeOf(s), 99999);
    expect(twice).toEqual(once);
    expect(twice.closedAtMs).toBe(8000);
    expect(s.status).toBe('OPEN');
    expect(err(() => closeTextCardRound(s, textCardScopeOf(s), -5))).toBe('INVALID_TIME');
  });
  it('derives status from round and judgements, so SUBMITTED/LOCKED/JUDGED can never contradict', () => {
    let s = submit(submit(submit(fresh(), 'p1', card('a', 'b', null)), 'p2', card('c', null, null), 5100), 'p3', { schemaVersion: 1, answers: [{ fieldId: 'alpha', value: 'z' }, { fieldId: 'beta', value: null }, { fieldId: 'gamma', value: null }] }, 5200);
    expect(['p1', 'p2', 'p3'].map(p => textCardStatus(s, p))).toEqual(['SUBMITTED', 'SUBMITTED', 'SUBMITTED']);
    s = closeTextCardRound(s, textCardScopeOf(s), 8000);
    expect(['p1', 'p2', 'p3'].map(p => textCardStatus(s, p))).toEqual(['LOCKED', 'LOCKED', 'LOCKED']);
    s = judge(s, 'p1', 'alpha', 'CORRECT').state;
    expect(textCardStatus(s, 'p1')).toBe('LOCKED'); // beta is answered but not judged yet
    s = judge(s, 'p1', 'beta', 'WRONG').state;
    expect(textCardStatus(s, 'p1')).toBe('JUDGED');
    s = judge(s, 'p2', 'alpha', 'PARTIAL').state;
    expect(['p1', 'p2', 'p3'].map(p => textCardStatus(s, p))).toEqual(['JUDGED', 'JUDGED', 'LOCKED']);
  });
  it('a card whose fields are all empty has nothing to judge and stays LOCKED', () => {
    const only = createTextCardRound({ runIndex: 1, roundId: 'r', config: { ...config, fields: [field('a'), field('b')] } });
    const s = closeTextCardRound(submitTextCard(only, { scope: textCardScopeOf(only), participantId: 'p', timer, now: 5000,
      input: { schemaVersion: 1, answers: [{ fieldId: 'a', value: null }, { fieldId: 'b', value: null }] } }), textCardScopeOf(only), 6000);
    expect(textCardStatus(s, 'p')).toBe('LOCKED');
    expect(err(() => judge(s, 'p', 'a', 'CORRECT'))).toBe('SUBMISSION_NOT_JUDGEABLE');
  });
});

describe('N2 per-field judgement bound to one card', () => {
  const closed = () => { const s = submit(submit(fresh(), 'p1', card('a', 'b')), 'p2', card('c', null, 'e'), 5100); return closeTextCardRound(s, textCardScopeOf(s), 8000); };
  it('judges only after the round is closed', () => {
    const s = submit(fresh(), 'p1', card('a'));
    expect(err(() => judgeTextCardField(s, textCardScopeOf(s), { participantId: 'p1', fieldId: 'alpha', cardRef: textCardRef(s, 'p1') as string, decision: 'CORRECT', now: 6000 }))).toBe('TEXT_CARD_NOT_CLOSED');
  });
  it('records a judgement per fieldId without touching the answers; repeating the same one is idempotent', () => {
    const s0 = closed();
    const first = judge(s0, 'p1', 'beta', 'WRONG');
    expect(first.applied).toBe(true);
    expect(first.state.cards[0].judgements).toEqual([{ fieldId: 'beta', decision: 'WRONG', judgedAtMs: 9000 }]);
    expect(first.state.cards[0].card).toEqual(s0.cards[0].card); // answer content unchanged
    expect(first.state.cards[1]).toEqual(s0.cards[1]); // other owner untouched
    expect(s0.cards[0].judgements).toEqual([]);
    const again = judgeTextCardField(first.state, textCardScopeOf(first.state), { participantId: 'p1', fieldId: 'beta', cardRef: textCardRef(first.state, 'p1') as string, decision: 'WRONG', now: 77777 });
    expect(again.applied).toBe(false);
    expect(again.state).toEqual(first.state);
    expect(again.state.cards[0].judgements[0].judgedAtMs).toBe(9000);
    expect(err(() => judge(first.state, 'p1', 'beta', 'CORRECT'))).toBe('TEXT_CARD_ALREADY_JUDGED');
  });
  it('refuses judgements for another field, an old/foreign card, a foreign owner or empty/unknown fields', () => {
    const s = closed();
    const ref1 = textCardRef(s, 'p1') as string, ref2 = textCardRef(s, 'p2') as string;
    const attempt = (over: Partial<{ participantId: string; fieldId: string; cardRef: string }>) => err(() => judgeTextCardField(s, textCardScopeOf(s), { participantId: 'p1', fieldId: 'alpha', cardRef: ref1, decision: 'CORRECT', now: 9000, ...over }));
    expect(attempt({ cardRef: ref2 })).toBe('TEXT_CARD_STALE_CARD'); // another owner's card
    expect(attempt({ cardRef: ref1.replace('5000', '4999') })).toBe('TEXT_CARD_STALE_CARD'); // an older card version
    expect(attempt({ cardRef: ref1.replace('round-7', 'round-6') })).toBe('TEXT_CARD_STALE_CARD'); // another round
    expect(attempt({ fieldId: 'delta' })).toBe('TEXT_CARD_FIELD_UNKNOWN');
    expect(attempt({ fieldId: '__proto__' })).toBe('TEXT_CARD_FIELD_UNKNOWN');
    expect(attempt({ fieldId: 'gamma' })).toBe('SUBMISSION_NOT_JUDGEABLE'); // p1 left gamma empty
    expect(attempt({ participantId: 'ghost' })).toBe('TEXT_CARD_NOT_FOUND');
    expect(attempt({ participantId: '__proto__' })).toBe('TEXT_CARD_NOT_FOUND');
    expect(err(() => judgeTextCardField(s, { ...textCardScopeOf(s), roundId: 'x' }, { participantId: 'p1', fieldId: 'alpha', cardRef: ref1, decision: 'CORRECT', now: 9000 }))).toBe('STALE_ROUND');
    expect(err(() => judgeTextCardField(s, textCardScopeOf(s), { participantId: 'p1', fieldId: 'alpha', cardRef: ref1, decision: 'LOOKS_GOOD' as never, now: 9000 }))).toBe('JUDGE_DECISION_UNSUPPORTED');
    expect(s.cards.every(c => c.judgements.length === 0)).toBe(true);
  });
  it('writes no points, ranks or random effects and calls neither clock nor randomness', () => {
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const s = judge(closed(), 'p1', 'alpha', 'PARTIAL').state;
      expect(JSON.stringify(s)).not.toMatch(/"(points|score|rank|winner|seed|random)"/i);
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); }
  });
});

describe('N2 serialization, corruption and SDK replay', () => {
  it('roundtrips open, closed and judged states through JSON unchanged', () => {
    const s1 = submit(submit(fresh(), 'p1', card('äöü', null, 'a|b;c')), 'p2', card('x'), 5100);
    const s2 = closeTextCardRound(s1, textCardScopeOf(s1), 8000);
    const s3 = judge(s2, 'p1', 'gamma', 'CORRECT').state;
    for (const s of [s1, s2, s3]) {
      const decoded = JSON.parse(JSON.stringify(s));
      expect(decoded).toEqual(s);
      expect(parseTextCardRoundState(decoded)).toEqual(s);
    }
  });
  it('rejects corrupt, foreign, legacy or tampered stored data in a controlled way', () => {
    const good = closeTextCardRound(submit(fresh(), 'p1', card('a', 'b')), textCardScopeOf(fresh()), 8000);
    const g = JSON.parse(JSON.stringify(good));
    const withCard = (patch: object) => ({ ...g, cards: [{ ...g.cards[0], ...patch }] });
    const bad: unknown[] = [null, undefined, 'x', [], {}, { ...g, kind: 'NUMERIC_ROUND' }, { ...g, schemaVersion: 2 }, { ...g, runIndex: 0 }, { ...g, extra: 1 },
      { ...g, status: 'OPEN' }, { ...g, closedAtMs: null }, { ...g, cards: [g.cards[0], g.cards[0]] },
      withCard({ card: { ...g.cards[0].card, answers: [...g.cards[0].card.answers].reverse() } }), // not canonical
      withCard({ card: { schemaVersion: 1, answers: [{ fieldId: 'alpha', value: 'a' }] } }), // violates the pinned config
      withCard({ card: { ...g.cards[0].card, answers: [{ fieldId: 'alpha', value: '' }, ...g.cards[0].card.answers.slice(1)] } }),
      withCard({ judgements: [{ fieldId: 'gamma', decision: 'CORRECT', judgedAtMs: 1 }] }), // field was left empty
      withCard({ judgements: [{ fieldId: 'alpha', decision: 'CORRECT', judgedAtMs: 1 }, { fieldId: 'alpha', decision: 'WRONG', judgedAtMs: 2 }] }),
      withCard({ judgements: [{ fieldId: 'delta', decision: 'CORRECT', judgedAtMs: 1 }] }),
      { ...g, status: 'OPEN', closedAtMs: null, cards: [{ ...g.cards[0], judgements: [{ fieldId: 'alpha', decision: 'CORRECT', judgedAtMs: 1 }] }] },
      withCard({ participantId: 7 }), withCard({ submittedAtMs: -1 }), withCard({ extra: true }),
      { ...g, config: { ...g.config, fields: [] } },
      { ...g, cards: [{ participantId: 'p1', value: 'A', status: 'SUBMITTED', roundId: 'r', submittedAtMs: 1, judgedAtMs: null, decision: null }] }, // legacy string record
    ];
    for (const raw of bad) {
      expect(err(() => parseTextCardRoundState(raw)), JSON.stringify(raw)?.slice(0, 80)).toBe('TEXT_CARD_STATE_INVALID');
      expect(err(() => submitTextCard(raw, { scope: textCardScopeOf(good), participantId: 'z', input: card('x'), timer, now: 5000 }))).toBe('TEXT_CARD_STATE_INVALID');
    }
    expect(err(() => createTextCardRound({ runIndex: 1, roundId: 'r', config: { ...config, fields: [field('a'), field('a')] } }))).toBe('TEXT_CARD_CONFIG_INVALID');
    expect(err(() => createTextCardRound({ runIndex: 0, roundId: 'r', config }))).toBe('TEXT_CARD_STATE_INVALID');
    for (const code of ['TEXT_CARD_INVALID', 'TEXT_CARD_STATE_INVALID', 'TEXT_CARD_ROUND_CLOSED', 'TEXT_CARD_STALE_CARD']) expect(gameErrorCode(new Error(code))).toBe(code);
  });
  const snapshot = (state: Record<string, unknown>, stateVersion = 0): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 2, gameSlug: 'future-textcard', engineVersion: 1, stateVersion, state });
  it('replays through the existing SDK state events to an identical state, without clock, randomness or re-judging', () => {
    const s0 = fresh(), s1 = submit(s0, 'a', card('Köln', null, 'x|y')), s2 = closeTextCardRound(s1, textCardScopeOf(s1), 8000);
    const s3 = judge(s2, 'a', 'alpha', 'CORRECT').state;
    const base = snapshot({ phase: 'INPUT_OPEN', cards: s0, scores: { a: 0 } });
    const e1 = createStateEvent(base, { phase: 'INPUT_OPEN', cards: s1, scores: { a: 0 } }, { eventId: randomUUID(), type: 'CARD_SUBMITTED', commandId: 'c1', actorId: 'a', occurredAtMs: 5000 });
    const mid = snapshot({ phase: 'INPUT_OPEN', cards: s1, scores: { a: 0 } }, 1);
    const e2 = createStateEvent(mid, { phase: 'REVEAL', cards: s3, scores: { a: 0 } }, { eventId: randomUUID(), type: 'CARD_JUDGED', commandId: 'c2', actorId: 'host', occurredAtMs: 9000 });
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const wire = JSON.parse(JSON.stringify([e1, e2]));
      const replayed = applyStateEvent(applyStateEvent(base, wire[0]), wire[1]);
      expect(applyStateEvent(applyStateEvent(base, wire[0]), wire[1])).toEqual(replayed);
      expect(replayed.stateVersion).toBe(2);
      expect(parseTextCardRoundState(replayed.state.cards)).toEqual(s3);
      expect(replayed.state.scores).toEqual({ a: 0 }); // replay writes no points
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); }
    expect(e1.changes.map(c => c.key)).toEqual(['cards']);
  });
  it('refuses events of another run or version; a tampered reconstructed card is caught on read', () => {
    const base = snapshot({ cards: fresh() });
    const e = createStateEvent(base, { cards: submit(fresh(), 'a', card('x')) }, { eventId: randomUUID(), type: 'X', commandId: null, actorId: null, occurredAtMs: 1 });
    expect(() => applyStateEvent({ ...base, runIndex: 3 }, e)).toThrow('EVENT_SCOPE_MISMATCH');
    expect(() => applyStateEvent({ ...base, stateVersion: 5 }, e)).toThrow('EVENT_VERSION_CONFLICT');
    const tampered = { ...e, changes: [{ key: 'cards', value: { ...submit(fresh(), 'a', card('x')), cards: [{ participantId: 'a', card: { schemaVersion: 1, answers: [] }, submittedAtMs: 1, judgements: [] }] } }] };
    expect(err(() => parseTextCardRoundState(applyStateEvent(base, tampered).state.cards))).toBe('TEXT_CARD_STATE_INVALID');
  });
});

describe('N2 legacy and N1 compatibility', () => {
  it('keeps string/null submissions readable and refuses card objects in the legacy contract', () => {
    const legacy = { participantId: 'p', roundId: 'r', value: 'A', status: 'SUBMITTED', submittedAtMs: 1, judgedAtMs: null, decision: null };
    expect(SubmissionRecordSchema.parse(legacy)).toEqual(legacy);
    expect(SubmissionRecordSchema.parse({ ...legacy, value: null }).value).toBeNull();
    const record = submit(fresh(), 'a', card('x')).cards[0];
    expect(SubmissionRecordSchema.safeParse(record).success).toBe(false);
    expect(SubmissionRecordSchema.safeParse({ ...legacy, value: record.card }).success).toBe(false);
    expect(() => submitOnce({ participantId: 'p', roundId: 'r', value: record.card as never, timer, now: 5000 })).toThrow();
    expect(submitOnce({ participantId: 'p', roundId: 'r', value: '7', timer, now: 5000 }).value).toBe('7');
  });
  it('N1 numeric states and text-card states are mutually unreadable; N1 still works', () => {
    const numeric = createNumericRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, scale: 0, min: { units: 0, scale: 0 }, max: { units: 10, scale: 0 }, unit: null, boundsDisclosure: 'PUBLIC' } });
    expect(err(() => parseTextCardRoundState(numeric))).toBe('TEXT_CARD_STATE_INVALID');
    expect(err(() => parseNumericRoundState(fresh()))).toBe('NUMERIC_STATE_INVALID');
    expect(parseNumericRoundState(numeric)).toEqual(numeric);
  });
  it('gives the three real engines no card entry point and no card as a choice or judge answer', () => {
    const context: CoreActionContext = { gameSlug: 'wer-ist-das', roomStatus: 'RUNNING', state: createWerIstDasState(1, { alice: 'Alice' }),
      informationRole: 'PLAYER', participantId: 'alice', active: true, permissions: new Set(['BUZZER_CONTROL']), now: 100 };
    for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) {
      const contract = getGameEngineContract(slug)!;
      for (const action of ['textSubmit', 'multi:submit', 'cardSubmit']) {
        expect(contract.validateCommand({ ...context, gameSlug: slug }, { action, payload: card('x') }), `${slug}/${action}`).toMatchObject({ success: false });
      }
    }
    expect(getGameEngineContract('wer-ist-das')!.validateCommand({ ...context, buzzerController: true }, { action: 'judge', payload: { result: card('x') } })).toMatchObject({ success: false });
  });
});

describe('N2 visibility (domain projection only — no socket, rejoin or recovery is proven here)', () => {
  const state = () => {
    const s = submit(submit(fresh(), 'alice', card('Alice-Antwort', 'a2')), 'bob', card('Bob-Antwort'), 5100);
    const closed = closeTextCardRound(s, textCardScopeOf(s), 8000);
    return judge(closed, 'alice', 'alpha', 'CORRECT').state;
  };
  const roles = {
    alice: { role: 'PLAYER', participantId: 'alice', teamId: 't1' }, partnerOfAlice: { role: 'PLAYER', participantId: 'carol', teamId: 't1' },
    bob: { role: 'PLAYER', participantId: 'bob', teamId: 't2' }, outsider: { role: 'PLAYER', participantId: 'zed', teamId: null },
    host: { role: 'HOST' }, blindHost: { role: 'HOST', blindHost: true }, playingHostAsHost: { role: 'HOST', participantId: 'alice', teamId: 't1' },
    viewer: { role: 'VIEWER' }, display: { role: 'DISPLAY' },
  } as const;
  const owners = (r: keyof typeof roles, revealed: boolean) => projectTextCardRound({ ...roles[r] }, state(), { revealed }).cards.map(c => c.participantId);
  it('shows a card only to its owner until the explicit reveal', () => {
    expect(owners('alice', false)).toEqual(['alice']);
    expect(owners('bob', false)).toEqual(['bob']);
    for (const r of ['partnerOfAlice', 'outsider', 'host', 'blindHost', 'playingHostAsHost', 'viewer', 'display'] as const) expect(owners(r, false), r).toEqual([]);
    for (const r of Object.keys(roles) as Array<keyof typeof roles>) expect(owners(r, true), r).toEqual(['alice', 'bob']);
  });
  it('team membership (a partner in the same team) and administrative rights grant no insight', () => {
    expect(owners('partnerOfAlice', false)).toEqual([]);
    expect(owners('host', false)).toEqual([]);
    expect(owners('playingHostAsHost', false)).toEqual([]); // the engine must assign the PLAYER information role for own data
  });
  it('shows judgements only after the reveal and exposes only the public config', () => {
    expect(projectTextCardRound(roles.alice, state(), { revealed: false }).cards[0].judgements).toEqual([]);
    expect(projectTextCardRound(roles.alice, state(), { revealed: true }).cards[0].judgements).toEqual([{ fieldId: 'alpha', decision: 'CORRECT', judgedAtMs: 9000 }]);
    for (const r of Object.keys(roles) as Array<keyof typeof roles>) {
      const projection = projectTextCardRound({ ...roles[r] }, state(), { revealed: r !== 'outsider' });
      expect(projection.config).toEqual(config);
      expect(projection.status).toBe('CLOSED');
      expect(JSON.stringify(projection)).not.toMatch(/configKey|reference|synonym|expected|cardRef/i);
    }
    const unrevealedOthers = JSON.stringify(projectTextCardRound(roles.outsider, state(), { revealed: false }));
    expect(unrevealedOthers).not.toMatch(/Alice-Antwort|Bob-Antwort|a2/);
  });
});

describe('N2 matching adapter (reuses matchAnswer unchanged; a result is a proposal, not a judgement)', () => {
  const ref = (expected: string, synonyms: string[] = []) => ({ expected, synonyms, revision: 'pool-rev-7' });
  it('treats empty fields as NO_ANSWER and never matches them', () => {
    for (const mode of ['EXACT', 'NORMALIZED', 'SYNONYM', 'FUZZY', 'MANUAL_ONLY'] as const) expect(matchTextField(null, { mode, reference: ref('Berlin') }).status).toBe('NO_ANSWER');
  });
  it('does not call a free word wrong without a reference: NOT_CHECKED (or NEEDS_JUDGE for MANUAL_ONLY)', () => {
    for (const mode of ['EXACT', 'NORMALIZED', 'SYNONYM', 'FUZZY'] as const) expect(matchTextField('Irgendwas', { mode, reference: null }), mode).toEqual({ status: 'NOT_CHECKED', mode, referenceRevision: null });
    expect(matchTextField('Irgendwas', { mode: 'MANUAL_ONLY', reference: null }).status).toBe('NEEDS_JUDGE');
    expect(matchTextField('Irgendwas', { mode: 'MANUAL_ONLY', reference: ref('x') }).status).toBe('NEEDS_JUDGE');
  });
  it('EXACT stays exact; NORMALIZED is a different mode; accents and sharp s are not silently equated', () => {
    expect(matchTextField('Berlin', { mode: 'EXACT', reference: ref('Berlin') }).status).toBe('MATCH');
    for (const near of ['berlin', 'Berlin ', ' Berlin', 'BERLIN']) expect(matchTextField(near, { mode: 'EXACT', reference: ref('Berlin') }).status, near).toBe('NO_MATCH');
    for (const near of ['berlin', ' BERLIN ', 'Berlin  ']) expect(matchTextField(near, { mode: 'NORMALIZED', reference: ref('Berlin') }).status, near).toBe('MATCH');
    expect(matchTextField('Koeln', { mode: 'NORMALIZED', reference: ref('Köln') }).status).toBe('NO_MATCH');
    expect(matchTextField('Kolln', { mode: 'NORMALIZED', reference: ref('Köln') }).status).toBe('NO_MATCH');
    expect(matchTextField('STRASSE', { mode: 'NORMALIZED', reference: ref('Straße') }).status).toBe('NO_MATCH');
    expect(matchTextField('Cologne', { mode: 'SYNONYM', reference: ref('Köln', ['Cologne']) }).status).toBe('MATCH');
    expect(matchTextField('Colonia', { mode: 'SYNONYM', reference: ref('Köln', ['Cologne']) }).status).toBe('NO_MATCH');
  });
  it('FUZZY similarity is only ever a judge proposal, never a confirmed match', () => {
    for (const near of ['Berln', 'Berlinn', 'berlín', 'Berlin!']) expect(matchTextField(near, { mode: 'FUZZY', reference: ref('Berlin') }).status, near).not.toBe('MATCH');
    expect(matchTextField('Berln', { mode: 'FUZZY', reference: ref('Berlin') }).status).toBe('NEEDS_JUDGE');
    expect(matchTextField('Hamburg', { mode: 'FUZZY', reference: ref('Berlin') }).status).toBe('NO_MATCH');
  });
  it('echoes mode and public revision only — never the reference or its synonyms', () => {
    const result = matchTextField('Berlin', { mode: 'SYNONYM', reference: ref('GEHEIM-LÖSUNG', ['SYN-GEHEIM']) });
    expect(result).toEqual({ status: 'NO_MATCH', mode: 'SYNONYM', referenceRevision: 'pool-rev-7' });
    expect(JSON.stringify(result)).not.toMatch(/GEHEIM/);
  });
  it('refuses unbounded or malformed references and unknown modes', () => {
    expect(err(() => matchTextField('x', { mode: 'EXACT', reference: ref('y'.repeat(401)) }))).toBe('INVALID_SETUP');
    expect(err(() => matchTextField('x', { mode: 'SYNONYM', reference: ref('y', Array.from({ length: 51 }, () => 's')) }))).toBe('INVALID_SETUP');
    expect(err(() => matchTextField('x', { mode: 'EXACT', reference: { expected: 'y', revision: '' } }))).toBe('INVALID_SETUP');
    expect(err(() => matchTextField('x', { mode: 'LIKE' as never, reference: null }))).toBe('INVALID_SETUP');
  });
});

describe('N2 neutral grouping of shared answers (decides nothing)', () => {
  const closedWith = (rows: Array<[string, string | null, string | null, string | null]>, roundId = 'round-7') => {
    let s = createTextCardRound({ runIndex: 2, roundId, config });
    rows.forEach(([id, a, b, c], i) => { s = submitTextCard(s, { scope: textCardScopeOf(s), participantId: id, input: card(a, b, c), timer, now: 5000 + i }); });
    return closeTextCardRound(s, textCardScopeOf(s), 9000);
  };
  it('groups equal answers within the same field only; the same word in another field is not shared', () => {
    const s = closedWith([['p1', 'Rom', 'Rom', null], ['p2', 'Rom', 'Wien', null], ['p3', 'Wien', 'Rom', null]]);
    expect(findSharedAnswers(s, 'EXACT')).toEqual([{ fieldId: 'alpha', participantIds: ['p1', 'p2'] }, { fieldId: 'beta', participantIds: ['p1', 'p3'] }]);
  });
  it('never groups empty values, and does not group by "both empty"', () => {
    const s = closedWith([['p1', 'x', null, null], ['p2', 'y', null, null], ['p3', 'z', null, null]]);
    expect(findSharedAnswers(s, 'EXACT')).toEqual([]);
    expect(findSharedAnswers(s, 'NORMALIZED')).toEqual([]);
  });
  it('EXACT and NORMALIZED differ exactly as the match modes do; output is order independent and key-free', () => {
    const rows: Array<[string, string | null, string | null, string | null]> = [['p2', ' berlin ', null, null], ['p1', 'Berlin', null, null], ['p3', 'BERLIN', null, null]];
    expect(findSharedAnswers(closedWith(rows), 'EXACT')).toEqual([]);
    const normalized = findSharedAnswers(closedWith(rows), 'NORMALIZED');
    expect(normalized).toEqual([{ fieldId: 'alpha', participantIds: ['p1', 'p2', 'p3'] }]);
    expect(findSharedAnswers(closedWith([...rows].reverse()), 'NORMALIZED')).toEqual(normalized);
    expect(JSON.stringify(normalized)).not.toMatch(/berlin|points|winner|valid/i);
  });
  it('is bound to one round: another round never mixes in, and an open round is refused', () => {
    const r1 = closedWith([['p1', 'Rom', null, null], ['p2', 'Rom', null, null]], 'round-1');
    const r2 = closedWith([['p3', 'Rom', null, null]], 'round-2');
    expect(findSharedAnswers(r1, 'EXACT')).toEqual([{ fieldId: 'alpha', participantIds: ['p1', 'p2'] }]);
    expect(findSharedAnswers(r2, 'EXACT')).toEqual([]);
    expect(err(() => findSharedAnswers(submit(fresh(), 'p1', card('Rom')), 'EXACT'))).toBe('TEXT_CARD_NOT_CLOSED');
  });
});
