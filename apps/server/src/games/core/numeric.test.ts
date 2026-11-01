import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NUMERIC_MAX_ABS_UNITS, NumericError, checkNumericTolerance, evaluateNumeric, formatNumericCanonical,
  groupByDistance, numericConfigKey, parseNumericConfig, parseNumericInput, parseNumericInputPublic, parseNumericText, parseNumericValue,
  projectNumericPublicInput, validateNumericValue,
  type NumericInputConfig, type NumericTolerance, type NumericValue,
} from '@quiz/shared/numeric';

const v = (units: number, scale: 0 | 1 = 0): NumericValue => ({ units, scale });
const config = (over: Partial<NumericInputConfig> = {}): NumericInputConfig => ({ schemaVersion: 1, scale: 0, min: v(-100), max: v(1000),
  unit: null, boundsDisclosure: 'PUBLIC', ...over });
const code = (r: { ok: boolean; code?: string }) => (r.ok ? 'OK' : r.code);

describe('N1 text entry: deterministic, bounded grammar', () => {
  it('keeps missing, empty, whitespace and a valid 0 apart', () => {
    expect(code(parseNumericText(null, 0))).toBe('NUMERIC_MISSING');
    expect(code(parseNumericText(undefined, 0))).toBe('NUMERIC_MISSING');
    expect(code(parseNumericText('', 0))).toBe('NUMERIC_EMPTY');
    expect(code(parseNumericText('  \t', 0))).toBe('NUMERIC_EMPTY');
    expect(parseNumericText('0', 0)).toEqual({ ok: true, value: v(0) });
    expect(parseNumericText(' 0 ', 0)).toEqual({ ok: true, value: v(0) });
    expect(parseNumericText('0,0', 1)).toEqual({ ok: true, value: v(0, 1) });
  });
  it('normalizes -0 to a single 0 and never yields a negative zero', () => {
    for (const [text, scale] of [['-0', 0], ['-0,0', 1], ['-000', 0]] as const) {
      const r = parseNumericText(text, scale);
      expect(r.ok && Object.is(r.value.units, 0)).toBe(true);
    }
    expect(NumericValueRejectsNegativeZero()).toBe(true);
  });
  it('accepts comma and dot as the one decimal separator, signs and leading zeros', () => {
    expect(parseNumericText('12,5', 1)).toEqual({ ok: true, value: v(125, 1) });
    expect(parseNumericText('12.5', 1)).toEqual({ ok: true, value: v(125, 1) });
    expect(parseNumericText('-3', 1)).toEqual({ ok: true, value: v(-30, 1) });
    expect(parseNumericText('-0,5', 1)).toEqual({ ok: true, value: v(-5, 1) });
    expect(parseNumericText('007', 0)).toEqual({ ok: true, value: v(7) });
    expect(parseNumericText('-42', 0)).toEqual({ ok: true, value: v(-42) });
  });
  it('marks typing drafts as incomplete instead of valid or zero', () => {
    for (const text of ['-', '12,', '12.', '-5,']) expect(code(parseNumericText(text, 1)), text).toBe('NUMERIC_INCOMPLETE');
  });
  it('rejects partial numbers, grouping, mixed syntax and exotic number forms', () => {
    const bad = ['12abc', 'abc', '1 234', '1 234', '1.234,5', '1,234.5', '1,2,3', '1..2', '+5', '--5', '5-', '1e3', '1E3', '0x10',
      'Infinity', '-Infinity', 'NaN', ',5', '.5', '-,5', '٣', '１２', '−12', '12 %', '0b1', '1_000'];
    for (const text of bad) expect(code(parseNumericText(text, 1)), JSON.stringify(text)).toBe('NUMERIC_INVALID_FORMAT');
  });
  it('treats 1.234 as a decimal, never as 1234', () => {
    expect(code(parseNumericText('1.234', 0))).toBe('NUMERIC_TOO_PRECISE');
    expect(code(parseNumericText('1.234', 1))).toBe('NUMERIC_TOO_PRECISE');
    expect(code(parseNumericText('1,234', 0))).toBe('NUMERIC_TOO_PRECISE');
  });
  it('rejects wrong types without coercion', () => {
    for (const raw of [0, 12, NaN, Infinity, true, false, [], ['1'], {}, { units: 1, scale: 0 }, () => 1, 10n]) {
      expect(code(parseNumericText(raw, 0)), String(typeof raw)).toBe('NUMERIC_WRONG_TYPE');
    }
  });
  it('never rounds: one decimal too many is rejected, even if it is a zero', () => {
    expect(parseNumericText('12,5', 1).ok).toBe(true);
    expect(code(parseNumericText('12,55', 1))).toBe('NUMERIC_TOO_PRECISE');
    expect(code(parseNumericText('12,50', 1))).toBe('NUMERIC_TOO_PRECISE');
    expect(code(parseNumericText('12,0', 0))).toBe('NUMERIC_TOO_PRECISE');
    expect(code(parseNumericText('0,05', 1))).toBe('NUMERIC_TOO_PRECISE');
  });
  it('bounds length and digits before converting', () => {
    expect(parseNumericText('9'.repeat(15), 0)).toEqual({ ok: true, value: v(NUMERIC_MAX_ABS_UNITS) });
    expect(parseNumericText('-' + '9'.repeat(15), 0)).toEqual({ ok: true, value: v(-NUMERIC_MAX_ABS_UNITS) });
    expect(code(parseNumericText('1' + '0'.repeat(15), 0))).toBe('NUMERIC_TOO_LARGE');
    expect(code(parseNumericText('9'.repeat(15), 1))).toBe('NUMERIC_TOO_LARGE'); // 14 integer digits + 1 decimal = 16 digits
    expect(parseNumericText('9'.repeat(14) + ',9', 1)).toEqual({ ok: true, value: v(NUMERIC_MAX_ABS_UNITS, 1) });
    expect(parseNumericText('0'.repeat(20) + '5', 0)).toEqual({ ok: true, value: v(5) });
    expect(code(parseNumericText('1'.repeat(33), 0))).toBe('NUMERIC_TOO_LONG');
    expect(code(parseNumericText(' '.repeat(10000), 0))).toBe('NUMERIC_TOO_LONG');
  });
});

function NumericValueRejectsNegativeZero(): boolean {
  return !parseNumericValue({ units: -0, scale: 0 }).ok;
}

describe('N1 canonical value and config', () => {
  it('accepts only the canonical object and rejects numbers, strings, nulls and extra keys', () => {
    expect(parseNumericValue({ units: 5, scale: 1 })).toEqual({ ok: true, value: v(5, 1) });
    expect(code(parseNumericValue(null))).toBe('NUMERIC_MISSING');
    expect(code(parseNumericValue(undefined))).toBe('NUMERIC_MISSING');
    for (const raw of [5, '5', true, [5], 'abc']) expect(code(parseNumericValue(raw))).toBe('NUMERIC_WRONG_TYPE');
    for (const raw of [{}, { units: '5', scale: 0 }, { units: 1.5, scale: 0 }, { units: NaN, scale: 0 }, { units: Infinity, scale: 0 },
      { units: 5, scale: 2 }, { units: 5, scale: 0, extra: true }, { units: 5 }, { scale: 0 }, { units: null, scale: 0 }]) {
      expect(code(parseNumericValue(raw)), JSON.stringify(raw)).toBe('NUMERIC_INVALID_FORMAT');
    }
    expect(code(parseNumericValue({ units: Number.MAX_SAFE_INTEGER, scale: 0 }))).toBe('NUMERIC_TOO_LARGE');
  });
  it('validates against scale and bounds exactly at, just below and just above the limits', () => {
    const c = config();
    expect(code(validateNumericValue(c, v(-100)))).toBe('OK');
    expect(code(validateNumericValue(c, v(1000)))).toBe('OK');
    expect(code(validateNumericValue(c, v(-101)))).toBe('NUMERIC_OUT_OF_RANGE');
    expect(code(validateNumericValue(c, v(1001)))).toBe('NUMERIC_OUT_OF_RANGE');
    expect(code(validateNumericValue(c, v(10, 1)))).toBe('NUMERIC_SCALE_MISMATCH');
    expect(code(validateNumericValue(c, v(0)))).toBe('OK');
    const decimal = config({ scale: 1, min: v(-5, 1), max: v(5, 1) });
    expect(code(parseNumericInput(decimal, '0,5'))).toBe('OK');
    expect(code(parseNumericInput(decimal, '0,6'))).toBe('NUMERIC_OUT_OF_RANGE');
    expect(code(parseNumericInput(decimal, '-0,5'))).toBe('OK');
    expect(code(parseNumericInput(decimal, '-0,6'))).toBe('NUMERIC_OUT_OF_RANGE');
  });
  it('rejects invalid configurations with a code only', () => {
    expect(parseNumericConfig(config()).ok).toBe(true);
    expect(parseNumericConfig(config({ min: v(1), max: v(0) }))).toEqual({ ok: false, code: 'NUMERIC_CONFIG_INVALID' });
    expect(parseNumericConfig(config({ min: v(5), max: v(5) })).ok).toBe(true);
    expect(parseNumericConfig(config({ scale: 1 })).ok).toBe(false); // bounds still scale 0
    expect(parseNumericConfig(config({ min: v(0, 1), max: v(10, 1) })).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), schemaVersion: 2 }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), scale: 2 }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), min: { units: NaN, scale: 0 } }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), max: { units: Infinity, scale: 0 } }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), max: { units: 10 ** 15, scale: 0 } }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), boundsDisclosure: undefined }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), unit: { label: 'Mio.', factor: 7 } }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), unit: { label: ' ', factor: 1 } }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), unit: { label: 'x'.repeat(25), factor: 1 } }).ok).toBe(false);
    expect(parseNumericConfig({ ...config(), unit: { label: 'Mio. Euro', factor: 1_000_000 } }).ok).toBe(true);
    expect(parseNumericConfig({ ...config(), target: 5 }).ok).toBe(false);
    expect(parseNumericConfig(null)).toEqual({ ok: false, code: 'NUMERIC_CONFIG_INVALID' });
  });
  it('binds identity to every effective field, including the unit scale', () => {
    const base = numericConfigKey(config());
    expect(numericConfigKey(config())).toBe(base);
    expect(numericConfigKey(config({ max: v(1001) }))).not.toBe(base);
    expect(numericConfigKey(config({ unit: { label: 'km', factor: 1 } }))).not.toBe(base);
    expect(numericConfigKey(config({ unit: { label: 'km', factor: 1000 } }))).not.toBe(numericConfigKey(config({ unit: { label: 'km', factor: 1 } })));
    expect(numericConfigKey(config({ boundsDisclosure: 'PRIVATE' }))).not.toBe(base);
  });
  it('formats canonically and locale-independently, losslessly through JSON', () => {
    expect(formatNumericCanonical(v(125, 1))).toBe('12.5');
    expect(formatNumericCanonical(v(125, 1), ',')).toBe('12,5');
    expect(formatNumericCanonical(v(-5, 1))).toBe('-0.5');
    expect(formatNumericCanonical(v(0, 1))).toBe('0.0');
    expect(formatNumericCanonical(v(0))).toBe('0');
    expect(formatNumericCanonical(v(-NUMERIC_MAX_ABS_UNITS, 1), ',')).toBe('-99999999999999,9');
    for (const text of ['0', '-7', '12,5', '-99999999999999,9']) {
      const parsed = parseNumericText(text, text.includes(',') ? 1 : 0);
      if (!parsed.ok) throw new Error('fixture');
      const roundtrip = JSON.parse(JSON.stringify(parsed.value)) as NumericValue;
      expect(roundtrip).toEqual(parsed.value);
      expect(formatNumericCanonical(roundtrip, ',')).toBe(text);
    }
  });
});

describe('N1 public metadata and secret separation', () => {
  it('projects bounds only when explicitly public and never carries evaluation data', () => {
    const publicMeta = projectNumericPublicInput(config({ unit: { label: 'km', factor: 1 } }));
    expect(publicMeta.bounds).toEqual({ min: v(-100), max: v(1000) });
    const privateMeta = projectNumericPublicInput(config({ boundsDisclosure: 'PRIVATE' }));
    expect(privateMeta.bounds).toBeNull();
    expect(Object.keys(privateMeta).sort()).toEqual(['allowNegative', 'bounds', 'scale', 'schemaVersion', 'unit']);
    expect(JSON.stringify(privateMeta)).not.toMatch(/1000|boundsDisclosure/);
  });
  it('client pre-check uses only public metadata; private bounds are left to the server', () => {
    const privateMeta = projectNumericPublicInput(config({ boundsDisclosure: 'PRIVATE', min: v(0), max: v(50) }));
    expect(code(parseNumericInputPublic(privateMeta, '9999'))).toBe('OK'); // no bound known client-side
    expect(code(parseNumericInputPublic(privateMeta, '-1'))).toBe('NUMERIC_OUT_OF_RANGE'); // keyboard-level sign rule
    const publicMeta = projectNumericPublicInput(config({ min: v(0), max: v(50) }));
    expect(code(parseNumericInputPublic(publicMeta, '51'))).toBe('NUMERIC_OUT_OF_RANGE');
  });
  it('range rejection from server validation is a bare code: no target, no bound, no value', () => {
    const secret = config({ boundsDisclosure: 'PRIVATE', min: v(0), max: v(777) });
    const r = validateNumericValue(secret, v(778));
    expect(r).toEqual({ ok: false, code: 'NUMERIC_OUT_OF_RANGE' });
    expect(JSON.stringify(r)).not.toMatch(/777|778/);
  });
});

describe('N1 evaluation: neutral, exact, independent reference values', () => {
  it('computes equality, direction and absolute deviation on both sides of the target', () => {
    // hand-computed: 2970-2962=8, 2500-2962=-462, 2962-2962=0
    expect(evaluateNumeric(v(2970), v(2962))).toMatchObject({ equal: false, direction: 'ABOVE', absoluteDeviationUnits: 8 });
    expect(evaluateNumeric(v(2500), v(2962))).toMatchObject({ direction: 'BELOW', absoluteDeviationUnits: 462 });
    expect(evaluateNumeric(v(2962), v(2962))).toMatchObject({ equal: true, direction: 'EQUAL', absoluteDeviationUnits: 0 });
    const left = evaluateNumeric(v(95), v(100)), right = evaluateNumeric(v(105), v(100));
    expect(left.absoluteDeviationUnits).toBe(right.absoluteDeviationUnits);
    expect(left.direction).toBe('BELOW');
    expect(right.direction).toBe('ABOVE');
  });
  it('handles positive, negative and zero targets, with a relative base of |target|', () => {
    expect(evaluateNumeric(v(110), v(100)).relativeDeviation).toEqual({ status: 'DEFINED', numerator: 10, denominator: 100 });
    expect(evaluateNumeric(v(-90), v(-100)).relativeDeviation).toEqual({ status: 'DEFINED', numerator: 10, denominator: 100 });
    expect(evaluateNumeric(v(-110), v(-100)).relativeDeviation).toEqual({ status: 'DEFINED', numerator: 10, denominator: 100 });
    expect(evaluateNumeric(v(5), v(-5)).absoluteDeviationUnits).toBe(10);
    const zero = evaluateNumeric(v(5), v(0));
    expect(zero.relativeDeviation).toEqual({ status: 'UNDEFINED', reason: 'TARGET_ZERO' });
    expect(zero.absoluteDeviationUnits).toBe(5);
    expect(JSON.stringify(zero)).not.toMatch(/NaN|Infinity|null/);
  });
  it('is decimal-exact where binary floats are not (0.1 / 0.2 / 0.3)', () => {
    const point1 = v(1, 1), point2 = v(2, 1), point3 = v(3, 1), point4 = v(4, 1);
    // float reality, for contrast: 0.3 - 0.2 = 0.09999999999999998 and 0.4 - 0.3 = 0.10000000000000003
    expect(0.3 - 0.2).not.toBe(0.1);
    expect(evaluateNumeric(point3, point2).absoluteDeviationUnits).toBe(1);
    expect(evaluateNumeric(point4, point3).absoluteDeviationUnits).toBe(1);
    const abs = (boundary: 'INCLUSIVE' | 'EXCLUSIVE'): NumericTolerance => ({ kind: 'ABSOLUTE', max: point1, boundary });
    expect(checkNumericTolerance(evaluateNumeric(point3, point2), abs('INCLUSIVE'))).toBe('WITHIN');
    expect(checkNumericTolerance(evaluateNumeric(point3, point2), abs('EXCLUSIVE'))).toBe('OUTSIDE'); // a float compare says WITHIN
    expect(checkNumericTolerance(evaluateNumeric(point4, point3), abs('INCLUSIVE'))).toBe('WITHIN'); // a float compare says OUTSIDE
    expect(checkNumericTolerance(evaluateNumeric(v(5, 1), point3), abs('INCLUSIVE'))).toBe('OUTSIDE');
  });
  it('tolerance: exactly on, just inside and just outside — absolute with mixed tolerance scale', () => {
    const t = (max: NumericValue, boundary: 'INCLUSIVE' | 'EXCLUSIVE'): NumericTolerance => ({ kind: 'ABSOLUTE', max, boundary });
    const e = evaluateNumeric(v(103), v(100)); // deviation 3
    expect(checkNumericTolerance(e, t(v(3), 'INCLUSIVE'))).toBe('WITHIN');
    expect(checkNumericTolerance(e, t(v(3), 'EXCLUSIVE'))).toBe('OUTSIDE');
    expect(checkNumericTolerance(e, t(v(31, 1), 'EXCLUSIVE'))).toBe('WITHIN'); // 3 < 3.1
    expect(checkNumericTolerance(e, t(v(29, 1), 'INCLUSIVE'))).toBe('OUTSIDE'); // 3 > 2.9
    expect(checkNumericTolerance(evaluateNumeric(v(30, 1), v(0, 1)), t(v(3), 'INCLUSIVE'))).toBe('WITHIN'); // 3.0 vs 3
    expect(checkNumericTolerance(evaluateNumeric(v(7), v(7)), t(v(0), 'INCLUSIVE'))).toBe('WITHIN');
    expect(checkNumericTolerance(evaluateNumeric(v(8), v(7)), t(v(0), 'INCLUSIVE'))).toBe('OUTSIDE');
  });
  it('tolerance: relative percent boundaries (5 % of 200 is 10; 12.5 % of 80 is 10)', () => {
    const pct = (max: NumericValue, boundary: 'INCLUSIVE' | 'EXCLUSIVE'): NumericTolerance => ({ kind: 'RELATIVE_PERCENT', max, boundary });
    expect(checkNumericTolerance(evaluateNumeric(v(210), v(200)), pct(v(5), 'INCLUSIVE'))).toBe('WITHIN');
    expect(checkNumericTolerance(evaluateNumeric(v(210), v(200)), pct(v(5), 'EXCLUSIVE'))).toBe('OUTSIDE');
    expect(checkNumericTolerance(evaluateNumeric(v(209), v(200)), pct(v(5), 'EXCLUSIVE'))).toBe('WITHIN');
    expect(checkNumericTolerance(evaluateNumeric(v(211), v(200)), pct(v(5), 'INCLUSIVE'))).toBe('OUTSIDE');
    expect(checkNumericTolerance(evaluateNumeric(v(190), v(200)), pct(v(5), 'INCLUSIVE'))).toBe('WITHIN');
    expect(checkNumericTolerance(evaluateNumeric(v(90), v(80)), pct(v(125, 1), 'INCLUSIVE'))).toBe('WITHIN');
    expect(checkNumericTolerance(evaluateNumeric(v(91), v(80)), pct(v(125, 1), 'INCLUSIVE'))).toBe('OUTSIDE');
    expect(checkNumericTolerance(evaluateNumeric(v(-90), v(-100)), pct(v(10), 'INCLUSIVE'))).toBe('WITHIN'); // base |-100|
    expect(checkNumericTolerance(evaluateNumeric(v(2970), v(2962)), pct(v(1), 'INCLUSIVE'))).toBe('WITHIN'); // 8/2962 = 0.27 %
  });
  it('relative tolerance on a zero target is UNDEFINED — never a quotient, never a substitute tolerance', () => {
    const e = evaluateNumeric(v(0), v(0));
    expect(checkNumericTolerance(e, { kind: 'RELATIVE_PERCENT', max: v(50), boundary: 'INCLUSIVE' })).toBe('UNDEFINED');
    expect(checkNumericTolerance(evaluateNumeric(v(1), v(0)), { kind: 'RELATIVE_PERCENT', max: v(1000), boundary: 'INCLUSIVE' })).toBe('UNDEFINED');
    expect(checkNumericTolerance(evaluateNumeric(v(1), v(0)), { kind: 'ABSOLUTE', max: v(1), boundary: 'INCLUSIVE' })).toBe('WITHIN');
  });
  it('rejects invalid tolerances and evaluations instead of guessing', () => {
    const e = evaluateNumeric(v(1), v(2));
    expect(() => checkNumericTolerance(e, { kind: 'ABSOLUTE', max: v(-1), boundary: 'INCLUSIVE' })).toThrow(NumericError);
    expect(() => checkNumericTolerance(e, { kind: 'ABSOLUTE', max: v(0), boundary: 'EXCLUSIVE' })).toThrow(NumericError);
    expect(() => checkNumericTolerance(e, { kind: 'ABSOLUTE', max: v(1) } as unknown as NumericTolerance)).toThrow(NumericError);
    expect(() => checkNumericTolerance({ ...e, absoluteDeviationUnits: NaN }, { kind: 'ABSOLUTE', max: v(1), boundary: 'INCLUSIVE' })).toThrow(NumericError);
    const tol: NumericTolerance = { kind: 'RELATIVE_PERCENT', max: v(5), boundary: 'INCLUSIVE' };
    // tampered / corrupt evaluations are refused, not silently classified
    expect(() => checkNumericTolerance({ ...e, relativeDeviation: { status: 'DEFINED', numerator: 1e300, denominator: 2 } }, tol)).toThrow(NumericError);
    expect(() => checkNumericTolerance({ ...e, relativeDeviation: { status: 'DEFINED', numerator: 1, denominator: 0 } }, tol)).toThrow(NumericError);
    expect(() => checkNumericTolerance({ ...e, relativeDeviation: { status: 'DEFINED', numerator: 5, denominator: 2 } }, tol)).toThrow(NumericError);
    expect(() => checkNumericTolerance({ ...e, equal: true }, tol)).toThrow(NumericError);
    expect(() => checkNumericTolerance({ ...e, direction: 'EQUAL' }, tol)).toThrow(NumericError);
  });
  it('keeps differences safe: extreme operands work, out-of-contract operands throw instead of overflowing silently', () => {
    const max = v(NUMERIC_MAX_ABS_UNITS), min = v(-NUMERIC_MAX_ABS_UNITS);
    const widest = evaluateNumeric(max, min);
    expect(widest.absoluteDeviationUnits).toBe(1_999_999_999_999_998); // independent: 2 * (10^15 - 1)
    expect(Number.isSafeInteger(widest.absoluteDeviationUnits)).toBe(true);
    expect(checkNumericTolerance(widest, { kind: 'RELATIVE_PERCENT', max: v(200), boundary: 'INCLUSIVE' })).toBe('WITHIN');
    // MAX_SAFE_INTEGER operands would make the difference 2^54 - 2 (not exactly representable) → must be refused
    expect(() => evaluateNumeric(v(Number.MAX_SAFE_INTEGER), v(-Number.MAX_SAFE_INTEGER))).toThrow('NUMERIC_TOO_LARGE');
    expect(() => evaluateNumeric(v(NUMERIC_MAX_ABS_UNITS + 1), v(0))).toThrow('NUMERIC_TOO_LARGE');
    expect(() => evaluateNumeric(v(1, 1), v(1, 0))).toThrow('NUMERIC_SCALE_MISMATCH');
    expect(() => evaluateNumeric({ units: NaN, scale: 0 }, v(1))).toThrow(NumericError);
    expect(() => evaluateNumeric({ units: '5' as unknown as number, scale: 0 }, v(1))).toThrow(NumericError);
  });
  it('compares exactly at the extreme end of the range (no float scaling error)', () => {
    const e = evaluateNumeric(v(0), v(NUMERIC_MAX_ABS_UNITS)); // deviation is exactly 100 % of the target
    expect(checkNumericTolerance(e, { kind: 'RELATIVE_PERCENT', max: v(100), boundary: 'INCLUSIVE' })).toBe('WITHIN');
    expect(checkNumericTolerance(e, { kind: 'RELATIVE_PERCENT', max: v(100), boundary: 'EXCLUSIVE' })).toBe('OUTSIDE');
    expect(checkNumericTolerance(e, { kind: 'RELATIVE_PERCENT', max: v(1000, 1), boundary: 'INCLUSIVE' })).toBe('WITHIN');
    expect(checkNumericTolerance(e, { kind: 'RELATIVE_PERCENT', max: v(999, 1), boundary: 'INCLUSIVE' })).toBe('OUTSIDE');
    const huge = evaluateNumeric(v(-NUMERIC_MAX_ABS_UNITS), v(NUMERIC_MAX_ABS_UNITS)); // 200 %
    expect(checkNumericTolerance(huge, { kind: 'RELATIVE_PERCENT', max: v(NUMERIC_MAX_ABS_UNITS, 1), boundary: 'INCLUSIVE' })).toBe('WITHIN');
    expect(checkNumericTolerance(huge, { kind: 'ABSOLUTE', max: v(NUMERIC_MAX_ABS_UNITS), boundary: 'INCLUSIVE' })).toBe('OUTSIDE'); // 1.999…e15 > 9.99…e14
  });
  it('is reproducible after a JSON roundtrip and repetition', () => {
    const input = v(1234, 1), target = v(-5678, 1);
    const first = evaluateNumeric(input, target);
    expect(evaluateNumeric(JSON.parse(JSON.stringify(input)), JSON.parse(JSON.stringify(target)))).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(evaluateNumeric(input, target)).toEqual(first);
  });
  it('groups by distance without choosing a winner: equal distance stays one group, order does not matter', () => {
    const entries = [{ id: 'c', value: v(130) }, { id: 'a', value: v(90) }, { id: 'b', value: v(110) }, { id: 'd', value: v(100) }];
    const grouped = groupByDistance(entries, v(100));
    expect(grouped).toEqual([{ absoluteDeviationUnits: 0, ids: ['d'] }, { absoluteDeviationUnits: 10, ids: ['a', 'b'] }, { absoluteDeviationUnits: 30, ids: ['c'] }]);
    expect(groupByDistance([...entries].reverse(), v(100))).toEqual(grouped);
    expect(groupByDistance([], v(1))).toEqual([]);
  });
});

describe('N1 runtime loadability', () => {
  it('loads as plain TypeScript in Node strip-only mode, as dist/app.js does with @quiz/shared (no enums/parameter properties)', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/numeric.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(file)}); const e = new m.NumericError('NUMERIC_EMPTY'); console.log(JSON.stringify([e.code, e.message, m.parseNumericText('12,5', 1).ok]));`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim())).toEqual(['NUMERIC_EMPTY', 'NUMERIC_EMPTY', true]);
  });
});
