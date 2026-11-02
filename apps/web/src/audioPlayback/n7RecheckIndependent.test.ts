import { describe, expect, it } from 'vitest';
import { intakeAudioPlayback } from './playbackIntake';
import { playProjection, SCOPE } from './testKit';

const expected = { ...SCOPE, minStateVersion: 3 };

describe('Independent N7 recheck at 84821b2', () => {
  it.each([null, undefined, { malformed: true }])('keeps minimal renewal knowledge over an empty/invalid intermediate view (%j)', empty => {
    const fresh = playProjection({ renewal: 20, url: '/api/v1/media/a?sig=fresh' });
    const old = playProjection({ renewal: 10, url: '/api/v1/media/a?sig=old' });
    const a = intakeAudioPlayback(null, expected, fresh);
    const b = intakeAudioPlayback(a.memo, expected, empty);
    expect(b.held).toBeNull();
    expect(JSON.stringify(b.memo)).not.toContain('sig=fresh');
    const c = intakeAudioPlayback(b.memo, expected, old);
    expect(c.held?.source?.url).not.toBe(old.source!.url);
    const d = intakeAudioPlayback(c.memo, expected, fresh);
    expect(d.held?.source?.url).toBe(fresh.source!.url);
  });
});
