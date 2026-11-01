// ============================================================
// N3 — OrderingForm: reusable private ordering answer (Midnight design)
//
// Responsibility: a list of PUBLIC items in the start order the caller supplies → the player moves
// items up/down → ONE complete order → onSubmit(order, attemptId). It owns no command queue, socket
// or session. The embedding caller sends the command (existing intent client; the server command id is
// a different thing than the UI attempt id) and reports back through `feedback`. Success appears only
// after the caller confirms (SUBMITTED). Moving sends nothing and is never an implicit submission.
//
// Operation: every item has an "up" and a "down" button (type=button, 44 px, keyboard and touch alike).
// There is no wrap-around: at the first/last position the button stays focusable (aria-disabled), does
// nothing and says so. Focus stays on the button just used (it is restored after the list is re-ordered).
// Drag and drop is deliberately NOT part of this foundation.
//
// Attempt contract (N1-R1, mandatory echo): every valid submit opens ONE attempt in the current
// context; `onSubmit` hands out its id. From that moment the form is locked against another submit,
// also before a late PENDING, until feedback for THIS attempt arrives. `attemptId` is a REQUIRED
// property of the feedback: a string echoes the attempt; null means "not an answer to an attempt"
// (a restored state after reload, or the round lock). Feedback is applicable only if
//   - its contextKey is the current one, and
//   - it is the round lock (LOCKED) with a null/missing or the current echo, or it echoes the current
//     attempt, or no attempt is open yet.
// Inapplicable feedback (other round, older attempt, null/missing) changes nothing: not the draft, not
// the held state, not the lock. The form keeps the last applicable feedback; object identity and content
// equality are irrelevant, so a re-created identical object is never an answer, while an identical error
// echoing a NEW attempt is a real answer. A context change is the only reset.
//
// Confirmed order (N2-R2): the last server-CONFIRMED order (applicable SUBMITTED/LOCKED with a valid
// `order`) is kept apart from the status. Once confirmed/locked the form shows it instead of the local
// draft; a later LOCKED without `order` never deletes it; without any confirmed order a lock shows the
// local draft read-only.
//
// Identity: the draft is keyed by stable item ids and survives parent re-renders, new but equal props
// objects, label changes and a mere re-ordering of the SAME item ids in `config.items`. A CHANGED item set
// under the SAME contextKey is a contract violation: the list is not rendered (controlled message), nothing
// is merged into an old draft or accepted order, and nothing can be sent. The caller must change the
// contextKey together with the item set; that resets draft, attempt, status and confirmed order.
//
// No theme/accent dependency and no key-based remounting. The config is validated with the STRICT public
// schema: an object that carries anything beyond the public fields (e.g. a value, solution or reference by
// mistake) is not rendered, instead of being passed along.
// ============================================================

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@quiz/ui';
import {
  orderingItemSetKey, orderingValueFromIds, parseOrderingConfig, validateOrdering,
  type OrderingConfig, type OrderingValue,
} from '@quiz/shared/ordering';
import styles from './OrderingForm.module.css';

export interface OrderingFeedback {
  /** Must equal the form's current `contextKey`. */
  contextKey: string;
  /** REQUIRED. The id handed to `onSubmit` for this answer, or null for a state that answers no attempt. */
  attemptId: string | null;
  status: 'PENDING' | 'SUBMITTED' | 'LOCKED' | 'ERROR';
  /** Server-confirmed order (shown instead of the draft once SUBMITTED/LOCKED). Must be a valid permutation of the configured items. */
  order?: OrderingValue;
  /** ERROR: short, non-secret text. */
  message?: string;
  /** ERROR: true keeps the draft editable and offers a manual retry; false makes the form read-only. */
  retryable?: boolean;
}

export interface OrderingFormProps {
  title?: string;
  /** PUBLIC config only: ids, labels, help and the START order of `items`. It has no room for values or solutions. */
  config: OrderingConfig;
  /** Identity of the current run/round/item set. A change resets draft, held feedback, attempt and confirmed order. */
  contextKey: string;
  /** Called once per valid submit with the complete visible order. `attemptId` is `<contextKey>#<n>`; echo it in `feedback.attemptId`. */
  onSubmit: (order: OrderingValue, attemptId: string) => void;
  feedback?: OrderingFeedback | null;
  disabled?: boolean;
  submitLabel?: string;
}

const GENERIC_ERROR = 'Das hat nicht geklappt. Bitte versuche es erneut.';
const CHANGED_ERROR = 'Die Aufgabe hat sich geändert. Bitte lade die Seite neu.';

interface Attempt { id: string; answered: boolean }
/** `accepted`: the last server-CONFIRMED order. Kept apart from `held`, because a later status message without `order`
 *  (e.g. the round lock) replaces `held` but must not erase what the server accepted. `setKey` pins the item SET. */
interface Session { context: string; setKey: string; seq: number; held: OrderingFeedback | null; attempt: Attempt | null; accepted: OrderingValue | null }

/** Order inside ONE attempt: a later or equal stage may replace the held one, an earlier one never. */
function rank(fb: OrderingFeedback): number {
  if (fb.status === 'PENDING') return 0;
  if (fb.status === 'ERROR') return fb.retryable === false ? 2 : 1;
  if (fb.status === 'SUBMITTED') return 2;
  return 3; // LOCKED
}
const sameContent = (a: OrderingFeedback | null, b: OrderingFeedback): boolean =>
  a !== null && JSON.stringify([a.contextKey, a.attemptId, a.status, a.order ?? null, a.message ?? null, a.retryable ?? null])
    === JSON.stringify([b.contextKey, b.attemptId, b.status, b.order ?? null, b.message ?? null, b.retryable ?? null]);

export function OrderingForm(props: OrderingFormProps) {
  const parsed = parseOrderingConfig(props.config);
  if (!parsed.ok) return <p className={styles.cardError} role="alert">Die Aufgabe kann nicht angezeigt werden.</p>;
  return <OrderingFormInner {...props} config={parsed.config} />;
}

type FocusTarget = { kind: 'move'; itemId: string; direction: 'up' | 'down' } | { kind: 'status' };

function OrderingFormInner({ title, config, contextKey, onSubmit, feedback, disabled = false, submitLabel = 'Abgeben' }: OrderingFormProps) {
  const id = useId();
  const setKey = orderingItemSetKey(config);
  const startIds = config.items.map(i => i.itemId);
  const [draft, setDraft] = useState<readonly string[]>(startIds);
  const [localError, setLocalError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [session, setSession] = useState<Session>({ context: contextKey, setKey, seq: 0, held: null, attempt: null, accepted: null });
  const buttons = useRef(new Map<string, { up: HTMLButtonElement | null; down: HTMLButtonElement | null }>());
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const pendingFocus = useRef<FocusTarget | null>(null);

  // Derived while rendering (no effect, no extra frame): context reset, then absorption of applicable feedback.
  let current = session;
  if (current.context !== contextKey) {
    current = { context: contextKey, setKey, seq: current.seq, held: null, attempt: null, accepted: null }; // the only reset, incl. the confirmed order
    setDraft(startIds);
    setLocalError(null);
    setAnnouncement('');
  }
  // A changed item SET under the same context is never merged into the old draft/attempt/confirmation (see header).
  const setChanged = current.setKey !== setKey;
  if (feedback && feedback.contextKey === contextKey && !setChanged) {
    const held = current.held, attempt = current.attempt;
    const isLock = feedback.status === 'LOCKED';
    const echo = feedback.attemptId ?? null; // a missing property counts like null: never an echo of an attempt
    // The attempt echo is enforced in EVERY state, also while LOCKED is already held: an explicitly older attempt of this
    // round is never applicable. The real round lock (echo null / missing) is. LOCKED is final: nothing but LOCKED follows it.
    const echoOk = echo === null || attempt === null || echo === attempt.id;
    const applicable = isLock ? echoOk : held?.status !== 'LOCKED' && (attempt === null || echo === attempt.id);
    const sameAttempt = held !== null && held.attemptId !== null && held.attemptId === feedback.attemptId;
    const ordered = !sameAttempt || rank(feedback) >= rank(held as OrderingFeedback);
    if (applicable && ordered && !sameContent(held, feedback)) {
      current = { ...current, held: feedback, attempt: attempt && !attempt.answered ? { ...attempt, answered: true } : attempt };
    } else if (applicable && ordered && attempt && !attempt.answered) {
      current = { ...current, attempt: { ...attempt, answered: true } }; // identical content, but it does answer this attempt
    }
    // Only applicable feedback may set or change the confirmed order, and only a valid permutation of THIS item set; a status
    // message without `order` never deletes it.
    if (applicable && ordered && feedback.order && (feedback.status === 'SUBMITTED' || feedback.status === 'LOCKED')) {
      const valid = validateOrdering(config, feedback.order);
      if (valid.ok && JSON.stringify(current.accepted) !== JSON.stringify(valid.order)) current = { ...current, accepted: valid.order };
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

  const labels = new Map(config.items.map(i => [i.itemId, i] as const));
  const shownIds: readonly string[] = (confirmed || locked) && current.accepted ? current.accepted.itemIds : draft; // no confirmed order yet: the local draft, read-only
  const visible = shownIds.every(itemId => labels.has(itemId)) && shownIds.length === config.items.length ? shownIds : startIds;

  // Focus management after a re-order or a submit: the node of a moved item is re-inserted by the browser and
  // would lose focus; restore it on the button just used (or on the status line once the form froze).
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null; // always consumed: a wish that finds no target is dropped, never kept to steal the focus later
    if (target.kind === 'status') { statusRef.current?.focus(); return; }
    buttons.current.get(target.itemId)?.[target.direction]?.focus();
  });
  // The status line (which got the focus at submit) disappears with a retryable error: do not strand the keyboard on `body`.
  // Only if the focus really was lost; a user who moved on elsewhere keeps it there.
  const submitRef = useRef<HTMLButtonElement | null>(null);

  function move(index: number, direction: 'up' | 'down') {
    if (unavailable) return;
    const target = direction === 'up' ? index - 1 : index + 1;
    const itemId = visible[index];
    const label = labels.get(itemId)?.label ?? '';
    pendingFocus.current = { kind: 'move', itemId, direction };
    if (target < 0 || target >= visible.length) {
      setAnnouncement(`${label} steht bereits auf Position ${index + 1} von ${visible.length}.`);
      return; // no wrap-around
    }
    const next = [...visible];
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
    setLocalError(null);
    setAnnouncement(`${label} steht jetzt auf Position ${target + 1} von ${visible.length}.`);
  }

  function submitOrder() {
    if (unavailable) return;
    const built = orderingValueFromIds(visible);
    const result = validateOrdering(config, built);
    if (!result.ok) { setLocalError(CHANGED_ERROR); return; }
    setLocalError(null);
    const attempt: Attempt = { id: `${contextKey}#${current.seq + 1}`, answered: false };
    setSession({ ...current, seq: current.seq + 1, attempt });
    pendingFocus.current = { kind: 'status' };
    onSubmit(result.order, attempt.id);
  }

  const errorText = setChanged ? CHANGED_ERROR : localError ?? (failed ? active?.message ?? GENERIC_ERROR : null);
  const statusText = pending ? 'Wird gesendet …' : confirmed ? 'Abgegeben.' : locked ? 'Die Eingabe ist gesperrt.' : null;
  const titleId = `${id}-title`, hintId = `${id}-hint`;

  return (
    <form className={styles.card} onSubmit={(event: FormEvent) => { event.preventDefault(); submitOrder(); }} noValidate
      aria-labelledby={title ? titleId : undefined} aria-busy={pending || undefined}>
      {title && <h3 id={titleId} className={styles.title}>{title}</h3>}
      {config.prompt && <p className={styles.prompt}>{config.prompt}</p>}
      {config.directionHint && <p className={styles.hint}>{config.directionHint}</p>}
      {!setChanged && (
        <ol className={styles.list} aria-describedby={hintId}>
          {visible.map((itemId, index) => {
            const def = labels.get(itemId)!;
            const position = `Position ${index + 1} von ${visible.length}`;
            const refs = () => { let entry = buttons.current.get(itemId); if (!entry) { entry = { up: null, down: null }; buttons.current.set(itemId, entry); } return entry; };
            const button = (direction: 'up' | 'down') => {
              const atEdge = direction === 'up' ? index === 0 : index === visible.length - 1;
              return (
                <button
                  type="button"
                  className={styles.move}
                  ref={el => { refs()[direction] = el; }}
                  aria-label={`${def.label} nach ${direction === 'up' ? 'oben' : 'unten'}, ${position}`}
                  disabled={unavailable}
                  aria-disabled={!unavailable && atEdge ? true : undefined}
                  onClick={() => move(index, direction)}
                ><span aria-hidden="true">{direction === 'up' ? '▲' : '▼'}</span></button>
              );
            };
            return (
              <li key={itemId} className={styles.item} data-item-id={itemId} data-locked={frozen || undefined}>
                <span className={styles.position} aria-hidden="true">{index + 1}</span>
                <span className={styles.text}>
                  <span className={styles.label}>{def.label}</span>
                  {def.help && <span className={styles.help}>{def.help}</span>}
                </span>
                <span className={styles.moves}>{button('up')}{button('down')}</span>
              </li>
            );
          })}
        </ol>
      )}
      <p id={hintId} className={styles.hint}>Verschiebe die Einträge mit den Pfeilen. Erst mit „{submitLabel}“ wird die Reihenfolge gesendet.</p>
      <div className={styles.srOnly} aria-live="polite" aria-atomic="true" data-testid="ordering-live">{announcement}</div>
      {errorText && <p className={styles.cardError} role="alert">{errorText}</p>}
      {statusText && <p ref={statusRef} tabIndex={-1} className={confirmed ? styles.ok : styles.status} role="status">{statusText}</p>}
      <Button ref={submitRef} type="submit" size="lg" loading={pending} disabled={unavailable} className={styles.submit}>
        {failed && !fatal ? 'Erneut senden' : submitLabel}
      </Button>
    </form>
  );
}
