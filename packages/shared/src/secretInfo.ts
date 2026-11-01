// ============================================================
// N5 — Secret information contract: CLIENT-SAFE part only (technical foundation, no game rules)
//
// This file holds what may leave the server: the PROJECTION a single viewer receives, the display-text policy, the
// bounds and the code-only errors. The server-private state (role assignments, fragment recipients, release log) is
// deliberately NOT here — it lives in apps/server/src/games/core/secretRoleDeal.ts and must never be imported by the
// browser. Nothing in this file can describe a role, a role distribution, a recipient list or an internal id.
//
// Three things are kept strictly apart (all decided by the later, user-confirmed engine, never by this contract):
//   1) the ROLE that was actually assigned on the server            — never part of a projection;
//   2) KNOWLEDGE explicitly released to ONE participant (`own`)      — title + text only;
//   3) information explicitly released to EVERYBODY (`released`)     — title + text only.
// Holding a role does NOT imply knowing it. A role becomes known only if a later engine explicitly releases a fragment
// that says so. "No fragment" is a valid, neutral state: it is not a missing assignment and not an invalid state.
//
// The scope fields (run, round, deal, revision) are non-secret labels that let the UI bind a projection to the context
// it expects. `dealId` and `revision` MUST be opaque server labels (never derived from a role, a term or a hash of
// secret content); the contract cannot detect an unfortunate label — that is the consumer's duty.
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no parameter properties, and (as in
// voting.ts / ordering.ts / textcard.ts) a self-contained file without relative imports.
// ============================================================

import { z } from 'zod';

export const SECRET_INFO_SCHEMA_VERSION = 1 as const;
export const SECRET_INFO_CONTRACT = 'SECRET_INFO_V1' as const;

/**
 * Protection bounds, not game rules and not player settings. 100 participants is the upper bound the room creation
 * already enforces for `maxPlayers` (http/validators.ts) — the bound must not be lower than a real room. The other
 * limits keep every operation linear and the persisted state small: at most 200 fragments of ≤ 1000 characters and at
 * most 2000 recipient links in total (≈ 0.4 MB even with the maximum id length). Bounds are checked BEFORE any
 * cross-comparison.
 */
export const SECRET_INFO_MAX_PARTICIPANTS = 100;
export const SECRET_INFO_MAX_ROLES = 32;
export const SECRET_INFO_MAX_FRAGMENTS = 200;
export const SECRET_INFO_MAX_RECIPIENT_LINKS = 2000;
export const SECRET_INFO_MAX_ID_LENGTH = 40;
export const SECRET_INFO_MAX_REF_LENGTH = 80;
export const SECRET_INFO_MAX_PARTICIPANT_ID_LENGTH = 200;
export const SECRET_INFO_MAX_ROUND_ID_LENGTH = 200;
export const SECRET_INFO_MAX_TITLE_LENGTH = 80;
export const SECRET_INFO_MAX_TEXT_LENGTH = 1000;
export const SECRET_INFO_MAX_TEXT_LINES = 20;

/** Per-issue codes. They never carry a value, an id or a path — only the kind of violation. */
export const SECRET_INFO_ISSUE_CODES = [
  'SHAPE_INVALID', 'LIMIT_EXCEEDED',
  'PARTICIPANT_DUPLICATE', 'ROLE_DUPLICATE',
  'ASSIGNMENT_UNKNOWN_PARTICIPANT', 'ASSIGNMENT_UNKNOWN_ROLE', 'ASSIGNMENT_DUPLICATE', 'ASSIGNMENT_MISSING',
  'FRAGMENT_DUPLICATE', 'RECIPIENT_UNKNOWN', 'RECIPIENT_DUPLICATE',
  'RELEASE_UNKNOWN_FRAGMENT', 'RELEASE_DUPLICATE', 'RELEASE_EMPTY',
] as const;
export type SecretInfoIssueCode = typeof SECRET_INFO_ISSUE_CODES[number];

/**
 * Wire error codes (the message of the thrown error equals the code). They carry no role, term, recipient list or id.
 * A later consumer reports ONLY this code (plus its own trace id) to the caller and keeps the rest server-side.
 */
export const SECRET_INFO_ERROR_CODES = [
  'SECRET_INFO_DEAL_INVALID', 'SECRET_INFO_STATE_INVALID', 'SECRET_INFO_SCOPE_INVALID',
  'SECRET_INFO_DEAL_STALE', 'SECRET_INFO_REVISION_STALE', 'SECRET_INFO_RELEASE_INVALID',
  'SECRET_INFO_TIME_INVALID', 'SECRET_INFO_AUDIENCE_INVALID', 'SECRET_INFO_PROJECTION_INVALID',
] as const;
export type SecretInfoErrorCode = typeof SECRET_INFO_ERROR_CODES[number];

export class SecretInfoError extends Error {
  readonly code: SecretInfoErrorCode;
  readonly issues: readonly SecretInfoIssueCode[];
  constructor(code: SecretInfoErrorCode, issues: readonly SecretInfoIssueCode[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'SecretInfoError';
  }
}

// ── Field schemas (shared by the client projection and the server-private state) ─────────────

const RESERVED_IDS = ['constructor', 'prototype', 'proto'];
/** Internal, opaque, lowercase identity of a role or a fragment. Server-private: never part of a projection. */
export const SecretInfoIdSchema = z.string().max(SECRET_INFO_MAX_ID_LENGTH)
  .regex(/^[a-z][a-z0-9_-]*$/)
  .refine(id => !RESERVED_IDS.includes(id), 'RESERVED_ID');
/** Opaque server-side label (deal id, revision). Must not encode a role, a term, a recipient or a hash of secret content. */
export const SecretInfoRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(SECRET_INFO_MAX_REF_LENGTH);
export const SecretInfoParticipantIdSchema = z.string().min(1).max(SECRET_INFO_MAX_PARTICIPANT_ID_LENGTH);
export const SecretInfoRoundIdSchema = z.string().min(1).max(SECRET_INFO_MAX_ROUND_ID_LENGTH);
export const SecretInfoRunIndexSchema = z.number().int().safe().positive();

// Display-text policy: the SAME rule as the N2 text card, N3 ordering and N4 voting for single-line text (no surrounding
// white space, no control/bidi characters, no lone surrogates, not blank). Duplicated on purpose — shared contracts are
// self-contained files (plain Node in strip-only mode cannot resolve sibling `.js` imports of `.ts`). A parity test pins
// the title rule to N4. The fragment TEXT additionally allows plain line feeds (U+000A) — no other control character,
// no carriage return — and at most SECRET_INFO_MAX_TEXT_LINES lines. It is rendered as plain text, never as markup.
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BLANK = /^(?:\p{White_Space}|[\u200B\u200C\u2060\uFEFF]|\u200D)*$/u;
export const SecretInfoTitleSchema = z.string().min(1).max(SECRET_INFO_MAX_TITLE_LENGTH)
  .refine(text => text === text.trim() && !FORBIDDEN.test(text) && !LONE_SURROGATE.test(text), 'DISPLAY_TEXT_INVALID')
  .refine(text => !BLANK.test(text), 'DISPLAY_TEXT_BLANK');
export const SecretInfoTextSchema = z.string().min(1).max(SECRET_INFO_MAX_TEXT_LENGTH)
  .refine(text => text === text.trim() && !FORBIDDEN.test(text.replace(/\n/g, '')) && !LONE_SURROGATE.test(text)
    && text.split('\n').length <= SECRET_INFO_MAX_TEXT_LINES, 'DISPLAY_TEXT_INVALID')
  .refine(text => !BLANK.test(text), 'DISPLAY_TEXT_BLANK');

// ── Client projection ────────────────────────────────────────

/** Non-secret binding of a projection to the context the caller expects. Labels only. */
export const SecretInfoScopeSchema = z.object({
  runIndex: SecretInfoRunIndexSchema,
  roundId: SecretInfoRoundIdSchema,
  dealId: SecretInfoRefSchema,
  revision: SecretInfoRefSchema,
}).strict();
export type SecretInfoScope = z.infer<typeof SecretInfoScopeSchema>;

/** One piece of readable information. No id, no recipient, no role: nothing but what the viewer may read. */
export const SecretInfoFragmentViewSchema = z.object({
  title: SecretInfoTitleSchema,
  text: SecretInfoTextSchema,
}).strict();
export type SecretInfoFragmentView = z.infer<typeof SecretInfoFragmentViewSchema>;

/**
 * What ONE caller may receive. `own` exists only for a participant who is on the deal AND is projected with the PLAYER
 * information role; it holds exactly the fragments released to that participant (possibly none) and nothing about the
 * actual role, the distribution, other participants or other fragments. `released` holds exactly the fragments that were
 * explicitly released to everybody, in the deal's fixed fragment order. Public release never exposes the original
 * recipients or any role.
 */
export const SecretInfoProjectionSchema = z.object({
  contract: z.literal(SECRET_INFO_CONTRACT),
  scope: SecretInfoScopeSchema,
  own: z.object({
    participantId: SecretInfoParticipantIdSchema,
    fragments: z.array(SecretInfoFragmentViewSchema).max(SECRET_INFO_MAX_FRAGMENTS),
  }).strict().nullable(),
  released: z.array(SecretInfoFragmentViewSchema).max(SECRET_INFO_MAX_FRAGMENTS),
}).strict();
export type SecretInfoProjection = z.infer<typeof SecretInfoProjectionSchema>;

export type SecretInfoProjectionResult = { ok: true; projection: SecretInfoProjection } | { ok: false; code: 'SECRET_INFO_PROJECTION_INVALID' };
/** Failure carries a code only: no values, no zod paths. Returns a fresh copy. */
export function parseSecretInfoProjection(raw: unknown): SecretInfoProjectionResult {
  const parsed = SecretInfoProjectionSchema.safeParse(raw);
  return parsed.success ? { ok: true, projection: parsed.data } : { ok: false, code: 'SECRET_INFO_PROJECTION_INVALID' };
}

/** What the UI's own authenticated context expects: the scope plus the participant the view is for. */
export interface SecretInfoExpectedContext extends SecretInfoScope { participantId: string }

/**
 * True iff a (valid) projection is bound to exactly the expected run, round, deal, revision AND recipient. A foreign or
 * stale projection, a projection without a private part, or one for another participant is never usable.
 */
export function secretInfoProjectionMatches(projection: SecretInfoProjection, expected: SecretInfoExpectedContext): boolean {
  return projection.own !== null && projection.own.participantId === expected.participantId
    && projection.scope.runIndex === expected.runIndex && projection.scope.roundId === expected.roundId
    && projection.scope.dealId === expected.dealId && projection.scope.revision === expected.revision;
}

/** Public UI context key: run, round, deal, revision and recipient. Labels only — never fragment content. */
export function secretInfoContextKey(expected: SecretInfoExpectedContext): string {
  return JSON.stringify(['SECRET_INFO', expected.runIndex, expected.roundId, expected.dealId, expected.revision, expected.participantId]);
}
