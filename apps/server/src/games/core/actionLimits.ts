// ============================================================
// Per-action protection for game sockets (G4 D).
//
// Key: server-resolved room + participant + action group. Never an IP (a shared
// WLAN/NAT must keep working), never a client-claimed id, never the socket or the
// commandId — several tabs, a reconnect or fresh command ids share one budget.
// In-memory and single-instance by design; a restart starts with full budgets
// (documented in docs/implementation/g4-results-protection/limits.md).
// ============================================================

/** Groups keep a spammer's budget away from unrelated duties (e.g. buzz spam never blocks the host's finish). */
import { randomUUID } from 'node:crypto';

export type LimitGroup = 'PLAYER_INPUT' | 'HOST_CONTROL' | 'RESULT_COMMAND' | 'READ' | 'REPLAY' | 'DENIED';

/**
 * Token buckets: a burst of `capacity`, then `refillPerSec` sustained.
 * Chosen from real play: a player may tap answer/buzz/joker a few times a second
 * (bursts of ~5 are normal, mashing a buzzer reaches ~10/s); a host judges, reveals
 * and advances at most about once per second; result commands are rare, deliberate
 * actions; every client re-reads once per `game:core:changed`.
 * REPLAY counts retries of an already known own command (transport retries after a lost
 * acknowledgement): a separate, more generous budget, so a retry never competes with new
 * intents yet a replay flood stays bounded. DENIED counts commands refused for lack of role
 * or right: a viewer cannot burn database reads and log lines with commands it may never send.
 */
export const ACTION_LIMITS: Record<LimitGroup, { capacity: number; refillPerSec: number }> = {
  PLAYER_INPUT: { capacity: 20, refillPerSec: 5 },
  HOST_CONTROL: { capacity: 30, refillPerSec: 5 },
  RESULT_COMMAND: { capacity: 10, refillPerSec: 1 },
  READ: { capacity: 40, refillPerSec: 8 },
  REPLAY: { capacity: 60, refillPerSec: 10 },
  DENIED: { capacity: 30, refillPerSec: 3 },
};

const PLAYER_INPUT = new Set(['answer', 'joker5050', 'jokerSpy', 'jokerRisk', 'buzz', 'stealBuzz', 'steal_buzz', 'joker', 'submit']);
const HOST_CONTROL = new Set(['judge', 'stealJudge', 'steal_judge', 'reveal', 'next', 'advance', 'fieldOpen', 'field_open', 'boardSwitch', 'board_switch', 'open', 'hint', 'buzzerOverride']);
export function limitGroupForAction(action: string): LimitGroup {
  if (PLAYER_INPUT.has(action)) return 'PLAYER_INPUT';
  if (HOST_CONTROL.has(action)) return 'HOST_CONTROL';
  return 'HOST_CONTROL'; // every other guarded action is a host duty (the lifecycle sockets are not part of this guard)
}

export type LimitDecision = { ok: true } | { ok: false; retryAfterMs: number; firstRejection: boolean; traceId: string };

/** `streakTraceId` ties every rejection of one streak to the single diagnostic line written for it. */
interface Bucket { tokens: number; updatedAt: number; rejectedSince: number | null; streakTraceId: string | null }

export class ActionLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private readonly now: () => number = Date.now, private readonly maxKeys = 5000,
    private readonly limits: typeof ACTION_LIMITS = ACTION_LIMITS) {}

  /** Consumes one token; only call for a new intent of an already authorised identity. */
  consume(roomId: string, participantId: string, group: LimitGroup): LimitDecision {
    const { capacity, refillPerSec } = this.limits[group];
    const key = `${roomId}|${participantId}|${group}`, now = this.now();
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: capacity, updatedAt: now, rejectedSince: null, streakTraceId: null };
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * refillPerSec / 1000);
    bucket.updatedAt = now;
    this.buckets.delete(key); // re-insert: Map order doubles as least-recently-used order
    let decision: LimitDecision;
    if (bucket.tokens >= 1) { bucket.tokens -= 1; bucket.rejectedSince = null; bucket.streakTraceId = null; decision = { ok: true }; }
    else {
      const first = bucket.rejectedSince === null;
      bucket.rejectedSince ??= now; // one log line per rejection streak, not per rejected request
      bucket.streakTraceId ??= randomUUID();
      decision = { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) * 1000 / refillPerSec), firstRejection: first, traceId: bucket.streakTraceId };
    }
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.sweep();
    return decision;
  }

  /** Drops buckets that are full again (no memory of a past spammer) and, as a hard cap, the oldest ones. */
  sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      const group = key.slice(key.lastIndexOf('|') + 1) as LimitGroup;
      const { capacity, refillPerSec } = this.limits[group];
      if (bucket.tokens + (now - bucket.updatedAt) * refillPerSec / 1000 >= capacity) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) { if (this.buckets.size <= this.maxKeys) break; this.buckets.delete(key); }
  }

  size(): number { return this.buckets.size; }
}

export const actionLimiter = new ActionLimiter();
const sweeper = setInterval(() => actionLimiter.sweep(), 60_000);
sweeper.unref();
