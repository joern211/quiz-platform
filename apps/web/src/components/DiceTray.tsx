// ============================================================
// N9 — DiceTray: reusable display of ONE dice process (Midnight design), with optional application callbacks for rolling and holding
//
// Responsibility: show the dice values by POSITION, the hold assignment, the number of rolls used and the holder, from a client-safe projection.
// It owns no socket, session, command, timer or dice state machine, draws nothing and never mutates anything: `onRoll` / `onHold` are APPLICATION
// callbacks, called with the intent of the binding that is currently shown. The server decides on its own; `you.canRoll` / `you.canHold` in the
// projection are display aids only. There is no game page, route or protocol here.
//
// Binding BEFORE rendering: the projection is validated with the strict client schema and compared with the expected context (run, sequence, roster
// revision, unit, RECIPIENT) and the caller's INDEPENDENT `minStateVersion` while rendering. A foreign, stale, malformed or withdrawn projection
// never reaches the markup — not even for one frame. An effect that resets afterwards would be too late and is not used.
//
// Ordering: see diceIntake.ts. One number of version knowledge per ordering level is held apart from the displayed data; a late older packet — an
// older snapshot, an older turn (also the same player's), an older sequence version, an older dice version — never restores values or an action; a
// withdrawal keeps the knowledge.
//
// Sending (decided here, once): ONE intent per concrete BINDING (context + turn + sequence version + dice version + roll number), shared by the roll
// and the hold controls. A press sends and locks ALL controls of exactly THIS binding: a double click, a roll right after a hold click and a hold click
// right after a roll click on the same binding send nothing second. The lock is keyed by that binding, not by object identity: new props objects, an
// equal projection, a theme change and a re-render do not clear it. A NEW projection (another dice version, roll number, sequence version or turn) is
// another binding and its controls are free again — the lock of an old binding can neither unlock nor block the new one. A rejected promise from the
// callback unlocks exactly that binding (the application must reject on a refusal; it must NOT swap the commandId behind the user's back — that is the
// existing intent/receipt contract). Nothing here sends on mount, rejoin, theme change or a new props object.
//
// The lock is shown with `aria-disabled`, NOT with the `disabled` attribute: a focused button that becomes `disabled` loses keyboard focus (measured in
// Chromium: focus falls back to <body> after every applied hold), and a keyboard user would have to start over. Presses on a locked control do nothing — the
// guard above, not the attribute, is what blocks a second send.
//
// Hold: a click sends the COMPLETE target assignment (the shown assignment with that die flipped), never a toggle the server would have to guess.
//
// Presentation: values are shown only after a first roll (before it: text, no placeholder digits). Every die is a position with a visible caption
// ("Würfel 2"), its value and — when held — the text "Gehalten" and a heavier frame (never colour alone); with the right to hold the die is a real
// button with `aria-pressed`. The status line (`role="status"`) names the roll state once per projection; the animation is DECORATION: one CSS tumble of
// the dice of the last roll, started by a key of turn + roll number, with NO timer, NO animationend handler and no random digits in the DOM, so an old
// animation can neither overwrite a newer stand nor unlock anything. The shown faces are the values of the projection from the first frame. It is not
// played when the stand is first seen (mount, reload, rejoin) and is off under prefers-reduced-motion.
// ============================================================

import { useId, useRef, useState } from 'react';
import { Button } from '@quiz/ui';
import { diceActionBindingKey, diceContextKey, type DiceActionBinding, type DiceExpectedContext, type DiceHoldIntent, type DiceProjection, type DiceRollIntent } from '@quiz/shared/dice';
import { intakeDiceProjection, type DiceIntakeMemo } from '../dice/diceIntake';
import styles from './DiceTray.module.css';

export interface DiceTrayProps {
  /** The context THIS caller expects, from its own authenticated session and snapshot channel — never taken from the projection. */
  expected: DiceExpectedContext;
  /** The projection received for this recipient; null / undefined when there is none (withdrawn, missing, other role). */
  projection: DiceProjection | null | undefined;
  /** Neutral heading. Plain text. */
  label?: string;
  /** Display names by id (players and teams) from the caller's own data; an id without a name is shown as its id. */
  names?: Readonly<Record<string, string>>;
  /** Label of the roll action. */
  rollLabel?: string;
  /** Optional application callback for a roll. May return a promise; a rejection unlocks the same binding. */
  onRoll?: (intent: DiceRollIntent) => void | Promise<unknown>;
  /** Optional application callback for a hold change (the complete target assignment). May return a promise; a rejection unlocks the same binding. */
  onHold?: (intent: DiceHoldIntent) => void | Promise<unknown>;
}

const UNAVAILABLE = 'Die Würfel sind zurzeit nicht verfügbar.';

const sameMemo = (a: DiceIntakeMemo, b: DiceIntakeMemo): boolean => a.key === b.key && a.seenStateVersion === b.seenStateVersion && a.seenSequenceVersion === b.seenSequenceVersion
  && a.seenTurnNumber === b.seenTurnNumber && a.seenDiceId === b.seenDiceId && a.seenDiceVersion === b.seenDiceVersion && a.seenRollCount === b.seenRollCount
  && a.seenRelease === b.seenRelease && JSON.stringify(a.held) === JSON.stringify(b.held);

interface Anim { ctx: string; turn: number; roll: number; key: string | null }
/**
 * Derives the visual-only animation key from what was OBSERVED (pure; no clock, no callback). A new roll of a stand that was seen before animates; the
 * first observation of a context (mount, reload, rejoin) does not; a withdrawal changes nothing.
 */
function nextAnim(prev: Anim, ctx: string, held: DiceProjection | null): Anim {
  const base: Anim = prev.ctx === ctx ? prev : { ctx, turn: -1, roll: -1, key: null };
  if (held === null) return base;
  const advanced = held.turnNumber > base.turn || (held.turnNumber === base.turn && held.rollCount > base.roll);
  if (!advanced) return base;
  const animate = base.turn >= 0 && held.rollCount > 0;
  return { ctx, turn: held.turnNumber, roll: held.rollCount, key: animate ? `${held.turnNumber}:${held.rollCount}` : null };
}

export function DiceTray({ expected, projection, label = 'Würfel', names, rollLabel = 'Würfeln', onRoll, onHold }: DiceTrayProps) {
  const titleId = `${useId()}-title`;
  const key = diceContextKey(expected);

  // Derived while rendering: no effect, no frame with old content. `memo` holds the version knowledge and the shown data.
  const [memo, setMemo] = useState<DiceIntakeMemo>(() => intakeDiceProjection(null, expected, projection).memo);
  const step = intakeDiceProjection(memo, expected, projection);
  const held = step.held;
  if (!sameMemo(memo, step.memo)) setMemo(step.memo);

  const [anim, setAnim] = useState<Anim>(() => { const first = intakeDiceProjection(null, expected, projection).held; return { ctx: key, turn: first?.turnNumber ?? -1, roll: first?.rollCount ?? -1, key: null }; });
  const animNow = nextAnim(anim, key, held);
  if (animNow !== anim) setAnim(animNow);

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
  const binding: DiceActionBinding = { turnNumber: held.turnNumber, sequenceVersion: held.sequenceVersion, diceVersion: held.diceVersion, rollCount: held.rollCount };
  const lockKey = `${key}|${diceActionBindingKey(binding)}`;
  const locked = sent === lockKey;
  const you = held.you;
  const canRoll = onRoll !== undefined && you !== null && you.canRoll;
  const canHold = onHold !== undefined && you !== null && you.canHold;
  const { values, config } = held;

  const send = (run: () => void | Promise<unknown>) => {
    if (sentRef.current === lockKey) return; // one send per concrete binding, shared by roll and hold
    sentRef.current = lockKey;
    setSent(lockKey);
    const unlock = () => { if (sentRef.current === lockKey) sentRef.current = null; setSent(current => (current === lockKey ? null : current)); };
    try {
      const result = run();
      if (result !== undefined && result !== null && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(undefined, unlock);
    } catch (error) { unlock(); throw error; }
  };
  const roll = () => { if (onRoll !== undefined) send(() => onRoll({ ...binding })); };
  const toggle = (index: number) => {
    if (onHold === undefined) return;
    const target = held.held.flatMap((isHeld, position) => ((position === index ? !isHeld : isHeld) ? [position] : []));
    send(() => onHold({ ...binding, held: target }));
  };

  const faces = values === null ? '' : values.join(', ');
  const statusText = held.status === 'PREPARED' ? 'Noch nicht gewürfelt.'
    : held.status === 'IN_PROGRESS' ? `Wurf ${held.rollCount} von ${config.maxRolls}: ${faces}.`
      : held.status === 'EXHAUSTED' ? `Wurf ${held.rollCount} von ${config.maxRolls}, kein weiterer Wurf: ${faces}.`
        : values === null ? 'Beendet.' : `Beendet. Ergebnis: ${faces}.`;
  const allHeld = values !== null && held.status === 'IN_PROGRESS' && held.held.every(Boolean);
  const holder = held.holder;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.title}>{label}</h3>
      <p className={styles.status} role="status">{statusText}</p>
      {you !== null && you.holdsTurn && (you.canRoll || you.canHold) && <p className={styles.hint}>Du bist am Zug.</p>}
      {you !== null && you.holdsTurn && !you.canRoll && !you.canHold && <p className={styles.hint}>Im Moment ist keine Aktion möglich.</p>}
      {you !== null && !you.holdsTurn && you.teamHoldsTurn === true && <p className={styles.hint}>Dein Team ist am Zug. Du kannst beraten.</p>}
      {allHeld && <p className={styles.hint}>Alle Würfel sind gehalten. Gib mindestens einen frei, um zu würfeln.</p>}
      <dl className={styles.list}>
        <div className={styles.row}>
          <dt className={styles.term}>{holder.teamId === null ? 'Würfelt' : 'Team'}</dt>
          <dd className={styles.value}>{holder.teamId === null ? nameOf(holder.playerId) : nameOf(holder.teamId)}</dd>
        </div>
        {holder.teamId !== null && (
          <div className={styles.row}>
            <dt className={styles.term}>Zuständig</dt>
            <dd className={styles.value}>{nameOf(holder.playerId)}</dd>
          </div>
        )}
        <div className={styles.row}>
          <dt className={styles.term}>Würfe</dt>
          <dd className={styles.value}>{held.rollCount} von {config.maxRolls}</dd>
        </div>
      </dl>
      {values !== null && (
        <ul className={styles.dice} aria-label="Würfel">
          {values.map((value, index) => {
            const isHeld = held.held[index];
            const tumbles = animNow.key === `${held.turnNumber}:${held.rollCount}` && held.lastRolled.includes(index);
            const className = `${styles.die} ${isHeld ? styles.held : ''} ${tumbles ? styles.tumble : ''}`;
            const content = (
              <>
                <span className={styles.cap}>Würfel {index + 1}</span>
                <span className={styles.face}>{value}</span>
                <span className={styles.state}>{isHeld ? 'Gehalten' : canHold ? 'Frei' : ''}</span>
              </>
            );
            return (
              <li key={`${held.turnNumber}:${held.rollCount}:${index}`}>
                {canHold
                  ? <button type="button" className={className} aria-pressed={isHeld} aria-disabled={locked || undefined} data-tumble={tumbles ? 'true' : undefined} onClick={() => toggle(index)}>{content}</button>
                  : <div className={className} data-tumble={tumbles ? 'true' : undefined}>{content}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {canRoll && (
        <div className={styles.actions}>
          <Button type="button" variant="primary" className={locked ? styles.locked : undefined} aria-disabled={locked || undefined} onClick={roll}>{locked ? 'Gesendet' : rollLabel}</Button>
        </div>
      )}
    </section>
  );
}
