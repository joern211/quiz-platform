// ============================================================
// N3 — Ordering contract (technical foundation, no game rules)
//
// A private answer is ONE complete ordering of the configured items: a
// permutation of stable item ids. Shape on the wire and in persistence
// (no in-band string encoding, no labels as identity):
//   { schemaVersion: 1, itemIds: [itemId, ...] }
// Every configured item appears exactly once. Missing, unknown, duplicate or
// foreign ids, wrong types, wrong versions and extra keys are rejected as a
// whole — nothing is sorted, de-duplicated, dropped or filled up. A partial
// list is never an answer (an unconfirmed UI draft is not a server submission).
//
// Three things are kept strictly apart:
//   A) PUBLIC: the config below (item ids, labels, help, PRESENTATION order).
//      Its strict schema has no room for a value, date, solution or reference.
//   B) PRIVATE per participant: the submitted order.
//   C) PRIVATE server data: the REFERENCE (ordered equivalence groups) and the
//      comparison facts derived from it. The reference is supplied by the
//      server-side engine setup; this contract never derives it from labels,
//      ids, dates or numbers, and never stores it in a client-bound key.
//
// Comparison (ORDERING_POSITION_MATCH_V1) states facts only: which submitted
// position matches the reference and how many. It is NOT a score, a winner or
// a tie rule. Whether equal years/numbers form an equivalence group is a later,
// user-confirmed engine decision (open: DEC-TIM-01); direction (ascending/
// descending) is expressed by how the engine builds the reference — never by a
// hidden reversal here.
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no
// parameter properties.
// ============================================================

import { z } from 'zod';

export const ORDERING_SCHEMA_VERSION = 1 as const;
export const ORDERING_COMPARISON_CONTRACT = 'ORDERING_POSITION_MATCH_V1' as const;
/**
 * Protection bounds, not game rules. Two items is the smallest list that carries order information; 12 keeps a
 * reorder list usable on a phone and the whole public config far below 5 KB. Nothing here enumerates permutations.
 */
export const ORDERING_MIN_ITEMS = 2;
export const ORDERING_MAX_ITEMS = 12;
export const ORDERING_MAX_ID_LENGTH = 40;
export const ORDERING_MAX_LABEL_LENGTH = 120;
export const ORDERING_MAX_HELP_LENGTH = 200;
export const ORDERING_MAX_PROMPT_LENGTH = 200;
export const ORDERING_MAX_DIRECTION_LENGTH = 80;
export const ORDERING_MAX_REVISION_LENGTH = 80;

/** Per-issue codes (each with a safe, CONFIGURED itemId or null — never an echoed attacker string). */
export const ORDERING_ISSUE_CODES = [
  'ORDER_MALFORMED', 'ORDER_UNKNOWN_ITEM', 'ORDER_DUPLICATE_ITEM', 'ORDER_MISSING_ITEM', 'ORDER_WRONG_TYPE',
  'REFERENCE_MALFORMED', 'REFERENCE_EMPTY_GROUP', 'REFERENCE_UNKNOWN_ITEM', 'REFERENCE_DUPLICATE_ITEM', 'REFERENCE_MISSING_ITEM',
] as const;
export type OrderingIssueCode = typeof ORDERING_ISSUE_CODES[number];
/** Wire error codes (the message of the thrown error equals the code, like CoreRuleError). They carry no order, id lists or reference data. */
export const ORDERING_ERROR_CODES = [
  'ORDERING_INVALID', 'ORDERING_CONFIG_INVALID', 'ORDERING_CONFIG_STALE', 'ORDERING_STATE_INVALID',
  'ORDERING_ROUND_CLOSED', 'ORDERING_NOT_CLOSED', 'ORDERING_STALE_SUBMISSION', 'ORDERING_ALREADY_COMPARED',
  'ORDERING_NOT_FOUND', 'ORDERING_REFERENCE_MISSING', 'ORDERING_REFERENCE_INVALID', 'ORDERING_REFERENCE_STALE',
] as const;
export type OrderingErrorCode = typeof ORDERING_ERROR_CODES[number];

export interface OrderingIssue { itemId: string | null; code: OrderingIssueCode }

export class OrderingError extends Error {
  readonly code: OrderingErrorCode;
  readonly issues: readonly OrderingIssue[];
  constructor(code: OrderingErrorCode, issues: readonly OrderingIssue[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'OrderingError';
  }
}

// ── Config (versioned, public) ───────────────────────────────

const RESERVED_IDS = ['constructor', 'prototype', 'proto'];
/** Opaque, stable, lowercase. A later engine must NOT encode a sort value, date or rank in the id (it is public). */
export const OrderingItemIdSchema = z.string().max(ORDERING_MAX_ID_LENGTH)
  .regex(/^[a-z][a-z0-9_-]*$/)
  .refine(id => !RESERVED_IDS.includes(id), 'RESERVED_ID');

// Display-text policy: the SAME rule as the N2 text card (no surrounding white space, no control/bidi characters, no
// lone surrogates), plus: not blank. Duplicated on purpose — shared contracts are self-contained files, because plain
// Node (strip-only) cannot resolve sibling `.js` imports of `.ts` sources. A parity test pins both policies together.
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BLANK = /^(?:\p{White_Space}|[\u200B\u200C\u2060\uFEFF]|\u200D)*$/u;
const displayText = (max: number) => z.string().min(1).max(max)
  .refine(text => text === text.trim() && !FORBIDDEN.test(text) && !LONE_SURROGATE.test(text), 'DISPLAY_TEXT_INVALID')
  .refine(text => !BLANK.test(text), 'DISPLAY_TEXT_BLANK');

export const OrderingItemDefSchema = z.object({
  itemId: OrderingItemIdSchema,
  /** Display only and NOT an identity: two items may share a label. */
  label: displayText(ORDERING_MAX_LABEL_LENGTH),
  help: displayText(ORDERING_MAX_HELP_LENGTH).nullable(),
}).strict();
export type OrderingItemDef = z.infer<typeof OrderingItemDefSchema>;

export const OrderingConfigSchema = z.object({
  schemaVersion: z.literal(ORDERING_SCHEMA_VERSION),
  /** Public task text. Display only: nothing is derived from it. */
  prompt: displayText(ORDERING_MAX_PROMPT_LENGTH).nullable(),
  /** Public direction text (e.g. what "top" means). Display only: no comparison reads it. */
  directionHint: displayText(ORDERING_MAX_DIRECTION_LENGTH).nullable(),
  /** In PRESENTATION order — the start order shown to the player. It is not the solution and says nothing about it. */
  items: z.array(OrderingItemDefSchema).min(ORDERING_MIN_ITEMS).max(ORDERING_MAX_ITEMS),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.items.map(i => i.itemId)).size !== config.items.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DUPLICATE_ITEM_ID' });
  }
});
export type OrderingConfig = z.infer<typeof OrderingConfigSchema>;

export type OrderingConfigResult = { ok: true; config: OrderingConfig } | { ok: false; code: 'ORDERING_CONFIG_INVALID' };
/** Failure carries a code only: no values, no zod paths. Usable by client and server (the config is public). */
export function parseOrderingConfig(raw: unknown): OrderingConfigResult {
  const parsed = OrderingConfigSchema.safeParse(raw);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, code: 'ORDERING_CONFIG_INVALID' };
}

/**
 * Server-side identity of everything that decides how a stored order is interpreted: schema version and the item
 * ids IN PRESENTATION ORDER (a re-shuffled start order after a rejoin is therefore a different, rejected scope).
 * Labels, help and texts are display-only and excluded. Contains public data only; never the reference.
 */
export function orderingConfigKey(config: OrderingConfig): string {
  return JSON.stringify([config.schemaVersion, config.items.map(i => i.itemId)]);
}
/**
 * Order-independent identity of the item SET (schema version + sorted ids). The UI keeps a draft across a mere
 * metadata re-ordering of the same ids; a changed set is a different task.
 */
export function orderingItemSetKey(config: OrderingConfig): string {
  return JSON.stringify([config.schemaVersion, config.items.map(i => i.itemId).sort()]);
}

// ── Submission ───────────────────────────────────────────────

export const OrderingValueSchema = z.object({
  schemaVersion: z.literal(ORDERING_SCHEMA_VERSION),
  itemIds: z.array(OrderingItemIdSchema).min(ORDERING_MIN_ITEMS).max(ORDERING_MAX_ITEMS),
}).strict();
export type OrderingValue = z.infer<typeof OrderingValueSchema>;

export type OrderingValidation = { ok: true; order: OrderingValue } | { ok: false; issues: OrderingIssue[] };

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural + set validation of ONE submitted order under the pinned config. Collects all issues (bounded by the
 * maximum item count) so a UI can explain them; nothing is accepted partially. Hand-rolled instead of zod so
 * that issue codes stay stable and attacker-supplied ids are never echoed. The returned order is a fresh object
 * (the input is never mutated or reused). The caller's order is kept verbatim: no sorting, no repair.
 */
export function validateOrdering(config: OrderingConfig, input: unknown): OrderingValidation {
  const malformed = (): OrderingValidation => ({ ok: false, issues: [{ itemId: null, code: 'ORDER_MALFORMED' }] });
  if (!plainObject(input)) return malformed();
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('schemaVersion') || !keys.includes('itemIds')) return malformed();
  if (input.schemaVersion !== ORDERING_SCHEMA_VERSION || !Array.isArray(input.itemIds)) return malformed();
  const ids: unknown[] = input.itemIds;
  if (ids.length > ORDERING_MAX_ITEMS) return malformed(); // bound before iterating

  const known = new Set(config.items.map(i => i.itemId));
  const seen = new Set<string>();
  const issues: OrderingIssue[] = [];
  for (const entry of ids) {
    if (typeof entry !== 'string') { issues.push({ itemId: null, code: 'ORDER_WRONG_TYPE' }); continue; }
    if (entry.length > ORDERING_MAX_ID_LENGTH || !known.has(entry)) { issues.push({ itemId: null, code: 'ORDER_UNKNOWN_ITEM' }); continue; }
    if (seen.has(entry)) { issues.push({ itemId: entry, code: 'ORDER_DUPLICATE_ITEM' }); continue; }
    seen.add(entry);
  }
  for (const def of config.items) if (!seen.has(def.itemId)) issues.push({ itemId: def.itemId, code: 'ORDER_MISSING_ITEM' });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, order: { schemaVersion: ORDERING_SCHEMA_VERSION, itemIds: [...(ids as string[])] } };
}

/** UI boundary: builds the wire value from the visible item ids (a copy; the input is not kept). */
export function orderingValueFromIds(itemIds: readonly string[]): OrderingValue {
  return { schemaVersion: ORDERING_SCHEMA_VERSION, itemIds: [...itemIds] };
}

// ── Reference (server-side, private) ─────────────────────────

export const OrderingRevisionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(ORDERING_MAX_REVISION_LENGTH);
/**
 * The correct order as ORDERED EQUIVALENCE GROUPS. The strict case is one item per group. Group g occupies the
 * contiguous positions its size reserves, after all earlier groups: [[a,b],[c]] accepts a,b,c and b,a,c — c,a,b
 * is not fully correct. Every configured id appears exactly once over all non-empty groups; overlapping or
 * alternative sets cannot be expressed, so nothing is ever enumerated. `revision` is an OPAQUE label of the
 * server-side content revision: it must not encode the order (it is pinned in states and may be echoed after reveal).
 */
export const OrderingReferenceSchema = z.object({
  schemaVersion: z.literal(ORDERING_SCHEMA_VERSION),
  revision: OrderingRevisionSchema,
  groups: z.array(z.array(OrderingItemIdSchema).min(1).max(ORDERING_MAX_ITEMS)).min(1).max(ORDERING_MAX_ITEMS),
}).strict();
export type OrderingReference = z.infer<typeof OrderingReferenceSchema>;

export type OrderingReferenceValidation = { ok: true; reference: OrderingReference } | { ok: false; code: 'ORDERING_REFERENCE_INVALID'; issues: OrderingIssue[] };

/** The strict reference: one item per group, in exactly the given order. A convenience for engines; it derives nothing. */
export function strictOrderingReference(revision: string, itemIds: readonly string[]): unknown {
  return { schemaVersion: ORDERING_SCHEMA_VERSION, revision, groups: itemIds.map(id => [id]) };
}

/** Validates a reference under the pinned item set. Returns a fresh canonical copy; the input is never reused. */
export function validateOrderingReference(config: OrderingConfig, input: unknown): OrderingReferenceValidation {
  const fail = (issues: OrderingIssue[]): OrderingReferenceValidation => ({ ok: false, code: 'ORDERING_REFERENCE_INVALID', issues });
  const malformed = () => fail([{ itemId: null, code: 'REFERENCE_MALFORMED' }]);
  if (!plainObject(input)) return malformed();
  const keys = Object.keys(input);
  if (keys.length !== 3 || !keys.includes('schemaVersion') || !keys.includes('revision') || !keys.includes('groups')) return malformed();
  if (input.schemaVersion !== ORDERING_SCHEMA_VERSION || !OrderingRevisionSchema.safeParse(input.revision).success || !Array.isArray(input.groups)) return malformed();
  const groups: unknown[] = input.groups;
  if (groups.length < 1 || groups.length > ORDERING_MAX_ITEMS) return malformed(); // bound before iterating

  const known = new Set(config.items.map(i => i.itemId));
  const seen = new Set<string>();
  const issues: OrderingIssue[] = [];
  const copy: string[][] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) { issues.push({ itemId: null, code: 'REFERENCE_MALFORMED' }); continue; }
    if (group.length === 0) { issues.push({ itemId: null, code: 'REFERENCE_EMPTY_GROUP' }); continue; }
    if (group.length > ORDERING_MAX_ITEMS) { issues.push({ itemId: null, code: 'REFERENCE_MALFORMED' }); continue; }
    const members: string[] = [];
    for (const entry of group) {
      if (typeof entry !== 'string' || entry.length > ORDERING_MAX_ID_LENGTH || !known.has(entry)) { issues.push({ itemId: null, code: 'REFERENCE_UNKNOWN_ITEM' }); continue; }
      if (seen.has(entry)) { issues.push({ itemId: entry, code: 'REFERENCE_DUPLICATE_ITEM' }); continue; }
      seen.add(entry);
      members.push(entry);
    }
    copy.push(members);
  }
  for (const def of config.items) if (!seen.has(def.itemId)) issues.push({ itemId: def.itemId, code: 'REFERENCE_MISSING_ITEM' });
  if (issues.length > 0) return fail(issues);
  return { ok: true, reference: { schemaVersion: ORDERING_SCHEMA_VERSION, revision: input.revision as string, groups: copy } };
}

// ── Comparison (facts only — no score, no winner) ────────────

export const OrderingPositionFactSchema = z.object({
  /** 1-based position as the participant submitted it. */
  position: z.number().int().min(1).max(ORDERING_MAX_ITEMS),
  itemId: OrderingItemIdSchema,
  /** True iff this item stands inside the position range its reference group occupies. */
  matches: z.boolean(),
}).strict();
export const OrderingComparisonSchema = z.object({
  contract: z.literal(ORDERING_COMPARISON_CONTRACT),
  referenceRevision: OrderingRevisionSchema,
  itemCount: z.number().int().min(ORDERING_MIN_ITEMS).max(ORDERING_MAX_ITEMS),
  matchedPositions: z.number().int().min(0).max(ORDERING_MAX_ITEMS),
  complete: z.boolean(),
  positions: z.array(OrderingPositionFactSchema).min(ORDERING_MIN_ITEMS).max(ORDERING_MAX_ITEMS),
}).strict();
export type OrderingComparison = z.infer<typeof OrderingComparisonSchema>;

/**
 * Deterministic position comparison under the pinned config. Pure integer arithmetic over at most
 * ORDERING_MAX_ITEMS entries; no clock, randomness, locale, label or id ordering. Both inputs are validated here
 * (the result never rests on a caller's claim). Returns a fresh object.
 */
export function compareOrdering(config: OrderingConfig, order: unknown, reference: unknown): OrderingComparison {
  const value = validateOrdering(config, order);
  if (!value.ok) throw new OrderingError('ORDERING_INVALID', value.issues);
  const ref = validateOrderingReference(config, reference);
  if (!ref.ok) throw new OrderingError('ORDERING_REFERENCE_INVALID', ref.issues);
  const ranges = new Map<string, { start: number; end: number }>();
  let start = 0;
  for (const group of ref.reference.groups) {
    const range = { start, end: start + group.length };
    for (const id of group) ranges.set(id, range);
    start = range.end;
  }
  const positions = value.order.itemIds.map((itemId, index) => {
    const range = ranges.get(itemId) as { start: number; end: number };
    return { position: index + 1, itemId, matches: index >= range.start && index < range.end };
  });
  const matchedPositions = positions.filter(p => p.matches).length;
  return { contract: ORDERING_COMPARISON_CONTRACT, referenceRevision: ref.reference.revision, itemCount: positions.length,
    matchedPositions, complete: matchedPositions === positions.length, positions };
}

/** Internal consistency of a STORED comparison against the stored order (no reference needed). True iff consistent. */
export function orderingComparisonMatchesOrder(order: OrderingValue, comparison: OrderingComparison): boolean {
  if (comparison.itemCount !== order.itemIds.length || comparison.positions.length !== order.itemIds.length) return false;
  let matched = 0;
  for (let i = 0; i < order.itemIds.length; i++) {
    const fact = comparison.positions[i];
    if (fact.position !== i + 1 || fact.itemId !== order.itemIds[i]) return false;
    if (fact.matches) matched++;
  }
  return comparison.matchedPositions === matched && comparison.complete === (matched === order.itemIds.length);
}
