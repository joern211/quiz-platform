import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlaybackController, DRIFT_TOLERANCE_MS, MAX_DRIFT_SEEKS, MIN_RESEEK_INTERVAL_MS, START_POSITION_TIMEOUT_MS, START_SEEK_RETRY_MS } from './AudioPlaybackController';
import { SCOPE, SERVER_BASE, createWorld, flush, playProjection } from './testKit';

afterEach(() => { vi.restoreAllMocks(); });

/** A started controller on a manual world. Server time = SERVER_BASE + mono; the default plan starts at mono 5000 (10 s clip). */
function mount(options: { rejectOnPause?: boolean; withClock?: boolean } = {}) {
  const world = createWorld(options);
  const controller = new AudioPlaybackController({ clock: world.clock, createAudio: world.createAudio, scheduler: world.scheduler, monoNow: world.monoNow });
  controller.start();
  return { world, controller, status: () => controller.getSnapshot().status, el: () => world.newestElement() };
}
type M = ReturnType<typeof mount>;
/** Load the newest element's metadata and let the controller react. */
const loaded = async (m: M) => { m.el().loadMetadata(); await flush(); };
/** Play from the start: apply, wait for the anchor, load, resolve play(). */
async function playing(m: M, anchorMono = 0) {
  m.controller.apply(playProjection({ anchorMono }));
  await loaded(m);
  await m.world.advance(0);
  m.el().startPlayback(); await flush();
}

describe('C. Asynchronous races: nothing stale can start, stop, break or keep playing', () => {
  for (const rejectOnPause of [false, true]) {
    describe(rejectOnPause ? 'browser aborts pending play() on pause' : 'worst case: a late fulfilment starts the sound', () => {
      it('A.play() pending → plan becomes PAUSED → late fulfilment of A leaves A silent', async () => {
        const m = mount({ rejectOnPause });
        m.controller.apply(playProjection({ anchorMono: 0 }));
        await loaded(m);
        const a = m.el();
        expect(a.playCalls).toBe(1);
        m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 0, playbackVersion: 2, stateVersion: 6 }));
        expect(a.paused).toBe(true);
        a.startPlayback(); await flush(); // the late fulfilment
        expect(a.paused).toBe(true);
        expect(a.running).toBe(false);
        expect(m.status()).toBe('PAUSED');
      });
      it.each([
        ['STOPPED', () => playProjection({ status: 'STOPPED', positionMs: 0, playbackVersion: 2, stateVersion: 6 })],
        ['ENDED', () => playProjection({ status: 'ENDED', playbackVersion: 2, stateVersion: 6 })],
        ['withdrawn (null)', () => null],
      ])('A.play() pending → %s → late fulfilment of A leaves A silent', async (_name, next) => {
        const m = mount({ rejectOnPause });
        m.controller.apply(playProjection({ anchorMono: 0 }));
        await loaded(m);
        const a = m.el();
        m.controller.apply(next());
        a.startPlayback(); await flush();
        expect(a.paused).toBe(true);
        expect(a.running).toBe(false);
      });
      it('A.play() pending → unmount → late fulfilment of A leaves A silent and nothing is left registered', async () => {
        const m = mount({ rejectOnPause });
        m.controller.apply(playProjection({ anchorMono: 0 }));
        await loaded(m);
        const a = m.el();
        m.controller.stop();
        a.startPlayback(); await flush();
        expect(a.paused).toBe(true);
        expect(a.srcRemoved).toBe(true);
        expect(a.listenerCount).toBe(0);
        expect(m.world.timersPending()).toBe(0);
      });
      it('A.play() pending → clip B loaded: A\'s late fulfilment / rejection / cleanup neither starts, stops nor fails B', async () => {
        const m = mount({ rejectOnPause });
        m.controller.apply(playProjection({ anchorMono: 0 }));
        await loaded(m);
        const a = m.el();
        // B: another playback instance (new playback id), plays normally
        const bScope = { ...SCOPE, playbackId: 'pb-2' };
        m.controller.apply(playProjection({ anchorMono: 0, scope: bScope, url: '/api/v1/media/clip-b?sig=1' }));
        const b = m.el();
        expect(b).not.toBe(a);
        await loaded(m);
        b.startPlayback(); await flush();
        const bPauses = b.pauseCalls, bPlays = b.playCalls;
        expect(b.running).toBe(true);
        a.startPlayback(); await flush();     // A's pending play() is fulfilled late
        a.failPlay('NotAllowedError'); await flush(); // and a late rejection arrives as well
        a.fire('error'); a.fire('ended'); a.fire('loadedmetadata'); await flush();
        expect(a.paused).toBe(true);           // A is silent
        expect(b.running).toBe(true);          // B is untouched
        expect(b.pauseCalls).toBe(bPauses);
        expect(b.playCalls).toBe(bPlays);
        expect(m.status()).toBe('PLAYING');    // no AUTOPLAY_BLOCKED / ERROR from A
      });
    });
  }

  it('old loadedmetadata / canplay / error / ended after a source change cannot change the new plan', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    const a = m.el();
    m.controller.apply(playProjection({ anchorMono: 0, url: '/api/v1/media/clip-a?sig=renewed' })); // renewed URL → new resource
    const b = m.el();
    expect(b).not.toBe(a);
    expect(a.listenerCount).toBe(0); // listeners are gone, not merely ignored
    for (const type of ['loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'error', 'ended']) a.fire(type);
    await flush();
    expect(m.status()).toBe('LOADING'); // B has no metadata yet; A's events did not make it ERROR/ENDED/ready
    expect(b.playCalls).toBe(0);
  });

  it('equal input is a no-op: new wrapper objects, repeated snapshots with other snapshot versions / server stamps never replay or reload', async () => {
    const m = mount();
    await playing(m);
    const el = m.el();
    const plays = el.playCalls, loads = el.loadCalls, seeks = el.seeks.length, elements = m.world.elements.length;
    for (let i = 0; i < 25; i++) m.controller.apply(playProjection({ anchorMono: 0, stateVersion: 6 + i, serverNowMs: SERVER_BASE + i * 100 }));
    for (let i = 0; i < 20; i++) await m.world.advance(100); // clock ticks / housekeeping
    expect(el.playCalls).toBe(plays);
    expect(el.loadCalls).toBe(loads);
    expect(el.seeks.length).toBe(seeks);
    expect(m.world.elements.length).toBe(elements);
    expect(m.status()).toBe('PLAYING');
  });

  it('an operation is bound to its attempt: pause then resume while the first play() is still pending leaves exactly the newer attempt in charge', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    const el = m.el();
    m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 0, playbackVersion: 2, stateVersion: 6 }));
    m.controller.apply(playProjection({ anchorMono: 0, playbackVersion: 3, stateVersion: 7 })); // resume (anchor already due)
    expect(el.playCalls).toBe(2);
    // the OLD attempt is fulfilled after the new one was requested: it must not pause the new one
    el.pending[0].resolve(); await flush();
    expect(el.running).toBe(true);
    expect(el.paused).toBe(false);
  });

  it('a LATE REJECTION of an overtaken attempt cannot mark the resource blocked or cancel the newer attempt (pause → resume while the first play() is pending)', async () => {
    for (const name of ['NotAllowedError', 'AbortError', 'NotSupportedError']) {
      const m = mount();
      m.controller.apply(playProjection({ anchorMono: 0 }));
      await loaded(m);
      const el = m.el();
      m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 0, playbackVersion: 2, stateVersion: 6 }));
      m.controller.apply(playProjection({ anchorMono: 0, playbackVersion: 3, stateVersion: 7 }));
      expect(el.playCalls).toBe(2);
      el.pending[0].reject(Object.assign(new Error(name), { name })); await flush(); // the OLD attempt fails late
      expect(m.status(), name).not.toBe('AUTOPLAY_BLOCKED');
      expect(m.status(), name).not.toBe('ERROR');
      el.startPlayback(); await flush(); // the NEWER attempt is fulfilled
      expect(m.status(), name).toBe('PLAYING');
      expect(el.running, name).toBe(true);
    }
  });
  it('start() → stop() → start() on the same instance (StrictMode) leaves exactly one live element, no listener or timer of the first life', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    const first = m.el();
    m.controller.stop();
    m.controller.start();
    expect(first.listenerCount).toBe(0);
    expect(first.paused).toBe(true);
    const live = m.world.elements.filter(e => e.listenerCount > 0);
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe(first);
    m.controller.stop();
    expect(m.world.elements.every(e => e.listenerCount === 0 && e.paused)).toBe(true);
    expect(m.world.timersPending()).toBe(0);
  });

  it('clock subscription is released on stop (no reaction after unmount)', async () => {
    const m = mount({ withClock: false });
    m.controller.apply(playProjection({ anchorMono: 0 }));
    m.controller.stop();
    m.world.clock.addSample({ sentMonoMs: 0, receivedMonoMs: 0, serverMs: SERVER_BASE });
    await flush();
    expect(m.world.elements.every(e => e.playCalls === 0)).toBe(true);
  });
});

describe('D. Time and loading', () => {
  it('never starts before the anchor: silent at anchor-1, starts exactly at the anchor, from the position valid then', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 5000 }));
    await loaded(m);
    expect(m.status()).toBe('WAITING_FOR_START');
    await m.world.advance(4999);
    expect(m.el().playCalls).toBe(0);
    await m.world.advance(1);
    expect(m.el().playCalls).toBe(1);
    expect(m.el().currentTime).toBe(0); // the element stood at the target already: no seek was needed
  });
  it('a LATE first delivery plays the position valid now, not 0', async () => {
    const m = mount();
    await m.world.advance(8000); // the projection arrives 3 s after the anchor
    m.controller.apply(playProjection({ anchorMono: 5000 }));
    await loaded(m);
    expect(m.el().playCalls).toBe(1);
    expect(m.el().seeks.at(-1)).toBeCloseTo(3, 3);
  });
  it('metadata arriving later than the start time seeks to the position that is valid when it arrives', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 5000 }));
    await m.world.advance(7000);
    expect(m.status()).toBe('LOADING');
    expect(m.el().playCalls).toBe(0);
    expect(m.el().seeks).toEqual([]); // no seek into a medium without metadata
    await loaded(m);
    expect(m.el().seeks.at(-1)).toBeCloseTo(2, 3);
    expect(m.el().playCalls).toBe(1);
  });
  it('joining after the end never starts the clip', async () => {
    const m = mount();
    await m.world.advance(15_000); // plan over at 15000 (anchor 5000 + 10 s)
    m.controller.apply(playProjection({ anchorMono: 5000 }));
    await loaded(m);
    expect(m.status()).toBe('ENDED');
    expect(m.world.elements.every(e => e.playCalls === 0)).toBe(true);
  });
  it('waking from background: elapsed time counts, a throttled timer does not skip it (resync) — and past the end it stops', async () => {
    const m = mount();
    await playing(m, 0);
    expect(m.el().running).toBe(true);
    m.world.sleep(4000); // the tab slept; timers did not fire, the media element stood still
    m.controller.resync();
    await flush();
    expect(m.el().seeks.at(-1)).toBeCloseTo(4, 2); // jumped to where the plan is NOW
    m.world.sleep(20_000); // far beyond the end
    m.controller.resync();
    await flush();
    expect(m.status()).toBe('ENDED');
    expect(m.el().paused).toBe(true);
  });
  it('without a clock basis nothing starts and no sync is claimed; a later sample starts the clip at the current position', async () => {
    const m = mount({ withClock: false });
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    expect(m.status()).toBe('AWAITING_CLOCK');
    await m.world.advance(3000);
    expect(m.el().playCalls).toBe(0);
    m.world.clock.addSample({ sentMonoMs: 3000, receivedMonoMs: 3000, serverMs: SERVER_BASE + 3000 });
    await flush();
    expect(m.el().playCalls).toBe(1);
    expect(m.el().seeks.at(-1)).toBeCloseTo(3, 3);
  });
  it('unusable media state: no metadata → no seek, no play, no throw; a seek that throws is survived', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    expect(m.status()).toBe('LOADING');
    expect(m.el().seeks).toEqual([]);
    expect(m.el().playCalls).toBe(0);
    Object.defineProperty(m.el(), 'currentTime', { set: () => { throw new Error('InvalidStateError'); }, get: () => 0, configurable: true });
    await loaded(m);
    expect(m.el().playCalls).toBe(1);
  });
  it('converts milliseconds to seconds exactly once (1500 ms → 1.5 s)', async () => {
    const m = mount();
    await m.world.advance(6500);
    m.controller.apply(playProjection({ anchorMono: 5000 }));
    await loaded(m);
    expect(m.el().seeks.at(-1)).toBe(1.5);
  });

  describe('drift correction stays inside its documented bounds', () => {
    it('within the tolerance nothing is corrected; beyond it exactly one seek', async () => {
      const m = mount();
      await playing(m, 0);
      const seeksAfterStart = m.el().seeks.length;
      m.el().drift((DRIFT_TOLERANCE_MS - 50) / 1000);
      await m.world.advance(500);
      expect(m.el().seeks.length).toBe(seeksAfterStart);
      m.el().drift(1.0);
      await m.world.advance(300);
      expect(m.el().seeks.length).toBe(seeksAfterStart + 1);
    });
    it('a medium that ignores seeks cannot cause a seek loop: at most MAX_DRIFT_SEEKS, never closer than the cooldown', async () => {
      const m = mount();
      await playing(m, 0);
      const stamps: number[] = [];
      Object.defineProperty(m.el(), 'currentTime', { get: () => 0.0, set: () => { stamps.push(m.world.mono); }, configurable: true }); // always 5+ s off, ignores seeks
      await m.world.advance(9000);
      const corrections = stamps.length;
      expect(corrections).toBeLessThanOrEqual(MAX_DRIFT_SEEKS);
      expect(corrections).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(MIN_RESEEK_INTERVAL_MS);
    });
    it('reports BUFFERING (no seek, no restart) while the element lacks data', async () => {
      const m = mount();
      await playing(m, 0);
      const seeks = m.el().seeks.length;
      m.el().readyState = 2; m.el().fire('waiting'); await flush();
      expect(m.status()).toBe('BUFFERING');
      m.el().drift(5);
      await m.world.advance(2000);
      expect(m.el().seeks.length).toBe(seeks);
      expect(m.el().playCalls).toBe(1);
    });
  });
});

describe('E. Access URL, errors, autoplay', () => {
  it('a renewed URL for the SAME clip keeps the plan: new element, same anchor, continues at the current position, never from the start', async () => {
    const m = mount();
    await playing(m, 0);
    await m.world.advance(3000);
    const old = m.el();
    m.controller.apply(playProjection({ anchorMono: 0, url: '/api/v1/media/clip-a?sig=renewed', stateVersion: 6 }));
    const fresh = m.el();
    expect(fresh).not.toBe(old);
    expect(old.paused).toBe(true);
    expect(old.srcRemoved).toBe(true);
    expect(old.listenerCount).toBe(0);
    await loaded(m);
    expect(fresh.seeks.at(-1)).toBeGreaterThan(3 - 0.05);
    expect(fresh.seeks.at(-1)).toBeLessThan(3.5);
    expect(fresh.playCalls).toBe(1);
  });
  it('autoplay blocked is its own LOCAL state; the user action plays the CURRENT plan at the CURRENT position, synchronously', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    m.el().failPlay('NotAllowedError'); await flush();
    expect(m.status()).toBe('AUTOPLAY_BLOCKED');
    expect(m.controller.getSnapshot().canActivate).toBe(true);
    await m.world.advance(4000); // the plan moved on while the user hesitated
    const el = m.el();
    const before = el.playCalls;
    m.controller.activate();
    expect(el.playCalls).toBe(before + 1); // play() was called inside the gesture, not after an await
    expect(el.seeks.at(-1)).toBeCloseTo(4, 2); // not the start of the clip
    el.startPlayback(); await flush();
    expect(m.status()).toBe('PLAYING');
  });
  it.each([
    ['the clip is over', () => playProjection({ status: 'ENDED', playbackVersion: 2, stateVersion: 6 })],
    ['the plan is paused', () => playProjection({ status: 'PAUSED', positionMs: 1000, playbackVersion: 2, stateVersion: 6 })],
    ['the plan is stopped', () => playProjection({ status: 'STOPPED', positionMs: 1000, playbackVersion: 2, stateVersion: 6 })],
    ['the authorisation was withdrawn', () => null],
  ])('activation after the user hesitated until %s starts nothing', async (_name, next) => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    m.el().failPlay('NotAllowedError'); await flush();
    const el = m.el(), before = el.playCalls;
    m.controller.apply(next());
    m.controller.activate();
    expect(m.world.elements.every(e => e.running === false)).toBe(true);
    expect(el.playCalls).toBe(before);
    expect(m.controller.getSnapshot().canActivate).toBe(false);
  });
  it('a time-expired clip is not restarted by the activation either', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    m.el().failPlay('NotAllowedError'); await flush();
    await m.world.advance(30_000);
    const el = m.el(), before = el.playCalls;
    m.controller.activate();
    expect(el.playCalls).toBe(before);
    expect(m.status()).toBe('ENDED');
  });
  it('a media error is LOCAL: retry reloads the same authorised source and asks for a fresh URL; plan, identity and position are kept', async () => {
    const m = mount();
    await playing(m, 0);
    await m.world.advance(2000);
    const renew = vi.fn();
    m.el().fire('error'); await flush();
    expect(m.status()).toBe('ERROR');
    expect(m.controller.getSnapshot().canRetry).toBe(true);
    expect(m.el().paused).toBe(true);
    m.controller.retry(renew);
    expect(renew).toHaveBeenCalledTimes(1);
    await loaded(m);
    expect(m.el().seeks.at(-1)).toBeCloseTo(2, 1); // the plan's position, not 0
    expect(m.el().playCalls).toBe(1);
    expect(m.controller.getSnapshot().phase).toBe('PLAYING');
  });
  it('an old error cannot mark a new clip broken, and an error of the current clip is shown neutrally (no URL, no raw text)', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    const a = m.el();
    m.controller.apply(playProjection({ anchorMono: 0, scope: { ...SCOPE, playbackId: 'pb-2' }, url: '/api/v1/media/clip-b?sig=1' }));
    a.fire('error'); await flush();
    expect(m.status()).not.toBe('ERROR');
    m.el().fire('error'); await flush();
    expect(m.status()).toBe('ERROR');
    expect(JSON.stringify(m.controller.getSnapshot())).not.toMatch(/api\/v1|sig=|clip-b/);
  });
  it('local ended / failure / retry never changes the server plan: the held projection is exactly what the server sent', async () => {
    const m = mount();
    const projection = playProjection({ anchorMono: 0 });
    const copy = JSON.stringify(projection);
    m.controller.apply(projection);
    await loaded(m);
    m.el().startPlayback(); await flush();
    m.el().fire('ended'); await flush();
    expect(m.status()).toBe('ENDED');
    expect(JSON.stringify(projection)).toBe(copy);
    expect(Object.keys(m.controller.getSnapshot()).sort()).toEqual(['canActivate', 'canRetry', 'durationMs', 'phase', 'positionMs', 'status']);
  });
  it('LOAD_ONLY loads but never plays; a later PLAY at a newer version plays that same resource', async () => {
    const m = mount();
    m.controller.apply({ ...playProjection(), release: 'LOAD_ONLY', plan: null });
    expect(m.status()).toBe('PRELOADED');
    await loaded(m);
    expect(m.el().playCalls).toBe(0);
    const pre = m.el();
    m.controller.apply(playProjection({ anchorMono: 0, playbackVersion: 2, stateVersion: 6 }));
    expect(m.el()).toBe(pre); // same source → no second element, no second load
    expect(pre.playCalls).toBe(1);
  });
  it('a TERMINAL plan (no source) releases the element at once and loads nothing: stop / end leave no element, listener or timer behind', async () => {
    for (const status of ['STOPPED', 'ENDED'] as const) {
      const m = mount();
      await playing(m, 0);
      const el = m.el();
      m.controller.apply(playProjection({ status, positionMs: 3000, playbackVersion: 2, stateVersion: 6 }));
      expect(el.paused).toBe(true);
      expect(el.srcRemoved).toBe(true);
      expect(el.listenerCount).toBe(0);
      expect(m.world.timersPending()).toBe(0);
      expect(m.status()).toBe(status);
      expect(m.world.elements).toHaveLength(1); // no replacement element
    }
  });
  it('a late joiner whose first projection is already terminal creates no element at all and fetches nothing', async () => {
    for (const status of ['STOPPED', 'ENDED'] as const) {
      const m = mount();
      m.controller.apply(playProjection({ status, positionMs: 3000 }));
      expect(m.world.elements).toHaveLength(0);
      expect(m.status()).toBe(status);
      m.controller.activate(); m.controller.retry(); m.controller.resync();
      expect(m.world.elements).toHaveLength(0);
    }
  });
  it('after an autoplay refusal a NEW plan is a new decision: play() is tried again (the user may have interacted meanwhile)', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    m.el().failPlay('NotAllowedError'); await flush();
    expect(m.status()).toBe('AUTOPLAY_BLOCKED');
    const el = m.el();
    m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 0, playbackVersion: 2, stateVersion: 6 }));
    m.controller.apply(playProjection({ anchorMono: 0, playbackVersion: 3, stateVersion: 7 }));
    expect(el.playCalls).toBe(2);
    el.startPlayback(); await flush();
    expect(m.status()).toBe('PLAYING');
  });
  it('a new renewal number for the SAME url string changes nothing at the media element (no reload, no seek)', async () => {
    const m = mount();
    await playing(m, 0);
    const el = m.el(), loads = el.loadCalls, seeks = el.seeks.length, made = m.world.elements.length;
    m.controller.apply(playProjection({ anchorMono: 0, renewal: 5, stateVersion: 6 }));
    await m.world.advance(500);
    expect(el.loadCalls).toBe(loads);
    expect(el.seeks.length).toBe(seeks);
    expect(m.world.elements).toHaveLength(made);
  });
  it('a plan whose source was dropped as OLDER holds NO element and loads nothing: RUNNING shows the neutral error with the retrieval action, PAUSED shows the plan', async () => {
    const m = mount();
    m.controller.apply({ ...playProjection({ anchorMono: 0 }), source: null }); // RUNNING, source dropped by the intake
    expect(m.world.elements).toHaveLength(0);
    expect(m.status()).toBe('ERROR');
    expect(m.controller.getSnapshot().canRetry).toBe(true);
    const renew = vi.fn();
    m.controller.retry(renew);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(m.world.elements).toHaveLength(0); // nothing old is reloaded
    m.controller.apply({ ...playProjection({ status: 'PAUSED', positionMs: 3000, playbackVersion: 2, stateVersion: 6 }), source: null });
    expect(m.status()).toBe('PAUSED');
    expect(m.world.elements).toHaveLength(0);
    // a genuinely current source arrives: the clip loads and plays at the position valid now
    m.controller.apply(playProjection({ anchorMono: 0, playbackVersion: 3, stateVersion: 7, renewal: 21 }));
    expect(m.world.elements).toHaveLength(1);
    await loaded(m);
    expect(m.el().playCalls).toBe(1);
  });
  it('a dropped preload (LOAD_ONLY without a source) also holds no element and offers the retrieval action', async () => {
    const m = mount();
    m.controller.apply({ ...playProjection(), release: 'LOAD_ONLY', plan: null, source: null });
    expect(m.world.elements).toHaveLength(0);
    expect(m.status()).toBe('ERROR');
  });
  it('a scheduled start can be cancelled by a pause before it fires: no timer survives, nothing is played', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 5000 }));
    await loaded(m);
    m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 0, playbackVersion: 2, stateVersion: 6 }));
    expect(m.world.timersPending()).toBe(0);
    await m.world.advance(20_000);
    expect(m.el().playCalls).toBe(0);
    expect(m.status()).toBe('PAUSED');
  });
  it('pause → resume continues from the stored offset after a long pause, not from 0 and not from the elapsed wall time', async () => {
    const m = mount();
    await playing(m, 0);
    await m.world.advance(3000);
    m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 3000, playbackVersion: 2, stateVersion: 6 }));
    expect(m.el().paused).toBe(true);
    await m.world.advance(120_000); // two minutes pass while paused
    m.controller.apply(playProjection({ status: 'RUNNING', positionMs: 3000, anchorMono: 123_000 + 500, playbackVersion: 3, stateVersion: 7 }));
    await m.world.advance(500);
    m.el().startPlayback(); await flush();
    expect(m.el().currentTime).toBeCloseTo(3, 1); // stored offset (the element already stood there: a verified position needs no seek)
    expect(m.status()).toBe('PLAYING');
  });
});

describe('N7-02. A local end belongs to the plan decision it was reported under', () => {
  it('a trailing ended after a pause is ignored; a later authoritative resume plays again (same element, same URL)', async () => {
    const m = mount();
    await playing(m, 0);
    const el = m.el();
    await m.world.advance(3000);
    m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 3000, playbackVersion: 2, stateVersion: 6 }));
    el.fire('ended'); await flush(); // queued before the pause, dispatched after it
    expect(m.status()).toBe('PAUSED');
    m.controller.apply(playProjection({ anchorMono: 3000, positionMs: 3000, playbackVersion: 3, stateVersion: 7 }));
    expect(el.playCalls).toBe(2);
    el.startPlayback(); await flush();
    expect(m.status()).toBe('PLAYING');
    expect(m.world.elements).toHaveLength(1);
  });
  it('a trailing ended that arrives AFTER the resume plan was taken (the element is not at its end any more) does not suppress it', async () => {
    const m = mount();
    await playing(m, 0);
    const el = m.el();
    await m.world.advance(3000);
    m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 3000, playbackVersion: 2, stateVersion: 6 }));
    m.controller.apply(playProjection({ anchorMono: 3000, positionMs: 3000, playbackVersion: 3, stateVersion: 7 }));
    el.ended = false; el.fire('ended'); await flush(); // stale: the element is playing / pending, `ended` is false
    el.startPlayback(); await flush();
    expect(m.status()).toBe('PLAYING');
    expect(el.running).toBe(true);
  });
  it('an early local end followed by a valid pause and resume does not override the server plan', async () => {
    const m = mount();
    await playing(m, 0);
    const el = m.el();
    await m.world.advance(9800);
    el.pause(); el.ended = true; el.fire('ended'); await flush(); // media ended slightly before the authoritative end
    expect(m.status()).toBe('ENDED');
    m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 9800, playbackVersion: 2, stateVersion: 6 }));
    expect(m.status()).toBe('PAUSED');
    await m.world.advance(1000);
    el.ended = false;
    m.controller.apply(playProjection({ anchorMono: 10_800, positionMs: 9800, playbackVersion: 3, stateVersion: 7 }));
    expect(el.playCalls).toBe(2);
    el.startPlayback(); await flush();
    expect(m.status()).toBe('PLAYING');
  });
  it('a REAL local end under an unchanged plan is final: no loop, no restart at 0, ticks / equal plans / new wrapper objects do not clear it', async () => {
    const m = mount();
    await playing(m, 0);
    const el = m.el();
    await m.world.advance(9000);
    el.pause(); el.ended = true; el.fire('ended'); await flush();
    expect(m.status()).toBe('ENDED');
    const plays = el.playCalls, seeks = el.seeks.length;
    for (let i = 0; i < 12; i++) { m.controller.apply(playProjection({ anchorMono: 0, stateVersion: 6 + i, serverNowMs: SERVER_BASE + i })); await m.world.advance(100); }
    m.controller.resync(); await m.world.advance(500);
    expect(m.status()).toBe('ENDED');
    expect(el.playCalls).toBe(plays);
    expect(el.seeks.length).toBe(seeks);
    expect(el.paused).toBe(true);
  });
  it('server stop / end / withdrawal after a local end stay silent', async () => {
    for (const next of [() => playProjection({ status: 'STOPPED', positionMs: 9000, playbackVersion: 2, stateVersion: 6 }), () => playProjection({ status: 'ENDED', playbackVersion: 2, stateVersion: 6 }), () => null]) {
      const m = mount();
      await playing(m, 0);
      const el = m.el();
      await m.world.advance(9000);
      el.pause(); el.ended = true; el.fire('ended'); await flush();
      m.controller.apply(next());
      await m.world.advance(5000);
      expect(m.world.elements.every(e => e.paused && !e.running)).toBe(true);
      expect(el.playCalls).toBe(1);
    }
  });
  it('an ended event while the plan does NOT expect playback (paused, scheduled, ready) is never recorded', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 5000 })); // scheduled
    await loaded(m);
    m.el().ended = true; m.el().fire('ended'); await flush();
    expect(m.status()).toBe('WAITING_FOR_START');
    await m.world.advance(5000);
    expect(m.el().playCalls).toBe(1); // the scheduled start still happens
  });
});

describe('N7-03. The first audible start verifiably stands at the current target', () => {
  /** A late joiner (4 s after the anchor) on an element whose setter / seekable state we control. */
  async function lateJoin(setup: (el: ReturnType<typeof createWorld>['elements'][number]) => void, durationMs = 10_000) {
    const m = mount();
    await m.world.advance(4000);
    m.controller.apply(playProjection({ anchorMono: 0, durationMs }));
    setup(m.el());
    await loaded(m);
    return m;
  }
  it('a throwing setter: silent and LOADING; when seeking works again it starts at the CURRENT position, not at the stale 4 s target', async () => {
    const m = await lateJoin(el => { el.seekMode = 'throw'; });
    const el = m.el();
    expect(el.playCalls).toBe(0);
    expect(el.paused).toBe(true);
    expect(m.status()).toBe('LOADING');
    await m.world.advance(2000);
    expect(el.playCalls).toBe(0);
    el.seekMode = 'immediate';
    await m.world.advance(500);
    expect(el.playCalls).toBe(1);
    expect(el.seeks.at(-1)).toBeGreaterThan(6.0);
    expect(el.seeks.at(-1)).toBeLessThan(6.8);
  });
  it('a silently ignored seek (no range yet): silent until it takes effect; setter attempts are spaced, not a tight loop', async () => {
    const m = await lateJoin(el => { el.seekMode = 'ignore'; }, 30_000);
    const el = m.el();
    let attempts = 0;
    Object.defineProperty(el, 'currentTime', { get: () => 0, set: () => { attempts++; }, configurable: true });
    await m.world.advance(9000);
    expect(el.playCalls).toBe(0);
    expect(m.status()).toBe('LOADING');
    expect(attempts).toBeLessThanOrEqual(Math.ceil(9000 / START_SEEK_RETRY_MS) + 1);
    expect(attempts).toBeGreaterThanOrEqual(5);
  });
  it('a seek that stays impossible ends in a NEUTRAL error with a retry action, never in an audible wrong start', async () => {
    const m = await lateJoin(el => { el.seekMode = 'ignore'; }, 30_000);
    await m.world.advance(START_POSITION_TIMEOUT_MS + 1000);
    expect(m.status()).toBe('ERROR');
    expect(m.controller.getSnapshot().canRetry).toBe(true);
    expect(m.world.elements.every(e => e.playCalls === 0)).toBe(true);
    JSON.stringify(m.controller.getSnapshot()); // no URL / path in the snapshot
    expect(JSON.stringify(m.controller.getSnapshot())).not.toMatch(/api\/v1|sig=/);
  });
  it('the target is not seekable yet (ranges): no setter call and no play; when the range arrives the CURRENT target is used', async () => {
    const m = await lateJoin(el => { el.seekableRanges = [[0, 2]]; });
    const el = m.el();
    await m.world.advance(1500);
    expect(el.seeks).toEqual([]); // never a blind setter call
    expect(el.playCalls).toBe(0);
    el.seekableRanges = [[0, 12]]; el.fire('progress'); await flush();
    expect(el.playCalls).toBe(1);
    expect(el.seeks.at(-1)).toBeGreaterThan(5.4);
  });
  it('an asynchronous seek is not a finished seek: no play while `seeking`; a clamped result is verified, retried, and only a correct one starts', async () => {
    const m = await lateJoin(el => { el.seekMode = 'async'; });
    const el = m.el();
    expect(el.seeking).toBe(true);
    expect(el.playCalls).toBe(0);
    el.completeSeek(2); await flush(); // the browser clamped 4 s down to 2 s
    expect(el.playCalls).toBe(0);
    await m.world.advance(600); // retry spacing
    expect(el.seeking).toBe(true);
    el.completeSeek(); await flush(); // now it lands where requested
    expect(el.playCalls).toBe(1);
    expect(el.currentTime).toBeGreaterThanOrEqual(4.5);
  });
  it('the clip ends while the controller is still waiting: it never starts', async () => {
    const m = await lateJoin(el => { el.seekMode = 'ignore'; });
    await m.world.advance(7000); // plan over at 10 s of server time since the anchor
    expect(m.status()).toBe('ENDED');
    expect(m.world.elements.every(e => e.playCalls === 0)).toBe(true);
  });
  it('withdrawal / pause / clip change while waiting: nothing starts, and late seek events of the old element are ignored', async () => {
    for (const next of ['pause', 'withdraw', 'clip'] as const) {
      const m = await lateJoin(el => { el.seekMode = 'async'; });
      const old = m.el();
      if (next === 'pause') m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 4000, playbackVersion: 2, stateVersion: 6 }));
      if (next === 'withdraw') m.controller.apply(null);
      if (next === 'clip') m.controller.apply(playProjection({ anchorMono: 4000, scope: { ...SCOPE, playbackId: 'pb-2' }, url: '/api/v1/media/clip-b?sig=1' }));
      old.completeSeek(); old.fire('progress'); old.fire('loadeddata'); await flush();
      expect(old.playCalls).toBe(0);
      expect(m.world.elements.filter(e => e !== m.el() || next === 'pause').every(e => e.playCalls === 0)).toBe(true);
      m.controller.stop();
    }
  });
  it('while waiting for the position a NEW plan (resume at another offset) is taken: the start uses the new target', async () => {
    const m = await lateJoin(el => { el.seekMode = 'ignore'; }, 30_000);
    const el = m.el();
    await m.world.advance(1000);
    m.controller.apply(playProjection({ status: 'PAUSED', positionMs: 5000, playbackVersion: 2, stateVersion: 6, durationMs: 30_000 }));
    expect(m.status()).toBe('PAUSED');
    m.controller.apply(playProjection({ anchorMono: 5000 + 500, positionMs: 20_000, playbackVersion: 3, stateVersion: 7, durationMs: 30_000 }));
    el.seekMode = 'immediate';
    await m.world.advance(1500);
    expect(el.playCalls).toBe(1);
    expect(el.seeks.at(-1)).toBeGreaterThanOrEqual(20); // the stored 20 s offset (+ time since the new anchor), not the stale 4 s / 5 s targets
    expect(el.seeks.at(-1)).toBeLessThan(21.5);
  });
  it('a renewal during the wait starts the new resource with a fresh wait (the old waiting time is not inherited)', async () => {
    const m = await lateJoin(el => { el.seekMode = 'ignore'; }, 30_000);
    await m.world.advance(START_POSITION_TIMEOUT_MS - 1000);
    expect(m.status()).toBe('LOADING');
    m.controller.apply(playProjection({ anchorMono: 0, url: '/api/v1/media/clip-a?sig=renewed', renewal: 2, durationMs: 30_000 }));
    const fresh = m.el();
    fresh.seekMode = 'ignore';
    fresh.loadMetadata(); await flush();
    await m.world.advance(3000);
    expect(m.status()).toBe('LOADING'); // would be ERROR if the 9 s already waited had been carried over
    expect(fresh.playCalls).toBe(0);
  });
  it('the user activation while the position is impossible neither throws nor plays; once possible the CURRENT position is used', async () => {
    const m = await lateJoin(el => { el.seekMode = 'throw'; }, 30_000);
    const el = m.el();
    expect(() => m.controller.activate()).not.toThrow();
    expect(el.playCalls).toBe(0);
    await m.world.advance(2000);
    el.seekMode = 'immediate';
    await m.world.advance(600);
    expect(el.playCalls).toBe(1);
    expect(el.seeks.at(-1)).toBeGreaterThan(6.4);
  });
  it('an immediate start at a position already reached needs no seek, and the user activation still plays synchronously', async () => {
    const m = mount();
    m.controller.apply(playProjection({ anchorMono: 0 }));
    await loaded(m);
    expect(m.el().playCalls).toBe(1);
    expect(m.el().seeks).toEqual([]);
    m.el().failPlay('NotAllowedError'); await flush();
    await m.world.advance(3000);
    const before = m.el().playCalls;
    m.controller.activate();
    expect(m.el().playCalls).toBe(before + 1); // inside the gesture, after a verified position
  });
});
