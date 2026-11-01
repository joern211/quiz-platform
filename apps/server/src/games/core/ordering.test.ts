import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ORDERING_MAX_ITEMS, ORDERING_MIN_ITEMS, OrderingError, compareOrdering, orderingComparisonMatchesOrder, orderingConfigKey,
  orderingItemSetKey, orderingValueFromIds, parseOrderingConfig, strictOrderingReference, validateOrdering, validateOrderingReference,
  type OrderingConfig, type OrderingItemDef,
} from '@quiz/shared/ordering';
import { parseTextCardConfig } from '@quiz/shared/textcard';

// Synthetic fixtures: ids/labels are NOT game presets and carry no value, date or rank (no game is decided by N3).
const item = (itemId: string, over: Partial<OrderingItemDef> = {}): OrderingItemDef => ({ itemId, label: `Eintrag ${itemId}`, help: null, ...over });
const config = (ids: string[] = ['ab', 'cd', 'ef', 'gh'], over: Partial<OrderingConfig> = {}): OrderingConfig =>
  ({ schemaVersion: 1, prompt: null, directionHint: null, items: ids.map(id => item(id)), ...over });
const parsed = (c: unknown) => { const r = parseOrderingConfig(c); if (!r.ok) throw new Error('config'); return r.config; };
const order = (...ids: string[]) => ({ schemaVersion: 1, itemIds: ids });
const codes = (r: ReturnType<typeof validateOrdering>) => (r.ok ? ['OK'] : r.issues.map(i => `${i.itemId}:${i.code}`));
const many = (n: number) => Array.from({ length: n }, (_, i) => `it${i}`);
function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(rest => [x, ...rest]));
}

describe('N3 config: explicit, bounded, versioned, public', () => {
  it('accepts the smallest and the largest list and refuses one less / one more', () => {
    expect(parseOrderingConfig(config(many(ORDERING_MIN_ITEMS))).ok).toBe(true);
    expect(parseOrderingConfig(config(many(ORDERING_MAX_ITEMS))).ok).toBe(true);
    expect(parseOrderingConfig(config(many(ORDERING_MIN_ITEMS - 1))).ok).toBe(false);
    expect(parseOrderingConfig(config([])).ok).toBe(false);
    expect(parseOrderingConfig(config(many(ORDERING_MAX_ITEMS + 1))).ok).toBe(false);
  });
  it('rejects duplicate and dangerous item ids; equal labels with different ids are fine', () => {
    expect(parseOrderingConfig(config(['aa', 'aa'])).ok).toBe(false);
    for (const id of ['__proto__', 'constructor', 'prototype', 'proto', 'Upper', '1abc', 'a b', 'a.b', '', 'x'.repeat(41), 'ä', 'a/b']) {
      expect(parseOrderingConfig(config(['okay', id])).ok, JSON.stringify(id)).toBe(false);
    }
    const same = config(['left', 'right']);
    same.items[0].label = same.items[1].label = 'Gleich';
    expect(parseOrderingConfig(same).ok).toBe(true);
    expect(parseOrderingConfig(config(['a-b_c9', 'x'])).ok).toBe(true);
  });
  it('is strict: no value, date, rank, tie group, solution, reference or seed can ride along — at any level', () => {
    const base = config();
    for (const extra of ['sortValue', 'year', 'date', 'canonicalIndex', 'tieGroup', 'solution', 'reference', 'referenceOrder', 'seed', 'groups']) {
      expect(parseOrderingConfig({ ...base, [extra]: 1 }).ok, `top ${extra}`).toBe(false);
      expect(parseOrderingConfig({ ...base, items: [{ ...base.items[0], [extra]: 1 }, ...base.items.slice(1)] }).ok, `item ${extra}`).toBe(false);
    }
    expect(parseOrderingConfig({ ...base, schemaVersion: 2 }).ok).toBe(false);
    expect(parseOrderingConfig({ ...base, items: [{ itemId: 'aa', label: 'A' }, base.items[1]] }).ok).toBe(false); // help has no default
    expect(parseOrderingConfig({ schemaVersion: 1, items: base.items }).ok).toBe(false); // prompt/directionHint are explicit
    for (const bad of [null, undefined, 'x', 3, [], { schemaVersion: 1 }]) expect(parseOrderingConfig(bad)).toEqual({ ok: false, code: 'ORDERING_CONFIG_INVALID' });
  });
  it('bounds label, help and prompt lengths and refuses blank, padded and control-character texts', () => {
    const withLabel = (label: string) => parseOrderingConfig(config(['aa', 'bb'], { items: [item('aa', { label }), item('bb')] })).ok;
    expect(withLabel('x'.repeat(120))).toBe(true);
    expect(withLabel('x'.repeat(121))).toBe(false);
    for (const bad of ['', ' padded', 'padded ', 'a\nb', 'a\u0000b', 'a‮b', '​', '   ', '\uD800']) expect(withLabel(bad), JSON.stringify(bad)).toBe(false);
    expect(withLabel('Zeile mit Ümläut und 😀')).toBe(true);
    const withHelp = (help: string | null) => parseOrderingConfig(config(['aa', 'bb'], { items: [item('aa', { help }), item('bb')] })).ok;
    expect(withHelp('x'.repeat(200))).toBe(true);
    expect(withHelp('x'.repeat(201))).toBe(false);
    expect(withHelp('')).toBe(false); // exactly one not-set representation: null
    expect(parseOrderingConfig(config(['aa', 'bb'], { prompt: 'x'.repeat(201) })).ok).toBe(false);
    expect(parseOrderingConfig(config(['aa', 'bb'], { directionHint: 'x'.repeat(81) })).ok).toBe(false);
    expect(parseOrderingConfig(config(['aa', 'bb'], { prompt: 'Bringe die Einträge in Reihenfolge', directionHint: 'Oben ist zuerst' })).ok).toBe(true);
  });
  it('uses the same display-text policy as the N2 text card (parity), plus "not blank"', () => {
    const samples = ['ok', 'Ümläut', '😀', ' x', 'x ', 'a\tb', 'a b', 'a‪b', 'a⁦b', 'a﻿b', 'a‍b', '\uDC00', 'a\uD83D', 'x'.repeat(80)];
    for (const s of samples) {
      const n2 = parseTextCardConfig({ schemaVersion: 1, fields: [{ fieldId: 'aa', label: s, help: null, required: true }], maxCodePointsPerField: 5, maxTotalCodePoints: 5 }).ok;
      const n3 = parseOrderingConfig(config(['aa', 'bb'], { items: [item('aa', { label: s }), item('bb')] })).ok;
      expect(n3, JSON.stringify(s)).toBe(n2);
    }
    const blankLooking = '​⁠';
    expect(parseTextCardConfig({ schemaVersion: 1, fields: [{ fieldId: 'aa', label: blankLooking, help: null, required: true }], maxCodePointsPerField: 5, maxTotalCodePoints: 5 }).ok).toBe(true);
    expect(parseOrderingConfig(config(['aa', 'bb'], { items: [item('aa', { label: blankLooking }), item('bb')] })).ok).toBe(false); // invisible item = unusable
  });
  it('keeps the presentation order in the scope key and the item SET in a separate order-independent key; labels are in neither', () => {
    const a = parsed(config(['ab', 'cd', 'ef']));
    const relabeled = parsed({ ...a, items: a.items.map(i => ({ ...i, label: `Neu ${i.itemId}`, help: 'Neue Hilfe' })) });
    const reshuffled = parsed({ ...a, items: [a.items[2], a.items[0], a.items[1]] });
    const otherSet = parsed(config(['ab', 'cd', 'zz']));
    expect(orderingConfigKey(relabeled)).toBe(orderingConfigKey(a));
    expect(orderingConfigKey(reshuffled)).not.toBe(orderingConfigKey(a)); // a re-shuffled start order is a different pinned scope
    expect(orderingItemSetKey(reshuffled)).toBe(orderingItemSetKey(a));
    expect(orderingItemSetKey(relabeled)).toBe(orderingItemSetKey(a));
    expect(orderingItemSetKey(otherSet)).not.toBe(orderingItemSetKey(a));
    expect(orderingConfigKey(otherSet)).not.toBe(orderingConfigKey(a));
    expect(orderingConfigKey(a)).not.toMatch(/Eintrag/); // no label in the key
  });
});

describe('N3 submission: a complete permutation of stable item ids', () => {
  const cfg = parsed(config(['ab', 'cd', 'ef']));
  it('accepts every permutation of the configured items, including the unchanged start order', () => {
    const all = permutations(['ab', 'cd', 'ef']);
    expect(all).toHaveLength(6);
    for (const p of all) {
      const r = validateOrdering(cfg, order(...p));
      expect(r.ok && r.order.itemIds).toEqual(p); // verbatim: never sorted or repaired
    }
    const start = validateOrdering(cfg, order(...cfg.items.map(i => i.itemId)));
    expect(start.ok).toBe(true);
  });
  it('validates the smallest and the largest list', () => {
    const small = parsed(config(many(ORDERING_MIN_ITEMS)));
    expect(validateOrdering(small, order(...many(ORDERING_MIN_ITEMS).reverse())).ok).toBe(true);
    const big = parsed(config(many(ORDERING_MAX_ITEMS)));
    expect(validateOrdering(big, order(...many(ORDERING_MAX_ITEMS).reverse())).ok).toBe(true);
    expect(validateOrdering(big, order(...many(ORDERING_MAX_ITEMS), 'it99')).ok).toBe(false);
  });
  it('refuses missing, extra, duplicate and foreign ids as a whole — nothing is dropped, deduplicated or filled', () => {
    expect(codes(validateOrdering(cfg, order('ab', 'cd')))).toEqual(['ef:ORDER_MISSING_ITEM']);
    expect(codes(validateOrdering(cfg, order()))).toEqual(['ab:ORDER_MISSING_ITEM', 'cd:ORDER_MISSING_ITEM', 'ef:ORDER_MISSING_ITEM']);
    expect(codes(validateOrdering(cfg, order('ab', 'cd', 'ef', 'gh')))).toEqual(['null:ORDER_UNKNOWN_ITEM']);
    expect(codes(validateOrdering(cfg, order('ab', 'ab', 'cd', 'ef')))).toEqual(['ab:ORDER_DUPLICATE_ITEM']);
    expect(codes(validateOrdering(cfg, order('ab', 'ab', 'cd')))).toEqual(['ab:ORDER_DUPLICATE_ITEM', 'ef:ORDER_MISSING_ITEM']); // right length, wrong set
    expect(codes(validateOrdering(cfg, order('ab', 'cd', 'zz')))).toEqual(['null:ORDER_UNKNOWN_ITEM', 'ef:ORDER_MISSING_ITEM']);
    expect(codes(validateOrdering(cfg, order('ab', 'cd', 'AB')))).toContain('null:ORDER_UNKNOWN_ITEM'); // ids are case-sensitive
  });
  it('refuses wrong types, versions, extra keys and non-plain input with controlled codes', () => {
    expect(codes(validateOrdering(cfg, order('ab', 'cd', 3 as never)))).toEqual(['null:ORDER_WRONG_TYPE', 'ef:ORDER_MISSING_ITEM']);
    expect(codes(validateOrdering(cfg, order('ab', 'cd', null as never)))).toContain('null:ORDER_WRONG_TYPE');
    expect(codes(validateOrdering(cfg, { ...order('ab', 'cd', 'ef'), schemaVersion: 2 }))).toEqual(['null:ORDER_MALFORMED']);
    expect(codes(validateOrdering(cfg, { ...order('ab', 'cd', 'ef'), extra: 1 }))).toEqual(['null:ORDER_MALFORMED']);
    expect(codes(validateOrdering(cfg, { schemaVersion: 1 }))).toEqual(['null:ORDER_MALFORMED']);
    expect(codes(validateOrdering(cfg, { schemaVersion: 1, itemIds: 'ab,cd,ef' }))).toEqual(['null:ORDER_MALFORMED']); // no in-band string encoding
    expect(codes(validateOrdering(cfg, { schemaVersion: 1, itemIds: { 0: 'ab', length: 3 } }))).toEqual(['null:ORDER_MALFORMED']);
    for (const bad of [null, undefined, 'ab', 7, ['ab', 'cd', 'ef'], new Date(0), new Map()]) expect(codes(validateOrdering(cfg, bad)), String(bad)).toEqual(['null:ORDER_MALFORMED']);
    class Hostile { schemaVersion = 1; itemIds = ['ab', 'cd', 'ef']; }
    expect(validateOrdering(cfg, new Hostile()).ok).toBe(false);
    const proto = JSON.parse('{"schemaVersion":1,"itemIds":["ab","cd","ef"],"__proto__":{"x":1}}');
    expect(validateOrdering(cfg, proto).ok).toBe(false); // an own __proto__ key is an extra key
  });
  it('bounds the payload before doing any work and never echoes attacker strings in issues', () => {
    const huge = { schemaVersion: 1, itemIds: Array.from({ length: 200_000 }, () => 'ab') };
    const started = Date.now();
    expect(codes(validateOrdering(cfg, huge))).toEqual(['null:ORDER_MALFORMED']);
    expect(Date.now() - started).toBeLessThan(500);
    const long = validateOrdering(cfg, order('ab', 'x'.repeat(100_000), 'ef'));
    expect(long.ok).toBe(false);
    const secret = validateOrdering(cfg, order('ab', 'GEHEIMER-TEXT', '__proto__', 'constructor'));
    expect(JSON.stringify(secret)).not.toMatch(/GEHEIMER|__proto__|constructor/);
  });
  it('does not mutate the input and shares no object with it or with later results', () => {
    const input = order('cd', 'ab', 'ef');
    const snapshot = JSON.stringify(input);
    const r = validateOrdering(cfg, input);
    expect(JSON.stringify(input)).toBe(snapshot);
    if (!r.ok) throw new Error('valid');
    expect(r.order).not.toBe(input);
    expect(r.order.itemIds).not.toBe(input.itemIds);
    input.itemIds.push('zz'); r.order.itemIds.reverse();
    expect(JSON.stringify(order('cd', 'ab', 'ef'))).toBe(JSON.stringify({ schemaVersion: 1, itemIds: ['cd', 'ab', 'ef'] }));
    expect(validateOrdering(cfg, order('cd', 'ab', 'ef')).ok).toBe(true);
    const src = ['ab', 'cd', 'ef'];
    const value = orderingValueFromIds(src);
    src.reverse();
    expect(value.itemIds).toEqual(['ab', 'cd', 'ef']);
  });
  it('keeps duplicate labels apart: the order is by item id, labels are never identity', () => {
    const c = parsed(config(['aa', 'bb', 'cc'], { items: [item('aa', { label: 'Gleich' }), item('bb', { label: 'Gleich' }), item('cc')] }));
    const x = validateOrdering(c, order('bb', 'aa', 'cc')), y = validateOrdering(c, order('aa', 'bb', 'cc'));
    expect(x.ok && y.ok).toBe(true);
    expect(x.ok && x.order.itemIds).not.toEqual(y.ok && y.order.itemIds);
    expect(codes(validateOrdering(c, order('aa', 'aa', 'cc')))).toEqual(['aa:ORDER_DUPLICATE_ITEM', 'bb:ORDER_MISSING_ITEM']); // same label twice is NOT the other item
  });
});

describe('N3 reference: ordered equivalence groups under the pinned item set', () => {
  const cfg = parsed(config(['aa', 'bb', 'cc', 'dd']));
  const ref = (groups: unknown, revision: unknown = 'rev-1') => ({ schemaVersion: 1, revision, groups });
  const bad = (raw: unknown) => { const r = validateOrderingReference(cfg, raw); return r.ok ? ['OK'] : r.issues.map(i => `${i.itemId}:${i.code}`); };
  it('accepts the strict case and grouped references that cover every id exactly once', () => {
    expect(validateOrderingReference(cfg, strictOrderingReference('rev-1', ['cc', 'aa', 'dd', 'bb'])).ok).toBe(true);
    expect(validateOrderingReference(cfg, ref([['aa', 'bb'], ['cc', 'dd']])).ok).toBe(true);
    expect(validateOrderingReference(cfg, ref([['dd', 'cc', 'bb', 'aa']])).ok).toBe(true); // one group = all equivalent
  });
  it('refuses empty, overlapping, missing, unknown and malformed groups', () => {
    expect(bad(ref([['aa'], [], ['bb', 'cc', 'dd']]))).toEqual(['null:REFERENCE_EMPTY_GROUP']);
    expect(bad(ref([['aa', 'bb'], ['bb', 'cc', 'dd']]))).toEqual(['bb:REFERENCE_DUPLICATE_ITEM']);
    expect(bad(ref([['aa'], ['bb'], ['cc']]))).toEqual(['dd:REFERENCE_MISSING_ITEM']);
    expect(bad(ref([['aa'], ['bb'], ['cc'], ['dd'], ['zz']]))).toEqual(['null:REFERENCE_UNKNOWN_ITEM']);
    expect(bad(ref([['aa'], ['bb'], 'cc', ['dd']]))).toEqual(['null:REFERENCE_MALFORMED', 'cc:REFERENCE_MISSING_ITEM']);
    expect(bad(ref([]))).toEqual(['null:REFERENCE_MALFORMED']);
    expect(bad(ref('aa,bb,cc,dd'))).toEqual(['null:REFERENCE_MALFORMED']);
    expect(bad(ref(Array.from({ length: 13 }, () => ['aa'])))).toEqual(['null:REFERENCE_MALFORMED']);
    expect(bad({ ...ref([['aa'], ['bb'], ['cc'], ['dd']]), extra: 1 })).toEqual(['null:REFERENCE_MALFORMED']);
    expect(bad({ ...ref([['aa'], ['bb'], ['cc'], ['dd']]), schemaVersion: 2 })).toEqual(['null:REFERENCE_MALFORMED']);
    for (const revision of ['', ' x', 'a b', 'x'.repeat(81), 5, null, 'ä']) expect(bad(ref([['aa'], ['bb'], ['cc'], ['dd']], revision)), JSON.stringify(revision)).toEqual(['null:REFERENCE_MALFORMED']);
    for (const raw of [null, undefined, [], 'x']) expect(bad(raw)).toEqual(['null:REFERENCE_MALFORMED']);
  });
  it('is validated against the config it is used with: another item set is refused', () => {
    const other = parsed(config(['aa', 'bb', 'cc', 'zz']));
    expect(validateOrderingReference(other, strictOrderingReference('rev-1', ['aa', 'bb', 'cc', 'dd'])).ok).toBe(false);
  });
  it('returns a fresh canonical copy and never echoes unknown strings', () => {
    const input = ref([['aa', 'bb'], ['cc', 'dd']]);
    const r = validateOrderingReference(cfg, input);
    if (!r.ok) throw new Error('valid');
    r.reference.groups[0].reverse();
    expect(input.groups[0]).toEqual(['aa', 'bb']);
    expect(JSON.stringify(validateOrderingReference(cfg, ref([['aa', 'GEHEIM'], ['bb', 'cc', 'dd']])))).not.toContain('GEHEIM');
  });
});

describe('N3 comparison: facts per position, no score, no winner', () => {
  // Labels run against the correct order on purpose: neither labels nor ids may influence the result.
  const cfg = parsed(config(['aa', 'bb', 'cc', 'dd'], { items: [item('aa', { label: 'Z'}), item('bb', { label: 'Y'}), item('cc', { label: 'X'}), item('dd', { label: 'W'})] }));
  const strict = strictOrderingReference('rev-7', ['aa', 'bb', 'cc', 'dd']);
  const compare = (ids: string[], reference: unknown = strict) => compareOrdering(cfg, order(...ids), reference);
  const matches = (ids: string[], reference: unknown = strict) => compare(ids, reference).positions.map(p => (p.matches ? 1 : 0)).join('');
  it('rates the correct order, the complete reverse, a single swap and "no matching position" with hand-derived facts', () => {
    expect(compare(['aa', 'bb', 'cc', 'dd'])).toMatchObject({ contract: 'ORDERING_POSITION_MATCH_V1', referenceRevision: 'rev-7', itemCount: 4, matchedPositions: 4, complete: true });
    expect(matches(['dd', 'cc', 'bb', 'aa'])).toBe('0000');
    expect(compare(['dd', 'cc', 'bb', 'aa'])).toMatchObject({ matchedPositions: 0, complete: false });
    expect(matches(['aa', 'cc', 'bb', 'dd'])).toBe('1001'); // one swap: 2 of 4 stand right
    expect(compare(['aa', 'cc', 'bb', 'dd'])).toMatchObject({ matchedPositions: 2, complete: false });
    expect(matches(['bb', 'cc', 'dd', 'aa'])).toBe('0000'); // rotation: every position wrong
    expect(compare(['aa', 'bb', 'cc', 'dd']).positions).toEqual([
      { position: 1, itemId: 'aa', matches: true }, { position: 2, itemId: 'bb', matches: true },
      { position: 3, itemId: 'cc', matches: true }, { position: 4, itemId: 'dd', matches: true }]);
  });
  it('same set is not enough: all 24 permutations contain the same ids but are told apart by position', () => {
    const results = permutations(['aa', 'bb', 'cc', 'dd']).map(p => ({ p, r: compare(p) }));
    expect(results).toHaveLength(24);
    expect(results.filter(x => x.r.complete).map(x => x.p)).toEqual([['aa', 'bb', 'cc', 'dd']]);
    // independent oracle: positions that equal the reference position
    for (const { p, r } of results) expect(r.matchedPositions).toBe(p.filter((id, i) => id === ['aa', 'bb', 'cc', 'dd'][i]).length);
    // an exact count distribution of the 24 permutations of 4 items: 9 with 0 fixed points, 8 with 1, 6 with 2, 1 with 4
    const histogram = [0, 1, 2, 3, 4].map(k => results.filter(x => x.r.matchedPositions === k).length);
    expect(histogram).toEqual([9, 8, 6, 0, 1]);
  });
  it('evaluates an explicit reference in the other direction without any hidden reversal or label/id sort', () => {
    const descending = strictOrderingReference('rev-d', ['dd', 'cc', 'bb', 'aa']);
    expect(compare(['dd', 'cc', 'bb', 'aa'], descending).complete).toBe(true);
    expect(compare(['aa', 'bb', 'cc', 'dd'], descending)).toMatchObject({ matchedPositions: 0, complete: false });
    const arbitrary = strictOrderingReference('rev-x', ['cc', 'aa', 'dd', 'bb']); // neither id order nor label order
    expect(compare(['cc', 'aa', 'dd', 'bb'], arbitrary).complete).toBe(true);
    expect(compare(['aa', 'bb', 'cc', 'dd'], arbitrary).matchedPositions).toBe(0);
  });
  it('treats grouped references as contiguous position ranges in group order', () => {
    const three = parsed(config(['aa', 'bb', 'cc']));
    const groups = { schemaVersion: 1, revision: 'rev-g', groups: [['aa', 'bb'], ['cc']] };
    const run = (ids: string[]) => compareOrdering(three, order(...ids), groups);
    expect(run(['aa', 'bb', 'cc']).complete).toBe(true);
    expect(run(['bb', 'aa', 'cc']).complete).toBe(true); // alternative inside the explicit group
    expect(run(['cc', 'aa', 'bb'])).toMatchObject({ matchedPositions: 1, complete: false }); // the group moved to the wrong range
    expect(run(['aa', 'cc', 'bb']).positions.map(p => p.matches)).toEqual([true, false, false]); // the group after it is not shifted
    expect(run(['cc', 'bb', 'aa']).positions.map(p => p.matches)).toEqual([false, true, false]);
  });
  it('agrees with an independent oracle that enumerates all allowed permutations (small n only)', () => {
    const four = parsed(config(['aa', 'bb', 'cc', 'dd']));
    const referenceGroups = [[['aa'], ['bb'], ['cc'], ['dd']], [['aa', 'bb'], ['cc', 'dd']], [['aa'], ['bb', 'cc', 'dd']], [['aa', 'bb', 'cc'], ['dd']], [['aa', 'bb', 'cc', 'dd']], [['bb', 'dd'], ['aa'], ['cc']]];
    for (const groups of referenceGroups) {
      // allowed = every concatenation of one permutation per group, in group order
      let allowed: string[][] = [[]];
      for (const g of groups) allowed = allowed.flatMap(prefix => permutations(g).map(p => [...prefix, ...p]));
      const allowedKeys = new Set(allowed.map(a => a.join()));
      for (const p of permutations(['aa', 'bb', 'cc', 'dd'])) {
        const r = compareOrdering(four, order(...p), { schemaVersion: 1, revision: 'r', groups });
        expect(r.complete, `${JSON.stringify(groups)} ${p}`).toBe(allowedKeys.has(p.join()));
      }
    }
  });
  it('works with duplicate labels and yields the same facts whatever the labels are', () => {
    const dup = parsed(config(['aa', 'bb', 'cc'], { items: [item('aa', { label: 'Gleich' }), item('bb', { label: 'Gleich' }), item('cc', { label: 'Gleich' })] }));
    const ref3 = strictOrderingReference('rev-1', ['bb', 'aa', 'cc']);
    expect(compareOrdering(dup, order('bb', 'aa', 'cc'), ref3).complete).toBe(true);
    expect(compareOrdering(dup, order('aa', 'bb', 'cc'), ref3)).toMatchObject({ matchedPositions: 1, complete: false });
  });
  it('is deterministic, free of clock and randomness, and returns fresh objects', () => {
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const a = compare(['bb', 'aa', 'cc', 'dd']), b = compare(['bb', 'aa', 'cc', 'dd']);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a.positions).not.toBe(b.positions);
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); }
  });
  it('refuses invalid orders and references with controlled errors instead of guessing', () => {
    const fail = (fn: () => unknown) => { try { fn(); } catch (e) { return [(e as Error).message, (e as OrderingError).issues.length > 0]; } return ['NO_ERROR', false]; };
    expect(fail(() => compare(['aa', 'bb', 'cc']))).toEqual(['ORDERING_INVALID', true]);
    const full = order('aa', 'bb', 'cc', 'dd');
    expect(fail(() => compareOrdering(cfg, full, null))).toEqual(['ORDERING_REFERENCE_INVALID', true]); // no reference: never guessed
    expect(fail(() => compareOrdering(cfg, full, undefined))).toEqual(['ORDERING_REFERENCE_INVALID', true]);
    expect(fail(() => compare(['aa', 'bb', 'cc', 'dd'], strictOrderingReference('r', ['aa', 'bb', 'cc'])))).toEqual(['ORDERING_REFERENCE_INVALID', true]);
  });
  it('detects an inconsistent stored comparison without needing the reference', () => {
    const value = orderingValueFromIds(['bb', 'aa', 'cc', 'dd']);
    const good = compare(['bb', 'aa', 'cc', 'dd']);
    expect(orderingComparisonMatchesOrder(value, good)).toBe(true);
    expect(orderingComparisonMatchesOrder(value, { ...good, matchedPositions: 4 })).toBe(false);
    expect(orderingComparisonMatchesOrder(value, { ...good, complete: true })).toBe(false);
    expect(orderingComparisonMatchesOrder(value, { ...good, positions: [...good.positions].reverse() })).toBe(false);
    expect(orderingComparisonMatchesOrder(orderingValueFromIds(['aa', 'bb', 'cc', 'dd']), good)).toBe(false);
    expect(orderingComparisonMatchesOrder(value, { ...good, itemCount: 3 })).toBe(false);
  });
});

describe('N3 serialization and runtime', () => {
  it('roundtrips config, reference, submission and comparison through JSON unchanged', () => {
    const c = parsed(config(['aa', 'bb', 'cc'], { prompt: 'Aufgabe', directionHint: 'Oben zuerst', items: [item('aa', { help: 'Hilfe' }), item('bb'), item('cc')] }));
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    const reference = { schemaVersion: 1, revision: 'rev-1', groups: [['aa', 'bb'], ['cc']] };
    const v = validateOrderingReference(c, JSON.parse(JSON.stringify(reference)));
    expect(v.ok && JSON.parse(JSON.stringify(v.reference))).toEqual(reference);
    const o = validateOrdering(c, JSON.parse(JSON.stringify(order('cc', 'aa', 'bb'))));
    expect(o.ok && JSON.parse(JSON.stringify(o.order))).toEqual(order('cc', 'aa', 'bb'));
    const cmp = compareOrdering(c, order('cc', 'aa', 'bb'), reference);
    expect(JSON.parse(JSON.stringify(cmp))).toEqual(cmp);
  });
  it('loads as plain TypeScript in Node strip-only mode, as dist/app.js does with @quiz/shared', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/ordering.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(file)}); const e = new m.OrderingError('ORDERING_INVALID', [{ itemId: null, code: 'ORDER_MALFORMED' }]);
       const cfg = m.OrderingConfigSchema.parse({ schemaVersion: 1, prompt: null, directionHint: null, items: [{ itemId: 'aa', label: 'A', help: null }, { itemId: 'bb', label: 'B', help: null }] });
       const c = m.compareOrdering(cfg, { schemaVersion: 1, itemIds: ['bb', 'aa'] }, m.strictOrderingReference('r1', ['aa', 'bb']));
       console.log(JSON.stringify([e.code, e.message, e.issues.length, c.matchedPositions, c.complete]));`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim())).toEqual(['ORDERING_INVALID', 'ORDERING_INVALID', 1, 0, false]);
  });
});
