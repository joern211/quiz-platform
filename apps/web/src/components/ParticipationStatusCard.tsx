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
// (taking it from the same projection would let a stale projection vouch for itself); a projection below it is rejected. In addition the
// card keeps a small VERSION MARK per displayed context: the highest `stateVersion` of any strictly valid, matching projection it has
// OBSERVED for that context — also one that released no record for the actor, and also after the displayed data were discarded. The mark
// holds a number and the context key only (no status, no life value, no roster); it is separate from the optionally held display data.
// A later projection below the mark never shows anything old: a still-displayed newer view of the SAME kind of record stays (a late
// older packet never turns "Ausgeschieden" back into "Aktiv"), otherwise the neutral unavailable state is shown until a projection at or
// above the mark arrives. Invalid, foreign or below-minimum projections never move the mark (no poisoning with unchecked numbers).
//
// Withdrawal and change: a missing / invalid / unauthorised / record-less projection discards ALL held display data at once (private
// values never survive a withdrawal) but keeps the version mark of the same context. Another actor, run, track, roster revision or actor
// kind is another context: both the mark and the data start empty (a single slot; no cache of old contexts). The caller must still raise
// `minStateVersion` as soon as it knows a newer snapshot — the mark protects within one displayed context only.
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

/** What is currently shown: the record of the expected actor and whether it is the caller's own. */
interface Shown { version: number; view: ParticipationActorView; own: boolean }
/**
 * Everything the card remembers for ONE context key. `seen` is the version MARK (highest valid matching snapshot observed, -1 = none);
 * `shown` is the optionally held display data. Withdrawal clears `shown` only; a context change replaces the whole memo.
 */
interface Memo { key: string; seen: number; shown: Shown | null }
/** A strictly valid, matching projection that passed the caller's minimum: its version and the record it holds for the actor (or none). */
interface Observed { version: number; record: Shown | null }

/** Pure transition (no React): what is displayed for the new observation and what is remembered afterwards. */
function stepParticipationMemo(prev: Memo | null, key: string, observed: Observed | null): { memo: Memo; shown: Shown | null } {
  const base: Memo = prev !== null && prev.key === key ? prev : { key, seen: -1, shown: null };
  if (observed === null) return { memo: { key, seen: base.seen, shown: null }, shown: null }; // withdrawal: data gone, version knowledge stays
  if (observed.version < base.seen) {
    // older than a snapshot already observed in this context: never shown; only a still-held newer view of the same kind stays visible
    const keep = base.shown !== null && observed.record !== null && observed.record.own === base.shown.own ? base.shown : null;
    return { memo: base, shown: keep };
  }
  return { memo: { key, seen: observed.version, shown: observed.record }, shown: observed.record }; // also a valid projection without a record raises the mark
}
const sameMemo = (a: Memo, b: Memo): boolean => a.key === b.key && a.seen === b.seen && JSON.stringify(a.shown) === JSON.stringify(b.shown);

export function ParticipationStatusCard({ expected, projection, label = 'Spielstatus' }: ParticipationStatusCardProps) {
  const titleId = `${useId()}-title`;

  // Bind first: only a strictly valid projection that matches the expected context (and the caller's minimum) is an observation at all.
  const key = participationContextKey(expected);
  const parsed = projection ? parseParticipationProjection(projection) : null;
  const valid = parsed !== null && parsed.ok && participationProjectionMatches(parsed.projection, expected) ? parsed.projection : null;
  const found = valid !== null ? participationActorView(valid, expected.actorId) : null;
  const observed: Observed | null = valid === null ? null : { version: valid.stateVersion, record: found === null ? null : { version: valid.stateVersion, view: found.view, own: found.own } };

  const [memo, setMemo] = useState<Memo>(() => stepParticipationMemo(null, key, observed).memo);
  const next = stepParticipationMemo(memo, key, observed); // derived while rendering: no effect, no frame with old content
  const shown = next.shown;
  if (!sameMemo(memo, next.memo)) setMemo(next.memo);

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
