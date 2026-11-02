// ============================================================
// N7 — Estimated SERVER time in the browser (small, injectable, monotonic)
//
// The browser wall clock (Date.now) is NEVER the server time: it can be minutes off and can be changed at any moment. The server
// stamp inside an event does not include the transport delay either. This clock therefore needs a ROUND-TRIP SAMPLE taken on the
// browser's MONOTONIC clock (performance.now): the browser notes `sentMonoMs`, the server answers with its time `serverMs`, the
// browser notes `receivedMonoMs`. Assumption: the delay is symmetric, so the server time at receipt is serverMs + rtt/2; the error
// of that estimate is bounded by ± rtt/2 (reported as uncertaintyMs). Between samples the estimate advances with the monotonic clock
// only, so a change of the wall clock cannot restart or skip audio.
//
// The clock keeps the sample with the SMALLEST round trip (the best bound), and refuses samples that cannot be true. WITHOUT a valid
// sample nowServerMs() is null — callers must not pretend to be synchronised. A push-only stamp (no send time) is deliberately not
// accepted: it cannot give a bound.
//
// Not delivered here (the later engine must): the transport that produces a sample (e.g. a ping with acknowledgement), its repetition
// and the handling of a reconnect. N7 adds no network endpoint.
// ============================================================

export interface MonotonicClock { nowMs(): number }
export const performanceClock: MonotonicClock = { nowMs: () => performance.now() };

export interface ClockSample { sentMonoMs: number; receivedMonoMs: number; serverMs: number }

/** A sample slower than this says too little about the offset to be used. A bound, not a promise. */
export const MAX_ACCEPTED_RTT_MS = 5000;

export interface ServerClock {
  /** Offer a round-trip sample; true if it is now the basis. Invalid samples change nothing. */
  addSample(sample: ClockSample): boolean;
  /** Estimated server time in whole ms, or null without a valid basis. */
  nowServerMs(): number | null;
  /** ± bound of the estimate (half the kept round trip, ms), or null without a basis. */
  uncertaintyMs(): number | null;
  /** Forget the basis (e.g. after a reconnect). */
  reset(): void;
  /** Called whenever the basis appears, improves or is reset. */
  subscribe(listener: () => void): () => void;
}

export function createServerClock(mono: MonotonicClock = performanceClock): ServerClock {
  let best: ClockSample | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const valid = (s: ClockSample): boolean => {
    if (!s || typeof s !== 'object') return false;
    const { sentMonoMs, receivedMonoMs, serverMs } = s;
    if (![sentMonoMs, receivedMonoMs, serverMs].every(Number.isFinite)) return false;
    if (!Number.isSafeInteger(serverMs) || serverMs < 0) return false;
    const rtt = receivedMonoMs - sentMonoMs;
    if (rtt < 0 || rtt > MAX_ACCEPTED_RTT_MS) return false;
    const now = mono.nowMs();
    return Number.isFinite(now) && receivedMonoMs <= now; // a sample cannot come from the future of our own monotonic clock
  };
  return {
    addSample(sample) {
      if (!valid(sample)) return false;
      if (best && sample.receivedMonoMs - sample.sentMonoMs > best.receivedMonoMs - best.sentMonoMs) return false;
      best = { sentMonoMs: sample.sentMonoMs, receivedMonoMs: sample.receivedMonoMs, serverMs: sample.serverMs };
      notify();
      return true;
    },
    nowServerMs() {
      if (!best) return null;
      const now = mono.nowMs();
      if (!Number.isFinite(now) || now < best.receivedMonoMs) return null; // the monotonic clock cannot run backwards: no trustworthy basis
      return Math.round(best.serverMs + (best.receivedMonoMs - best.sentMonoMs) / 2 + (now - best.receivedMonoMs));
    },
    uncertaintyMs() { return best ? (best.receivedMonoMs - best.sentMonoMs) / 2 : null; },
    reset() { if (best) { best = null; notify(); } },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
