// ============================================================
// N7 — Browser controller for ONE server-controlled clip (framework-free, binds a real HTMLAudioElement)
//
// Input is only what the intake validated: the held projection (scope, versions, release, source URL, duration, plan) or null. The
// controller turns the SERVER PLAN into local media behaviour and keeps the LOCAL media state separate from it: the plan can say
// RUNNING while this browser is still loading, blocked by autoplay, buffering or failed. A fulfilled play() proves nothing about any
// other browser, and no local media event (ended, error, pause) ever changes the plan, the points or the next clip.
//
// Asynchronous work is bound to a RESOURCE GENERATION: every source (scope + URL) gets its own Audio object, a generation number and
// a play-operation counter. A timer, listener, metadata event, error or play() promise acts only if its generation AND element are
// still the current ones. A late fulfilment of an overtaken play() additionally PAUSES ITS OWN old element — an ignored callback alone
// would leave the sound running. Teardown pauses, removes the source, reloads (to stop network work), removes listeners and timers.
//
// Time: the plan is evaluated with the injected ServerClock (monotonic). Before the anchor nothing is audible; the start timer is
// re-evaluated when it fires, so a late timer, late metadata or a late join all land on the position that is valid NOW, never on 0.
// After the clip end nothing starts. Drift is corrected with a seek only beyond DRIFT_TOLERANCE_MS, at most once per
// MIN_RESEEK_INTERVAL_MS and at most MAX_DRIFT_SEEKS times per resource and plan (no seek loop).
// ============================================================

import {
  audioPlaybackPhaseAt, audioPlaybackTargetMs, mediaSecondsToMs, msToMediaSeconds,
  type AudioPlaybackPhase, type AudioPlaybackPlan, type AudioPlaybackProjection, type AudioPlaybackScope,
} from '@quiz/shared/audioPlayback';
import type { ServerClock } from './serverClock';

/** Drift tolerated before a correcting seek (ms). Browser clocks, decoder start-up and seek granularity make a tighter bound untrue. */
export const DRIFT_TOLERANCE_MS = 250;
/** Minimum time between two correcting seeks of one resource (ms). */
export const MIN_RESEEK_INTERVAL_MS = 1000;
/** Upper bound of automatic correcting seeks per resource and plan; afterwards the clip plays on without further correction. */
export const MAX_DRIFT_SEEKS = 5;
/** Housekeeping tick while a clip should be audible (ms). */
export const TICK_MS = 250;
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;

export type LocalStatus =
  | 'UNAVAILABLE' | 'AWAITING_CLOCK' | 'PRELOADED' | 'NOT_STARTED' | 'LOADING' | 'WAITING_FOR_START' | 'PLAYING' | 'BUFFERING'
  | 'PAUSED' | 'STOPPED' | 'ENDED' | 'AUTOPLAY_BLOCKED' | 'ERROR';

export interface AudioLike {
  src: string;
  currentTime: number;
  preload: string;
  readonly paused: boolean;
  readonly readyState: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface Scheduler {
  after(ms: number, fn: () => void): () => void;
  every(ms: number, fn: () => void): () => void;
}
export const browserScheduler: Scheduler = {
  after: (ms, fn) => { const h = setTimeout(fn, ms); return () => clearTimeout(h); },
  every: (ms, fn) => { const h = setInterval(fn, ms); return () => clearInterval(h); },
};

export interface ControllerOptions {
  clock: ServerClock;
  createAudio?: () => AudioLike;
  scheduler?: Scheduler;
  /** Monotonic ms, only used for the re-seek cooldown. */
  monoNow?: () => number;
}

export interface ControllerSnapshot {
  status: LocalStatus;
  /** Derived plan phase at the last evaluation (null without a plan / clock). */
  phase: AudioPlaybackPhase | null;
  /** Server-plan target position (ms) at the last evaluation — not the element's currentTime. */
  positionMs: number | null;
  durationMs: number | null;
  canActivate: boolean;
  canRetry: boolean;
}
const IDLE: ControllerSnapshot = { status: 'UNAVAILABLE', phase: null, positionMs: null, durationMs: null, canActivate: false, canRetry: false };

interface Resource {
  gen: number;
  scope: AudioPlaybackScope;
  url: string;
  element: AudioLike;
  cleanups: Array<() => void>;
  metadataReady: boolean;
  /** Counter of play() attempts; an attempt acts only while it is the latest and the resource is current. */
  playOp: number;
  playPending: boolean;
  /** Local intent: this resource is supposed to be audible. */
  wantPlaying: boolean;
  blocked: boolean;
  errored: boolean;
  localEnded: boolean;
  driftSeeks: number;
  lastSeekMono: number;
  dead: boolean;
}

export class AudioPlaybackController {
  private readonly clock: ServerClock;
  private readonly createAudio: () => AudioLike;
  private readonly scheduler: Scheduler;
  private readonly monoNow: () => number;
  private readonly listeners = new Set<() => void>();
  private snapshot: ControllerSnapshot = IDLE;
  private active = false;
  private held: AudioPlaybackProjection | null = null;
  private appliedKey = '';
  private planKey = '';
  private generation = 0;
  private res: Resource | null = null;
  private cancelStartTimer: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;
  private unsubscribeClock: (() => void) | null = null;

  constructor(options: ControllerOptions) {
    this.clock = options.clock;
    this.createAudio = options.createAudio ?? (() => new Audio() as unknown as AudioLike);
    this.scheduler = options.scheduler ?? browserScheduler;
    this.monoNow = options.monoNow ?? (() => performance.now());
  }

  // ── Public surface ─────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): ControllerSnapshot => this.snapshot;

  /** Begin acting (idempotent). StrictMode may start → stop → start the same instance: nothing is left behind in between. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.unsubscribeClock = this.clock.subscribe(() => this.reconcile());
    this.appliedKey = ''; // re-apply what was held before a stop
    this.apply(this.held);
  }

  /** Stop acting and release EVERYTHING: element, listeners, timers, clock subscription. The desired state is remembered for start(). */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.unsubscribeClock?.(); this.unsubscribeClock = null;
    this.teardownResource();
    this.clearTimers();
    this.generation++; // everything still in flight belongs to a past generation
    this.setSnapshot(IDLE);
  }

  /**
   * The validated projection (or null = no authorisation). Equal input is a no-op: a new wrapper object, a repeated snapshot, a clock
   * tick, a theme change or a re-render never restarts, reloads or seeks. A new source or scope replaces the resource; a renewed URL for
   * the SAME scope replaces only the resource and keeps the plan; a changed plan is re-evaluated against the current resource.
   */
  apply(next: AudioPlaybackProjection | null): void {
    this.held = next;
    if (!this.active) return;
    const key = next === null ? 'NULL' : JSON.stringify([next.scope, next.playbackVersion, next.release, next.source?.url ?? null, next.durationMs, next.plan]);
    if (key === this.appliedKey) return;
    this.appliedKey = key;
    if (next === null) { this.withdraw(); return; }
    // A terminal plan carries no source (nothing left to play): hold no element, load nothing, show the end. Version knowledge is the intake's job.
    if (next.source === null) {
      this.teardownResource(); this.clearTimers(); this.generation++;
      this.planKey = JSON.stringify([next.scope, next.playbackVersion, next.plan]);
      this.reconcile();
      return;
    }
    const sourceChanged = this.res === null || this.res.url !== next.source.url || !sameScope(this.res.scope, next.scope);
    const planKey = JSON.stringify([next.scope, next.playbackVersion, next.plan]);
    // A new plan is a new decision: counters restart and a former autoplay refusal is retried (the user may have interacted since).
    if (planKey !== this.planKey) { this.planKey = planKey; if (this.res) { this.res.driftSeeks = 0; this.res.blocked = false; } }
    if (sourceChanged) { this.replaceResource(next); }
    if (next.release === 'LOAD_ONLY') { this.silence(); this.clearTimers(); this.setStatus('PRELOADED', null, null); return; }
    this.reconcile();
  }

  /** User gesture ("Audio aktivieren"): plays the CURRENT plan at the CURRENT position, synchronously inside the gesture. Starts nothing after end / stop / withdrawal. */
  activate(): void {
    const res = this.res, held = this.held;
    if (!this.active || !res || res.dead || !held?.plan || held.release !== 'PLAY') return;
    const nowS = this.clock.nowServerMs();
    if (nowS === null) return;
    res.blocked = false;
    const phase = audioPlaybackPhaseAt(held.plan, held.durationMs!, nowS);
    if (phase === 'PLAYING' && res.metadataReady && res.element.paused && !res.playPending) { this.startPlay(res, held.plan, held.durationMs!, nowS); return; }
    this.reconcile();
  }

  /** "Erneut laden": reload the SAME authorised source (and ask the application for a fresh URL). Plan and identity stay; no new round, no new clip. */
  retry(onRenewUrl?: () => void): void {
    const held = this.held;
    if (!this.active || !held || held.release === 'NONE' || held.source === null) return;
    if (this.snapshot.status === 'AUTOPLAY_BLOCKED') { this.activate(); return; }
    this.replaceResource(held);
    onRenewUrl?.();
    this.reconcile();
  }

  /** Re-evaluate against the monotonic clock (tab became visible again, device woke up). Timers that were throttled do not skip time. */
  resync(): void { this.reconcile(); }

  // ── Resources ──────────────────────────────────────────────

  private replaceResource(held: AudioPlaybackProjection): void {
    this.teardownResource();
    const gen = ++this.generation;
    const element = this.createAudio();
    const res: Resource = {
      gen, scope: { ...held.scope }, url: held.source!.url, element, cleanups: [], metadataReady: false, playOp: 0, playPending: false,
      wantPlaying: false, blocked: false, errored: false, localEnded: false, driftSeeks: 0, lastSeekMono: -Infinity, dead: false,
    };
    const guard = (fn: () => void) => () => { if (this.res === res && !res.dead && this.generation === gen) fn(); };
    const on = (type: string, fn: () => void) => { const h = guard(fn); element.addEventListener(type, h); res.cleanups.push(() => element.removeEventListener(type, h)); };
    on('loadedmetadata', () => { res.metadataReady = true; this.reconcile(); });
    on('canplay', () => this.reconcile());
    on('playing', () => this.reconcile());
    on('waiting', () => this.reconcile());
    on('stalled', () => this.reconcile());
    on('ended', () => { res.localEnded = true; res.wantPlaying = false; this.reconcile(); });
    on('error', () => { res.errored = true; res.wantPlaying = false; res.playOp++; try { element.pause(); } catch { /* element already unusable */ } this.reconcile(); });
    this.res = res;
    element.preload = 'auto';
    element.src = res.url;
    if (element.readyState >= HAVE_METADATA) res.metadataReady = true;
    try { element.load(); } catch { res.errored = true; }
  }

  private teardownResource(): void {
    const res = this.res;
    if (!res) return;
    this.res = null;
    res.dead = true; res.wantPlaying = false; res.playOp++;
    for (const cleanup of res.cleanups) cleanup();
    res.cleanups = [];
    try { res.element.pause(); res.element.removeAttribute('src'); res.element.load(); } catch { /* best effort: the object is dropped either way */ }
  }

  private withdraw(): void {
    this.teardownResource();
    this.clearTimers();
    this.generation++;
    this.planKey = '';
    this.setSnapshot(IDLE);
  }

  /** Pause this resource and invalidate its pending play attempts. */
  private silence(): void {
    const res = this.res;
    if (!res) return;
    res.wantPlaying = false; res.playOp++; res.playPending = false;
    if (!res.element.paused) { try { res.element.pause(); } catch { /* ignore */ } }
  }

  private clearTimers(): void {
    this.cancelStartTimer?.(); this.cancelStartTimer = null;
    this.cancelTick?.(); this.cancelTick = null;
  }

  // ── The one decision function ──────────────────────────────

  private reconcile(): void {
    const held = this.held, res = this.res;
    if (!this.active || !held) return;
    if (held.release === 'LOAD_ONLY') { this.setStatus('PRELOADED', null, null); return; }
    if (!held.plan || held.durationMs === null) return;
    if (held.source === null) { // terminal plan: no element exists
      this.clearTimers();
      const status = held.plan.status === 'STOPPED' ? 'STOPPED' : 'ENDED';
      this.setStatus(status, status, held.durationMs, status === 'ENDED' ? held.durationMs : held.plan.positionMs);
      return;
    }
    if (!res) return;
    const { plan, durationMs } = held;
    this.clearTimers();
    if (res.errored) { this.silence(); this.setStatus('ERROR', null, durationMs); return; }
    const nowS = this.clock.nowServerMs();
    if (nowS === null) { this.silence(); this.setStatus('AWAITING_CLOCK', null, durationMs); return; } // never claim sync without a basis
    const phase = audioPlaybackPhaseAt(plan, durationMs, nowS);
    const target = audioPlaybackTargetMs(plan, durationMs, nowS);
    switch (phase) {
      case 'READY': this.silence(); this.setStatus('NOT_STARTED', phase, durationMs, target); return;
      case 'PAUSED': this.silence(); this.setStatus('PAUSED', phase, durationMs, target); return;
      case 'STOPPED': this.silence(); this.setStatus('STOPPED', phase, durationMs, target); return;
      case 'ENDED': this.silence(); this.setStatus('ENDED', phase, durationMs, durationMs); return;
      case 'SCHEDULED': {
        this.silence(); // nothing audible before the anchor
        const anchor = plan.anchorServerMs!;
        this.cancelStartTimer = this.scheduler.after(Math.max(1, anchor - nowS), () => this.reconcile());
        this.setStatus(res.metadataReady ? 'WAITING_FOR_START' : 'LOADING', phase, durationMs, target);
        return;
      }
      case 'PLAYING': break;
    }
    // PLAYING by plan: what happens locally depends on the media state. The tick re-evaluates against the clock, so the end of the clip
    // is noticed even while loading, blocked or buffering (it is cleared at the top of every evaluation).
    if (res.localEnded) { this.setStatus('ENDED', phase, durationMs, target); return; }
    this.cancelTick = this.scheduler.every(TICK_MS, () => this.reconcile());
    if (!res.metadataReady) { this.setStatus('LOADING', phase, durationMs, target); return; } // no seek before metadata; the event re-enters here
    if (res.blocked) { this.setStatus('AUTOPLAY_BLOCKED', phase, durationMs, target); return; }
    if (res.element.paused && !res.playPending) { this.startPlay(res, plan, durationMs, nowS); return; }
    this.followPlan(res, durationMs, target);
  }

  private startPlay(res: Resource, plan: AudioPlaybackPlan, durationMs: number, nowS: number): void {
    const target = audioPlaybackTargetMs(plan, durationMs, nowS);
    this.seek(res, target);
    const op = ++res.playOp;
    res.playPending = true; res.wantPlaying = true;
    let attempt: Promise<void>;
    try { attempt = res.element.play(); } catch (error) { attempt = Promise.reject(error); }
    this.setStatus('LOADING', 'PLAYING', durationMs, target);
    const current = () => this.res === res && !res.dead && res.playOp === op;
    attempt.then(() => {
      if (!current()) {
        // overtaken (pause, stop, withdrawal, new clip, unmount): stop what THIS attempt started — but never a newer attempt of the same resource
        if (this.res !== res || !res.wantPlaying) { try { res.element.pause(); } catch { /* ignore */ } }
        return;
      }
      res.playPending = false;
      this.reconcile();
    }, (error: unknown) => {
      if (!current()) return;
      res.playPending = false; res.wantPlaying = false;
      const name = (error as { name?: string } | null)?.name;
      if (name === 'NotAllowedError') res.blocked = true;
      else if (name === 'AbortError') return; // interrupted by our own pause/load; the next evaluation decides
      else res.errored = true;
      this.reconcile();
    });
  }

  private followPlan(res: Resource, durationMs: number, target: number): void {
    if (res.element.paused) { this.setStatus('LOADING', 'PLAYING', durationMs, target); return; } // play() requested, not started yet
    const elementMs = mediaSecondsToMs(res.element.currentTime);
    if (res.element.readyState < HAVE_FUTURE_DATA) { this.setStatus('BUFFERING', 'PLAYING', durationMs, target); return; }
    const mono = this.monoNow();
    if (elementMs !== null && Math.abs(elementMs - target) > DRIFT_TOLERANCE_MS && res.driftSeeks < MAX_DRIFT_SEEKS && mono - res.lastSeekMono >= MIN_RESEEK_INTERVAL_MS) {
      res.driftSeeks++; res.lastSeekMono = mono;
      this.seek(res, target);
    }
    this.setStatus('PLAYING', 'PLAYING', durationMs, target);
  }

  private seek(res: Resource, ms: number): void {
    if (!res.metadataReady) return;
    try { res.element.currentTime = msToMediaSeconds(Math.max(0, Math.round(ms))); } catch { /* not seekable yet: the next evaluation retries within the seek limits */ }
  }

  // ── Snapshot ───────────────────────────────────────────────

  private setStatus(status: LocalStatus, phase: AudioPlaybackPhase | null, durationMs: number | null, positionMs: number | null = null): void {
    // Position is shown per whole second so the UI does not re-render at the housekeeping rate.
    const shown = positionMs === null ? null : Math.floor(positionMs / 1000) * 1000;
    const next: ControllerSnapshot = { status, phase, positionMs: shown, durationMs, canActivate: status === 'AUTOPLAY_BLOCKED', canRetry: status === 'ERROR' };
    this.setSnapshot(next);
  }
  private setSnapshot(next: ControllerSnapshot): void {
    const prev = this.snapshot;
    if (prev.status === next.status && prev.phase === next.phase && prev.positionMs === next.positionMs && prev.durationMs === next.durationMs
      && prev.canActivate === next.canActivate && prev.canRetry === next.canRetry) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

function sameScope(a: AudioPlaybackScope, b: AudioPlaybackScope): boolean {
  return a.runIndex === b.runIndex && a.roundId === b.roundId && a.playbackId === b.playbackId && a.contentRevision === b.contentRevision;
}
