// ============================================================
// N4 — VoteForm: reusable private, binding single-choice ballot (Midnight design)
//
// Responsibility: PUBLIC options (already released to this audience) + the voter's OWN list of choosable option ids
// → the voter selects ONE option or, where explicitly allowed, a deliberate abstention → ONE complete ballot →
// onSubmit(ballot, attemptId). It owns no command queue, socket or session. The embedding caller sends the command
// (existing intent client; the server command id is a different thing than the UI attempt id) and reports back
// through `feedback`. Success appears only after the caller confirms (SUBMITTED). Selecting sends nothing.
//
// Operation: a native radio group (fieldset + legend). Nothing is pre-selected. Arrow keys / Space / click change the
// selection only. ENTER on a radio does NOT submit (a vote is binding and must never be sent by accident); the one
// explicit "Stimme abgeben" button (click, or Enter/Space while it has focus) sends. An abstention is its own radio,
// visually apart, and only exists if `allowAbstain`. An empty selection is "not chosen yet": submitting it shows an
// error, moves the focus to the first choosable radio and sends nothing — it is never an abstention.
//
// Attempt contract (N1-R1, mandatory echo): every valid submit opens ONE attempt in the current context; `onSubmit`
// hands out its id. From that moment the form is locked against another submit, also before a late PENDING, until
// feedback for THIS attempt arrives. `attemptId` is a REQUIRED property of the feedback: a string echoes the attempt;
// null means "not an answer to an attempt" (a restored state after reload, or the poll lock). Feedback is applicable
// only if its contextKey is the current one, and it is the lock (LOCKED) with a null/missing or the current echo, or it
// echoes the current attempt, or no attempt is open yet. Inapplicable feedback changes nothing: not the draft, the held
// state, the confirmation or the lock — in EVERY state, also after LOCKED is held. A re-created identical object is
// never an answer; an identical error echoing a NEW attempt is. A context change is the only reset.
//
// Confirmed ballot (N2-R2): the last server-CONFIRMED ballot (applicable SUBMITTED/LOCKED with a valid `ballot`) is kept
// apart from the status — an OPTION and an ABSTAIN alike. Once confirmed/locked the form shows it instead of the local
// draft; a later LOCKED without `ballot` never deletes it; without any confirmed ballot a lock shows the local draft
// read-only and says that it is not confirmed as a cast vote.
//
// Identity: the draft is keyed by stable option ids and survives parent re-renders, new but equal props objects, label
// changes and a mere re-ordering of the SAME option ids. A CHANGED option set, choice list or abstention right under the
// SAME contextKey is a contract violation: nothing is rendered or sent and nothing is merged into an old draft or an
// accepted ballot. The caller must change the contextKey (see `votingContextKey`) together with the poll; that resets
// draft, attempt, status and confirmation — a second poll of the same round never inherits anything.
//
// The config is validated with the STRICT public schema: an object that carries anything beyond the public fields (an
// author, role, solution, voter list …) is not rendered. The component never receives the roster or other voters' lists.
// ============================================================

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@quiz/ui';
import {
  parseVotingOptionsConfig, validateVotingBallot, votingAbstainBallot, votingOptionBallot, votingOptionSetKey,
  type VotingBallot, type VotingOptionsConfig,
} from '@quiz/shared/voting';
import styles from './VoteForm.module.css';

export interface VoteFeedback {
  /** Must equal the form's current `contextKey`. */
  contextKey: string;
  /** REQUIRED. The id handed to `onSubmit` for this ballot, or null for a state that answers no attempt. */
  attemptId: string | null;
  status: 'PENDING' | 'SUBMITTED' | 'LOCKED' | 'ERROR';
  /** Server-confirmed ballot (shown instead of the draft once SUBMITTED/LOCKED). Must be valid for THIS voter and option set. */
  ballot?: VotingBallot;
  /** ERROR: short, non-secret text. */
  message?: string;
  /** ERROR: true keeps the selection and offers a manual retry; false makes the form read-only. */
  retryable?: boolean;
}

export interface VoteFormProps {
  title?: string;
  /** PUBLIC options only (ids, labels, help, the fixed presentation order). No author, role or solution fits in here. */
  config: VotingOptionsConfig;
  /** The voter's OWN list of choosable option ids (a subset of the options). Never the roster or anybody else's list. */
  selectableOptionIds: readonly string[];
  /** Whether THIS voter may abstain explicitly. There is no default: the caller decides. */
  allowAbstain: boolean;
  /** Identity of the current run/round/poll/option set. A change resets selection, held feedback, attempt and confirmation. */
  contextKey: string;
  /** Called once per valid submit with the complete ballot. `attemptId` is `<contextKey>#<n>`; echo it in `feedback.attemptId`. */
  onSubmit: (ballot: VotingBallot, attemptId: string) => void;
  feedback?: VoteFeedback | null;
  disabled?: boolean;
  submitLabel?: string;
}

const GENERIC_ERROR = 'Das hat nicht geklappt. Bitte versuche es erneut.';
const CHANGED_ERROR = 'Die Abstimmung hat sich geändert. Bitte lade die Seite neu.';
const NO_CHOICE_ERROR = 'Bitte wähle eine Option oder enthalte dich bewusst, bevor du abgibst.';

interface Attempt { id: string; answered: boolean }
/** `accepted`: the last server-CONFIRMED ballot. Kept apart from `held`, because a later status message without `ballot`
 *  (e.g. the lock) replaces `held` but must not erase what the server accepted. `setKey` pins options, choice list and right. */
interface Session { context: string; setKey: string; seq: number; held: VoteFeedback | null; attempt: Attempt | null; accepted: VotingBallot | null }
type Choice = { kind: 'OPTION'; optionId: string } | { kind: 'ABSTAIN' } | null;

/** Order inside ONE attempt: a later or equal stage may replace the held one, an earlier one never. */
function rank(fb: VoteFeedback): number {
  if (fb.status === 'PENDING') return 0;
  if (fb.status === 'ERROR') return fb.retryable === false ? 2 : 1;
  if (fb.status === 'SUBMITTED') return 2;
  return 3; // LOCKED
}
const sameContent = (a: VoteFeedback | null, b: VoteFeedback): boolean =>
  a !== null && JSON.stringify([a.contextKey, a.attemptId, a.status, a.ballot ?? null, a.message ?? null, a.retryable ?? null])
    === JSON.stringify([b.contextKey, b.attemptId, b.status, b.ballot ?? null, b.message ?? null, b.retryable ?? null]);

export function VoteForm(props: VoteFormProps) {
  const parsed = parseVotingOptionsConfig(props.config);
  const selectable: unknown = props.selectableOptionIds;
  const consistent = parsed.ok && Array.isArray(selectable) && typeof props.allowAbstain === 'boolean'
    && selectable.every(id => typeof id === 'string' && parsed.config.options.some(o => o.optionId === id))
    && new Set(selectable as string[]).size === selectable.length;
  if (!parsed.ok || !consistent) return <p className={styles.cardError} role="alert">Die Abstimmung kann nicht angezeigt werden.</p>;
  if ((selectable as string[]).length === 0 && !props.allowAbstain) return <p className={styles.status} role="status">Für dich ist in dieser Abstimmung keine Auswahl möglich.</p>;
  return <VoteFormInner {...props} config={parsed.config} />;
}

type FocusTarget = 'status' | 'choice';

function VoteFormInner({ title, config, selectableOptionIds, allowAbstain, contextKey, onSubmit, feedback, disabled = false, submitLabel = 'Stimme abgeben' }: VoteFormProps) {
  const id = useId();
  const choosable = new Set(selectableOptionIds);
  const setKey = JSON.stringify([votingOptionSetKey(config), [...selectableOptionIds].sort(), allowAbstain]);
  const voter = { allowedOptionIds: [...selectableOptionIds], allowAbstain };
  const [choice, setChoice] = useState<Choice>(null); // nothing is pre-selected
  const [localError, setLocalError] = useState<string | null>(null);
  const [session, setSession] = useState<Session>({ context: contextKey, setKey, seq: 0, held: null, attempt: null, accepted: null });
  const radios = useRef(new Map<string, HTMLInputElement | null>());
  const abstainRef = useRef<HTMLInputElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const submitRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);

  // Derived while rendering (no effect, no extra frame): context reset, then absorption of applicable feedback.
  let current = session;
  if (current.context !== contextKey) {
    current = { context: contextKey, setKey, seq: current.seq, held: null, attempt: null, accepted: null }; // the only reset, incl. the confirmed ballot
    setChoice(null);
    setLocalError(null);
  }
  // A changed option set / choice list / abstention right under the same context is never merged (see header).
  const setChanged = current.setKey !== setKey;
  if (feedback && feedback.contextKey === contextKey && !setChanged) {
    const held = current.held, attempt = current.attempt;
    const isLock = feedback.status === 'LOCKED';
    const echo = feedback.attemptId ?? null; // a missing property counts like null: never an echo of an attempt
    // The echo is enforced in EVERY state, also while LOCKED is already held: an explicitly older attempt is never
    // applicable. The real lock (echo null / missing) is. LOCKED is final: nothing but LOCKED follows it.
    const echoOk = echo === null || attempt === null || echo === attempt.id;
    const applicable = isLock ? echoOk : held?.status !== 'LOCKED' && (attempt === null || echo === attempt.id);
    const sameAttempt = held !== null && held.attemptId !== null && held.attemptId === feedback.attemptId;
    const ordered = !sameAttempt || rank(feedback) >= rank(held as VoteFeedback);
    if (applicable && ordered && !sameContent(held, feedback)) {
      current = { ...current, held: feedback, attempt: attempt && !attempt.answered ? { ...attempt, answered: true } : attempt };
    } else if (applicable && ordered && attempt && !attempt.answered) {
      current = { ...current, attempt: { ...attempt, answered: true } }; // identical content, but it does answer this attempt
    }
    // Only applicable feedback may set or change the confirmed ballot, and only one that is valid for THIS voter and
    // option set (an abstention only where allowed); a status message without `ballot` never deletes it.
    if (applicable && ordered && feedback.ballot && (feedback.status === 'SUBMITTED' || feedback.status === 'LOCKED')) {
      const valid = validateVotingBallot(config, voter, feedback.ballot);
      if (valid.ok && JSON.stringify(current.accepted) !== JSON.stringify(valid.ballot)) current = { ...current, accepted: valid.ballot };
    }
  }
  if (current !== session) setSession(current);

  const active = current.held;
  const awaiting = current.attempt !== null && !current.attempt.answered;
  const pending = awaiting || active?.status === 'PENDING';
  const confirmed = !awaiting && active?.status === 'SUBMITTED';
  const locked = !awaiting && active?.status === 'LOCKED';
  const failed = !awaiting && active?.status === 'ERROR';
  const fatal = failed && active?.retryable === false;
  const frozen = pending || confirmed || locked || fatal;
  const unavailable = disabled || frozen || setChanged;
  const retryable = failed && !fatal;
  useEffect(() => {
    if (retryable && !disabled && (document.activeElement === document.body || document.activeElement === null)) submitRef.current?.focus();
  }, [retryable, disabled]);

  // What the group shows: the confirmed ballot once confirmed/locked, otherwise the local selection (read-only when locked).
  const shown: Choice = (confirmed || locked) && current.accepted
    ? (current.accepted.kind === 'ABSTAIN' ? { kind: 'ABSTAIN' } : { kind: 'OPTION', optionId: current.accepted.optionId })
    : choice;
  const confirmedBallot = (confirmed || locked) && current.accepted !== null;

  // Focus management: after a valid submit the status line takes the focus (a disabled control must not hold it); after an
  // empty submit the first choosable radio does.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null; // always consumed: a wish that finds no target is dropped, never kept to steal the focus later
    if (target === 'status') { statusRef.current?.focus(); return; }
    const first = config.options.find(o => choosable.has(o.optionId));
    (first ? radios.current.get(first.optionId) : abstainRef.current)?.focus();
  });

  function select(next: Choice) {
    if (unavailable) return;
    setChoice(next);
    setLocalError(null); // changing the selection sends nothing
  }

  function submitBallot() {
    if (unavailable) return;
    if (choice === null) { setLocalError(NO_CHOICE_ERROR); pendingFocus.current = 'choice'; return; } // never an implicit abstention
    const built = choice.kind === 'ABSTAIN' ? votingAbstainBallot() : votingOptionBallot(choice.optionId);
    const result = validateVotingBallot(config, voter, built);
    if (!result.ok) { setLocalError(CHANGED_ERROR); return; }
    setLocalError(null);
    const attempt: Attempt = { id: `${contextKey}#${current.seq + 1}`, answered: false };
    setSession({ ...current, seq: current.seq + 1, attempt });
    pendingFocus.current = 'status';
    onSubmit(result.ballot, attempt.id);
  }

  // Enter on a radio must not send the (binding) vote. The explicit button is the one confirmation.
  function onGroupKeyDown(event: KeyboardEvent<HTMLFieldSetElement>) {
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') event.preventDefault();
  }

  const errorText = setChanged ? CHANGED_ERROR : localError ?? (failed ? active?.message ?? GENERIC_ERROR : null);
  const statusText = pending ? 'Wird gesendet …'
    : confirmed ? (current.accepted?.kind === 'ABSTAIN' ? 'Enthaltung abgegeben.' : 'Stimme abgegeben.')
    : locked ? (confirmedBallot ? 'Die Abstimmung ist geschlossen.' : 'Die Abstimmung ist geschlossen. Diese Auswahl ist nicht als abgegebene Stimme bestätigt.')
    : null;
  const titleId = `${id}-title`, hintId = `${id}-hint`, name = `${id}-vote`;
  const total = config.options.length;

  return (
    <form className={styles.card} onSubmit={(event: FormEvent) => { event.preventDefault(); submitBallot(); }} noValidate
      aria-labelledby={title ? titleId : undefined} aria-busy={pending || undefined}>
      {title && <h3 id={titleId} className={styles.title}>{title}</h3>}
      {!setChanged && (
        <fieldset className={styles.group} aria-describedby={hintId} onKeyDown={onGroupKeyDown}>
          <legend className={styles.legend}>{config.prompt ?? 'Deine Stimme'}</legend>
          {config.options.map((def, index) => {
            const allowed = choosable.has(def.optionId);
            const checked = shown?.kind === 'OPTION' && shown.optionId === def.optionId;
            return (
              <label key={def.optionId} className={styles.option} data-checked={checked || undefined} data-unavailable={!allowed || undefined}
                data-option-id={def.optionId} data-locked={frozen || undefined}>
                <input
                  type="radio"
                  className={styles.radio}
                  name={name}
                  value={def.optionId}
                  ref={el => { radios.current.set(def.optionId, el); }}
                  checked={checked}
                  disabled={unavailable || !allowed}
                  onChange={() => select({ kind: 'OPTION', optionId: def.optionId })}
                />
                <span className={styles.text}>
                  <span className={styles.label}>{def.label}<span className={styles.srOnly}>, Option {index + 1} von {total}</span></span>
                  {def.help && <span className={styles.help}>{def.help}</span>}
                  {!allowed && <span className={styles.help}>Diese Option kannst du nicht wählen.</span>}
                </span>
              </label>
            );
          })}
          {allowAbstain && (
            <>
              <hr className={styles.separator} />
              <label className={styles.option} data-checked={shown?.kind === 'ABSTAIN' || undefined} data-abstain="true" data-locked={frozen || undefined}>
                <input
                  type="radio"
                  className={styles.radio}
                  name={name}
                  value=""
                  ref={abstainRef}
                  checked={shown?.kind === 'ABSTAIN'}
                  disabled={unavailable}
                  onChange={() => select({ kind: 'ABSTAIN' })}
                />
                <span className={styles.text}>
                  <span className={styles.label}>Enthalten</span>
                  <span className={styles.help}>Du gibst bewusst für keine Option eine Stimme ab.</span>
                </span>
              </label>
            </>
          )}
        </fieldset>
      )}
      <p id={hintId} className={styles.hint}>Deine Stimme ist verbindlich und kann nicht geändert werden. Erst mit „{submitLabel}“ wird sie gesendet.</p>
      {errorText && <p className={styles.cardError} role="alert">{errorText}</p>}
      {statusText && <p ref={statusRef} tabIndex={-1} className={confirmed ? styles.ok : styles.status} role="status">{statusText}</p>}
      <Button ref={submitRef} type="submit" size="lg" loading={pending} disabled={unavailable} className={styles.submit}>
        {failed && !fatal ? 'Erneut senden' : submitLabel}
      </Button>
    </form>
  );
}
