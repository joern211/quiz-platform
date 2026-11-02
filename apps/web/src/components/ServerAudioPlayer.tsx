// ============================================================
// N7 — ServerAudioPlayer: plays ONE already-released, server-controlled clip (Midnight design)
//
// Responsibility: turn a client-safe audio projection into a status and, where the browser demands it, one real user action. It owns no
// socket, session, command, round or game state and offers no free play / pause / seek control: the SERVER plan decides what should
// be audible; native controls are not used. It never receives the private plan, an asset id, a title or a file path.
//
// Binding BEFORE acting: the projection is validated and compared with the context the embedding UI EXPECTS from its own session
// (run, round, playback id, content revision) and with the caller's independent `minStateVersion`. A foreign, stale, malformed or
// withdrawn projection reaches neither the markup nor the media element. Version knowledge (`seen`) is kept apart from what is playable
// (`held`): a withdrawal or an empty intermediate view stops the sound at once but a late older PLAY can never restore it.
//
// The audio object is NOT part of the DOM and no URL appears in the markup. Equal input (new wrapper objects, repeated snapshots,
// re-renders, theme changes, clock ticks) never restarts or reloads anything — the controller compares a stable key. Unmount,
// StrictMode and context changes release the element, its listeners and timers.
//
// Embedding obligations (not part of N7): produce clock samples (round trip) for `clock`, pass the projection of THIS recipient, supply
// a fresh URL on `onRenewUrl`, and decide any game reaction to a failure. A local failure is shown here and nowhere else.
// ============================================================

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@quiz/ui';
import type { AudioPlaybackExpectedContext } from '@quiz/shared/audioPlayback';
import { intakeAudioPlayback, type IntakeMemo } from '../audioPlayback/playbackIntake';
import { AudioPlaybackController, type AudioLike, type LocalStatus, type Scheduler } from '../audioPlayback/AudioPlaybackController';
import type { ServerClock } from '../audioPlayback/serverClock';
import styles from './ServerAudioPlayer.module.css';

export interface ServerAudioPlayerProps {
  /** The context THIS caller expects, from its own authenticated session and snapshot channel — never taken from the projection. */
  expected: AudioPlaybackExpectedContext;
  /** The projection received for this recipient; null / undefined when there is none (withdrawn, missing, other role). */
  projection: unknown;
  /** Estimated server time (monotonic). Without a valid basis nothing starts. */
  clock: ServerClock;
  /** Neutral heading. Plain text. */
  label?: string;
  /** Asks the application for a fresh access URL of the SAME clip (the plan stays). */
  onRenewUrl?: () => void;
  /** Test / harness seams, read once at mount. */
  createAudio?: () => AudioLike;
  scheduler?: Scheduler;
  monoNow?: () => number;
}

const STATUS_TEXT: Record<LocalStatus, string> = {
  UNAVAILABLE: 'Das Audio ist zurzeit nicht verfügbar.',
  AWAITING_CLOCK: 'Die Zeit wird abgeglichen …',
  PRELOADED: 'Das Audio ist vorbereitet.',
  NOT_STARTED: 'Die Wiedergabe hat noch nicht begonnen.',
  LOADING: 'Das Audio wird geladen …',
  WAITING_FOR_START: 'Die Wiedergabe startet gleich.',
  PLAYING: 'Das Audio läuft.',
  BUFFERING: 'Das Audio puffert …',
  PAUSED: 'Die Wiedergabe ist pausiert.',
  STOPPED: 'Die Wiedergabe wurde gestoppt.',
  ENDED: 'Die Wiedergabe ist zu Ende.',
  AUTOPLAY_BLOCKED: 'Dein Browser blockiert das automatische Abspielen. Aktiviere das Audio, um mitzuhören.',
  ERROR: 'Das Audio kann gerade nicht geladen werden.',
};
const fmt = (ms: number): string => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const sameMemo = (a: IntakeMemo | null, b: IntakeMemo): boolean => a !== null && a.key === b.key && a.seenStateVersion === b.seenStateVersion
  && a.seenPlaybackVersion === b.seenPlaybackVersion && a.seenRelease === b.seenRelease && JSON.stringify(a.held) === JSON.stringify(b.held);

export function ServerAudioPlayer({ expected, projection, clock, label = 'Audio', onRenewUrl, createAudio, scheduler, monoNow }: ServerAudioPlayerProps) {
  const titleId = `${useId()}-title`;
  const seams = useRef({ createAudio, scheduler, monoNow });

  // Bind first (pure, derived while rendering): only a strictly valid, matching, not-too-old projection is an observation at all.
  const [memo, setMemo] = useState<IntakeMemo | null>(null);
  const intake = intakeAudioPlayback(memo, expected, projection);
  if (!sameMemo(memo, intake.memo)) setMemo(intake.memo);
  const held = intake.held;

  const controller = useMemo(() => new AudioPlaybackController({ clock, ...seams.current }), [clock]);
  useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
  // Layout effect: a withdrawal must silence the element before the browser paints. `apply` compares a stable key; equal input does nothing.
  useLayoutEffect(() => { controller.apply(held); });
  useEffect(() => {
    const resync = () => { if (document.visibilityState !== 'hidden') controller.resync(); };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('pageshow', resync);
    return () => { document.removeEventListener('visibilitychange', resync); window.removeEventListener('pageshow', resync); };
  }, [controller]);

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  // Never show a local status for something that is not currently authorised, not even for one frame.
  const status: LocalStatus = held === null ? 'UNAVAILABLE' : snapshot.status;
  const showPosition = held !== null && snapshot.positionMs !== null && snapshot.durationMs !== null && ['PLAYING', 'BUFFERING', 'PAUSED', 'STOPPED', 'WAITING_FOR_START', 'AUTOPLAY_BLOCKED', 'LOADING'].includes(status);

  return (
    <section className={styles.card} aria-labelledby={titleId} data-status={status}>
      <h3 id={titleId} className={styles.title}>{label}</h3>
      <p className={`${styles.status} ${status === 'ERROR' ? styles.problem : ''}`} role="status">{STATUS_TEXT[status]}</p>
      {showPosition && <p className={styles.position}>Position {fmt(snapshot.positionMs!)} von {fmt(snapshot.durationMs!)}</p>}
      {held !== null && (snapshot.canActivate || snapshot.canRetry) && (
        <div className={styles.actions}>
          {snapshot.canActivate && <Button type="button" size="lg" className={styles.action} onClick={() => controller.activate()}>Audio aktivieren</Button>}
          {snapshot.canRetry && <Button type="button" size="lg" variant="secondary" className={styles.action} onClick={() => controller.retry(onRenewUrl)}>Erneut laden</Button>}
        </div>
      )}
    </section>
  );
}
