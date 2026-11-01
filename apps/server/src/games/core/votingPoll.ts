// ============================================================
// N4 — Voting poll lifecycle (domain building block)
//
// Pure functions over a serializable poll state. They authenticate NOTHING: `participantId`, the expected
// scope, `timer` and `now` MUST come from the server-side admission/command boundary of a future engine (current
// authenticated session, current membership, kick/rights withdrawal, run/round/phase checks) — never from a client
// payload. The eligibility inside the state is a pinned ROSTER, not an authentication; a historical roster is no
// replacement for the current server checks. No socket, DB, clock, randomness, scoring or ledger here: points,
// results, winners and eliminations stay with the engine and the central score path. Exactly-once effects need
// transaction/CAS/receipt at the real consumer.
//
// Lock semantics: the POLL is the unit that closes. After `closeVotingPoll` nobody may vote — also not an eligible
// participant who has not voted and also not while an external timer still runs. The tally is DERIVED from the
// closed state (nothing stored twice), is available only for a closed poll and is independent of the order in which
// the ballots were stored.
//
// Secrets: the persisted state is SERVER-PRIVATE (config + roster/allowlists + ballots). Everything that leaves the
// server goes through `projectVotingPoll`, which keeps three independent releases apart: the OPTIONS, the voter's OWN
// ballot and the AGGREGATE. Releasing the aggregate never releases individual ballots.
// ============================================================

import { z } from 'zod';
import { type CoreTimer } from '@quiz/shared';
import {
  VOTING_MAX_VOTERS, VOTING_SCHEMA_VERSION, VOTING_TALLY_CONTRACT, VotingBallotSchema, VotingEligibilitySchema, VotingError,
  VotingOptionIdSchema, VotingOptionsConfigSchema, VotingParticipantIdSchema, VotingPollIdSchema, VotingTallySchema,
  votingOptionsKey, votingSelectableOptionIds, validateVotingBallot, validateVotingEligibility,
  type VotingBallot, type VotingEligibility, type VotingOptionsConfig, type VotingTally, type VotingVoter,
} from '@quiz/shared/voting';
import { CoreRuleError, timerAcceptsInput } from './runtimePrimitives.js';
import { canView, type ProjectionAudience } from './visibility.js';

const idText = z.string().min(1).max(200);

/** An accepted ballot is immutable. `castAtMs` is server-private (never projected, not even for the owner). */
export const VotingBallotRecordSchema = z.object({
  participantId: VotingParticipantIdSchema,
  ballot: VotingBallotSchema,
  castAtMs: z.number().int().nonnegative(),
}).strict();
export type VotingBallotRecord = z.infer<typeof VotingBallotRecordSchema>;

/**
 * Persisted state of ONE poll. It pins the effective public options (so a later change cannot reinterpret stored
 * ballots) and the eligibility with its opaque revision (so a changed roster is a different scope, never a silent
 * re-reading of old ballots). Status is stored once; the tally is not stored at all.
 */
export const VotingPollStateSchema = z.object({
  kind: z.literal('VOTING_POLL'),
  schemaVersion: z.literal(VOTING_SCHEMA_VERSION),
  runIndex: z.number().int().positive(),
  roundId: idText,
  pollId: VotingPollIdSchema,
  config: VotingOptionsConfigSchema,
  eligibility: VotingEligibilitySchema,
  status: z.enum(['OPEN', 'CLOSED']),
  closedAtMs: z.number().int().nonnegative().nullable(),
  ballots: z.array(VotingBallotRecordSchema).max(VOTING_MAX_VOTERS),
}).strict().superRefine((state, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if ((state.status === 'CLOSED') !== (state.closedAtMs !== null)) bad('CLOSE_STATE_CONFLICT');
  const eligibility = validateVotingEligibility(state.config, state.eligibility);
  if (!eligibility.ok || JSON.stringify(eligibility.eligibility) !== JSON.stringify(state.eligibility)) { bad('ELIGIBILITY_CONFIG_CONFLICT'); return; }
  if (new Set(state.ballots.map(r => r.participantId)).size !== state.ballots.length) bad('DUPLICATE_BALLOT_OWNER');
  for (const record of state.ballots) {
    const voter = state.eligibility.voters.find(v => v.participantId === record.participantId);
    if (!voter) { bad('BALLOT_OWNER_NOT_ELIGIBLE'); continue; }
    const again = validateVotingBallot(state.config, voter, record.ballot);
    if (!again.ok || JSON.stringify(again.ballot) !== JSON.stringify(record.ballot)) bad('BALLOT_NOT_ALLOWED_FOR_OWNER');
    if (state.closedAtMs !== null && record.castAtMs > state.closedAtMs) bad('CAST_AFTER_CLOSE');
  }
});
export type VotingPollState = z.infer<typeof VotingPollStateSchema>;

/** What the caller currently considers authoritative; any difference means the request is stale. */
export interface VotingScope { runIndex: number; roundId: string; pollId: string; optionsKey: string; eligibilityRevision: string }

export function parseVotingPollState(raw: unknown): VotingPollState {
  const parsed = VotingPollStateSchema.safeParse(raw);
  if (!parsed.success) throw new VotingError('VOTING_STATE_INVALID');
  return parsed.data;
}
export function votingScopeOf(state: VotingPollState): VotingScope {
  return { runIndex: state.runIndex, roundId: state.roundId, pollId: state.pollId, optionsKey: votingOptionsKey(state.config), eligibilityRevision: state.eligibility.revision };
}
function assertScope(state: VotingPollState, expected: VotingScope): void {
  if (state.runIndex !== expected.runIndex || state.roundId !== expected.roundId) throw new CoreRuleError('STALE_ROUND');
  if (state.pollId !== expected.pollId) throw new VotingError('VOTING_POLL_STALE'); // another vote in the same round
  if (votingOptionsKey(state.config) !== expected.optionsKey) throw new VotingError('VOTING_CONFIG_STALE');
  if (state.eligibility.revision !== expected.eligibilityRevision) throw new VotingError('VOTING_ROSTER_STALE');
}
function assertTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new CoreRuleError('INVALID_TIME');
}
const findVoter = (state: VotingPollState, participantId: string): VotingVoter | undefined => state.eligibility.voters.find(v => v.participantId === participantId);
const findRecord = (state: VotingPollState, participantId: string) => state.ballots.find(r => r.participantId === participantId);

/** Creates an OPEN poll without ballots. Config and eligibility are validated against each other; nothing is repaired. */
export function createVotingPoll(input: { runIndex: number; roundId: string; pollId: string; config: unknown; eligibility: unknown }): VotingPollState {
  const config = VotingOptionsConfigSchema.safeParse(input.config);
  if (!config.success) throw new VotingError('VOTING_CONFIG_INVALID');
  const eligibility = validateVotingEligibility(config.data, input.eligibility);
  if (!eligibility.ok) throw new VotingError('VOTING_ELIGIBILITY_INVALID', eligibility.issues);
  return parseVotingPollState({ kind: 'VOTING_POLL', schemaVersion: VOTING_SCHEMA_VERSION, runIndex: input.runIndex, roundId: input.roundId, pollId: input.pollId,
    config: config.data, eligibility: eligibility.eligibility, status: 'OPEN', closedAtMs: null, ballots: [] });
}

/**
 * Atomic acceptance of ONE binding ballot. Order: stored data → scope → time → poll open → deadline → eligibility →
 * existing ballot → ballot validation. On any failure nothing is stored and the input state is untouched (no partial
 * record, no burnt slot, no event). A second ordinary cast never replaces or repeats an accepted ballot — also not an
 * identical one; genuine command repetition belongs to the later receipt/intent path, not to a second vote.
 */
export function castVote(rawState: unknown, args: { scope: VotingScope; participantId: string; input: unknown; timer: CoreTimer; now: number }): VotingPollState {
  const state = parseVotingPollState(rawState);
  assertScope(state, args.scope);
  assertTime(args.now);
  if (state.status !== 'OPEN') throw new VotingError('VOTING_POLL_CLOSED');
  if (!timerAcceptsInput(args.timer, args.now)) throw new CoreRuleError('TIME_EXPIRED');
  const voter = findVoter(state, args.participantId);
  if (!voter) throw new VotingError('VOTING_NOT_ELIGIBLE');
  if (findRecord(state, args.participantId)) throw new VotingError('VOTING_ALREADY_VOTED');
  const validation = validateVotingBallot(state.config, voter, args.input);
  if (!validation.ok) throw new VotingError('VOTING_INVALID', validation.issues);
  const record: VotingBallotRecord = { participantId: args.participantId, ballot: validation.ballot, castAtMs: args.now };
  return parseVotingPollState({ ...state, ballots: [...state.ballots, record] });
}

/**
 * Closes the poll for good (OPEN → CLOSED). This is the real acceptance deadline: afterwards `castVote` rejects every
 * participant, including eligible ones without a ballot, regardless of the timer. An empty poll can be closed.
 * Idempotent: closing a closed poll returns the identical state (closedAtMs unchanged). `now` must not precede an
 * accepted ballot. Closing is NOT the public release of any result.
 */
export function closeVotingPoll(rawState: unknown, scope: VotingScope, now: number): VotingPollState {
  const state = parseVotingPollState(rawState);
  assertScope(state, scope);
  assertTime(now);
  if (state.status === 'CLOSED') return state;
  if (state.ballots.some(r => r.castAtMs > now)) throw new CoreRuleError('INVALID_TIME');
  return parseVotingPollState({ ...state, status: 'CLOSED', closedAtMs: now });
}

export type VotingOutcome =
  | { kind: 'NOT_ELIGIBLE' }
  | { kind: 'NOT_CAST' }
  | { kind: 'ABSTAINED' }
  | { kind: 'VOTED'; optionId: string };
/**
 * Server-internal, CLOSED polls only: what ONE participant did. Not cast, an explicit abstention and a vote for an
 * option are three different states, and none of them has a consequence here (no points, no penalty).
 */
export function votingOutcome(rawState: unknown, participantId: string): VotingOutcome {
  const state = parseVotingPollState(rawState);
  if (state.status !== 'CLOSED') throw new VotingError('VOTING_NOT_CLOSED');
  if (!findVoter(state, participantId)) return { kind: 'NOT_ELIGIBLE' };
  const record = findRecord(state, participantId);
  if (!record) return { kind: 'NOT_CAST' };
  return record.ballot.kind === 'ABSTAIN' ? { kind: 'ABSTAINED' } : { kind: 'VOTED', optionId: record.ballot.optionId };
}

/**
 * Neutral count of a CLOSED poll. Pure integer arithmetic; no clock, randomness, locale or label/id ordering; the output
 * follows the pinned PRESENTATION order, so identical valid ballots under an identical config always give an identical
 * tally, whatever order the records were stored in. An open poll has no tally (no live count). No winner, no
 * elimination, no points, no tie resolution.
 */
export function tallyVotingPoll(rawState: unknown): VotingTally {
  const state = parseVotingPollState(rawState);
  if (state.status !== 'CLOSED') throw new VotingError('VOTING_NOT_CLOSED');
  const votes = new Map<string, number>(state.config.options.map(o => [o.optionId, 0] as const));
  let abstainCount = 0;
  for (const record of state.ballots) {
    if (record.ballot.kind === 'ABSTAIN') { abstainCount++; continue; }
    votes.set(record.ballot.optionId, (votes.get(record.ballot.optionId) ?? 0) + 1);
  }
  const options = state.config.options.map(o => ({ optionId: o.optionId, votes: votes.get(o.optionId) as number }));
  const optionVoteCount = options.reduce((sum, o) => sum + o.votes, 0);
  const max = options.reduce((m, o) => Math.max(m, o.votes), 0);
  const leaders = max > 0 ? options.filter(o => o.votes === max).map(o => o.optionId) : [];
  return {
    contract: VOTING_TALLY_CONTRACT,
    pollId: state.pollId,
    eligibleCount: state.eligibility.voters.length,
    castCount: state.ballots.length,
    optionVoteCount,
    abstainCount,
    missingCount: state.eligibility.voters.length - state.ballots.length,
    options,
    top: { kind: leaders.length === 0 ? 'NONE' : leaders.length === 1 ? 'SINGLE' : 'TIED', votes: max, optionIds: leaders },
  };
}

// ── Projection ───────────────────────────────────────────────

export const VOTING_RELEASE_AUDIENCES = ['VOTERS', 'PLAYERS', 'HOST', 'VIEWERS', 'DISPLAYS'] as const;
export type VotingReleaseAudience = typeof VOTING_RELEASE_AUDIENCES[number];
/**
 * Explicit, REQUIRED release decision of the authoritative engine phase — never a client flag and never a consequence of
 * administrative rights. Two independent lists (no defaults, empty = nobody):
 *  - `options`: who may see the option texts now. VOTERS = players on the pinned roster; PLAYERS = every player role;
 *    HOST = the host information role (a blind host or a playing host is no exception: a playing host must be
 *    projected with the PLAYER role); VIEWERS / DISPLAYS = the read-only outputs.
 *  - `result`: who may see the AGGREGATE (counts, participation numbers, most-voted options). Only for a CLOSED poll.
 * Neither list releases individual ballots, voter→option lists, single timestamps, the roster or the allowlists.
 */
export interface VotingRelease { options: readonly VotingReleaseAudience[]; result: readonly VotingReleaseAudience[] }

function parseRelease(raw: unknown): VotingRelease {
  const bad = () => new VotingError('VOTING_RELEASE_INVALID');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad();
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes('options') || !keys.includes('result')) throw bad();
  const read = (list: unknown): VotingReleaseAudience[] => {
    if (!Array.isArray(list) || list.length > VOTING_RELEASE_AUDIENCES.length) throw bad();
    const out: VotingReleaseAudience[] = [];
    for (const entry of list as unknown[]) {
      if (typeof entry !== 'string' || !(VOTING_RELEASE_AUDIENCES as readonly string[]).includes(entry) || out.includes(entry as VotingReleaseAudience)) throw bad();
      out.push(entry as VotingReleaseAudience);
    }
    return out;
  };
  const record = raw as Record<string, unknown>;
  return { options: read(record.options), result: read(record.result) };
}
function isListed(list: readonly VotingReleaseAudience[], audience: ProjectionAudience, isVoter: boolean): boolean {
  switch (audience.role) {
    case 'PLAYER': return list.includes('PLAYERS') || (isVoter && list.includes('VOTERS'));
    case 'HOST': return list.includes('HOST');
    case 'VIEWER': return list.includes('VIEWERS');
    case 'DISPLAY': return list.includes('DISPLAYS');
  }
}

export const VotingProjectionSchema = z.object({
  pollId: VotingPollIdSchema,
  status: z.enum(['OPEN', 'CLOSED']),
  /** Option texts, or null while they are not released to THIS audience. */
  options: VotingOptionsConfigSchema.nullable(),
  /** Only for a player on the roster: the OWN accepted ballot and the OWN minimal choice list. Never for anybody else. */
  own: z.object({
    ballot: VotingBallotSchema.nullable(),
    selectableOptionIds: z.array(VotingOptionIdSchema),
    allowAbstain: z.boolean(),
  }).strict().nullable(),
  /** The aggregate, only when released to this audience and the poll is CLOSED. */
  result: VotingTallySchema.nullable(),
}).strict();
export type VotingProjection = z.infer<typeof VotingProjectionSchema>;

/**
 * Role/audience projection through the existing visibility helper. Three independent grants:
 *  A) the OPTIONS (`release.options`), B) the OWN ballot (PLAYER_PRIVATE: only the owner, never a team partner, host,
 *  blind host, viewer or display — and never because a result is public), C) the AGGREGATE (`release.result`).
 * `canView(..., publiclyRevealed)` is deliberately NOT applied to ballots: a visible result does not make single ballots
 * public. `own.selectableOptionIds` / `allowAbstain` are the voter's own minimal choice list, stable over the poll's
 * lifetime (vote, lock and close do not change it) and only given once the options are released to that voter; the
 * roster and other voters' allowlists never leave. A release of the result for an OPEN poll is rejected instead of
 * being counted live. DOMAIN projection only: it proves nothing about socket, rejoin or recovery delivery.
 */
export function projectVotingPoll(audience: ProjectionAudience, rawState: unknown, rawRelease: unknown): VotingProjection {
  const state = parseVotingPollState(rawState);
  const release = parseRelease(rawRelease);
  if (release.result.length > 0 && state.status !== 'CLOSED') throw new VotingError('VOTING_NOT_CLOSED');
  const voter = audience.role === 'PLAYER' && audience.participantId ? findVoter(state, audience.participantId) : undefined;
  const optionsVisible = isListed(release.options, audience, voter !== undefined);
  const resultVisible = isListed(release.result, audience, voter !== undefined);
  let own: VotingProjection['own'] = null;
  if (voter) {
    const record = findRecord(state, voter.participantId);
    const ballot = record && canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: record.participantId }) ? record.ballot : null;
    own = { ballot, selectableOptionIds: optionsVisible ? votingSelectableOptionIds(state.config, voter) : [], allowAbstain: optionsVisible && voter.allowAbstain };
  }
  const projection: VotingProjection = {
    pollId: state.pollId,
    status: state.status,
    options: optionsVisible ? state.config : null,
    own,
    result: resultVisible ? tallyVotingPoll(state) : null,
  };
  return JSON.parse(JSON.stringify(projection)) as VotingProjection;
}

export type { VotingBallot, VotingEligibility, VotingOptionsConfig, VotingTally };
