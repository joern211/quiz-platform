import { describe, expect, it } from 'vitest';
import type { AudioPlaybackExpectedContext, AudioPlaybackProjection } from '@quiz/shared/audioPlayback';
import { AUDIO_PLAYBACK_CONTRACT } from '@quiz/shared/audioPlayback';
import { intakeAudioPlayback, type IntakeMemo, type IntakeResult } from './playbackIntake';
import { SCOPE, playProjection } from './testKit';

const EXPECTED: AudioPlaybackExpectedContext = { ...SCOPE, minStateVersion: 3 };
const play = (stateVersion: number, playbackVersion = 1, url = '/api/v1/media/a?sig=1'): AudioPlaybackProjection => playProjection({ stateVersion, playbackVersion, url });
const none = (stateVersion: number, playbackVersion = 1): AudioPlaybackProjection =>
  ({ contract: AUDIO_PLAYBACK_CONTRACT, scope: { ...SCOPE }, stateVersion, playbackVersion, release: 'NONE', serverNowMs: 1, durationMs: null, source: null, plan: null });
const loadOnly = (stateVersion: number, playbackVersion = 1): AudioPlaybackProjection =>
  ({ contract: AUDIO_PLAYBACK_CONTRACT, scope: { ...SCOPE }, stateVersion, playbackVersion, release: 'LOAD_ONLY', serverNowMs: 1, durationMs: 10_000, source: { url: '/api/v1/media/a?sig=1' }, plan: null });
/** Feed a sequence; returns every result. */
function run(inputs: unknown[], expected = EXPECTED): IntakeResult[] {
  const out: IntakeResult[] = []; let memo: IntakeMemo | null = null;
  for (const input of inputs) { const r = intakeAudioPlayback(memo, expected, input); out.push(r); memo = r.memo; }
  return out;
}
const heldVersion = (r: IntakeResult) => r.held?.stateVersion ?? null;

describe('N7 intake: version knowledge is kept apart from what is playable (analogue of N6 held/seen)', () => {
  it('PLAY v9 → valid withdrawal v10 → late PLAY v9: no source comes back', () => {
    const r = run([play(9), none(10), play(9)]);
    expect(r.map(x => x.outcome)).toEqual(['ACCEPTED', 'RELEASE_NONE', 'STALE']);
    expect(r.map(heldVersion)).toEqual([9, null, null]);
    expect(r[2].memo.seenStateVersion).toBe(10);
  });
  it('PLAY v9 → null → old PLAY v8: no revival in the same context (the 3-step case with an empty intermediate view)', () => {
    const r = run([play(9), null, play(8)]);
    expect(r.map(x => x.outcome)).toEqual(['ACCEPTED', 'WITHDRAWN', 'STALE']);
    expect(r.map(heldVersion)).toEqual([9, null, null]);
    expect(r[1].memo.seenStateVersion).toBe(9); // the knowledge survived the withdrawal
  });
  it('the same holds for undefined, malformed and a longer chain of empty views', () => {
    expect(run([play(9), undefined, 'garbage', { nope: 1 }, play(8), play(7, 1)]).map(heldVersion)).toEqual([9, null, null, null, null, null]);
  });
  it('a re-delivery of the very same snapshot after an empty view is accepted (it is not older)', () => {
    expect(run([play(9), null, play(9)]).map(heldVersion)).toEqual([9, null, 9]);
  });
  it('a valid, matching but source-less view raises the known version (NONE and LOAD_ONLY)', () => {
    const r = run([play(5), none(8), play(6), play(7, 5)]);
    expect(r.map(heldVersion)).toEqual([5, null, null, null]);
    expect(r[3].memo.seenStateVersion).toBe(8);
    expect(run([play(5), loadOnly(8), play(6)]).map(x => x.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'STALE']);
    expect(run([play(5), loadOnly(8), play(6)])[1].held?.plan).toBeNull(); // preload only: nothing to play
  });
  it('a newer legitimate PLAY after a withdrawal is accepted (re-release by a newer snapshot)', () => {
    expect(run([play(9), none(10), play(11)]).map(heldVersion)).toEqual([9, null, 11]);
  });
  it('an invalid or foreign context with an enormous version cannot poison the current context', () => {
    const foreign = { ...play(2 ** 40), scope: { ...SCOPE, playbackId: 'other' } };
    const bad = { ...play(2 ** 40), title: 'extra field' };
    const r = run([play(6), foreign, bad, play(7)]);
    expect(r.map(x => x.outcome)).toEqual(['ACCEPTED', 'WITHDRAWN', 'WITHDRAWN', 'ACCEPTED']);
    expect(r[3].memo.seenStateVersion).toBe(7);
    expect(r[1].memo.seenStateVersion).toBe(6);
  });
  it('the caller\'s own minimum is independent: a projection below it is not an observation, the minimum is not derived from the incoming one', () => {
    const r = run([play(2)], { ...EXPECTED, minStateVersion: 3 });
    expect(r[0]).toMatchObject({ outcome: 'WITHDRAWN', held: null });
    expect(r[0].memo.seenStateVersion).toBe(-1);
    expect(run([play(3)], { ...EXPECTED, minStateVersion: 3 })[0].outcome).toBe('ACCEPTED');
  });
  it('a lower PLAN version is stale even with a higher snapshot version; both numbers are monotone', () => {
    const r = run([play(9, 4), play(10, 3), play(10, 4), play(11, 5)]);
    expect(r.map(x => x.outcome)).toEqual(['ACCEPTED', 'STALE', 'ACCEPTED', 'ACCEPTED']);
    expect(r[1].held?.stateVersion).toBe(9); // the previously held newer view stays
  });
  it('at the SAME snapshot and plan version a renewed URL is accepted; a wider release than the one already seen is not', () => {
    const r = run([play(9, 1, '/api/v1/media/a?sig=1'), play(9, 1, '/api/v1/media/a?sig=2'), none(9, 1), play(9, 1)]);
    expect(r.map(x => x.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'RELEASE_NONE', 'STALE']);
    expect(r[1].held?.source?.url).toBe('/api/v1/media/a?sig=2');
    expect(r[3].held).toBeNull();
    expect(run([play(9), loadOnly(9), play(9)]).map(x => x.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'STALE']);
  });
  it('a terminal projection (STOPPED / ENDED, no source) is held as such; a late older PLAY with a source cannot bring the source back', () => {
    const r = run([play(9), playProjection({ status: 'STOPPED', positionMs: 2000, stateVersion: 10, playbackVersion: 2 }), play(9), play(9, 1)]);
    expect(r.map(x => x.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'STALE', 'STALE']);
    expect(r[1].held?.source).toBeNull();
    expect(r[3].held?.plan?.status).toBe('STOPPED'); // the newer terminal view stays
  });
  it('a real context change (other clip, run, round, revision) starts with EMPTY knowledge; no archive of the old context', () => {
    const a = intakeAudioPlayback(null, EXPECTED, play(50));
    const other = { ...EXPECTED, playbackId: 'pb-2' };
    const b = intakeAudioPlayback(a.memo, other, { ...play(4), scope: { ...SCOPE, playbackId: 'pb-2' } });
    expect(b.outcome).toBe('ACCEPTED');
    expect(b.memo.seenStateVersion).toBe(4);
    // going back to the first context does not remember it either
    const back = intakeAudioPlayback(b.memo, EXPECTED, play(4));
    expect(back.outcome).toBe('ACCEPTED');
    expect(Object.keys(b.memo).sort()).toEqual(['held', 'key', 'seenPlaybackVersion', 'seenRelease', 'seenStateVersion']);
  });
  it('holds nothing but the validated projection and numbers: the memo has no URL for withdrawn or released-NONE views', () => {
    const r = run([play(9), none(10)]);
    expect(JSON.stringify(r[1].memo)).not.toMatch(/api\/v1|sig=/);
  });
  it('consecutive updates: LOAD_ONLY after PLAY keeps a source but drops the plan (nothing playable), a newer PLAY brings a new source', () => {
    const r = run([play(5, 1, '/api/v1/media/a?sig=1'), loadOnly(6, 1), play(7, 2, '/api/v1/media/a?sig=9')]);
    expect(r.map(x => x.held?.source?.url ?? null)).toEqual(['/api/v1/media/a?sig=1', '/api/v1/media/a?sig=1', '/api/v1/media/a?sig=9']);
    expect(r[1].held?.plan).toBeNull();
  });
});
