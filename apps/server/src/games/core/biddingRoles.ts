// ============================================================
// N10 — Adapter: bidder / performer assignment from an N5 role deal (SERVER-PRIVATE, pure)
//
// An N5 deal is IMMUTABLE and says which role each participant holds. A bidding needs ONE pinned assignment per team: who bids (bidder) and who performs (performer).
// This adapter reads such an assignment from a deal and carries its origin — run, round, deal id and revision — to the bidding: the caller states INDEPENDENTLY which
// run / round / deal / revision it expects, and every one of them is compared with the deal that is actually loaded (N8-03 lesson: a correct deal of an old game or round
// is not the right deal for the new one with the same participants). The deal's revision becomes the bidding's `rolesRevision`.
//
// It is NOT a second deal and never changes one: the deal stays immutable, the bidding never re-deals when a bid is made. Rotation of roles between rounds = a NEW deal
// for the new round and therefore a NEW bidding with a new `rolesRevision`; a replacement player inherits nothing. The role names are the consumer's own ids.
// A team may have more than two members: exactly ONE member holds the bidder role, exactly ONE the performer role, nobody else holds either.
//
// Using a deal as the source makes the pinned pair visible in the bidding projections that name it (the winner's pair, `you.teamId` of a bidder) — that is the point
// of the mechanic, not a leak of the deal; all other roles and fragments of the deal stay where N5 keeps them. Errors: BIDDING_CONFIG_INVALID, code-only issues.
//
// ORIGIN (N10-03): the result carries the origin it was checked against (run, round, deal id, revision — labels only). `prepareBiddingPhase` compares that origin with the bidding's own
// target context and the independently expected deal, so a correct result of another run/round/deal cannot be pinned later. `prepareBiddingPhaseFromRoleDeal` is the combined path.
// ============================================================

import { BiddingError, type BiddingIssueCode } from '@quiz/shared/bidding';
import { SecretInfoScopeSchema } from '@quiz/shared/secretInfo';
import { prepareBiddingPhase, type BiddingState } from './biddingPhase.js';
import { parseSecretRoleDealState, secretRoleDealScopeOf, type SecretRoleDealScope } from './secretRoleDeal.js';

export interface BiddingRolesFromDealArgs {
  deal: unknown;
  /** what the CALLER expects (from its own context, never from the deal): run, round, deal id and pinned revision */
  scope: SecretRoleDealScope;
  /** the role ids of the consumer */
  bidderRoleId: string;
  performerRoleId: string;
  /** the teams IN SCHEDULING ORDER with their members (from the CURRENT team assignment, never from the deal) */
  teams: ReadonlyArray<{ teamId: string; memberIds: readonly string[] }>;
}
/** The ORIGIN a derived assignment was checked against: labels only (never a role, a term or a fragment). `prepareBiddingPhase` compares it with the bidding's target context. */
export interface BiddingRoleOrigin { runIndex: number; roundId: string; dealId: string; revision: string }
export interface BiddingRolesFromDeal { rolesRevision: string; teams: Array<{ teamId: string; bidderId: string; performerId: string }>; origin: BiddingRoleOrigin }

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export function biddingRolesFromRoleDeal(args: BiddingRolesFromDealArgs): BiddingRolesFromDeal {
  const fail = (issue: BiddingIssueCode) => new BiddingError('BIDDING_CONFIG_INVALID', [issue]);
  if (!isPlain(args) || !Array.isArray(args.teams) || typeof args.bidderRoleId !== 'string' || typeof args.performerRoleId !== 'string' || args.bidderRoleId === args.performerRoleId) throw fail('SHAPE_INVALID');
  let deal;
  try { deal = parseSecretRoleDealState(args.deal); } catch { throw fail('SHAPE_INVALID'); }
  const expected = SecretInfoScopeSchema.safeParse(args.scope);
  if (!expected.success) throw fail('SHAPE_INVALID');
  const own = secretRoleDealScopeOf(deal);
  if (own.runIndex !== expected.data.runIndex || own.roundId !== expected.data.roundId || own.dealId !== expected.data.dealId || own.revision !== expected.data.revision) throw fail('CONFIG_CONFLICT');
  const roleOf = new Map(deal.assignments.map(assignment => [assignment.participantId, assignment.roleId] as const));
  const teams: BiddingRolesFromDeal['teams'] = [];
  const seen = new Set<string>();
  for (const team of args.teams as unknown[]) {
    if (!isPlain(team) || typeof team.teamId !== 'string' || !Array.isArray(team.memberIds)) throw fail('SHAPE_INVALID');
    const members = team.memberIds as unknown[];
    if (members.some(id => typeof id !== 'string' || !roleOf.has(id) || seen.has(id)) || new Set(members).size !== members.length) throw fail('TEAM_CONFLICT');
    for (const id of members as string[]) seen.add(id);
    const bidders = (members as string[]).filter(id => roleOf.get(id) === args.bidderRoleId);
    const performers = (members as string[]).filter(id => roleOf.get(id) === args.performerRoleId);
    if (bidders.length !== 1 || performers.length !== 1) throw fail('TEAM_CONFLICT');
    teams.push({ teamId: team.teamId, bidderId: bidders[0], performerId: performers[0] });
  }
  return { rolesRevision: deal.revision, teams, origin: { runIndex: own.runIndex, roundId: own.roundId, dealId: own.dealId, revision: own.revision } };
}

export interface PrepareBiddingFromRoleDealArgs extends BiddingRolesFromDealArgs {
  biddingId: string; sequenceId: string; rosterRevision: string; category: string | null; numeric: unknown;
}
/**
 * The COMBINED server-side preparation path N5 → N10: the ONE expected scope (run, round, deal id, revision, from the caller's own context) is compared with the loaded deal (adapter)
 * AND is the target context of the bidding (run, round) and the expected deal of the origin check in `prepareBiddingPhase` — there is no second, separately supplied run or round that
 * could disagree. A deal of another run, round or deal id, or one with an equal revision label, is refused; so is a derived result of a former deal.
 */
export function prepareBiddingPhaseFromRoleDeal(args: PrepareBiddingFromRoleDealArgs): BiddingState {
  const { biddingId, sequenceId, rosterRevision, category, numeric, ...rolesArgs } = args;
  const derived = biddingRolesFromRoleDeal(rolesArgs);
  const scope = SecretInfoScopeSchema.parse(rolesArgs.scope); // already accepted by the adapter
  return prepareBiddingPhase({
    runIndex: scope.runIndex, roundId: scope.roundId, biddingId, sequenceId, rosterRevision, category, numeric,
    roles: { source: 'N5_DEAL', derived, expectedDealId: scope.dealId, expectedRevision: scope.revision },
  });
}
