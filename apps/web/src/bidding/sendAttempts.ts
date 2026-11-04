// ============================================================
// N10 — Send attempts of the bidding panel (pure, no React, no DOM)
//
// ONE state machine for every way a send can be answered (N10-01 / N10-02). A press that is allowed to send creates an ATTEMPT — an identity of its own next to the target binding:
// the application echoes it (`attemptId`), the numeric field is bound to it (`fieldAttemptId`), and every later event — a rejected promise, a feedback report — applies to THIS
// attempt only. That is what keeps three things apart that a binding key alone cannot:
//   - a late rejection of attempt 1 can never release the retry (attempt 2) that is already in flight on the same binding;
//   - one rejection report releases ONE retry, however many presses arrive in the same task (the decision is made on the CURRENT store, held in a ref — never on the closure of a render);
//   - a report that was applied once is never applied again (consumed signatures), while a NEW report with identical text stays distinguishable by its `attemptId` / `id`.
// Reports WITHOUT `attemptId` apply to the current attempt of their binding; reports without `attemptId` and `id` are identified by their content only and therefore take effect at most
// once — an application that reports the same text for several attempts must give each report an `id` or the `attemptId` it was handed.
// The store is immutable; every function returns the next store (or the same object when nothing changes).
// ============================================================

import type { NumericValue } from '@quiz/shared/numeric';

export type AttemptKind = 'BID' | 'PASS';
export type AttemptOutcome = 'SENT' | 'PENDING' | 'ACCEPTED' | 'REJECTED';
export interface Attempt {
  /** identity of this send (monotone per panel) — handed to the application and echoed in its reports */
  id: string;
  contextKey: string;
  bindingKey: string;
  kind: AttemptKind;
  /** the NumberField attempt (`<contextKey>#<n>`) of a bid, null for a pass */
  fieldAttemptId: string | null;
  value: NumericValue | null;
  outcome: AttemptOutcome;
  message: string | null;
}
/** A bid submit of the numeric field that was NOT sent because another attempt held the binding (the field believes it submitted: it must be told, or it waits forever). */
export interface DroppedFieldAttempt { contextKey: string; bindingKey: string; fieldAttemptId: string }
export interface AttemptStore { seq: number; current: Attempt | null; consumed: readonly string[]; dropped: DroppedFieldAttempt | null }
export const emptyAttemptStore: AttemptStore = { seq: 0, current: null, consumed: [], dropped: null };

const MAX_CONSUMED = 64;
export interface AttemptFeedback { bindingKey: string; attemptId?: string; id?: string | number; status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; message?: string }

/** The report's identity: binding, attempt, report id, status and text. Equal signature = the same report. */
export const feedbackSignature = (fb: AttemptFeedback): string => JSON.stringify([fb.bindingKey, fb.attemptId ?? null, fb.id ?? null, fb.status, fb.message ?? null]);

const active = (attempt: Attempt): boolean => attempt.outcome !== 'REJECTED';
/** Does a (not rejected) attempt hold the lock of exactly this target binding? Bid and pass share it. */
export function holdsLock(store: AttemptStore, contextKey: string, bindingKey: string): boolean {
  const cur = store.current;
  return cur !== null && cur.contextKey === contextKey && cur.bindingKey === bindingKey && active(cur);
}

/** Starts an attempt for a press, or returns null when the binding is locked by an attempt that is not rejected. The decision uses THIS store — callers pass the current ref value. */
export function startAttempt(store: AttemptStore, args: { contextKey: string; bindingKey: string; kind: AttemptKind; fieldAttemptId?: string | null; value?: NumericValue | null }): { store: AttemptStore; attempt: Attempt } | null {
  if (holdsLock(store, args.contextKey, args.bindingKey)) return null;
  const seq = store.seq + 1;
  const attempt: Attempt = {
    id: `a${seq}`, contextKey: args.contextKey, bindingKey: args.bindingKey, kind: args.kind, fieldAttemptId: args.fieldAttemptId ?? null, value: args.value ?? null, outcome: 'SENT', message: null,
  };
  return { store: { seq, current: attempt, consumed: store.consumed, dropped: null }, attempt };
}

/**
 * The numeric field submitted, but the press was refused because an attempt of this binding is in flight (e.g. a pass in the same task). The field has opened an attempt of its own and
 * waits for an answer to it: the refusal is remembered, so the panel can answer that attempt with a retryable error (N10-02). Nothing was sent.
 */
export function dropFieldAttempt(store: AttemptStore, dropped: DroppedFieldAttempt): AttemptStore {
  return { ...store, dropped };
}

/** A rejected promise: releases the attempt that was handed to THAT callback and no other. A rejection of an older attempt changes nothing. */
export function rejectAttempt(store: AttemptStore, attemptId: string, message: string | null): AttemptStore {
  const cur = store.current;
  if (cur === null || cur.id !== attemptId || cur.outcome === 'REJECTED' || cur.outcome === 'ACCEPTED') return store;
  return { ...store, current: { ...cur, outcome: 'REJECTED', message } };
}

/**
 * An application report. Applied at most once (consumed signature); for the current attempt of its binding only — a report that names another attempt, another binding or another context, or
 * one that arrives after the attempt has settled, only becomes consumed. PENDING never un-settles; ACCEPTED and REJECTED are final for the attempt.
 */
export function applyFeedback(store: AttemptStore, feedback: AttemptFeedback, contextKey: string): AttemptStore {
  const sig = feedbackSignature(feedback);
  if (store.consumed.includes(sig)) return store;
  const consumed = [...store.consumed, sig].slice(-MAX_CONSUMED);
  const cur = store.current;
  const applies = cur !== null && cur.contextKey === contextKey && cur.bindingKey === feedback.bindingKey && (feedback.attemptId === undefined || feedback.attemptId === cur.id)
    && cur.outcome !== 'ACCEPTED' && cur.outcome !== 'REJECTED';
  if (!applies || cur === null) return { ...store, consumed };
  const outcome: AttemptOutcome = feedback.status === 'REJECTED' ? 'REJECTED' : feedback.status === 'ACCEPTED' ? 'ACCEPTED' : 'PENDING';
  return { ...store, consumed, current: { ...cur, outcome, message: feedback.status === 'REJECTED' ? feedback.message ?? null : cur.message } };
}
