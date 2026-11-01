import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SubmissionRecordSchema, type CoreTimer } from '@quiz/shared';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { VOTING_ERROR_CODES, VotingError, votingTallyIsConsistent } from '@quiz/shared/voting';
import { gameErrorCode } from './errors.js';
import { getGameEngineContract } from './engineContract.js';
import { createTimer, endTimer, pauseTimer, submitOnce } from './runtimePrimitives.js';
import { createWerIstDasState } from '../weristdas/state.js';
import { createNumericRound, parseNumericRoundState } from './numericSubmission.js';
import { createTextCardRound, parseTextCardRoundState } from './textCardSubmission.js';
import { createOrderingRound, parseOrderingRoundState } from './orderingSubmission.js';
import type { CoreActionContext } from './actionRules.js';
import type { ProjectionAudience } from './visibility.js';
import {
  VotingProjectionSchema, castVote, closeVotingPoll, createVotingPoll, parseVotingPollState, projectVotingPoll, tallyVotingPoll,
  votingOutcome, votingScopeOf, type VotingPollState, type VotingRelease, type VotingScope,
} from './votingPoll.js';

// Synthetic fixtures: ids/labels are NOT game presets and carry no author, role, solution or "real/fake" meaning.
const OPTIONS = ['aa', 'bb', 'cc', 'dd'];
const config = { schemaVersion: 1, prompt: 'Wähle eine Option.', options: OPTIONS.map(id => ({ optionId: id, label: `Option ${id}`, help: null })) };
const voter = (participantId: string, allowedOptionIds: string[], allowAbstain: boolean) => ({ participantId, allowedOptionIds, allowAbstain });
const roster = (revision = 'roster-1') => ({
  schemaVersion: 1, revision, voters: [
    voter('p1', ['aa', 'bb', 'cc', 'dd'], true),
    voter('p2', ['aa', 'cc', 'dd'], false), // explicit allowlist without 'bb' (own option in a later engine) — no default rule is implied
    voter('p3', ['aa', 'bb', 'cc', 'dd'], false),
    voter('p4', ['cc', 'dd'], true),
    voter('p5', [], true), // abstain-only
  ],
});
const fresh = (over: Partial<{ runIndex: number; roundId: string; pollId: string; eligibility: unknown; config: unknown }> = {}) =>
  createVotingPoll({ runIndex: 2, roundId: 'round-7', pollId: 'poll-1', config, eligibility: roster(), ...over });
const option = (optionId: string) => ({ schemaVersion: 1 as const, kind: 'OPTION' as const, optionId });
const abstain = () => ({ schemaVersion: 1 as const, kind: 'ABSTAIN' as const });
const timer = createTimer('COUNTDOWN', 1000, 20000); // accepts input until 21000 (exclusive)
const cast = (state: VotingPollState, participantId: string, input: unknown, now = 5000, t: CoreTimer = timer, scope: VotingScope = votingScopeOf(state)) =>
  castVote(state, { scope, participantId, input, timer: t, now });
const close = (state: VotingPollState, now = 8000) => closeVotingPoll(state, votingScopeOf(state), now);
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as Error).message; } return 'NO_ERROR'; };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
/** p1→aa, p2→aa, p3→cc, p4 abstains, p5 does not vote. Hand-derived: aa 2, bb 0, cc 1, dd 0. */
const standard = (now = 8000) => {
  let s = fresh();
  s = cast(s, 'p1', option('aa'), 5000); s = cast(s, 'p2', option('aa'), 5100); s = cast(s, 'p3', option('cc'), 5200); s = cast(s, 'p4', abstain(), 5300);
  return close(s, now);
};

describe('N4 atomic cast: one binding ballot per eligible participant', () => {
  it('accepts one option ballot bound to owner, run, round and poll; the previous state is untouched; no tally is stored', () => {
    const s0 = deepFreeze(fresh());
    const s1 = cast(s0, 'p1', option('aa'));
    expect(s1.ballots).toEqual([{ participantId: 'p1', ballot: option('aa'), castAtMs: 5000 }]);
    expect(s0.ballots).toEqual([]);
    expect(s1).toMatchObject({ kind: 'VOTING_POLL', runIndex: 2, roundId: 'round-7', pollId: 'poll-1', status: 'OPEN', closedAtMs: null });
    expect(JSON.stringify(s1)).not.toMatch(/tally|winner|score|votes/i);
  });
  it('accepts an explicit abstention where the voter may, and refuses it where the voter may not', () => {
    const s = cast(fresh(), 'p1', abstain());
    expect(s.ballots[0].ballot).toEqual(abstain());
    expect(err(() => cast(fresh(), 'p3', abstain()))).toBe('VOTING_INVALID'); // p3 has no abstention right
    expect(cast(fresh(), 'p5', abstain()).ballots).toHaveLength(1); // abstain-only voter
    expect(err(() => cast(fresh(), 'p5', option('aa')))).toBe('VOTING_INVALID');
  });
  it('only eligible participants may vote: strangers, viewers, hosts and display ids create no record', () => {
    const s = cast(fresh(), 'p1', option('aa'));
    const before = JSON.stringify(s);
    for (const who of ['stranger', 'viewer-1', 'host-1', 'display-1', '', 'P1', 'p1 ', '__proto__']) {
      expect(err(() => cast(s, who, option('aa'))), who).toBe('VOTING_NOT_ELIGIBLE');
    }
    expect(JSON.stringify(s)).toBe(before);
  });
  it('enforces the per-voter allowlist: a locked option is refused, an explicitly allowed one is accepted — no default rule', () => {
    expect(err(() => cast(fresh(), 'p2', option('bb')))).toBe('VOTING_INVALID'); // blocked by the explicit allowlist
    expect(cast(fresh(), 'p1', option('bb')).ballots[0].ballot).toEqual(option('bb')); // explicitly allowed for another voter
    expect(cast(fresh(), 'p3', option('bb')).ballots[0].ballot).toEqual(option('bb'));
    expect(cast(fresh(), 'p2', option('aa')).ballots).toHaveLength(1);
    expect(err(() => cast(fresh(), 'p4', option('aa')))).toBe('VOTING_INVALID'); // p4 may only choose cc / dd
  });
  it('is all-or-nothing: an invalid ballot leaves no partial record and burns no slot; a valid one still works afterwards', () => {
    const s1 = cast(fresh(), 'p1', option('aa'));
    const before = JSON.stringify(s1);
    for (const bad of [null, undefined, {}, option('zz'), option('Option aa'), { schemaVersion: 1, kind: 'OPTION' }, { schemaVersion: 1, kind: 'OPTION', optionIds: ['aa'] },
      { schemaVersion: 1, kind: 'OPTION', optionId: 'aa', voterId: 'p1' }, { schemaVersion: 1, kind: 'ABSTAIN', optionId: 'aa' }, 'aa', 0, 'ABSTAIN']) {
      let thrown: unknown;
      try { cast(s1, 'p2', bad); } catch (e) { thrown = e; }
      expect((thrown as Error).message).toBe('VOTING_INVALID');
      expect((thrown as VotingError).issues.length).toBeGreaterThan(0);
      expect(gameErrorCode(thrown)).toBe('VOTING_INVALID');
    }
    expect(JSON.stringify(s1)).toBe(before);
    expect(cast(s1, 'p2', option('cc')).ballots.map(r => r.participantId)).toEqual(['p1', 'p2']);
  });
  it('never overwrites or repeats an accepted ballot: a second cast is refused — identical, different, or option→abstention', () => {
    const s1 = cast(fresh(), 'p1', option('aa'));
    expect(err(() => cast(s1, 'p1', option('aa'), 5100))).toBe('VOTING_ALREADY_VOTED'); // also the identical one
    expect(err(() => cast(s1, 'p1', option('bb'), 5100))).toBe('VOTING_ALREADY_VOTED');
    expect(err(() => cast(s1, 'p1', abstain(), 5100))).toBe('VOTING_ALREADY_VOTED');
    const a1 = cast(fresh(), 'p1', abstain());
    expect(err(() => cast(a1, 'p1', option('aa'), 5100))).toBe('VOTING_ALREADY_VOTED'); // an abstention is binding as well
    expect(err(() => cast(a1, 'p1', abstain(), 5100))).toBe('VOTING_ALREADY_VOTED');
    expect(s1.ballots).toHaveLength(1);
    expect(close(s1).ballots[0].ballot).toEqual(option('aa'));
  });
  it('rejects a wrong scope instead of re-attaching: other run, round, poll (same round), re-shuffled options, other roster revision', () => {
    const s = fresh();
    const scope = votingScopeOf(s);
    const go = (over: Partial<VotingScope>) => err(() => castVote(s, { scope: { ...scope, ...over }, participantId: 'p1', input: option('aa'), timer, now: 5000 }));
    expect(go({})).toBe('NO_ERROR');
    expect(go({ runIndex: 3 })).toBe('STALE_ROUND');
    expect(go({ roundId: 'round-8' })).toBe('STALE_ROUND');
    expect(go({ pollId: 'poll-2' })).toBe('VOTING_POLL_STALE'); // a second vote in the same round
    expect(go({ optionsKey: JSON.stringify([1, ['bb', 'aa', 'cc', 'dd']]) })).toBe('VOTING_CONFIG_STALE');
    expect(go({ optionsKey: JSON.stringify([1, ['aa', 'bb', 'cc']]) })).toBe('VOTING_CONFIG_STALE');
    expect(go({ eligibilityRevision: 'roster-2' })).toBe('VOTING_ROSTER_STALE');
    expect(s.ballots).toEqual([]);
    expect(Object.keys(scope).sort()).toEqual(['eligibilityRevision', 'optionsKey', 'pollId', 'roundId', 'runIndex']);
  });
  it('a second poll of the same round starts empty: old ballots, receipts and acknowledgements are not re-used', () => {
    const first = cast(fresh(), 'p1', option('aa'));
    const second = fresh({ pollId: 'poll-2' });
    expect(second.ballots).toEqual([]);
    expect(err(() => castVote(second, { scope: votingScopeOf(first), participantId: 'p1', input: option('aa'), timer, now: 5000 }))).toBe('VOTING_POLL_STALE');
    expect(cast(second, 'p1', option('bb')).ballots[0].ballot).toEqual(option('bb')); // p1 may vote again — in the NEW poll only
    const changedRoster = fresh({ eligibility: roster('roster-2') });
    expect(err(() => castVote(changedRoster, { scope: votingScopeOf(first), participantId: 'p1', input: option('aa'), timer, now: 5000 }))).toBe('VOTING_ROSTER_STALE');
  });
  it('rejects a changed option set or roster by pinning: stored ballots are never re-read under other options', () => {
    const s1 = cast(fresh(), 'p1', option('aa'));
    const widened = { ...clone(s1), config: { ...clone(s1.config), options: [...s1.config.options, { optionId: 'ee', label: 'Neu', help: null }] } };
    // The widened config is internally valid, but the scope the caller pinned no longer matches: no silent late vote
    expect(err(() => castVote(widened, { scope: votingScopeOf(s1), participantId: 'p3', input: option('ee'), timer, now: 5000 }))).toBe('VOTING_CONFIG_STALE');
  });
});

describe('N4 deadline, pause and real close', () => {
  it('accepts immediately before the deadline and refuses exactly at the end, after it, while paused and when expired', () => {
    const s = fresh();
    expect(cast(s, 'p1', option('aa'), 20999).ballots).toHaveLength(1);
    expect(err(() => cast(s, 'p1', option('aa'), 21000))).toBe('TIME_EXPIRED');
    expect(err(() => cast(s, 'p1', option('aa'), 21001))).toBe('TIME_EXPIRED');
    expect(err(() => cast(s, 'p1', option('aa'), 5000, pauseTimer(timer, 3000)))).toBe('TIME_EXPIRED');
    expect(err(() => cast(s, 'p1', option('aa'), 5000, endTimer(timer, 5000)))).toBe('TIME_EXPIRED');
    expect(s.ballots).toEqual([]);
  });
  it('validates the clock value itself', () => {
    for (const now of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) expect(err(() => cast(fresh(), 'p1', option('aa'), now)), String(now)).toBe('INVALID_TIME');
  });
  it('really closes the whole poll: an eligible non-voter is locked out even while an external timer still runs', () => {
    const open = cast(fresh(), 'p1', option('aa'));
    expect(timer.status).toBe('RUNNING');
    const closed = close(open, 6000);
    expect(closed).toMatchObject({ status: 'CLOSED', closedAtMs: 6000 });
    expect(err(() => cast(closed, 'p3', option('aa'), 7000))).toBe('VOTING_POLL_CLOSED'); // never voted, timer is still running
    expect(err(() => cast(closed, 'p1', option('aa'), 7000))).toBe('VOTING_POLL_CLOSED');
    expect(err(() => cast(closed, 'stranger', option('aa'), 7000))).toBe('VOTING_POLL_CLOSED');
    expect(closed.ballots).toHaveLength(1);
  });
  it('closes an empty poll, idempotently and without moving the closing time; never before an accepted ballot', () => {
    const empty = close(fresh(), 6000);
    expect(empty).toMatchObject({ status: 'CLOSED', closedAtMs: 6000, ballots: [] });
    const again = closeVotingPoll(empty, votingScopeOf(empty), 9000);
    expect(again).toEqual(empty);
    expect(again.closedAtMs).toBe(6000);
    const s = cast(fresh(), 'p1', option('aa'), 5000);
    expect(err(() => close(s, 4999))).toBe('INVALID_TIME');
    expect(close(s, 5000).closedAtMs).toBe(5000);
    expect(err(() => close(fresh(), -1))).toBe('INVALID_TIME');
  });
  it('closing is scoped like casting', () => {
    const s = fresh();
    expect(err(() => closeVotingPoll(s, { ...votingScopeOf(s), pollId: 'poll-9' }, 6000))).toBe('VOTING_POLL_STALE');
    expect(err(() => closeVotingPoll(s, { ...votingScopeOf(s), runIndex: 9 }, 6000))).toBe('STALE_ROUND');
    expect(err(() => closeVotingPoll(s, { ...votingScopeOf(s), eligibilityRevision: 'x' }, 6000))).toBe('VOTING_ROSTER_STALE');
  });
  it('has one consistent status: OPEN iff there is no closing time, and the closing time never precedes a ballot', () => {
    const closed = standard(8000);
    expect(closed.status === 'CLOSED').toBe(closed.closedAtMs !== null);
    expect(Math.max(...closed.ballots.map(b => b.castAtMs))).toBeLessThanOrEqual(closed.closedAtMs as number);
    expect(fresh().closedAtMs).toBeNull();
  });
});

describe('N4 creation and stored-state validation', () => {
  it('refuses contradictory configuration/eligibility at creation, with codes only', () => {
    expect(err(() => fresh({ config: { ...config, options: [config.options[0]] } }))).toBe('VOTING_CONFIG_INVALID');
    expect(err(() => fresh({ config: { ...config, authorId: 'p1' } }))).toBe('VOTING_CONFIG_INVALID');
    expect(err(() => fresh({ eligibility: { ...roster(), voters: [voter('p1', ['aa', 'zz'], true)] } }))).toBe('VOTING_ELIGIBILITY_INVALID');
    expect(err(() => fresh({ eligibility: { ...roster(), voters: [voter('p1', ['aa'], true), voter('p1', ['bb'], true)] } }))).toBe('VOTING_ELIGIBILITY_INVALID');
    expect(err(() => fresh({ eligibility: { ...roster(), voters: [voter('p1', [], false)] } }))).toBe('VOTING_ELIGIBILITY_INVALID');
    expect(err(() => fresh({ eligibility: { ...roster(), voters: [] } }))).toBe('VOTING_ELIGIBILITY_INVALID');
    expect(err(() => fresh({ runIndex: 0 }))).toBe('VOTING_STATE_INVALID');
    expect(err(() => fresh({ pollId: 'bad id' }))).toBe('VOTING_STATE_INVALID');
    expect(err(() => fresh({ roundId: '' }))).toBe('VOTING_STATE_INVALID');
  });
  it('copies its inputs: later mutation of the config or roster object cannot change the stored poll', () => {
    const cfg = clone(config), el = clone(roster());
    const s = createVotingPoll({ runIndex: 2, roundId: 'round-7', pollId: 'poll-1', config: cfg, eligibility: el });
    cfg.options[0].label = 'MUTIERT'; el.voters[0].allowedOptionIds.push('zz'); el.voters.pop();
    expect(s.config.options[0].label).toBe('Option aa');
    expect(s.eligibility.voters).toHaveLength(5);
    expect(s.eligibility.voters[0].allowedOptionIds).toEqual(['aa', 'bb', 'cc', 'dd']);
  });
  it('refuses corrupt, foreign or tampered stored data in every entry point — and repairs, re-draws and re-counts nothing', () => {
    const good = standard();
    const mutate = (fn: (s: Record<string, any>) => void) => { const s = clone(good) as Record<string, any>; fn(s); return s; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const corrupt: Record<string, unknown> = {
      closedWithoutTime: mutate(s => { s.closedAtMs = null; }),
      openWithTime: mutate(s => { s.status = 'OPEN'; }),
      unknownOwner: mutate(s => { s.ballots[0].participantId = 'ghost'; }),
      duplicateOwner: mutate(s => { s.ballots[1].participantId = s.ballots[0].participantId; }),
      unknownOption: mutate(s => { s.ballots[0].ballot.optionId = 'zz'; }),
      forbiddenForOwner: mutate(s => { s.ballots[1].ballot.optionId = 'bb'; }), // p2 may not choose bb
      forbiddenAbstain: mutate(s => { s.ballots[2].ballot = { schemaVersion: 1, kind: 'ABSTAIN' }; }), // p3 may not abstain
      abstainWithOption: mutate(s => { s.ballots[3].ballot = { schemaVersion: 1, kind: 'ABSTAIN', optionId: 'cc' }; }),
      optionWithoutId: mutate(s => { s.ballots[0].ballot = { schemaVersion: 1, kind: 'OPTION' }; }),
      castAfterClose: mutate(s => { s.ballots[0].castAtMs = 9000; }),
      negativeTime: mutate(s => { s.ballots[0].castAtMs = -1; }),
      duplicateVoter: mutate(s => { s.eligibility.voters[1].participantId = 'p1'; }),
      rosterUnknownOption: mutate(s => { s.eligibility.voters[0].allowedOptionIds.push('zz'); }),
      rosterNoChoice: mutate(s => { s.eligibility.voters[2].allowedOptionIds = []; }),
      rosterEmpty: mutate(s => { s.eligibility.voters = []; s.ballots = []; }),
      duplicateOptions: mutate(s => { s.config.options[1].optionId = 'aa'; }),
      extraWinner: mutate(s => { s.winner = 'aa'; }),
      extraTally: mutate(s => { s.tally = { aa: 99 }; }),
      extraBallotKey: mutate(s => { s.ballots[0].ownerLabel = 'x'; }),
      wrongKind: mutate(s => { s.kind = 'ORDERING_ROUND'; }),
      wrongVersion: mutate(s => { s.schemaVersion = 2; }),
      ballotsNotArray: mutate(s => { s.ballots = {}; }),
      nullState: null, stringState: 'x', arrayState: [],
    };
    for (const [name, bad] of Object.entries(corrupt)) {
      expect(err(() => parseVotingPollState(bad)), name).toBe('VOTING_STATE_INVALID');
      expect(err(() => tallyVotingPoll(bad)), name).toBe('VOTING_STATE_INVALID');
      expect(err(() => votingOutcome(bad, 'p1')), name).toBe('VOTING_STATE_INVALID');
      expect(err(() => closeVotingPoll(bad, votingScopeOf(good), 9000)), name).toBe('VOTING_STATE_INVALID');
      expect(err(() => castVote(bad, { scope: votingScopeOf(good), participantId: 'p5', input: abstain(), timer, now: 5000 })), name).toBe('VOTING_STATE_INVALID');
      expect(err(() => projectVotingPoll({ role: 'VIEWER' }, bad, { options: [], result: [] })), name).toBe('VOTING_STATE_INVALID');
    }
    expect(parseVotingPollState(good)).toEqual(good);
  });
  it('survives a deep-frozen state (no mutation anywhere) and shares no object with its inputs or results', () => {
    const frozen = deepFreeze(standard());
    expect(() => tallyVotingPoll(frozen)).not.toThrow();
    expect(() => projectVotingPoll({ role: 'VIEWER' }, frozen, { options: ['VIEWERS'], result: ['VIEWERS'] })).not.toThrow();
    const open = deepFreeze(fresh());
    const next = cast(open, 'p1', option('aa'));
    expect(next.config).not.toBe(open.config);
    expect(next.eligibility).not.toBe(open.eligibility);
    next.ballots[0].ballot = abstain();
    expect(open.ballots).toEqual([]);
  });
});

describe('N4 tally: neutral facts of a closed poll', () => {
  it('counts a hand-derived example completely: per-option votes (also 0), participation, missing and the single most-voted option', () => {
    expect(tallyVotingPoll(standard())).toEqual({
      contract: 'VOTING_TALLY_V1', pollId: 'poll-1', eligibleCount: 5, castCount: 4, optionVoteCount: 3, abstainCount: 1, missingCount: 1,
      options: [{ optionId: 'aa', votes: 2 }, { optionId: 'bb', votes: 0 }, { optionId: 'cc', votes: 1 }, { optionId: 'dd', votes: 0 }],
      top: { kind: 'SINGLE', votes: 2, optionIds: ['aa'] },
    });
  });
  it('0 ballots: every option has 0 votes, everybody is missing, and nobody is a leader (no id, no all-zero group)', () => {
    const t = tallyVotingPoll(close(fresh()));
    expect(t).toMatchObject({ eligibleCount: 5, castCount: 0, optionVoteCount: 0, abstainCount: 0, missingCount: 5, top: { kind: 'NONE', votes: 0, optionIds: [] } });
    expect(t.options.map(o => o.votes)).toEqual([0, 0, 0, 0]);
  });
  it('only abstentions: counted as abstentions, not as missing and not as a leader', () => {
    let s = fresh();
    s = cast(s, 'p1', abstain()); s = cast(s, 'p4', abstain()); s = cast(s, 'p5', abstain());
    const t = tallyVotingPoll(close(s));
    expect(t).toMatchObject({ castCount: 3, optionVoteCount: 0, abstainCount: 3, missingCount: 2, top: { kind: 'NONE', optionIds: [] } });
    expect(votingTallyIsConsistent(t)).toBe(true);
  });
  it('reports several equally most-voted options as a neutral tie in presentation order — and keeps every single ballot', () => {
    let s = fresh();
    s = cast(s, 'p4', option('cc'), 5000); s = cast(s, 'p3', option('cc'), 5100); s = cast(s, 'p2', option('aa'), 5200); s = cast(s, 'p1', option('aa'), 5300);
    const closed = close(s);
    const t = tallyVotingPoll(closed);
    expect(t.top).toEqual({ kind: 'TIED', votes: 2, optionIds: ['aa', 'cc'] }); // presentation order, not vote order
    expect(t.options.map(o => o.votes)).toEqual([2, 0, 2, 0]);
    expect(closed.ballots.map(r => [r.participantId, r.ballot])).toEqual([['p4', option('cc')], ['p3', option('cc')], ['p2', option('aa')], ['p1', option('aa')]]); // a tie changes no ballot
    expect(t.missingCount).toBe(1);
  });
  it('full participation leaves nobody missing; a lone vote makes a single leader with 1 vote', () => {
    let s = fresh();
    s = cast(s, 'p1', option('dd')); s = cast(s, 'p2', option('aa')); s = cast(s, 'p3', option('bb')); s = cast(s, 'p4', option('cc')); s = cast(s, 'p5', abstain());
    const full = tallyVotingPoll(close(s));
    expect(full).toMatchObject({ castCount: 5, missingCount: 0, optionVoteCount: 4, abstainCount: 1, top: { kind: 'TIED', votes: 1, optionIds: ['aa', 'bb', 'cc', 'dd'] } });
    const lone = tallyVotingPoll(close(cast(fresh(), 'p3', option('dd'))));
    expect(lone.top).toEqual({ kind: 'SINGLE', votes: 1, optionIds: ['dd'] });
  });
  it('agrees with an independent oracle for EVERY assignment of 3 voters (125 cases) — and does not depend on the cast or storage order', () => {
    const three = { schemaVersion: 1, revision: 'r3', voters: ['p1', 'p2', 'p3'].map(id => voter(id, ['aa', 'bb', 'cc'], true)) };
    const choices: (string | null)[] = [null, 'ABSTAIN', 'aa', 'bb', 'cc'];
    const ids = ['p1', 'p2', 'p3'];
    let cases = 0;
    for (const a of choices) for (const b of choices) for (const c of choices) {
      const picked = [a, b, c];
      const run = (order: number[]) => {
        let s = createVotingPoll({ runIndex: 1, roundId: 'r', pollId: 'poll-x', config, eligibility: three });
        for (const i of order) { const choice = picked[i]; if (choice !== null) s = cast(s, ids[i], choice === 'ABSTAIN' ? abstain() : option(choice), 5000 + i); }
        const closed = close(s, 9000);
        return { closed, tally: tallyVotingPoll(closed) };
      };
      const forward = run([0, 1, 2]), backward = run([2, 1, 0]);
      expect(backward.tally).toEqual(forward.tally);
      const reversedStorage = { ...clone(forward.closed), ballots: clone(forward.closed.ballots).reverse() };
      expect(tallyVotingPoll(reversedStorage)).toEqual(forward.tally);
      // oracle: plain filters over the choice list (a different shape than the implementation)
      const optionVotes = (id: string) => picked.filter(p => p === id).length;
      const expectedVotes = OPTIONS.map(optionVotes);
      const abstentions = picked.filter(p => p === 'ABSTAIN').length, none = picked.filter(p => p === null).length;
      const best = Math.max(...expectedVotes);
      const leaders = best > 0 ? OPTIONS.filter((_, i) => expectedVotes[i] === best) : [];
      expect(forward.tally.options.map(o => o.votes)).toEqual(expectedVotes);
      expect(forward.tally).toMatchObject({ eligibleCount: 3, abstainCount: abstentions, missingCount: none, castCount: 3 - none, optionVoteCount: 3 - none - abstentions });
      expect(forward.tally.top.optionIds).toEqual(leaders);
      expect(forward.tally.top.kind).toBe(leaders.length === 0 ? 'NONE' : leaders.length === 1 ? 'SINGLE' : 'TIED');
      expect(votingTallyIsConsistent(forward.tally)).toBe(true);
      cases++;
    }
    expect(cases).toBe(125);
  });
  it('keeps the invariants: option votes + abstentions + missing = eligible, and the roster alone decides the denominator', () => {
    const t = tallyVotingPoll(standard());
    expect(t.optionVoteCount + t.abstainCount + t.missingCount).toBe(t.eligibleCount);
    expect(t.options.reduce((sum, o) => sum + o.votes, 0)).toBe(t.optionVoteCount);
    expect(t.eligibleCount).toBe(roster().voters.length);
    // viewers/displays/hosts cannot enlarge the denominator: they cannot even create a record
    const s = cast(fresh(), 'p1', option('aa'));
    for (const who of ['viewer-1', 'display-1', 'host-1']) expect(err(() => cast(s, who, option('aa')))).toBe('VOTING_NOT_ELIGIBLE');
    expect(tallyVotingPoll(close(s)).eligibleCount).toBe(5);
  });
  it('has no live count: an open poll has no tally and no outcome', () => {
    const open = cast(fresh(), 'p1', option('aa'));
    expect(err(() => tallyVotingPoll(open))).toBe('VOTING_NOT_CLOSED');
    expect(err(() => votingOutcome(open, 'p1'))).toBe('VOTING_NOT_CLOSED');
  });
  it('is deterministic, free of clock and randomness, and returns fresh objects; it decides nothing', () => {
    const closed = standard();
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const a = tallyVotingPoll(closed), b = tallyVotingPoll(closed);
      expect(b).toEqual(a);
      expect(b).not.toBe(a);
      expect(b.options).not.toBe(a.options);
      a.options[0].votes = 99;
      expect(tallyVotingPoll(closed).options[0].votes).toBe(2);
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); }
    expect(Object.keys(tallyVotingPoll(closed)).sort()).toEqual(['abstainCount', 'castCount', 'contract', 'eligibleCount', 'missingCount', 'optionVoteCount', 'options', 'pollId', 'top']);
    expect(JSON.stringify(tallyVotingPoll(closed))).not.toMatch(/winner|score|point|elimin|penalty|correct|author|participantId/i);
  });
  it('tells not cast, explicit abstention and a vote for an option apart — and nothing else', () => {
    const closed = standard();
    expect(votingOutcome(closed, 'p1')).toEqual({ kind: 'VOTED', optionId: 'aa' });
    expect(votingOutcome(closed, 'p4')).toEqual({ kind: 'ABSTAINED' });
    expect(votingOutcome(closed, 'p5')).toEqual({ kind: 'NOT_CAST' });
    expect(votingOutcome(closed, 'viewer-1')).toEqual({ kind: 'NOT_ELIGIBLE' });
  });
  it('a tie neither zeroes nor removes the per-vote facts a later engine needs (e.g. a fixed per-vote scoring)', () => {
    let s = fresh();
    s = cast(s, 'p1', option('aa')); s = cast(s, 'p2', option('cc'));
    const closed = close(s);
    expect(tallyVotingPoll(closed).top.kind).toBe('TIED');
    expect(votingOutcome(closed, 'p1')).toEqual({ kind: 'VOTED', optionId: 'aa' });
    expect(votingOutcome(closed, 'p2')).toEqual({ kind: 'VOTED', optionId: 'cc' });
  });
});

describe('N4 serialization, SDK replay and compatibility', () => {
  const snapshot = (state: Record<string, unknown>, stateVersion = 0): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 2, gameSlug: 'future-voting', engineVersion: 1, stateVersion, state });
  it('roundtrips open, voted, abstained and closed states and their tally through JSON unchanged', () => {
    const states = [fresh(), cast(fresh(), 'p1', option('bb')), cast(cast(fresh(), 'p1', abstain()), 'p3', option('aa'), 5100), standard()];
    for (const s of states) {
      const decoded = JSON.parse(JSON.stringify(s));
      expect(decoded).toEqual(s);
      expect(parseVotingPollState(decoded)).toEqual(s);
    }
    const closed = standard();
    expect(tallyVotingPoll(JSON.parse(JSON.stringify(closed)))).toEqual(tallyVotingPoll(closed));
    expect(votingScopeOf(parseVotingPollState(JSON.parse(JSON.stringify(closed))))).toEqual(votingScopeOf(closed));
  });
  it('replays through the existing SDK state events to an identical state and tally, without clock, randomness or a new vote', () => {
    const s0 = fresh(), s1 = cast(s0, 'p1', option('aa')), s2 = cast(s1, 'p4', abstain(), 5100), s3 = close(s2, 8000);
    const base = snapshot({ phase: 'VOTING', voting: s0, scores: { p1: 0 } });
    const e1 = createStateEvent(base, { phase: 'VOTING', voting: s1, scores: { p1: 0 } }, { eventId: randomUUID(), type: 'VOTE_CAST', commandId: 'c1', actorId: 'p1', occurredAtMs: 5000 });
    const mid1 = snapshot({ phase: 'VOTING', voting: s1, scores: { p1: 0 } }, 1);
    const e2 = createStateEvent(mid1, { phase: 'VOTING', voting: s2, scores: { p1: 0 } }, { eventId: randomUUID(), type: 'VOTE_CAST', commandId: 'c2', actorId: 'p4', occurredAtMs: 5100 });
    const mid2 = snapshot({ phase: 'VOTING', voting: s2, scores: { p1: 0 } }, 2);
    const e3 = createStateEvent(mid2, { phase: 'RESULT', voting: s3, scores: { p1: 0 } }, { eventId: randomUUID(), type: 'VOTE_CLOSED', commandId: 'c3', actorId: 'host', occurredAtMs: 8000 });
    const now = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const wire = JSON.parse(JSON.stringify([e1, e2, e3]));
      const replay = () => wire.reduce((snap: EngineStateSnapshot, event: unknown) => applyStateEvent(snap, event), base) as EngineStateSnapshot;
      const replayed = replay();
      expect(replay()).toEqual(replayed);
      expect(replayed.stateVersion).toBe(3);
      expect(parseVotingPollState(replayed.state.voting)).toEqual(s3);
      expect(tallyVotingPoll(replayed.state.voting)).toEqual(tallyVotingPoll(s3));
      expect(replayed.state.scores).toEqual({ p1: 0 }); // replay writes no points
      expect(now).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { now.mockRestore(); random.mockRestore(); }
  });
  it('rejects a foreign event scope or version, and a tampered reconstructed state is refused by the next domain call', () => {
    const s0 = fresh(), s1 = cast(s0, 'p1', option('aa'));
    const base = snapshot({ voting: s0 });
    const e = createStateEvent(base, { voting: s1 }, { eventId: randomUUID(), type: 'VOTE_CAST', commandId: null, actorId: null, occurredAtMs: 1 });
    expect(() => applyStateEvent({ ...base, runIndex: 3 }, e)).toThrow('EVENT_SCOPE_MISMATCH');
    expect(() => applyStateEvent({ ...base, gameSlug: 'other' }, e)).toThrow('EVENT_SCOPE_MISMATCH');
    expect(() => applyStateEvent({ ...base, stateVersion: 5 }, e)).toThrow('EVENT_VERSION_CONFLICT');
    const tampered = clone(e);
    (tampered.changes[0].value as { ballots: { participantId: string }[] }).ballots[0].participantId = 'ghost';
    expect(err(() => parseVotingPollState(applyStateEvent(base, tampered).state.voting))).toBe('VOTING_STATE_INVALID');
  });
  it('keeps string/null submissions readable and refuses ballots in the legacy contract and in the legacy answer path', () => {
    const legacy = { participantId: 'p', roundId: 'r', value: 'A', status: 'SUBMITTED', submittedAtMs: 1, judgedAtMs: null, decision: null };
    expect(SubmissionRecordSchema.parse(legacy)).toEqual(legacy);
    expect(SubmissionRecordSchema.parse({ ...legacy, value: null }).value).toBeNull();
    const record = cast(fresh(), 'p1', option('aa')).ballots[0];
    expect(SubmissionRecordSchema.safeParse(record).success).toBe(false);
    expect(SubmissionRecordSchema.safeParse({ ...legacy, value: record.ballot }).success).toBe(false);
    expect(() => submitOnce({ participantId: 'p', roundId: 'r', value: record.ballot as never, timer, now: 5000 })).toThrow();
    expect(submitOnce({ participantId: 'p', roundId: 'r', value: '7', timer, now: 5000 }).value).toBe('7');
    expect(err(() => cast(fresh(), 'p1', 'aa'))).toBe('VOTING_INVALID'); // a legacy string is no ballot
    expect(err(() => cast(fresh(), 'p1', null))).toBe('VOTING_INVALID');
  });
  it('N1, N2, N3 and N4 states are mutually unreadable; N1, N2 and N3 still work', () => {
    const numeric = createNumericRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, scale: 0, min: { units: 0, scale: 0 }, max: { units: 10, scale: 0 }, unit: null, boundsDisclosure: 'PUBLIC' } });
    const textCard = createTextCardRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, fields: [{ fieldId: 'alpha', label: 'A', help: null, required: true }], maxCodePointsPerField: 10, maxTotalCodePoints: 10 } });
    const ordering = createOrderingRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, prompt: null, directionHint: null, items: [{ itemId: 'aa', label: 'A', help: null }, { itemId: 'bb', label: 'B', help: null }] }, referenceRevision: null });
    for (const other of [numeric, textCard, ordering]) expect(err(() => parseVotingPollState(other))).toBe('VOTING_STATE_INVALID');
    expect(err(() => parseNumericRoundState(fresh()))).toBe('NUMERIC_STATE_INVALID');
    expect(err(() => parseTextCardRoundState(fresh()))).toBe('TEXT_CARD_STATE_INVALID');
    expect(err(() => parseOrderingRoundState(fresh()))).toBe('ORDERING_STATE_INVALID');
    expect(parseNumericRoundState(numeric)).toEqual(numeric);
    expect(parseTextCardRoundState(textCard)).toEqual(textCard);
    expect(parseOrderingRoundState(ordering)).toEqual(ordering);
  });
  it('gives the three real engines no vote entry point and no ballot as a choice or judge answer', () => {
    const context: CoreActionContext = { gameSlug: 'wer-ist-das', roomStatus: 'RUNNING', state: createWerIstDasState(1, { alice: 'Alice' }),
      informationRole: 'PLAYER', participantId: 'alice', active: true, permissions: new Set(['BUZZER_CONTROL']), now: 100 };
    for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) {
      const contract = getGameEngineContract(slug)!;
      for (const action of ['vote.cast', 'vote:submit', 'vote.close', 'voting:cast', 'castVote', 'closeVotingPoll']) {
        expect(contract.validateCommand({ ...context, gameSlug: slug }, { action, payload: option('aa') }), `${slug}/${action}`).toMatchObject({ success: false });
      }
    }
    expect(getGameEngineContract('wer-ist-das')!.validateCommand({ ...context, buzzerController: true }, { action: 'judge', payload: { result: option('aa') } })).toMatchObject({ success: false });
  });
  it('exposes every voting error code on the wire with its own code, and unknown ones stay INTERNAL_ERROR', () => {
    for (const code of VOTING_ERROR_CODES) expect(gameErrorCode(new Error(code)), code).toBe(code);
    expect(gameErrorCode(new VotingError('VOTING_NOT_ELIGIBLE'))).toBe('VOTING_NOT_ELIGIBLE');
    expect(gameErrorCode(new Error('VOTING_SOMETHING_ELSE'))).toBe('INTERNAL_ERROR');
  });
  it('keeps errors free of choices, participant ids, rosters, allowlists and labels', () => {
    const open = cast(fresh(), 'p1', option('aa'));
    const attempts: (() => unknown)[] = [
      () => cast(open, 'ghost-voter', option('GEHEIME-OPTION')), () => cast(open, 'p2', option('bb')), () => cast(open, 'p2', { schemaVersion: 1, kind: 'OPTION', optionId: 'GEHEIME-OPTION' }),
      () => cast(open, 'p1', option('aa')), () => cast(open, 'p3', abstain()), () => closeVotingPoll(open, { ...votingScopeOf(open), pollId: 'poll-GEHEIM' }, 9000),
      () => fresh({ eligibility: { ...roster(), voters: [voter('p9-GEHEIM', ['aa', 'zz-GEHEIM'], true)] } }), () => parseVotingPollState({ ...clone(open), ballots: [{ participantId: 'p9-GEHEIM', ballot: option('aa'), castAtMs: 1 }] }),
    ];
    for (const attempt of attempts) {
      try { attempt(); } catch (e) {
        const text = JSON.stringify([(e as Error).message, (e as { issues?: unknown }).issues ?? null, (e as Error).name]);
        expect(text).not.toMatch(/GEHEIM|ghost-voter|p1|p2|p3|p9|Option aa|allowedOptionIds/);
      }
    }
  });
});

describe('N4 visibility (domain projection only — no socket, rejoin or recovery is proven here)', () => {
  const none: VotingRelease = { options: [], result: [] };
  const audiences: Record<string, ProjectionAudience> = {
    owner: { role: 'PLAYER', participantId: 'p1', teamId: 't1' },
    partner: { role: 'PLAYER', participantId: 'p2', teamId: 't1' }, // same team as the owner, own right to vote
    other: { role: 'PLAYER', participantId: 'p3', teamId: 't2' },
    stranger: { role: 'PLAYER', participantId: 'zz', teamId: 't1' }, // a player not on the roster, even in the owner's team
    host: { role: 'HOST', participantId: null },
    blindHost: { role: 'HOST', blindHost: true, participantId: null },
    hostAsHost: { role: 'HOST', participantId: 'p3' }, // a playing host that was NOT projected with the PLAYER information role
    hostAsPlayer: { role: 'PLAYER', participantId: 'p3', teamId: null }, // the correct role for a playing host
    viewer: { role: 'VIEWER' },
    display: { role: 'DISPLAY' },
  };
  const closed = standard();
  const open = (() => { let s = fresh(); s = cast(s, 'p1', option('aa'), 5000); s = cast(s, 'p2', option('aa'), 5100); s = cast(s, 'p3', option('cc'), 5200); return cast(s, 'p4', abstain(), 5300); })();
  const everyone = ['VOTERS', 'PLAYERS', 'HOST', 'VIEWERS', 'DISPLAYS'] as const;
  const project = (who: keyof typeof audiences, state: unknown, release: VotingRelease) => projectVotingPoll(audiences[who], state, release);
  const text = (value: unknown) => JSON.stringify(value);
  const LEAKS = /castAtMs|allowedOptionIds|"voters"|"ballots"|participantId|"eligibility"|revision|roster|"p[1-5]"|authorId|isCorrect|seed/;

  it('releases NOTHING by default: no options, no aggregate, no foreign ballot — and the release decision is mandatory', () => {
    for (const who of Object.keys(audiences)) {
      const p = project(who, closed, none);
      expect(p.options, who).toBeNull();
      expect(p.result, who).toBeNull();
      expect(p).toMatchObject({ pollId: 'poll-1', status: 'CLOSED' });
      expect(VotingProjectionSchema.safeParse(p).success).toBe(true);
    }
    for (const bad of [undefined, null, {}, { options: [] }, { result: [] }, { options: [], result: [], extra: [] }, { options: ['EVERYONE'], result: [] },
      { options: ['VIEWERS', 'VIEWERS'], result: [] }, { options: 'VIEWERS', result: [] }, { options: [], result: [1] }, { options: ['VOTERS', 'PLAYERS', 'HOST', 'VIEWERS', 'DISPLAYS', 'VOTERS'], result: [] }]) {
      expect(err(() => projectVotingPoll(audiences.viewer, closed, bad)), JSON.stringify(bad)).toBe('VOTING_RELEASE_INVALID');
    }
  });
  it('shows the owner only the OWN accepted ballot — as private confirmation, independent of any release', () => {
    const owner = project('owner', open, none);
    expect(owner.own).toEqual({ ballot: option('aa'), selectableOptionIds: [], allowAbstain: false }); // choice list only once the options are released
    expect(text(owner)).not.toMatch(LEAKS);
    expect(project('partner', open, none).own?.ballot).toEqual(option('aa')); // p2's own ballot — which happens to be equal, not p1's
    expect(project('other', open, none).own?.ballot).toEqual(option('cc'));
    expect(project('hostAsPlayer', open, none).own?.ballot).toEqual(option('cc'));
  });
  it('gives nobody else a foreign ballot: team partner, other players, host, blind host, a playing host without the player role, viewer, display', () => {
    const casts = (() => { let s = fresh(); s = cast(s, 'p1', option('bb')); return s; })(); // only p1 voted, for bb
    for (const who of ['partner', 'other', 'stranger', 'host', 'blindHost', 'hostAsHost', 'viewer', 'display']) {
      const p = project(who, casts, { options: [...everyone], result: [] });
      expect(p.own?.ballot ?? null, who).toBeNull();
      expect(text(p), who).not.toMatch(/"kind":"(OPTION|ABSTAIN)"/); // the option LIST is public here; a BALLOT (kind) of p1 is not
    }
    expect(project('owner', casts, none).own?.ballot).toEqual(option('bb'));
  });
  it('gives no own data to anybody without a right to vote: stranger, host (even with a voter id), viewer, display', () => {
    for (const who of ['stranger', 'host', 'blindHost', 'hostAsHost', 'viewer', 'display']) expect(project(who, open, { options: [...everyone], result: [] }).own, who).toBeNull();
  });
  it('releases the options independently of the aggregate, per audience', () => {
    const onlyVoters = { options: ['VOTERS'], result: [] } as VotingRelease;
    for (const who of ['owner', 'partner', 'other', 'hostAsPlayer']) expect(project(who, open, onlyVoters).options, who).toEqual(config);
    for (const who of ['stranger', 'host', 'blindHost', 'hostAsHost', 'viewer', 'display']) expect(project(who, open, onlyVoters).options, who).toBeNull();
    const viewersToo = { options: ['VOTERS', 'VIEWERS', 'DISPLAYS'], result: [] } as VotingRelease;
    expect(project('viewer', open, viewersToo).options).toEqual(config);
    expect(project('display', open, viewersToo).options).toEqual(config);
    expect(project('host', open, viewersToo).options).toBeNull(); // administrative rights are no information rights
    expect(project('stranger', open, { options: ['PLAYERS'], result: [] }).options).toEqual(config); // PLAYERS = every player role
    expect(project('host', open, { options: ['HOST'], result: [] }).options).toEqual(config);
    expect(project('viewer', open, { options: ['VIEWERS'], result: [] }).result).toBeNull(); // options released, aggregate not
  });
  it('hands the voter exactly the OWN minimal choice list, stable over vote, lock and close — and never the roster or others\' lists', () => {
    const release = { options: ['VOTERS'], result: [] } as VotingRelease;
    const before = project('partner', fresh(), release).own;
    expect(before).toEqual({ ballot: null, selectableOptionIds: ['aa', 'cc', 'dd'], allowAbstain: false }); // p2: no 'bb', no abstention
    const voted = project('partner', cast(fresh(), 'p2', option('cc')), release).own;
    const after = project('partner', close(cast(fresh(), 'p2', option('cc'))), release).own;
    expect(voted).toEqual({ ballot: option('cc'), selectableOptionIds: ['aa', 'cc', 'dd'], allowAbstain: false });
    expect(after).toEqual(voted); // the list does not change when the voter votes or the poll closes
    expect(project('owner', fresh(), release).own).toEqual({ ballot: null, selectableOptionIds: ['aa', 'bb', 'cc', 'dd'], allowAbstain: true });
    expect(project('hostAsPlayer', fresh(), release).own?.selectableOptionIds).toEqual(['aa', 'bb', 'cc', 'dd']);
    for (const who of ['owner', 'partner', 'other']) expect(text(project(who, open, release)), who).not.toMatch(LEAKS);
  });
  it('releases the AGGREGATE only for a closed poll and only to the listed audiences — never a running count', () => {
    const release = { options: [], result: ['VIEWERS', 'DISPLAYS', 'VOTERS'] } as VotingRelease;
    const tally = tallyVotingPoll(closed);
    for (const who of ['viewer', 'display', 'owner', 'partner', 'other', 'hostAsPlayer']) expect(project(who, closed, release).result, who).toEqual(tally);
    for (const who of ['host', 'blindHost', 'hostAsHost', 'stranger']) expect(project(who, closed, release).result, who).toBeNull();
    expect(err(() => projectVotingPoll(audiences.viewer, open, release))).toBe('VOTING_NOT_CLOSED'); // not counted live
    expect(err(() => projectVotingPoll(audiences.host, open, { options: [], result: ['HOST'] }))).toBe('VOTING_NOT_CLOSED');
    for (const who of Object.keys(audiences)) {
      const p = project(who, open, none);
      expect(p.result, who).toBeNull();
      expect(text(p), who).not.toMatch(/optionVoteCount|abstainCount|missingCount|castCount|eligibleCount|"top"|"votes"/);
    }
  });
  it('after the aggregate is released, still NO ballot list, voter→option mapping, single timestamp, roster, allowlist or authorship goes out', () => {
    const release = { options: [...everyone], result: [...everyone] } as VotingRelease;
    for (const who of Object.keys(audiences)) {
      const p = project(who, closed, release);
      expect(p.result, who).toEqual(tallyVotingPoll(closed));
      expect(text(p), who).not.toMatch(LEAKS);
      expect(p.options).toEqual(config);
      if (p.own) expect(Object.keys(p.own).sort()).toEqual(['allowAbstain', 'ballot', 'selectableOptionIds']);
      expect(Object.keys(p).sort()).toEqual(['options', 'own', 'pollId', 'result', 'status']);
    }
    // the owner sees only his own ballot; the partner in the same team sees only his own
    expect(project('owner', closed, release).own?.ballot).toEqual(option('aa'));
    expect(project('other', closed, release).own?.ballot).toEqual(option('cc'));
    expect(project('viewer', closed, release).own).toBeNull();
  });
  it('does not apply a blanket "publicly revealed" to private ballots: a public result makes no single ballot public', () => {
    const release = { options: [], result: [...everyone] } as VotingRelease;
    const viewer = project('viewer', closed, release);
    expect(viewer.own).toBeNull();
    expect(text(viewer)).not.toMatch(/"kind":"(OPTION|ABSTAIN)"/);
    const stranger = project('stranger', closed, release);
    expect(stranger.own).toBeNull();
    expect(text(stranger)).not.toMatch(/"kind":"(OPTION|ABSTAIN)"/);
  });
  it('shows no author, role, correctness or seed marker on the options and no secret in the schema of the projection', () => {
    const p = project('viewer', closed, { options: ['VIEWERS'], result: [] });
    expect(text(p.options)).not.toMatch(/author|owner|isCorrect|role|solution|seed|participant/i);
    expect(Object.keys(VotingProjectionSchema.shape).sort()).toEqual(['options', 'own', 'pollId', 'result', 'status']);
    expect(VotingProjectionSchema.safeParse({ ...p, voters: ['p1'] }).success).toBe(false);
    expect(VotingProjectionSchema.safeParse({ ...p, ballots: [] }).success).toBe(false);
  });
  it('returns independent copies', () => {
    const p = project('viewer', closed, { options: ['VIEWERS'], result: ['VIEWERS'] });
    (p.options as { options: { label: string }[] }).options[0].label = 'MUTIERT';
    (p.result as { options: { votes: number }[] }).options[0].votes = 99;
    const again = project('viewer', closed, { options: ['VIEWERS'], result: ['VIEWERS'] });
    expect(again.options?.options[0].label).toBe('Option aa');
    expect(again.result?.options[0].votes).toBe(2);
  });
});
