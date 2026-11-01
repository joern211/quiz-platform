import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TEXT_CARD_MAX_FIELDS, countCodePoints, draftsToTextCard, parseTextCardConfig, textCardConfigKey, validateTextCard,
  type TextCardConfig, type TextCardFieldDef,
} from '@quiz/shared/textcard';

// Synthetic fixtures: ids/labels are NOT game presets (no category set is decided by N2).
const field = (fieldId: string, over: Partial<TextCardFieldDef> = {}): TextCardFieldDef => ({ fieldId, label: `Feld ${fieldId}`, help: null, required: false, ...over });
const config = (over: Partial<TextCardConfig> = {}): TextCardConfig => ({
  schemaVersion: 1, fields: [field('alpha', { required: true }), field('beta'), field('gamma')],
  maxCodePointsPerField: 20, maxTotalCodePoints: 60, ...over,
});
const card = (...answers: Array<[string, string | null]>) => ({ schemaVersion: 1, answers: answers.map(([fieldId, value]) => ({ fieldId, value })) });
const full = (a: string | null = 'eins', b: string | null = null, c: string | null = null) => card(['alpha', a], ['beta', b], ['gamma', c]);
const codes = (r: ReturnType<typeof validateTextCard>) => (r.ok ? ['OK'] : r.issues.map(i => `${i.fieldId}:${i.code}`));
const cp = (...points: number[]) => String.fromCodePoint(...points);

describe('N2 config: explicit, bounded, versioned, public', () => {
  it('accepts one field and the maximum number of fields, rejects one more', () => {
    expect(parseTextCardConfig(config({ fields: [field('solo', { required: true })] })).ok).toBe(true);
    const many = (n: number) => Array.from({ length: n }, (_, i) => field(`f${i}`));
    expect(parseTextCardConfig(config({ fields: many(TEXT_CARD_MAX_FIELDS) })).ok).toBe(true);
    expect(parseTextCardConfig(config({ fields: many(TEXT_CARD_MAX_FIELDS + 1) })).ok).toBe(false);
    expect(parseTextCardConfig(config({ fields: [] })).ok).toBe(false);
  });
  it('rejects duplicate and dangerous field ids; equal labels with different ids are fine', () => {
    expect(parseTextCardConfig(config({ fields: [field('a1'), field('a1')] })).ok).toBe(false);
    for (const id of ['__proto__', 'constructor', 'prototype', 'Upper', '1abc', 'a b', 'a.b', '', 'x'.repeat(41), 'ä', 'a/b']) {
      expect(parseTextCardConfig(config({ fields: [field(id)] })).ok, JSON.stringify(id)).toBe(false);
    }
    expect(parseTextCardConfig(config({ fields: [field('left', { label: 'Gleich' }), field('right', { label: 'Gleich' })] })).ok).toBe(true);
    expect(parseTextCardConfig(config({ fields: [field('a-b_c9')] })).ok).toBe(true);
  });
  it('is strict: unknown keys, missing explicit flags, wrong version and bad limits are refused with a code only', () => {
    const base = config();
    expect(parseTextCardConfig({ ...base, extra: 1 }).ok).toBe(false);
    expect(parseTextCardConfig({ ...base, schemaVersion: 2 }).ok).toBe(false);
    expect(parseTextCardConfig({ ...base, fields: [{ fieldId: 'a', label: 'A', help: null }] }).ok).toBe(false); // required has no default
    expect(parseTextCardConfig({ ...base, fields: [{ ...field('a'), reference: 'Berlin' }] }).ok).toBe(false); // no room for private references
    expect(parseTextCardConfig({ ...base, fields: [{ ...field('a'), required: 'yes' }] }).ok).toBe(false);
    expect(parseTextCardConfig({ ...base, fields: [{ ...field('a'), help: undefined }] }).ok).toBe(false); // null is the one absent form
    for (const over of [{ maxCodePointsPerField: 0 }, { maxCodePointsPerField: 201 }, { maxCodePointsPerField: 1.5 }, { maxTotalCodePoints: 0 },
      { maxTotalCodePoints: 1201 }, { maxTotalCodePoints: NaN }]) expect(parseTextCardConfig({ ...base, ...over }).ok, JSON.stringify(over)).toBe(false);
    expect(parseTextCardConfig(config({ fields: [field('a', { label: '' })] })).ok).toBe(false);
    expect(parseTextCardConfig(config({ fields: [field('a', { label: 'x'.repeat(81) })] })).ok).toBe(false);
    expect(parseTextCardConfig(config({ fields: [field('a', { help: 'y'.repeat(201) })] })).ok).toBe(false);
    expect(parseTextCardConfig(config({ fields: [field('a', { label: 'Zeile\numbruch' })] })).ok).toBe(false);
    expect(parseTextCardConfig(config({ fields: [field('a', { label: ' führend' })] })).ok).toBe(false);
    expect(parseTextCardConfig(config({ maxTotalCodePoints: 1, fields: [field('a', { required: true }), field('b', { required: true })] })).ok).toBe(false);
    expect(parseTextCardConfig(null)).toEqual({ ok: false, code: 'TEXT_CARD_CONFIG_INVALID' });
  });
  it('config identity covers order, ids, required and limits — not display text', () => {
    const base = textCardConfigKey(config());
    expect(textCardConfigKey(config())).toBe(base);
    const [a, b, c] = config().fields;
    expect(textCardConfigKey(config({ fields: [b, a, c] }))).not.toBe(base);
    expect(textCardConfigKey(config({ fields: [{ ...a, fieldId: 'alpha2' }, b, c] }))).not.toBe(base);
    expect(textCardConfigKey(config({ fields: [{ ...a, required: false }, b, c] }))).not.toBe(base);
    expect(textCardConfigKey(config({ maxCodePointsPerField: 21 }))).not.toBe(base);
    expect(textCardConfigKey(config({ maxTotalCodePoints: 61 }))).not.toBe(base);
    expect(textCardConfigKey(config({ fields: [{ ...a, label: 'Anders', help: 'Neue Hilfe' }, b, c] }))).toBe(base);
  });
});

describe('N2 empty-value semantics: exactly one representation (null)', () => {
  it('keeps null, empty string, whitespace-only, omission and wrong types apart', () => {
    expect(codes(validateTextCard(config(), full('eins', null, null)))).toEqual(['OK']);
    expect(codes(validateTextCard(config(), full(null)))).toEqual(['alpha:TEXT_REQUIRED']);
    expect(codes(validateTextCard(config(), full('', null)))).toEqual(['alpha:TEXT_BLANK']);
    expect(codes(validateTextCard(config(), full('x', '   ')))).toEqual(['beta:TEXT_BLANK']);
    expect(codes(validateTextCard(config(), full('x', cp(0xA0, 0x2003))))).toEqual(['beta:TEXT_BLANK']);
    expect(codes(validateTextCard(config(), full('x', cp(0x200B, 0x200D))))).toEqual(['beta:TEXT_BLANK']);
    expect(codes(validateTextCard(config(), card(['alpha', 'x'], ['beta', null])))).toEqual(['gamma:TEXT_MISSING_FIELD']);
    expect(codes(validateTextCard(config(), { schemaVersion: 1, answers: [{ fieldId: 'alpha', value: 'x' }, { fieldId: 'beta', value: null }, { fieldId: 'gamma' }] }))).toEqual(['gamma:TEXT_CARD_MALFORMED']);
    expect(codes(validateTextCard(config(), { schemaVersion: 1, answers: [{ fieldId: 'alpha', value: 'x' }, { fieldId: 'beta', value: undefined }, { fieldId: 'gamma', value: null }] }))).toEqual(['beta:TEXT_WRONG_TYPE']);
    for (const bad of [5, true, false, [], {}, ['a']]) {
      expect(codes(validateTextCard(config(), { schemaVersion: 1, answers: [{ fieldId: 'alpha', value: bad }, { fieldId: 'beta', value: null }, { fieldId: 'gamma', value: null }] })), JSON.stringify(bad)).toEqual(['alpha:TEXT_WRONG_TYPE']);
    }
  });
  it('required means formal completeness only: any formally valid text passes, regardless of being "right"', () => {
    expect(validateTextCard(config(), full('Zzzzz-Nonsens-123')).ok).toBe(true);
    expect(validateTextCard(config({ fields: [field('opt')] }), card(['opt', null])).ok).toBe(true); // all optional, all empty
  });
});

describe('N2 structure: no silent changes, no partial acceptance', () => {
  it('rejects unknown keys and unknown/duplicate/missing ids without echoing attacker strings', () => {
    const e = (x: unknown) => codes(validateTextCard(config(), x));
    expect(e({ ...full(), extra: 1 })).toEqual(['null:TEXT_CARD_MALFORMED']);
    expect(e({ schemaVersion: 1 })).toEqual(['null:TEXT_CARD_MALFORMED']);
    expect(e({ schemaVersion: 2, answers: [] })).toEqual(['null:TEXT_CARD_MALFORMED']);
    expect(e({ schemaVersion: 1, answers: 'x' })).toEqual(['null:TEXT_CARD_MALFORMED']);
    expect(e([])).toEqual(['null:TEXT_CARD_MALFORMED']);
    expect(e(null)).toEqual(['null:TEXT_CARD_MALFORMED']);
    expect(e('card')).toEqual(['null:TEXT_CARD_MALFORMED']);
    expect(e(card(['alpha', 'x'], ['beta', null], ['gamma', null], ['delta', 'secret']))).toEqual(['null:TEXT_UNKNOWN_FIELD']);
    expect(e(card(['alpha', 'x'], ['alpha', 'y'], ['beta', null], ['gamma', null]))).toEqual(['alpha:TEXT_DUPLICATE_FIELD']);
    expect(e({ schemaVersion: 1, answers: [{ fieldId: 'alpha', value: 'x', extra: 1 }, { fieldId: 'beta', value: null }, { fieldId: 'gamma', value: null }] })).toEqual(['alpha:TEXT_CARD_MALFORMED']);
    expect(e({ schemaVersion: 1, answers: [null, 5, 'x'] })).toEqual(['null:TEXT_CARD_MALFORMED', 'null:TEXT_CARD_MALFORMED', 'null:TEXT_CARD_MALFORMED', 'alpha:TEXT_MISSING_FIELD', 'beta:TEXT_MISSING_FIELD', 'gamma:TEXT_MISSING_FIELD']);
    const tooMany = { schemaVersion: 1, answers: Array.from({ length: TEXT_CARD_MAX_FIELDS + 1 }, (_, i) => ({ fieldId: `f${i}`, value: null })) };
    expect(e(tooMany)).toEqual(['null:TEXT_CARD_MALFORMED']);
    const issues = JSON.stringify((validateTextCard(config(), card(['evil-injected-id', 'GEHEIM-TEXT'])) as { issues: unknown }).issues);
    expect(issues).not.toMatch(/evil-injected-id|GEHEIM-TEXT/);
  });
  it('treats prototype keys as plain unknown keys: no mutation, no confusion with inherited properties', () => {
    const polluted = JSON.parse('{"schemaVersion":1,"answers":[{"fieldId":"alpha","value":"x"},{"fieldId":"beta","value":null},{"fieldId":"gamma","value":null}],"__proto__":{"polluted":true}}');
    expect(codes(validateTextCard(config(), polluted))).toEqual(['null:TEXT_CARD_MALFORMED']);
    const entry = JSON.parse('{"schemaVersion":1,"answers":[{"fieldId":"__proto__","value":"x"},{"fieldId":"constructor","value":"y"}]}');
    expect(codes(validateTextCard(config(), entry)).slice(0, 2)).toEqual(['null:TEXT_UNKNOWN_FIELD', 'null:TEXT_UNKNOWN_FIELD']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    class Fake { schemaVersion = 1; answers: unknown[] = []; }
    expect(codes(validateTextCard(config(), new Fake()))).toEqual(['null:TEXT_CARD_MALFORMED']);
    expect(codes(validateTextCard(config(), Object.create({ schemaVersion: 1 })))).toEqual(['null:TEXT_CARD_MALFORMED']);
    // a field named like an inherited property can never be confused: ids in a config are validated, answers are an array
    expect(codes(validateTextCard(config(), card(['alpha', 'x'], ['beta', null], ['gamma', null], ['toString', 'z'])))).toEqual(['null:TEXT_UNKNOWN_FIELD']);
  });
  it('collects every problem of an invalid card and accepts nothing of it', () => {
    const result = validateTextCard(config(), card(['alpha', null], ['beta', '   '], ['gamma', 'x'.repeat(21)]));
    expect(codes(result)).toEqual(['alpha:TEXT_REQUIRED', 'beta:TEXT_BLANK', 'gamma:TEXT_TOO_LONG']);
    expect('card' in result).toBe(false);
  });
  it('assigns answers by fieldId: re-ordered entries and re-ordered definitions never swap values', () => {
    const shuffled = validateTextCard(config(), card(['gamma', 'drei'], ['alpha', 'eins'], ['beta', 'zwei']));
    expect(shuffled.ok && shuffled.card.answers).toEqual([{ fieldId: 'alpha', value: 'eins' }, { fieldId: 'beta', value: 'zwei' }, { fieldId: 'gamma', value: 'drei' }]); // canonical = config order
    const [a, b, c] = config().fields;
    const reordered = config({ fields: [c, a, b] });
    const again = validateTextCard(reordered, card(['alpha', 'eins'], ['beta', 'zwei'], ['gamma', 'drei']));
    expect(again.ok && again.card.answers).toEqual([{ fieldId: 'gamma', value: 'drei' }, { fieldId: 'alpha', value: 'eins' }, { fieldId: 'beta', value: 'zwei' }]);
    const relabeled = config({ fields: [{ ...a, label: 'beta' }, { ...b, label: 'alpha' }, c] });
    const byId = validateTextCard(relabeled, card(['alpha', 'eins'], ['beta', 'zwei'], ['gamma', 'drei']));
    expect(byId.ok && byId.card.answers[0]).toEqual({ fieldId: 'alpha', value: 'eins' }); // labels play no role
  });
  it('returns a fresh object: the input card is neither mutated nor aliased', () => {
    const input = full('eins', 'zwei', null);
    const frozen = JSON.stringify(input);
    const result = validateTextCard(config(), input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(result.ok && result.card).not.toBe(input);
    if (result.ok) { result.card.answers[0].value = 'mutiert'; expect(JSON.stringify(input)).toBe(frozen); }
  });
});

describe('N2 text rules: verbatim, code-point length, explicit character policy', () => {
  it('measures code points at exactly the limit and one above', () => {
    const c = config({ maxCodePointsPerField: 5, maxTotalCodePoints: 100 });
    expect(validateTextCard(c, full('abcde')).ok).toBe(true);
    expect(codes(validateTextCard(c, full('abcdef')))).toEqual(['alpha:TEXT_TOO_LONG']);
    expect(countCodePoints(cp(0x1F600, 0x1F600, 0x1F600))).toBe(3); // 6 UTF-16 units
    const three = cp(0x1F600, 0x1F600, 0x1F600), four = three + cp(0x1F600);
    const small = config({ maxCodePointsPerField: 3, maxTotalCodePoints: 100 });
    expect(validateTextCard(small, full(three)).ok).toBe(true);
    expect(codes(validateTextCard(small, full(four)))).toEqual(['alpha:TEXT_TOO_LONG']);
    expect(countCodePoints('e' + cp(0x301))).toBe(2); // combining mark counts: the limit is a protection bound, not a grapheme count
    expect(countCodePoints('')).toBe(0);
  });
  it('bounds the total size across fields and never truncates', () => {
    const c = config({ maxCodePointsPerField: 10, maxTotalCodePoints: 12 });
    expect(validateTextCard(c, full('abcdef', 'ghijkl')).ok).toBe(true); // 12 exactly
    expect(codes(validateTextCard(c, full('abcdef', 'ghijklm')))).toEqual(['null:TEXT_TOTAL_TOO_LONG']);
    const long = validateTextCard(c, full('x'.repeat(100_000)));
    expect(codes(long)).toEqual(['alpha:TEXT_TOO_LONG']); // refused before scanning, not cut
  });
  it('keeps German, accented, other-script and emoji text intact, byte for byte', () => {
    const family = cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
    const samples = ['Köln', 'Straße', 'Zürich', 'Ünïcödé', 'İstanbul', 'Москва', '東京', 'القاهرة', family, 'e' + cp(0x301), cp(0xE9), 'Zwei Wörter', ' Berlin ', 'a'];
    for (const text of samples) {
      const r = validateTextCard(config({ maxCodePointsPerField: 40 }), full(text));
      expect(r.ok && r.card.answers[0].value, JSON.stringify(text)).toBe(text);
    }
    const nfc = cp(0xE9), nfd = 'e' + cp(0x301);
    const r = validateTextCard(config(), full(nfc, nfd));
    expect(r.ok && [r.card.answers[0].value === nfc, r.card.answers[1].value === nfd]).toEqual([true, true]); // no Unicode normalization on the server
  });
  it('is lossless for text containing separators, JSON and structure characters', () => {
    const tricky = ['a|b', 'a;b,c', '{"x":1}', '[1,2]', 'a\\nb', '"quoted"', '<b>fett</b>', 'null', 'a:b=c&d'];
    const c = config({ maxCodePointsPerField: 30, maxTotalCodePoints: 100 });
    for (const text of tricky) {
      const r = validateTextCard(c, full(text, tricky[0], tricky[1]));
      expect(r.ok).toBe(true);
      const wire = JSON.parse(JSON.stringify(r.ok ? r.card : null));
      const back = validateTextCard(c, wire);
      expect(back.ok && back.card.answers.map(a => a.value)).toEqual([text, tricky[0], tricky[1]]);
    }
  });
  it('rejects control characters, line breaks, bidi controls, BOM and ill-formed surrogates', () => {
    const bad = ['a\nb', 'a\rb', 'a\tb', cp(0), cp(0x7F), cp(0x2028), cp(0x2029), cp(0x202E), cp(0x2066), cp(0xFEFF) + 'x',
      String.fromCharCode(0xD800), 'x' + String.fromCharCode(0xDC00), String.fromCharCode(0xD800) + 'x'];
    for (const text of bad) expect(codes(validateTextCard(config(), full(text))), JSON.stringify(text)).toEqual(['alpha:TEXT_INVALID_CHARACTERS']);
    expect(validateTextCard(config(), full(cp(0xD83D, 0xDE00))).ok).toBe(true); // a proper surrogate pair is one emoji
  });
});

describe('N2 UI boundary and serialization', () => {
  it('builds the card from drafts: trims, blank → null, config order, unknown drafts ignored', () => {
    const drafts = new Map([['gamma', '  drei  '], ['alpha', 'eins'], ['beta', '   '], ['constructor', 'x'], ['unknown', 'y']]);
    const built = draftsToTextCard(config(), drafts);
    expect(built).toEqual(card(['alpha', 'eins'], ['beta', null], ['gamma', 'drei']));
    expect(draftsToTextCard(config(), new Map()).answers.every(a => a.value === null)).toBe(true);
    expect(validateTextCard(config(), built).ok).toBe(true);
  });
  it('roundtrips config and card through JSON unchanged', () => {
    const c = config({ fields: [field('alpha', { required: true, help: 'Hilfe' }), field('beta')] });
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    const parsed = parseTextCardConfig(JSON.parse(JSON.stringify(c)));
    expect(parsed.ok && parsed.config).toEqual(c);
    const v = validateTextCard(c, JSON.parse(JSON.stringify(card(['alpha', 'ä'], ['beta', null]))));
    expect(v.ok && JSON.parse(JSON.stringify(v.card))).toEqual(card(['alpha', 'ä'], ['beta', null]));
  });
  it('loads as plain TypeScript in Node strip-only mode, as dist/app.js does with @quiz/shared', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/textcard.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(file)}); const e = new m.TextCardError('TEXT_CARD_INVALID', [{ fieldId: null, code: 'TEXT_BLANK' }]); console.log(JSON.stringify([e.code, e.message, e.issues.length, m.countCodePoints('a' + String.fromCodePoint(0x1F600))]));`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim())).toEqual(['TEXT_CARD_INVALID', 'TEXT_CARD_INVALID', 1, 2]);
  });
});
