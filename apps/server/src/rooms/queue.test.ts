import { describe, it, expect } from 'vitest';
import { serializeRoom } from './queue.js';

describe('room operation queue', () => {
  it('allows nested viewer admission but keeps competing connections behind the current room operation', async () => {
    const events: string[] = []; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = serializeRoom('nested-room', async () => {
      events.push('subscribe'); await serializeRoom('nested-room', async () => { events.push('viewer-admission'); });
      await barrier; events.push('subscribed');
    });
    const second = serializeRoom('nested-room', async () => { events.push('disconnect'); });
    await Promise.resolve(); await Promise.resolve();
    expect(events).toEqual(['subscribe', 'viewer-admission']);
    release(); await Promise.all([first, second]);
    expect(events).toEqual(['subscribe', 'viewer-admission', 'subscribed', 'disconnect']);
  });
  it('releases on failure without blocking other rooms', async () => {
    const events: string[] = [];
    await expect(serializeRoom('failed-room', async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    await Promise.all([serializeRoom('failed-room', async () => { events.push('recovered'); }), serializeRoom('other-room', async () => { events.push('independent'); })]);
    expect(events.sort()).toEqual(['independent', 'recovered']);
  });
  it('does not let a detached continuation reuse a room lease that has already ended', async () => {
    const events: string[] = []; let wake!: () => void, unlock!: () => void;
    const later = new Promise<void>(resolve => { wake = resolve; }), barrier = new Promise<void>(resolve => { unlock = resolve; });
    let detached!: Promise<void>;
    await serializeRoom('detached-room', async () => { detached = later.then(() => serializeRoom('detached-room', async () => { events.push('detached'); })); });
    const current = serializeRoom('detached-room', async () => { events.push('current'); await barrier; });
    wake(); await Promise.resolve(); await Promise.resolve(); expect(events).toEqual(['current']);
    unlock(); await Promise.all([current, detached]); expect(events).toEqual(['current', 'detached']);
  });
});
