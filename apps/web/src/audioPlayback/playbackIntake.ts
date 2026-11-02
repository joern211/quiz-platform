// ============================================================
// N7 — Intake of audio projections: binding, version knowledge, withdrawal (pure, no React, no DOM)
//
// Two things are kept apart, as in N6:
//   seen  — the minimal VERSION KNOWLEDGE of one context: the highest strictly valid, matching snapshot version and plan version
//           observed, and the strictest release at that exact pair. Numbers only; it survives withdrawal.
//   held  — what may be played or loaded right now (the validated projection). Gone on every withdrawal.
// A projection is only an observation if it is strictly valid, belongs to the expected context and is not older than the caller's
// INDEPENDENT `minStateVersion`. Invalid, foreign or too-old input never moves `seen` (no poisoning with a huge unchecked number).
//
// Ordering: a projection older than `seen` in EITHER the snapshot version or the plan version is stale and ignored — it never
// restores a source after a newer withdrawal (PLAY v9 → NONE v10 → PLAY v9), nor after an empty intermediate view (PLAY v9 → null →
// PLAY v8). At the very same (snapshot, plan) pair a re-delivery with the same or a narrower release is accepted (a renewed URL for
// the same clip), a WIDER one is not (a withdrawal at this exact snapshot cannot be undone by its own earlier packet).
// ============================================================

import {
  audioPlaybackContextKey, audioPlaybackProjectionMatches, parseAudioPlaybackProjection,
  type AudioPlaybackExpectedContext, type AudioPlaybackProjection, type AudioPlaybackRelease,
} from '@quiz/shared/audioPlayback';

const RANK: Record<AudioPlaybackRelease, number> = { NONE: 0, LOAD_ONLY: 1, PLAY: 2 };

export interface IntakeMemo {
  key: string;
  seenStateVersion: number;
  seenPlaybackVersion: number;
  /** Release of the last accepted projection (-1 rank = none yet). */
  seenRelease: AudioPlaybackRelease | null;
  held: AudioPlaybackProjection | null;
}
export type IntakeOutcome = 'ACCEPTED' | 'RELEASE_NONE' | 'WITHDRAWN' | 'STALE';
export interface IntakeResult { memo: IntakeMemo; held: AudioPlaybackProjection | null; outcome: IntakeOutcome }

export const emptyMemo = (key: string): IntakeMemo => ({ key, seenStateVersion: -1, seenPlaybackVersion: -1, seenRelease: null, held: null });

export function intakeAudioPlayback(prev: IntakeMemo | null, expected: AudioPlaybackExpectedContext, raw: unknown): IntakeResult {
  const key = audioPlaybackContextKey(expected);
  const base = prev !== null && prev.key === key ? prev : emptyMemo(key); // another context starts with empty knowledge (single slot, no archive)
  const parsed = raw === null || raw === undefined ? null : parseAudioPlaybackProjection(raw);
  const observed = parsed !== null && parsed.ok && audioPlaybackProjectionMatches(parsed.projection, expected) ? parsed.projection : null;
  if (observed === null) {
    // no valid authorisation for THIS context right now: nothing playable survives, the version knowledge does
    return { memo: { ...base, held: null }, held: null, outcome: 'WITHDRAWN' };
  }
  const older = observed.stateVersion < base.seenStateVersion || observed.playbackVersion < base.seenPlaybackVersion;
  const samePair = observed.stateVersion === base.seenStateVersion && observed.playbackVersion === base.seenPlaybackVersion;
  const wider = samePair && base.seenRelease !== null && RANK[observed.release] > RANK[base.seenRelease];
  if (older || wider) return { memo: base, held: base.held, outcome: 'STALE' };
  // URL ordering inside an otherwise acceptable projection: an access URL ISSUED earlier (lower renewal number) never replaces the one already
  // held. The projection is still taken for everything else (plan, versions): a delayed older renewal answer must neither displace the
  // current source nor make the current playback be torn down because of its late arrival.
  const heldSource = base.held?.source ?? null;
  const projection = observed.source !== null && heldSource !== null && observed.source.renewal < heldSource.renewal ? { ...observed, source: heldSource } : observed;
  const held = observed.release === 'NONE' ? null : projection;
  return {
    memo: { key, seenStateVersion: observed.stateVersion, seenPlaybackVersion: observed.playbackVersion, seenRelease: observed.release, held },
    held,
    outcome: held === null ? 'RELEASE_NONE' : 'ACCEPTED',
  };
}
