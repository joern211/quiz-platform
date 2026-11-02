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
  /**
   * Highest access-URL renewal number accepted in this context (-1 = none). A NUMBER only, kept apart from `held` like the two versions: it survives
   * a withdrawal, null, undefined and an invalid view, so a delayed older renewal can never come back through an empty intermediate state.
   */
  seenRenewal: number;
  held: AudioPlaybackProjection | null;
}
export type IntakeOutcome = 'ACCEPTED' | 'RELEASE_NONE' | 'WITHDRAWN' | 'STALE';
export interface IntakeResult { memo: IntakeMemo; held: AudioPlaybackProjection | null; outcome: IntakeOutcome }

export const emptyMemo = (key: string): IntakeMemo => ({ key, seenStateVersion: -1, seenPlaybackVersion: -1, seenRelease: null, seenRenewal: -1, held: null });

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
  // URL ordering inside an otherwise acceptable projection. A source ISSUED earlier than one already known (lower renewal number — or the same number with
  // another URL, which would contradict the issuer) never replaces the held source, whatever the arrival order. The projection is still taken for everything
  // else (plan, versions): a late older renewal must neither displace the current source nor make a newer pause/stop get lost. When the older source arrives
  // while NO source is held (after a withdrawal, null, undefined or an invalid view) there is nothing newer to keep: the projection is held WITHOUT a source
  // (the older URL is dropped, not loaded) and the controller shows the neutral state with the retrieval action. Only the number is remembered, never a URL.
  let projection = observed;
  let seenRenewal = base.seenRenewal;
  if (observed.source !== null) {
    const heldSource = base.held?.source ?? null;
    const behind = observed.source.renewal < base.seenRenewal;
    const contradicts = observed.source.renewal === base.seenRenewal && heldSource !== null && heldSource.url !== observed.source.url;
    if (behind || contradicts) projection = { ...observed, source: heldSource };
    else seenRenewal = observed.source.renewal;
  }
  const held = observed.release === 'NONE' ? null : projection;
  return {
    memo: { key, seenStateVersion: observed.stateVersion, seenPlaybackVersion: observed.playbackVersion, seenRelease: observed.release, seenRenewal, held },
    held,
    outcome: held === null ? 'RELEASE_NONE' : 'ACCEPTED',
  };
}
