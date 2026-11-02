// ============================================================
// N7 — Audio playback plan (domain building block, SERVER-PRIVATE)
//
// The schedule of ONE prepared, normalised clip: authorised asset reference, trusted duration (ms, from the audio pipeline —
// never from browser metadata), a state and a server-time anchor. A later engine persists this state with its own state/receipt
// machinery; N7 invents no command bus, no socket event, no route and no table.
//
// What this is NOT (the later real consumer must supply it): authentication, rights, phase, the decision WHEN a clip starts or
// why it stops, buzzers, points, judging, re-open or replacement rules, persistence, CAS, receipts. A local browser event (a
// finished <audio>, an error, a blocked autoplay) never changes this state.
//
// Time: every function receives `now` (server time in ms) explicitly. Nothing here reads Date.now(), performance.now(), a random
// source or the network. Same state + same action + same time = same decision; the state survives JSON serialisation unchanged and
// recovery never re-rolls the source or restarts the clip.
//
// Versions: `version` is a LOCAL optimistic counter of THIS plan (starts at 0, +1 per real change). It is not the global game
// `stateVersion` (that one orders projections and is passed in by the caller) and no database CAS. A repeated command with the
// CURRENT version that finds the target already reached is a no-op (no new anchor, no second effect); a stale version is refused.
//
// The stored state never contains a signed URL: it is resolved lazily, only for a released projection (see projectAudioPlayback).
// Errors: code only (AUDIO_PLAYBACK_ERROR_CODES). No asset id, URL, title or value appears in a message or a path.
// ============================================================

import { z } from 'zod';
import {
  AUDIO_PLAYBACK_CONTRACT, AUDIO_PLAYBACK_RELEASES, AUDIO_PLAYBACK_SCHEMA_VERSION, AUDIO_PLAYBACK_MAX_ID_LENGTH,
  AudioPlaybackDurationMsSchema, AudioPlaybackError, AudioPlaybackMsSchema, AudioPlaybackProjectionSchema, AudioPlaybackScopeSchema,
  AudioPlaybackSourceSchema, AudioPlaybackStatusSchema, AudioPlaybackVersionSchema,
  audioPlaybackEndsAtMs, audioPlaybackPhaseAt, audioPlaybackTargetMs,
  type AudioPlaybackPhase, type AudioPlaybackPlan, type AudioPlaybackProjection, type AudioPlaybackRelease, type AudioPlaybackScope,
} from '@quiz/shared/audioPlayback';
import { canView, type ProjectionAudience, type VisibilityRule } from './visibility.js';

// ── Persisted state (server-private) ─────────────────────────

/** Authorised asset reference. An id only — never a URL, a path or a file name. */
const AssetRefSchema = z.string().min(1).max(AUDIO_PLAYBACK_MAX_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);

export const AudioPlaybackStateSchema = z.object({
  schemaVersion: z.literal(AUDIO_PLAYBACK_SCHEMA_VERSION),
  scope: AudioPlaybackScopeSchema,
  assetId: AssetRefSchema,
  /** Trusted duration in ms, from the normalised audio (MediaAsset.duration). */
  durationMs: AudioPlaybackDurationMsSchema,
  version: AudioPlaybackVersionSchema,
  status: AudioPlaybackStatusSchema,
  /** Position AT the anchor while RUNNING (0 on the first start, the stored offset after a resume); frozen otherwise. */
  positionMs: AudioPlaybackMsSchema,
  /** Server time at which `positionMs` is (or will be) reached; set only while RUNNING. */
  anchorServerMs: AudioPlaybackMsSchema.nullable(),
  /** Server time of the last real change; transitions never run backwards in time. */
  changedAtMs: AudioPlaybackMsSchema,
}).strict();
export type AudioPlaybackState = z.infer<typeof AudioPlaybackStateSchema>;

function fail(code: ConstructorParameters<typeof AudioPlaybackError>[0]): never { throw new AudioPlaybackError(code); }

/** Strict validation of a persisted or incoming state. Throws only a code. Returns a fresh copy. */
export function parseAudioPlaybackState(raw: unknown): AudioPlaybackState {
  const parsed = AudioPlaybackStateSchema.safeParse(raw);
  if (!parsed.success) return fail('AUDIO_PLAYBACK_STATE_INVALID');
  const s = parsed.data;
  const ok = s.positionMs <= s.durationMs
    && (s.status === 'RUNNING') === (s.anchorServerMs !== null)
    && (s.anchorServerMs === null || s.anchorServerMs + (s.durationMs - s.positionMs) <= Number.MAX_SAFE_INTEGER)
    && (s.status !== 'READY' || (s.positionMs === 0 && s.version === 0))
    && (s.status !== 'PAUSED' || s.positionMs < s.durationMs)
    && (s.status !== 'ENDED' || s.positionMs === s.durationMs);
  return ok ? s : fail('AUDIO_PLAYBACK_STATE_INVALID');
}

/** The schedule part of a state (the shape the shared time formula works on). */
export function audioPlaybackPlanOf(state: AudioPlaybackState): AudioPlaybackPlan {
  return { status: state.status, positionMs: state.positionMs, anchorServerMs: state.anchorServerMs };
}

export function createAudioPlayback(input: { scope: unknown; assetId: unknown; durationMs: unknown; now: number }): AudioPlaybackState {
  clockMs(input.now);
  return parseAudioPlaybackState({
    schemaVersion: AUDIO_PLAYBACK_SCHEMA_VERSION, scope: input.scope, assetId: input.assetId, durationMs: input.durationMs,
    version: 0, status: 'READY', positionMs: 0, anchorServerMs: null, changedAtMs: input.now,
  });
}

// ── Reading ──────────────────────────────────────────────────

export interface AudioPlaybackReading { phase: AudioPlaybackPhase; targetMs: number; endsAtMs: number | null }
/** Derived view at `now` — usable without any background job having rewritten the stored status. */
export function readAudioPlayback(rawState: unknown, now: number): AudioPlaybackReading {
  const state = parseAudioPlaybackState(rawState);
  const plan = audioPlaybackPlanOf(state);
  return {
    phase: audioPlaybackPhaseAt(plan, state.durationMs, clockMs(now)),
    targetMs: audioPlaybackTargetMs(plan, state.durationMs, now),
    endsAtMs: audioPlaybackEndsAtMs(plan, state.durationMs),
  };
}

// ── Transitions ──────────────────────────────────────────────

export interface AudioPlaybackChange { state: AudioPlaybackState; changed: boolean }
interface CommonArgs { scope: AudioPlaybackScope; expectedVersion: number; now: number }

function clockMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail('AUDIO_PLAYBACK_TIME_INVALID');
  return value;
}
function sameScope(a: AudioPlaybackScope, b: unknown): boolean {
  const parsed = AudioPlaybackScopeSchema.safeParse(b);
  return parsed.success && parsed.data.runIndex === a.runIndex && parsed.data.roundId === a.roundId
    && parsed.data.playbackId === a.playbackId && parsed.data.contentRevision === a.contentRevision;
}

/**
 * Shared admission order: strict state → scope (a stale/foreign instance is refused before anything else is read) → argument and
 * clock validity → no backwards time → local version → effective end. Returns the validated state.
 */
function admit(rawState: unknown, args: CommonArgs & { startAtMs?: number }, options: { allowEnded: boolean }): AudioPlaybackState {
  const state = parseAudioPlaybackState(rawState);
  if (!sameScope(state.scope, args.scope)) fail('AUDIO_PLAYBACK_SCOPE_INVALID');
  if (!Number.isSafeInteger(args.expectedVersion) || args.expectedVersion < 0) fail('AUDIO_PLAYBACK_ARGS_INVALID');
  clockMs(args.now);
  if (args.now < state.changedAtMs) fail('AUDIO_PLAYBACK_TIME_INVALID');
  if (args.startAtMs !== undefined) {
    // An anchor in the past would claim part of the clip as already played before this command was accepted.
    if (!Number.isSafeInteger(args.startAtMs) || args.startAtMs < args.now) fail('AUDIO_PLAYBACK_TIME_INVALID');
    if (args.startAtMs + state.durationMs > Number.MAX_SAFE_INTEGER) fail('AUDIO_PLAYBACK_TIME_INVALID');
  }
  if (args.expectedVersion !== state.version) fail('AUDIO_PLAYBACK_VERSION_STALE');
  if (!options.allowEnded && state.status === 'RUNNING' && args.now >= audioPlaybackEndsAtMs(audioPlaybackPlanOf(state), state.durationMs)!) fail('AUDIO_PLAYBACK_ENDED');
  return state;
}
function next(state: AudioPlaybackState, patch: Pick<AudioPlaybackState, 'status' | 'positionMs' | 'anchorServerMs'>, now: number): AudioPlaybackChange {
  return { state: parseAudioPlaybackState({ ...state, ...patch, version: state.version + 1, changedAtMs: now }), changed: true };
}
const unchanged = (state: AudioPlaybackState): AudioPlaybackChange => ({ state, changed: false });

/** READY → RUNNING with the anchor `startAtMs` (>= now) at position 0. RUNNING with the current version: no-op, the anchor stays. */
export function startAudioPlayback(rawState: unknown, args: CommonArgs & { startAtMs: number }): AudioPlaybackChange {
  const state = admit(rawState, args, { allowEnded: false });
  if (state.status === 'RUNNING') return unchanged(state);
  if (state.status === 'STOPPED' || state.status === 'ENDED') return fail('AUDIO_PLAYBACK_TERMINAL');
  if (state.status !== 'READY') return fail('AUDIO_PLAYBACK_TRANSITION_INVALID');
  return next(state, { status: 'RUNNING', positionMs: 0, anchorServerMs: args.startAtMs }, args.now);
}

/**
 * RUNNING → PAUSED, freezing the position valid at `now`. Before a scheduled start this cancels the pending start and freezes the
 * anchor position (0 on a first start, the stored offset on a scheduled resume). PAUSED with the current version: no-op.
 */
export function pauseAudioPlayback(rawState: unknown, args: CommonArgs): AudioPlaybackChange {
  const state = admit(rawState, args, { allowEnded: false });
  if (state.status === 'PAUSED') return unchanged(state);
  if (state.status === 'STOPPED' || state.status === 'ENDED') return fail('AUDIO_PLAYBACK_TERMINAL');
  if (state.status !== 'RUNNING') return fail('AUDIO_PLAYBACK_TRANSITION_INVALID');
  return next(state, { status: 'PAUSED', positionMs: audioPlaybackTargetMs(audioPlaybackPlanOf(state), state.durationMs, args.now), anchorServerMs: null }, args.now);
}

/** PAUSED → RUNNING with a NEW anchor `startAtMs` (>= now) at the stored position — never back at 0. RUNNING with the current version: no-op. */
export function resumeAudioPlayback(rawState: unknown, args: CommonArgs & { startAtMs: number }): AudioPlaybackChange {
  const state = admit(rawState, args, { allowEnded: false });
  if (state.status === 'RUNNING') return unchanged(state);
  if (state.status === 'STOPPED' || state.status === 'ENDED') return fail('AUDIO_PLAYBACK_TERMINAL');
  if (state.status !== 'PAUSED') return fail('AUDIO_PLAYBACK_TRANSITION_INVALID');
  return next(state, { status: 'RUNNING', positionMs: state.positionMs, anchorServerMs: args.startAtMs }, args.now);
}

/** READY / RUNNING / PAUSED → STOPPED (terminal for this instance; a new pass needs a new playback id). STOPPED with the current version: no-op. */
export function stopAudioPlayback(rawState: unknown, args: CommonArgs): AudioPlaybackChange {
  const state = admit(rawState, args, { allowEnded: false });
  if (state.status === 'STOPPED') return unchanged(state);
  if (state.status === 'ENDED') return fail('AUDIO_PLAYBACK_TERMINAL');
  return next(state, { status: 'STOPPED', positionMs: state.status === 'RUNNING' ? audioPlaybackTargetMs(audioPlaybackPlanOf(state), state.durationMs, args.now) : state.positionMs, anchorServerMs: null }, args.now);
}

/** Persists the derived end: RUNNING with now >= end → ENDED (terminal, position = duration). ENDED with the current version: no-op. Otherwise refused. */
export function settleAudioPlayback(rawState: unknown, args: CommonArgs): AudioPlaybackChange {
  const state = admit(rawState, args, { allowEnded: true });
  if (state.status === 'ENDED') return unchanged(state);
  if (state.status !== 'RUNNING' || args.now < audioPlaybackEndsAtMs(audioPlaybackPlanOf(state), state.durationMs)!) return fail('AUDIO_PLAYBACK_TRANSITION_INVALID');
  return next(state, { status: 'ENDED', positionMs: state.durationMs, anchorServerMs: null }, args.now);
}

// ── Projection ───────────────────────────────────────────────

const AUDIENCE_ROLES = new Set(['HOST', 'PLAYER', 'VIEWER', 'DISPLAY']);

/**
 * What ONE caller may receive. `release` is decided by the consumer per recipient (auth, role, phase); `sourceVisibility` states WHO
 * may hear the clip at all and is checked with the existing canView rule: a blind host is not a recipient of host-private audio, and
 * administrative rights open neither player- nor team-private audio. The effective release is NONE unless the rule allows the
 * audience. `resolveSource` is called LAZILY and ONLY for LOAD_ONLY / PLAY — never to sign something and hide it afterwards.
 *
 * NONE carries scope and versions only (no source, duration or plan) so that a withdrawal stays orderable. LOAD_ONLY carries the
 * source and duration but no plan: preloading is an information release (the receiver can play the bytes itself). PLAY carries the
 * source and the plan — except for a TERMINAL plan (STOPPED / ENDED), which carries the plan and the duration but no source: nothing
 * is left to play, so no URL is resolved. The projection shows the end correctly even if no job has rewritten the stored status.
 */
export function projectAudioPlayback(
  audience: ProjectionAudience,
  rawState: unknown,
  args: { release: AudioPlaybackRelease; sourceVisibility: VisibilityRule; stateVersion: number; now: number; resolveSource: (assetId: string) => { url: string; renewal: number } },
): AudioPlaybackProjection {
  if (!audience || typeof audience !== 'object' || !AUDIENCE_ROLES.has(audience.role)) return fail('AUDIO_PLAYBACK_AUDIENCE_INVALID');
  if (!(AUDIO_PLAYBACK_RELEASES as readonly string[]).includes(args.release)) return fail('AUDIO_PLAYBACK_RELEASE_INVALID');
  if (!Number.isSafeInteger(args.stateVersion) || args.stateVersion < 0) return fail('AUDIO_PLAYBACK_ARGS_INVALID');
  clockMs(args.now);
  const state = parseAudioPlaybackState(rawState);
  const effective: AudioPlaybackRelease = canView(audience, args.sourceVisibility) ? args.release : 'NONE';
  const base = { contract: AUDIO_PLAYBACK_CONTRACT, scope: { ...state.scope }, stateVersion: args.stateVersion, playbackVersion: state.version, release: effective, serverNowMs: args.now };
  // Never let a ZodError escape: its message can quote values. A failed build is reported by code only.
  const build = (shape: object): AudioPlaybackProjection => {
    const projected = AudioPlaybackProjectionSchema.safeParse({ ...base, ...shape });
    return projected.success ? projected.data : fail('AUDIO_PLAYBACK_PROJECTION_INVALID');
  };
  if (effective === 'NONE') return build({ durationMs: null, source: null, plan: null });
  const plan = audioPlaybackPlanOf(state);
  const ended = state.status === 'RUNNING' && args.now >= audioPlaybackEndsAtMs(plan, state.durationMs)!;
  const terminal = ended || state.status === 'STOPPED' || state.status === 'ENDED';
  // Nothing is left to play for a terminal plan: report it without a source, so no URL is resolved/signed and no clip is fetched for it.
  if (effective === 'PLAY' && terminal) {
    return build({ durationMs: state.durationMs, source: null, plan: ended ? { status: 'ENDED', positionMs: state.durationMs, anchorServerMs: null } : plan });
  }
  let resolved: unknown;
  try { resolved = args.resolveSource(state.assetId); } catch { return fail('AUDIO_PLAYBACK_SOURCE_INVALID'); }
  const checked = AudioPlaybackSourceSchema.safeParse(resolved);
  if (!checked.success) return fail('AUDIO_PLAYBACK_SOURCE_INVALID');
  const source = checked.data;
  if (effective === 'LOAD_ONLY') return build({ durationMs: state.durationMs, source, plan: null });
  return build({ durationMs: state.durationMs, source, plan });
}

/** Issues renewal numbers; `last()` is the value to persist for a restart (null until something was issued). */
export type RenewalIssuer = ((now: number) => number) & { readonly last: () => number | null };

/**
 * The server side's ISSUER of renewal numbers for ONE playback instance (the adapter that signs access URLs keeps one). `issue(now)` returns
 * max(previous + 1, now): strictly increasing INSIDE this instance, also while the server clock stands still or steps back.
 *
 * What is guaranteed across a RESTART — and what is not: an instance cannot know what an earlier instance issued. The order survives a restart in
 * exactly two ways: (a) the adapter persists `issuer.last()` together with its own playback state (the existing persistence/recovery path of the
 * consumer) and recreates the issuer with `createRenewalIssuer(lastPersisted)`; or (b) it relies on the wall clock, which only holds while the clock
 * did not run backwards between the restart and the last issued number. A clock stepped back WITHOUT restoring `last` can issue a lower number than
 * before; a browser that already knows the higher number then treats the fresh URL as older. N7 provides no storage and no time service.
 *
 * A new number is issued ONLY when a new URL is really issued; while the URL handed out earlier is still valid the adapter reuses it together with
 * its number (a re-signed URL for every projection would make every browser reload the clip).
 */
export function createRenewalIssuer(lastIssued?: number): RenewalIssuer {
  if (lastIssued !== undefined && (!Number.isSafeInteger(lastIssued) || lastIssued < 0)) fail('AUDIO_PLAYBACK_ARGS_INVALID');
  let last = lastIssued ?? -1;
  const issue = (now: number): number => { clockMs(now); last = Math.max(last + 1, now); return last; };
  return Object.assign(issue, { last: (): number | null => (last < 0 ? null : last) });
}

export type { AudioPlaybackProjection, AudioPlaybackScope, AudioPlaybackPlan, AudioPlaybackRelease } from '@quiz/shared/audioPlayback';
