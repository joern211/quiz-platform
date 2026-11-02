import { describe, expect, it } from 'vitest';
import { AudioPlaybackController } from './AudioPlaybackController';
import { intakeAudioPlayback } from './playbackIntake';
import { createWorld, flush, playProjection, SCOPE, SERVER_BASE } from './testKit';

const expected = { ...SCOPE, minStateVersion: 3 };
function mount() {
  const world = createWorld();
  const controller = new AudioPlaybackController({ clock: world.clock, createAudio: world.createAudio, scheduler: world.scheduler, monoNow: world.monoNow });
  controller.start();
  return { world, controller };
}

describe('Independent N7 regression probes at 1cc8cb3', () => {
  it('a delayed older URL response cannot replace a newer URL at the same unchanged plan/snapshot version', () => {
    // The contract now orders renewals by the issuer's renewal number (the review's probe carried none): older = issued first.
    const older = playProjection({ anchorMono: 0, url: '/api/v1/media/clip-a?exp=100&sig=old', serverNowMs: SERVER_BASE + 100, renewal: 1 });
    const newer = playProjection({ anchorMono: 0, url: '/api/v1/media/clip-a?exp=200&sig=new', serverNowMs: SERVER_BASE + 200, renewal: 2 });
    const fresh = intakeAudioPlayback(null, expected, newer);
    const late = intakeAudioPlayback(fresh.memo, expected, older);
    expect(late.held?.source?.url).toBe(newer.source!.url);
  });

  it('a delayed ended event from the previous run cannot suppress a later authoritative resume of the same resource', async () => {
    const { world, controller } = mount();
    controller.apply(playProjection({ anchorMono: 0 }));
    const el = world.newestElement();
    el.loadMetadata(); el.startPlayback(); await flush();
    await world.advance(3000);
    controller.apply(playProjection({ status: 'PAUSED', positionMs: 3000, playbackVersion: 2, stateVersion: 6 }));
    el.fire('ended'); await flush(); // already-queued event, dispatched after the pause
    expect(controller.getSnapshot().status).toBe('PAUSED');
    controller.apply(playProjection({ anchorMono: 3000, positionMs: 3000, playbackVersion: 3, stateVersion: 7 }));
    el.startPlayback(); await flush();
    expect(el.playCalls).toBe(2);
    expect(controller.getSnapshot().status).toBe('PLAYING');
    expect(el.running).toBe(true);
  });

  it('an early local EOF followed by a valid pause/resume must not permanently override the server plan', async () => {
    const { world, controller } = mount();
    controller.apply(playProjection({ anchorMono: 0 }));
    const el = world.newestElement();
    el.loadMetadata(); el.startPlayback(); await flush();
    await world.advance(9800);
    el.pause(); el.fire('ended'); await flush(); // media slightly ahead of server/decoder duration discrepancy
    controller.apply(playProjection({ status: 'PAUSED', positionMs: 9800, playbackVersion: 2, stateVersion: 6 }));
    await world.advance(1000);
    controller.apply(playProjection({ anchorMono: 10800, positionMs: 9800, playbackVersion: 3, stateVersion: 7 }));
    el.startPlayback(); await flush();
    expect(el.playCalls).toBe(2);
    expect(controller.getSnapshot().status).toBe('PLAYING');
  });

  it('late join does not play from zero when the required seek currently throws; it waits and retries safely', async () => {
    const { world, controller } = mount();
    await world.advance(4000);
    controller.apply(playProjection({ anchorMono: 0 }));
    const el = world.newestElement();
    Object.defineProperty(el, 'currentTime', {
      get: () => 0,
      set: () => { throw Object.assign(new Error('media not seekable yet'), { name: 'InvalidStateError' }); },
      configurable: true,
    });
    el.loadMetadata(); await flush();
    expect(el.playCalls).toBe(0);
    expect(el.paused).toBe(true);
    controller.stop();
  });

  it('late join also waits if the seek is silently ignored while no range is seekable yet', async () => {
    const { world, controller } = mount();
    await world.advance(4000);
    controller.apply(playProjection({ anchorMono: 0 }));
    const el = world.newestElement();
    Object.defineProperty(el, 'currentTime', { get: () => 0, set: () => {}, configurable: true });
    el.loadMetadata(); await flush();
    el.startPlayback(); await flush();
    expect(el.playCalls).toBe(0);
    expect(el.paused).toBe(true);
    expect(controller.getSnapshot().status).not.toBe('PLAYING');
    controller.stop();
  });
});
