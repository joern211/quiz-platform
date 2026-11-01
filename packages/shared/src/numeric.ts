// ============================================================
// N1 — Numeric contract (technical foundation, no game rules)
//
// A number is a bounded scaled integer: { units, scale } means
// units / 10^scale. No binary floats cross a contract, compare, or
// persistence boundary. JSON roundtrips are lossless because both
// fields are safe integers. BigInt is used only inside comparisons
// and never appears in a serialized shape.
//
// Locale is a presentation and text-entry concern only (Master §12.7).
// The wire/persistence form is the canonical object, never "1,5".
// ============================================================

import { z } from 'zod';

export const NUMERIC_SCHEMA_VERSION = 1 as const;
/** |units| <= 10^15 - 1: at most 15 digits. Differences of two operands stay < 2^53. */
export const NUMERIC_MAX_ABS_UNITS = 999_999_999_999_999;
export const NUMERIC_MAX_DIGITS = 15;
/** Raw text longer than this is rejected before any scanning/conversion. */
export const NUMERIC_MAX_INPUT_LENGTH = 32;
export const NUMERIC_MAX_UNIT_LABEL_LENGTH = 24;

export const NUMERIC_ERROR_CODES = [
  'NUMERIC_MISSING', 'NUMERIC_EMPTY', 'NUMERIC_INCOMPLETE', 'NUMERIC_WRONG_TYPE', 'NUMERIC_TOO_LONG',
  'NUMERIC_INVALID_FORMAT', 'NUMERIC_TOO_PRECISE', 'NUMERIC_TOO_LARGE', 'NUMERIC_OUT_OF_RANGE',
  'NUMERIC_SCALE_MISMATCH', 'NUMERIC_CONFIG_INVALID', 'NUMERIC_CONFIG_STALE', 'NUMERIC_STATE_INVALID',
  'NUMERIC_ALREADY_JUDGED',
] as const;
export type NumericErrorCode = typeof NUMERIC_ERROR_CODES[number];

/** Thrown by the throwing helpers; `message` equals `code` like CoreRuleError (wire-stable, no values). */
export class NumericError extends Error {
  constructor(readonly code: NumericErrorCode) { super(code); this.name = 'NumericError'; }
}

// ── Value ────────────────────────────────────────────────────

export const NumericScaleSchema = z.union([z.literal(0), z.literal(1)]);
export type NumericScale = z.infer<typeof NumericScaleSchema>;

export const NumericValueSchema = z.object({
  units: z.number().int().min(-NUMERIC_MAX_ABS_UNITS).max(NUMERIC_MAX_ABS_UNITS)
    .refine(n => !Object.is(n, -0), 'NEGATIVE_ZERO'),
  scale: NumericScaleSchema,
}).strict();
export type NumericValue = z.infer<typeof NumericValueSchema>;

export type NumericResult = { ok: true; value: NumericValue } | { ok: false; code: NumericErrorCode };
const fail = (code: NumericErrorCode): { ok: false; code: NumericErrorCode } => ({ ok: false, code });

/**
 * UI/text-entry boundary. Grammar (independent of locale):
 *   [-] digits [ (, | .) digits ]       e.g. 12  -3  0,5  12.5
 * Both "," and "." are ALWAYS the decimal separator. Grouping characters
 * (thousands dots, spaces, apostrophes) are not part of the grammar, so
 * "1.234" is the decimal 1.234 (rejected when scale is 0 or 1) and never 1234.
 * No sign "+", no exponent, no hex, no Infinity/NaN, no non-ASCII characters
 * (e.g. NBSP, U+2212), no leading separator (write 0,5). Only surrounding
 * ASCII whitespace is trimmed. Digits beyond `scale` are rejected — even zeros —
 * so nothing is ever rounded or silently dropped.
 */
export function parseNumericText(raw: unknown, scale: NumericScale): NumericResult {
  if (raw === null || raw === undefined) return fail('NUMERIC_MISSING');
  if (typeof raw !== 'string') return fail('NUMERIC_WRONG_TYPE');
  if (raw.length > NUMERIC_MAX_INPUT_LENGTH) return fail('NUMERIC_TOO_LONG');
  const text = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (text === '') return fail('NUMERIC_EMPTY');
  if (text === '-') return fail('NUMERIC_INCOMPLETE');
  const match = /^(-)?([0-9]+)(?:([.,])([0-9]*))?$/.exec(text);
  if (!match) return fail('NUMERIC_INVALID_FORMAT');
  const [, sign, integerDigits, separator, fraction = ''] = match;
  if (separator && fraction === '') return fail('NUMERIC_INCOMPLETE');
  if (fraction.length > scale) return fail('NUMERIC_TOO_PRECISE');
  const digits = (integerDigits + fraction.padEnd(scale, '0')).replace(/^0+/, '');
  if (digits.length > NUMERIC_MAX_DIGITS) return fail('NUMERIC_TOO_LARGE');
  const magnitude = digits === '' ? 0 : Number(digits);
  return { ok: true, value: { units: sign && magnitude !== 0 ? -magnitude : magnitude, scale } };
}

/** Structured (wire) boundary: only the canonical object is accepted — never numbers, strings or booleans. */
export function parseNumericValue(raw: unknown): NumericResult {
  if (raw === null || raw === undefined) return fail('NUMERIC_MISSING');
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail('NUMERIC_WRONG_TYPE');
  const parsed = NumericValueSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const units = (raw as { units?: unknown }).units;
  if (typeof units === 'number' && Number.isInteger(units) && Math.abs(units) > NUMERIC_MAX_ABS_UNITS) return fail('NUMERIC_TOO_LARGE');
  return fail('NUMERIC_INVALID_FORMAT');
}

/** Canonical text, '.' separator, always exactly `scale` decimals, no grouping. */
export function formatNumericCanonical(value: NumericValue, decimalSeparator: '.' | ',' = '.'): string {
  const magnitude = Math.abs(value.units).toString().padStart(value.scale + 1, '0');
  const integer = magnitude.slice(0, magnitude.length - value.scale);
  const fraction = value.scale ? magnitude.slice(-value.scale) : '';
  return `${value.units < 0 ? '-' : ''}${integer}${fraction ? decimalSeparator + fraction : ''}`;
}

// ── Configuration (server-validated, versioned) ──────────────

/**
 * `factor` is explicit metadata only: one entered unit equals `factor` base units
 * (e.g. label "Mio. Euro", factor 1_000_000). Stored and compared values are in
 * the ENTERED unit; nothing multiplies silently, neither in the UI nor on the server.
 */
export const NumericUnitSchema = z.object({
  label: z.string().min(1).max(NUMERIC_MAX_UNIT_LABEL_LENGTH)
    .refine(s => s === s.trim() && !/[\p{Cc}\p{Cf}]/u.test(s), 'UNIT_LABEL_INVALID'),
  factor: z.union([z.literal(1), z.literal(1_000), z.literal(1_000_000), z.literal(1_000_000_000)]),
}).strict();
export type NumericUnit = z.infer<typeof NumericUnitSchema>;

export const NumericInputConfigSchema = z.object({
  schemaVersion: z.literal(NUMERIC_SCHEMA_VERSION),
  scale: NumericScaleSchema,
  min: NumericValueSchema,
  max: NumericValueSchema,
  unit: NumericUnitSchema.nullable(),
  /** Whether min/max may appear in public input metadata and error details. */
  boundsDisclosure: z.enum(['PUBLIC', 'PRIVATE']),
}).strict().superRefine((config, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (config.min.scale !== config.scale || config.max.scale !== config.scale) issue('SCALE_CONFLICT');
  else if (config.min.units > config.max.units) issue('MIN_GREATER_THAN_MAX');
});
export type NumericInputConfig = z.infer<typeof NumericInputConfigSchema>;

export type NumericConfigResult = { ok: true; config: NumericInputConfig } | { ok: false; code: 'NUMERIC_CONFIG_INVALID' };
/** Failure carries a code only: no values, no zod paths. */
export function parseNumericConfig(raw: unknown): NumericConfigResult {
  const parsed = NumericInputConfigSchema.safeParse(raw);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, code: 'NUMERIC_CONFIG_INVALID' };
}

/** Deterministic identity of an effective config; used to detect a stale/changed configuration. Server-internal. */
export function numericConfigKey(config: NumericInputConfig): string {
  return JSON.stringify([config.schemaVersion, config.scale, config.min.units, config.max.units,
    config.unit ? [config.unit.label, config.unit.factor] : null, config.boundsDisclosure]);
}

/** Public input metadata: never carries targets or evaluation parameters. Bounds only when explicitly public. */
export const NumericPublicInputSchema = z.object({
  schemaVersion: z.literal(NUMERIC_SCHEMA_VERSION),
  scale: NumericScaleSchema,
  unit: NumericUnitSchema.nullable(),
  /** UI hint (keyboard). Derived from min < 0; knowingly disclosed even when the bounds are private. */
  allowNegative: z.boolean(),
  bounds: z.object({ min: NumericValueSchema, max: NumericValueSchema }).strict().nullable(),
}).strict();
export type NumericPublicInput = z.infer<typeof NumericPublicInputSchema>;
export function projectNumericPublicInput(config: NumericInputConfig): NumericPublicInput {
  return { schemaVersion: config.schemaVersion, scale: config.scale, unit: config.unit,
    allowNegative: config.min.units < 0,
    bounds: config.boundsDisclosure === 'PUBLIC' ? { min: config.min, max: config.max } : null };
}

/** Wire value against the effective config. Range errors never include bounds unless they are public. */
export function validateNumericValue(config: NumericInputConfig, input: unknown): NumericResult {
  const parsed = parseNumericValue(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.scale !== config.scale) return fail('NUMERIC_SCALE_MISMATCH');
  if (parsed.value.units < config.min.units || parsed.value.units > config.max.units) return fail('NUMERIC_OUT_OF_RANGE');
  return parsed;
}
/** Text entry + range in one step (same rules the UI and the server use). */
export function parseNumericInput(config: NumericInputConfig, raw: unknown): NumericResult {
  const parsed = parseNumericText(raw, config.scale);
  return parsed.ok ? validateNumericValue(config, parsed.value) : parsed;
}
/** Client-side pre-check using only public metadata; the server remains authoritative. */
export function parseNumericInputPublic(meta: NumericPublicInput, raw: unknown): NumericResult {
  const parsed = parseNumericText(raw, meta.scale);
  if (!parsed.ok) return parsed;
  if (!meta.allowNegative && parsed.value.units < 0) return fail('NUMERIC_OUT_OF_RANGE');
  if (meta.bounds && (parsed.value.units < meta.bounds.min.units || parsed.value.units > meta.bounds.max.units)) return fail('NUMERIC_OUT_OF_RANGE');
  return parsed;
}

// ── Evaluation (neutral metrics; never writes points) ────────

function strictValue(value: unknown): NumericValue {
  const parsed = parseNumericValue(value);
  if (!parsed.ok) throw new NumericError(parsed.code === 'NUMERIC_TOO_LARGE' ? 'NUMERIC_TOO_LARGE' : 'NUMERIC_INVALID_FORMAT');
  return parsed.value;
}
const pow10 = (n: number): bigint => 10n ** BigInt(n);

export const NumericEvaluationSchema = z.object({
  schemaVersion: z.literal(NUMERIC_SCHEMA_VERSION),
  scale: NumericScaleSchema,
  equal: z.boolean(),
  /** Position of the INPUT relative to the target. */
  direction: z.enum(['BELOW', 'EQUAL', 'ABOVE']),
  /** |input - target| in units of `scale`; at most 2 * (10^15 - 1), still a safe integer. */
  absoluteDeviationUnits: z.number().int().nonnegative().max(2 * NUMERIC_MAX_ABS_UNITS),
  /** Exact ratio |input - target| / |target|; no float. UNDEFINED when the target is 0. */
  relativeDeviation: z.discriminatedUnion('status', [
    z.object({ status: z.literal('DEFINED'), numerator: z.number().int().nonnegative(), denominator: z.number().int().positive() }).strict(),
    z.object({ status: z.literal('UNDEFINED'), reason: z.literal('TARGET_ZERO') }).strict(),
  ]),
}).strict();
export type NumericEvaluation = z.infer<typeof NumericEvaluationSchema>;

/** Both operands must share one scale (the config scale) and the contract magnitude; otherwise it throws. */
export function evaluateNumeric(inputValue: NumericValue, targetValue: NumericValue): NumericEvaluation {
  const input = strictValue(inputValue), target = strictValue(targetValue);
  if (input.scale !== target.scale) throw new NumericError('NUMERIC_SCALE_MISMATCH');
  const diff = input.units - target.units; // |diff| <= 2 * (10^15 - 1): exact in a double
  const absolute = Math.abs(diff);
  return {
    schemaVersion: NUMERIC_SCHEMA_VERSION, scale: input.scale, equal: diff === 0,
    direction: diff === 0 ? 'EQUAL' : diff < 0 ? 'BELOW' : 'ABOVE',
    absoluteDeviationUnits: absolute,
    relativeDeviation: target.units === 0
      ? { status: 'UNDEFINED', reason: 'TARGET_ZERO' }
      : { status: 'DEFINED', numerator: absolute, denominator: Math.abs(target.units) },
  };
}

/** Explicit tolerance only: `boundary` has no default, so inclusiveness is always a stated decision. */
export const NumericToleranceSchema = z.object({
  kind: z.enum(['ABSOLUTE', 'RELATIVE_PERCENT']),
  /** ABSOLUTE: same unit as the values. RELATIVE_PERCENT: percent, e.g. {units: 125, scale: 1} = 12.5 %. */
  max: NumericValueSchema.refine(v => v.units >= 0, 'NEGATIVE_TOLERANCE'),
  boundary: z.enum(['INCLUSIVE', 'EXCLUSIVE']),
}).strict().refine(t => !(t.boundary === 'EXCLUSIVE' && t.max.units === 0), 'EMPTY_TOLERANCE');
export type NumericTolerance = z.infer<typeof NumericToleranceSchema>;
export type NumericToleranceResult = 'WITHIN' | 'OUTSIDE' | 'UNDEFINED';

/** Exact integer cross-multiplication (BigInt internally); no epsilon, no float. */
export function checkNumericTolerance(evaluation: NumericEvaluation, toleranceInput: NumericTolerance): NumericToleranceResult {
  const parsedEvaluation = NumericEvaluationSchema.safeParse(evaluation), parsedTolerance = NumericToleranceSchema.safeParse(toleranceInput);
  if (!parsedEvaluation.success || !parsedTolerance.success) throw new NumericError('NUMERIC_INVALID_FORMAT');
  const e = parsedEvaluation.data, t = parsedTolerance.data;
  let left: bigint, right: bigint;
  if (t.kind === 'ABSOLUTE') {
    // diff / 10^e.scale  <=  tol / 10^t.max.scale
    left = BigInt(e.absoluteDeviationUnits) * pow10(t.max.scale);
    right = BigInt(t.max.units) * pow10(e.scale);
  } else {
    if (e.relativeDeviation.status === 'UNDEFINED') return 'UNDEFINED';
    // numerator / denominator  <=  tol / (100 * 10^t.max.scale)
    left = BigInt(e.relativeDeviation.numerator) * 100n * pow10(t.max.scale);
    right = BigInt(t.max.units) * BigInt(e.relativeDeviation.denominator);
  }
  return left < right || (t.boundary === 'INCLUSIVE' && left === right) ? 'WITHIN' : 'OUTSIDE';
}

/**
 * Groups entries by equal distance to the target, nearest group first. No winner is chosen:
 * equal distance stays one group; arrival time and randomness play no role. The id order inside a
 * group is lexicographic only to keep the output deterministic and carries no meaning.
 */
export function groupByDistance<T extends { id: string; value: NumericValue }>(entries: readonly T[], targetValue: NumericValue): Array<{ absoluteDeviationUnits: number; ids: string[] }> {
  const groups = new Map<number, string[]>();
  for (const entry of entries) {
    const { absoluteDeviationUnits } = evaluateNumeric(entry.value, targetValue);
    groups.set(absoluteDeviationUnits, [...(groups.get(absoluteDeviationUnits) ?? []), entry.id]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b)
    .map(([absoluteDeviationUnits, ids]) => ({ absoluteDeviationUnits, ids: ids.sort() }));
}
