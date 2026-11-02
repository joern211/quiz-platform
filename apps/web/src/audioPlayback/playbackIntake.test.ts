import { describe, expect, it } from 'vitest';
import type { AudioPlaybackExpectedContext, AudioPlaybackProjection } from '@quiz/shared/audioPlayback';
import { AUDIO_PLAYBACK_CONTRACT } from '@quiz/shared/audioPlayback';
import { intakeAudioPlayback, type IntakeMemo, type IntakeResult } from './playbackIntake';
import { SCOPE, SERVER_BASE, playProjection } from './testKit';

const EXPECTED: AudioPlaybackExpectedContext = { ...SCOPE, minStateVersion: 3 };
const play = (stateVersion: number, playbackVersion = 1, url = '/api/v1/media/a?sig=1'): AudioPlaybackProjection => playProjection({ stateVersion, playbackVersion, url });
const none = (stateVersion: number, playbackVersion = 1): AudioPlaybackProjection =>
  ({ contract: AUDIO_PLAYBACK_CONTRACT, scope: { ...SCOPE }, stateVersion, playbackVersion, release: 'NONE', serverNowMs: 1, durationMs: null, source: null, plan: null });
const loadOnly = (stateVersion: number, playbackVersion = 1): AudioPlaybackProjection =>
  ({ contract: AUDIO_PLAYBACK_CONTRACT, scope: { ...SCOPE }, stateVersion, playbackVersion, release: 'LOAD_ONLY', serverNowMs: 1, durationMs: 10_000, source: { url: '/api/v1/media/a?sig=1', renewal: 1 }, plan: null });
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

  it('EXHAUSTIVE order check: over every sequence of 5 inputs from a mixed alphabet, nothing older than a seen withdrawal or newer-than-seen knowledge is ever playable again', () => {
    const foreign = { ...play(99), scope: { ...SCOPE, playbackId: 'other' } };
    const alphabet: Array<[string, unknown]> = [['P8', play(8)], ['P9', play(9)], ['N10', none(10)], ['null', null], ['P11', play(11)], ['X99', foreign]];
    const length = 5;
    let checked = 0;
    const walk = (prefix: number[]) => {
      if (prefix.length === length) {
        let memo: IntakeMemo | null = null;
        let maxAccepted = -1, withdrawnAt = -1;
        for (const index of prefix) {
          const r = intakeAudioPlayback(memo, EXPECTED, alphabet[index][1]);
          memo = r.memo;
          const input = alphabet[index][1] as { stateVersion?: number; release?: string } | null;
          if (r.outcome === 'ACCEPTED' || r.outcome === 'RELEASE_NONE') { maxAccepted = Math.max(maxAccepted, input!.stateVersion!); if (r.outcome === 'RELEASE_NONE') withdrawnAt = Math.max(withdrawnAt, input!.stateVersion!); }
          // (1) what is playable is never older than anything already accepted; (2) never at or below a withdrawal seen before; (3) the foreign context changes nothing
          if (r.held) { expect(r.held.stateVersion, alphabet.filter((_, i) => prefix.includes(i)).map(a => a[0]).join()).toBeGreaterThanOrEqual(maxAccepted); expect(r.held.stateVersion).toBeGreaterThan(withdrawnAt); }
          expect(r.memo.seenStateVersion).toBe(maxAccepted);
        }
        checked++;
        return;
      }
      for (let i = 0; i < alphabet.length; i++) walk([...prefix, i]);
    };
    walk([]);
    expect(checked).toBe(6 ** 5);
  });

});

describe('N7-01. Access-URL renewals are ordered by the issuer\'s renewal number', () => {
  const U1 = '/api/v1/media/clip-a?exp=100&sig=zzz', U2 = '/api/v1/media/clip-a?exp=200&sig=aaa', U3 = '/api/v1/media/clip-a?exp=300&sig=mmm';
  const withUrl = (url: string, renewal: number, over: Parameters<typeof playProjection>[0] = {}) => playProjection({ anchorMono: 0, url, renewal, ...over });
  const urls = (r: IntakeResult[]) => r.map(x => x.held?.source?.url ?? null);

  it('R1 begins, R2 begins, R2 returns, R1 returns: U2 stays (same snapshot version and same plan version)', () => {
    const r = run([withUrl(U2, 2), withUrl(U1, 1)]);
    expect(urls(r)).toEqual([U2, U2]);
    expect(r[1].memo.held?.source?.renewal).toBe(2);
  });
  it('the normal order R1 then R2 moves to the newer URL; the same URL is simply re-accepted', () => {
    expect(urls(run([withUrl(U1, 1), withUrl(U2, 2), withUrl(U2, 2)]))).toEqual([U1, U2, U2]);
  });
  it('the order is NOT taken from the URL text, the signature text, the server stamp or the arrival: a lexicographically larger URL with a lower number loses', () => {
    const big = withUrl('/api/v1/media/clip-a?exp=999&sig=zzzzzz', 1, { serverNowMs: SERVER_BASE + 9_999 });
    const small = withUrl('/api/v1/media/clip-a?exp=1&sig=aa', 2, { serverNowMs: SERVER_BASE + 1 });
    expect(urls(run([big, small]))[1]).toBe(small.source!.url);
    expect(urls(run([small, big]))[1]).toBe(small.source!.url);
  });
  it('a late older URL at a NEWER snapshot/plan version still brings its plan (a pause must not be lost) but never the older source', () => {
    const r = run([withUrl(U2, 2), withUrl(U1, 1, { status: 'PAUSED', positionMs: 3000, stateVersion: 10, playbackVersion: 2 })]);
    expect(r[1].outcome).toBe('ACCEPTED');
    expect(r[1].held?.plan).toEqual({ status: 'PAUSED', positionMs: 3000, anchorServerMs: null });
    expect(r[1].held?.source?.url).toBe(U2);
    expect(r[1].held?.stateVersion).toBe(10);
  });
  it('a LOAD_ONLY view with an older number does not displace the held newer source either', () => {
    const lo = { ...loadOnly(6), source: { url: U1, renewal: 1 } };
    const r = run([withUrl(U2, 2, { stateVersion: 5 }), lo]);
    expect(r[1].held?.source?.url).toBe(U2);
    expect(r[1].held?.plan).toBeNull();
  });
  it('a renewal needs neither a new snapshot version nor a new plan version nor a new playback id: only the number grows', () => {
    const r = run([withUrl(U1, 1), withUrl(U3, 3), withUrl(U2, 2)]);
    expect(urls(r)).toEqual([U1, U3, U3]);
    expect(new Set(r.map(x => `${x.held?.stateVersion}/${x.held?.playbackVersion}`))).toEqual(new Set(['5/1']));
    expect(r.map(x => x.held?.plan?.anchorServerMs)).toEqual([SERVER_BASE, SERVER_BASE, SERVER_BASE]); // the anchor never moved
  });
  it('a withdrawal during a renewal stays effective: a late renewal answer of an older snapshot, or of the same snapshot, is not accepted', () => {
    const r = run([withUrl(U1, 1, { stateVersion: 9 }), none(10), withUrl(U2, 2, { stateVersion: 9 }), withUrl(U3, 3, { stateVersion: 10 })]);
    expect(r.map(x => x.outcome)).toEqual(['ACCEPTED', 'RELEASE_NONE', 'STALE', 'STALE']);
    expect(urls(r)).toEqual([U1, null, null, null]);
  });
  it('a clip change during a renewal: the old clip\'s late answer is foreign and the new clip starts with empty knowledge', () => {
    const next = { ...EXPECTED, playbackId: 'pb-2' };
    let r = intakeAudioPlayback(null, EXPECTED, withUrl(U1, 1));
    r = intakeAudioPlayback(r.memo, next, { ...withUrl(U2, 2, { stateVersion: 99 }) }); // answer of the OLD clip under the NEW expectation
    expect(r).toMatchObject({ outcome: 'WITHDRAWN', held: null });
    r = intakeAudioPlayback(r.memo, next, { ...withUrl(U3, 1), scope: { ...SCOPE, playbackId: 'pb-2' } });
    expect(r.held?.source?.url).toBe(U3); // number 1 is fine in a new context
  });
  it('a terminal plan (no source) and a later older renewal: the terminal view stays, nothing comes back', () => {
    const r = run([withUrl(U2, 2), playProjection({ status: 'STOPPED', positionMs: 2000, stateVersion: 6, playbackVersion: 2 }), withUrl(U1, 1)]);
    expect(r.map(x => x.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'STALE']);
    expect(r[2].held?.source).toBeNull();
  });
  it('EXHAUSTIVE: over all orders of three renewals the held source is always the highest number seen', () => {
    const all = [withUrl(U1, 1), withUrl(U2, 2), withUrl(U3, 3)];
    const perms: number[][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const perm of perms) {
      let memo: IntakeMemo | null = null; let best = 0;
      for (const i of perm) {
        const r = intakeAudioPlayback(memo, EXPECTED, all[i]); memo = r.memo; best = Math.max(best, all[i].source!.renewal);
        expect(r.held?.source?.renewal).toBe(best);
      }
    }
  });
});
