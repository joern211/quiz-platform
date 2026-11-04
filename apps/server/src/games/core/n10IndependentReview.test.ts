import { expect, it } from 'vitest';
import { BIDDING_NUMERIC_POSITIVE_INTEGER } from '@quiz/shared/bidding';
import { TURN_SEQUENCE_MAX_COUNTER } from '@quiz/shared/turnSequence';
import { createSecretRoleDeal } from './secretRoleDeal.js';
import { biddingRolesFromRoleDeal } from './biddingRoles.js';
import { abortBidding, biddingScopeOf, biddingTurnSequenceInput, openBidding, prepareBiddingPhase, refreshBiddingBasis } from './biddingPhase.js';
import { prepareTurnSequence, startTurnSequence, turnSequenceScopeOf } from './turnSequence.js';

const oldScope = { runIndex: 1, roundId: 'round-1', dealId: 'deal-1', revision: 'roles-1' };
const assignments = [
  { participantId: 'a', roleId: 'bidder' }, { participantId: 'b', roleId: 'performer' },
  { participantId: 'c', roleId: 'bidder' }, { participantId: 'd', roleId: 'performer' },
];
const roles = biddingRolesFromRoleDeal({
  scope: oldScope,
  deal: createSecretRoleDeal({ ...oldScope, participantIds: ['a', 'b', 'c', 'd'], roleIds: ['bidder', 'performer'], assignments, fragments: [] }),
  bidderRoleId: 'bidder', performerRoleId: 'performer', teams: [{ teamId: 'A', memberIds: ['a', 'b'] }, { teamId: 'B', memberIds: ['c', 'd'] }],
});

// extended contract (N10-03): the derived N5 result is an explicit input with its origin; the bidding's run/round and the expected deal are compared with it
const prepare = (runIndex: number, roundId: string) => prepareBiddingPhase({
  runIndex, roundId, biddingId: `bidding-${runIndex}-${roundId}`, sequenceId: 'seq-1', rosterRevision: 'roster-1', category: 'Hauptstädte',
  numeric: BIDDING_NUMERIC_POSITIVE_INTEGER, roles: { source: 'N5_DEAL', derived: roles, expectedDealId: oldScope.dealId, expectedRevision: oldScope.revision },
});

it.each([[2, 'round-1'], [1, 'round-2']] as const)('a derived N5 role assignment cannot be pinned to run %s / %s', (runIndex, roundId) => {
  expect(prepare(1, 'round-1').teams[0]).toEqual({ teamId: 'A', bidderId: 'a', performerId: 'b' });
  expect(() => prepare(runIndex, roundId)).toThrow();
});

it('a BASIS refresh cannot spend the last version step needed to close the bidding', () => {
  const prepared = prepare(1, 'round-1');
  const ready = prepareTurnSequence(biddingTurnSequenceInput(prepared));
  const level = (ids: string[], version: number, trackId: string) => ({ runIndex: 1, trackId, rosterRevision: 'track-roster', knownIds: ids, activeIds: ids, version });
  const eligibility = (version: number) => ({ actors: level(['A', 'B'], version, 'teams'), members: level(['a', 'b', 'c', 'd'], version, 'members') });
  const active = startTurnSequence(ready, { scope: turnSequenceScopeOf(ready), expectedVersion: 0, eligibility: eligibility(1) }).state;
  const sequence = { ...active, version: TURN_SEQUENCE_MAX_COUNTER - 1 };
  const scope = biddingScopeOf(prepared);
  const opened = openBidding(prepared, { scope, expectedVersion: 0, sequence }).state;
  const args = { scope, expectedVersion: opened.version, expectedSequenceVersion: sequence.version, sequence };
  expect(abortBidding(opened, { ...args, reason: 'HOST_ABORTED', gate: { abortAuthorized: true } }).sequence.phase).toBe('CLOSED');
  expect(() => refreshBiddingBasis(opened, { ...args, eligibility: eligibility(2) })).toThrow('BIDDING_COUNTER_LIMIT');
});
