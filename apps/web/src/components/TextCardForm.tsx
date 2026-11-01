// ============================================================
// N2 — TextCardForm: reusable private answer card (Midnight design)
//
// Responsibility: free-text drafts per fieldId → ONE validated card → onSubmit(card, attemptId).
// It owns no command queue, socket or session. The embedding caller sends the command (existing
// intent client; the server command id is a different thing than the UI attempt id) and reports
// back through `feedback`. Success appears only after the caller confirms (SUBMITTED).
//
// Attempt contract (N1-R1, mandatory echo): every valid submit opens ONE attempt in the current
// context; `onSubmit` hands out its id. From that moment the card is locked against another submit,
// also before a late PENDING, until feedback for THIS attempt arrives. `attemptId` is a REQUIRED
// property of the feedback: a string echoes the attempt; null means "not an answer to an attempt"
// (a restored state after reload, or the round lock). Feedback is applicable only if
//   - its contextKey is the current one, and
//   - it is the round lock (LOCKED), or it echoes the current attempt, or no attempt is open yet.
// Inapplicable feedback (other round, older attempt, null/missing) changes nothing: not drafts, not
// the held state, not the lock. The card keeps the last applicable feedback; object identity and
// content equality are irrelevant, so a re-created identical object is never an answer, while an
// identical error echoing a NEW attempt is a real answer. A context change is the only reset.
//
// Enter contract: Enter in a field moves to the next field; in the last field it submits the card.
// Enter during IME composition is ignored. Single-line fields only (line breaks are not allowed).
// No theme/accent dependency, no key-based remounting.
// ============================================================

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@quiz/ui';
import {
  draftsToTextCard, validateTextCard, textCardAnswer,
  type TextCardConfig, type TextCardIssue, type TextCardIssueCode, type TextCardValue,
} from '@quiz/shared/textcard';
import styles from './TextCardForm.module.css';

export interface TextCardFeedback {
  /** Must equal the card's current `contextKey`. */
  contextKey: string;
  /** REQUIRED. The id handed to `onSubmit` for this answer, or null for a state that answers no attempt. */
  attemptId: string | null;
  status: 'PENDING' | 'SUBMITTED' | 'LOCKED' | 'ERROR';
  /** Server-confirmed card (shown instead of the drafts once SUBMITTED/LOCKED). */
  card?: TextCardValue;
  /** ERROR: short, non-secret text. */
  message?: string;
  /** ERROR: true keeps the drafts editable and offers a manual retry; false makes the card read-only. */
  retryable?: boolean;
  /** ERROR: safe per-field problems (configured fieldIds + issue codes only — never texts). */
  fieldErrors?: ReadonlyArray<{ fieldId: string; code: TextCardIssueCode }>;
}

export interface TextCardFormProps {
  title?: string;
  /** PUBLIC config only: labels, order, limits. It has no room for references or solutions. */
  config: TextCardConfig;
  /** Identity of the current run/round. A change resets drafts, held feedback and the current attempt. */
  contextKey: string;
  /** Called once per valid submit. `attemptId` is `<contextKey>#<n>`; echo it in `feedback.attemptId`. */
  onSubmit: (card: TextCardValue, attemptId: string) => void;
  feedback?: TextCardFeedback | null;
  disabled?: boolean;
  submitLabel?: string;
}

const GENERIC_ERROR = 'Das hat nicht geklappt. Bitte versuche es erneut.';
const MARKED_ERROR = 'Bitte prüfe die markierten Felder.';

/** Safe text per issue code; the limit is public config. */
export function textCardIssueMessage(code: TextCardIssueCode | string, config: TextCardConfig): string {
  switch (code) {
    case 'TEXT_REQUIRED': return 'Dieses Feld ist erforderlich.';
    case 'TEXT_BLANK': return 'Bitte Text eingeben.';
    case 'TEXT_TOO_LONG': return `Höchstens ${config.maxCodePointsPerField} Zeichen.`;
    case 'TEXT_INVALID_CHARACTERS': return 'Enthält nicht erlaubte Zeichen, z. B. einen Zeilenumbruch.';
    case 'TEXT_TOTAL_TOO_LONG': return `Alle Antworten zusammen dürfen höchstens ${config.maxTotalCodePoints} Zeichen lang sein.`;
    case 'TEXT_MISSING_FIELD': case 'TEXT_UNKNOWN_FIELD': case 'TEXT_DUPLICATE_FIELD': case 'TEXT_WRONG_TYPE': case 'TEXT_CARD_MALFORMED':
      return 'Die Karte passt nicht mehr zur aktuellen Runde. Bitte lade die Seite neu.';
    default: return GENERIC_ERROR;
  }
}

interface Attempt { id: string; answered: boolean }
interface Session { context: string; seq: number; held: TextCardFeedback | null; attempt: Attempt | null }

/** Order inside ONE attempt: a later or equal stage may replace the held one, an earlier one never. */
function rank(fb: TextCardFeedback): number {
  if (fb.status === 'PENDING') return 0;
  if (fb.status === 'ERROR') return fb.retryable === false ? 2 : 1;
  if (fb.status === 'SUBMITTED') return 2;
  return 3; // LOCKED
}
const sameContent = (a: TextCardFeedback | null, b: TextCardFeedback): boolean =>
  a !== null && JSON.stringify([a.contextKey, a.attemptId, a.status, a.card ?? null, a.message ?? null, a.retryable ?? null, a.fieldErrors ?? null])
    === JSON.stringify([b.contextKey, b.attemptId, b.status, b.card ?? null, b.message ?? null, b.retryable ?? null, b.fieldErrors ?? null]);

export function TextCardForm({ title, config, contextKey, onSubmit, feedback, disabled = false, submitLabel = 'Abgeben' }: TextCardFormProps) {
  const id = useId();
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [localIssues, setLocalIssues] = useState<readonly TextCardIssue[]>([]);
  const [session, setSession] = useState<Session>({ context: contextKey, seq: 0, held: null, attempt: null });
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const composing = useRef(false);

  // Derived while rendering (no effect, no extra frame): context reset, then absorption of applicable feedback.
  let current = session;
  if (current.context !== contextKey) {
    current = { context: contextKey, seq: current.seq, held: null, attempt: null };
    setDrafts(new Map());
    setLocalIssues([]);
  }
  if (feedback && feedback.contextKey === contextKey) {
    const held = current.held, attempt = current.attempt;
    const isLock = feedback.status === 'LOCKED';
    const applicable = held?.status === 'LOCKED' ? isLock
      : isLock ? feedback.attemptId === null || attempt === null || feedback.attemptId === attempt.id
      : attempt === null || feedback.attemptId === attempt.id;
    const sameAttempt = held !== null && held.attemptId !== null && held.attemptId === feedback.attemptId;
    const ordered = !sameAttempt || rank(feedback) >= rank(held as TextCardFeedback);
    if (applicable && ordered && !sameContent(held, feedback)) {
      current = { ...current, held: feedback, attempt: attempt && !attempt.answered ? { ...attempt, answered: true } : attempt };
    } else if (applicable && ordered && attempt && !attempt.answered) {
      current = { ...current, attempt: { ...attempt, answered: true } }; // identical content, but it does answer this attempt
    }
    // `applicable` already guarantees that feedback answers the CURRENT attempt (or is the round lock, or no attempt is open).
  }
  if (current !== session) setSession(current);

  const active = current.held;
  const awaiting = current.attempt !== null && !current.attempt.answered;
  const pending = awaiting || active?.status === 'PENDING';
  const confirmed = !awaiting && active?.status === 'SUBMITTED';
  const locked = !awaiting && active?.status === 'LOCKED';
  const failed = !awaiting && active?.status === 'ERROR';
  const fatal = failed && active?.retryable === false;
  const readOnly = pending || confirmed || locked || fatal;
  const unavailable = disabled || pending || confirmed || locked || fatal;

  const issues: readonly TextCardIssue[] = [...localIssues, ...(failed ? (active?.fieldErrors ?? []).map(e => ({ fieldId: e.fieldId, code: e.code })) : [])];
  const fieldIssue = (fieldId: string) => issues.find(i => i.fieldId === fieldId);
  const cardIssues = issues.filter(i => i.fieldId === null);
  const cardError = cardIssues.length > 0 ? cardIssues.map(i => textCardIssueMessage(i.code, config)).join(' ')
    : failed ? (active?.message ?? (issues.length > 0 ? MARKED_ERROR : GENERIC_ERROR)) : null;
  const statusText = pending ? 'Wird gesendet …' : confirmed ? 'Abgegeben.' : locked ? 'Die Eingabe ist gesperrt.' : null;

  const valueOf = (fieldId: string): string => {
    if ((confirmed || locked) && active?.card) return textCardAnswer(active.card, fieldId) ?? '';
    return drafts.get(fieldId) ?? '';
  };

  function submitCard() {
    if (unavailable) return;
    const built = draftsToTextCard(config, drafts);
    const result = validateTextCard(config, built);
    if (!result.ok) {
      setLocalIssues(result.issues);
      const first = config.fields.find(f => result.issues.some(i => i.fieldId === f.fieldId));
      if (first) inputs.current.get(first.fieldId)?.focus();
      return;
    }
    setLocalIssues([]);
    const attempt: Attempt = { id: `${contextKey}#${current.seq + 1}`, answered: false };
    setSession({ ...current, seq: current.seq + 1, attempt });
    onSubmit(result.card, attempt.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key !== 'Enter') return;
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; // IME commit, not a command
    event.preventDefault(); // never an implicit browser submission of the whole card
    const next = config.fields[index + 1];
    if (next) inputs.current.get(next.fieldId)?.focus();
    else submitCard();
  }

  const titleId = `${id}-title`;
  return (
    <form className={styles.card} onSubmit={(event: FormEvent) => { event.preventDefault(); submitCard(); }} noValidate
      aria-labelledby={title ? titleId : undefined} aria-busy={pending || undefined}>
      {title && <h3 id={titleId} className={styles.title}>{title}</h3>}
      {config.fields.map((def, index) => {
        const inputId = `${id}-${def.fieldId}`, helpId = `${inputId}-help`, errorId = `${inputId}-error`;
        const issue = fieldIssue(def.fieldId);
        return (
          <div key={def.fieldId} className={styles.field}>
            <label htmlFor={inputId} className={styles.label}>{def.label}{def.required ? <>{' '}<span className={styles.required}>(erforderlich)</span></> : null}</label>
            <input
              id={inputId}
              ref={el => { if (el) inputs.current.set(def.fieldId, el); else inputs.current.delete(def.fieldId); }}
              className={`${styles.input} ${issue ? styles.invalid : ''}`}
              type="text"
              enterKeyHint={index === config.fields.length - 1 ? 'send' : 'next'}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              value={valueOf(def.fieldId)}
              readOnly={readOnly}
              disabled={disabled}
              aria-invalid={issue ? true : undefined}
              aria-describedby={[def.help ? helpId : null, issue ? errorId : null].filter(Boolean).join(' ') || undefined}
              onChange={event => {
                const value = event.target.value;
                setDrafts(prev => new Map(prev).set(def.fieldId, value));
                setLocalIssues(prev => prev.filter(i => i.fieldId !== def.fieldId && i.fieldId !== null));
              }}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; }}
              onKeyDown={event => handleKeyDown(event, index)}
            />
            {def.help && <p id={helpId} className={styles.hint}>{def.help}</p>}
            {issue && <p id={errorId} className={styles.error}>{textCardIssueMessage(issue.code, config)}</p>}
          </div>
        );
      })}
      {cardError && <p className={styles.cardError} role="alert">{cardError}</p>}
      {statusText && <p className={confirmed ? styles.ok : styles.status} role="status">{statusText}</p>}
      <Button type="submit" size="lg" loading={pending} disabled={unavailable} className={styles.submit}>
        {failed && !fatal ? 'Erneut senden' : submitLabel}
      </Button>
    </form>
  );
}
