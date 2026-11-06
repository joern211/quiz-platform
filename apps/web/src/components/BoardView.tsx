// ============================================================
// N11 — BoardView: reusable display of ONE board with figures (Midnight design) and an optional application callback for a move
//
// Responsibility: show the fields, the figures on them, the holder, the roll of the current turn and the last move from a client-safe projection; and, for a
// view that is offered targets by the SERVER, let the user pick a figure and one of ITS offered targets and hand the intent to `onMove`. It owns no socket,
// session, command, timer or board state machine, computes no step count and no legal move, and NEVER shows a move as done: the projection is the only
// truth, a figure stands where the last projection says. `you.canMove` and `targets` are DISPLAY AIDS; the server decides on its own. No game page or route.
//
// Binding BEFORE rendering: the projection is validated with the strict client schema and compared with the expected context (run, sequence, roster
// revision, unit, board, RECIPIENT) and the caller's INDEPENDENT `minStateVersion` while rendering. A foreign, stale, malformed, empty (release NONE) or
// withdrawn projection never reaches the markup — not even for one frame. See boardIntake.ts for the ordering of packets.
//
// Sending (decided here, once): every press that is allowed to send creates an ATTEMPT with an identity of its own. The decision is made at the CURRENT ref
// state (never at the closure of a render): ONE attempt per concrete BINDING (context + turn + sequence version + board version + roll). A double click and
// two alternative targets of the same binding send nothing second. A NEW projection (another board version, roll or turn) is another binding and is free
// again. A rejected promise releases exactly THAT attempt — a late rejection of an older attempt (other binding, or an earlier attempt of this binding)
// neither releases nor blocks the running one; a late acceptance changes nothing but the (already shown) text. The application must reject on a refusal and
// must NOT swap the commandId behind the user's back (existing intent / receipt contract). Nothing sends on mount, rejoin, theme change or new props.
// The lock is shown with `aria-disabled`, not `disabled`, so a focused control keeps keyboard focus.
//
// Presentation: every figure and field is TEXT (never colour alone); the choice is two real button groups (figure, then target) with `aria-pressed`.
// ============================================================

import { useId, useRef, useState } from 'react';
import { boardActionBindingKey, boardContextKey, type BoardActionBinding, type BoardExpectedContext, type BoardMoveIntent, type BoardProjection } from '@quiz/shared/board';
import { intakeBoardProjection, type BoardIntakeMemo } from '../board/boardIntake';
import styles from './BoardView.module.css';

export interface BoardMoveAttempt { attemptId: string }
export interface BoardViewProps {
  /** The context THIS caller expects, from its own authenticated session and snapshot channel — never taken from the projection. */
  expected: BoardExpectedContext;
  /** The projection received for this recipient; null / undefined when there is none (withdrawn, missing, other role). */
  projection: BoardProjection | null | undefined;
  /** Neutral heading. Plain text. */
  label?: string;
  /** Display names by id (owners, players, teams) from the caller's own data; an id without a name is shown as its id. */
  names?: Readonly<Record<string, string>>;
  /** Optional application callback for a move. May return a promise; a rejection releases exactly the attempt it belongs to. */
  onMove?: (intent: BoardMoveIntent, attempt: BoardMoveAttempt) => void | Promise<unknown>;
}

const UNAVAILABLE = 'Das Brett ist zurzeit nicht verfügbar.';
const REJECTED = 'Der Zug wurde nicht angenommen. Du kannst es erneut versuchen.';

const sameMemo = (a: BoardIntakeMemo, b: BoardIntakeMemo): boolean => a.key === b.key && a.seenStateVersion === b.seenStateVersion && a.seenSequenceVersion === b.seenSequenceVersion
  && a.seenTurnNumber === b.seenTurnNumber && a.seenBoardVersion === b.seenBoardVersion && a.seenDiceId === b.seenDiceId && a.seenDiceVersion === b.seenDiceVersion
  && a.seenRollCount === b.seenRollCount && a.seenRelease === b.seenRelease && JSON.stringify(a.held) === JSON.stringify(b.held);

interface Attempt { id: number; lockKey: string }

export function BoardView({ expected, projection, label = 'Brett', names, onMove }: BoardViewProps) {
  const titleId = `${useId()}-title`;
  const contextKey = boardContextKey(expected);

  // Derived while rendering: no effect, no frame with old content. `memo` holds the version knowledge and the shown data.
  const [memo, setMemo] = useState<BoardIntakeMemo>(() => intakeBoardProjection(null, expected, projection).memo);
  const step = intakeBoardProjection(memo, expected, projection);
  const held = step.held;
  if (!sameMemo(memo, step.memo)) setMemo(step.memo);

  const attemptRef = useRef<{ seq: number; current: Attempt | null }>({ seq: 0, current: null });
  const [lockedKey, setLockedKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ lockKey: string; attemptId: number; text: string } | null>(null);
  const [choice, setChoice] = useState<{ lockKey: string; figureId: string } | null>(null);

  if (held === null || held.release === 'NONE') {
    return (
      <section className={styles.card} aria-labelledby={titleId}>
        <h3 id={titleId} className={styles.title}>{label}</h3>
        <p className={styles.unavailable}>{UNAVAILABLE}</p>
      </section>
    );
  }

  const nameOf = (id: string): string => names?.[id] ?? id;
  const { geometry, figures, roll, you, targets, holder, lastMove } = held;
  const startIds = new Map(geometry.routes.map(route => [route.route[0], route.ownerId] as const));
  const homeIds = new Map(geometry.routes.map(route => [route.route[route.route.length - 1], route.ownerId] as const));
  const ownerOf = new Map(figures.map(figure => [figure.id, figure.ownerId] as const));

  // the ORIGIN of every intent is fixed HERE, from the projection that is shown (target AND counters), as copies
  const binding: BoardActionBinding | null = roll === null ? null : {
    scope: { runIndex: held.scope.runIndex, sequenceId: held.scope.sequenceId, rosterRevision: held.scope.rosterRevision, unit: held.scope.unit }, boardId: held.boardId,
    turnNumber: held.turnNumber, sequenceVersion: held.sequenceVersion, boardVersion: held.boardVersion, diceId: roll.diceId, diceVersion: roll.diceVersion, rollCount: roll.rollCount,
  };
  const lockKey = binding === null ? null : `${contextKey}|${boardActionBindingKey(binding)}`;
  const locked = lockKey !== null && lockedKey === lockKey;
  const actionable = onMove !== undefined && binding !== null && lockKey !== null && you !== null && you.canMove && targets.length > 0;
  const figureIds = [...new Set(targets.map(target => target.figureId))];
  const selected = choice !== null && choice.lockKey === lockKey && figureIds.includes(choice.figureId) ? choice.figureId : null;
  const ownTargets = selected === null ? [] : targets.filter(target => target.figureId === selected);

  const send = (figureId: string, to: string) => {
    if (!actionable || binding === null || lockKey === null || onMove === undefined) return;
    const current = attemptRef.current.current;
    if (current !== null && current.lockKey === lockKey) return; // one attempt per concrete binding, decided on the REF — shared by every control
    const id = attemptRef.current.seq + 1;
    attemptRef.current = { seq: id, current: { id, lockKey } };
    setLockedKey(lockKey);
    setFeedback(null);
    const release = () => {
      if (attemptRef.current.current?.id !== id) return; // a late rejection of an older attempt releases nothing
      attemptRef.current = { ...attemptRef.current, current: null };
      setLockedKey(key => (key === lockKey ? null : key));
      setFeedback({ lockKey, attemptId: id, text: REJECTED });
    };
    try {
      const result = onMove({ ...binding, scope: { ...binding.scope }, figureId, to }, { attemptId: `a${id}` });
      if (result !== undefined && result !== null && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(undefined, release);
    } catch (error) { release(); throw error; }
  };

  const statusText = roll === null ? 'Im Moment gibt es keinen Wurf für einen Zug.'
    : roll.spent ? `Der Wurf (${roll.steps} Schritte) ist verbraucht.`
      : `Wurf: ${roll.steps} ${roll.steps === 1 ? 'Schritt' : 'Schritte'}.`;
  const fieldRole = (id: string): string => (startIds.has(id) ? `Start von ${nameOf(startIds.get(id) as string)}` : homeIds.has(id) ? `Ziel von ${nameOf(homeIds.get(id) as string)}` : '');
  const shownFeedback = feedback !== null && feedback.lockKey === lockKey ? feedback.text : null;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.title}>{label}</h3>
      <p className={styles.status} role="status">{statusText}</p>
      {you !== null && you.holdsTurn && you.canMove && <p className={styles.hint}>Du bist am Zug. Wähle eine Figur und ein Ziel.</p>}
      {you !== null && you.holdsTurn && !you.canMove && roll !== null && !roll.spent && <p className={styles.hint}>Du bist am Zug, aber mit diesem Wurf ist kein Zug möglich.</p>}
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
        {lastMove !== null && (
          <div className={styles.row}>
            <dt className={styles.term}>Letzter Zug</dt>
            <dd className={styles.value}>
              Figur {lastMove.figureId} ({nameOf(ownerOf.get(lastMove.figureId) ?? '')}) von {lastMove.from} nach {lastMove.to}
              {lastMove.captured.length > 0 ? `, schlägt ${lastMove.captured.join(', ')}` : ''}
            </dd>
          </div>
        )}
      </dl>
      <ul className={styles.fields} aria-label="Felder">
        {geometry.fields.map(field => {
          const here = figures.filter(figure => figure.at === field.id);
          const offered = ownTargets.find(target => target.to === field.id);
          return (
            <li key={field.id} className={`${styles.field} ${offered !== undefined ? styles.offered : ''}`}>
              <span className={styles.fieldName}>Feld {field.id}</span>
              {fieldRole(field.id) !== '' && <span className={styles.fieldRole}>{fieldRole(field.id)}</span>}
              {here.length === 0 ? <span className={styles.empty}>leer</span> : (
                <ul className={styles.figures} aria-label={`Figuren auf Feld ${field.id}`}>
                  {here.map(figure => <li key={figure.id} className={styles.figure}>Figur {figure.id} ({nameOf(figure.ownerId)}){selected === figure.id ? ', gewählt' : ''}</li>)}
                </ul>
              )}
              {offered !== undefined && <span className={styles.offeredText}>Mögliches Ziel</span>}
            </li>
          );
        })}
      </ul>
      {actionable && (
        <div className={styles.choice}>
          <div role="group" aria-label="Figur wählen" className={styles.group}>
            {figureIds.map(id => (
              <button key={id} type="button" className={`${styles.pick} ${selected === id ? styles.picked : ''}`} aria-pressed={selected === id} aria-disabled={locked || undefined}
                onClick={() => { if (!locked && lockKey !== null) setChoice({ lockKey, figureId: id }); }}>
                Figur {id} ({nameOf(ownerOf.get(id) ?? '')})
              </button>
            ))}
          </div>
          {selected !== null && (
            <div role="group" aria-label={`Ziel für Figur ${selected}`} className={styles.group}>
              {ownTargets.map(target => (
                <button key={target.to} type="button" className={styles.pick} aria-disabled={locked || undefined} onClick={() => send(target.figureId, target.to)}>
                  Nach Feld {target.to}{target.captures.length > 0 ? `, schlägt ${target.captures.join(', ')}` : ''}
                </button>
              ))}
            </div>
          )}
          {locked && <p className={styles.hint} role="status">Der Zug wird gesendet …</p>}
        </div>
      )}
      {shownFeedback !== null && <p className={styles.error} role="status">{shownFeedback}</p>}
    </section>
  );
}
