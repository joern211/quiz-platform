import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as contract from '@quiz/shared/audioPlayback';
import {
  AUDIO_PLAYBACK_CONTRACT, AUDIO_PLAYBACK_ERROR_CODES, AUDIO_PLAYBACK_MAX_DURATION_MS, AudioPlaybackError, AudioPlaybackProjectionSchema,
  audioPlaybackContextKey, audioPlaybackEndsAtMs, audioPlaybackPhaseAt, audioPlaybackProjectionMatches, audioPlaybackTargetMs,
  mediaSecondsToMs, msToMediaSeconds, parseAudioPlaybackProjection, type AudioPlaybackScope,
} from '@quiz/shared/audioPlayback';
import {
  audioPlaybackPlanOf, createAudioPlayback, createRenewalIssuer, parseAudioPlaybackState, pauseAudioPlayback, projectAudioPlayback, readAudioPlayback,
  resumeAudioPlayback, settleAudioPlayback, startAudioPlayback, stopAudioPlayback, type AudioPlaybackState,
} from './audioPlaybackPlan.js';
import { gameErrorCode } from './errors.js';
import type { ProjectionAudience, VisibilityRule } from './visibility.js';

// Synthetic fixtures: opaque ids, a 10 s clip, no title/artist anywhere, no game rule.
const scope: AudioPlaybackScope = { runIndex: 2, roundId: 'round-1', playbackId: 'pb-1', contentRevision: 'rev-1' };
const DUR = 10_000;
const fresh = (now = 1000): AudioPlaybackState => createAudioPlayback({ scope, assetId: 'asset-opaque-1', durationMs: DUR, now });
const args = <T extends object = object>(state: AudioPlaybackState, now: number, extra: T = {} as T) => ({ scope, expectedVersion: state.version, now, ...extra });
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof AudioPlaybackError ? e.code : `OTHER:${String(e)}`; } return 'NO_ERROR'; };
/** START at `startAt` (READY at 1000, command at 1000). */
const running = (startAt = 5000): AudioPlaybackState => startAudioPlayback(fresh(), args(fresh(), 1000, { startAtMs: startAt })).state;

describe('A. Time formula and boundaries (half-open [start, end))', () => {
  it('is READY and silent before a start, at position 0', () => {
    expect(readAudioPlayback(fresh(), 9_999_999)).toEqual({ phase: 'READY', targetMs: 0, endsAtMs: null });
  });
  it.each([
    [4999, 'SCHEDULED', 0], // before the future anchor: nothing audible, target = anchor position (0)
    [5000, 'PLAYING', 0], // exactly at the start
    [5001, 'PLAYING', 1],
    [14_999, 'PLAYING', 9_999], // immediately before the end
    [15_000, 'ENDED', DUR], // exactly at the end: over, does not start again
    [15_001, 'ENDED', DUR],
    [9_000_000, 'ENDED', DUR],
  ])('RUNNING (anchor 5000, 10 s): at %i it is %s with target %i', (now, phase, target) => {
    const reading = readAudioPlayback(running(), now);
    expect(reading.phase).toBe(phase);
    expect(reading.targetMs).toBe(target);
    expect(reading.endsAtMs).toBe(15_000);
  });
  it('never lets a target leave [0, duration] and never asks a clock backwards', () => {
    const s = running();
    for (const now of [0, 1, 4999, 5000, 7777, 14_999, 15_000, 2 ** 40]) {
      const t = readAudioPlayback(s, now).targetMs;
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(DUR);
    }
  });
  it('uses one formula on the server and in the shared helper (position at the anchor + elapsed, clamped)', () => {
    const plan = { status: 'RUNNING' as const, positionMs: 3000, anchorServerMs: 9000 };
    expect(audioPlaybackTargetMs(plan, DUR, 8000)).toBe(3000); // before the anchor
    expect(audioPlaybackTargetMs(plan, DUR, 9000)).toBe(3000);
    expect(audioPlaybackTargetMs(plan, DUR, 10_000)).toBe(4000);
    expect(audioPlaybackEndsAtMs(plan, DUR)).toBe(16_000);
    expect(audioPlaybackPhaseAt(plan, DUR, 15_999)).toBe('PLAYING');
    expect(audioPlaybackPhaseAt(plan, DUR, 16_000)).toBe('ENDED');
  });
});

describe('A. Transitions', () => {
  it('start: READY → RUNNING with the requested anchor at position 0, version +1', () => {
    const r = startAudioPlayback(fresh(), args(fresh(), 1000, { startAtMs: 5000 }));
    expect(r.changed).toBe(true);
    expect(r.state).toMatchObject({ status: 'RUNNING', positionMs: 0, anchorServerMs: 5000, version: 1, changedAtMs: 1000 });
  });
  it('start may be immediate (startAt = now) but never in the past', () => {
    expect(startAudioPlayback(fresh(), args(fresh(), 1000, { startAtMs: 1000 })).state.anchorServerMs).toBe(1000);
    expect(code(() => startAudioPlayback(fresh(), args(fresh(), 1000, { startAtMs: 999 })))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
  });
  it('pause during playback freezes the position valid at the server time', () => {
    const p = pauseAudioPlayback(running(), args(running(), 8000));
    expect(p.state).toMatchObject({ status: 'PAUSED', positionMs: 3000, anchorServerMs: null, version: 2 });
    expect(readAudioPlayback(p.state, 99_999)).toEqual({ phase: 'PAUSED', targetMs: 3000, endsAtMs: null });
  });
  it('pause BEFORE a scheduled first start cancels the pending start and freezes position 0', () => {
    const s = running(5000);
    const p = pauseAudioPlayback(s, args(s, 2000));
    expect(p.state).toMatchObject({ status: 'PAUSED', positionMs: 0, anchorServerMs: null });
    // the old anchor is gone: even much later nothing starts by itself
    expect(readAudioPlayback(p.state, 9_000_000)).toMatchObject({ phase: 'PAUSED', targetMs: 0 });
  });
  it('resume sets a NEW anchor at the stored position — never back at 0', () => {
    const s = running();
    const paused = pauseAudioPlayback(s, args(s, 8000)).state; // position 3000
    const resumed = resumeAudioPlayback(paused, args(paused, 9000, { startAtMs: 9500 })).state;
    expect(resumed).toMatchObject({ status: 'RUNNING', positionMs: 3000, anchorServerMs: 9500, version: 3 });
    expect(readAudioPlayback(resumed, 9499)).toMatchObject({ phase: 'SCHEDULED', targetMs: 3000 });
    expect(readAudioPlayback(resumed, 9500)).toMatchObject({ phase: 'PLAYING', targetMs: 3000 });
    expect(readAudioPlayback(resumed, 10_500)).toMatchObject({ phase: 'PLAYING', targetMs: 4000 });
    expect(readAudioPlayback(resumed, 9500 + 7000)).toMatchObject({ phase: 'ENDED' });
  });
  it('pause before a SCHEDULED resume keeps the stored offset (not 0, not the future target)', () => {
    const s = running();
    const paused = pauseAudioPlayback(s, args(s, 8000)).state;
    const resumed = resumeAudioPlayback(paused, args(paused, 9000, { startAtMs: 12_000 })).state;
    const again = pauseAudioPlayback(resumed, args(resumed, 10_000)).state;
    expect(again).toMatchObject({ status: 'PAUSED', positionMs: 3000, anchorServerMs: null });
  });
  it('pause at the end boundary: the clip is over (refused), one millisecond earlier it is paused one ms before the end', () => {
    const s = running(); // ends at 15000
    expect(code(() => pauseAudioPlayback(s, args(s, 15_000)))).toBe('AUDIO_PLAYBACK_ENDED');
    expect(pauseAudioPlayback(s, args(s, 14_999)).state).toMatchObject({ status: 'PAUSED', positionMs: 9_999 });
  });
  it('stop is terminal for this instance (also from READY, RUNNING and PAUSED); nothing leaves STOPPED', () => {
    const stopped = stopAudioPlayback(running(), args(running(), 8000)).state;
    expect(stopped).toMatchObject({ status: 'STOPPED', positionMs: 3000, anchorServerMs: null });
    expect(stopAudioPlayback(fresh(), args(fresh(), 1000)).state.status).toBe('STOPPED');
    const paused = pauseAudioPlayback(running(), args(running(), 8000)).state;
    expect(stopAudioPlayback(paused, args(paused, 8100)).state.status).toBe('STOPPED');
    for (const act of [
      () => startAudioPlayback(stopped, args(stopped, 9000, { startAtMs: 9000 })),
      () => resumeAudioPlayback(stopped, args(stopped, 9000, { startAtMs: 9000 })),
      () => pauseAudioPlayback(stopped, args(stopped, 9000)),
      () => settleAudioPlayback(stopped, args(stopped, 90_000)),
    ]) expect(['AUDIO_PLAYBACK_TERMINAL', 'AUDIO_PLAYBACK_TRANSITION_INVALID']).toContain(code(act));
    expect(code(() => startAudioPlayback(stopped, args(stopped, 9000, { startAtMs: 9000 })))).toBe('AUDIO_PLAYBACK_TERMINAL');
  });
  it('a time-expired RUNNING is NOT revived or silently rewritten by pause / resume / stop / start; settle persists the end', () => {
    const s = running(); // over at 15000
    for (const act of [
      () => pauseAudioPlayback(s, args(s, 20_000)),
      () => resumeAudioPlayback(s, args(s, 20_000, { startAtMs: 20_000 })),
      () => stopAudioPlayback(s, args(s, 20_000)),
      () => startAudioPlayback(s, args(s, 20_000, { startAtMs: 20_000 })),
    ]) expect(code(act)).toBe('AUDIO_PLAYBACK_ENDED');
    const settled = settleAudioPlayback(s, args(s, 20_000));
    expect(settled).toMatchObject({ changed: true, state: { status: 'ENDED', positionMs: DUR, anchorServerMs: null, version: 2 } });
    expect(settleAudioPlayback(settled.state, args(settled.state, 20_001))).toEqual({ state: settled.state, changed: false });
    expect(code(() => settleAudioPlayback(s, args(s, 14_999)))).toBe('AUDIO_PLAYBACK_TRANSITION_INVALID'); // not over yet
    for (const act of [
      () => startAudioPlayback(settled.state, args(settled.state, 30_000, { startAtMs: 30_000 })),
      () => resumeAudioPlayback(settled.state, args(settled.state, 30_000, { startAtMs: 30_000 })),
      () => pauseAudioPlayback(settled.state, args(settled.state, 30_000)),
      () => stopAudioPlayback(settled.state, args(settled.state, 30_000)),
    ]) expect(code(act)).toBe('AUDIO_PLAYBACK_TERMINAL');
  });
  it('refuses transitions that make no sense (pause READY, resume READY/RUNNING-less, start PAUSED)', () => {
    expect(code(() => pauseAudioPlayback(fresh(), args(fresh(), 2000)))).toBe('AUDIO_PLAYBACK_TRANSITION_INVALID');
    expect(code(() => resumeAudioPlayback(fresh(), args(fresh(), 2000, { startAtMs: 2000 })))).toBe('AUDIO_PLAYBACK_TRANSITION_INVALID');
    const paused = pauseAudioPlayback(running(), args(running(), 8000)).state;
    expect(code(() => startAudioPlayback(paused, args(paused, 8100, { startAtMs: 8100 })))).toBe('AUDIO_PLAYBACK_TRANSITION_INVALID');
  });
});

describe('A. Duplicates and versions', () => {
  it('a like-for-like repeat with the CURRENT version creates no new anchor and no second effect', () => {
    const s = running(5000);
    const again = startAudioPlayback(s, args(s, 3000, { startAtMs: 9999 }));
    expect(again).toEqual({ state: s, changed: false });
    expect(again.state.anchorServerMs).toBe(5000);
    const paused = pauseAudioPlayback(s, args(s, 8000)).state;
    expect(pauseAudioPlayback(paused, args(paused, 8500))).toEqual({ state: paused, changed: false });
    const resumed = resumeAudioPlayback(paused, args(paused, 9000, { startAtMs: 9100 })).state;
    expect(resumeAudioPlayback(resumed, args(resumed, 9200, { startAtMs: 9900 }))).toEqual({ state: resumed, changed: false });
    const stopped = stopAudioPlayback(resumed, args(resumed, 9300)).state;
    expect(stopAudioPlayback(stopped, args(stopped, 9400))).toEqual({ state: stopped, changed: false });
  });
  it('a STALE version is refused every time — also for a repeat that would otherwise be a no-op', () => {
    const s0 = fresh();
    const s1 = startAudioPlayback(s0, args(s0, 1000, { startAtMs: 5000 })).state; // version 1
    expect(code(() => startAudioPlayback(s1, { scope, expectedVersion: 0, now: 1100, startAtMs: 5000 }))).toBe('AUDIO_PLAYBACK_VERSION_STALE');
    expect(code(() => pauseAudioPlayback(s1, { scope, expectedVersion: 0, now: 1100 }))).toBe('AUDIO_PLAYBACK_VERSION_STALE');
    expect(code(() => stopAudioPlayback(s1, { scope, expectedVersion: 7, now: 1100 }))).toBe('AUDIO_PLAYBACK_VERSION_STALE');
    expect(s1.version).toBe(1); // nothing moved
  });
  it('is bound to its instance: another run, round, playback id or content revision is refused before anything else', () => {
    const s = fresh();
    for (const other of [{ ...scope, runIndex: 3 }, { ...scope, roundId: 'round-2' }, { ...scope, playbackId: 'pb-2' }, { ...scope, contentRevision: 'rev-2' }]) {
      expect(code(() => startAudioPlayback(s, { scope: other, expectedVersion: 0, now: 1000, startAtMs: 2000 }))).toBe('AUDIO_PLAYBACK_SCOPE_INVALID');
    }
    expect(code(() => startAudioPlayback(s, { scope: { runIndex: 2 } as AudioPlaybackScope, expectedVersion: 0, now: 1000, startAtMs: 2000 }))).toBe('AUDIO_PLAYBACK_SCOPE_INVALID');
  });
  it('a clock that runs backwards relative to the last change is refused', () => {
    const s = running(); // changedAtMs 1000
    expect(code(() => pauseAudioPlayback(s, args(s, 999)))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
  });
});

describe('A. Validation: units, bounds, missing binding', () => {
  it.each([
    ['zero duration', 0], ['negative duration', -5], ['fractional duration (seconds mistaken for ms)', 12.5], ['NaN', NaN], ['Infinity', Infinity],
    ['unsafe integer', 2 ** 53], ['above the pipeline limit', AUDIO_PLAYBACK_MAX_DURATION_MS + 1], ['a string', '10000'], ['null', null], ['undefined', undefined],
  ])('rejects a trusted duration that is %s', (_name, durationMs) => {
    expect(code(() => createAudioPlayback({ scope, assetId: 'a', durationMs, now: 1 }))).toBe('AUDIO_PLAYBACK_STATE_INVALID');
  });
  it('accepts the pipeline limit exactly', () => {
    expect(createAudioPlayback({ scope, assetId: 'a', durationMs: AUDIO_PLAYBACK_MAX_DURATION_MS, now: 1 }).durationMs).toBe(AUDIO_PLAYBACK_MAX_DURATION_MS);
  });
  it.each([[NaN], [Infinity], [-1], [1.5], [2 ** 53], ['1000' as unknown as number], [null as unknown as number]])('rejects server time %s', now => {
    expect(code(() => createAudioPlayback({ scope, assetId: 'a', durationMs: DUR, now }))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
    expect(code(() => readAudioPlayback(fresh(), now))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
    expect(code(() => pauseAudioPlayback(running(), args(running(), now)))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
  });
  it.each([[NaN], [Infinity], [-1], [1.5], [2 ** 53], ['5000' as unknown as number]])('rejects a start anchor %s', startAtMs => {
    expect(code(() => startAudioPlayback(fresh(), args(fresh(), 1000, { startAtMs })))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
  });
  it.each([[-1], [1.5], [NaN], [Infinity], ['0' as unknown as number], [undefined as unknown as number]])('rejects an expected version %s', expectedVersion => {
    expect(code(() => startAudioPlayback(fresh(), { scope, expectedVersion, now: 1000, startAtMs: 2000 }))).toBe('AUDIO_PLAYBACK_ARGS_INVALID');
  });
  it('rejects missing, extra and inconsistent persisted fields and never echoes a value', () => {
    const s = running();
    for (const bad of [
      { ...s, extra: 'x' }, { ...s, title: 'private song title' }, { ...s, version: -1 }, { ...s, positionMs: DUR + 1 }, { ...s, positionMs: 1.5 },
      { ...s, anchorServerMs: null }, { ...fresh(), anchorServerMs: 5 }, { ...s, status: 'WHATEVER' }, { ...s, scope: { ...scope, playbackId: '' } },
      { ...s, scope: { ...scope, roundId: 'bad id with spaces' } }, { ...s, assetId: 'https://x/y.mp3' }, { ...s, assetId: '/storage/private/song.mp3' },
      { ...s, status: 'ENDED', anchorServerMs: null, positionMs: 5 }, { ...fresh(), version: 3 }, { ...s, durationMs: DUR, anchorServerMs: Number.MAX_SAFE_INTEGER },
      null, undefined, 'x', [], 42,
    ]) {
      let message = '';
      try { parseAudioPlaybackState(bad); } catch (e) { message = (e as Error).message; }
      expect(message).toBe('AUDIO_PLAYBACK_STATE_INVALID');
    }
  });
  it('stores no signed URL and no metadata field — only the allowlisted keys', () => {
    expect(Object.keys(running()).sort()).toEqual(['anchorServerMs', 'assetId', 'changedAtMs', 'durationMs', 'positionMs', 'schemaVersion', 'scope', 'status', 'version'].sort());
    expect(JSON.stringify(running())).not.toMatch(/exp=|sig=|\/api\/|http/);
  });
});

describe('A. Determinism, serialisation, recovery', () => {
  it('same state + same action + same time = same decision; a JSON round trip changes nothing', () => {
    const s = running();
    const roundTrip = parseAudioPlaybackState(JSON.parse(JSON.stringify(s)));
    expect(roundTrip).toEqual(s);
    for (const now of [3000, 5000, 9999, 15_000]) expect(readAudioPlayback(roundTrip, now)).toEqual(readAudioPlayback(s, now));
    expect(pauseAudioPlayback(roundTrip, args(roundTrip, 8000))).toEqual(pauseAudioPlayback(s, args(s, 8000)));
    expect(JSON.stringify(pauseAudioPlayback(s, args(s, 8000)).state)).toBe(JSON.stringify(pauseAudioPlayback(s, args(s, 8000)).state));
  });
  it('recovery keeps the anchor: reloading a RUNNING plan after a restart neither restarts it at 0 nor re-rolls it', () => {
    const stored = JSON.stringify(running(5000));
    const recovered = parseAudioPlaybackState(JSON.parse(stored));
    expect(recovered.anchorServerMs).toBe(5000);
    expect(readAudioPlayback(recovered, 9000)).toMatchObject({ phase: 'PLAYING', targetMs: 4000 });
  });
  it('reads no clock, no random source and no network (a mocked Date.now / Math.random are never touched)', () => {
    const dateNow = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    const s = running();
    readAudioPlayback(s, 6000); pauseAudioPlayback(s, args(s, 6000)); stopAudioPlayback(s, args(s, 6000)); settleAudioPlayback(s, args(s, 20_000));
    projectAudioPlayback({ role: 'PLAYER', participantId: 'p1' }, s, { release: 'PLAY', sourceVisibility: { scope: 'PUBLIC' }, stateVersion: 3, now: 6000, resolveSource: () => ({ url: '/api/v1/media/x', renewal: 1 }) });
    expect(dateNow).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('the plan alone (not a local browser event) decides: there is no entry point that takes a media event', () => {
    const names = Object.keys(contract).concat(['audioPlaybackPlanOf']);
    expect(names.filter(n => /ended|onended|mediaEvent|loadedmetadata|canplay/i.test(n))).toEqual([]);
    expect(audioPlaybackPlanOf(running())).toEqual({ status: 'RUNNING', positionMs: 0, anchorServerMs: 5000 });
  });
});

// ── B. Release, projection, information protection ───────────

const PUBLIC: VisibilityRule = { scope: 'PUBLIC' };
const url = (assetId: string) => `/api/v1/media/${assetId}?exp=1&sig=s`;
const src = (assetId: string) => ({ url: url(assetId), renewal: 7 });
const project = (audience: ProjectionAudience, release: 'NONE' | 'LOAD_ONLY' | 'PLAY', state = running(), over: Record<string, unknown> = {}) =>
  projectAudioPlayback(audience, state, { release, sourceVisibility: PUBLIC, stateVersion: 9, now: 6000, resolveSource: src, ...over } as Parameters<typeof projectAudioPlayback>[2]);

describe('B. Release policy and lazy URL resolution', () => {
  it('NONE: no source, no duration, no plan — and the resolver is never called', () => {
    const resolveUrl = vi.fn(src);
    const p = projectAudioPlayback({ role: 'PLAYER', participantId: 'p1' }, running(), { release: 'NONE', sourceVisibility: PUBLIC, stateVersion: 9, now: 6000, resolveSource: resolveUrl });
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(p).toEqual({ contract: AUDIO_PLAYBACK_CONTRACT, scope, stateVersion: 9, playbackVersion: 1, release: 'NONE', serverNowMs: 6000, durationMs: null, source: null, plan: null });
    expect(JSON.stringify(p)).not.toMatch(/asset-opaque|api|url|exp=|sig=/i);
  });
  it('LOAD_ONLY: source + duration only — no plan, so nothing can be played from it', () => {
    const resolveUrl = vi.fn(src);
    const p = projectAudioPlayback({ role: 'PLAYER', participantId: 'p1' }, running(), { release: 'LOAD_ONLY', sourceVisibility: PUBLIC, stateVersion: 9, now: 6000, resolveSource: resolveUrl });
    expect(resolveUrl).toHaveBeenCalledTimes(1);
    expect(resolveUrl).toHaveBeenCalledWith('asset-opaque-1');
    expect(p).toMatchObject({ release: 'LOAD_ONLY', durationMs: DUR, source: { url: url('asset-opaque-1'), renewal: 7 }, plan: null });
  });
  it('PLAY: source, duration and the current plan; stateVersion and playbackVersion are separate numbers', () => {
    const p = project({ role: 'VIEWER' }, 'PLAY');
    expect(p).toMatchObject({ release: 'PLAY', stateVersion: 9, playbackVersion: 1, durationMs: DUR, plan: { status: 'RUNNING', positionMs: 0, anchorServerMs: 5000 } });
    expect(project({ role: 'VIEWER' }, 'PLAY', running(), { stateVersion: 123 })).toMatchObject({ stateVersion: 123, playbackVersion: 1 });
  });
  it('a TERMINAL plan (stored STOPPED / ENDED, or ended by time) carries the plan and duration but NO source — and no URL is resolved for it', () => {
    const stopped = stopAudioPlayback(running(), args(running(), 8000)).state;
    const settled = settleAudioPlayback(running(), args(running(), 20_000)).state;
    for (const [name, state, now, status] of [['stopped', stopped, 9000, 'STOPPED'], ['settled', settled, 21_000, 'ENDED'], ['ended by time only', running(), 15_000, 'ENDED']] as const) {
      const resolveUrl = vi.fn(src);
      const p = projectAudioPlayback({ role: 'VIEWER' }, state, { release: 'PLAY', sourceVisibility: PUBLIC, stateVersion: 9, now, resolveSource: resolveUrl });
      expect(resolveUrl, name).not.toHaveBeenCalled();
      expect(p, name).toMatchObject({ release: 'PLAY', durationMs: DUR, source: null, plan: { status } });
      expect(parseAudioPlaybackProjection(p).ok, name).toBe(true);
    }
    // the schema holds the same rule in both directions
    const play = project({ role: 'VIEWER' }, 'PLAY');
    expect(parseAudioPlaybackProjection({ ...play, plan: { status: 'STOPPED', positionMs: 1, anchorServerMs: null } }).ok).toBe(false); // terminal WITH a source
    expect(parseAudioPlaybackProjection({ ...play, source: null }).ok).toBe(false); // non-terminal WITHOUT a source
    expect(parseAudioPlaybackProjection({ ...project({ role: 'VIEWER' }, 'LOAD_ONLY'), source: null }).ok).toBe(false);
  });
  it('shows a correct END without any job having rewritten the stored status, and a scheduled start as RUNNING with a future anchor', () => {
    expect(project({ role: 'PLAYER', participantId: 'p' }, 'PLAY', running(), { now: 15_000 })).toMatchObject({ plan: { status: 'ENDED', positionMs: DUR, anchorServerMs: null } });
    expect(project({ role: 'PLAYER', participantId: 'p' }, 'PLAY', running(), { now: 14_999 }).plan).toMatchObject({ status: 'RUNNING' });
    expect(project({ role: 'PLAYER', participantId: 'p' }, 'PLAY', running(), { now: 100 }).plan).toEqual({ status: 'RUNNING', positionMs: 0, anchorServerMs: 5000 });
  });
  it('is the client contract: the projection parses with the shared strict schema and fails closed on any extra or missing part', () => {
    const p = project({ role: 'DISPLAY' }, 'PLAY');
    expect(parseAudioPlaybackProjection(p)).toEqual({ ok: true, projection: p });
    for (const bad of [
      { ...p, title: 'Song' }, { ...p, source: { url: p.source!.url, renewal: 1, title: 'x' } }, { ...p, assetId: 'asset-opaque-1' }, { ...p, plan: { ...p.plan, extra: 1 } },
      { ...p, release: 'NONE' }, { ...p, source: null }, { ...p, plan: null }, { ...p, durationMs: null },
      { ...p, release: 'LOAD_ONLY' }, { ...p, plan: { ...p.plan, positionMs: DUR + 1 } }, { ...p, plan: { status: 'PAUSED', positionMs: 0, anchorServerMs: 5 } },
      { ...p, stateVersion: -1 }, { ...p, playbackVersion: 1.5 }, { ...p, durationMs: 12.5 }, { ...p, contract: 'OTHER' },
      { ...p, source: { url: 'https://evil.example/x.mp3', renewal: 1 } }, { ...p, source: { url: '//evil.example/x.mp3', renewal: 1 } }, { ...p, source: { url: 'javascript:alert(1)', renewal: 1 } },
      { ...p, source: { url: '/ok path', renewal: 1 } }, null, undefined, 'x',
    ]) expect(parseAudioPlaybackProjection(bad)).toEqual({ ok: false, code: 'AUDIO_PLAYBACK_PROJECTION_INVALID' });
  });
  it('fails closed on a bad audience, a bad release, a bad version, a bad resolver result and a throwing resolver (code only)', () => {
    const s = running();
    expect(code(() => projectAudioPlayback({ role: 'ADMIN' } as never, s, { release: 'PLAY', sourceVisibility: PUBLIC, stateVersion: 1, now: 1, resolveSource: src }))).toBe('AUDIO_PLAYBACK_AUDIENCE_INVALID');
    expect(code(() => projectAudioPlayback(null as never, s, { release: 'PLAY', sourceVisibility: PUBLIC, stateVersion: 1, now: 1, resolveSource: src }))).toBe('AUDIO_PLAYBACK_AUDIENCE_INVALID');
    expect(code(() => project({ role: 'VIEWER' }, 'ALL' as never))).toBe('AUDIO_PLAYBACK_RELEASE_INVALID');
    expect(code(() => project({ role: 'VIEWER' }, 'PLAY', s, { stateVersion: -1 }))).toBe('AUDIO_PLAYBACK_ARGS_INVALID');
    expect(code(() => project({ role: 'VIEWER' }, 'PLAY', s, { now: 1.5 }))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
    expect(code(() => project({ role: 'VIEWER' }, 'PLAY', s, { resolveSource: () => ({ url: 'https://x/y', renewal: 1 }) }))).toBe('AUDIO_PLAYBACK_SOURCE_INVALID');
    expect(code(() => project({ role: 'VIEWER' }, 'PLAY', s, { resolveSource: () => { throw new Error('/secret/storage/path.mp3'); } }))).toBe('AUDIO_PLAYBACK_SOURCE_INVALID');
    expect(code(() => project({ role: 'VIEWER' }, 'PLAY', { ...s, title: 'x' } as never))).toBe('AUDIO_PLAYBACK_STATE_INVALID');
  });
});

describe('N7-01 (server side). Renewal numbers order the ISSUED access URLs, independently of plan, snapshot and arrival', () => {
  it('the projection carries the renewal number of the URL it carries; the plan and both versions are untouched by a renewal', () => {
    const s = running();
    const a = projectAudioPlayback({ role: 'VIEWER' }, s, { release: 'PLAY', sourceVisibility: PUBLIC, stateVersion: 9, now: 6000, resolveSource: () => ({ url: '/api/v1/media/x?sig=1', renewal: 11 }) });
    const b = projectAudioPlayback({ role: 'VIEWER' }, s, { release: 'PLAY', sourceVisibility: PUBLIC, stateVersion: 9, now: 6000, resolveSource: () => ({ url: '/api/v1/media/x?sig=2', renewal: 12 }) });
    expect(a.source).toEqual({ url: '/api/v1/media/x?sig=1', renewal: 11 });
    expect(b.source).toEqual({ url: '/api/v1/media/x?sig=2', renewal: 12 });
    expect({ ...a, source: null }).toEqual({ ...b, source: null }); // same plan, same stateVersion, same playbackVersion, same anchor
  });
  it('rejects a source without, with a fractional, negative, unsafe or string renewal number (code only)', () => {
    for (const renewal of [undefined, 1.5, -1, 2 ** 53, '3', NaN, null]) {
      expect(code(() => project({ role: 'VIEWER' }, 'PLAY', running(), { resolveSource: () => ({ url: '/api/v1/media/x', renewal }) }))).toBe('AUDIO_PLAYBACK_SOURCE_INVALID');
    }
    expect(parseAudioPlaybackProjection({ ...project({ role: 'VIEWER' }, 'PLAY'), source: { url: '/api/v1/media/x' } }).ok).toBe(false);
  });
  it('the issuer is strictly increasing, follows the server clock, and keeps growing when the clock stands still or a restart reuses the same time', () => {
    const issue = createRenewalIssuer();
    expect(issue(1000)).toBe(1000);
    expect(issue(1000)).toBe(1001); // same millisecond: still strictly increasing
    expect(issue(900)).toBe(1002); // a clock that stepped back never reuses a number
    expect(issue(5000)).toBe(5000);
    const afterRestart = createRenewalIssuer(); // in-memory state is gone; the clock still carries the order
    expect(afterRestart(5001)).toBeGreaterThan(5000);
    expect(code(() => issue(-1))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
    expect(code(() => issue(1.5))).toBe('AUDIO_PLAYBACK_TIME_INVALID');
  });
});

describe('B. Roles and phases: who may receive the clip at all (existing canView, no blanket admin release)', () => {
  const rules: Array<[string, VisibilityRule]> = [
    ['PUBLIC', { scope: 'PUBLIC' }],
    ['HOST_PRIVATE', { scope: 'HOST_PRIVATE' }],
    ['PLAYER_PRIVATE of p1', { scope: 'PLAYER_PRIVATE', ownerParticipantId: 'p1' }],
    ['TEAM_PRIVATE of t1', { scope: 'TEAM_PRIVATE', ownerTeamId: 't1' }],
  ];
  const audiences: Array<[string, ProjectionAudience]> = [
    ['HOST (not playing)', { role: 'HOST' }],
    ['BLIND_HOST', { role: 'HOST', blindHost: true }],
    ['playing HOST p9', { role: 'HOST', participantId: 'p9' }],
    ['PLAYER p1 of t1', { role: 'PLAYER', participantId: 'p1', teamId: 't1' }],
    ['PLAYER p2 of t1', { role: 'PLAYER', participantId: 'p2', teamId: 't1' }],
    ['PLAYER p3 of t2', { role: 'PLAYER', participantId: 'p3', teamId: 't2' }],
    ['VIEWER', { role: 'VIEWER' }],
    ['DISPLAY', { role: 'DISPLAY' }],
  ];
  // expected PLAY recipients per rule (everybody else is downgraded to NONE even though release = PLAY was requested)
  const allowed: Record<string, string[]> = {
    PUBLIC: audiences.map(([n]) => n),
    HOST_PRIVATE: ['HOST (not playing)', 'playing HOST p9'],
    'PLAYER_PRIVATE of p1': ['PLAYER p1 of t1'],
    'TEAM_PRIVATE of t1': ['PLAYER p1 of t1', 'PLAYER p2 of t1'],
  };
  for (const [ruleName, rule] of rules) {
    it(`source visibility ${ruleName}: exactly ${allowed[ruleName].length} of ${audiences.length} audiences receive it`, () => {
      for (const [name, audience] of audiences) {
        const resolveUrl = vi.fn(src);
        const p = projectAudioPlayback(audience, running(), { release: 'PLAY', sourceVisibility: rule, stateVersion: 4, now: 6000, resolveSource: resolveUrl });
        const should = allowed[ruleName].includes(name);
        expect(p.release, `${ruleName} → ${name}`).toBe(should ? 'PLAY' : 'NONE');
        expect(resolveUrl).toHaveBeenCalledTimes(should ? 1 : 0); // a refused audience never costs a signature
        if (!should) expect(JSON.stringify(p)).not.toMatch(/asset-opaque|api\/v1|exp=|sig=/);
        expect(p.stateVersion).toBe(4); // even the withdrawal marker stays orderable
        expect(p.playbackVersion).toBe(1);
      }
    });
  }
  it('a blind host receives no host-private audio even though the host may administer the room', () => {
    const blind = projectAudioPlayback({ role: 'HOST', blindHost: true }, running(), { release: 'PLAY', sourceVisibility: { scope: 'HOST_PRIVATE' }, stateVersion: 1, now: 6000, resolveSource: src });
    expect(blind).toMatchObject({ release: 'NONE', source: null, plan: null, durationMs: null });
  });
  it('a requested release never EXTENDS what the rule allows, and the consumer may narrow it (LOAD_ONLY / NONE) per phase', () => {
    expect(project({ role: 'PLAYER', participantId: 'p' }, 'LOAD_ONLY').plan).toBeNull();
    expect(project({ role: 'PLAYER', participantId: 'p' }, 'NONE').source).toBeNull();
  });
});

describe('B. Private markers and metadata never reach a serialised view', () => {
  const MARKERS = ['PRIVATE_SONG_TITLE_MARKER', 'PRIVATE_ARTIST_MARKER', 'private-original-name.mp3', '/storage/private/path.mp3', 'ID3_COVER_MARKER'];
  it('a state that carries metadata is rejected at the boundary; a clean state projects to an allowlisted shape for every release', () => {
    for (const marker of MARKERS) {
      for (const key of ['title', 'artist', 'originalName', 'storagePath', 'cover', 'metadata', 'mediaSession']) {
        expect(code(() => parseAudioPlaybackState({ ...running(), [key]: marker }))).toBe('AUDIO_PLAYBACK_STATE_INVALID');
      }
      // Refs are opaque labels: the shape (no path separator, no space, no underscore text) is enforced, their meaning cannot be — a
      // consumer must not encode a title in a ref (documented in handoff.md). A marker that happens to be a legal label is therefore skipped.
      if (/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(marker)) continue;
      expect(code(() => createAudioPlayback({ scope: { ...scope, roundId: marker }, assetId: 'a', durationMs: DUR, now: 1 }))).toBe('AUDIO_PLAYBACK_STATE_INVALID');
      expect(code(() => createAudioPlayback({ scope, assetId: marker, durationMs: DUR, now: 1 }))).toBe('AUDIO_PLAYBACK_STATE_INVALID');
    }
    const allowedKeys = ['contract', 'scope', 'stateVersion', 'playbackVersion', 'release', 'serverNowMs', 'durationMs', 'source', 'plan'].sort();
    for (const release of ['NONE', 'LOAD_ONLY', 'PLAY'] as const) {
      const p = project({ role: 'VIEWER' }, release);
      expect(Object.keys(p).sort()).toEqual(allowedKeys);
      expect(JSON.stringify(p)).not.toMatch(new RegExp(MARKERS.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
    }
  });
});

describe('Shared helpers: units, context binding, errors, strip-only loading', () => {
  it('converts milliseconds to media seconds and back in one place, and treats unusable media values as unknown', () => {
    expect(msToMediaSeconds(1500)).toBe(1.5);
    expect(msToMediaSeconds(0)).toBe(0);
    expect(mediaSecondsToMs(1.5)).toBe(1500);
    expect(mediaSecondsToMs(1.2344)).toBe(1234);
    for (const bad of [NaN, Infinity, -Infinity, -0.001]) expect(mediaSecondsToMs(bad)).toBeNull();
    for (const bad of [-1, 1.5, NaN, Infinity]) expect(code(() => msToMediaSeconds(bad))).toBe('AUDIO_PLAYBACK_ARGS_INVALID');
  });
  it('binds a projection to the expected scope AND the independently supplied minimum snapshot version', () => {
    const p = project({ role: 'VIEWER' }, 'PLAY');
    const expected = { ...scope, minStateVersion: 9 };
    expect(audioPlaybackProjectionMatches(p, expected)).toBe(true);
    expect(audioPlaybackProjectionMatches(p, { ...expected, minStateVersion: 10 })).toBe(false);
    for (const other of [{ runIndex: 3 }, { roundId: 'r2' }, { playbackId: 'pb-2' }, { contentRevision: 'rev-2' }]) expect(audioPlaybackProjectionMatches(p, { ...expected, ...other })).toBe(false);
    expect(audioPlaybackProjectionMatches(p, { ...expected, minStateVersion: NaN })).toBe(false);
    expect(audioPlaybackContextKey(scope)).toBe(JSON.stringify(['AUDIO_PLAYBACK', 2, 'round-1', 'pb-1', 'rev-1']));
    expect(audioPlaybackContextKey(scope)).not.toMatch(/asset|api|exp=/);
  });
  it('is a typed error with a code only, whitelisted for the wire', () => {
    const error = new AudioPlaybackError('AUDIO_PLAYBACK_VERSION_STALE');
    expect(error.message).toBe('AUDIO_PLAYBACK_VERSION_STALE');
    expect(error.name).toBe('AudioPlaybackError');
    expect(new Set(AUDIO_PLAYBACK_ERROR_CODES).size).toBe(AUDIO_PLAYBACK_ERROR_CODES.length);
    for (const c of AUDIO_PLAYBACK_ERROR_CODES) expect(gameErrorCode(new AudioPlaybackError(c))).toBe(c);
  });
  it('exports no server-private schema, no state mutation and no URL resolver to the browser', () => {
    const names = Object.keys(contract);
    expect(names.filter(n => /^(create|start|pause|resume|stop|settle|project)|StateSchema|assetId|resolve|sign/i.test(n))).toEqual([]);
  });
  it('imports nothing but zod, is registered as a subpath export, and loads as plain TypeScript in Node strip-only mode', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/audioPlayback.ts', import.meta.url));
    const imports = readFileSync(file, 'utf8').split('\n').filter(line => /^\s*(import|export)\b.*\bfrom\b/.test(line));
    expect(imports).toEqual(["import { z } from 'zod';"]);
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../packages/shared/package.json', import.meta.url)), 'utf8')) as { exports: Record<string, string> };
    expect(manifest.exports['./audioPlayback']).toBe('./src/audioPlayback.ts');
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(file)});
       const scope = { runIndex: 1, roundId: 'r', playbackId: 'p', contentRevision: 'c' };
       const ok = m.parseAudioPlaybackProjection({ contract: 'AUDIO_PLAYBACK_V1', scope, stateVersion: 1, playbackVersion: 0, release: 'NONE', serverNowMs: 5, durationMs: null, source: null, plan: null });
       const bad = m.parseAudioPlaybackProjection({ contract: 'AUDIO_PLAYBACK_V1', scope, stateVersion: 1, playbackVersion: 0, release: 'NONE', serverNowMs: 5, durationMs: null, source: null, plan: null, title: 'x' });
       console.log(JSON.stringify([ok.ok, bad.ok, m.audioPlaybackTargetMs({ status: 'RUNNING', positionMs: 0, anchorServerMs: 10 }, 100, 60), new m.AudioPlaybackError('AUDIO_PLAYBACK_ENDED').code]));`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual([true, false, 50, 'AUDIO_PLAYBACK_ENDED']);
  });
  it('the schema is strict for every nested object', () => {
    const p = project({ role: 'VIEWER' }, 'PLAY');
    expect(AudioPlaybackProjectionSchema.safeParse({ ...p, scope: { ...p.scope, extra: 1 } }).success).toBe(false);
  });
});
