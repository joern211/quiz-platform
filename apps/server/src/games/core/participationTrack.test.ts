import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SubmissionRecordSchema, type CoreTurn } from '@quiz/shared';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { PARTICIPATION_ERROR_CODES, PARTICIPATION_MAX_ACTORS, PARTICIPATION_RELEASES, ParticipationError, ParticipationProjectionSchema, type ParticipationRelease } from '@quiz/shared/participation';
import { VotingBallotSchema } from '@quiz/shared/voting';
import { gameErrorCode } from './errors.js';
import { getGameEngineContract } from './engineContract.js';
import { coreActionDenial, type CoreActionContext } from './actionRules.js';
import { advanceTurn } from './roundFlow.js';
import { createWerIstDasState } from '../weristdas/state.js';
import { createNumericRound, parseNumericRoundState } from './numericSubmission.js';
import { createTextCardRound, parseTextCardRoundState } from './textCardSubmission.js';
import { createOrderingRound, parseOrderingRoundState } from './orderingSubmission.js';
import { createVotingPoll, parseVotingPollState } from './votingPoll.js';
import { createSecretRoleDeal, parseSecretRoleDealState, projectSecretInfo, secretRoleDealScopeOf } from './secretRoleDeal.js';
import type { ProjectionAudience } from './visibility.js';
import * as domain from './participationTrack.js';
import {
  actorPlayStatus, activeActorIds, activeActorsInOrder, changeLives, createParticipationTrack, eliminateActor, findNextActiveTurn, isActorActive,
  parseParticipationTrackState, participationScopeOf, projectParticipation, type ParticipationTrackScope, type ParticipationTrackState,
} from './participationTrack.js';

// Synthetic fixtures. Life values are distinguishable markers (777, 555 …); none of this is a game preset: start values, bounds
// and the zero-lives policy are explicit test inputs, not rules.
const IDS = ['p1', 'p2', 'p3', 'p4', 'p5'];
const START = [777, 555, 333, 222, 111];
const ON = (zeroLivesPolicy: 'ELIMINATE' | 'KEEP_ACTIVE', maxLives = 999) => ({ livesMode: 'ON' as const, maxLives, zeroLivesPolicy });
const OFF = { livesMode: 'OFF' as const };
const baseScope = { runIndex: 2, trackId: 'track-1', rosterRevision: 'roster-1', actorKind: 'PARTICIPANT' as const };
const input = (over: Record<string, unknown> = {}) => ({
  ...baseScope, config: ON('ELIMINATE'), actors: IDS.map((actorId, i) => ({ actorId, lives: START[i] })), ...over,
});
const fresh = (over: Record<string, unknown> = {}) => createParticipationTrack(input(over));
const lifeless = () => fresh({ config: OFF, actors: IDS.map(actorId => ({ actorId, lives: null })) });
const keep = (lives: number[] = [3, 1, 0, 2, 5]) => fresh({ config: ON('KEEP_ACTIVE', 5), actors: IDS.map((actorId, i) => ({ actorId, lives: lives[i] })) });
const scopeOf = (s: ParticipationTrackState): ParticipationTrackScope => participationScopeOf(s);
const loss = (s: ParticipationTrackState, actorId: string, delta: number, now = 5000, over: Record<string, unknown> = {}) =>
  changeLives(s, { scope: scopeOf(s), expectedVersion: s.version, actorId, delta, now, ...over });
const out = (s: ParticipationTrackState, actorId: string, now = 5000, over: Record<string, unknown> = {}) =>
  eliminateActor(s, { scope: scopeOf(s), expectedVersion: s.version, actorId, now, ...over });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
const message = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } return 'NO_ERROR'; };
const thrown = (fn: () => unknown): Error & { issues?: string[] } => { try { fn(); } catch (e) { return e as Error & { issues?: string[] }; } throw new Error('NO_ERROR'); };
const text = (value: unknown) => JSON.stringify(value);
const actor = (s: ParticipationTrackState, id: string) => s.actors.find(a => a.actorId === id)!;

describe('N6 track: contract and initial state', () => {
  it('creates a track from explicit start lives per actor: everybody ACTIVE, version 0, no history, nothing invented', () => {
    const s = fresh();
    expect(s).toMatchObject({ kind: 'PARTICIPATION_TRACK', schemaVersion: 1, runIndex: 2, trackId: 'track-1', rosterRevision: 'roster-1', actorKind: 'PARTICIPANT', version: 0, config: ON('ELIMINATE') });
    expect(s.actors).toEqual(IDS.map((actorId, i) => ({ actorId, status: 'ACTIVE', lives: START[i], elimination: null })));
    expect(Object.keys(s).sort()).toEqual(['actorKind', 'actors', 'config', 'kind', 'rosterRevision', 'runIndex', 'schemaVersion', 'trackId', 'version']);
    expect(parseParticipationTrackState(clone(s))).toEqual(s);
  });
  it('supports the life model OFF with an explicit null — never an invented counter — and OFF still allows an explicit elimination', () => {
    const s = lifeless();
    expect(s.config).toEqual({ livesMode: 'OFF' });
    expect(s.actors.every(a => a.lives === null && a.status === 'ACTIVE')).toBe(true);
    expect(actor(out(s, 'p2').state, 'p2')).toMatchObject({ status: 'ELIMINATED', lives: null });
  });
  it('supports both explicitly chosen zero-lives policies, with different start values per actor and a start value of 0 only under KEEP_ACTIVE', () => {
    expect(fresh({ config: ON('ELIMINATE', 3), actors: IDS.map((actorId, i) => ({ actorId, lives: [1, 2, 3, 1, 2][i] })) }).config).toEqual(ON('ELIMINATE', 3));
    const k = keep();
    expect(k.config).toEqual(ON('KEEP_ACTIVE', 5));
    expect(k.actors.map(a => a.lives)).toEqual([3, 1, 0, 2, 5]);
    expect(thrown(() => fresh({ config: ON('ELIMINATE', 5), actors: IDS.map((actorId, i) => ({ actorId, lives: [3, 1, 0, 2, 5][i] })) })).issues).toContain('ZERO_LIVES_CONFLICT'); // ACTIVE/0 is never repaired
  });
  it('invents no default: policy, bound, start value and mode must be given explicitly and validly', () => {
    for (const config of [undefined, null, {}, { livesMode: 'ON' }, { livesMode: 'ON', maxLives: 3 }, { livesMode: 'ON', zeroLivesPolicy: 'ELIMINATE' }, { livesMode: 'ON', maxLives: 3, zeroLivesPolicy: 'DEFAULT' },
      { livesMode: 'ON', maxLives: 3, zeroLivesPolicy: 'eliminate' }, { livesMode: 'on', maxLives: 3, zeroLivesPolicy: 'ELIMINATE' }, { livesMode: 'OFF', maxLives: 3 }, { livesMode: 'OFF', zeroLivesPolicy: 'ELIMINATE' },
      { livesMode: 'ON', maxLives: 0, zeroLivesPolicy: 'KEEP_ACTIVE' }, { livesMode: 'ON', maxLives: -1, zeroLivesPolicy: 'KEEP_ACTIVE' }, { livesMode: 'ON', maxLives: 1.5, zeroLivesPolicy: 'KEEP_ACTIVE' },
      { livesMode: 'ON', maxLives: 1001, zeroLivesPolicy: 'KEEP_ACTIVE' }, { livesMode: 'ON', maxLives: Number.NaN, zeroLivesPolicy: 'KEEP_ACTIVE' }, { livesMode: 'ON', maxLives: Infinity, zeroLivesPolicy: 'KEEP_ACTIVE' },
      { livesMode: 'ON', maxLives: 2 ** 53, zeroLivesPolicy: 'KEEP_ACTIVE' }, { livesMode: 'ON', maxLives: '3', zeroLivesPolicy: 'KEEP_ACTIVE' }, { livesMode: 'ON', maxLives: 3, zeroLivesPolicy: 'KEEP_ACTIVE', extra: 1 }]) {
      expect(message(() => fresh({ config })), JSON.stringify(config)).toBe('PARTICIPATION_TRACK_INVALID');
    }
    for (const actors of [undefined, 'AUTO', [], [{ actorId: 'p1' }], [{ lives: 3 }], [{ actorId: 'p1', lives: 3, status: 'ACTIVE' }], [{ actorId: 'p1', lives: 3, extra: 1 }]]) {
      expect(message(() => fresh({ actors })), JSON.stringify(actors)).toBe('PARTICIPATION_TRACK_INVALID');
    }
    expect(fresh({ config: ON('KEEP_ACTIVE', 1000), actors: [{ actorId: 'p1', lives: 1000 }] }).actors[0].lives).toBe(1000); // upper bound accepted exactly
  });
  it('keeps null and 0 apart, and rejects invalid, too large and unsafe start values', () => {
    const only = (config: unknown, lives: unknown) => fresh({ config, actors: [{ actorId: 'p1', lives }] });
    expect(only(OFF, null).actors[0].lives).toBeNull();
    expect(thrown(() => only(OFF, 0)).issues).toContain('LIVES_MODEL_CONFLICT'); // 0 is not "no model"
    expect(thrown(() => only(ON('KEEP_ACTIVE', 5), null)).issues).toContain('LIVES_MODEL_CONFLICT'); // null is not 0
    expect(only(ON('KEEP_ACTIVE', 5), 0).actors[0].lives).toBe(0);
    expect(thrown(() => only(ON('KEEP_ACTIVE', 5), 6)).issues).toContain('LIVES_OUT_OF_RANGE');
    for (const lives of [-1, 1.5, Number.NaN, Infinity, -Infinity, 2 ** 53, 2 ** 53 - 1 + 2, '3', true, undefined, {}, [], 1001]) {
      expect(message(() => only(ON('KEEP_ACTIVE', 1000), lives)), String(lives)).toBe('PARTICIPATION_TRACK_INVALID');
    }
  });
  it('separates PARTICIPANT and TEAM tracks: the same id text is never the same actor, the kind belongs to the checked scope', () => {
    const team = fresh({ actorKind: 'TEAM', trackId: 'track-1', actors: [{ actorId: 'p1', lives: 3 }, { actorId: 't1', lives: 2 }] });
    const participant = fresh({ actors: [{ actorId: 'p1', lives: 3 }, { actorId: 't1', lives: 2 }] });
    expect(team.actorKind).toBe('TEAM');
    const kindOnly = { ...scopeOf(participant), actorKind: 'TEAM' as const };
    expect(message(() => changeLives(participant, { scope: kindOnly, expectedVersion: 0, actorId: 'p1', delta: -1, now: 1 }))).toBe('PARTICIPATION_KIND_MISMATCH');
    expect(message(() => eliminateActor(team, { scope: scopeOf(participant), expectedVersion: 0, actorId: 'p1', now: 1 }))).toBe('PARTICIPATION_KIND_MISMATCH');
    expect(message(() => isActorActive(team, scopeOf(participant), 'p1'))).toBe('PARTICIPATION_KIND_MISMATCH');
    // the same id text in two tracks of different kinds evolves independently
    const a = out(participant, 'p1').state, b = loss(team, 'p1', -1).state;
    expect(actor(a, 'p1').status).toBe('ELIMINATED');
    expect(actor(b, 'p1')).toMatchObject({ status: 'ACTIVE', lives: 2 });
    expect(actor(team, 'p1').status).toBe('ACTIVE');
    // an id of the other kind is unknown in this track
    expect(actorPlayStatus(fresh({ actors: [{ actorId: 'p1', lives: 1 }] }), baseScope, 't1')).toBe('UNKNOWN');
  });
  it('rejects duplicate actors, an empty circle, invalid scope fields and versions, extra and missing fields', () => {
    expect(thrown(() => fresh({ actors: [{ actorId: 'p1', lives: 3 }, { actorId: 'p1', lives: 2 }] })).issues).toContain('ACTOR_DUPLICATE');
    for (const bad of [{ runIndex: 0 }, { runIndex: -1 }, { runIndex: 1.5 }, { runIndex: Number.NaN }, { runIndex: Infinity }, { runIndex: '2' }, { runIndex: 2 ** 53 },
      { trackId: '' }, { trackId: 'a b' }, { trackId: 'x'.repeat(81) }, { trackId: 7 }, { rosterRevision: '' }, { rosterRevision: '.x' }, { rosterRevision: 'x'.repeat(81) }, { rosterRevision: null },
      { actorKind: 'PLAYER' }, { actorKind: 'team' }, { actorKind: undefined }]) {
      expect(message(() => fresh(bad)), JSON.stringify(bad)).toBe('PARTICIPATION_TRACK_INVALID');
    }
    const base = input();
    for (const extra of ['kind', 'schemaVersion', 'version', 'status', 'seed', 'members']) expect(message(() => createParticipationTrack({ ...base, [extra]: 1 })), extra).toBe('PARTICIPATION_TRACK_INVALID');
    for (const key of Object.keys(base)) expect(message(() => createParticipationTrack(Object.fromEntries(Object.entries(base).filter(([name]) => name !== key)))), `missing ${key}`).toBe('PARTICIPATION_TRACK_INVALID');
    const polluted = JSON.parse(`{"__proto__": {"x": 1}, ${JSON.stringify(base).slice(1)}`) as unknown;
    expect(message(() => createParticipationTrack(polluted))).toBe('PARTICIPATION_TRACK_INVALID');
    class Weird { runIndex = 1; }
    for (const bad of [null, undefined, 'x', 7, [], new Weird(), Object.create({ inherited: 1 })]) expect(message(() => createParticipationTrack(bad)), String(bad)).toBe('PARTICIPATION_TRACK_INVALID');
    for (const id of ['', 'x'.repeat(201), 7, null]) expect(message(() => fresh({ actors: [{ actorId: id, lives: 1 }] })), String(id)).toBe('PARTICIPATION_TRACK_INVALID');
  });
  it('enforces the actor bound exactly and stops at LIMIT_EXCEEDED before any cross comparison', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ actorId: `a${i}`, lives: 1 }));
    expect(PARTICIPATION_MAX_ACTORS).toBe(100);
    expect(fresh({ actors: many(100) }).actors).toHaveLength(100);
    expect(thrown(() => fresh({ actors: many(101) })).issues).toEqual(['LIMIT_EXCEEDED']);
    // a LOADED over-long state with duplicates stops at the bound: the duplicate check is never run
    const over = clone(fresh({ actors: many(100) }));
    over.actors = [...over.actors, ...over.actors.slice(0, 5)];
    const error = thrown(() => parseParticipationTrackState(over));
    expect(error.message).toBe('PARTICIPATION_STATE_INVALID');
    expect(error.issues).toContain('LIMIT_EXCEEDED');
    expect(error.issues).not.toContain('ACTOR_DUPLICATE');
  });
  it('rejects a damaged loaded state as a whole — also ACTIVE with 0 lives under ELIMINATE — and accepts ELIMINATED with remaining lives', () => {
    const good = clone(fresh());
    const eliminatedWithLives = clone(out(fresh(), 'p1', 9000).state);
    expect(parseParticipationTrackState(eliminatedWithLives).actors[0]).toMatchObject({ status: 'ELIMINATED', lives: 777, elimination: { atMs: 9000, cause: 'EXPLICIT' } });
    expect(parseParticipationTrackState(clone(out(lifeless(), 'p1').state)).actors[0]).toMatchObject({ status: 'ELIMINATED', lives: null });
    const knockedOut = clone(loss(fresh({ actors: IDS.map(actorId => ({ actorId, lives: 1 })) }), 'p1', -1).state);
    expect(parseParticipationTrackState(knockedOut).actors[0]).toMatchObject({ status: 'ELIMINATED', lives: 0, elimination: { cause: 'ZERO_LIVES' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately loose: the test mutates arbitrary parts of a JSON clone
    const cases: [string, (s: any) => void, any?][] = [
      ['extra field', s => { s.role = 'x'; }], ['wrong kind', s => { s.kind = 'SECRET_ROLE_DEAL'; }], ['version 2', s => { s.schemaVersion = 2; }], ['no version field', s => { delete s.schemaVersion; }],
      ['ACTIVE/0 under ELIMINATE', s => { s.actors[0].lives = 0; }], ['ELIMINATED without elimination', s => { s.actors[0].status = 'ELIMINATED'; }],
      ['ACTIVE with elimination', s => { s.actors[0].elimination = { atMs: 1, cause: 'EXPLICIT' }; }],
      ['ZERO_LIVES with positive lives', s => { s.actors[0].status = 'ELIMINATED'; s.actors[0].elimination = { atMs: 1, cause: 'ZERO_LIVES' }; s.version = 1; }],
      ['lives above maxLives', s => { s.actors[0].lives = 1000; }], ['lives below 0', s => { s.actors[0].lives = -1; }], ['lives null under ON', s => { s.actors[0].lives = null; }],
      ['lives 1.5', s => { s.actors[0].lives = 1.5; }], ['lives string', s => { s.actors[0].lives = '3'; }], ['unsafe lives', s => { s.actors[0].lives = 2 ** 53; }],
      ['version -1', s => { s.version = -1; }], ['version 1.5', s => { s.version = 1.5; }], ['unsafe version', s => { s.version = 2 ** 53; }], ['version null (NaN in JSON)', s => { s.version = null; }],
      ['version below elimination count', s => { s.actors[0].status = 'ELIMINATED'; s.actors[0].elimination = { atMs: 1, cause: 'EXPLICIT' }; s.version = 0; }],
      ['elimination time -1', s => { s.actors[0].status = 'ELIMINATED'; s.actors[0].elimination = { atMs: -1, cause: 'EXPLICIT' }; s.version = 1; }],
      ['elimination time 1.5', s => { s.actors[0].status = 'ELIMINATED'; s.actors[0].elimination = { atMs: 1.5, cause: 'EXPLICIT' }; s.version = 1; }],
      ['unknown cause', s => { s.actors[0].status = 'ELIMINATED'; s.actors[0].elimination = { atMs: 1, cause: 'DISCONNECT' }; s.version = 1; }],
      ['elimination extra key', s => { s.actors[0].status = 'ELIMINATED'; s.actors[0].elimination = { atMs: 1, cause: 'EXPLICIT', reason: 'free text' }; s.version = 1; }],
      ['duplicate actor', s => { s.actors[1].actorId = 'p1'; }], ['actor key missing', s => { delete s.actors[0].elimination; }], ['actor extra key', s => { s.actors[0].connected = true; }],
      ['no actors', s => { s.actors = []; }], ['maxLives lowered below a value', s => { s.config.maxLives = 5; }],
      ['policy missing', s => { delete s.config.zeroLivesPolicy; }], ['mode OFF with lives', s => { s.config = { livesMode: 'OFF' }; }], ['bad status', s => { s.actors[0].status = 'DEAD'; }],
      ['config extra key', s => { s.config.default = 3; }], ['wrong types', s => { s.actors = 'p1'; }],
    ];
    for (const [name, mutate] of cases) {
      const copy = clone(good);
      mutate(copy);
      expect(message(() => parseParticipationTrackState(copy)), name).toBe('PARTICIPATION_STATE_INVALID');
      expect(message(() => changeLives(copy, { scope: scopeOf(good), expectedVersion: 0, actorId: 'p2', delta: -1, now: 1 })), `change ${name}`).toBe('PARTICIPATION_STATE_INVALID');
      expect(message(() => projectParticipation({ role: 'VIEWER' }, copy, { scope: scopeOf(good), release: 'STATUS', stateVersion: 1 })), `project ${name}`).toBe('PARTICIPATION_STATE_INVALID');
    }
    for (const junk of [null, undefined, 'x', 7, [], {}]) expect(message(() => parseParticipationTrackState(junk))).toBe('PARTICIPATION_STATE_INVALID');
  });
  it('does not retain, share or alter its input; invalid input changes nothing', () => {
    const frozen = deepFreeze(input());
    const snapshot = clone(frozen);
    const state = createParticipationTrack(frozen);
    expect(frozen).toEqual(snapshot);
    const live = input();
    const created = createParticipationTrack(live);
    const before = clone(created);
    live.actors[0].lives = 1; live.actors.push({ actorId: 'late', lives: 1 }); (live.config as { maxLives: number }).maxLives = 1; live.trackId = 'mutated';
    expect(created).toEqual(before);
    state.actors[0].lives = 1; state.actors.pop(); state.config = OFF as never;
    expect(createParticipationTrack(input())).toEqual(fresh());
    const bad = deepFreeze(input({ actors: [] }));
    expect(message(() => createParticipationTrack(bad))).toBe('PARTICIPATION_TRACK_INVALID');
  });
  it('keeps errors free of life values, bounds, ids, causes, times and raw state — message, issues, name, keys and stack', () => {
    const open = loss(fresh(), 'p1', -1).state;
    const attempts: (() => unknown)[] = [
      () => fresh({ actors: [{ actorId: 'p-GEHEIM', lives: 4242 }, { actorId: 'p-GEHEIM', lives: 4243 }] }), () => fresh({ config: { livesMode: 'ON', maxLives: 4242, zeroLivesPolicy: 'GEHEIM' } }),
      () => createParticipationTrack({ ...input(), GEHEIMKEY: 4242 }), () => parseParticipationTrackState({ ...clone(open), actors: [{ actorId: 'p-GEHEIM', status: 'ACTIVE', lives: 4242, elimination: null }] }),
      () => loss(open, 'p-GEHEIM', -1), () => loss(open, 'p2', -4242), () => loss(open, 'p2', 4242), () => loss(open, 'p2', -1, 1, { expectedVersion: 4242 }), () => loss(open, 'p2', -1, 654321.5),
      () => eliminateActor(open, { scope: { ...scopeOf(open), trackId: 'track-GEHEIM' }, expectedVersion: open.version, actorId: 'p2', now: 1 }),
      () => eliminateActor(open, { scope: { ...scopeOf(open), rosterRevision: 'roster-GEHEIM' }, expectedVersion: open.version, actorId: 'p2', now: 1 }),
      () => projectParticipation({ role: 'ADMIN' } as never, open, { scope: scopeOf(open), release: 'STATUS', stateVersion: 1 }),
      () => projectParticipation({ role: 'PLAYER' }, open, { scope: scopeOf(open), release: 'GEHEIM' as never, stateVersion: 1 }), () => activeActorsInOrder(open, scopeOf(open), ['p-GEHEIM']),
    ];
    for (const attempt of attempts) {
      const error = thrown(attempt);
      const serialized = text([error.message, error.issues ?? null, error.name, Object.keys(error), String(error.stack).split('\n')[0]]);
      expect(serialized).not.toMatch(/GEHEIM|4242|777|555|333|222|111|999|654321|track-1|roster-1|"p[1-5]"|ZERO_LIVES|EXPLICIT/);
      expect(Object.keys(error).filter(key => key !== 'name').sort()).toEqual(['code', 'issues']);
      expect(error.cause).toBeUndefined();
    }
  });
});

describe('N6 mutations: lives, elimination, versions', () => {
  it('applies an exact loss and an exact gain inside the bounds, one version step each, with a small private transition', () => {
    const s0 = deepFreeze(fresh({ config: ON('ELIMINATE', 5), actors: IDS.map((actorId, i) => ({ actorId, lives: [3, 5, 1, 2, 4][i] })) }));
    const lost = loss(s0, 'p1', -1, 5000);
    expect(lost.changed).toBe(true);
    expect(actor(lost.state, 'p1')).toEqual({ actorId: 'p1', status: 'ACTIVE', lives: 2, elimination: null });
    expect(lost.state.version).toBe(1);
    expect(lost.transition).toEqual({ actorKind: 'PARTICIPANT', actorId: 'p1', statusBefore: 'ACTIVE', statusAfter: 'ACTIVE', livesBefore: 3, livesAfter: 2, versionBefore: 0, versionAfter: 1 });
    expect(s0.version).toBe(0); // the input state is untouched (frozen)
    expect(actor(s0, 'p1').lives).toBe(3);
    const gained = loss(lost.state, 'p1', 3, 6000);
    expect(actor(gained.state, 'p1').lives).toBe(5); // exactly the bound
    expect(gained.state.version).toBe(2);
    const others = gained.state.actors.filter(a => a.actorId !== 'p1');
    expect(others).toEqual(s0.actors.filter(a => a.actorId !== 'p1')); // nobody else changed
    expect(actor(loss(s0, 'p2', -5, 7000).state, 'p2')).toMatchObject({ lives: 0, status: 'ELIMINATED' });
  });
  it('rejects zero, non-integer and non-numeric deltas and unsafe integer arithmetic without any change', () => {
    const s = fresh({ config: ON('ELIMINATE', 5), actors: IDS.map(actorId => ({ actorId, lives: 3 })) });
    for (const delta of [0, 1.5, -0.5, Number.NaN, Infinity, -Infinity, '1', null, undefined, true, [], {}, 2 ** 53, -(2 ** 53)]) {
      expect(message(() => loss(s, 'p1', delta as never)), String(delta)).toBe('PARTICIPATION_DELTA_INVALID');
    }
    for (const delta of [2 ** 53 - 1, -(2 ** 53 - 1), Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 3, -4]) {
      expect(message(() => loss(s, 'p1', delta)), String(delta)).toBe('PARTICIPATION_LIVES_OUT_OF_RANGE'); // safe integers that would overflow or underflow
    }
  });
  it('never clamps: an under- or overflow rejects the whole call and changes nothing', () => {
    const s = deepFreeze(fresh({ config: ON('ELIMINATE', 5), actors: [{ actorId: 'p1', lives: 1 }, { actorId: 'p2', lives: 5 }] }));
    expect(message(() => loss(s, 'p1', -2))).toBe('PARTICIPATION_LIVES_OUT_OF_RANGE'); // would not become 0 silently
    expect(message(() => loss(s, 'p2', 1))).toBe('PARTICIPATION_LIVES_OUT_OF_RANGE'); // would not become maxLives silently
    expect(message(() => loss(s, 'p2', 100))).toBe('PARTICIPATION_LIVES_OUT_OF_RANGE');
    expect(s.version).toBe(0);
    expect(s.actors.map(a => [a.status, a.lives])).toEqual([['ACTIVE', 1], ['ACTIVE', 5]]);
  });
  it('under ELIMINATE the last life sets lives 0 AND ELIMINATED in ONE return and ONE version step (no ACTIVE/0 intermediate state)', () => {
    const s = fresh({ config: ON('ELIMINATE', 5), actors: IDS.map((actorId, i) => ({ actorId, lives: [1, 3, 3, 3, 3][i] })) });
    const ko = loss(s, 'p1', -1, 8000);
    expect(actor(ko.state, 'p1')).toEqual({ actorId: 'p1', status: 'ELIMINATED', lives: 0, elimination: { atMs: 8000, cause: 'ZERO_LIVES' } });
    expect(ko.state.version).toBe(s.version + 1);
    expect(ko.transition).toMatchObject({ statusBefore: 'ACTIVE', statusAfter: 'ELIMINATED', livesBefore: 1, livesAfter: 0, versionBefore: 0, versionAfter: 1 });
    expect(parseParticipationTrackState(clone(ko.state))).toEqual(ko.state); // a valid state, no repair needed
    const three = loss(s, 'p2', -3, 8100); // also a larger exact loss that reaches 0
    expect(actor(three.state, 'p2')).toMatchObject({ lives: 0, status: 'ELIMINATED' });
    expect(three.state.version).toBe(1);
  });
  it('under KEEP_ACTIVE 0 lives leaves the actor ACTIVE — no elimination, no phase, no winner — and a deliberate later change stays possible', () => {
    const s = keep([2, 1, 0, 2, 5]);
    const zero = loss(s, 'p2', -1, 8000);
    expect(actor(zero.state, 'p2')).toEqual({ actorId: 'p2', status: 'ACTIVE', lives: 0, elimination: null });
    expect(zero.state.version).toBe(1);
    expect(zero.transition).toMatchObject({ statusBefore: 'ACTIVE', statusAfter: 'ACTIVE', livesAfter: 0 });
    expect(activeActorIds(zero.state, scopeOf(zero.state))).toEqual(IDS); // everybody is still active; nobody is declared out or winning
    expect(actor(loss(zero.state, 'p2', 2, 9000).state, 'p2')).toMatchObject({ status: 'ACTIVE', lives: 2 }); // an explicit change inside the bounds
    expect(actor(out(zero.state, 'p2', 9000).state, 'p2')).toMatchObject({ status: 'ELIMINATED', lives: 0, elimination: { cause: 'EXPLICIT' } });
  });
  it('rejects a life change without a life model, for an unknown actor and for an eliminated actor (also a positive one)', () => {
    expect(message(() => loss(lifeless(), 'p1', -1))).toBe('PARTICIPATION_LIVES_DISABLED');
    const s = out(fresh({ config: ON('ELIMINATE', 999) }), 'p1', 7000).state;
    expect(message(() => loss(s, 'p1', -1))).toBe('PARTICIPATION_ACTOR_ELIMINATED');
    expect(message(() => loss(s, 'p1', 1))).toBe('PARTICIPATION_ACTOR_ELIMINATED'); // not even positive: no revival
    for (const unknown of ['ghost', '', '__proto__', 'constructor', 7, null, undefined, 'P1']) expect(message(() => loss(s, unknown as never, -1)), String(unknown)).toBe('PARTICIPATION_ACTOR_UNKNOWN');
    expect(message(() => out(s, 'ghost'))).toBe('PARTICIPATION_ACTOR_UNKNOWN');
  });
  it('eliminates explicitly without inventing a life loss: positive lives and null stay, only the status changes', () => {
    const s = fresh();
    const gone = out(s, 'p1', 6000);
    expect(gone.changed).toBe(true);
    expect(actor(gone.state, 'p1')).toEqual({ actorId: 'p1', status: 'ELIMINATED', lives: 777, elimination: { atMs: 6000, cause: 'EXPLICIT' } });
    expect(gone.state.version).toBe(1);
    expect(gone.transition).toEqual({ actorKind: 'PARTICIPANT', actorId: 'p1', statusBefore: 'ACTIVE', statusAfter: 'ELIMINATED', livesBefore: 777, livesAfter: 777, versionBefore: 0, versionAfter: 1 });
    expect(gone.state.actors.filter(a => a.actorId !== 'p1')).toEqual(s.actors.filter(a => a.actorId !== 'p1'));
    const noModel = out(lifeless(), 'p3', 6000);
    expect(actor(noModel.state, 'p3')).toMatchObject({ status: 'ELIMINATED', lives: null }); // null stays null, never 0
    expect(noModel.transition).toMatchObject({ livesBefore: null, livesAfter: null });
  });
  it('treats a repeated elimination in the CURRENT context as a no-op: unchanged state, same version, FIRST time and cause kept', () => {
    const first = out(fresh(), 'p1', 5000).state;
    const again = out(first, 'p1', 99999);
    expect(again.changed).toBe(false);
    expect(again.transition).toBeNull();
    expect(again.state).toEqual(first);
    expect(again.state.version).toBe(first.version);
    expect(actor(again.state, 'p1').elimination).toEqual({ atMs: 5000, cause: 'EXPLICIT' });
    expect(again.state).not.toBe(first); // a fresh copy, never the same reference
    const koFirst = loss(fresh({ actors: IDS.map(actorId => ({ actorId, lives: 1 })) }), 'p1', -1, 4000).state;
    expect(actor(out(koFirst, 'p1', 8000).state, 'p1').elimination).toEqual({ atMs: 4000, cause: 'ZERO_LIVES' }); // the knock-out stays the first cause
  });
  it('checks scope and version BEFORE the no-op, so a stale repeat is never accepted for looking harmless', () => {
    const first = out(fresh(), 'p1', 5000).state;
    expect(message(() => eliminateActor(first, { scope: scopeOf(first), expectedVersion: 0, actorId: 'p1', now: 6000 }))).toBe('PARTICIPATION_VERSION_STALE');
    expect(message(() => eliminateActor(first, { scope: { ...scopeOf(first), runIndex: 3 }, expectedVersion: 1, actorId: 'p1', now: 6000 }))).toBe('PARTICIPATION_RUN_STALE');
    expect(message(() => eliminateActor(first, { scope: scopeOf(first), expectedVersion: 1, actorId: 'p1', now: -1 }))).toBe('PARTICIPATION_TIME_INVALID');
    expect(message(() => eliminateActor(first, { scope: scopeOf(first), expectedVersion: 1, actorId: 'ghost', now: 6000 }))).toBe('PARTICIPATION_ACTOR_UNKNOWN');
  });
  it('does not apply an old, repeated life loss again; a deliberate NEW change with the new version is a different, valid action', () => {
    const s0 = fresh({ config: ON('ELIMINATE', 5), actors: IDS.map(actorId => ({ actorId, lives: 4 })) });
    const call = { scope: scopeOf(s0), expectedVersion: 0, actorId: 'p1', delta: -1, now: 5000 };
    const s1 = changeLives(s0, call).state;
    expect(actor(s1, 'p1').lives).toBe(3);
    expect(message(() => changeLives(s1, call))).toBe('PARTICIPATION_VERSION_STALE'); // the same command with the old version
    expect(actor(s1, 'p1').lives).toBe(3); // nothing was taken again
    expect(s1.version).toBe(1);
    const s2 = changeLives(s1, { ...call, expectedVersion: 1 }).state; // a conscious new change
    expect(actor(s2, 'p1').lives).toBe(2);
    expect(s2.version).toBe(2);
    // a change for ANOTHER actor with the old version is stale too: the counter is per track, not per actor
    expect(message(() => changeLives(s1, { ...call, actorId: 'p2' }))).toBe('PARTICIPATION_VERSION_STALE');
    // a ko with the old version cannot create a second version step or a second elimination
    const k0 = fresh({ actors: IDS.map(actorId => ({ actorId, lives: 1 })) });
    const k1 = loss(k0, 'p1', -1).state;
    expect(message(() => changeLives(k1, { scope: scopeOf(k0), expectedVersion: 0, actorId: 'p1', delta: -1, now: 5000 }))).toBe('PARTICIPATION_VERSION_STALE');
    expect(k1.version).toBe(1);
  });
  it('rejects a malformed expectedVersion, wrong time values and wrong argument shapes — with the same code, no partial state', () => {
    const s = deepFreeze(fresh());
    for (const v of [undefined, null, '0', 0.5, -1, Number.NaN, Infinity, 2 ** 53, 1, 99]) expect(message(() => loss(s, 'p1', -1, 5000, { expectedVersion: v })), String(v)).toBe('PARTICIPATION_VERSION_STALE');
    for (const now of [Number.NaN, Infinity, -Infinity, -1, 1.5, '5', null, undefined, 2 ** 53, 1e300]) {
      expect(message(() => changeLives(s, { scope: scopeOf(s), expectedVersion: 0, actorId: 'p1', delta: -1, now: now as never })), `loss ${String(now)}`).toBe('PARTICIPATION_TIME_INVALID'); // validated although this loss would not eliminate
      expect(message(() => eliminateActor(s, { scope: scopeOf(s), expectedVersion: 0, actorId: 'p1', now: now as never })), `eliminate ${String(now)}`).toBe('PARTICIPATION_TIME_INVALID');
    }
    expect(loss(s, 'p1', -1, 0).state.version).toBe(1); // time 0 is a valid server time
    for (const extra of [{ all: true }, { force: 1 }]) {
      expect(message(() => changeLives(s, { scope: scopeOf(s), expectedVersion: 0, actorId: 'p1', delta: -1, now: 1, ...extra }))).toBe('PARTICIPATION_ARGS_INVALID');
      expect(message(() => eliminateActor(s, { scope: scopeOf(s), expectedVersion: 0, actorId: 'p1', now: 1, ...extra }))).toBe('PARTICIPATION_ARGS_INVALID');
    }
    expect(message(() => changeLives(s, { scope: scopeOf(s), expectedVersion: 0, actorId: 'p1', now: 1 } as never))).toBe('PARTICIPATION_ARGS_INVALID');
    for (const bad of [undefined, null, 'x', []]) expect(message(() => changeLives(s, bad as never))).toBe('PARTICIPATION_ARGS_INVALID');
    expect(s.version).toBe(0);
    expect(s.actors.map(a => a.lives)).toEqual(START);
  });
  it('refuses a change that would push the local version beyond a safe integer — a coded error, no partial state, no wrap-around', () => {
    const edge = parseParticipationTrackState({ ...clone(fresh()), version: Number.MAX_SAFE_INTEGER });
    expect(edge.version).toBe(Number.MAX_SAFE_INTEGER); // a valid, loadable state
    const frozen = deepFreeze(clone(edge));
    expect(message(() => changeLives(frozen, { scope: scopeOf(frozen), expectedVersion: Number.MAX_SAFE_INTEGER, actorId: 'p1', delta: -1, now: 1 }))).toBe('PARTICIPATION_STATE_INVALID');
    expect(message(() => eliminateActor(frozen, { scope: scopeOf(frozen), expectedVersion: Number.MAX_SAFE_INTEGER, actorId: 'p1', now: 1 }))).toBe('PARTICIPATION_STATE_INVALID');
    expect(frozen).toEqual(edge);
  });
  it('rejects a stale scope without any state change: run, track, roster revision, actor kind, malformed', () => {
    const s = deepFreeze(fresh());
    const base = scopeOf(s);
    const cases: [Record<string, unknown>, string][] = [
      [{ runIndex: 3 }, 'PARTICIPATION_RUN_STALE'], [{ trackId: 'track-2' }, 'PARTICIPATION_TRACK_STALE'], [{ rosterRevision: 'roster-2' }, 'PARTICIPATION_ROSTER_STALE'], [{ actorKind: 'TEAM' }, 'PARTICIPATION_KIND_MISMATCH'],
    ];
    for (const [change, code] of cases) {
      const wrong = { ...base, ...change } as ParticipationTrackScope;
      expect(message(() => changeLives(s, { scope: wrong, expectedVersion: 0, actorId: 'p1', delta: -1, now: 1 })), JSON.stringify(change)).toBe(code);
      expect(message(() => eliminateActor(s, { scope: wrong, expectedVersion: 0, actorId: 'p1', now: 1 }))).toBe(code);
      expect(message(() => isActorActive(s, wrong, 'p1'))).toBe(code);
      expect(message(() => activeActorIds(s, wrong))).toBe(code);
      expect(message(() => activeActorsInOrder(s, wrong, ['p1']))).toBe(code);
      expect(message(() => projectParticipation({ role: 'PLAYER', participantId: 'p1' }, s, { scope: wrong, release: 'STATUS', stateVersion: 1 }))).toBe(code);
    }
    for (const bad of [undefined, null, {}, { runIndex: 2 }, { ...base, extra: 1 }, 'track-1', [], { ...base, runIndex: undefined }, { ...base, actorKind: 'PLAYER' }]) {
      expect(message(() => changeLives(s, { scope: bad as never, expectedVersion: 0, actorId: 'p1', delta: -1, now: 1 })), JSON.stringify(bad)).toBe('PARTICIPATION_SCOPE_INVALID');
      expect(message(() => activeActorIds(s, bad as never))).toBe('PARTICIPATION_SCOPE_INVALID');
    }
    expect(s.version).toBe(0);
  });
  it('never revives: no positive life, no read, no re-load, no round change and no export that could', () => {
    const gone = loss(fresh({ actors: IDS.map(actorId => ({ actorId, lives: 1 })) }), 'p1', -1).state;
    expect(message(() => loss(gone, 'p1', 5))).toBe('PARTICIPATION_ACTOR_ELIMINATED');
    for (let i = 0; i < 3; i++) { projectParticipation({ role: 'PLAYER', participantId: 'p1' }, clone(gone), { scope: scopeOf(gone), release: 'STATUS_AND_LIVES', stateVersion: i }); }
    const reloaded = parseParticipationTrackState(clone(gone));
    expect(actor(reloaded, 'p1')).toMatchObject({ status: 'ELIMINATED', lives: 0 });
    expect(isActorActive(reloaded, scopeOf(reloaded), 'p1')).toBe(false);
    expect(Object.keys(domain).filter(name => /revive|revival|reset|reassign|transfer|undo|restore|heal|replace|reactivate|autoEliminate|winner/i.test(name))).toEqual([]);
  });
  it('keeps every state, return and transition independent of the others — real mutation attempts', () => {
    const s0 = fresh({ config: ON('ELIMINATE', 5), actors: IDS.map(actorId => ({ actorId, lives: 3 })) });
    const change = loss(s0, 'p1', -1);
    const before0 = clone(s0), before1 = clone(change.state);
    change.state.actors[0].lives = 99; change.state.actors.pop(); change.transition!.livesAfter = 99; (change.state.config as { maxLives: number }).maxLives = 1;
    expect(s0).toEqual(before0);
    expect(actor(loss(s0, 'p1', -1).state, 'p1').lives).toBe(2); // a new change from the untouched original gives the original result
    const again = out(s0, 'p2').state;
    again.actors[1].lives = 99; again.actors[1].elimination!.atMs = 1;
    expect(loss(s0, 'p2', -1).state.actors[1].lives).toBe(2);
    expect(parseParticipationTrackState(before1)).toEqual(loss(s0, 'p1', -1).state);
    const frozen = deepFreeze(clone(before1));
    expect(() => loss(frozen, 'p2', -1)).not.toThrow(); // a write on a frozen input would throw
    expect(frozen).toEqual(before1);
  });
});

describe('N6 rounds, runs, replay and activity queries', () => {
  it('keeps ONE track across rounds of the same run: remaining lives and eliminations are unchanged, nothing is recreated at a round transition', () => {
    const s0 = fresh({ config: ON('ELIMINATE', 5), actors: IDS.map(actorId => ({ actorId, lives: 2 })) });
    const round1 = loss(out(s0, 'p5', 1000).state, 'p1', -1, 2000).state;
    const snapshot = (round: string, value: ParticipationTrackState, stateVersion: number): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 2, gameSlug: 'future-lives', engineVersion: 1, stateVersion, state: { round, phase: 'PLAYING', participation: value } });
    const base = snapshot('round-1', round1, 4);
    const next = createStateEvent(base, { round: 'round-2', phase: 'PLAYING', participation: round1 }, { eventId: randomUUID(), type: 'ROUND_TRANSITION', commandId: 'c1', actorId: 'host', occurredAtMs: 9000 });
    expect(next.changes.map(c => c.key)).toEqual(['round']); // the track is not rewritten by a round change
    const round2 = applyStateEvent(base, JSON.parse(JSON.stringify(next))).state.participation;
    expect(parseParticipationTrackState(round2)).toEqual(round1);
    expect(activeActorIds(round2, scopeOf(round1))).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(actor(parseParticipationTrackState(round2), 'p1').lives).toBe(1);
    expect(actor(parseParticipationTrackState(round2), 'p5').status).toBe('ELIMINATED');
    expect(participationScopeOf(round1)).toEqual(scopeOf(s0)); // no round id anywhere in the scope
  });
  it('treats a new run, a new track or a new roster revision as independent, explicitly created data; the old scope is rejected', () => {
    const played = out(fresh(), 'p1', 5000).state;
    const rematch = fresh({ runIndex: 3 });
    expect(rematch.actors.every(a => a.status === 'ACTIVE' && a.elimination === null) && rematch.version === 0).toBe(true); // nothing taken over
    expect(actor(played, 'p1').status).toBe('ELIMINATED'); // and the old run is untouched
    expect(message(() => eliminateActor(rematch, { scope: scopeOf(played), expectedVersion: 0, actorId: 'p2', now: 1 }))).toBe('PARTICIPATION_RUN_STALE');
    const otherTrack = fresh({ trackId: 'track-2' });
    expect(message(() => isActorActive(otherTrack, scopeOf(played), 'p2'))).toBe('PARTICIPATION_TRACK_STALE');
    const reRostered = fresh({ rosterRevision: 'roster-2', actors: IDS.slice(0, 3).map(actorId => ({ actorId, lives: 5 })) });
    expect(message(() => activeActorIds(reRostered, scopeOf(played)))).toBe('PARTICIPATION_ROSTER_STALE'); // a changed roster is a different scope, no silent re-reading
    expect(message(() => projectParticipation({ role: 'PLAYER', participantId: 'p1' }, otherTrack, { scope: scopeOf(played), release: 'STATUS', stateVersion: 1 }))).toBe('PARTICIPATION_TRACK_STALE');
  });
  it('roundtrips JSON and replays SDK state events to the same state without clock, randomness or a second life loss', () => {
    const s0 = fresh({ config: ON('ELIMINATE', 5), actors: IDS.map(actorId => ({ actorId, lives: 2 })) });
    const s1 = loss(s0, 'p1', -1, 5000).state, s2 = loss(s1, 'p1', -1, 6000).state, s3 = out(s2, 'p3', 7000).state;
    for (const s of [s0, s1, s2, s3]) expect(parseParticipationTrackState(clone(s))).toEqual(s);
    expect(actor(s2, 'p1')).toMatchObject({ status: 'ELIMINATED', lives: 0 });
    const snapshot = (value: ParticipationTrackState, stateVersion: number): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 2, gameSlug: 'future-lives', engineVersion: 1, stateVersion, state: { participation: value, scores: { p1: 0 } } });
    const base = snapshot(s0, 0);
    const e1 = createStateEvent(base, { participation: s1, scores: { p1: 0 } }, { eventId: randomUUID(), type: 'LIVES_CHANGED', commandId: 'c1', actorId: 'host', occurredAtMs: 5000 });
    const e2 = createStateEvent(snapshot(s1, 1), { participation: s2, scores: { p1: 0 } }, { eventId: randomUUID(), type: 'ACTOR_ELIMINATED', commandId: 'c2', actorId: 'host', occurredAtMs: 6000 });
    const e3 = createStateEvent(snapshot(s2, 2), { participation: s3, scores: { p1: 0 } }, { eventId: randomUUID(), type: 'ACTOR_ELIMINATED', commandId: 'c3', actorId: 'host', occurredAtMs: 7000 });
    const clock = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const wire = JSON.parse(JSON.stringify([e1, e2, e3]));
      const replay = () => wire.reduce((snap: EngineStateSnapshot, event: unknown) => applyStateEvent(snap, event), base) as EngineStateSnapshot;
      const replayed = replay();
      expect(replay()).toEqual(replayed);
      expect(replayed.stateVersion).toBe(3);
      expect(parseParticipationTrackState(replayed.state.participation)).toEqual(s3);
      expect(actor(parseParticipationTrackState(replayed.state.participation), 'p1').lives).toBe(0); // replay applied each loss exactly once
      expect(replayed.state.scores).toEqual({ p1: 0 }); // replay writes no points
      expect(projectParticipation({ role: 'VIEWER' }, replayed.state.participation, { scope: scopeOf(s0), release: 'STATUS_AND_LIVES', stateVersion: 3 }))
        .toEqual(projectParticipation({ role: 'VIEWER' }, s3, { scope: scopeOf(s0), release: 'STATUS_AND_LIVES', stateVersion: 3 }));
      expect(clock).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); random.mockRestore(); }
    expect(() => applyStateEvent({ ...base, runIndex: 3 }, e1)).toThrow('EVENT_SCOPE_MISMATCH');
    expect(() => applyStateEvent({ ...base, stateVersion: 5 }, e1)).toThrow('EVENT_VERSION_CONFLICT');
    const tampered = clone(e1);
    (tampered.changes.find((c: { key: string }) => c.key === 'participation')!.value as { actors: { status: string }[] }).actors[0].status = 'ELIMINATED';
    expect(message(() => parseParticipationTrackState(applyStateEvent(base, tampered).state.participation))).toBe('PARTICIPATION_STATE_INVALID'); // ELIMINATED without elimination metadata
  });
  it('answers activity queries for known, eliminated and unknown actors — unknown and eliminated are never active', () => {
    const s = out(loss(fresh({ actors: IDS.map(actorId => ({ actorId, lives: 1 })) }), 'p2', -1).state, 'p4', 6000).state;
    const sc = scopeOf(s);
    expect(IDS.map(id => actorPlayStatus(s, sc, id))).toEqual(['ACTIVE', 'ELIMINATED', 'ACTIVE', 'ELIMINATED', 'ACTIVE']);
    expect(IDS.map(id => isActorActive(s, sc, id))).toEqual([true, false, true, false, true]);
    for (const unknown of ['ghost', '', '__proto__', 'constructor', 'P1', 7, null, undefined, ['p1'], { actorId: 'p1' }]) {
      expect(actorPlayStatus(s, sc, unknown as never), String(unknown)).toBe('UNKNOWN');
      expect(isActorActive(s, sc, unknown as never)).toBe(false);
    }
    expect(activeActorIds(s, sc)).toEqual(['p1', 'p3', 'p5']); // fixed roster order, no sorting
    const none = IDS.reduce((acc, id) => out(acc, id).state, s);
    expect(activeActorIds(none, sc)).toEqual([]); // nobody active is an empty answer, no automatic winner or end
    expect(Object.keys(domain).filter(name => /winner|placement|rank|gameOver|end(?!ors)/i.test(name))).toEqual([]);
  });
  it('does not turn a room-level state into gameplay: ACTIVE here does not override the admission-level `active` flag of the action context', () => {
    const s = fresh();
    expect(isActorActive(s, scopeOf(s), 'p1')).toBe(true); // gameplay layer: ACTIVE
    const context: CoreActionContext = { gameSlug: 'wer-ist-das', roomStatus: 'RUNNING', state: createWerIstDasState(1, { p1: 'P1' }), informationRole: 'PLAYER', participantId: 'p1',
      active: false, /* kicked / left / banned at the room level */ permissions: new Set(['BUZZER_CONTROL']), now: 100 };
    expect(coreActionDenial(context, 'buzz')).toBe('FORBIDDEN'); // the existing gate stays in force: BOTH layers must allow the action
    expect(coreActionDenial({ ...context, active: true }, 'buzz')).not.toBe('FORBIDDEN');
  });

  const order5 = (idsInOrder: string[] = IDS): CoreTurn => ({ mode: 'FIXED', order: idsInOrder, index: 0, cycle: 0 });
  const withStatuses = (active: boolean[]) => active.reduce((acc, isActive, i) => (isActive ? acc : out(acc, IDS[i]).state), fresh());

  it('filters a fixed order to the active actors and keeps the given order: all, gaps, first / last eliminated, one left, none left', () => {
    const sc = baseScope;
    expect(activeActorsInOrder(withStatuses([true, true, true, true, true]), sc, IDS)).toEqual(IDS);
    expect(activeActorsInOrder(withStatuses([true, false, true, false, true]), sc, IDS)).toEqual(['p1', 'p3', 'p5']);
    expect(activeActorsInOrder(withStatuses([false, true, true, true, true]), sc, IDS)).toEqual(['p2', 'p3', 'p4', 'p5']);
    expect(activeActorsInOrder(withStatuses([true, true, true, true, false]), sc, IDS)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(activeActorsInOrder(withStatuses([false, false, true, false, false]), sc, IDS)).toEqual(['p3']); // one left: a valid result, never a winner
    expect(activeActorsInOrder(withStatuses([false, false, false, false, false]), sc, IDS)).toEqual([]);
    expect(activeActorsInOrder(withStatuses([true, true, true, true, true]), sc, ['p4', 'p1', 'p5', 'p2'])).toEqual(['p4', 'p1', 'p5', 'p2']); // the given order is kept, not the roster order
    expect(activeActorsInOrder(withStatuses([true, false, true, true, true]), sc, ['p3'])).toEqual(['p3']); // a partial order is fine
  });
  it('rejects an empty, duplicated, unknown, malformed or over-long order — also ids of the other actor kind — instead of treating it as a turn', () => {
    const s = fresh({ actors: [{ actorId: 'p1', lives: 1 }, { actorId: 'p2', lives: 1 }] });
    const orderIssues = (order: unknown) => thrown(() => activeActorsInOrder(s, scopeOf(s), order as never));
    expect(orderIssues([]).issues).toEqual(['ORDER_EMPTY']);
    expect(orderIssues(['p1', 'p1']).issues).toEqual(['ORDER_DUPLICATE']);
    expect(orderIssues(['p1', 'ghost']).issues).toEqual(['ORDER_UNKNOWN_ACTOR']);
    expect(orderIssues(['t1']).issues).toEqual(['ORDER_UNKNOWN_ACTOR']); // a team id is no participant here
    expect(orderIssues(['p1', 7]).issues).toEqual(['SHAPE_INVALID']);
    expect(orderIssues('p1').issues).toEqual(['SHAPE_INVALID']);
    expect(orderIssues(null).issues).toEqual(['SHAPE_INVALID']);
    expect(orderIssues(Array.from({ length: PARTICIPATION_MAX_ACTORS + 1 }, (_, i) => `p${i}`)).issues).toEqual(['LIMIT_EXCEEDED']);
    expect(message(() => activeActorsInOrder(s, scopeOf(s), ['p1', 'ghost']))).toBe('PARTICIPATION_ORDER_INVALID');
    const teams = fresh({ actorKind: 'TEAM', actors: [{ actorId: 'p1', lives: 1 }, { actorId: 't1', lives: 1 }] });
    expect(activeActorsInOrder(teams, scopeOf(teams), ['t1', 'p1'])).toEqual(['t1', 'p1']); // the same texts are fine in their own track
  });
  it('finds the next active turn in a CoreTurn like advanceTurn does: skipping eliminated actors, wrapping at most once, cycle counted', () => {
    const s = withStatuses([true, false, true, true, false]);
    const sc = scopeOf(s);
    const a = findNextActiveTurn(s, sc, order5(), { includeCurrent: false });
    expect(a).toEqual({ kind: 'FOUND', turn: { mode: 'FIXED', order: IDS, index: 2, cycle: 0 }, skippedActorIds: ['p2'], wrapped: false });
    const b = findNextActiveTurn(s, sc, { ...order5(), index: 3 }, { includeCurrent: false });
    expect(b).toEqual({ kind: 'FOUND', turn: { mode: 'FIXED', order: IDS, index: 0, cycle: 1 }, skippedActorIds: ['p5'], wrapped: true }); // p5 skipped, wrap to p1, cycle +1
    const c = findNextActiveTurn(s, sc, { ...order5(), index: 1 }, { includeCurrent: true }); // the current actor was just eliminated
    expect(c).toEqual({ kind: 'FOUND', turn: { mode: 'FIXED', order: IDS, index: 2, cycle: 0 }, skippedActorIds: ['p2'], wrapped: false });
    const d = findNextActiveTurn(s, sc, { ...order5(), index: 2 }, { includeCurrent: true }); // an active current actor stays
    expect(d).toEqual({ kind: 'FOUND', turn: { mode: 'FIXED', order: IDS, index: 2, cycle: 0 }, skippedActorIds: [], wrapped: false });
    const e = findNextActiveTurn(s, sc, { ...order5(), index: 4, cycle: 6 }, { includeCurrent: false });
    expect(e).toMatchObject({ kind: 'FOUND', turn: { index: 0, cycle: 7 }, wrapped: true });
  });
  it('is the same as advanceTurn when everybody is active, for every position and cycle', () => {
    const s = fresh();
    for (let index = 0; index < IDS.length; index++) for (const cycle of [0, 3]) {
      const turn: CoreTurn = { mode: 'FIXED', order: IDS, index, cycle };
      const found = findNextActiveTurn(s, scopeOf(s), turn, { includeCurrent: false });
      expect(found.kind === 'FOUND' && found.turn).toEqual(advanceTurn(turn));
    }
  });
  it('finds one remaining actor again after a full wrap; with nobody active it returns NONE — no fallback, no undefined, no endless loop, no winner', () => {
    const one = withStatuses([false, false, true, false, false]);
    const found = findNextActiveTurn(one, scopeOf(one), { ...order5(), index: 2 }, { includeCurrent: false });
    expect(found).toEqual({ kind: 'FOUND', turn: { mode: 'FIXED', order: IDS, index: 2, cycle: 1 }, skippedActorIds: ['p4', 'p5', 'p1', 'p2'], wrapped: true });
    expect(Object.keys(found).sort()).toEqual(['kind', 'skippedActorIds', 'turn', 'wrapped']); // no winner, no "last one standing" field
    const none = withStatuses([false, false, false, false, false]);
    for (const includeCurrent of [true, false]) expect(findNextActiveTurn(none, scopeOf(none), order5(), { includeCurrent })).toEqual({ kind: 'NONE' });
    const big = Array.from({ length: 100 }, (_, i) => ({ actorId: `a${i}`, lives: 1 }));
    const allGone = big.reduce((acc, a) => out(acc, a.actorId).state, fresh({ actors: big }));
    expect(findNextActiveTurn(allGone, scopeOf(allGone), { mode: 'FIXED', order: big.map(a => a.actorId), index: 99, cycle: 0 }, { includeCurrent: false })).toEqual({ kind: 'NONE' }); // returns, bounded to one cycle
  });
  it('matches an independent brute-force oracle for every status pattern, start position and mode of the search', () => {
    for (let mask = 0; mask < 32; mask++) {
      const flags = IDS.map((_, i) => (mask & (1 << i)) !== 0);
      const s = withStatuses(flags);
      for (let index = 0; index < IDS.length; index++) for (const includeCurrent of [false, true]) {
        const turn: CoreTurn = { mode: 'FIXED', order: IDS, index, cycle: 2 };
        let expected: { index: number; cycle: number; skipped: string[] } | null = null;
        const skipped: string[] = [];
        for (let k = includeCurrent ? 0 : 1; k < (includeCurrent ? IDS.length : IDS.length + 1); k++) {
          const pos = index + k;
          if (flags[pos % IDS.length]) { expected = { index: pos % IDS.length, cycle: 2 + Math.floor(pos / IDS.length), skipped }; break; }
          skipped.push(IDS[pos % IDS.length]);
        }
        const found = findNextActiveTurn(s, scopeOf(s), turn, { includeCurrent });
        const tag = `mask ${mask} idx ${index} cur ${includeCurrent}`;
        if (expected === null) expect(found, tag).toEqual({ kind: 'NONE' });
        else expect(found, tag).toEqual({ kind: 'FOUND', turn: { mode: 'FIXED', order: IDS, index: expected.index, cycle: expected.cycle }, skippedActorIds: expected.skipped, wrapped: expected.cycle > 2 });
      }
    }
  });
  it('never re-sorts or re-draws: the given order and mode are returned as passed; nothing depends on connection state', () => {
    const s = withStatuses([true, true, false, true, true]);
    for (const mode of ['FIXED', 'RANDOM', 'ROTATING_START', 'CUSTOM_HOST_ORDER'] as const) {
      const turn: CoreTurn = { mode, order: ['p4', 'p1', 'p3', 'p5', 'p2'], index: 0, cycle: 0 };
      const found = findNextActiveTurn(s, scopeOf(s), turn, { includeCurrent: false });
      expect(found).toEqual({ kind: 'FOUND', turn: { mode, order: ['p4', 'p1', 'p3', 'p5', 'p2'], index: 1, cycle: 0 }, skippedActorIds: [], wrapped: false });
    }
    const random = vi.spyOn(Math, 'random');
    try { findNextActiveTurn(s, scopeOf(s), order5(), { includeCurrent: false }); expect(random).not.toHaveBeenCalled(); } finally { random.mockRestore(); }
    const turn = deepFreeze(order5());
    expect(() => findNextActiveTurn(s, scopeOf(s), turn, { includeCurrent: false })).not.toThrow();
    const result = findNextActiveTurn(s, scopeOf(s), order5(), { includeCurrent: false });
    if (result.kind === 'FOUND') result.turn.order.push('zz'); // a returned order is a copy
    expect(findNextActiveTurn(s, scopeOf(s), order5(), { includeCurrent: false })).toMatchObject({ turn: { order: IDS } });
  });
  it('rejects an invalid turn, an unknown or other-kind entry and bad options — never a valid turn', () => {
    const s = withStatuses([true, true, true, true, true]);
    const find = (turn: unknown, ...rest: unknown[]) => message(() => findNextActiveTurn(s, scopeOf(s), turn as never, (rest.length ? rest[0] : { includeCurrent: false }) as never));
    expect(find({ mode: 'FIXED', order: IDS, index: 5, cycle: 0 })).toBe('PARTICIPATION_ORDER_INVALID');
    expect(find({ mode: 'FIXED', order: ['p1', 'p1'], index: 0, cycle: 0 })).toBe('PARTICIPATION_ORDER_INVALID');
    expect(find({ mode: 'FIXED', order: [], index: 0, cycle: 0 })).toBe('PARTICIPATION_ORDER_INVALID');
    expect(find({ mode: 'FIXED', order: ['p1', 'ghost'], index: 0, cycle: 0 })).toBe('PARTICIPATION_ORDER_INVALID');
    expect(find({ mode: 'FIXED', order: ['t1'], index: 0, cycle: 0 })).toBe('PARTICIPATION_ORDER_INVALID');
    expect(find({ mode: 'LAST', order: IDS, index: 0, cycle: 0 })).toBe('PARTICIPATION_ORDER_INVALID');
    expect(find({ mode: 'FIXED', order: IDS, index: 0, cycle: 0, winner: 'p1' })).toBe('PARTICIPATION_ORDER_INVALID');
    expect(find(null)).toBe('PARTICIPATION_ORDER_INVALID');
    for (const options of [undefined, null, {}, { includeCurrent: 'yes' }, { includeCurrent: true, wrap: true }]) expect(find(order5(), options)).toBe('PARTICIPATION_ARGS_INVALID');
  });
});

describe('N6 projection: only explicitly allowed status and lives (domain projection only — no socket, rejoin or recovery is proven here)', () => {
  /** p1 777 ACTIVE, p2 555→ explicit elimination (lives kept), p3 333 lost one, p4 KO'd to 0, p5 111. Distinguishable markers everywhere. */
  const build = () => {
    let s = fresh();
    s = loss(s, 'p3', -1, 123456).state; // p3 → 332
    s = out(s, 'p2', 654321).state; // p2 stays 555, ELIMINATED
    s = loss(s, 'p4', -222, 777000).state; // p4 → 0, ELIMINATED (ZERO_LIVES)
    return s;
  };
  const state = build();
  const sc = scopeOf(state);
  const audiences: Record<string, ProjectionAudience> = {
    owner: { role: 'PLAYER', participantId: 'p1', teamId: 't1' },
    partner: { role: 'PLAYER', participantId: 'p5', teamId: 't1' }, // same team as the owner, own record
    other: { role: 'PLAYER', participantId: 'p3', teamId: 't2' },
    eliminated: { role: 'PLAYER', participantId: 'p2', teamId: 't2' },
    stranger: { role: 'PLAYER', participantId: 'zz', teamId: 't1' },
    host: { role: 'HOST', participantId: null },
    blindHost: { role: 'HOST', blindHost: true, participantId: null },
    hostAsHost: { role: 'HOST', participantId: 'p3' },
    hostAsPlayer: { role: 'PLAYER', participantId: 'p3', teamId: null },
    viewer: { role: 'VIEWER' },
    display: { role: 'DISPLAY' },
  };
  const project = (who: keyof typeof audiences, release: ParticipationRelease, s: unknown = state, stateVersion = 4242) => projectParticipation(audiences[who], s, { scope: sc, release, stateVersion });
  const PRIVATE = /maxLives|zeroLivesPolicy|livesMode|startLives|elimination|atMs|cause|ZERO_LIVES|EXPLICIT|"version"|123456|654321|777000|\b999\b|rosterList|members|connected|admission|leftAt|kickedAt|bannedAt|"role"|seed/;
  const view = (actorId: string, status: string, lives: unknown) => ({ actorId, status, lives });

  it('releases NOTHING to others by default: with NONE a stranger, viewer, display and host get only the envelope — and no derived sums', () => {
    for (const who of ['stranger', 'host', 'blindHost', 'hostAsHost', 'viewer', 'display']) {
      expect(project(who, 'NONE'), who).toEqual({ contract: 'PARTICIPATION_STATUS_V1', scope: sc, stateVersion: 4242, own: null, public: [] });
      expect(text(project(who, 'NONE')), who).not.toMatch(/ACTIVE|ELIMINATED|777|555|332|333|222|111|VALUE|HIDDEN|active|count|total|remaining/i);
    }
    for (const who of Object.keys(audiences)) expect(project(who, 'NONE').public, who).toEqual([]);
  });
  it('shows a player the OWN record — status and lives — through PLAYER_PRIVATE, and nothing of the others under NONE', () => {
    expect(project('owner', 'NONE').own).toEqual(view('p1', 'ACTIVE', { state: 'VALUE', value: 777 }));
    expect(project('other', 'NONE').own).toEqual(view('p3', 'ACTIVE', { state: 'VALUE', value: 332 }));
    expect(project('eliminated', 'NONE').own).toEqual(view('p2', 'ELIMINATED', { state: 'VALUE', value: 555 })); // eliminated with remaining lives stays a valid, readable own record
    expect(project('partner', 'NONE').own).toEqual(view('p5', 'ACTIVE', { state: 'VALUE', value: 111 })); // the team partner sees only his OWN record
    expect(project('hostAsPlayer', 'NONE').own).toEqual(project('other', 'NONE').own);
    expect(text(project('owner', 'NONE'))).not.toMatch(/555|332|222|111|"p[2-5]"/);
    expect(text(project('partner', 'NONE'))).not.toMatch(/777|555|332|222|"p[1-4]"/);
  });
  it('STATUS releases the status of everybody but NO life value, bound, start value, cause or time — checked on the serialized payload', () => {
    for (const who of ['stranger', 'host', 'blindHost', 'viewer', 'display', 'other']) {
      const p = project(who, 'STATUS');
      expect(p.public).toEqual([view('p1', 'ACTIVE', { state: 'HIDDEN' }), view('p2', 'ELIMINATED', { state: 'HIDDEN' }), view('p3', 'ACTIVE', { state: 'HIDDEN' }), view('p4', 'ELIMINATED', { state: 'HIDDEN' }), view('p5', 'ACTIVE', { state: 'HIDDEN' })]);
      expect(text({ ...p, own: null }), who).not.toMatch(/777|555|332|333|222|111|VALUE|NO_MODEL/); // the public part never carries a life value (the own record may)
      expect(text(p), who).not.toMatch(PRIVATE);
    }
    expect(project('owner', 'STATUS').own).toEqual(view('p1', 'ACTIVE', { state: 'VALUE', value: 777 })); // the owner's own lives remain his own data
    expect(project('owner', 'STATUS').public[0]).toEqual(view('p1', 'ACTIVE', { state: 'HIDDEN' })); // ... but the public entry does not carry them
  });
  it('STATUS_AND_LIVES releases the current lives together with the status — a real 0 included — and still no bound, policy, cause or time', () => {
    for (const who of ['stranger', 'host', 'blindHost', 'viewer', 'display']) {
      const p = project(who, 'STATUS_AND_LIVES');
      expect(p.public).toEqual([view('p1', 'ACTIVE', { state: 'VALUE', value: 777 }), view('p2', 'ELIMINATED', { state: 'VALUE', value: 555 }), view('p3', 'ACTIVE', { state: 'VALUE', value: 332 }),
        view('p4', 'ELIMINATED', { state: 'VALUE', value: 0 }), view('p5', 'ACTIVE', { state: 'VALUE', value: 111 })]);
      expect(text(p), who).not.toMatch(PRIVATE);
      expect(p.own, who).toBeNull();
    }
    const off = lifeless();
    const p = projectParticipation({ role: 'VIEWER' }, out(off, 'p2').state, { scope: scopeOf(off), release: 'STATUS_AND_LIVES', stateVersion: 1 });
    expect(p.public.map(a => a.lives)).toEqual(Array(5).fill({ state: 'NO_MODEL' })); // null with the model off — never an invented 0
    expect(text(p)).not.toMatch(/"value"/);
    const hidden = projectParticipation({ role: 'VIEWER' }, off, { scope: scopeOf(off), release: 'STATUS', stateVersion: 1 });
    expect(hidden.public.every(a => a.lives.state === 'HIDDEN')).toBe(true); // STATUS does not even reveal whether a life model exists
  });
  it('does not publish the private change counter or a count of hidden life losses — stateVersion is the caller\'s snapshot version', () => {
    const many = Array.from({ length: 6 }, (_, i) => i).reduce((acc) => loss(acc, 'p1', -1).state, build()); // the local counter keeps growing
    expect(many.version).toBeGreaterThan(state.version);
    for (const who of ['viewer', 'owner', 'host']) {
      const p = projectParticipation(audiences[who], many, { scope: scopeOf(many), release: 'STATUS', stateVersion: 4242 });
      expect(p.stateVersion).toBe(4242);
      expect(Object.keys(p).sort()).toEqual(['contract', 'own', 'public', 'scope', 'stateVersion']);
      expect(text({ ...p, own: null })).not.toContain(String(many.version));
    }
    expect(project('viewer', 'STATUS', many, 9).stateVersion).toBe(9);
  });
  it('gives a HOST — blind or not, playing or not — no own record and no hidden lives or status; a playing host is projected as PLAYER', () => {
    for (const who of ['host', 'blindHost', 'hostAsHost']) {
      expect(project(who, 'NONE'), who).toEqual({ contract: 'PARTICIPATION_STATUS_V1', scope: sc, stateVersion: 4242, own: null, public: [] });
      expect(project(who, 'STATUS').own, who).toBeNull();
    }
    expect(project('host', 'STATUS')).toEqual(project('blindHost', 'STATUS'));
    const rights = { role: 'PLAYER', participantId: 'p3', teamId: null, isAdmin: true, permissions: ['REVEAL_CONTENT', 'PLAYER_MANAGE'], blindHost: false } as unknown as ProjectionAudience;
    expect(projectParticipation(rights, state, { scope: sc, release: 'NONE', stateVersion: 1 }).own).toEqual(project('hostAsPlayer', 'NONE').own);
    const hostWithRights = { role: 'HOST', participantId: 'p1', isAdmin: true, permissions: ['REVEAL_CONTENT'] } as unknown as ProjectionAudience;
    expect(projectParticipation(hostWithRights, state, { scope: sc, release: 'NONE', stateVersion: 1 }).own).toBeNull(); // administrative rights open no hidden gameplay data
  });
  it('gives VIEWER and DISPLAY no own position, whatever id they carry; a stranger and a wrong participant id get no private view', () => {
    expect(projectParticipation({ role: 'VIEWER', participantId: 'p1' }, state, { scope: sc, release: 'NONE', stateVersion: 1 }).own).toBeNull();
    expect(projectParticipation({ role: 'DISPLAY', participantId: 'p1', teamId: 't1' }, state, { scope: sc, release: 'STATUS_AND_LIVES', stateVersion: 1 }).own).toBeNull();
    expect(project('stranger', 'NONE').own).toBeNull();
    expect(projectParticipation({ role: 'PLAYER', participantId: null }, state, { scope: sc, release: 'NONE', stateVersion: 1 }).own).toBeNull();
    expect(projectParticipation({ role: 'PLAYER' }, state, { scope: sc, release: 'NONE', stateVersion: 1 }).own).toBeNull();
  });
  it('in a TEAM track gives the own TEAM record through TEAM_PRIVATE to players of that team only — a team id text alone, a wrong team or a participant id is no proof', () => {
    const team = fresh({ actorKind: 'TEAM', actors: [{ actorId: 't1', lives: 333 }, { actorId: 't2', lives: 222 }, { actorId: 'p9', lives: 111 }] });
    const tsc = scopeOf(team);
    const as = (audience: ProjectionAudience) => projectParticipation(audience, team, { scope: tsc, release: 'NONE', stateVersion: 1 }).own;
    expect(as({ role: 'PLAYER', participantId: 'p1', teamId: 't1' })).toEqual(view('t1', 'ACTIVE', { state: 'VALUE', value: 333 }));
    expect(as({ role: 'PLAYER', participantId: 'p2', teamId: 't1' })).toEqual(view('t1', 'ACTIVE', { state: 'VALUE', value: 333 })); // a team partner: the TEAM's record
    expect(as({ role: 'PLAYER', participantId: 'p3', teamId: 't2' })).toEqual(view('t2', 'ACTIVE', { state: 'VALUE', value: 222 }));
    expect(as({ role: 'PLAYER', participantId: 'p4', teamId: 'tX' })).toBeNull(); // a wrong team
    expect(as({ role: 'PLAYER', participantId: 'p4', teamId: null })).toBeNull();
    expect(as({ role: 'PLAYER', participantId: 't1', teamId: null })).toBeNull(); // the participant id text equals a team id: no proof
    expect(as({ role: 'PLAYER', participantId: 'p9', teamId: null })).toBeNull(); // a participant id equal to a TEAM actor id of the track: still no team
    expect(as({ role: 'HOST', participantId: null, teamId: 't1' })).toBeNull(); // the host role never gets the team's private record
    expect(as({ role: 'VIEWER', teamId: 't1' })).toBeNull();
    expect(as({ role: 'DISPLAY', teamId: 't1' })).toBeNull();
    // and in a PARTICIPANT track a team id is no own record at all
    expect(projectParticipation({ role: 'PLAYER', participantId: 'zz', teamId: 'p1' }, state, { scope: sc, release: 'NONE', stateVersion: 1 }).own).toBeNull();
    expect(text(projectParticipation({ role: 'PLAYER', participantId: 'p1', teamId: 't1' }, team, { scope: tsc, release: 'NONE', stateVersion: 1 }))).not.toMatch(/p9|members|"p[0-9]"/); // no member list
  });
  it('keeps an ELIMINATED player exactly a PLAYER: no extra rights, no secret, no role switch — N5 knowledge is unchanged and independent', () => {
    const deal = createSecretRoleDeal({ runIndex: 2, roundId: 'round-7', dealId: 'deal-1', revision: 'rev-1', participantIds: IDS, roleIds: ['rolemarkerzulu', 'rolemarkeryankee'],
      assignments: IDS.map((participantId, i) => ({ participantId, roleId: i % 2 ? 'rolemarkeryankee' : 'rolemarkerzulu' })),
      fragments: [{ fragmentId: 'fragalpha', title: 'TITLE_ALPHA', text: 'TEXT_ALPHA', recipientIds: ['p2'] }, { fragmentId: 'fragbravo', title: 'TITLE_BRAVO', text: 'TEXT_BRAVO', recipientIds: ['p1'] }] });
    const before = projectSecretInfo({ role: 'PLAYER', participantId: 'p2' }, deal, secretRoleDealScopeOf(deal));
    const alive = fresh();
    const gone = out(alive, 'p2', 5000).state;
    // elimination does not touch the N5 deal or its projection; and nothing of N5 leaks into the participation projection
    expect(projectSecretInfo({ role: 'PLAYER', participantId: 'p2' }, deal, secretRoleDealScopeOf(deal))).toEqual(before);
    expect(before.own!.fragments).toEqual([{ title: 'TITLE_ALPHA', text: 'TEXT_ALPHA' }]); // still exactly the explicitly allowed knowledge
    expect(text(projectSecretInfo({ role: 'PLAYER', participantId: 'p2' }, deal, secretRoleDealScopeOf(deal)))).not.toMatch(/BRAVO|rolemarker/);
    for (const release of PARTICIPATION_RELEASES) {
      const p = projectParticipation({ role: 'PLAYER', participantId: 'p2' }, gone, { scope: scopeOf(gone), release, stateVersion: 1 });
      expect(text(p), release).not.toMatch(/ALPHA|BRAVO|rolemarker|frag|TEXT_|TITLE_/);
      expect(p.own).toEqual(view('p2', 'ELIMINATED', { state: 'VALUE', value: 555 })); // an eliminated PLAYER still has his own record
      const viewerView = projectParticipation({ role: 'VIEWER' }, gone, { scope: scopeOf(gone), release, stateVersion: 1 });
      expect(viewerView.own).toBeNull(); // not turned into an all-knowing spectator
    }
    // the track knows nothing about room role, admission or connection: no such field exists to be changed
    expect(text(gone)).not.toMatch(/connected|admission|leftAt|kickedAt|bannedAt|rejoin|socket|"role"|roleId|permission/i);
    expect(Object.keys(gone.actors[0]).sort()).toEqual(['actorId', 'elimination', 'lives', 'status']);
    expect(gone.version).toBe(1); // the elimination was ONE local change and nothing else
  });
  it('maps ADMIN / unknown roles and malformed audiences, releases and arguments to coded errors — never to a guess', () => {
    const call = (audience: unknown, ...rest: unknown[]) => message(() => projectParticipation(audience as never, state, { scope: sc, release: (rest.length > 0 ? rest[0] : 'NONE') as never, stateVersion: (rest.length > 1 ? rest[1] : 1) as never }));
    for (const bad of [{ role: 'ADMIN' }, { role: 'ADMIN', participantId: 'p1' }, { role: 'player', participantId: 'p1' }, { role: undefined }, {}, null, undefined, 'PLAYER', [],
      { role: 'PLAYER', participantId: 7 }, { role: 'PLAYER', participantId: '' }, { role: 'PLAYER', participantId: 'p'.repeat(201) }, { role: 'PLAYER', participantId: 'p1', teamId: 7 }, { role: 'PLAYER', teamId: '' }]) {
      expect(call(bad), JSON.stringify(bad)).toBe('PARTICIPATION_AUDIENCE_INVALID');
    }
    for (const release of [undefined, null, 'ALL', 'status', 'NONE ', ['STATUS'], 7, {}, 'LIVES', 'STATUS_ONLY']) expect(call({ role: 'VIEWER' }, release), String(release)).toBe('PARTICIPATION_RELEASE_INVALID');
    for (const version of [-1, 1.5, Number.NaN, Infinity, '1', null, undefined, 2 ** 53]) expect(call({ role: 'VIEWER' }, 'NONE', version), String(version)).toBe('PARTICIPATION_ARGS_INVALID');
    expect(message(() => projectParticipation({ role: 'VIEWER' }, state, { scope: sc, release: 'NONE', stateVersion: 1, all: true } as never))).toBe('PARTICIPATION_ARGS_INVALID');
    expect(message(() => projectParticipation({ role: 'VIEWER' }, state, { scope: sc, release: 'NONE' } as never))).toBe('PARTICIPATION_ARGS_INVALID'); // the release is REQUIRED — no default
    expect(call({ role: 'VIEWER' }, 'NONE', 0)).not.toBe('PARTICIPATION_ARGS_INVALID'); // 0 is a valid snapshot version
  });
  it('serializes only allowlisted fields for every audience, release and track variant — no counter, bound, policy, cause, time, roster or role anywhere', () => {
    const variants: [string, ParticipationTrackState][] = [['on/eliminate', state], ['on/keep', loss(keep([3, 1, 5, 2, 4]), 'p2', -1, 654321).state], ['off', out(lifeless(), 'p3', 654321).state]];
    for (const [name, s] of variants) for (const release of PARTICIPATION_RELEASES) for (const who of Object.keys(audiences)) {
      const p = projectParticipation(audiences[who], s, { scope: scopeOf(s), release, stateVersion: 4242 });
      expect(ParticipationProjectionSchema.safeParse(p).success, `${name}/${release}/${who}`).toBe(true);
      expect(Object.keys(p).sort()).toEqual(['contract', 'own', 'public', 'scope', 'stateVersion']);
      expect(Object.keys(p.scope).sort()).toEqual(['actorKind', 'rosterRevision', 'runIndex', 'trackId']);
      for (const entry of [...(p.own ? [p.own] : []), ...p.public]) expect(Object.keys(entry).sort()).toEqual(['actorId', 'lives', 'status']);
      expect(text(p), `${name}/${release}/${who}`).not.toMatch(PRIVATE);
      expect(p.public.map(a => a.actorId)).toEqual(release === 'NONE' ? [] : IDS); // the public order is the fixed roster order, only when released
    }
  });
  it('returns independent copies: mutating a projection or a returned state reaches neither the stored state nor another projection', () => {
    const a = project('owner', 'STATUS_AND_LIVES'), b = project('owner', 'STATUS_AND_LIVES'), v = project('viewer', 'STATUS_AND_LIVES');
    a.own!.status = 'ELIMINATED'; a.public[0].status = 'ELIMINATED'; a.public.pop(); a.scope.trackId = 'mutated'; (v.public[1].lives as { value: number }).value = 1;
    expect(project('owner', 'STATUS_AND_LIVES')).toEqual(b);
    expect(project('viewer', 'STATUS_AND_LIVES').public[1].lives).toEqual({ state: 'VALUE', value: 555 });
    const frozen = deepFreeze(clone(state));
    expect(() => project('owner', 'STATUS', frozen)).not.toThrow();
    expect(frozen).toEqual(state);
  });
});

describe('N6 compatibility with N1–N5 and the existing engines', () => {
  const state = fresh();
  it('does not accept a participation state or projection as a legacy answer, a voting ballot or a complete game state', () => {
    const legacy = { participantId: 'p', roundId: 'r', value: 'A', status: 'SUBMITTED', submittedAtMs: 1, judgedAtMs: null, decision: null };
    expect(SubmissionRecordSchema.parse(legacy)).toEqual(legacy);
    const projection = projectParticipation({ role: 'PLAYER', participantId: 'p1' }, state, { scope: scopeOf(state), release: 'STATUS', stateVersion: 1 });
    for (const foreign of [state, projection, state.actors[0], state.config, projection.own]) {
      expect(SubmissionRecordSchema.safeParse(foreign).success).toBe(false);
      expect(SubmissionRecordSchema.safeParse({ ...legacy, value: foreign }).success).toBe(false);
      expect(VotingBallotSchema.safeParse(foreign).success).toBe(false);
    }
  });
  it('keeps N1–N6 states mutually unreadable; N1–N5 still work', () => {
    const numeric = createNumericRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, scale: 0, min: { units: 0, scale: 0 }, max: { units: 10, scale: 0 }, unit: null, boundsDisclosure: 'PUBLIC' } });
    const textCard = createTextCardRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, fields: [{ fieldId: 'alpha', label: 'A', help: null, required: true }], maxCodePointsPerField: 10, maxTotalCodePoints: 10 } });
    const ordering = createOrderingRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, prompt: null, directionHint: null, items: [{ itemId: 'aa', label: 'A', help: null }, { itemId: 'bb', label: 'B', help: null }] }, referenceRevision: null });
    const voting = createVotingPoll({ runIndex: 1, roundId: 'r', pollId: 'poll-1', config: { schemaVersion: 1, prompt: null, options: [{ optionId: 'aa', label: 'A', help: null }, { optionId: 'bb', label: 'B', help: null }] },
      eligibility: { schemaVersion: 1, revision: 'rev', voters: [{ participantId: 'p1', allowedOptionIds: ['aa'], allowAbstain: true }] } });
    const deal = createSecretRoleDeal({ runIndex: 1, roundId: 'r', dealId: 'deal-1', revision: 'rev-1', participantIds: ['p1'], roleIds: ['rolea'], assignments: [{ participantId: 'p1', roleId: 'rolea' }], fragments: [] });
    for (const other of [numeric, textCard, ordering, voting, deal]) expect(message(() => parseParticipationTrackState(other))).toBe('PARTICIPATION_STATE_INVALID');
    expect(message(() => parseNumericRoundState(state))).toBe('NUMERIC_STATE_INVALID');
    expect(message(() => parseTextCardRoundState(state))).toBe('TEXT_CARD_STATE_INVALID');
    expect(message(() => parseOrderingRoundState(state))).toBe('ORDERING_STATE_INVALID');
    expect(message(() => parseVotingPollState(state))).toBe('VOTING_STATE_INVALID');
    expect(message(() => parseSecretRoleDealState(state))).toBe('SECRET_INFO_STATE_INVALID');
    expect(parseNumericRoundState(numeric)).toEqual(numeric);
    expect(parseTextCardRoundState(textCard)).toEqual(textCard);
    expect(parseOrderingRoundState(ordering)).toEqual(ordering);
    expect(parseVotingPollState(voting)).toEqual(voting);
    expect(parseSecretRoleDealState(deal)).toEqual(deal);
  });
  it('does not touch N4 voting: an elimination neither changes a pinned poll roster nor deletes a valid ballot', () => {
    const poll = createVotingPoll({ runIndex: 2, roundId: 'r', pollId: 'poll-1', config: { schemaVersion: 1, prompt: null, options: [{ optionId: 'aa', label: 'A', help: null }, { optionId: 'bb', label: 'B', help: null }] },
      eligibility: { schemaVersion: 1, revision: 'rev', voters: [{ participantId: 'p1', allowedOptionIds: ['aa', 'bb'], allowAbstain: false }] } });
    const before = clone(poll);
    const gone = out(fresh(), 'p1').state;
    expect(actor(gone, 'p1').status).toBe('ELIMINATED');
    expect(poll).toEqual(before);
    expect(parseVotingPollState(clone(poll))).toEqual(poll); // eligibility stays a pinned roster, never a current authentication
  });
  it('gives the three real engines no participation entry point', () => {
    const context: CoreActionContext = { gameSlug: 'wer-ist-das', roomStatus: 'RUNNING', state: createWerIstDasState(1, { alice: 'Alice' }),
      informationRole: 'PLAYER', participantId: 'alice', active: true, permissions: new Set(['BUZZER_CONTROL']), now: 100 };
    for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) {
      const contract = getGameEngineContract(slug)!;
      for (const action of ['lives.change', 'lives:change', 'participation.eliminate', 'eliminate', 'changeLives', 'eliminateActor', 'revive', 'life.lose']) {
        expect(contract.validateCommand({ ...context, gameSlug: slug }, { action, payload: { actorId: 'alice', delta: -1 } }), `${slug}/${action}`).toMatchObject({ success: false });
      }
    }
  });
  it('exposes every participation error code on the wire with its own code, and unknown ones stay INTERNAL_ERROR', () => {
    for (const code of PARTICIPATION_ERROR_CODES) expect(gameErrorCode(new Error(code)), code).toBe(code);
    expect(gameErrorCode(new ParticipationError('PARTICIPATION_VERSION_STALE', ['SHAPE_INVALID']))).toBe('PARTICIPATION_VERSION_STALE');
    expect(gameErrorCode(new Error('PARTICIPATION_SOMETHING_ELSE'))).toBe('INTERNAL_ERROR');
    expect(gameErrorCode(new Error('ZERO_LIVES_CONFLICT'))).toBe('INTERNAL_ERROR'); // issue codes are not wire codes
  });
});
