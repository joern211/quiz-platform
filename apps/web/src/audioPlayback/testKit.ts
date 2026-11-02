// TEST-ONLY helpers for the N7 browser controller: a controllable Audio double, a manual scheduler tied to a manual monotonic clock.
// Server time in these tests is always SERVER_BASE + mono, so "the plan anchor at server time SERVER_BASE + 5000" means mono 5000.
import { AUDIO_PLAYBACK_CONTRACT, type AudioPlaybackProjection } from '@quiz/shared/audioPlayback';
import type { AudioLike, Scheduler } from './AudioPlaybackController';
import { createServerClock, type ServerClock } from './serverClock';

export const SERVER_BASE = 1_000_000;
export const SCOPE = { runIndex: 2, roundId: 'round-1', playbackId: 'pb-1', contentRevision: 'rev-1' };

type Pending = { resolve: () => void; reject: (error: Error) => void; settled: boolean };

/** HTMLAudioElement double. `rejectOnPause` models a browser that aborts pending play() promises on pause(); false models the worst case in which a late fulfilment starts the sound. */
export class FakeAudio implements AudioLike {
  src = ''; preload = ''; paused = true; readyState = 0;
  playCalls = 0; pauseCalls = 0; loadCalls = 0; srcRemoved = false;
  seeks: number[] = [];
  pending: Pending[] = [];
  private listeners = new Map<string, Set<() => void>>();
  private t = 0; // playhead in seconds
  get currentTime(): number { return this.t; }
  /** Every assignment is a seek and is recorded. */
  set currentTime(v: number) { this.t = v; this.seeks.push(v); }
  /** Move the playhead WITHOUT recording a seek (the media simply drifted). */
  drift(seconds: number): void { this.t += seconds; }
  constructor(private readonly rejectOnPause = false) {}
  get listenerCount(): number { let n = 0; for (const set of this.listeners.values()) n += set.size; return n; }
  /** Played time model: the playhead advances while the media is really running. */
  running = false;
  play(): Promise<void> {
    this.playCalls++; this.paused = false;
    return new Promise<void>((resolve, reject) => {
      const p: Pending = { settled: false, resolve: () => { if (p.settled) return; p.settled = true; this.paused = false; this.running = true; resolve(); }, reject: error => { if (p.settled) return; p.settled = true; reject(error); } };
      this.pending.push(p);
    });
  }
  pause(): void {
    this.pauseCalls++; this.paused = true; this.running = false;
    if (this.rejectOnPause) for (const p of this.pending) p.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  }
  load(): void { this.loadCalls++; this.readyState = 0; }
  removeAttribute(name: string): void { if (name === 'src') { this.src = ''; this.srcRemoved = true; } }
  addEventListener(type: string, fn: () => void): void { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn); }
  removeEventListener(type: string, fn: () => void): void { this.listeners.get(type)?.delete(fn); }
  fire(type: string): void { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(); }
  // helpers for tests
  loadMetadata(): void { this.readyState = 4; this.fire('loadedmetadata'); this.fire('canplay'); }
  /** Resolve the latest outstanding play() (the browser started playback). */
  startPlayback(): void { this.pending.filter(p => !p.settled).at(-1)?.resolve(); }
  /** A refused play() leaves the element paused (HTML spec: NotAllowedError is raised before `paused` is cleared). */
  failPlay(name: string): void { this.paused = true; this.running = false; this.pending.filter(p => !p.settled).at(-1)?.reject(Object.assign(new Error(name), { name })); }
  tick(ms: number): void { if (this.running && !this.paused) this.t += ms / 1000; }
}
export interface World {
  mono: number;
  elements: FakeAudio[];
  clock: ServerClock;
  scheduler: Scheduler;
  monoNow: () => number;
  createAudio: () => FakeAudio;
  /** Advance monotonic time, firing due timers in order; the playhead of running elements follows. */
  advance(ms: number): Promise<void>;
  /** Jump the monotonic clock WITHOUT firing timers (device sleep / throttled background tab). */
  sleep(ms: number): void;
  timersPending(): number;
  newestElement(): FakeAudio;
}
export function createWorld(options: { rejectOnPause?: boolean; withClock?: boolean } = {}): World {
  const timers = new Set<{ due: number; every?: number; fn: () => void }>();
  const world = {
    mono: 0, elements: [] as FakeAudio[],
  } as World;
  const mono = { nowMs: () => world.mono };
  world.clock = createServerClock(mono);
  if (options.withClock !== false) world.clock.addSample({ sentMonoMs: 0, receivedMonoMs: 0, serverMs: SERVER_BASE });
  world.monoNow = () => world.mono;
  world.scheduler = {
    after(ms, fn) { const t = { due: world.mono + ms, fn }; timers.add(t); return () => { timers.delete(t); }; },
    every(ms, fn) { const t = { due: world.mono + ms, every: ms, fn }; timers.add(t); return () => { timers.delete(t); }; },
  };
  world.createAudio = () => { const el = new FakeAudio(options.rejectOnPause ?? false); world.elements.push(el); return el; };
  world.newestElement = () => world.elements.at(-1)!;
  world.timersPending = () => timers.size;
  world.sleep = ms => { world.mono += ms; };
  world.advance = async ms => {
    const end = world.mono + ms;
    for (;;) {
      const next = [...timers].filter(t => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      const step = Math.max(0, next.due - world.mono);
      for (const el of world.elements) el.tick(step);
      world.mono = next.due;
      if (next.every) next.due += next.every; else timers.delete(next);
      next.fn();
      await flush();
    }
    for (const el of world.elements) el.tick(end - world.mono);
    world.mono = end;
    await flush();
  };
  return world;
}
export const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

/** A PLAY projection whose plan anchor is at mono `anchorMono` (server time SERVER_BASE + anchorMono). */
export function playProjection(over: Partial<AudioPlaybackProjection> & { anchorMono?: number; positionMs?: number; status?: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'ENDED' | 'READY'; url?: string } = {}): AudioPlaybackProjection {
  const { anchorMono = 5000, positionMs = 0, status = 'RUNNING', url = '/api/v1/media/clip-a?exp=1&sig=a', ...rest } = over;
  const plan = status === 'RUNNING' ? { status, positionMs, anchorServerMs: SERVER_BASE + anchorMono }
    : { status, positionMs: status === 'ENDED' ? 10_000 : positionMs, anchorServerMs: null };
  return { contract: AUDIO_PLAYBACK_CONTRACT, scope: { ...SCOPE }, stateVersion: 5, playbackVersion: 1, release: 'PLAY', serverNowMs: SERVER_BASE, durationMs: 10_000, source: { url }, plan, ...rest } as AudioPlaybackProjection;
}
