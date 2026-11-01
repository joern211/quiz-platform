// ============================================================
// N2 — Text card contract (technical foundation, no game rules)
//
// A card is a private, atomic answer made of named single-line text
// fields. One field is the same contract with exactly one entry.
//
// Shape on the wire and in persistence (no in-band string encoding):
//   { schemaVersion: 1, answers: [{ fieldId, value: string | null }, ...] }
// An ARRAY of entries, never an object keyed by fieldId: there is no
// prototype-key ambiguity, and the assignment of an answer to a category
// is by fieldId only — never by position.
//
// Empty answers have exactly ONE representation: value === null.
// "" and whitespace-only strings are rejected (TEXT_BLANK); an omitted
// entry is rejected (TEXT_MISSING_FIELD). A formally valid card is not a
// correct answer: letter rule, category membership, dictionary, synonyms
// and duplicates are separate, later, game-specific checks.
//
// The config is PUBLIC by construction (strict schema, no room for a
// private reference). Matching references live in the server-side engine
// setup, never in this contract.
//
// Strip-only TypeScript: this file is loaded by plain Node in dist/app.js,
// so no enums and no parameter properties.
// ============================================================

import { z } from 'zod';

export const TEXT_CARD_SCHEMA_VERSION = 1 as const;
/** Protection bounds, not game rules. */
export const TEXT_CARD_MAX_FIELDS = 12;
export const TEXT_CARD_MAX_FIELD_CODEPOINTS = 200;
export const TEXT_CARD_MAX_TOTAL_CODEPOINTS = 1200;
export const TEXT_CARD_MAX_ID_LENGTH = 40;
export const TEXT_CARD_MAX_LABEL_LENGTH = 80;
export const TEXT_CARD_MAX_HELP_LENGTH = 200;

/** Per-issue codes (carried in `issues`, each with a safe fieldId or null). */
export const TEXT_CARD_ISSUE_CODES = [
  'TEXT_CARD_MALFORMED', 'TEXT_UNKNOWN_FIELD', 'TEXT_DUPLICATE_FIELD', 'TEXT_MISSING_FIELD', 'TEXT_WRONG_TYPE',
  'TEXT_REQUIRED', 'TEXT_BLANK', 'TEXT_TOO_LONG', 'TEXT_INVALID_CHARACTERS', 'TEXT_TOTAL_TOO_LONG',
] as const;
export type TextCardIssueCode = typeof TEXT_CARD_ISSUE_CODES[number];
/** Wire error codes (the message of the thrown error equals the code, like CoreRuleError). */
export const TEXT_CARD_ERROR_CODES = [
  'TEXT_CARD_INVALID', 'TEXT_CARD_CONFIG_INVALID', 'TEXT_CARD_CONFIG_STALE', 'TEXT_CARD_STATE_INVALID',
  'TEXT_CARD_ROUND_CLOSED', 'TEXT_CARD_NOT_CLOSED', 'TEXT_CARD_STALE_CARD', 'TEXT_CARD_ALREADY_JUDGED',
  'TEXT_CARD_FIELD_UNKNOWN', 'TEXT_CARD_NOT_FOUND',
] as const;
export type TextCardErrorCode = typeof TEXT_CARD_ERROR_CODES[number];

/** `fieldId` is a safe, configured id — or null when the offender is not a known field (never an echoed attacker string). */
export interface TextCardIssue { fieldId: string | null; code: TextCardIssueCode }

export class TextCardError extends Error {
  readonly code: TextCardErrorCode;
  readonly issues: readonly TextCardIssue[];
  constructor(code: TextCardErrorCode, issues: readonly TextCardIssue[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'TextCardError';
  }
}

// ── Text rules ───────────────────────────────────────────────

/**
 * Length unit: Unicode CODE POINTS (not UTF-16 units, not grapheme clusters). A letter with a combining
 * mark or an emoji ZWJ sequence counts as several. The limit is a protection bound only.
 */
export function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) i++; // surrogate pair = one code point
    }
    count++;
  }
  return count;
}

// Control characters (incl. tab, CR, LF: fields are single-line), line/paragraph separators, bidi
// embedding/override/isolate controls (answer spoofing at the reveal) and the BOM. Emoji joiners (ZWJ),
// variation selectors and combining marks stay allowed.
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BLANK = /^[\p{White_Space}\u200B\u200C\u200D\u2060\uFEFF]*$/u;

/**
 * Verdict on ONE stored text value. Text is kept verbatim: no trimming, no case folding, no Unicode
 * normalization on the server. (The UI boundary trims surrounding white space, see `draftsToTextCard`.)
 */
export function checkTextValue(value: string, maxCodePoints: number): TextCardIssueCode | null {
  if (value.length > maxCodePoints * 2) return 'TEXT_TOO_LONG'; // cheap bound before any scan: code points <= UTF-16 units <= 2 * code points
  if (FORBIDDEN.test(value) || LONE_SURROGATE.test(value)) return 'TEXT_INVALID_CHARACTERS';
  if (BLANK.test(value)) return 'TEXT_BLANK';
  if (countCodePoints(value) > maxCodePoints) return 'TEXT_TOO_LONG';
  return null;
}

// ── Config (versioned, public) ───────────────────────────────

const RESERVED_IDS = ['constructor', 'prototype', 'proto'];
export const TextCardFieldIdSchema = z.string().max(TEXT_CARD_MAX_ID_LENGTH)
  .regex(/^[a-z][a-z0-9_-]*$/)
  .refine(id => !RESERVED_IDS.includes(id), 'RESERVED_ID');

const displayText = (max: number) => z.string().min(1).max(max)
  .refine(s => s === s.trim() && !FORBIDDEN.test(s) && !LONE_SURROGATE.test(s), 'DISPLAY_TEXT_INVALID');

export const TextCardFieldDefSchema = z.object({
  fieldId: TextCardFieldIdSchema,
  label: displayText(TEXT_CARD_MAX_LABEL_LENGTH),
  /** Optional public help text. */
  help: displayText(TEXT_CARD_MAX_HELP_LENGTH).nullable(),
  /** Explicit, no default. true: null is not allowed (formal completeness). false: null is allowed. */
  required: z.boolean(),
}).strict();
export type TextCardFieldDef = z.infer<typeof TextCardFieldDefSchema>;

export const TextCardConfigSchema = z.object({
  schemaVersion: z.literal(TEXT_CARD_SCHEMA_VERSION),
  /** Ordered for display only; the assignment of answers is by fieldId. */
  fields: z.array(TextCardFieldDefSchema).min(1).max(TEXT_CARD_MAX_FIELDS),
  maxCodePointsPerField: z.number().int().min(1).max(TEXT_CARD_MAX_FIELD_CODEPOINTS),
  maxTotalCodePoints: z.number().int().min(1).max(TEXT_CARD_MAX_TOTAL_CODEPOINTS),
}).strict().superRefine((config, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (new Set(config.fields.map(f => f.fieldId)).size !== config.fields.length) issue('DUPLICATE_FIELD_ID');
  const required = config.fields.filter(f => f.required).length;
  if (required > config.maxTotalCodePoints) issue('TOTAL_TOO_SMALL_FOR_REQUIRED_FIELDS'); // each required field needs >= 1 code point
});
export type TextCardConfig = z.infer<typeof TextCardConfigSchema>;

export type TextCardConfigResult = { ok: true; config: TextCardConfig } | { ok: false; code: 'TEXT_CARD_CONFIG_INVALID' };
/** Failure carries a code only: no values, no zod paths. Usable by client and server (the config is public). */
export function parseTextCardConfig(raw: unknown): TextCardConfigResult {
  const parsed = TextCardConfigSchema.safeParse(raw);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, code: 'TEXT_CARD_CONFIG_INVALID' };
}

/**
 * Identity of everything that decides how a stored card is interpreted: schema version, field ORDER, ids,
 * required flags and limits. Labels/help are display-only and deliberately excluded. Contains no private data
 * (the config has none), so comparing it never needs to stay server-internal.
 */
export function textCardConfigKey(config: TextCardConfig): string {
  return JSON.stringify([config.schemaVersion, config.fields.map(f => [f.fieldId, f.required]),
    config.maxCodePointsPerField, config.maxTotalCodePoints]);
}

// ── Card ─────────────────────────────────────────────────────

export const TextCardAnswerSchema = z.object({ fieldId: TextCardFieldIdSchema, value: z.string().nullable() }).strict();
export const TextCardValueSchema = z.object({
  schemaVersion: z.literal(TEXT_CARD_SCHEMA_VERSION),
  answers: z.array(TextCardAnswerSchema).min(1).max(TEXT_CARD_MAX_FIELDS),
}).strict();
export type TextCardValue = z.infer<typeof TextCardValueSchema>;

export type TextCardValidation = { ok: true; card: TextCardValue } | { ok: false; issues: TextCardIssue[] };

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const ownKeys = (value: object): string[] => Object.keys(value);

/**
 * Structural + content validation of ONE card under the pinned config. Collects all issues (bounded by the
 * field count) so a UI can show every problem; nothing is accepted partially. Hand-rolled instead of zod so
 * that issue codes stay stable and attacker-supplied ids/texts are never echoed. The returned card is a fresh
 * object in config order (single canonical representation); the input is never mutated or reused.
 */
export function validateTextCard(config: TextCardConfig, input: unknown): TextCardValidation {
  const malformed = (): TextCardValidation => ({ ok: false, issues: [{ fieldId: null, code: 'TEXT_CARD_MALFORMED' }] });
  if (!plainObject(input)) return malformed();
  const keys = ownKeys(input);
  if (keys.length !== 2 || !keys.includes('schemaVersion') || !keys.includes('answers')) return malformed();
  if (input.schemaVersion !== TEXT_CARD_SCHEMA_VERSION || !Array.isArray(input.answers)) return malformed();
  const answers: unknown[] = input.answers;
  if (answers.length > TEXT_CARD_MAX_FIELDS) return malformed(); // bound before iterating

  const defs = new Map<string, TextCardFieldDef>(config.fields.map(f => [f.fieldId, f]));
  const seen = new Map<string, string | null>();
  const issues: TextCardIssue[] = [];
  const add = (fieldId: string | null, code: TextCardIssueCode) => { issues.push({ fieldId, code }); };

  for (const entry of answers) {
    if (!plainObject(entry)) { add(null, 'TEXT_CARD_MALFORMED'); continue; }
    const entryKeys = ownKeys(entry);
    const id = typeof entry.fieldId === 'string' && defs.has(entry.fieldId) ? entry.fieldId : null;
    if (typeof entry.fieldId !== 'string' || id === null) { add(null, 'TEXT_UNKNOWN_FIELD'); continue; }
    if (entryKeys.length !== 2 || !entryKeys.includes('value')) { if (!seen.has(id)) seen.set(id, null); add(id, 'TEXT_CARD_MALFORMED'); continue; } // one issue per field, not MALFORMED + MISSING
    if (seen.has(id)) { add(id, 'TEXT_DUPLICATE_FIELD'); continue; }
    const value = entry.value;
    if (value !== null && typeof value !== 'string') { seen.set(id, null); add(id, 'TEXT_WRONG_TYPE'); continue; }
    seen.set(id, value);
  }

  let total = 0;
  for (const def of config.fields) {
    if (!seen.has(def.fieldId)) { add(def.fieldId, 'TEXT_MISSING_FIELD'); continue; }
    const value = seen.get(def.fieldId) as string | null;
    if (issues.some(i => i.fieldId === def.fieldId)) continue; // already reported (wrong type / duplicate)
    if (value === null) { if (def.required) add(def.fieldId, 'TEXT_REQUIRED'); continue; }
    const problem = checkTextValue(value, config.maxCodePointsPerField);
    if (problem) { add(def.fieldId, problem); continue; }
    total += countCodePoints(value);
  }
  if (issues.length === 0 && total > config.maxTotalCodePoints) add(null, 'TEXT_TOTAL_TOO_LONG');
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, card: { schemaVersion: TEXT_CARD_SCHEMA_VERSION,
    answers: config.fields.map(def => ({ fieldId: def.fieldId, value: seen.get(def.fieldId) as string | null })) } };
}

/**
 * UI boundary: builds the card from free-text drafts. Surrounding white space is trimmed; a blank draft
 * becomes null (the single empty representation). Drafts for unknown fieldIds are ignored here — the server
 * never accepts them. Lookup is by fieldId through a Map, never by position.
 */
export function draftsToTextCard(config: TextCardConfig, drafts: ReadonlyMap<string, string>): TextCardValue {
  return { schemaVersion: TEXT_CARD_SCHEMA_VERSION, answers: config.fields.map(def => {
    const trimmed = (drafts.get(def.fieldId) ?? '').trim();
    return { fieldId: def.fieldId, value: trimmed === '' ? null : trimmed };
  }) };
}

/** Lookup of one answer by fieldId in an already validated card. */
export function textCardAnswer(card: TextCardValue, fieldId: string): string | null | undefined {
  const entry = card.answers.find(a => a.fieldId === fieldId);
  return entry ? entry.value : undefined;
}
