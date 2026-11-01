// ============================================================
// N5 — Secret role deal (domain building block, SERVER-PRIVATE)
//
// One immutable, explicitly prepared deal for a fixed circle of participants: WHICH role each participant actually holds
// on the server, WHICH information fragments exist, to WHOM each fragment is explicitly released, and WHICH fragments were
// explicitly released to everybody. It is not an ACL system, not a rules interpreter and not an engine.
//
// Held role ≠ known role. The role assignment never reaches any projection by itself; a participant learns his role only
// if a later engine puts that knowledge into a fragment addressed to him. Fragments are independent of roles: the same
// role may carry different knowledge, one fragment may address several participants, a participant may hold a role and no
// fragment at all. There is no inheritance from role, team or host rights.
//
// What this module does NOT do (the later real consumer must): authenticate anybody, decide a phase, choose roles or
// terms, draw randomness, read a clock, persist, send. `audience`, the expected scope and `now` come from the server's
// admission/command boundary — never from a client payload. The pinned participant list is a ROSTER, not an
// authentication: current session, membership, kick, right changes and host transfer are checked by the consumer at the
// moment of the call. No clock and no RNG are used anywhere in here, so validation, replay, rejoin and recovery never
// re-deal or re-time anything.
//
// Immutability: assignments, recipients and fragment contents are fixed at creation. There is no reassign / edit /
// transfer. The only later change is the additive, idempotent public release (`releaseSecretInformation`). Every function
// returns fresh objects and keeps no reference to its input.
//
// Revision: an opaque label chosen by the creator. It is bound to the frozen deal; a factually different deal must get a
// new `dealId`/`revision`. The helper cannot enforce uniqueness across deals — the consumer must mint the label once and
// persist it uniquely (e.g. a unique key on room + run + round + dealId). It must NOT be derived from roles or terms (not
// even as a hash: a small term space can be brute-forced).
//
// Errors: code only (see SECRET_INFO_ERROR_CODES). Issues are code-only too and may be logged server-side; no id, role,
// term, recipient or raw state ever appears in a message, an issue or a zod path.
// ============================================================

import { z } from 'zod';
import {
  SECRET_INFO_CONTRACT, SECRET_INFO_ISSUE_CODES, SECRET_INFO_MAX_FRAGMENTS, SECRET_INFO_MAX_PARTICIPANTS,
  SECRET_INFO_MAX_RECIPIENT_LINKS, SECRET_INFO_MAX_ROLES, SECRET_INFO_SCHEMA_VERSION,
  SecretInfoError, SecretInfoIdSchema, SecretInfoParticipantIdSchema, SecretInfoProjectionSchema, SecretInfoRefSchema,
  SecretInfoRoundIdSchema, SecretInfoRunIndexSchema, SecretInfoScopeSchema, SecretInfoTextSchema, SecretInfoTitleSchema,
  type SecretInfoIssueCode, type SecretInfoProjection, type SecretInfoScope,
} from '@quiz/shared/secretInfo';
import { CoreRuleError } from './runtimePrimitives.js';
import { canView, type ProjectionAudience } from './visibility.js';

// ── Persisted state (server-private) ─────────────────────────

const AssignmentSchema = z.object({ participantId: SecretInfoParticipantIdSchema, roleId: SecretInfoIdSchema }).strict();
const FragmentSchema = z.object({
  fragmentId: SecretInfoIdSchema,
  title: SecretInfoTitleSchema,
  text: SecretInfoTextSchema,
  /** Explicit recipients. Empty = exists on the server only until it is explicitly released publicly. */
  recipientIds: z.array(SecretInfoParticipantIdSchema).max(SECRET_INFO_MAX_PARTICIPANTS),
}).strict();
const ReleaseSchema = z.object({
  fragmentId: SecretInfoIdSchema,
  /** Server time supplied by the caller at the FIRST release. Server-private: never projected, never decisive. */
  releasedAtMs: z.number().int().safe().nonnegative(),
}).strict();

/**
 * The persisted deal. Everything in it is SERVER-PRIVATE. Loading re-validates structure AND invariants; nothing is
 * repaired, completed, truncated or silently dropped.
 */
export const SecretRoleDealStateSchema = z.object({
  kind: z.literal('SECRET_ROLE_DEAL'),
  schemaVersion: z.literal(SECRET_INFO_SCHEMA_VERSION),
  runIndex: SecretInfoRunIndexSchema,
  roundId: SecretInfoRoundIdSchema,
  /** Distinguishes several deals of the same round. */
  dealId: SecretInfoRefSchema,
  /** Opaque revision of THIS frozen deal (see header). */
  revision: SecretInfoRefSchema,
  /** The pinned circle, in the given order (the order of the creator is kept). */
  participantIds: z.array(SecretInfoParticipantIdSchema).min(1).max(SECRET_INFO_MAX_PARTICIPANTS),
  /** The known role ids. A role may be assigned to several participants, and may be assigned to nobody. */
  roleIds: z.array(SecretInfoIdSchema).min(1).max(SECRET_INFO_MAX_ROLES),
  /** Exactly one per pinned participant. */
  assignments: z.array(AssignmentSchema).max(SECRET_INFO_MAX_PARTICIPANTS),
  fragments: z.array(FragmentSchema).max(SECRET_INFO_MAX_FRAGMENTS),
  /** Additive log of publicly released fragments, in fragment order. Initially empty. */
  released: z.array(ReleaseSchema).max(SECRET_INFO_MAX_FRAGMENTS),
}).strict().superRefine((state, ctx) => {
  const bad = (code: SecretInfoIssueCode) => ctx.addIssue({ code: z.ZodIssueCode.custom, message: code });
  // Refinements also run for "dirty" (e.g. over-long) arrays: bound everything BEFORE any cross-comparison.
  let links = 0;
  for (const fragment of state.fragments) links += fragment.recipientIds.length > SECRET_INFO_MAX_PARTICIPANTS ? SECRET_INFO_MAX_RECIPIENT_LINKS + 1 : fragment.recipientIds.length;
  if (state.participantIds.length > SECRET_INFO_MAX_PARTICIPANTS || state.roleIds.length > SECRET_INFO_MAX_ROLES
    || state.assignments.length > SECRET_INFO_MAX_PARTICIPANTS || state.fragments.length > SECRET_INFO_MAX_FRAGMENTS
    || state.released.length > SECRET_INFO_MAX_FRAGMENTS || links > SECRET_INFO_MAX_RECIPIENT_LINKS) { bad('LIMIT_EXCEEDED'); return; }

  const participants = new Set(state.participantIds);
  if (participants.size !== state.participantIds.length) bad('PARTICIPANT_DUPLICATE');
  const roles = new Set(state.roleIds);
  if (roles.size !== state.roleIds.length) bad('ROLE_DUPLICATE');

  const assigned = new Set<string>();
  for (const assignment of state.assignments) {
    if (!participants.has(assignment.participantId)) bad('ASSIGNMENT_UNKNOWN_PARTICIPANT');
    if (!roles.has(assignment.roleId)) bad('ASSIGNMENT_UNKNOWN_ROLE');
    if (assigned.has(assignment.participantId)) bad('ASSIGNMENT_DUPLICATE');
    assigned.add(assignment.participantId);
  }
  if (!state.participantIds.every(id => assigned.has(id))) bad('ASSIGNMENT_MISSING');

  const fragmentIds = new Set<string>();
  for (const fragment of state.fragments) {
    if (fragmentIds.has(fragment.fragmentId)) bad('FRAGMENT_DUPLICATE');
    fragmentIds.add(fragment.fragmentId);
    const seen = new Set<string>();
    for (const recipient of fragment.recipientIds) {
      if (!participants.has(recipient)) bad('RECIPIENT_UNKNOWN');
      if (seen.has(recipient)) bad('RECIPIENT_DUPLICATE');
      seen.add(recipient);
    }
  }
  const releasedIds = new Set<string>();
  for (const release of state.released) {
    if (!fragmentIds.has(release.fragmentId)) bad('RELEASE_UNKNOWN_FRAGMENT');
    if (releasedIds.has(release.fragmentId)) bad('RELEASE_DUPLICATE');
    releasedIds.add(release.fragmentId);
  }
});
export type SecretRoleDealState = z.infer<typeof SecretRoleDealStateSchema>;

/** Only our own custom codes survive; every other (structural) zod message — which may echo input — becomes SHAPE_INVALID. */
function issueCodesOf(error: z.ZodError): SecretInfoIssueCode[] {
  const known = SECRET_INFO_ISSUE_CODES as readonly string[];
  const codes: SecretInfoIssueCode[] = [];
  for (const issue of error.issues) {
    const code = (issue.code === 'custom' && known.includes(issue.message) ? issue.message : 'SHAPE_INVALID') as SecretInfoIssueCode;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** Validates a stored / loaded deal. A damaged or manipulated state is rejected as a whole (no repair). */
export function parseSecretRoleDealState(raw: unknown): SecretRoleDealState {
  const parsed = SecretRoleDealStateSchema.safeParse(raw);
  if (!parsed.success) throw new SecretInfoError('SECRET_INFO_STATE_INVALID', issueCodesOf(parsed.error));
  return parsed.data;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => own.includes(key));
};

// ── Creation ─────────────────────────────────────────────────

const DEAL_INPUT_KEYS = ['runIndex', 'roundId', 'dealId', 'revision', 'participantIds', 'roleIds', 'assignments', 'fragments'] as const;

/**
 * Creates the frozen deal from CONCRETE, server-decided assignments. There is no "AUTO", no implicit n−1, no client
 * randomness and no role preset: every participant is listed with exactly one known role, every fragment with its explicit
 * recipients (possibly none). Anything unknown, duplicated, missing or additional is rejected as a whole. Nothing is
 * released. The input is not retained; assignments and recipients are stored in the order of `participantIds` (set
 * semantics: their given order carries no meaning), fragments keep the given order (it fixes the output order).
 */
export function createSecretRoleDeal(input: unknown): SecretRoleDealState {
  const invalid = (issues: SecretInfoIssueCode[] = ['SHAPE_INVALID']) => new SecretInfoError('SECRET_INFO_DEAL_INVALID', issues);
  if (!isPlain(input) || !hasExactKeys(input, DEAL_INPUT_KEYS)) throw invalid();
  const candidate = {
    kind: 'SECRET_ROLE_DEAL', schemaVersion: SECRET_INFO_SCHEMA_VERSION,
    runIndex: input.runIndex, roundId: input.roundId, dealId: input.dealId, revision: input.revision,
    participantIds: input.participantIds, roleIds: input.roleIds, assignments: input.assignments, fragments: input.fragments, released: [],
  };
  const parsed = SecretRoleDealStateSchema.safeParse(candidate);
  if (!parsed.success) throw invalid(issueCodesOf(parsed.error));
  const state = parsed.data;
  const order = new Map(state.participantIds.map((id, index) => [id, index] as const));
  const byRoster = (a: string, b: string) => (order.get(a) as number) - (order.get(b) as number);
  const canonical: SecretRoleDealState = {
    ...state,
    assignments: [...state.assignments].sort((a, b) => byRoster(a.participantId, b.participantId)),
    fragments: state.fragments.map(f => ({ ...f, recipientIds: [...f.recipientIds].sort(byRoster) })),
  };
  return parseSecretRoleDealState(canonical);
}

// ── Scope ────────────────────────────────────────────────────

/** What the caller currently considers authoritative (from its own server-side context); any difference means stale. */
export type SecretRoleDealScope = SecretInfoScope;
export function secretRoleDealScopeOf(state: SecretRoleDealState): SecretRoleDealScope {
  return { runIndex: state.runIndex, roundId: state.roundId, dealId: state.dealId, revision: state.revision };
}

/**
 * Fixed error semantics for EVERY stale access (mutation and projection alike — a stale projection is rejected, never
 * "empty"): a malformed expected scope → SECRET_INFO_SCOPE_INVALID; another run or round → STALE_ROUND (the existing public
 * code); another deal of the same round → SECRET_INFO_DEAL_STALE; another pinned revision → SECRET_INFO_REVISION_STALE.
 * The consumer maps all of them to "stale / resync" without any detail.
 */
function assertScope(state: SecretRoleDealState, expected: unknown): void {
  const scope = SecretInfoScopeSchema.safeParse(expected); // strict: exact keys AND valid types, so a malformed scope is never "just stale"
  if (!scope.success) throw new SecretInfoError('SECRET_INFO_SCOPE_INVALID');
  if (state.runIndex !== scope.data.runIndex || state.roundId !== scope.data.roundId) throw new CoreRuleError('STALE_ROUND');
  if (state.dealId !== scope.data.dealId) throw new SecretInfoError('SECRET_INFO_DEAL_STALE');
  if (state.revision !== scope.data.revision) throw new SecretInfoError('SECRET_INFO_REVISION_STALE');
}

// ── Explicit selective public release ────────────────────────

/**
 * Releases the SELECTED fragments to everybody (PUBLIC), additively and idempotently. Order of checks: stored data → scope
 * → time → batch. The helper authenticates nobody and decides no phase: the real consumer must first check current
 * rights, phase, membership and version, and then wire state event, persistence, CAS and receipt atomically (and prevent
 * the double effect of parallel commands).
 *
 * - Nothing is public without this call; there is no reveal-all and no wildcard. The selection is an explicit, non-empty
 *   list of known fragment ids.
 * - The batch is all-or-nothing: an unknown id, a malformed id or a duplicate id inside the batch rejects the whole batch
 *   (SECRET_INFO_RELEASE_INVALID) and changes nothing. A duplicate is rejected consistently, never silently merged.
 * - Re-releasing an already released fragment is idempotent: no new effect and the FIRST release time is kept. A mixed
 *   batch of released and new ids adds only the new ones, all with the given `now`.
 * - Only the publication status of the selected fragments changes. Roles, recipients, other fragments and all contents
 *   stay as they are. There is no un-release.
 * - `now` is server time supplied by the caller (safe non-negative integer); it is stored privately and never projected.
 * - The released log is kept in FRAGMENT order, so different (permitted) release orders yield the same ids and the same
 *   projections. `changed` tells the consumer whether a state event is needed at all.
 */
export function releaseSecretInformation(rawState: unknown, args: { scope: SecretRoleDealScope; fragmentIds: readonly string[]; now: number }): { state: SecretRoleDealState; changed: boolean } {
  const state = parseSecretRoleDealState(rawState);
  if (!isPlain(args) || !hasExactKeys(args, ['scope', 'fragmentIds', 'now'])) throw new SecretInfoError('SECRET_INFO_RELEASE_INVALID', ['SHAPE_INVALID']);
  assertScope(state, args.scope);
  if (!Number.isSafeInteger(args.now) || args.now < 0) throw new SecretInfoError('SECRET_INFO_TIME_INVALID');
  const reject = (code: SecretInfoIssueCode) => new SecretInfoError('SECRET_INFO_RELEASE_INVALID', [code]);
  const ids: unknown = args.fragmentIds;
  if (!Array.isArray(ids)) throw reject('SHAPE_INVALID');
  if (ids.length === 0) throw reject('RELEASE_EMPTY');
  if (ids.length > SECRET_INFO_MAX_FRAGMENTS) throw reject('LIMIT_EXCEEDED'); // bound before building any set
  const known = new Set(state.fragments.map(f => f.fragmentId));
  const batch = new Set<string>();
  let duplicate = false, unknown = false;
  for (const id of ids as unknown[]) {
    if (typeof id !== 'string') throw reject('SHAPE_INVALID');
    if (!known.has(id)) unknown = true;
    if (batch.has(id)) duplicate = true;
    batch.add(id);
  }
  if (unknown) throw reject('RELEASE_UNKNOWN_FRAGMENT');
  if (duplicate) throw reject('RELEASE_DUPLICATE');

  const releasedAt = new Map(state.released.map(r => [r.fragmentId, r.releasedAtMs] as const));
  const additions = state.fragments.filter(f => batch.has(f.fragmentId) && !releasedAt.has(f.fragmentId));
  if (additions.length === 0) return { state, changed: false };
  for (const fragment of additions) releasedAt.set(fragment.fragmentId, args.now);
  const released = state.fragments.filter(f => releasedAt.has(f.fragmentId)).map(f => ({ fragmentId: f.fragmentId, releasedAtMs: releasedAt.get(f.fragmentId) as number }));
  return { state: parseSecretRoleDealState({ ...state, released }), changed: true };
}

// ── Projection ───────────────────────────────────────────────

const INFORMATION_ROLES = ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'];

/**
 * Projection for ONE caller, built through a small allowlist (no spread of the private state). The `audience` must come
 * from the server's admission/session path: the information role is the CURRENT game role — a playing host or a playing
 * administrator is projected with the PLAYER role and gets exactly what a player gets; administrative rights open no
 * foreign secret (`ProjectionAudience` has no ADMIN entry on purpose; a non-playing administrator maps to VIEWER, or to
 * HOST only if the existing mapping makes him the host). A pinned roster is not an authentication.
 *
 * - `own`: only for role PLAYER whose participantId is on the deal; exactly the fragments addressed to that participant
 *   (visibility rule PLAYER_PRIVATE per recipient — no team rule, no `blindHost` shortcut), title + text only, in fragment
 *   order. A participant without fragments gets an empty list. No role id, no distribution, no other participant, no
 *   fragment id. The actual role is NEVER part of it.
 * - `released`: the explicitly released fragments for every information role, title + text only, in fragment order.
 *   Before any release this is an empty list for everybody, so a public projection reveals neither how many secrets exist
 *   nor who holds which role. A fragment that is both addressed to a player and released appears in both lists.
 * - HOST (blind or not) gets no private part and no overview. A later non-playing host preview needs its own, explicit
 *   decision and is NOT available here — do not open it through `canView(HOST_PRIVATE)`.
 * - A malformed audience or a stale scope throws (code only); it never degrades to a guess.
 */
export function projectSecretInfo(audience: ProjectionAudience, rawState: unknown, expectedScope: SecretRoleDealScope): SecretInfoProjection {
  const state = parseSecretRoleDealState(rawState);
  assertScope(state, expectedScope);
  const bad = () => new SecretInfoError('SECRET_INFO_AUDIENCE_INVALID');
  if (!isPlain(audience) || typeof audience.role !== 'string' || !INFORMATION_ROLES.includes(audience.role)) throw bad();
  const id: unknown = audience.participantId;
  if (id !== undefined && id !== null && !SecretInfoParticipantIdSchema.safeParse(id).success) throw bad();

  const onDeal = typeof id === 'string' && audience.role === 'PLAYER' && state.participantIds.includes(id);
  const view = (f: { title: string; text: string }) => ({ title: f.title, text: f.text });
  const own = onDeal
    ? { participantId: id as string, fragments: state.fragments.filter(f => f.recipientIds.some(recipient => canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: recipient }))).map(view) }
    : null;
  const releasedIds = new Set(state.released.map(r => r.fragmentId));
  const projection = {
    contract: SECRET_INFO_CONTRACT,
    scope: secretRoleDealScopeOf(state),
    own,
    released: state.fragments.filter(f => releasedIds.has(f.fragmentId)).map(view),
  };
  return SecretInfoProjectionSchema.parse(projection); // fresh object, strict allowlist re-checked
}

export { SecretInfoError } from '@quiz/shared/secretInfo';
export type { SecretInfoProjection, SecretInfoScope } from '@quiz/shared/secretInfo';
