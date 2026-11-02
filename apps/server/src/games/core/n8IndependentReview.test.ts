import { describe, expect, it } from 'vitest';
import { createParticipationTrack, participationScopeOf } from './participationTrack.js';
import {
  advanceTurnSequence, authorizeTurnAction, eligibilityFromParticipation, overrideTurnSequence,
  prepareTurnSequence, startTurnSequence, turnSequenceScopeOf, withholdCurrentHolder,
  type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';

const prepared = (runIndex = 1) => prepareTurnSequence({ runIndex, sequenceId: 'seq-review', rosterRevision: 'roster-review', unit: 'PLAYER', mode: 'FIXED', order: ['a', 'b'] });
const eligibility = (activeIds: string[], version: number): TurnEligibility => ({ actors: { runIndex: 1, trackId: 'track-review', rosterRevision: 'track-roster', version, knownIds: ['a', 'b'], activeIds }, members: null }); // runIndex: added when the contract gained the run binding (N8-03); the sequence below is run 1
const args = (s: TurnSequenceState) => ({ scope: turnSequenceScopeOf(s), expectedVersion: s.version, expectedTurnNumber: s.turnNumber });

describe('Independent N8 review at 93b8797', () => {
  it('a newer NO_ELIGIBLE observation must not be forgotten merely because a repeated search still finds nobody', () => {
    const p = prepared();
    const s = startTurnSequence(p, { scope: turnSequenceScopeOf(p), expectedVersion: 0, eligibility: eligibility([], 1) }).state;
    expect(s.phase).toBe('NO_ELIGIBLE');
    const observed = advanceTurnSequence(s, { ...args(s), outcome: 'SKIP', eligibility: eligibility([], 10) }).state;
    expect(() => advanceTurnSequence(observed, { ...args(observed), outcome: 'SKIP', eligibility: eligibility([], 2) })).toThrow('TURN_SEQ_ELIGIBILITY_STALE');
  });

  it('a newer eligibility basis seen while HELD must still fence a stale override', () => {
    const p = prepared();
    let s = startTurnSequence(p, { scope: turnSequenceScopeOf(p), expectedVersion: 0, eligibility: eligibility(['a', 'b'], 1) }).state;
    s = withholdCurrentHolder(s, { ...args(s), eligibility: eligibility(['b'], 2) }).state;
    expect(s.phase).toBe('HELD');
    s = withholdCurrentHolder(s, { ...args(s), eligibility: eligibility([], 10) }).state;
    expect(() => overrideTurnSequence(s, { ...args(s), target: { playerId: 'b' }, eligibility: eligibility(['b'], 3), now: 1000 })).toThrow('TURN_SEQ_ELIGIBILITY_STALE');
  });

  it('participation from another run cannot authorize a fresh sequence of a different run even if the participant IDs are reused', () => {
    const track = createParticipationTrack({ runIndex: 1, trackId: 'track-review', rosterRevision: 'track-roster', actorKind: 'PARTICIPANT', config: { livesMode: 'OFF' }, actors: [{ actorId: 'a', lives: null }, { actorId: 'b', lives: null }] });
    const foreign = eligibilityFromParticipation({ unit: 'PLAYER', actors: { track, scope: participationScopeOf(track) } });
    const control = prepared(1);
    const valid = startTurnSequence(control, { scope: turnSequenceScopeOf(control), expectedVersion: 0, eligibility: foreign }).state;
    expect(authorizeTurnAction(valid, { ...args(valid), caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: foreign }).allowed).toBe(true);
    const p = prepared(2);
    expect(() => {
      const s = startTurnSequence(p, { scope: turnSequenceScopeOf(p), expectedVersion: 0, eligibility: foreign }).state;
      authorizeTurnAction(s, { ...args(s), caller: { role: 'PLAYER', participantId: 'a', teamId: null }, gate: { admitted: true, phaseOpen: true, paused: false }, eligibility: foreign });
    }).toThrow();
  });

  it('an identical-target override must not forget a newer eligibility basis and then select an eliminated peer from an older snapshot', () => {
    const p = prepared();
    let s = startTurnSequence(p, { scope: turnSequenceScopeOf(p), expectedVersion: 0, eligibility: eligibility(['a', 'b'], 1) }).state;
    s = overrideTurnSequence(s, { ...args(s), target: { playerId: 'a' }, eligibility: eligibility(['a'], 10), now: 1000 }).state;
    expect(() => advanceTurnSequence(s, { ...args(s), outcome: 'COMPLETE', eligibility: eligibility(['a', 'b'], 2) })).toThrow('TURN_SEQ_ELIGIBILITY_STALE');
  });
});
