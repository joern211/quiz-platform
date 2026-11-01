// ============================================================
// N1 — NumberField: reusable numeric answer field (Midnight design)
//
// Responsibility: text entry → canonical NumericValue → onSubmit. It does
// NOT own a command queue, socket or session. The embedding caller sends the
// command (existing intent client, same commandId across RATE_LIMITED retries)
// and reports back through `feedback`. The field receives PUBLIC input
// metadata only — never targets, evaluation parameters or private bounds.
//
// Attempt contract (R1): every valid submit opens ONE attempt in the current
// context; `onSubmit(value, attemptId)` hands out its id. From that moment the
// field is locked against another submit until an applicable, DIFFERENT
// feedback for this attempt arrives — also if the caller reports PENDING late.
// Feedback is applicable only if its `contextKey` is the current one and, when it
// carries an `attemptId`, that id is the current attempt's. Inapplicable
// feedback (other round, older attempt) changes nothing: not the draft, not the
// held state, not the lock. The field keeps the last applicable feedback, so
// `feedback: null` or a stale object means "no new information", never "reset".
// The last server-confirmed value (applicable SUBMITTED/LOCKED with `value`) is held
// apart from the status: a LOCKED message without `value` keeps showing it.
// Content-identical feedback with a new object identity is not new information
// either (typical parent re-render). A retry that fails with the very same error
// is distinguished by echoing `attemptId`. A context change is the only reset.
//
// No theme/accent dependency and no key-based remounting: theme changes keep
// draft, focus and identity. A caller that never reports feedback after
// onSubmit leaves the field waiting (it will not resend by itself).
// ============================================================

import { useId, useState, type FormEvent } from 'react';
import { Button } from '@quiz/ui';
import {
  formatNumericCanonical, parseNumericInputPublic,
  type NumericPublicInput, type NumericValue,
} from '@quiz/shared/numeric';
import styles from './NumberField.module.css';

export interface NumberFieldFeedback {
  /** Must equal the field's current `contextKey`; otherwise the feedback is inapplicable and ignored. */
  contextKey: string;
  /** Optional echo of the id handed to `onSubmit`; makes identical consecutive answers distinguishable. */
  attemptId?: string;
  status: 'PENDING' | 'SUBMITTED' | 'LOCKED' | 'ERROR';
  /** Server-confirmed value (shown instead of the draft once SUBMITTED/LOCKED). */
  value?: NumericValue;
  /** ERROR: a short, non-secret text. Falls back to a generic message. */
  message?: string;
  /** ERROR: true keeps the draft editable and offers "Erneut senden"; false makes the field read-only. */
  retryable?: boolean;
}

export interface NumberFieldProps {
  label: string;
  input: NumericPublicInput;
  /** Identity of the current run/round. A change resets the draft, the held feedback and the current attempt. */
  contextKey: string;
  /** Called once per valid submit. `attemptId` identifies this attempt (`<contextKey>#<n>`); echo it in `feedback.attemptId`. */
  onSubmit: (value: NumericValue, attemptId: string) => void;
  feedback?: NumberFieldFeedback | null;
  disabled?: boolean;
  hint?: string;
  submitLabel?: string;
}

const GENERIC_ERROR = 'Das hat nicht geklappt. Bitte versuche es erneut.';
const MINUS = '−';
const display = (value: NumericValue) => formatNumericCanonical(value, ',').replace('-', MINUS);

/** Non-secret text per code; bounds appear only when they are part of the public metadata. */
export function numericErrorMessage(code: string, meta: NumericPublicInput): string {
  switch (code) {
    case 'NUMERIC_EMPTY': case 'NUMERIC_MISSING': return 'Bitte gib eine Zahl ein.';
    case 'NUMERIC_INCOMPLETE': return 'Die Zahl ist noch nicht vollständig.';
    case 'NUMERIC_TOO_PRECISE': return meta.scale === 0
      ? 'Bitte nur ganze Zahlen eingeben. Punkt und Komma sind Dezimalzeichen, keine Tausendertrennung.'
      : 'Bitte höchstens eine Nachkommastelle eingeben. Punkt und Komma sind Dezimalzeichen, keine Tausendertrennung.';
    case 'NUMERIC_TOO_LONG': case 'NUMERIC_TOO_LARGE': return 'Die Zahl ist zu groß oder zu lang.';
    case 'NUMERIC_OUT_OF_RANGE': return meta.bounds
      ? `Die Zahl muss zwischen ${display(meta.bounds.min)} und ${display(meta.bounds.max)} liegen.`
      : 'Die Zahl liegt außerhalb des erlaubten Bereichs.';
    case 'NUMERIC_INVALID_FORMAT': case 'NUMERIC_WRONG_TYPE':
      return 'Bitte nur Ziffern mit optionalem Minus und Komma oder Punkt eingeben, z. B. 12,5. Ohne Leerzeichen und Tausendertrennung.';
    default: return GENERIC_ERROR;
  }
}

interface Attempt { id: string; answered: boolean }
/** `confirmed`: the last server-CONFIRMED value (from applicable SUBMITTED/LOCKED feedback). Kept apart from `held`, because a later
 *  status message without `value` (e.g. the round lock) replaces `held` but must not erase what the server accepted. */
interface Session { context: string; seq: number; held: NumberFieldFeedback | null; attempt: Attempt | null; confirmed: NumericValue | null }
/** Content identity of a feedback (object identity is irrelevant). */
const signature = (fb: NumberFieldFeedback | null): string =>
  fb ? JSON.stringify([fb.contextKey, fb.attemptId ?? null, fb.status, fb.value ?? null, fb.message ?? null, fb.retryable ?? null]) : '';

export function NumberField({ label, input, contextKey, onSubmit, feedback, disabled = false, hint, submitLabel = 'Abgeben' }: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [session, setSession] = useState<Session>({ context: contextKey, seq: 0, held: null, attempt: null, confirmed: null });

  // Derived while rendering (no effect, no extra frame): context reset, then absorption of applicable feedback.
  let current = session;
  if (current.context !== contextKey) {
    current = { context: contextKey, seq: current.seq, held: null, attempt: null, confirmed: null }; // the only reset, incl. the confirmed value
    setDraft('');
    setLocalError(null);
  }
  const applicable = !!feedback && feedback.contextKey === contextKey
    && (feedback.attemptId === undefined || !current.attempt || feedback.attemptId === current.attempt.id);
  if (applicable && signature(feedback) !== signature(current.held)) {
    current = { ...current, held: feedback,
      attempt: current.attempt && !current.attempt.answered ? { ...current.attempt, answered: true } : current.attempt };
  }
  // Only applicable feedback may set or change the confirmed value; a status message without `value` never deletes it.
  if (applicable && feedback && (feedback.status === 'SUBMITTED' || feedback.status === 'LOCKED') && feedback.value
    && JSON.stringify(current.confirmed) !== JSON.stringify(feedback.value)) current = { ...current, confirmed: feedback.value };
  if (current !== session) setSession(current);

  const active = current.held;
  const awaiting = current.attempt !== null && !current.attempt.answered; // submitted, no answer for THIS attempt yet
  const pending = awaiting || active?.status === 'PENDING';
  const confirmed = !awaiting && active?.status === 'SUBMITTED';
  const locked = !awaiting && active?.status === 'LOCKED';
  const failed = !awaiting && active?.status === 'ERROR';
  const fatal = failed && active?.retryable === false;
  const readOnly = pending || confirmed || locked || fatal;
  const unavailable = disabled || pending || confirmed || locked || fatal;
  const shown = (confirmed || locked) && current.confirmed ? formatNumericCanonical(current.confirmed, ',') : draft; // no confirmed value yet: the local draft, read-only

  function validate(text: string): string | null {
    const parsed = parseNumericInputPublic(input, text);
    return parsed.ok ? null : numericErrorMessage(parsed.code, input);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (unavailable) return;
    const parsed = parseNumericInputPublic(input, draft);
    if (!parsed.ok) { setLocalError(numericErrorMessage(parsed.code, input)); return; }
    setLocalError(null);
    const attempt: Attempt = { id: `${contextKey}#${current.seq + 1}`, answered: false };
    setSession({ ...current, seq: current.seq + 1, attempt });
    onSubmit(parsed.value, attempt.id);
  }

  const errorText = localError ?? (failed ? active?.message ?? GENERIC_ERROR : null);
  const statusText = pending ? 'Wird gesendet …' : confirmed ? 'Abgegeben.' : locked ? 'Die Eingabe ist gesperrt.' : null;
  const unitId = input.unit ? `${id}-unit` : null, hintId = `${id}-hint`, errorId = `${id}-error`, statusId = `${id}-status`;
  const formatHint = input.scale === 0 ? 'Nur ganze Zahlen.' : 'Eine Nachkommastelle möglich. Komma oder Punkt als Dezimalzeichen.';
  const boundsHint = input.bounds ? ` Erlaubt: ${display(input.bounds.min)} bis ${display(input.bounds.max)}.` : '';
  const describedBy = [unitId, hintId, errorText ? errorId : null, statusText ? statusId : null].filter(Boolean).join(' ');
  const inputMode = input.allowNegative ? 'text' : input.scale === 0 ? 'numeric' : 'decimal';

  return (
    <form className={styles.field} onSubmit={handleSubmit} noValidate>
      <label htmlFor={id} className={styles.label}>{label}</label>
      <div className={styles.row}>
        <input
          id={id}
          className={`${styles.input} ${errorText ? styles.invalid : ''}`}
          type="text"
          inputMode={inputMode}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={shown}
          readOnly={readOnly}
          disabled={disabled}
          aria-invalid={errorText ? true : undefined}
          aria-describedby={describedBy}
          aria-errormessage={errorText ? errorId : undefined}
          onChange={event => { setDraft(event.target.value); setLocalError(null); }}
          onBlur={() => { if (!readOnly && draft.trim() !== '') setLocalError(validate(draft)); }}
        />
        {input.unit && <span id={unitId ?? undefined} className={styles.unit}>{input.unit.label}</span>}
        <Button type="submit" size="lg" loading={pending} disabled={unavailable} className={styles.submit}>
          {failed && !fatal ? 'Erneut senden' : submitLabel}
        </Button>
      </div>
      <p id={hintId} className={styles.hint}>
        {input.unit ? `Einheit: ${input.unit.label} · ` : ''}{formatHint}{boundsHint}{hint ? ` ${hint}` : ''}
      </p>
      {errorText && <p id={errorId} className={styles.error} role="alert">{errorText}</p>}
      {statusText && <p id={statusId} className={confirmed ? styles.ok : styles.status} role="status">{statusText}</p>}
    </form>
  );
}
