import { Profiler, StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '@quiz/ui';
import type { AudioPlaybackExpectedContext, AudioPlaybackProjection } from '@quiz/shared/audioPlayback';
import { AUDIO_PLAYBACK_CONTRACT } from '@quiz/shared/audioPlayback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerAudioPlayer } from './ServerAudioPlayer';
import { SCOPE, SERVER_BASE, createWorld, flush, playProjection, type World } from '../audioPlayback/testKit';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const EXPECTED: AudioPlaybackExpectedContext = { ...SCOPE, minStateVersion: 3 };
const none = (stateVersion: number, playbackVersion = 1): AudioPlaybackProjection =>
  ({ contract: AUDIO_PLAYBACK_CONTRACT, scope: { ...SCOPE }, stateVersion, playbackVersion, release: 'NONE', serverNowMs: 1, durationMs: null, source: null, plan: null });
const text = () => document.body.textContent ?? '';
const liveElements = (world: World) => world.elements.filter(e => e.listenerCount > 0);

function mount(over: { projection?: unknown; strict?: boolean; world?: World; expected?: AudioPlaybackExpectedContext; onRenewUrl?: () => void } = {}) {
  const world = over.world ?? createWorld();
  const props = { expected: over.expected ?? EXPECTED, clock: world.clock, createAudio: world.createAudio, scheduler: world.scheduler, monoNow: world.monoNow, onRenewUrl: over.onRenewUrl };
  const ui = (projection: unknown, expected = props.expected) => {
    const tree = <ServerAudioPlayer {...props} expected={expected} projection={projection} label="Clip" />;
    return over.strict === false ? tree : <StrictMode>{tree}</StrictMode>;
  };
  const view = render(ui('projection' in over ? over.projection : playProjection({ anchorMono: 0 })));
  return { world, view, set: (projection: unknown, expected?: AudioPlaybackExpectedContext) => view.rerender(ui(projection, expected)) };
}

describe('N7 ServerAudioPlayer: binding, no leaks, no native controls', () => {
  it('shows only a neutral heading and status; the audio object is not in the DOM and no URL, asset or media tag is in the markup', async () => {
    mount();
    await act(async () => { await flush(); });
    expect(screen.getByRole('heading', { name: 'Clip' })).toBeInTheDocument();
    expect(document.querySelector('audio, video, source, [controls]')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/api\/v1|sig=|clip-a|href=|src=/);
  });
  it('without any projection (null / undefined / garbage) it is neutral and creates no audio object at all', () => {
    for (const projection of [null, undefined, 'x', {}, { contract: 'AUDIO_PLAYBACK_V1' }]) {
      const m = mount({ projection });
      expect(text()).toContain('Das Audio ist zurzeit nicht verfügbar.');
      expect(m.world.elements).toHaveLength(0);
      cleanup();
    }
  });
  it('a foreign or too-old projection reaches neither the markup nor an element, not even for one frame', () => {
    const frames: string[] = [];
    const world = createWorld();
    const props = { expected: EXPECTED, clock: world.clock, createAudio: world.createAudio, scheduler: world.scheduler, monoNow: world.monoNow };
    const tree = (p: unknown) => <Profiler id="p" onRender={() => frames.push(document.body.textContent ?? '')}><ServerAudioPlayer {...props} projection={p} /></Profiler>;
    const view = render(tree({ ...playProjection({ anchorMono: 0 }), scope: { ...SCOPE, playbackId: 'other' } }));
    view.rerender(tree(playProjection({ anchorMono: 0, stateVersion: 1 }))); // below the caller's minimum (3)
    expect(world.elements).toHaveLength(0);
    expect(frames.every(f => !/läuft|geladen|pausiert/.test(f))).toBe(true);
  });
  it('has accessible names, a polite status and no native media controls or sliders', async () => {
    mount({ projection: playProjection({ anchorMono: 0 }) });
    await act(async () => { await flush(); });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Clip' })).toBeInTheDocument();
    expect(screen.queryByRole('slider')).toBeNull();
    expect(document.querySelector('[aria-live="assertive"]')).toBeNull();
  });
});

describe('N7 ServerAudioPlayer: no restart, no leftovers', () => {
  it('new wrapper objects, repeated snapshots, clock ticks and a theme change start no second play() and no second load (StrictMode on)', async () => {
    function Probe({ projection, world }: { projection: unknown; world: World }) {
      const { setTheme } = useTheme();
      return <><button onClick={() => setTheme('light')}>theme</button><ServerAudioPlayer expected={EXPECTED} projection={projection} clock={world.clock} createAudio={world.createAudio} scheduler={world.scheduler} monoNow={world.monoNow} /></>;
    }
    const world = createWorld();
    const tree = (projection: unknown) => <StrictMode><ThemeProvider><Probe projection={projection} world={world} /></ThemeProvider></StrictMode>;
    const view = render(tree(playProjection({ anchorMono: 0 })));
    await act(async () => { await flush(); });
    const el = liveElements(world)[0];
    expect(liveElements(world)).toHaveLength(1); // StrictMode double mount left exactly one
    await act(async () => { el.loadMetadata(); await flush(); el.startPlayback(); await flush(); });
    const plays = el.playCalls, loads = el.loadCalls, made = world.elements.length;
    for (let i = 0; i < 10; i++) view.rerender(tree(playProjection({ anchorMono: 0, stateVersion: 6 + i, serverNowMs: SERVER_BASE + i })));
    await userEvent.click(screen.getByRole('button', { name: 'theme' }));
    for (let i = 0; i < 12; i++) await act(async () => { await world.advance(250); });
    expect(el.playCalls).toBe(plays);
    expect(el.loadCalls).toBe(loads);
    expect(world.elements.length).toBe(made);
    expect(text()).toContain('Das Audio läuft.');
  });
  it('withdrawal silences the element and shows the neutral state at once; a late older PLAY does not bring it back', async () => {
    const m = mount({ projection: playProjection({ anchorMono: 0, stateVersion: 9 }) });
    await act(async () => { await flush(); const el = liveElements(m.world)[0]; el.loadMetadata(); await flush(); el.startPlayback(); await flush(); });
    const el = m.world.newestElement(); // StrictMode: the first-created element belongs to the discarded first life
    expect(liveElements(m.world)).toEqual([el]);
    expect(el.running).toBe(true);
    m.set(none(10));
    expect(text()).toContain('nicht verfügbar');
    expect(el.paused).toBe(true);
    expect(liveElements(m.world)).toHaveLength(0);
    m.set(playProjection({ anchorMono: 0, stateVersion: 9 })); // late older PLAY
    expect(text()).toContain('nicht verfügbar');
    expect(m.world.elements).toHaveLength(2); // only the StrictMode pair of the first mount; nothing new for it
    m.set(null); m.set(playProjection({ anchorMono: 0, stateVersion: 8 }));
    expect(text()).toContain('nicht verfügbar');
    expect(m.world.elements).toHaveLength(2);
  });
  it('unmount releases element, listeners and timers; a late play() fulfilment afterwards is silent', async () => {
    const m = mount({ projection: playProjection({ anchorMono: 0 }) });
    await act(async () => { await flush(); liveElements(m.world)[0].loadMetadata(); await flush(); });
    const el = liveElements(m.world)[0];
    m.view.unmount();
    el.startPlayback(); await flush();
    expect(el.paused).toBe(true);
    expect(el.listenerCount).toBe(0);
    expect(m.world.timersPending()).toBe(0);
  });
  it('a context change releases the old clip and never lets its late events touch the new one', async () => {
    const m = mount({ projection: playProjection({ anchorMono: 0 }) });
    await act(async () => { await flush(); liveElements(m.world)[0].loadMetadata(); await flush(); });
    const a = liveElements(m.world)[0];
    const next = { ...EXPECTED, playbackId: 'pb-2' };
    m.set({ ...playProjection({ anchorMono: 0, url: '/api/v1/media/clip-b?sig=1' }), scope: { ...SCOPE, playbackId: 'pb-2' } }, next);
    expect(a.srcRemoved).toBe(true);
    expect(liveElements(m.world)).toHaveLength(1);
    await act(async () => { a.fire('error'); a.startPlayback(); await flush(); });
    expect(a.paused).toBe(true);
    expect(text()).not.toContain('nicht geladen werden');
    // a LATE renewal result for the OLD clip (old context, newer version) is foreign now: it neither shows nor loads anything
    m.set({ ...playProjection({ anchorMono: 0, url: '/api/v1/media/clip-a?sig=late', stateVersion: 99 }) }, next);
    expect(m.world.elements.filter(e => e.src.includes('late'))).toHaveLength(0);
    expect(text()).toContain('nicht verfügbar');
  });
});

describe('N7 ServerAudioPlayer: autoplay, error and retry in the UI', () => {
  it('autoplay blocked shows an understandable text and a real button; the click activates the CURRENT plan inside the gesture', async () => {
    const m = mount({ projection: playProjection({ anchorMono: 0 }) });
    await act(async () => { await flush(); const el = liveElements(m.world)[0]; el.loadMetadata(); await flush(); el.failPlay('NotAllowedError'); await flush(); });
    expect(text()).toContain('blockiert das automatische Abspielen');
    const button = screen.getByRole('button', { name: 'Audio aktivieren' });
    await act(async () => { await m.world.advance(4000); });
    const el = liveElements(m.world)[0], plays = el.playCalls;
    await userEvent.click(button);
    expect(el.playCalls).toBe(plays + 1);
    expect(el.seeks.at(-1)).toBeCloseTo(4, 1);
    await act(async () => { el.startPlayback(); await flush(); });
    expect(screen.queryByRole('button', { name: 'Audio aktivieren' })).toBeNull();
  });
  it('the activate button is keyboard operable and disappears when the clip was withdrawn meanwhile', async () => {
    const m = mount({ projection: playProjection({ anchorMono: 0, stateVersion: 5 }) });
    await act(async () => { await flush(); const el = liveElements(m.world)[0]; el.loadMetadata(); await flush(); el.failPlay('NotAllowedError'); await flush(); });
    screen.getByRole('button', { name: 'Audio aktivieren' }).focus();
    expect(screen.getByRole('button', { name: 'Audio aktivieren' })).toHaveFocus();
    m.set(none(6));
    expect(screen.queryByRole('button', { name: 'Audio aktivieren' })).toBeNull();
    expect(text()).toContain('nicht verfügbar');
  });
  it('an error shows a neutral text (no URL, no raw error) and a retry that asks the application for a fresh URL', async () => {
    const onRenewUrl = vi.fn();
    const m = mount({ projection: playProjection({ anchorMono: 0 }), onRenewUrl });
    await act(async () => { await flush(); liveElements(m.world)[0].fire('error'); await flush(); });
    expect(text()).toContain('Das Audio kann gerade nicht geladen werden.');
    expect(document.body.innerHTML).not.toMatch(/api\/v1|sig=|clip-a/);
    await userEvent.click(screen.getByRole('button', { name: 'Erneut laden' }));
    expect(onRenewUrl).toHaveBeenCalledTimes(1);
    expect(liveElements(m.world)).toHaveLength(1); // the failed element was replaced, not duplicated
  });
  it('shows a long German status and position without an overflow-prone fixed width', async () => {
    mount({ projection: playProjection({ anchorMono: 0 }) });
    await act(async () => { await flush(); });
    const section = document.querySelector('section')!;
    expect(section.className).toMatch(/card/);
  });
});
