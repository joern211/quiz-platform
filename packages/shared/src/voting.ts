// ============================================================
// N4 — Voting contract (technical foundation, no game rules)
//
// ONE ordinary, binding single-choice ballot per eligible participant and poll, on PREDEFINED options.
//   { schemaVersion: 1, kind: 'OPTION',  optionId }   — a vote for exactly one configured option
//   { schemaVersion: 1, kind: 'ABSTAIN' }              — an explicit abstention (only where the voter may)
// "No ballot" (not cast) is a third, different state and is represented by the ABSENCE of a record. There is no
// reserved option id for an abstention: ABSTAIN is a discriminator of its own and carries no optionId, so a normal
// option may be called "abstain" or "null" without any collision. Missing, ambiguous, multiple, unknown or foreign
// choices, wrong types/versions and extra keys are rejected as a whole — nothing becomes "option 0" and nothing
// becomes an abstention by accident.
//
// Three things are kept strictly apart:
//   A) PUBLIC option data: ids, labels, help, PRESENTATION order (VotingOptionsConfig). Its strict schema has no
//      room for an author, owner, role, solution, "correct" flag or seed.
//   B) PRIVATE eligibility (server only): who may vote, which options each voter may choose, whether each voter
//      may abstain. Never part of a client-bound config or key.
//   C) PRIVATE ballots (server only, one per voter) and a neutral, deterministic TALLY derived from a CLOSED poll.
//
// The tally states facts only (votes per option, participation numbers, the most-voted option(s)). It is NOT a
// score, a winner, an elimination or a tie rule. "Most voted" is not "correct". Whether a tie matters, whether
// abstaining or not voting has consequences, and who gets points is the decision of a later, user-confirmed
// engine rule (open: DEC-SPI-01, DEC-UND-01, DEC-AGT-01).
//
// This is NOT a cryptographically anonymous election. Small aggregates can allow conclusions outside the system;
// the secret contract proven here is the role-bound release of data (see the server projection).
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no parameter properties, and
// (as in ordering.ts / textcard.ts) a self-contained file without relative imports.
// ============================================================

import { z } from 'zod';

export const VOTING_SCHEMA_VERSION = 1 as const;
export const VOTING_TALLY_CONTRACT = 'VOTING_TALLY_V1' as const;
/**
 * Protection bounds, not game rules. Two options are the smallest poll that carries a choice. 32 options keep the vote
 * list usable on a phone and the whole public config far below 16 KB; 100 voters is the upper bound the room
 * creation already enforces for `maxPlayers` (http/validators.ts) — the bound must not be lower than a real room.
 * Nothing in this contract enumerates combinations: every operation is linear in options + voters.
 */
export const VOTING_MIN_OPTIONS = 2;
export const VOTING_MAX_OPTIONS = 32;
export const VOTING_MAX_VOTERS = 100;
export const VOTING_MAX_ID_LENGTH = 40;
export const VOTING_MAX_LABEL_LENGTH = 120;
export const VOTING_MAX_HELP_LENGTH = 200;
export const VOTING_MAX_PROMPT_LENGTH = 200;
export const VOTING_MAX_PARTICIPANT_ID_LENGTH = 200;
export const VOTING_MAX_REF_LENGTH = 80;

/** Per-issue codes. An issue carries a CONFIGURED optionId or null — never an echoed attacker string. */
export const VOTING_ISSUE_CODES = [
  'BALLOT_MALFORMED', 'BALLOT_MISSING_CHOICE', 'BALLOT_WRONG_TYPE', 'BALLOT_UNKNOWN_OPTION',
  'BALLOT_OPTION_NOT_ALLOWED', 'BALLOT_ABSTAIN_NOT_ALLOWED',
  'ELIGIBILITY_MALFORMED', 'ELIGIBILITY_DUPLICATE_VOTER', 'ELIGIBILITY_UNKNOWN_OPTION',
  'ELIGIBILITY_DUPLICATE_OPTION', 'ELIGIBILITY_NO_CHOICE',
] as const;
export type VotingIssueCode = typeof VOTING_ISSUE_CODES[number];
/** Wire error codes (the message of the thrown error equals the code). They carry no choice, roster or allowlist data. */
export const VOTING_ERROR_CODES = [
  'VOTING_INVALID', 'VOTING_CONFIG_INVALID', 'VOTING_ELIGIBILITY_INVALID', 'VOTING_STATE_INVALID',
  'VOTING_POLL_STALE', 'VOTING_CONFIG_STALE', 'VOTING_ROSTER_STALE',
  'VOTING_POLL_CLOSED', 'VOTING_NOT_CLOSED', 'VOTING_NOT_ELIGIBLE', 'VOTING_ALREADY_VOTED', 'VOTING_RELEASE_INVALID',
] as const;
export type VotingErrorCode = typeof VOTING_ERROR_CODES[number];

export interface VotingIssue { optionId: string | null; code: VotingIssueCode }

export class VotingError extends Error {
  readonly code: VotingErrorCode;
  readonly issues: readonly VotingIssue[];
  constructor(code: VotingErrorCode, issues: readonly VotingIssue[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'VotingError';
  }
}

// ── Option config (versioned, public) ────────────────────────

const RESERVED_IDS = ['constructor', 'prototype', 'proto'];
/**
 * Opaque, stable, lowercase. Public: a later engine must NOT encode an author, a role, "real/fake" or an answer in the
 * id (and must create it independently of the vote order). A parser cannot detect every unfortunate id.
 */
export const VotingOptionIdSchema = z.string().max(VOTING_MAX_ID_LENGTH)
  .regex(/^[a-z][a-z0-9_-]*$/)
  .refine(id => !RESERVED_IDS.includes(id), 'RESERVED_ID');
/** Opaque server-side reference label (poll id, roster revision). Must not encode roster, allowlist or author data. */
export const VotingRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(VOTING_MAX_REF_LENGTH);
export const VotingPollIdSchema = VotingRefSchema;
export const VotingParticipantIdSchema = z.string().min(1).max(VOTING_MAX_PARTICIPANT_ID_LENGTH);

// Display-text policy: the SAME rule as the N2 text card and the N3 ordering (no surrounding white space, no
// control/bidi characters, no lone surrogates, not blank). Duplicated on purpose — shared contracts are self-contained
// files (plain Node in strip-only mode cannot resolve sibling `.js` imports of `.ts`). A parity test pins them together.
const FORBIDDEN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BLANK = /^(?:\p{White_Space}|[\u200B\u200C\u2060\uFEFF]|\u200D)*$/u;
const displayText = (max: number) => z.string().min(1).max(max)
  .refine(text => text === text.trim() && !FORBIDDEN.test(text) && !LONE_SURROGATE.test(text), 'DISPLAY_TEXT_INVALID')
  .refine(text => !BLANK.test(text), 'DISPLAY_TEXT_BLANK');

export const VotingOptionDefSchema = z.object({
  optionId: VotingOptionIdSchema,
  /** Display only and NOT an identity: two options may share a label and stay two options. */
  label: displayText(VOTING_MAX_LABEL_LENGTH),
  help: displayText(VOTING_MAX_HELP_LENGTH).nullable(),
}).strict();
export type VotingOptionDef = z.infer<typeof VotingOptionDefSchema>;

export const VotingOptionsConfigSchema = z.object({
  schemaVersion: z.literal(VOTING_SCHEMA_VERSION),
  /** Public task text. Display only: nothing is derived from it. */
  prompt: displayText(VOTING_MAX_PROMPT_LENGTH).nullable(),
  /** In PRESENTATION order — fixed by the server-side snapshot, never re-shuffled on render or rejoin. */
  options: z.array(VotingOptionDefSchema).min(VOTING_MIN_OPTIONS).max(VOTING_MAX_OPTIONS),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.options.map(o => o.optionId)).size !== config.options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'DUPLICATE_OPTION_ID' });
  }
});
export type VotingOptionsConfig = z.infer<typeof VotingOptionsConfigSchema>;

export type VotingConfigResult = { ok: true; config: VotingOptionsConfig } | { ok: false; code: 'VOTING_CONFIG_INVALID' };
/** Failure carries a code only: no values, no zod paths. Usable by client and server (the config is public). */
export function parseVotingOptionsConfig(raw: unknown): VotingConfigResult {
  const parsed = VotingOptionsConfigSchema.safeParse(raw);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, code: 'VOTING_CONFIG_INVALID' };
}

/**
 * Server-side identity of how stored ballots are interpreted: schema version and the option ids IN PRESENTATION
 * ORDER (a re-shuffled presentation after a rejoin is a different, rejected scope). Labels/help are excluded.
 * Public data only.
 */
export function votingOptionsKey(config: VotingOptionsConfig): string {
  return JSON.stringify([config.schemaVersion, config.options.map(o => o.optionId)]);
}
/** Order-independent identity of the option SET (schema version + sorted ids), for the UI. */
export function votingOptionSetKey(config: VotingOptionsConfig): string {
  return JSON.stringify([config.schemaVersion, config.options.map(o => o.optionId).sort()]);
}
/**
 * Public UI context key of ONE poll: run, round, pollId and the option SET. A new poll in the same round, a new round
 * or a changed option set yields a different key (the UI then drops draft AND confirmation). An optional opaque
 * `eligibilityRevision` (a server label, never roster/allowlist data) lets the caller also separate a changed right to
 * vote. Public data only.
 */
export function votingContextKey(args: { runIndex: number; roundId: string; pollId: string; config: VotingOptionsConfig; eligibilityRevision?: string | null }): string {
  return JSON.stringify(['VOTING', args.runIndex, args.roundId, args.pollId, votingOptionSetKey(args.config), args.eligibilityRevision ?? null]);
}

// ── Private eligibility (server only) ────────────────────────

export const VotingVoterSchema = z.object({
  participantId: VotingParticipantIdSchema,
  /** The options THIS voter may choose, configured ids only, no duplicates. Empty is valid only together with allowAbstain. */
  allowedOptionIds: z.array(VotingOptionIdSchema).max(VOTING_MAX_OPTIONS),
  /** Explicit, no default: the voter may (true) or may not (false) cast an explicit abstention. */
  allowAbstain: z.boolean(),
}).strict();
export type VotingVoter = z.infer<typeof VotingVoterSchema>;

/**
 * The pinned right to vote. `revision` is an OPAQUE label of the server-side roster/policy revision; it must not encode
 * the roster, an allowlist or an author relation. The roster is never part of a client-bound config or key.
 * Eligibility is a ROSTER, not an authentication: the domain does not know a socket identity.
 */
export const VotingEligibilitySchema = z.object({
  schemaVersion: z.literal(VOTING_SCHEMA_VERSION),
  revision: VotingRefSchema,
  voters: z.array(VotingVoterSchema).min(1).max(VOTING_MAX_VOTERS),
}).strict();
export type VotingEligibility = z.infer<typeof VotingEligibilitySchema>;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => own.includes(key));
};

export type VotingEligibilityValidation = { ok: true; eligibility: VotingEligibility } | { ok: false; issues: VotingIssue[] };

/**
 * Validates an eligibility under the pinned option config and returns a fresh canonical copy (voters and allowlists keep
 * the given order; nothing is sorted, merged or repaired). Contradictions are rejected: duplicate voters, duplicate
 * or unknown allowed options, and a voter who can neither choose an option nor abstain. Issues carry configured option
 * ids or null only.
 */
export function validateVotingEligibility(config: VotingOptionsConfig, input: unknown): VotingEligibilityValidation {
  const malformed = (): VotingEligibilityValidation => ({ ok: false, issues: [{ optionId: null, code: 'ELIGIBILITY_MALFORMED' }] });
  if (!plainObject(input) || !hasExactKeys(input, ['schemaVersion', 'revision', 'voters'])) return malformed();
  if (input.schemaVersion !== VOTING_SCHEMA_VERSION || !VotingRefSchema.safeParse(input.revision).success || !Array.isArray(input.voters)) return malformed();
  const voters: unknown[] = input.voters;
  if (voters.length < 1 || voters.length > VOTING_MAX_VOTERS) return malformed(); // bound before iterating

  const known = new Set(config.options.map(o => o.optionId));
  const seenVoters = new Set<string>();
  const issues: VotingIssue[] = [];
  const copy: VotingVoter[] = [];
  for (const entry of voters) {
    if (!plainObject(entry) || !hasExactKeys(entry, ['participantId', 'allowedOptionIds', 'allowAbstain'])) { issues.push({ optionId: null, code: 'ELIGIBILITY_MALFORMED' }); continue; }
    const { participantId, allowedOptionIds, allowAbstain } = entry;
    if (!VotingParticipantIdSchema.safeParse(participantId).success || !Array.isArray(allowedOptionIds)
      || allowedOptionIds.length > VOTING_MAX_OPTIONS || typeof allowAbstain !== 'boolean') { issues.push({ optionId: null, code: 'ELIGIBILITY_MALFORMED' }); continue; }
    if (seenVoters.has(participantId as string)) { issues.push({ optionId: null, code: 'ELIGIBILITY_DUPLICATE_VOTER' }); continue; }
    seenVoters.add(participantId as string);
    const seenOptions = new Set<string>();
    const allowed: string[] = [];
    for (const optionId of allowedOptionIds as unknown[]) {
      if (typeof optionId !== 'string' || optionId.length > VOTING_MAX_ID_LENGTH || !known.has(optionId)) { issues.push({ optionId: null, code: 'ELIGIBILITY_UNKNOWN_OPTION' }); continue; }
      if (seenOptions.has(optionId)) { issues.push({ optionId, code: 'ELIGIBILITY_DUPLICATE_OPTION' }); continue; }
      seenOptions.add(optionId);
      allowed.push(optionId);
    }
    if (allowed.length === 0 && allowAbstain === false) issues.push({ optionId: null, code: 'ELIGIBILITY_NO_CHOICE' });
    copy.push({ participantId: participantId as string, allowedOptionIds: allowed, allowAbstain });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, eligibility: { schemaVersion: VOTING_SCHEMA_VERSION, revision: input.revision as string, voters: copy } };
}

/** The options a voter may choose, in PRESENTATION order (derived; the stored allowlist order is irrelevant). */
export function votingSelectableOptionIds(config: VotingOptionsConfig, voter: Pick<VotingVoter, 'allowedOptionIds'>): string[] {
  const allowed = new Set(voter.allowedOptionIds);
  return config.options.map(o => o.optionId).filter(id => allowed.has(id));
}

// ── Ballot ───────────────────────────────────────────────────

export const VotingBallotSchema = z.discriminatedUnion('kind', [
  z.object({ schemaVersion: z.literal(VOTING_SCHEMA_VERSION), kind: z.literal('OPTION'), optionId: VotingOptionIdSchema }).strict(),
  z.object({ schemaVersion: z.literal(VOTING_SCHEMA_VERSION), kind: z.literal('ABSTAIN') }).strict(),
]);
export type VotingBallot = z.infer<typeof VotingBallotSchema>;

/** UI boundary: build wire ballots from a deliberate choice (fresh objects). */
export function votingOptionBallot(optionId: string): VotingBallot {
  return { schemaVersion: VOTING_SCHEMA_VERSION, kind: 'OPTION', optionId };
}
export function votingAbstainBallot(): VotingBallot {
  return { schemaVersion: VOTING_SCHEMA_VERSION, kind: 'ABSTAIN' };
}

export type VotingBallotValidation = { ok: true; ballot: VotingBallot } | { ok: false; issues: VotingIssue[] };

/**
 * Structural + permission validation of ONE ballot of ONE voter under the pinned config. Hand-rolled (not zod) so the
 * issue codes stay stable and no attacker-supplied string is ever echoed. The returned ballot is a fresh object. No
 * repair: a ballot that is not exactly one allowed OPTION or one allowed ABSTAIN is rejected as a whole.
 */
export function validateVotingBallot(config: VotingOptionsConfig, voter: Pick<VotingVoter, 'allowedOptionIds' | 'allowAbstain'>, input: unknown): VotingBallotValidation {
  const fail = (code: VotingIssueCode): VotingBallotValidation => ({ ok: false, issues: [{ optionId: null, code }] });
  if (input === null || input === undefined) return fail('BALLOT_MISSING_CHOICE');
  if (!plainObject(input)) return fail('BALLOT_MALFORMED');
  if (input.schemaVersion !== VOTING_SCHEMA_VERSION) return fail('BALLOT_MALFORMED');
  if (input.kind === 'ABSTAIN') {
    if (!hasExactKeys(input, ['schemaVersion', 'kind'])) return fail('BALLOT_MALFORMED'); // an optionId next to ABSTAIN is ambiguous
    if (!voter.allowAbstain) return fail('BALLOT_ABSTAIN_NOT_ALLOWED');
    return { ok: true, ballot: votingAbstainBallot() };
  }
  if (input.kind !== 'OPTION') return fail('BALLOT_MALFORMED');
  const keys = Object.keys(input);
  if (!keys.includes('optionId') && keys.length === 2) return fail('BALLOT_MISSING_CHOICE'); // { schemaVersion, kind } only
  if (!hasExactKeys(input, ['schemaVersion', 'kind', 'optionId'])) return fail('BALLOT_MALFORMED'); // extra keys, e.g. a list of ids
  const optionId = input.optionId;
  if (optionId === null || optionId === undefined) return fail('BALLOT_MISSING_CHOICE');
  if (typeof optionId !== 'string') return fail('BALLOT_WRONG_TYPE');
  if (optionId.length > VOTING_MAX_ID_LENGTH || !config.options.some(o => o.optionId === optionId)) return fail('BALLOT_UNKNOWN_OPTION');
  if (!voter.allowedOptionIds.includes(optionId)) return fail('BALLOT_OPTION_NOT_ALLOWED'); // no id echoed: the issue stays code-only
  return { ok: true, ballot: votingOptionBallot(optionId) };
}

// ── Tally (neutral facts of a CLOSED poll) ───────────────────

export const VotingOptionCountSchema = z.object({
  optionId: VotingOptionIdSchema,
  votes: z.number().int().min(0).max(VOTING_MAX_VOTERS),
}).strict();
const count = () => z.number().int().min(0).max(VOTING_MAX_VOTERS);
export const VotingTallySchema = z.object({
  contract: z.literal(VOTING_TALLY_CONTRACT),
  pollId: VotingPollIdSchema,
  /** Roster size at the pinned eligibility — viewers, displays and host administration are not part of it. */
  eligibleCount: count(),
  /** Accepted ballots = optionVoteCount + abstainCount. */
  castCount: count(),
  optionVoteCount: count(),
  abstainCount: count(),
  /** Eligible participants without any ballot (not cast). Not an abstention and not a penalty. */
  missingCount: count(),
  /** One entry per configured option IN PRESENTATION ORDER, including options with 0 votes. */
  options: z.array(VotingOptionCountSchema).min(VOTING_MIN_OPTIONS).max(VOTING_MAX_OPTIONS),
  /**
   * The option(s) with the highest POSITIVE vote count, in presentation order. NONE: nobody voted for an option (no
   * leader id, never "all options with 0 votes"). TIED: several options share the top count — a neutral fact, no
   * resolution. SINGLE: one option. "Most voted" is not "correct", "winner" or "eliminated".
   */
  top: z.object({
    kind: z.enum(['NONE', 'SINGLE', 'TIED']),
    votes: count(),
    optionIds: z.array(VotingOptionIdSchema).max(VOTING_MAX_OPTIONS),
  }).strict(),
}).strict();
export type VotingTally = z.infer<typeof VotingTallySchema>;

/**
 * Internal consistency of a tally (never trust a tally that arrived from somewhere else): the counters add up, option
 * ids are unique, and `top` is exactly what the option counts imply. True iff consistent.
 */
export function votingTallyIsConsistent(tally: VotingTally): boolean {
  if (!VotingTallySchema.safeParse(tally).success) return false;
  if (tally.eligibleCount !== tally.castCount + tally.missingCount) return false;
  if (tally.castCount !== tally.optionVoteCount + tally.abstainCount) return false;
  if (new Set(tally.options.map(o => o.optionId)).size !== tally.options.length) return false;
  if (tally.options.reduce((sum, o) => sum + o.votes, 0) !== tally.optionVoteCount) return false;
  const max = tally.options.reduce((m, o) => Math.max(m, o.votes), 0);
  const leaders = max > 0 ? tally.options.filter(o => o.votes === max).map(o => o.optionId) : [];
  const kind = leaders.length === 0 ? 'NONE' : leaders.length === 1 ? 'SINGLE' : 'TIED';
  return tally.top.kind === kind && tally.top.votes === (max > 0 ? max : 0)
    && tally.top.optionIds.length === leaders.length && tally.top.optionIds.every((id, i) => id === leaders[i]);
}
