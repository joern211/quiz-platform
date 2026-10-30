import { describe, expect, it } from 'vitest';
import { createTimer, extendTimer, judgeSubmission, legacyRoundTimer, lockSubmission, pauseTimer, resumeTimer, scoreJudgement, submitOnce, timerAcceptsInput, timerElapsed, timerRemaining } from './runtimePrimitives.js';

describe('shared runtime: persisted deadlines, submissions and judging', () => {
  it('preserves countdown time across serialization, long pause and restart', () => {
    const running = createTimer('COUNTDOWN', 1000, 10000);
    const paused = JSON.parse(JSON.stringify(pauseTimer(running, 4000)));
    expect(timerRemaining(paused, 999999)).toBe(7000);
    expect(timerAcceptsInput(paused, 5000)).toBe(false);
    const resumed = resumeTimer(paused, 100000);
    expect(resumed.endsAtMs).toBe(107000);
    expect(timerElapsed(resumed, 102000)).toBe(5000);
    expect(timerAcceptsInput(resumed, 106999)).toBe(true);
    expect(timerAcceptsInput(resumed, 107000)).toBe(false);
  });
  it('supports count-up/unlimited and controlled time changes without resurrecting expiry', () => {
    const up = resumeTimer(pauseTimer(createTimer('COUNTUP', 1000), 5000), 10000);
    expect(timerElapsed(up, 13000)).toBe(7000);
    expect(timerRemaining(up, 13000)).toBeNull();
    expect(timerAcceptsInput(createTimer('UNLIMITED', 0), 1000000)).toBe(true);
    const ended = extendTimer(createTimer('COUNTDOWN', 0, 5000), -5000, 0);
    expect(ended.status).toBe('EXPIRED');
    expect(() => resumeTimer(ended, 10000)).toThrow('TIMER_NOT_PAUSED');
    expect(() => createTimer('COUNTDOWN', 0, Infinity)).toThrow('INVALID_TIMER_DURATION');
  });
  it('locks the deadline boundary, rejects duplicate inputs and preserves manual/partial judgement', () => {
    const timer = createTimer('COUNTDOWN', 0, 1000);
    const input = { participantId: 'p', roundId: 'r', value: 'A', timer, now: 999 };
    const first = submitOnce(input);
    expect(() => submitOnce({ ...input, previous: first })).toThrow('ALREADY_ANSWERED');
    expect(() => submitOnce({ ...input, now: 1000 })).toThrow('TIME_EXPIRED');
    const judged = judgeSubmission(first, 'PARTIAL', 2000);
    expect(judged).toMatchObject({ status: 'JUDGED', decision: 'PARTIAL', submittedAtMs: 999, judgedAtMs: 2000 });
    expect(() => judgeSubmission(judged, 'WRONG', 3000)).toThrow('SUBMISSION_NOT_JUDGEABLE');
    expect(scoreJudgement('PARTIAL', { correct: 100, wrong: -50, partial: 25 })).toBe(25);
    expect(() => scoreJudgement('PARTIAL', { correct: 100, wrong: -50 })).toThrow('JUDGE_DECISION_UNSUPPORTED');
  });
  it('reads explicit legacy timestamps and refuses to invent a missing deadline', () => {
    expect(legacyRoundTimer({ timerStartMs: 1000, timerEndMs: 6000 }, 'INPUT_OPEN').endsAtMs).toBe(6000);
    expect(resumeTimer(legacyRoundTimer({ pauseRemainingMs: 5000 }, 'PAUSED'), 10000).endsAtMs).toBe(15000);
    expect(() => legacyRoundTimer({}, 'INPUT_OPEN')).toThrow('INVALID_TIMER_STATE');
  });
});

it('refuses to extend an expired persisted deadline even before its timeout callback ran', () => {
  const running = JSON.parse(JSON.stringify(createTimer('COUNTDOWN', 1000, 1000)));
  expect(() => extendTimer(running, 5000, 2000)).toThrow('TIME_EXPIRED');
  expect(() => extendTimer(running, 5000, 9999)).toThrow('TIME_EXPIRED');
});

it('extends only a live budget and preserves paused elapsed time instead of charging the pause', () => {
  const timer = createTimer('COUNTDOWN', 1000, 1000);
  expect(extendTimer(timer, 5000, 1999).endsAtMs).toBe(7000);
  const paused = extendTimer(pauseTimer(timer, 1500), 500, 90000);
  expect(paused).toMatchObject({ status: 'PAUSED', remainingMs: 1000, elapsedBeforeMs: 500 });
  const resumed = resumeTimer(paused, 100000);
  expect(resumed.endsAtMs).toBe(101000); expect(timerElapsed(resumed, 100100)).toBe(600);
});
it('caps elapsed countdown time at its deadline and never resumes a zero paused budget', () => {
  const timer = createTimer('COUNTDOWN', 1000, 1000);
  expect(timerElapsed(timer, 99999)).toBe(1000);
  expect(pauseTimer(timer, 99999)).toMatchObject({ status: 'EXPIRED', remainingMs: 0, elapsedBeforeMs: 1000 });
  expect(() => resumeTimer({ ...pauseTimer(timer, 1500), remainingMs: 0 }, 5000)).toThrow('TIME_EXPIRED');
});

it('G3: a 0 outcome is a real outcome, partial 0 is supported, undefined/fractional/non-finite values are refused', () => {
  expect(scoreJudgement('CORRECT', { correct: 0, wrong: 0 })).toBe(0);
  expect(scoreJudgement('WRONG', { correct: 100, wrong: 0 })).toBe(0);
  expect(scoreJudgement('PARTIAL', { correct: 100, wrong: -50, partial: 0 })).toBe(0);
  expect(scoreJudgement('CANCELLED', { correct: 100, wrong: -50 })).toBe(0);
  expect(scoreJudgement('WRONG', { correct: 100, wrong: -50 })).toBe(-50);
  for (const bad of [0.5, NaN, Infinity]) expect(() => scoreJudgement('CORRECT', { correct: bad, wrong: 0 })).toThrow('JUDGE_DECISION_UNSUPPORTED');
});
it('G3: submit, lock and judge follow one order; a lock never reopens or re-judges and a judged record cannot be submitted over', () => {
  const timer = createTimer('COUNTDOWN', 0, 1000);
  const submitted = submitOnce({ participantId: 'p', roundId: 'r', value: 'a', timer, now: 10 });
  const locked = lockSubmission(submitted);
  expect(locked).toMatchObject({ status: 'LOCKED', value: 'a', submittedAtMs: 10 });
  expect(lockSubmission(locked)).toEqual(locked);
  expect(() => submitOnce({ previous: locked, participantId: 'p', roundId: 'r', value: 'b', timer, now: 20 })).toThrow('ALREADY_ANSWERED');
  const judged = judgeSubmission(locked, 'WRONG', 30);
  expect(lockSubmission(judged)).toEqual(judged);
  expect(() => submitOnce({ previous: judged, participantId: 'p', roundId: 'r', value: 'b', timer, now: 40 })).toThrow('ALREADY_ANSWERED');
  // another participant or round is a different record, not an overwrite
  expect(submitOnce({ previous: judged, participantId: 'q', roundId: 'r', value: 'b', timer, now: 40 }).participantId).toBe('q');
  expect(submitOnce({ previous: judged, participantId: 'p', roundId: 's', value: 'b', timer, now: 40 }).roundId).toBe('s');
});
