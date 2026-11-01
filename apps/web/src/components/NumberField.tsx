// ============================================================
// N1 — NumberField: reusable numeric answer field (Midnight design)
//
// Responsibility: text entry → canonical NumericValue → onSubmit. It does
// NOT own a command queue, socket or session. The embedding caller sends the
// command (existing intent client, same commandId across RATE_LIMITED retries)
// and reports back through `feedback`. Success is shown only after the caller
// reports SUBMITTED. Feedback for another `contextKey` (round/run) is ignored,
// so a late ACK never lands on a new draft. The field receives PUBLIC input
// metadata only — never targets, evaluation parameters or private bounds.
//
// No theme/accent dependency and no key-based remounting: theme changes keep
// draft, focus and identity. A caller that never reports feedback after
// onSubmit leaves the field waiting (it will not resend by itself).
// ============================================================

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@quiz/ui';
import {
  formatNumericCanonical, parseNumericInputPublic,
  type NumericPublicInput, type NumericValue,
} from '@quiz/shared/numeric';
import styles from './NumberField.module.css';

export interface NumberFieldFeedback {
  /** Must equal the field's current `contextKey`; otherwise the feedback is stale and ignored. */
  contextKey: string;
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
  /** Identity of the current run/round. A change resets the draft and drops older feedback. */
  contextKey: string;
  onSubmit: (value: NumericValue) => void;
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

export function NumberField({ label, input, contextKey, onSubmit, feedback, disabled = false, hint, submitLabel = 'Abgeben' }: NumberFieldProps) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [seenContext, setSeenContext] = useState(contextKey);
  const sent = useRef(false);

  // New run/round: start with an empty draft. Adjusting state while rendering avoids one frame of stale text.
  if (seenContext !== contextKey) {
    setSeenContext(contextKey);
    setDraft('');
    setLocalError(null);
  }

  const active = feedback && feedback.contextKey === contextKey ? feedback : null;
  useEffect(() => { sent.current = false; }, [feedback, contextKey]);

  const pending = active?.status === 'PENDING';
  const confirmed = active?.status === 'SUBMITTED';
  const locked = active?.status === 'LOCKED';
  const failed = active?.status === 'ERROR';
  const fatal = failed && active?.retryable === false;
  const readOnly = pending || confirmed || locked || fatal;
  const unavailable = disabled || locked || fatal || confirmed || pending;
  const shown = (confirmed || locked) && active?.value ? formatNumericCanonical(active.value, ',') : draft;

  function validate(text: string): string | null {
    const parsed = parseNumericInputPublic(input, text);
    return parsed.ok ? null : numericErrorMessage(parsed.code, input);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (unavailable || sent.current) return;
    const parsed = parseNumericInputPublic(input, draft);
    if (!parsed.ok) { setLocalError(numericErrorMessage(parsed.code, input)); return; }
    setLocalError(null);
    sent.current = true;
    onSubmit(parsed.value);
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
