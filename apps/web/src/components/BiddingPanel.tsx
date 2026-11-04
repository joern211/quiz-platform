// ============================================================
// N10 — BiddingPanel: reusable display and input of ONE bidding (Midnight design), with optional application callbacks for a bid and a pass
//
// Responsibility: show the released standing of a bidding — or only the neutral message — from a client-safe projection, and offer the bid input and the pass only to the
// pinned bidder who is on turn. It owns no socket, session, command, timer or bidding state machine and never mutates anything: `onBid` / `onPass` are APPLICATION callbacks,
// called with the intent of the binding that is currently shown. The server decides on its own; `you.canBid` / `you.canPass` are display aids only. There is no game page,
// route or protocol here.
//
// Binding BEFORE rendering: the projection is validated with the strict client schema and compared with the expected context (run, round, bidding, sequence, roster and roles
// revision, RECIPIENT) and the caller's INDEPENDENT `minStateVersion` while rendering. A foreign, stale, malformed or withdrawn projection never reaches the markup — not even
// for one frame. An effect that resets afterwards would be too late and is not used.
//
// Ordering: see biddingIntake.ts. One number of version knowledge per ordering level is held apart from the displayed data; a late older packet never restores a bid, a
// standing or an action; a withdrawal keeps the knowledge.
//
// Information: the NEUTRAL packet (performers and every non-bidder player) is rendered as one sentence — "Dein Partner verhandelt gerade." — and nothing else: there is no
// category, bid, team or number in the received data to render. Only the STANDING packet (pinned bidders, viewers, displays, a non-blind host) shows category, teams and bids.
// Viewer / display packets carry no `you` and therefore never show controls.
//
// Sending (decided here, once): ONE intent per concrete BINDING (context + team + turn + sequence version + bidding version), shared by the bid and the pass controls. A press
// sends and locks ALL controls of exactly THIS binding: a double click, a pass right after a bid click and a bid right after a pass click on the same binding send nothing
// second. The lock is keyed by that binding, not by object identity: new props objects, equal feedback, a theme change and a re-render do not clear it. A NEW projection
// (another bidding version, sequence version or turn) is another binding and its controls are free again. A rejected promise from the callback, or `REJECTED` feedback for
// exactly this binding, unlocks exactly that binding (the application must NOT swap the commandId behind the user's back — that is the existing intent/receipt contract).
// Nothing here sends on mount, rejoin, theme change or a new props object. The lock is shown with `aria-disabled`, NOT `disabled`, so keyboard focus stays where it is.
//
// The bid field is the existing N1 NumberField: its public metadata carries the profile's scale/unit and as its minimum the smallest STRICTLY HIGHER value (display aid; the
// server compares again). Its attempt context is the binding key, so a new binding starts a clean attempt. Passing leaves THIS bidding for good: the text next to the button says so.
// ============================================================

import { useId, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { Button } from '@quiz/ui';
import { formatNumericCanonical, type NumericPublicInput, type NumericValue } from '@quiz/shared/numeric';
import {
  biddingActionBindingKey, biddingContextKey, biddingNextMinimum,
  type BiddingActionBinding, type BiddingBidIntent, type BiddingExpectedContext, type BiddingPassIntent, type BiddingProjection, type BiddingStandingProjection,
} from '@quiz/shared/bidding';
import { intakeBiddingProjection, type BiddingIntakeMemo } from '../bidding/biddingIntake';
import { applyFeedback, emptyAttemptStore, holdsLock, rejectAttempt, startAttempt, type AttemptStore } from '../bidding/sendAttempts';
import { NumberField, type NumberFieldFeedback } from './NumberField';
import styles from './BiddingPanel.module.css';

/** What the application reports back for the binding that was sent. `bindingKey` must be the key of the binding the intent was made for (`biddingActionBindingKey`). */
export interface BiddingFeedback {
  bindingKey: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  /** REJECTED: a short, non-secret text */
  message?: string;
  /** The attempt this report answers: the `attemptId` the callback was given. Without it the report applies to the CURRENT attempt of its binding; an older attempt's report is ignored when it names it. */
  attemptId?: string;
  /** Optional unique id of THIS report (e.g. a counter). Reports are applied at most once; two identical rejections stay distinguishable by `attemptId` or `id` — without either the content is the identity. */
  id?: string | number;
}
/** What a callback is told about THIS send: echo it as `attemptId` in the feedback. */
export interface BiddingSendAttempt { attemptId: string }

export interface BiddingPanelProps {
  /** The context THIS caller expects, from its own authenticated session and snapshot channel — never taken from the projection. */
  expected: BiddingExpectedContext;
  /** The projection received for this recipient; null / undefined when there is none (withdrawn, missing). */
  projection: BiddingProjection | null | undefined;
  /** Neutral heading. Plain text. */
  label?: string;
  /** Display names by id (teams and players) from the caller's own data; an id without a name is shown as its id. */
  names?: Readonly<Record<string, string>>;
  /** Optional application callback for a bid. May return a promise; its rejection releases THIS attempt (and its numeric input) once. */
  onBid?: (intent: BiddingBidIntent, attempt: BiddingSendAttempt) => void | Promise<unknown>;
  /** Optional application callback for a pass. May return a promise; its rejection releases THIS attempt once. */
  onPass?: (intent: BiddingPassIntent, attempt: BiddingSendAttempt) => void | Promise<unknown>;
  /** Optional feedback of the application; used only for the binding it names. */
  feedback?: BiddingFeedback | null;
}

const UNAVAILABLE = 'Das Bieten ist zurzeit nicht verfügbar.';
const display = (value: NumericValue, unit: NumericPublicInput['unit']): string => `${formatNumericCanonical(value, ',')}${unit ? ` ${unit.label}` : ''}`;

const GENERIC_REJECTION = 'Das hat nicht geklappt. Bitte versuche es erneut.';
const sameMemo = (a: BiddingIntakeMemo, b: BiddingIntakeMemo): boolean => a.key === b.key && a.seenStateVersion === b.seenStateVersion && a.seenBiddingVersion === b.seenBiddingVersion
  && a.seenSequenceVersion === b.seenSequenceVersion && a.seenTurnNumber === b.seenTurnNumber && a.seenRelease === b.seenRelease && JSON.stringify(a.held) === JSON.stringify(b.held);

export function BiddingPanel({ expected, projection, label = 'Bieten', names, onBid, onPass, feedback }: BiddingPanelProps) {
  const titleId = `${useId()}-title`;
  const key = biddingContextKey(expected);

  // Derived while rendering: no effect, no frame with old content. `memo` holds the version knowledge and the shown data.
  const [memo, setMemo] = useState<BiddingIntakeMemo>(() => intakeBiddingProjection(null, expected, projection).memo);
  const step = intakeBiddingProjection(memo, expected, projection);
  const held = step.held;
  if (!sameMemo(memo, step.memo)) setMemo(step.memo);

  // The attempt store lives in a REF (the truth at the moment of a press — two presses inside ONE task run with the closure of the SAME render) and is mirrored in state for rendering.
  const attemptsRef = useRef<AttemptStore>(emptyAttemptStore);
  const [attempts, setAttemptsState] = useState<AttemptStore>(emptyAttemptStore);
  const commit = (next: AttemptStore) => { if (next !== attemptsRef.current) { attemptsRef.current = next; setAttemptsState(next); } };
  // An application report is applied once and to its attempt only. A layout effect (synchronous in the commit, no visible frame) keeps the ref current before any later press.
  useLayoutEffect(() => { if (feedback) commit(applyFeedback(attemptsRef.current, feedback, key)); }, [feedback, key]); // eslint-disable-line react-hooks/exhaustive-deps -- commit only touches the ref and the state mirror

  if (held === null) {
    return (
      <section className={styles.card} aria-labelledby={titleId}>
        <h3 id={titleId} className={styles.title}>{label}</h3>
        <p className={styles.unavailable}>{UNAVAILABLE}</p>
      </section>
    );
  }

  if (held.release === 'NEUTRAL') {
    const text = held.phase === 'OPEN' ? (held.you?.performer ? 'Dein Partner verhandelt gerade.' : 'Das Bieten läuft.')
      : held.phase === 'PREPARED' ? 'Das Bieten beginnt gleich.' : 'Das Bieten ist beendet.';
    return (
      <section className={styles.card} aria-labelledby={titleId}>
        <h3 id={titleId} className={styles.title}>{label}</h3>
        <p className={styles.status} role="status">{text}</p>
      </section>
    );
  }

  return <StandingView
    key={`${key}|view`} held={held} contextKey={key} titleId={titleId} label={label} names={names} onBid={onBid} onPass={onPass}
    attempts={attempts} attemptsRef={attemptsRef} commit={commit}
  />;
}

interface StandingViewProps {
  held: BiddingStandingProjection; contextKey: string; titleId: string; label: string; names?: Readonly<Record<string, string>>;
  onBid?: BiddingPanelProps['onBid']; onPass?: BiddingPanelProps['onPass'];
  attempts: AttemptStore; attemptsRef: MutableRefObject<AttemptStore>; commit: (next: AttemptStore) => void;
}

function StandingView({ held, contextKey, titleId, label, names, onBid, onPass, attempts, attemptsRef, commit }: StandingViewProps) {
  const passHintId = `${useId()}-pass-hint`;
  const nameOf = (id: string): string => names?.[id] ?? id;
  const unit = held.numeric.unit;
  const you = held.you;
  const bidder = you !== null && you.teamId !== null ? you : null; // controls belong to a pinned bidder only
  // the ORIGIN of every intent is fixed HERE, from the projection that is shown (target, team AND counters): the counters alone are unique only inside one target, and the
  // application may deliver the intent after the context has changed. Copies, so that nothing downstream can alias the projection.
  const binding: BiddingActionBinding | null = bidder === null || bidder.teamId === null ? null : {
    scope: { runIndex: held.scope.runIndex, roundId: held.scope.roundId, biddingId: held.scope.biddingId, sequenceId: held.scope.sequenceId, rosterRevision: held.scope.rosterRevision, rolesRevision: held.scope.rolesRevision },
    teamId: bidder.teamId, turnNumber: held.turnNumber, sequenceVersion: held.sequenceVersion, biddingVersion: held.biddingVersion,
  };
  const bindingKey = binding === null ? null : biddingActionBindingKey(binding);
  const lockKey = binding === null ? null : `${contextKey}|${bindingKey}`;
  const current = bindingKey !== null && attempts.current !== null && attempts.current.contextKey === contextKey && attempts.current.bindingKey === bindingKey ? attempts.current : null;
  const locked = bindingKey !== null && holdsLock(attempts, contextKey, bindingKey);
  const canBid = onBid !== undefined && bidder !== null && bidder.canBid;
  const canPass = onPass !== undefined && bidder !== null && bidder.canPass;

  /** One press: decided on the CURRENT store (the ref), then the callback. A promise rejection releases THIS attempt only. */
  const send = (kind: 'BID' | 'PASS', fieldAttemptId: string | null, value: NumericValue | null, run: (attemptId: string) => void | Promise<unknown>) => {
    if (bindingKey === null) return;
    const started = startAttempt(attemptsRef.current, { contextKey, bindingKey, kind, fieldAttemptId, value });
    if (started === null) return; // an attempt of this binding is in flight (or settled as accepted): bid and pass share the lock
    commit(started.store);
    const attemptId = started.attempt.id;
    const release = () => commit(rejectAttempt(attemptsRef.current, attemptId, GENERIC_REJECTION));
    try {
      const result = run(attemptId);
      if (result !== undefined && result !== null && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(undefined, release);
    } catch (error) { release(); throw error; }
  };
  const submitBid = (value: NumericValue, fieldAttemptId: string) => {
    if (binding === null || onBid === undefined) return;
    send('BID', fieldAttemptId, value, attemptId => onBid({ ...binding, scope: { ...binding.scope }, value: { units: value.units, scale: value.scale } }, { attemptId }));
  };
  const submitPass = () => { if (binding !== null && onPass !== undefined) send('PASS', null, null, attemptId => onPass({ ...binding, scope: { ...binding.scope } }, { attemptId })); };

  const standing = held.standing;
  const next = biddingNextMinimum({ scale: held.numeric.scale, bounds: held.numeric.bounds }, standing === null ? null : standing.value);
  const max = held.numeric.bounds?.max ?? null;
  const canOutbid = next !== null && max !== null && next.units <= max.units;
  const inputMeta: NumericPublicInput | null = canOutbid && next !== null && max !== null ? { ...held.numeric, bounds: { min: next, max } } : null;

  const statusText = held.phase === 'PREPARED' ? 'Das Bieten beginnt gleich.'
    : held.phase === 'OPEN' ? (standing === null ? 'Noch kein Gebot.' : `Höchstgebot: ${display(standing.value, unit)} von ${nameOf(standing.teamId)}.`)
      : held.phase === 'CLOSED' ? (held.outcome === null ? 'Beendet.' : `Beendet. ${nameOf(held.outcome.winnerTeamId)} gewinnt mit ${display(held.outcome.winningValue, unit)}.`)
        : 'Das Bieten wurde abgebrochen. Es gibt kein Ergebnis.';
  const stalled = held.phase === 'OPEN' && held.onTurn === null; // nobody is up (the bidder on turn is out of play, or the sequence does not agree with the schedule): nobody can act
  const ownTeam = bidder === null ? null : held.teams.find(team => team.teamId === bidder.teamId) ?? null;
  const youText = bidder === null ? null
    : bidder.canBid && onBid !== undefined ? 'Du bist am Zug.'
      : bidder.holdsTurn ? 'Im Moment ist keine Aktion möglich.'
        : held.phase !== 'OPEN' || stalled ? null
          : ownTeam?.status === 'PASSED' ? 'Dein Team ist ausgestiegen.'
            : ownTeam?.leading ? 'Du führst. Warte auf die anderen Teams.' : 'Ein anderes Team ist am Zug.';

  // ONE attempt state feeds the numeric field: its attempt id is the NumberField's own, so a second rejection with identical text is a NEW report for it, and a pass or an old
  // attempt can never release or confirm the number input.
  const fieldFeedback: NumberFieldFeedback | null = current !== null && lockKey !== null && current.kind === 'BID' && current.fieldAttemptId !== null
    ? current.outcome === 'PENDING' ? { contextKey: lockKey, attemptId: current.fieldAttemptId, status: 'PENDING' }
      : current.outcome === 'ACCEPTED' ? { contextKey: lockKey, attemptId: current.fieldAttemptId, status: 'SUBMITTED', ...(current.value !== null ? { value: current.value } : {}) }
        : current.outcome === 'REJECTED' ? { contextKey: lockKey, attemptId: current.fieldAttemptId, status: 'ERROR', message: current.message ?? GENERIC_REJECTION, retryable: true }
          : null
    : null;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.title}>{label}</h3>
      {held.category !== null && <p className={styles.hint}>Kategorie: {held.category}</p>}
      <p className={styles.status} role="status">{statusText}</p>
      {youText !== null && <p className={styles.hint}>{youText}</p>}
      {stalled && <p className={styles.hint}>Im Moment kann niemand bieten.</p>}
      {held.onTurn !== null && !(bidder !== null && bidder.holdsTurn) && <p className={styles.muted}>Am Zug: {nameOf(held.onTurn.teamId)}</p>}
      <ul className={styles.teams} aria-label="Teams">
        {held.teams.map(team => (
          <li key={team.teamId} className={`${styles.team} ${team.leading ? styles.leading : ''} ${team.status === 'PASSED' ? styles.passed : ''}`}>
            <span className={styles.teamName}>{nameOf(team.teamId)}</span>
            <span className={styles.teamState}>{team.status === 'PASSED' ? 'ausgestiegen' : team.leading ? 'führt' : 'im Rennen'}</span>
          </li>
        ))}
      </ul>
      {(canBid || canPass) && lockKey !== null && (
        <div className={styles.actions}>
          {canBid && inputMeta !== null && (
            <NumberField
              label="Dein Gebot" input={inputMeta} contextKey={lockKey} onSubmit={submitBid} feedback={fieldFeedback} submitLabel="Bieten"
              disabled={locked && current?.kind === 'PASS'} hint={standing === null ? undefined : 'Es muss höher sein als das Höchstgebot.'}
            />
          )}
          {canBid && inputMeta === null && <p className={styles.hint}>Höher bieten ist nicht möglich.</p>}
          {canPass && (
            <div className={styles.passRow}>
              <Button type="button" variant="secondary" className={locked ? styles.locked : undefined} aria-disabled={locked || undefined} aria-describedby={passHintId} onClick={submitPass}>{locked ? 'Gesendet' : 'Passen'}</Button>
              <p id={passHintId} className={styles.muted}>Passen: Du steigst aus diesem Bieten aus und kannst nicht wieder einsteigen.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
