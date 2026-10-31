import { describe, expect, it } from 'vitest';
import { ACTION_LIMITS, ActionLimiter, limitGroupForAction } from './actionLimits.js';

function limiter(maxKeys?: number) {
  const clock = { now: 1_000_000 };
  return { clock, limiter: new ActionLimiter(() => clock.now, maxKeys) };
}

describe('action limits: deterministic token bucket', () => {
  it('allows a normal fast burst, rejects the next one and reports an honest retry time', () => {
    const { limiter: l } = limiter(), { capacity, refillPerSec } = ACTION_LIMITS.PLAYER_INPUT;
    for (let i = 0; i < capacity; i++) expect(l.consume('r', 'p', 'PLAYER_INPUT')).toEqual({ ok: true });
    const rejected = l.consume('r', 'p', 'PLAYER_INPUT');
    expect(rejected).toMatchObject({ ok: false, firstRejection: true });
    expect((rejected as { retryAfterMs: number }).retryAfterMs).toBe(Math.ceil(1000 / refillPerSec));
    expect(l.consume('r', 'p', 'PLAYER_INPUT')).toMatchObject({ ok: false, firstRejection: false });
  });

  it('ties a rejection streak to one trace id and starts a new one after a success', () => {
    const { limiter: l, clock } = limiter(), { capacity, refillPerSec } = ACTION_LIMITS.PLAYER_INPUT;
    for (let i = 0; i < capacity; i++) l.consume('r', 'p', 'PLAYER_INPUT');
    const first = l.consume('r', 'p', 'PLAYER_INPUT'), second = l.consume('r', 'p', 'PLAYER_INPUT');
    expect(first).toMatchObject({ ok: false, firstRejection: true });
    expect(second).toMatchObject({ ok: false, firstRejection: false });
    expect((second as { traceId: string }).traceId).toBe((first as { traceId: string }).traceId);
    clock.now += 1000 / refillPerSec; expect(l.consume('r', 'p', 'PLAYER_INPUT').ok).toBe(true);
    const next = l.consume('r', 'p', 'PLAYER_INPUT');
    expect(next).toMatchObject({ ok: false, firstRejection: true });
    expect((next as { traceId: string }).traceId).not.toBe((first as { traceId: string }).traceId);
  });

  it('unlocks exactly when one token has refilled, not a millisecond earlier', () => {
    const { limiter: l, clock } = limiter(), { capacity, refillPerSec } = ACTION_LIMITS.PLAYER_INPUT, step = 1000 / refillPerSec;
    for (let i = 0; i < capacity; i++) l.consume('r', 'p', 'PLAYER_INPUT');
    expect(l.consume('r', 'p', 'PLAYER_INPUT').ok).toBe(false);
    clock.now += step - 1; expect(l.consume('r', 'p', 'PLAYER_INPUT').ok).toBe(false);
    clock.now += 1; expect(l.consume('r', 'p', 'PLAYER_INPUT').ok).toBe(true);
    expect(l.consume('r', 'p', 'PLAYER_INPUT').ok).toBe(false);
  });

  it('keeps participants, rooms and action groups independent', () => {
    const { limiter: l } = limiter();
    for (let i = 0; i < ACTION_LIMITS.PLAYER_INPUT.capacity + 5; i++) l.consume('r1', 'spammer', 'PLAYER_INPUT');
    expect(l.consume('r1', 'spammer', 'PLAYER_INPUT').ok).toBe(false);
    expect(l.consume('r1', 'other', 'PLAYER_INPUT').ok).toBe(true);
    expect(l.consume('r2', 'spammer', 'PLAYER_INPUT').ok).toBe(true);
    expect(l.consume('r1', 'spammer', 'HOST_CONTROL').ok).toBe(true);
    expect(l.consume('r1', 'spammer', 'RESULT_COMMAND').ok).toBe(true);
  });

  it('forgets idle identities and caps memory regardless of how many identities appear', () => {
    const { limiter: l, clock } = limiter(50);
    for (let i = 0; i < 500; i++) l.consume('r', `p${i}`, 'PLAYER_INPUT');
    expect(l.size()).toBeLessThanOrEqual(50);
    const small = limiter(5000);
    for (let i = 0; i < 100; i++) small.limiter.consume('r', `p${i}`, 'PLAYER_INPUT');
    small.clock.now += 60_000; small.limiter.sweep();
    expect(small.limiter.size()).toBe(0);
    void clock;
  });

  it('groups by duty: players act, hosts control (also unknown guarded actions)', () => {
    for (const a of ['answer', 'buzz', 'stealBuzz', 'joker5050', 'jokerSpy', 'jokerRisk']) expect(limitGroupForAction(a)).toBe('PLAYER_INPUT');
    for (const a of ['judge', 'stealJudge', 'reveal', 'next', 'fieldOpen', 'boardSwitch', 'open', 'hint', 'buzzerOverride']) expect(limitGroupForAction(a)).toBe('HOST_CONTROL');
    expect(limitGroupForAction('somethingNew')).toBe('HOST_CONTROL');
  });
});
