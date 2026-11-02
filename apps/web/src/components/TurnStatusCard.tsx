// ============================================================
// N8 — TurnStatusCard: read-only display of the current turn, with an optional application callback (Midnight design)
//
// Responsibility: show whose turn it is (team and player only where the server RELEASED them), the state, the turn number and — with the
// order release — the outer order, taken from a client-safe projection. It owns no socket, session, command, timer or turn state machine
// and never mutates the sequence: the optional `onAdvance` is an APPLICATION callback, called with the binding of the turn that is
// currently shown (turn number + sequence version). The server decides on its own; `canAct` in the projection is a display aid only.
//
// Binding BEFORE rendering: the projection is validated with the strict client schema and compared with the expected context (run,
// sequence, roster revision, unit, recipient) and the caller's INDEPENDENT `minStateVersion` while rendering. A foreign, stale, malformed or
// withdrawn projection never reaches the markup — not even for one frame. An effect that resets afterwards would be too late and is not used.
//
// Ordering: see turnIntake.ts. Version knowledge (one number per ordering level) is held apart from the displayed data. A late older packet
// — an older snapshot, an older turn, an older entitlement — never restores a holder or an action; a withdrawal keeps the knowledge.
//
// Sending: the action is offered only when the shown projection says the recipient holds the turn and may act (`you.canAct`). A press
// calls `onAdvance(binding)` once and locks the button for exactly THIS binding. New props objects, an equal projection, a theme change
// and a re-render do not clear the lock (it is keyed by context + binding, not by object identity). A NEW turn or a new sequence version
// is another binding: the button belongs to that one and never re-sends the old one. A rejected promise from `onAdvance` unlocks the same
// binding (a failed send may be tried again; a late callback of an old turn cannot finish a new one — the server compares both numbers).
// Nothing here advances a turn on its own: no effect, no timer, no mount, no prop change calls `onAdvance`.
//
// Presentation: state and holder are text (never colour alone); plain text nodes only (names come from the caller's own mapping, the id is
// the fallback); no timer, no animation, no audio, no toast. The status line is a polite live region so a new turn is announced.
// ============================================================

import { useId, useRef, useState } from 'react';
import { Button } from '@quiz/ui';
import { turnActionBindingKey, turnSequenceContextKey, type TurnActionBinding, type TurnSequenceExpectedContext, type TurnSequenceProjection } from '@quiz/shared/turnSequence';
import { intakeTurnSequence, type TurnIntakeMemo } from '../turnSequence/turnIntake';
import styles from './TurnStatusCard.module.css';

export interface TurnStatusCardProps {
  /** The context THIS caller expects, from its own authenticated session and snapshot channel — never taken from the projection. */
  expected: TurnSequenceExpectedContext;
  /** The projection received for this recipient; null / undefined when there is none (withdrawn, missing, other role). */
  projection: TurnSequenceProjection | null | undefined;
  /** Neutral heading. Plain text. */
  label?: string;
  /** Display names by id (players and teams) from the caller's own data; an id without a name is shown as its id. */
  names?: Readonly<Record<string, string>>;
  /** Optional: label of the action offered to the holder. */
  actionLabel?: string;
  /** Optional application callback for the offered action. May return a promise; a rejection unlocks the same binding. */
  onAdvance?: (binding: TurnActionBinding) => void | Promise<unknown>;
}

const UNAVAILABLE = 'Der Zugstatus ist zurzeit nicht verfügbar.';
const STATUS_TEXT = {
  READY: 'Noch nicht begonnen.', ACTIVE: 'Ein Zug läuft.', HELD: 'Der Zug ist angehalten.', NO_ELIGIBLE: 'Niemand ist am Zug.', CLOSED: 'Beendet.',
} as const;

const sameMemo = (a: TurnIntakeMemo, b: TurnIntakeMemo): boolean => a.key === b.key && a.seenStateVersion === b.seenStateVersion && a.seenSequenceVersion === b.seenSequenceVersion
  && a.seenTurnNumber === b.seenTurnNumber && a.seenEntitlement === b.seenEntitlement && a.seenRelease === b.seenRelease && JSON.stringify(a.held) === JSON.stringify(b.held);

export function TurnStatusCard({ expected, projection, label = 'Zugfolge', names, actionLabel = 'Zug beenden', onAdvance }: TurnStatusCardProps) {
  const titleId = `${useId()}-title`;
  const key = turnSequenceContextKey(expected);

  // Derived while rendering: no effect, no frame with old content. `memo` holds the version knowledge and the shown data.
  const [memo, setMemo] = useState<TurnIntakeMemo>(() => intakeTurnSequence(null, expected, projection).memo);
  const step = intakeTurnSequence(memo, expected, projection);
  const held = step.held;
  if (!sameMemo(memo, step.memo)) setMemo(step.memo);

  const [sent, setSent] = useState<string | null>(null);
  const sentRef = useRef<string | null>(null);

  if (held === null || held.release === 'NONE') {
    return (
      <section className={styles.card} aria-labelledby={titleId}>
        <h3 id={titleId} className={styles.title}>{label}</h3>
        <p className={styles.unavailable}>{UNAVAILABLE}</p>
      </section>
    );
  }

  const nameOf = (id: string): string => names?.[id] ?? id;
  const binding: TurnActionBinding = { turnNumber: held.turnNumber, sequenceVersion: held.sequenceVersion };
  const lockKey = `${key}|${turnActionBindingKey(binding)}`;
  const locked = sent === lockKey;
  const offered = onAdvance !== undefined && held.you !== null && held.you.canAct;
  const holder = held.current;
  const you = held.you;

  const advance = () => {
    if (onAdvance === undefined || sentRef.current === lockKey) return; // one send per concrete turn binding
    sentRef.current = lockKey;
    setSent(lockKey);
    const unlock = () => { if (sentRef.current === lockKey) sentRef.current = null; setSent(current => (current === lockKey ? null : current)); };
    try {
      const result = onAdvance(binding);
      if (result !== undefined && result !== null && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(undefined, unlock);
    } catch (error) { unlock(); throw error; }
  };

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.title}>{label}</h3>
      <p className={`${styles.status} ${held.status === 'HELD' ? styles.held : ''}`} role="status">{STATUS_TEXT[held.status]}</p>
      {you !== null && you.holdsTurn && you.canAct && <p className={styles.hint}>Du bist am Zug.</p>}
      {you !== null && you.holdsTurn && !you.canAct && <p className={styles.hint}>Dein Zug ist angehalten.</p>}
      {you !== null && !you.holdsTurn && you.teamHoldsTurn === true && <p className={styles.hint}>Dein Team ist am Zug. Du kannst beraten.</p>}
      <dl className={styles.list}>
        {holder !== null && (
          <div className={styles.row}>
            <dt className={styles.term}>{holder.teamId === null ? 'Am Zug' : 'Team am Zug'}</dt>
            <dd className={styles.value}>{holder.teamId === null ? nameOf(holder.playerId) : nameOf(holder.teamId)}</dd>
          </div>
        )}
        {holder !== null && holder.teamId !== null && (
          <div className={styles.row}>
            <dt className={styles.term}>Zuständig</dt>
            <dd className={styles.value}>{nameOf(holder.playerId)}</dd>
          </div>
        )}
        {held.turnNumber > 0 && (
          <div className={styles.row}>
            <dt className={styles.term}>Zug</dt>
            <dd className={styles.value}>{held.turnNumber}</dd>
          </div>
        )}
        {held.release === 'ORDER' && (
          <div className={styles.row}>
            <dt className={styles.term}>Umlauf</dt>
            <dd className={styles.value}>{held.order.cycle + 1}</dd>
          </div>
        )}
      </dl>
      {held.release === 'ORDER' && (
        <ol className={styles.order} aria-label="Reihenfolge">
          {held.order.actorIds.map((id, index) => {
            const isCurrent = held.order.position === index && (held.status === 'ACTIVE' || held.status === 'HELD');
            return (
              <li key={id} className={`${styles.entry} ${isCurrent ? styles.current : ''}`}>{nameOf(id)}{isCurrent ? ' (am Zug)' : ''}</li>
            );
          })}
        </ol>
      )}
      {offered && (
        <div className={styles.actions}>
          <Button type="button" variant="primary" onClick={advance} disabled={locked}>{locked ? 'Gesendet' : actionLabel}</Button>
        </div>
      )}
    </section>
  );
}
