// ============================================================
// N6 — ParticipationStatusCard: read-only display of ONE already-released actor (Midnight design)
//
// Responsibility: show the gameplay status ("Aktiv" / "Ausgeschieden") and, where released, the current lives of ONE actor, taken
// from a client-safe projection. It owns no socket, session, command, timer or gameplay state machine, offers no plus / minus /
// eliminate control and takes no callback. It never receives the private track, the life policy, a roster or an N5 deal — only the
// projection contract plus the context the embedding UI EXPECTS from its own authenticated session.
//
// Binding BEFORE rendering: the projection is validated with the strict client schema and compared with the expected context
// (run, track, roster revision, actor kind, actor id) while rendering. A foreign, stale, malformed or record-less projection never
// reaches the markup — not even for one frame. An effect that resets afterwards would be too late and is not relied upon.
//
// Snapshot order: `expected.minStateVersion` comes from the caller's OWN snapshot channel, independent of the incoming projection
// (taking it from the same projection would let a stale projection vouch for itself); an older projection is rejected. In addition
// the card remembers the highest snapshot version it has shown for this context: a late, older projection of the SAME kind of record
// never turns an "Ausgeschieden" back into "Aktiv" or restores more lives — the newer view stays. An older projection of a different
// kind (e.g. a public entry after a private own record) is not substituted: the card shows the neutral unavailable state instead.
//
// Withdrawal and change: a missing / invalid / unauthorised projection, another actor or any context change drops everything that was
// held. A later projection starts fresh with ITS own values — an old value is never revived, also not after a withdrawal.
//
// Presentation: status is text (never colour or a symbol alone). Lives appear ONLY as the number the server released: 0 is a real
// value; hidden or "no life model" shows no lives row at all (never a 0, never an empty bar, never a hidden KO symbol). No "winner",
// no points, no rank. Plain text only; no timer, no animation, no audio, no toast, no tooltip, no live region.
// ============================================================

import { useId, useState } from 'react';
import {
  parseParticipationProjection, participationActorView, participationContextKey, participationProjectionMatches,
  type ParticipationActorView, type ParticipationExpectedContext, type ParticipationProjection,
} from '@quiz/shared/participation';
import styles from './ParticipationStatusCard.module.css';

export interface ParticipationStatusCardProps {
  /** The context THIS caller expects, from its own authenticated session and snapshot channel — never taken from the projection. */
  expected: ParticipationExpectedContext;
  /** The projection received for this viewer; null / undefined when there is none (withdrawn, missing, other role). */
  projection: ParticipationProjection | null | undefined;
  /** Neutral heading, e.g. the name the caller already shows for this actor. Plain text. */
  label?: string;
}

const UNAVAILABLE = 'Der Status ist zurzeit nicht verfügbar.';
const STATUS_TEXT = { ACTIVE: 'Aktiv', ELIMINATED: 'Ausgeschieden' } as const;

/** What is currently shown: the context it belongs to, the snapshot version, the record and whether it is the caller's own. */
interface Shown { key: string; version: number; view: ParticipationActorView; own: boolean }
const same = (a: Shown | null, b: Shown): boolean => a !== null && a.key === b.key && a.version === b.version && a.own === b.own && JSON.stringify(a.view) === JSON.stringify(b.view);

export function ParticipationStatusCard({ expected, projection, label = 'Spielstatus' }: ParticipationStatusCardProps) {
  const titleId = `${useId()}-title`;

  // Bind first: only a strictly valid projection that matches the expected context and holds a record for the actor may reach the markup.
  const key = participationContextKey(expected);
  const parsed = projection ? parseParticipationProjection(projection) : null;
  const found = parsed !== null && parsed.ok && participationProjectionMatches(parsed.projection, expected) ? participationActorView(parsed.projection, expected.actorId) : null;
  const incoming: Shown | null = parsed !== null && parsed.ok && found !== null ? { key, version: parsed.projection.stateVersion, view: found.view, own: found.own } : null;

  const [held, setHeld] = useState<Shown | null>(incoming);
  let shown: Shown | null = null;
  if (incoming === null) {
    if (held !== null) setHeld(null); // withdrawal / invalid / other actor: nothing old survives
  } else if (held !== null && held.key === key && incoming.version < held.version) {
    // an older snapshot after a newer one: keep the newer view of the same kind of record; for another kind show the neutral state
    // and leave `held` untouched — clearing it would let the next render accept this very (older) projection after all
    if (held.own === incoming.own) shown = held;
  } else {
    shown = incoming;
    if (!same(held, incoming)) setHeld(incoming);
  }

  if (shown === null) {
    return (
      <section className={styles.card} aria-labelledby={titleId}>
        <h3 id={titleId} className={styles.title}>{label}</h3>
        <p className={styles.unavailable}>{UNAVAILABLE}</p>
      </section>
    );
  }
  const { view } = shown;
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.title}>{label}</h3>
      <p className={styles.source}>{shown.own ? 'Deine eigene Angabe.' : 'Öffentlich sichtbar.'}</p>
      <dl className={styles.list}>
        <div className={styles.row}>
          <dt className={styles.term}>Status</dt>
          <dd className={`${styles.value} ${view.status === 'ACTIVE' ? styles.active : styles.eliminated}`}>{STATUS_TEXT[view.status]}</dd>
        </div>
        {view.lives.state === 'VALUE' && (
          <div className={styles.row}>
            <dt className={styles.term}>Leben</dt>
            <dd className={styles.value}>{view.lives.value}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
