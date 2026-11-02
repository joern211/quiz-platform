import { describe, expect, it, vi } from 'vitest';
import { createServerClock, MAX_ACCEPTED_RTT_MS } from './serverClock';

const make = (start = 0) => { const state = { now: start }; return { state, clock: createServerClock({ nowMs: () => state.now }) }; };

describe('N7 ServerClock: estimate on the monotonic clock only', () => {
  it('has no basis (null) until a valid round-trip sample exists — a guess is never offered', () => {
    const { clock } = make();
    expect(clock.nowServerMs()).toBeNull();
    expect(clock.uncertaintyMs()).toBeNull();
  });
  it('estimates server time as stamp + rtt/2 + elapsed monotonic time; the bound is rtt/2', () => {
    const { state, clock } = make(1000);
    expect(clock.addSample({ sentMonoMs: 900, receivedMonoMs: 1000, serverMs: 5_000_000 })).toBe(true); // rtt 100
    expect(clock.nowServerMs()).toBe(5_000_050);
    expect(clock.uncertaintyMs()).toBe(50);
    state.now = 3500;
    expect(clock.nowServerMs()).toBe(5_002_550);
  });
  it('keeps the sample with the SMALLEST round trip and ignores a worse one', () => {
    const { state, clock } = make(1000);
    clock.addSample({ sentMonoMs: 800, receivedMonoMs: 1000, serverMs: 5_000_000 }); // rtt 200 → uncertainty 100
    expect(clock.addSample({ sentMonoMs: 960, receivedMonoMs: 1000, serverMs: 5_000_030 })).toBe(true); // rtt 40 → better
    expect(clock.uncertaintyMs()).toBe(20);
    expect(clock.addSample({ sentMonoMs: 500, receivedMonoMs: 1000, serverMs: 9_999_999 })).toBe(false); // rtt 500 → worse, ignored
    expect(clock.nowServerMs()).toBe(5_000_050);
    state.now = 1000;
  });
  it.each([
    ['negative rtt', { sentMonoMs: 1000, receivedMonoMs: 900, serverMs: 5 }],
    ['rtt above the accepted bound', { sentMonoMs: 0, receivedMonoMs: MAX_ACCEPTED_RTT_MS + 1, serverMs: 5 }],
    ['NaN', { sentMonoMs: NaN, receivedMonoMs: 10, serverMs: 5 }],
    ['Infinity', { sentMonoMs: 0, receivedMonoMs: Infinity, serverMs: 5 }],
    ['fractional server time', { sentMonoMs: 0, receivedMonoMs: 10, serverMs: 5.5 }],
    ['negative server time', { sentMonoMs: 0, receivedMonoMs: 10, serverMs: -5 }],
    ['a sample from the future of our own monotonic clock', { sentMonoMs: 0, receivedMonoMs: 99_999, serverMs: 5 }],
    ['a string', { sentMonoMs: '0', receivedMonoMs: 10, serverMs: 5 }],
  ])('refuses an impossible sample: %s — and keeps the previous basis', (_name, sample) => {
    const { clock } = make(1000);
    clock.addSample({ sentMonoMs: 990, receivedMonoMs: 1000, serverMs: 7_000_000 });
    expect(clock.addSample(sample as never)).toBe(false);
    expect(clock.nowServerMs()).toBe(7_000_005);
  });
  it('is not touched by the wall clock: a client clock minutes ahead or behind changes nothing', () => {
    const { state, clock } = make(1000);
    clock.addSample({ sentMonoMs: 1000, receivedMonoMs: 1000, serverMs: 5_000_000 });
    const wall = vi.spyOn(Date, 'now');
    for (const skew of [+9 * 60_000, -7 * 60_000, 0]) {
      wall.mockReturnValue(1_700_000_000_000 + skew);
      state.now = 2000;
      expect(clock.nowServerMs()).toBe(5_001_000);
    }
    expect(wall).not.toHaveBeenCalled();
    wall.mockRestore();
  });
  it('drops an untrustworthy basis if the monotonic clock ever runs backwards, and reset() forgets everything', () => {
    const { state, clock } = make(1000);
    clock.addSample({ sentMonoMs: 1000, receivedMonoMs: 1000, serverMs: 5_000_000 });
    state.now = 500;
    expect(clock.nowServerMs()).toBeNull();
    state.now = 1500;
    expect(clock.nowServerMs()).toBe(5_000_500);
    clock.reset();
    expect(clock.nowServerMs()).toBeNull();
  });
  it('notifies subscribers when the basis appears or is reset, not for refused samples', () => {
    const { clock } = make(1000);
    const listener = vi.fn();
    const off = clock.subscribe(listener);
    clock.addSample({ sentMonoMs: NaN, receivedMonoMs: 1, serverMs: 1 });
    expect(listener).not.toHaveBeenCalled();
    clock.addSample({ sentMonoMs: 1000, receivedMonoMs: 1000, serverMs: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    clock.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    off(); clock.addSample({ sentMonoMs: 1000, receivedMonoMs: 1000, serverMs: 5 });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
