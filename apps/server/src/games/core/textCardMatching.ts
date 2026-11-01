// ============================================================
// N2 — Field matching adapter (thin, explicit, no new engine)
//
// Reuses `matchAnswer` unchanged for ONE configured single comparison per
// field. A match result is a PROPOSAL about similarity to a server-side
// reference — it is not a judgement, not validity and not points. The
// reference (expected word, synonyms) is server data and never leaves this
// function; only the mode and a public revision id are echoed so that the
// caller can pin them next to the result for deterministic repetition.
// ============================================================

import { CoreRuleError } from './runtimePrimitives.js';
import { matchAnswer, type MatchMode } from './roundFlow.js';

export type FieldMatchStatus = 'NO_ANSWER' | 'NOT_CHECKED' | 'MATCH' | 'NO_MATCH' | 'NEEDS_JUDGE';

export interface FieldMatchReference {
  expected: string;
  synonyms?: readonly string[];
  /** Public identifier of the reference content/revision (pinned by the caller; never the content itself). */
  revision: string;
}
export interface FieldMatchCheck { mode: MatchMode; reference: FieldMatchReference | null }
export interface FieldMatchResult { status: FieldMatchStatus; mode: MatchMode; referenceRevision: string | null }

const MAX_REFERENCE_UNITS = 400; // matches the 200 code point field limit (UTF-16 units <= 2 * code points)
const MAX_SYNONYMS = 50;
const MODES: readonly MatchMode[] = ['EXACT', 'NORMALIZED', 'SYNONYM', 'FUZZY', 'MANUAL_ONLY'];

/**
 * - `null` value → NO_ANSWER (an empty field is not a wrong answer and is never matched).
 * - MANUAL_ONLY → NEEDS_JUDGE, with or without reference.
 * - no reference (any other mode) → NOT_CHECKED: a free word is NOT automatically NO_MATCH or wrong.
 * - otherwise exactly the existing `matchAnswer` semantics: EXACT stays exact (no normalization), NORMALIZED is
 *   another mode, FUZZY can only yield NEEDS_JUDGE or NO_MATCH, never MATCH.
 */
export function matchTextField(value: string | null, check: FieldMatchCheck): FieldMatchResult {
  if (!MODES.includes(check.mode)) throw new CoreRuleError('INVALID_SETUP');
  const revision = check.reference?.revision ?? null;
  const done = (status: FieldMatchStatus): FieldMatchResult => ({ status, mode: check.mode, referenceRevision: revision });
  if (value === null) return done('NO_ANSWER');
  if (check.mode === 'MANUAL_ONLY') return done('NEEDS_JUDGE');
  const reference = check.reference;
  if (!reference) return done('NOT_CHECKED');
  const synonyms = reference.synonyms ?? [];
  if (!reference.revision || reference.revision.length > 100 || reference.expected.length > MAX_REFERENCE_UNITS
    || synonyms.length > MAX_SYNONYMS || synonyms.some(s => s.length > MAX_REFERENCE_UNITS)) throw new CoreRuleError('INVALID_SETUP');
  return done(matchAnswer(value, reference.expected, check.mode, synonyms));
}
