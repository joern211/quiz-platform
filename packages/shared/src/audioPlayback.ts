// ============================================================
// N7 — Server-controlled audio playback contract: CLIENT-SAFE part only (technical foundation, no game rules)
//
// One prepared, normalised clip per playback instance. The server owns a PLAN (state + anchor); what may leave the server is
// the PROJECTION one caller receives. Intent (plan) and local media state (loading, buffering, autoplay blocked, error) are
// different facts and are never derived from each other: a server-side RUNNING does not prove that any browser is playing.
//
// Units: every time value is an integer number of MILLISECONDS (`*Ms`), a finite safe integer. `HTMLMediaElement.currentTime`
// is in seconds and is converted in exactly one place (msToMediaSeconds / mediaSecondsToMs). Seconds are never guessed.
//
// Time formula for a RUNNING plan (shared by the server projection and the browser, one implementation):
//   targetMs(now)  = clamp(positionMs + max(0, now - anchorServerMs), 0, durationMs)
//   endsAtMs       = anchorServerMs + (durationMs - positionMs)
//   active         <=> anchorServerMs <= now < endsAtMs          (half-open [start, end): at `endsAtMs` the clip is over)
//   now < anchor   => SCHEDULED: nothing may be audible yet; the target is the anchor position (0 on first start)
//
// Information protection: `release` NONE / LOAD_ONLY / PLAY is decided by the server per recipient. NONE carries no source,
// no duration and no plan — only scope and versions, so a WITHDRAWAL is still orderable. The projection never contains a
// title, artist, file name, storage path or content text. A short-lived URL is not DRM: delivered bytes stay with the receiver.
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no parameter properties, and a self-contained
// file without relative imports (as participation.ts / secretInfo.ts).
// ============================================================

import { z } from 'zod';

export const AUDIO_PLAYBACK_SCHEMA_VERSION = 1 as const;
export const AUDIO_PLAYBACK_CONTRACT = 'AUDIO_PLAYBACK_V1' as const;

/**
 * Protection bounds, not game rules. 1_800_000 ms is the upper bound the existing audio pipeline already enforces
 * (MAX_AUDIO_DURATION_SECONDS <= 1800 in config/index.ts). The URL bound keeps a projection small.
 */
export const AUDIO_PLAYBACK_MAX_DURATION_MS = 1_800_000;
export const AUDIO_PLAYBACK_MAX_ID_LENGTH = 200;
export const AUDIO_PLAYBACK_MAX_REF_LENGTH = 80;
export const AUDIO_PLAYBACK_MAX_URL_LENGTH = 2048;

/** Stored plan states. SCHEDULED / PLAYING are derived (see audioPlaybackPhaseAt), never stored. */
export const AUDIO_PLAYBACK_STATUSES = ['READY', 'RUNNING', 'PAUSED', 'STOPPED', 'ENDED'] as const;
export const AUDIO_PLAYBACK_PHASES = ['READY', 'SCHEDULED', 'PLAYING', 'PAUSED', 'STOPPED', 'ENDED'] as const;
export const AUDIO_PLAYBACK_RELEASES = ['NONE', 'LOAD_ONLY', 'PLAY'] as const;
export type AudioPlaybackStatus = typeof AUDIO_PLAYBACK_STATUSES[number];
export type AudioPlaybackPhase = typeof AUDIO_PLAYBACK_PHASES[number];
export type AudioPlaybackRelease = typeof AUDIO_PLAYBACK_RELEASES[number];

/**
 * Wire error codes (the message of the thrown error equals the code). They carry no asset id, URL, path, title or value.
 * A later consumer reports ONLY the code (plus its own trace id) and keeps the rest server-side.
 */
export const AUDIO_PLAYBACK_ERROR_CODES = [
  'AUDIO_PLAYBACK_STATE_INVALID', 'AUDIO_PLAYBACK_ARGS_INVALID', 'AUDIO_PLAYBACK_SCOPE_INVALID',
  'AUDIO_PLAYBACK_VERSION_STALE', 'AUDIO_PLAYBACK_TIME_INVALID', 'AUDIO_PLAYBACK_TRANSITION_INVALID',
  'AUDIO_PLAYBACK_TERMINAL', 'AUDIO_PLAYBACK_ENDED', 'AUDIO_PLAYBACK_AUDIENCE_INVALID',
  'AUDIO_PLAYBACK_RELEASE_INVALID', 'AUDIO_PLAYBACK_SOURCE_INVALID', 'AUDIO_PLAYBACK_PROJECTION_INVALID',
] as const;
export type AudioPlaybackErrorCode = typeof AUDIO_PLAYBACK_ERROR_CODES[number];

export class AudioPlaybackError extends Error {
  readonly code: AudioPlaybackErrorCode;
  constructor(code: AudioPlaybackErrorCode) {
    super(code);
    this.code = code;
    this.name = 'AudioPlaybackError';
  }
}

// ── Field schemas (shared by the client projection and the server-private state) ─────────────

/** Opaque server-side label (round id, playback id, content revision). Must not encode a title, a path or a solution. */
export const AudioPlaybackRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(AUDIO_PLAYBACK_MAX_REF_LENGTH);
export const AudioPlaybackRunIndexSchema = z.number().int().safe().positive();
/** A point in server time or a position in the clip: a non-negative safe integer number of milliseconds. */
export const AudioPlaybackMsSchema = z.number().int().safe().nonnegative();
export const AudioPlaybackDurationMsSchema = z.number().int().safe().positive().max(AUDIO_PLAYBACK_MAX_DURATION_MS);
export const AudioPlaybackVersionSchema = z.number().int().safe().nonnegative();
export const AudioPlaybackStatusSchema = z.enum(AUDIO_PLAYBACK_STATUSES);

/**
 * The binding of one playback instance: run, round, opaque playback id and the pinned content/source revision. A URL token, a
 * title or a path is not an identity. A new clip or a deliberate new pass gets a new `playbackId`; a renewed access URL for the
 * same running clip does not.
 */
export const AudioPlaybackScopeSchema = z.object({
  runIndex: AudioPlaybackRunIndexSchema,
  roundId: AudioPlaybackRefSchema,
  playbackId: AudioPlaybackRefSchema,
  contentRevision: AudioPlaybackRefSchema,
}).strict();
export type AudioPlaybackScope = z.infer<typeof AudioPlaybackScopeSchema>;

/** The schedule: status plus the position at the anchor and the anchor itself (server time) — RUNNING only. */
export const AudioPlaybackPlanSchema = z.object({
  status: AudioPlaybackStatusSchema,
  positionMs: AudioPlaybackMsSchema,
  anchorServerMs: AudioPlaybackMsSchema.nullable(),
}).strict().superRefine((plan, ctx) => {
  if ((plan.status === 'RUNNING') !== (plan.anchorServerMs !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ANCHOR_STATUS_CONFLICT' });
});
export type AudioPlaybackPlan = z.infer<typeof AudioPlaybackPlanSchema>;

// ── Time formula (pure; `now` is always explicit) ────────────

function checkMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new AudioPlaybackError('AUDIO_PLAYBACK_TIME_INVALID');
}
function checkPlan(plan: AudioPlaybackPlan, durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > AUDIO_PLAYBACK_MAX_DURATION_MS
    || !Number.isSafeInteger(plan.positionMs) || plan.positionMs < 0 || plan.positionMs > durationMs
    || (plan.status === 'RUNNING') !== (plan.anchorServerMs !== null)
    || (plan.anchorServerMs !== null && (!Number.isSafeInteger(plan.anchorServerMs) || plan.anchorServerMs < 0 || plan.anchorServerMs + (durationMs - plan.positionMs) > Number.MAX_SAFE_INTEGER))) {
    throw new AudioPlaybackError('AUDIO_PLAYBACK_STATE_INVALID');
  }
}

/** Server time at which a RUNNING plan is over (exclusive end), or null when the plan is not RUNNING. */
export function audioPlaybackEndsAtMs(plan: AudioPlaybackPlan, durationMs: number): number | null {
  checkPlan(plan, durationMs);
  return plan.status === 'RUNNING' && plan.anchorServerMs !== null ? plan.anchorServerMs + (durationMs - plan.positionMs) : null;
}

/** Derived display phase at `nowMs`. RUNNING before the anchor is SCHEDULED; RUNNING at/after the end is ENDED. */
export function audioPlaybackPhaseAt(plan: AudioPlaybackPlan, durationMs: number, nowMs: number): AudioPlaybackPhase {
  checkMs(nowMs);
  const endsAt = audioPlaybackEndsAtMs(plan, durationMs);
  if (plan.status !== 'RUNNING') return plan.status;
  if (nowMs < plan.anchorServerMs!) return 'SCHEDULED';
  return nowMs >= endsAt! ? 'ENDED' : 'PLAYING';
}

/** Target position in the clip at `nowMs` (ms): clamp(position + max(0, now - anchor), 0, duration); frozen otherwise; the duration when ENDED. */
export function audioPlaybackTargetMs(plan: AudioPlaybackPlan, durationMs: number, nowMs: number): number {
  checkMs(nowMs);
  checkPlan(plan, durationMs);
  if (plan.status === 'ENDED') return durationMs;
  if (plan.status !== 'RUNNING') return plan.positionMs;
  return Math.min(durationMs, Math.max(0, plan.positionMs + Math.max(0, nowMs - plan.anchorServerMs!)));
}

/** The single millisecond/second conversion for HTMLMediaElement.currentTime. */
export function msToMediaSeconds(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new AudioPlaybackError('AUDIO_PLAYBACK_ARGS_INVALID');
  return ms / 1000;
}
/** Seconds from the media element back to whole milliseconds; null for NaN / Infinity / negative values (metadata not usable yet). */
export function mediaSecondsToMs(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

// ── Client projection ────────────────────────────────────────

/**
 * A same-origin path only: no scheme, no host, no protocol-relative URL, no whitespace or control characters. The application
 * hands the browser its own protected media path (e.g. /api/v1/media/…); a projection can never point the player elsewhere.
 */
export const AudioPlaybackUrlSchema = z.string().min(2).max(AUDIO_PLAYBACK_MAX_URL_LENGTH)
  .regex(/^\/(?!\/)\S*$/)
  .refine(url => !url.includes('\\') && ![...url].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127));

export const AudioPlaybackProjectionSchema = z.object({
  contract: z.literal(AUDIO_PLAYBACK_CONTRACT),
  scope: AudioPlaybackScopeSchema,
  /** Version of the authoritative game snapshot this projection belongs to (NOT the plan version, NOT a local generation). */
  stateVersion: AudioPlaybackVersionSchema,
  /** Version of the plan; monotone within one instance. */
  playbackVersion: AudioPlaybackVersionSchema,
  release: z.enum(AUDIO_PLAYBACK_RELEASES),
  /** Server clock when this projection was built — metadata for diagnostics; NOT a clock offset (no round trip). */
  serverNowMs: AudioPlaybackMsSchema,
  durationMs: AudioPlaybackDurationMsSchema.nullable(),
  source: z.object({ url: AudioPlaybackUrlSchema }).strict().nullable(),
  plan: AudioPlaybackPlanSchema.nullable(),
}).strict().superRefine((p, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (p.release === 'NONE') {
    if (p.durationMs !== null || p.source !== null || p.plan !== null) bad('NONE_CARRIES_DATA');
    return;
  }
  if (p.durationMs === null || p.source === null) { bad('RELEASE_WITHOUT_SOURCE'); return; }
  if (p.release === 'LOAD_ONLY') { if (p.plan !== null) bad('LOAD_ONLY_CARRIES_PLAN'); return; }
  if (p.plan === null) { bad('PLAY_WITHOUT_PLAN'); return; }
  try { checkPlan(p.plan, p.durationMs); } catch { bad('PLAN_OUT_OF_RANGE'); }
});
export type AudioPlaybackProjection = z.infer<typeof AudioPlaybackProjectionSchema>;

export type AudioPlaybackProjectionResult = { ok: true; projection: AudioPlaybackProjection } | { ok: false; code: 'AUDIO_PLAYBACK_PROJECTION_INVALID' };
/** Failure carries a code only: no values, no zod paths. Returns a fresh copy. */
export function parseAudioPlaybackProjection(raw: unknown): AudioPlaybackProjectionResult {
  const parsed = AudioPlaybackProjectionSchema.safeParse(raw);
  return parsed.success ? { ok: true, projection: parsed.data } : { ok: false, code: 'AUDIO_PLAYBACK_PROJECTION_INVALID' };
}

/**
 * What the UI's own authenticated context expects, INDEPENDENTLY of the projection that arrives: the scope and
 * `minStateVersion`, the oldest authoritative snapshot version the caller will accept (from the caller's OWN snapshot channel —
 * never copy it out of the incoming projection, that would make a stale projection vouch for itself).
 */
export interface AudioPlaybackExpectedContext extends AudioPlaybackScope { minStateVersion: number }

/** True iff the scope of a (valid) projection equals the expected scope and its snapshot is not older than expected. */
export function audioPlaybackProjectionMatches(projection: AudioPlaybackProjection, expected: AudioPlaybackExpectedContext): boolean {
  return projection.scope.runIndex === expected.runIndex && projection.scope.roundId === expected.roundId
    && projection.scope.playbackId === expected.playbackId && projection.scope.contentRevision === expected.contentRevision
    && Number.isSafeInteger(expected.minStateVersion) && projection.stateVersion >= expected.minStateVersion;
}

/** Public UI context key: run, round, playback id and content revision. Labels only — never a URL, an asset id or a position. */
export function audioPlaybackContextKey(scope: AudioPlaybackScope): string {
  return JSON.stringify(['AUDIO_PLAYBACK', scope.runIndex, scope.roundId, scope.playbackId, scope.contentRevision]);
}
