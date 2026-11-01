import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SubmissionRecordSchema } from '@quiz/shared';
import { applyStateEvent, createStateEvent, type EngineStateSnapshot } from '@quiz/game-sdk';
import { SECRET_INFO_ERROR_CODES, SECRET_INFO_MAX_FRAGMENTS, SECRET_INFO_MAX_PARTICIPANTS, SECRET_INFO_MAX_RECIPIENT_LINKS, SECRET_INFO_MAX_ROLES, SecretInfoProjectionSchema, SecretInfoError } from '@quiz/shared/secretInfo';
import { VotingBallotSchema } from '@quiz/shared/voting';
import { gameErrorCode } from './errors.js';
import { getGameEngineContract } from './engineContract.js';
import { submitOnce, createTimer } from './runtimePrimitives.js';
import { createWerIstDasState } from '../weristdas/state.js';
import { createNumericRound, parseNumericRoundState } from './numericSubmission.js';
import { createTextCardRound, parseTextCardRoundState } from './textCardSubmission.js';
import { createOrderingRound, parseOrderingRoundState } from './orderingSubmission.js';
import { createVotingPoll, parseVotingPollState } from './votingPoll.js';
import type { CoreActionContext } from './actionRules.js';
import { canView, type ProjectionAudience } from './visibility.js';
import * as domainModule from './secretRoleDeal.js';
import {
  createSecretRoleDeal, parseSecretRoleDealState, projectSecretInfo, releaseSecretInformation, secretRoleDealScopeOf,
  type SecretRoleDealScope, type SecretRoleDealState,
} from './secretRoleDeal.js';

// Synthetic fixtures. Role / fragment ids are lowercase (id policy) but unmistakable markers; texts carry upper-case markers.
// None of this is a game preset: the number of roles, their names and the knowledge per role are NOT rules.
const ROLE_Z = 'rolemarkerzulu', ROLE_Y = 'rolemarkeryankee', ROLE_X = 'rolemarkerxray';
const ROSTER = ['p1', 'p2', 'p3', 'p4', 'p5'];
const frag = (fragmentId: string, mark: string, recipientIds: string[]) => ({ fragmentId, title: `TITLE_${mark}`, text: `TEXT_${mark}`, recipientIds });
/** p1 and p2 hold the SAME role but different knowledge; p3 and p4 share ONE fragment; p1 has two fragments; p5 holds a role and no fragment. */
const dealInput = (over: Record<string, unknown> = {}) => ({
  runIndex: 2, roundId: 'round-7', dealId: 'deal-1', revision: 'rev-1',
  participantIds: [...ROSTER], roleIds: [ROLE_Z, ROLE_Y, ROLE_X],
  assignments: [{ participantId: 'p1', roleId: ROLE_Z }, { participantId: 'p2', roleId: ROLE_Z }, { participantId: 'p3', roleId: ROLE_Y }, { participantId: 'p4', roleId: ROLE_Y }, { participantId: 'p5', roleId: ROLE_X }],
  fragments: [frag('fragalpha', 'ALPHA', ['p1']), frag('fragbravo', 'BRAVO', ['p2']), frag('fragcharlie', 'CHARLIE', ['p3', 'p4']), frag('fragdelta', 'DELTA', ['p1']), frag('fragecho', 'ECHO', [])],
  ...over,
});
const fresh = (over: Record<string, unknown> = {}) => createSecretRoleDeal(dealInput(over));
const scopeOf = (state: SecretRoleDealState): SecretRoleDealScope => secretRoleDealScopeOf(state);
const release = (state: SecretRoleDealState, fragmentIds: string[], now = 5000, scope: SecretRoleDealScope = scopeOf(state)) => releaseSecretInformation(state, { scope, fragmentIds, now });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
const message = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } return 'NO_ERROR'; };
const thrown = (fn: () => unknown): Error & { issues?: string[] } => { try { fn(); } catch (e) { return e as Error & { issues?: string[] }; } throw new Error('NO_ERROR'); };
const U = (...cp: number[]) => String.fromCodePoint(...cp);
const text = (value: unknown) => JSON.stringify(value);

describe('N5 deal: contract and private state', () => {
  it('creates a small valid deal: every participant exactly once, nothing released, JSON-serializable', () => {
    const state = fresh();
    expect(state).toMatchObject({ kind: 'SECRET_ROLE_DEAL', schemaVersion: 1, runIndex: 2, roundId: 'round-7', dealId: 'deal-1', revision: 'rev-1', released: [] });
    expect(state.participantIds).toEqual(ROSTER);
    expect(state.assignments.map(a => a.participantId)).toEqual(ROSTER);
    expect(new Set(state.assignments.map(a => a.participantId)).size).toBe(ROSTER.length);
    expect(Object.keys(state).sort()).toEqual(['assignments', 'dealId', 'fragments', 'kind', 'participantIds', 'released', 'revision', 'roleIds', 'roundId', 'runIndex', 'schemaVersion']);
    expect(parseSecretRoleDealState(clone(state))).toEqual(state);
  });
  it('allows the same role for several participants with explicitly different knowledge, a role without any fragment and shared / multiple fragments', () => {
    const state = fresh();
    const role = (id: string) => state.assignments.find(a => a.participantId === id)!.roleId;
    expect(role('p1')).toBe(role('p2')); // same actual role …
    const recipients = (id: string) => state.fragments.filter(f => f.recipientIds.includes(id)).map(f => f.fragmentId);
    expect(recipients('p1')).toEqual(['fragalpha', 'fragdelta']); // … a participant with several fragments
    expect(recipients('p2')).toEqual(['fragbravo']); // … different knowledge
    expect(recipients('p3')).toEqual(['fragcharlie']);
    expect(recipients('p4')).toEqual(['fragcharlie']); // one fragment, several recipients
    expect(recipients('p5')).toEqual([]); // a role and no fragment at all
    expect(state.fragments.find(f => f.fragmentId === 'fragecho')!.recipientIds).toEqual([]); // exists on the server only
    expect(fresh({ roleIds: [ROLE_Z, ROLE_Y, ROLE_X, 'rolemarkerunused'] }).roleIds).toHaveLength(4); // a role may be assigned to nobody
  });
  it('does not deal, default or complete anything: no AUTO, no implicit remainder, no presets', () => {
    for (const bad of [{ assignments: 'AUTO' }, { assignments: undefined }, { assignments: [] }, { roleIds: 'AUTO' }, { roleIds: [] }, { participantIds: [] }, { fragments: undefined }]) {
      expect(message(() => fresh(bad)), JSON.stringify(bad)).toBe('SECRET_INFO_DEAL_INVALID');
    }
    const partial = dealInput();
    expect(message(() => createSecretRoleDeal({ ...partial, assignments: partial.assignments.slice(0, 4) }))).toBe('SECRET_INFO_DEAL_INVALID'); // the fifth is NOT filled in
    expect(thrown(() => createSecretRoleDeal({ ...partial, assignments: partial.assignments.slice(0, 4) })).issues).toContain('ASSIGNMENT_MISSING');
  });
  it('rejects an unknown role, a missing or duplicate assignment and an extra foreign participant — with code-only issues', () => {
    const base = dealInput();
    const issuesOf = (over: Record<string, unknown>) => thrown(() => createSecretRoleDeal({ ...base, ...over })).issues;
    expect(issuesOf({ assignments: [{ participantId: 'p1', roleId: 'rolemarkerghost' }, ...base.assignments.slice(1)] })).toContain('ASSIGNMENT_UNKNOWN_ROLE');
    expect(issuesOf({ assignments: base.assignments.slice(1) })).toContain('ASSIGNMENT_MISSING');
    expect(issuesOf({ assignments: [...base.assignments, { participantId: 'p1', roleId: ROLE_Y }] })).toContain('ASSIGNMENT_DUPLICATE');
    expect(issuesOf({ assignments: [...base.assignments, { participantId: 'ghost', roleId: ROLE_Y }] })).toContain('ASSIGNMENT_UNKNOWN_PARTICIPANT');
    expect(issuesOf({ assignments: [...base.assignments.slice(0, 4), { participantId: 'ghost', roleId: ROLE_Y }] })).toEqual(expect.arrayContaining(['ASSIGNMENT_UNKNOWN_PARTICIPANT', 'ASSIGNMENT_MISSING']));
  });
  it('rejects duplicate participants, roles, fragment ids and recipients, and unknown recipients', () => {
    const base = dealInput();
    const issuesOf = (over: Record<string, unknown>) => thrown(() => createSecretRoleDeal({ ...base, ...over })).issues;
    expect(issuesOf({ participantIds: [...ROSTER, 'p1'] })).toContain('PARTICIPANT_DUPLICATE');
    expect(issuesOf({ roleIds: [ROLE_Z, ROLE_Z, ROLE_Y, ROLE_X] })).toContain('ROLE_DUPLICATE');
    expect(issuesOf({ fragments: [frag('fragalpha', 'A', ['p1']), frag('fragalpha', 'B', ['p2'])] })).toContain('FRAGMENT_DUPLICATE');
    expect(issuesOf({ fragments: [frag('fragalpha', 'A', ['p1', 'p1'])] })).toContain('RECIPIENT_DUPLICATE');
    expect(issuesOf({ fragments: [frag('fragalpha', 'A', ['p1', 'ghost'])] })).toContain('RECIPIENT_UNKNOWN');
  });
  it('rejects invalid scope fields, versions, kinds and extra / missing fields at every level', () => {
    for (const bad of [{ runIndex: 0 }, { runIndex: -1 }, { runIndex: 1.5 }, { runIndex: Number.NaN }, { runIndex: Infinity }, { runIndex: '2' }, { runIndex: 2 ** 53 },
      { roundId: '' }, { roundId: 'x'.repeat(201) }, { roundId: 7 }, { dealId: '' }, { dealId: 'a b' }, { dealId: 'x'.repeat(81) }, { dealId: 'role marker' }, { dealId: '../x' },
      { revision: '' }, { revision: '.rev' }, { revision: 'x'.repeat(81) }, { revision: null }]) {
      expect(message(() => fresh(bad)), JSON.stringify(bad)).toBe('SECRET_INFO_DEAL_INVALID');
    }
    const base = dealInput();
    for (const extra of ['kind', 'schemaVersion', 'released', 'seed', 'autoAssign', 'teamRoles']) expect(message(() => createSecretRoleDeal({ ...base, [extra]: 1 })), extra).toBe('SECRET_INFO_DEAL_INVALID');
    const polluted = JSON.parse(`{"__proto__": {"role": "x"}, ${JSON.stringify(base).slice(1)}`) as unknown; // an OWN "__proto__" key, as JSON.parse creates it
    expect(message(() => createSecretRoleDeal(polluted))).toBe('SECRET_INFO_DEAL_INVALID');
    for (const key of Object.keys(base)) expect(message(() => createSecretRoleDeal(Object.fromEntries(Object.entries(base).filter(([name]) => name !== key)))), `missing ${key}`).toBe('SECRET_INFO_DEAL_INVALID');
    expect(message(() => fresh({ assignments: [{ participantId: 'p1', roleId: ROLE_Z, extra: 1 }, ...base.assignments.slice(1)] }))).toBe('SECRET_INFO_DEAL_INVALID');
    expect(message(() => fresh({ fragments: [{ ...frag('fragalpha', 'A', ['p1']), extra: 1 }] }))).toBe('SECRET_INFO_DEAL_INVALID');
    class Weird { runIndex = 1; }
    for (const input of [null, undefined, 'x', 7, [], new Weird(), Object.create({ inherited: 1 })]) expect(message(() => createSecretRoleDeal(input)), String(input)).toBe('SECRET_INFO_DEAL_INVALID');
    for (const id of ['__proto__', 'constructor', 'prototype', 'Aa', '1a', 'a b', '']) {
      expect(message(() => fresh({ roleIds: [id, ROLE_Y, ROLE_X] })), `role ${id}`).toBe('SECRET_INFO_DEAL_INVALID');
      expect(message(() => fresh({ fragments: [frag(id, 'A', [])] })), `fragment ${id}`).toBe('SECRET_INFO_DEAL_INVALID');
    }
  });
  it('enforces the named bounds exactly (one inside, one outside) and bounds BEFORE any cross-comparison', () => {
    const many = (n: number, prefix = 'q') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const full = (ids: string[]) => ({ participantIds: ids, assignments: ids.map(participantId => ({ participantId, roleId: ROLE_Z })), fragments: [] as unknown[] });
    expect(SECRET_INFO_MAX_PARTICIPANTS).toBe(100);
    expect(fresh(full(many(100))).participantIds).toHaveLength(100);
    expect(message(() => fresh(full(many(101))))).toBe('SECRET_INFO_DEAL_INVALID');
    // over-long lists stop at LIMIT_EXCEEDED: the quadratic-looking cross checks (here: a missing assignment) are never run
    const over = thrown(() => fresh({ participantIds: many(101), assignments: many(100).map(participantId => ({ participantId, roleId: ROLE_Z })), fragments: [] }));
    expect(over.issues).toContain('LIMIT_EXCEEDED');
    expect(over.issues).not.toContain('ASSIGNMENT_MISSING');
    expect(SECRET_INFO_MAX_ROLES).toBe(32);
    expect(fresh({ roleIds: [ROLE_Z, ROLE_Y, ROLE_X, ...many(29, 'role')] }).roleIds).toHaveLength(32);
    expect(message(() => fresh({ roleIds: [ROLE_Z, ROLE_Y, ROLE_X, ...many(30, 'role')] }))).toBe('SECRET_INFO_DEAL_INVALID');
    expect(SECRET_INFO_MAX_FRAGMENTS).toBe(200);
    const fragments = (n: number) => Array.from({ length: n }, (_, i) => frag(`frag${i}`, `F${i}`, []));
    expect(fresh({ fragments: fragments(200) }).fragments).toHaveLength(200);
    expect(message(() => fresh({ fragments: fragments(201) }))).toBe('SECRET_INFO_DEAL_INVALID');
    // total recipient links: 100 recipients x 20 fragments = 2000 is fine, one more link is not
    expect(SECRET_INFO_MAX_RECIPIENT_LINKS).toBe(2000);
    const ids = many(100);
    const wide = (n: number, extraLinks = 0) => ({ ...full(ids), fragments: [...Array.from({ length: n }, (_, i) => frag(`wide${i}`, `W${i}`, ids)), ...(extraLinks ? [frag('wideextra', 'X', ids.slice(0, extraLinks))] : [])] });
    expect(fresh(wide(20)).fragments).toHaveLength(20);
    expect(thrown(() => fresh(wide(20, 1))).issues).toContain('LIMIT_EXCEEDED');
    expect(fresh({ fragments: [frag('x'.repeat(40), 'A', [])] }).fragments).toHaveLength(1);
    expect(message(() => fresh({ fragments: [frag('x'.repeat(41), 'A', [])] }))).toBe('SECRET_INFO_DEAL_INVALID');
    expect(message(() => fresh({ roleIds: ['r'.repeat(41), ROLE_Y, ROLE_X] }))).toBe('SECRET_INFO_DEAL_INVALID');
    expect(fresh({ fragments: [{ fragmentId: 'fragalpha', title: 'x'.repeat(80), text: 'y'.repeat(1000), recipientIds: [] }] }).fragments).toHaveLength(1);
    expect(message(() => fresh({ fragments: [{ fragmentId: 'fragalpha', title: 'x'.repeat(81), text: 'y', recipientIds: [] }] }))).toBe('SECRET_INFO_DEAL_INVALID');
    expect(message(() => fresh({ fragments: [{ fragmentId: 'fragalpha', title: 'x', text: 'y'.repeat(1001), recipientIds: [] }] }))).toBe('SECRET_INFO_DEAL_INVALID');
    expect(message(() => fresh({ participantIds: [...ROSTER.slice(0, 4), 'p'.repeat(201)], assignments: [...dealInput().assignments.slice(0, 4), { participantId: 'p'.repeat(201), roleId: ROLE_X }] }))).toBe('SECRET_INFO_DEAL_INVALID');
  });
  it('keeps text as plain, policy-checked text: multi-line allowed, markup stays verbatim, hidden / bidi / control characters refused', () => {
    const one = (title: string, body: string) => fresh({ fragments: [{ fragmentId: 'fragalpha', title, text: body, recipientIds: ['p1'] }] });
    expect(one('Titel', 'Zeile 1\nZeile 2').fragments[0].text).toBe('Zeile 1\nZeile 2');
    expect(one('<b>T</b>', '<script>alert(1)</script> &amp;').fragments[0]).toMatchObject({ title: '<b>T</b>', text: '<script>alert(1)</script> &amp;' });
    for (const bad of ['', ' ', ' x', 'x ', 'x\ty', U(0x7), U(0x202e), U(0xfeff), U(0xd800), U(0x200b), 'a\rb']) {
      expect(message(() => one('ok', bad)), `text ${JSON.stringify(bad)}`).toBe('SECRET_INFO_DEAL_INVALID');
      expect(message(() => one(bad, 'ok')), `title ${JSON.stringify(bad)}`).toBe('SECRET_INFO_DEAL_INVALID');
    }
    expect(message(() => one('ok', '\nx'))).toBe('SECRET_INFO_DEAL_INVALID');
    expect(message(() => one('ok', Array(21).fill('a').join('\n')))).toBe('SECRET_INFO_DEAL_INVALID');
  });
  it('stores assignments and recipients in the order of the roster (set semantics) and fragments in the given order', () => {
    const a = fresh();
    const shuffled = dealInput();
    const b = createSecretRoleDeal({ ...shuffled, assignments: [...shuffled.assignments].reverse(), fragments: shuffled.fragments.map(f => ({ ...f, recipientIds: [...f.recipientIds].reverse() })) });
    expect(b).toEqual(a);
    expect(fresh({ fragments: [...dealInput().fragments].reverse() }).fragments.map(f => f.fragmentId)).toEqual(['fragecho', 'fragdelta', 'fragcharlie', 'fragbravo', 'fragalpha']);
  });
  it('rejects a loaded, manipulated state as a whole — nothing is repaired', () => {
    const good = clone(fresh());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately loose: the test mutates arbitrary parts of a JSON clone
    const tampered: [string, (s: any) => void][] = [
      ['extra field', s => { s.role = 'x'; }], ['wrong kind', s => { s.kind = 'VOTING_POLL'; }], ['version 2', s => { s.schemaVersion = 2; }], ['no version', s => { delete s.schemaVersion; }],
      ['unknown role', s => { s.assignments[0].roleId = 'rolemarkerghost'; }], ['missing assignment', s => { s.assignments.pop(); }], ['duplicate assignment', s => { s.assignments[1].participantId = 'p1'; }],
      ['foreign assignee', s => { s.assignments[4].participantId = 'ghost'; }], ['extra assignee', s => { s.assignments.push({ participantId: 'ghost', roleId: ROLE_Z }); }],
      ['duplicate participant', s => { s.participantIds[1] = 'p1'; }], ['duplicate role', s => { s.roleIds[1] = s.roleIds[0]; }], ['duplicate fragment', s => { s.fragments[1].fragmentId = 'fragalpha'; }],
      ['foreign recipient', s => { s.fragments[0].recipientIds.push('ghost'); }], ['duplicate recipient', s => { s.fragments[2].recipientIds.push('p3'); }],
      ['release unknown', s => { s.released.push({ fragmentId: 'fraghost', releasedAtMs: 1 }); }], ['release twice', s => { s.released.push({ fragmentId: 'fragalpha', releasedAtMs: 1 }, { fragmentId: 'fragalpha', releasedAtMs: 2 }); }],
      ['release time -1', s => { s.released.push({ fragmentId: 'fragalpha', releasedAtMs: -1 }); }], ['release time 1.5', s => { s.released.push({ fragmentId: 'fragalpha', releasedAtMs: 1.5 }); }],
      ['release time null (NaN in JSON)', s => { s.released.push({ fragmentId: 'fragalpha', releasedAtMs: null }); }], ['release extra key', s => { s.released.push({ fragmentId: 'fragalpha', releasedAtMs: 1, by: 'host' }); }],
      ['cut text', s => { s.fragments[0].text = ''; }], ['hidden char in title', s => { s.fragments[0].title = `T${U(0x202e)}`; }], ['run index 0', s => { s.runIndex = 0; }],
      ['wrong type', s => { s.participantIds = 'p1'; }], ['too many links', s => { s.fragments[0].recipientIds = Array.from({ length: 101 }, (_, i) => `p${i}`); }],
    ];
    for (const [name, mutate] of tampered) {
      const copy = clone(good);
      mutate(copy);
      expect(message(() => parseSecretRoleDealState(copy)), name).toBe('SECRET_INFO_STATE_INVALID');
      expect(message(() => projectSecretInfo({ role: 'PLAYER', participantId: 'p1' }, copy, scopeOf(good))), `project ${name}`).toBe('SECRET_INFO_STATE_INVALID');
      expect(message(() => release(copy, ['fragalpha'], 1, scopeOf(good))), `release ${name}`).toBe('SECRET_INFO_STATE_INVALID');
    }
    for (const junk of [null, undefined, 'x', 7, [], {}]) expect(message(() => parseSecretRoleDealState(junk))).toBe('SECRET_INFO_STATE_INVALID');
  });
  it('does not retain, share or alter its input; invalid input changes nothing', () => {
    const input = deepFreeze(dealInput());
    const snapshot = clone(input);
    const state = createSecretRoleDeal(input);
    expect(input).toEqual(snapshot); // frozen input: a mutation attempt would have thrown
    const live = dealInput();
    const created = createSecretRoleDeal(live);
    const before = clone(created);
    live.participantIds.push('late'); live.assignments[0].roleId = ROLE_X; live.fragments[0].text = 'MUTIERT'; live.fragments[0].recipientIds.push('p5'); live.roleIds.length = 0;
    expect(created).toEqual(before); // later mutation of the original input does not reach the deal
    state.fragments[0].text = 'MUTIERT'; state.assignments[0].roleId = ROLE_X; (state.released as unknown[]).push('x');
    expect(createSecretRoleDeal(dealInput())).toEqual(fresh()); // another deal is independent of that mutation
    const bad = dealInput({ assignments: [] });
    const frozenBad = deepFreeze(clone(bad));
    expect(message(() => createSecretRoleDeal(frozenBad))).toBe('SECRET_INFO_DEAL_INVALID');
    expect(frozenBad).toEqual(bad);
  });
  it('keeps errors free of roles, terms, recipients, ids and raw state — message, issues, name, keys and stack', () => {
    const open = fresh();
    const attempts: (() => unknown)[] = [
      () => fresh({ assignments: [{ participantId: 'p1', roleId: 'rolemarkerGEHEIMGHOST' }, ...dealInput().assignments.slice(1)] }),
      () => fresh({ fragments: [frag('fragGEHEIM', 'GEHEIM_X', ['p1'])] }), () => fresh({ fragments: [{ fragmentId: 'fragalpha', title: 'TITLE_GEHEIM', text: `GEHEIM${U(0x202e)}`, recipientIds: ['p-GEHEIM'] }] }),
      () => fresh({ participantIds: ['p-GEHEIM', 'p-GEHEIM'] }), () => createSecretRoleDeal({ ...dealInput(), GEHEIMKEY: 'GEHEIM' }),
      () => parseSecretRoleDealState({ ...clone(open), assignments: [{ participantId: 'p-GEHEIM', roleId: ROLE_Z }] }), () => release(open, ['fragGEHEIM']),
      () => release(open, ['fragalpha', 'fragalpha']), () => release(open, ['fragalpha'], 1, { ...scopeOf(open), dealId: 'deal-GEHEIM' }),
      () => release(open, ['fragalpha'], 1, { ...scopeOf(open), revision: 'rev-GEHEIM' }), () => projectSecretInfo({ role: 'ADMIN' } as never, open, scopeOf(open)),
      () => projectSecretInfo({ role: 'PLAYER', participantId: 'p-GEHEIM'.repeat(40) }, open, scopeOf(open)),
    ];
    for (const attempt of attempts) {
      const error = thrown(attempt);
      const serialized = text([error.message, error.issues ?? null, error.name, Object.keys(error), String(error.stack).split('\n')[0]]);
      expect(serialized).not.toMatch(/GEHEIM|rolemarker|TITLE_|TEXT_|frag[a-z]|"p[1-5]"|ghost|deal-1|rev-1|round-7/);
      expect(Object.keys(error).filter(key => key !== 'name').sort()).toEqual(error instanceof SecretInfoError ? ['code', 'issues'] : ['code']); // nothing else rides along (no cause, no raw state)
      expect(error.cause).toBeUndefined();
    }
  });
});

describe('N5 projection: only explicitly allowed knowledge (domain projection only — no socket, rejoin or recovery is proven here)', () => {
  const audiences: Record<string, ProjectionAudience> = {
    owner: { role: 'PLAYER', participantId: 'p1', teamId: 't1' },
    partner: { role: 'PLAYER', participantId: 'p2', teamId: 't1' }, // same team AND same role as the owner, own knowledge
    other: { role: 'PLAYER', participantId: 'p3', teamId: 't2' },
    other2: { role: 'PLAYER', participantId: 'p4', teamId: 't2' },
    nothing: { role: 'PLAYER', participantId: 'p5', teamId: 't1' }, // holds a role, no fragment
    stranger: { role: 'PLAYER', participantId: 'zz', teamId: 't1' }, // a player that is not on the deal, even in the owner's team
    host: { role: 'HOST', participantId: null },
    blindHost: { role: 'HOST', blindHost: true, participantId: null },
    hostAsHost: { role: 'HOST', participantId: 'p3' }, // a playing host that was NOT projected with the PLAYER information role
    hostAsPlayer: { role: 'PLAYER', participantId: 'p3', teamId: null }, // the correct role for a playing host
    viewer: { role: 'VIEWER' },
    display: { role: 'DISPLAY' },
  };
  const state = fresh();
  const scope = scopeOf(state);
  const project = (who: keyof typeof audiences, s: unknown = state, sc: SecretRoleDealScope = scope) => projectSecretInfo(audiences[who], s, sc);
  const view = (mark: string) => ({ title: `TITLE_${mark}`, text: `TEXT_${mark}` });
  const SECRETS = /rolemarker|frag(alpha|bravo|charlie|delta|echo)|releasedAtMs|recipientIds|assignments|roleId|fragmentId|seed/;

  it('does not project the held role: no role id, role name or distribution in ANY projection, under any key', () => {
    let released = state;
    for (const stage of [[], ['fragalpha'], ['fragalpha', 'fragbravo', 'fragcharlie', 'fragdelta', 'fragecho']]) {
      if (stage.length) released = release(released, stage).state;
      for (const who of Object.keys(audiences)) {
        const p = project(who, released);
        expect(text(p), `${who}/${stage.length}`).not.toMatch(SECRETS);
        expect(Object.keys(p).sort(), who).toEqual(['contract', 'own', 'released', 'scope']);
        expect(SecretInfoProjectionSchema.safeParse(p).success, who).toBe(true);
      }
    }
    // knowledge of the own role exists only if a fragment says so — a held role alone shows nothing
    expect(project('nothing').own).toEqual({ participantId: 'p5', fragments: [] });
  });
  it('shows a player exactly the text explicitly released to him — title and text only, in fragment order', () => {
    expect(project('owner').own).toEqual({ participantId: 'p1', fragments: [view('ALPHA'), view('DELTA')] });
    expect(project('partner').own).toEqual({ participantId: 'p2', fragments: [view('BRAVO')] });
    expect(project('other').own).toEqual({ participantId: 'p3', fragments: [view('CHARLIE')] });
    expect(project('other2').own).toEqual({ participantId: 'p4', fragments: [view('CHARLIE')] }); // one fragment, several explicit recipients
    expect(project('hostAsPlayer').own).toEqual(project('other').own);
    for (const fragment of project('owner').own!.fragments) expect(Object.keys(fragment).sort()).toEqual(['text', 'title']);
    expect(text(project('owner'))).not.toMatch(/"p[2-5]"|BRAVO|CHARLIE|ECHO/); // no other fragment, no other participant
  });
  it('gives the same role or the same team no access to a foreign fragment', () => {
    for (const who of ['partner', 'nothing', 'stranger']) {
      expect(text(project(who)), who).not.toMatch(/ALPHA|DELTA/); // p2 shares role AND team with p1; p5 and the stranger share the team
    }
    expect(text(project('owner'))).not.toMatch(/BRAVO/);
    const sameTeam = { role: 'PLAYER', participantId: 'p2', teamId: 'tX' } as ProjectionAudience;
    const otherTeam = { role: 'PLAYER', participantId: 'p2', teamId: 'tY' } as ProjectionAudience;
    expect(projectSecretInfo(sameTeam, state, scope)).toEqual(projectSecretInfo(otherTeam, state, scope)); // the team plays no role at all
  });
  it('gives a HOST — blind or not, playing or not, with or without extra rights — no private part and no role / term overview', () => {
    for (const who of ['host', 'blindHost', 'hostAsHost']) {
      const p = project(who);
      expect(p.own, who).toBeNull();
      expect(p.released, who).toEqual([]);
      expect(text(p), who).not.toMatch(/TEXT_|TITLE_|"p[1-5]"/);
    }
    expect(canView(audiences.host, { scope: 'HOST_PRIVATE' })).toBe(true); // the existing helper WOULD open it — the projection must not use it
    expect(project('host')).toEqual(project('blindHost'));
    // administrative rights and other claims on the audience are ignored: only the information role and participantId count
    const loaded = { role: 'PLAYER', participantId: 'p3', teamId: null, isAdmin: true, permissions: ['REVEAL_CONTENT', 'PLAYER_MANAGE'], blindHost: false } as unknown as ProjectionAudience;
    expect(projectSecretInfo(loaded, state, scope)).toEqual(project('hostAsPlayer'));
    const hostWithRights = { role: 'HOST', participantId: 'p1', isAdmin: true, permissions: ['REVEAL_CONTENT'], blindHost: false } as unknown as ProjectionAudience;
    expect(projectSecretInfo(hostWithRights, state, scope).own).toBeNull();
  });
  it('maps ADMIN / unknown roles and malformed audiences to a coded error — never to a guess', () => {
    for (const bad of [{ role: 'ADMIN' }, { role: 'ADMIN', participantId: 'p1' }, { role: 'player', participantId: 'p1' }, { role: undefined }, {}, null, undefined, 'PLAYER', [],
      { role: 'PLAYER', participantId: 7 }, { role: 'PLAYER', participantId: '' }, { role: 'PLAYER', participantId: 'p'.repeat(201) }]) {
      expect(message(() => projectSecretInfo(bad as never, state, scope)), JSON.stringify(bad)).toBe('SECRET_INFO_AUDIENCE_INVALID');
    }
    expect(project('viewer').own).toBeNull(); // a non-playing administrator is projected as VIEWER by the existing mapping
  });
  it('shows VIEWER and DISPLAY nothing before a release and exactly the released content afterwards — without a hint about the rest', () => {
    for (const who of ['viewer', 'display']) {
      const before = project(who);
      expect(before, who).toEqual({ contract: 'SECRET_INFO_V1', scope, own: null, released: [] });
      const afterOne = project(who, release(state, ['fragalpha']).state);
      expect(afterOne.released, who).toEqual([view('ALPHA')]);
      expect(afterOne.own, who).toBeNull();
      expect(text(afterOne), who).not.toMatch(/BRAVO|CHARLIE|DELTA|ECHO|"p[1-5]"|rolemarker|frag/);
    }
    const mixed = release(release(state, ['fragecho'], 1).state, ['fragcharlie'], 2).state;
    expect(project('viewer', mixed).released).toEqual([view('CHARLIE'), view('ECHO')]); // fragment order, not release order; the recipient-less fragment is public only now
    expect(text(project('display', mixed))).not.toMatch(/"p[1-5]"/); // the original recipients stay private
  });
  it('gives PLAYER and HOST the same public part but never more private knowledge from it', () => {
    const released = release(state, ['fragbravo']).state;
    expect(project('owner', released).released).toEqual([view('BRAVO')]); // p1 now sees the public text, not as "own"
    expect(project('owner', released).own).toEqual(project('owner').own);
    expect(project('host', released).released).toEqual([view('BRAVO')]);
    expect(project('host', released).own).toBeNull();
    expect(project('stranger', released).released).toEqual([view('BRAVO')]);
    expect(project('stranger', released).own).toBeNull();
    // a fragment that is both addressed to the player and released appears in both lists (own knowledge is not withdrawn)
    expect(project('partner', released).own!.fragments).toEqual([view('BRAVO')]);
  });
  it('does not let one released fragment release another fragment, a role or the recipients', () => {
    const released = release(state, ['fragdelta']).state;
    for (const who of Object.keys(audiences)) {
      const p = project(who, released);
      expect(text(p.released), who).not.toMatch(/ALPHA|BRAVO|CHARLIE|ECHO/);
      expect(text(p), who).not.toMatch(SECRETS);
    }
    expect(project('partner', released).own).toEqual(project('partner').own);
    expect(released.assignments).toEqual(state.assignments);
    expect(released.fragments).toEqual(state.fragments);
  });
  it('gives non-participants, a wrong recipient and a missing private release no private view', () => {
    expect(project('stranger').own).toBeNull();
    expect(projectSecretInfo({ role: 'VIEWER', participantId: 'p1' }, state, scope).own).toBeNull(); // the id alone is no right
    expect(projectSecretInfo({ role: 'DISPLAY', participantId: 'p1' }, state, scope).own).toBeNull();
    expect(projectSecretInfo({ role: 'PLAYER', participantId: null }, state, scope).own).toBeNull();
    expect(projectSecretInfo({ role: 'PLAYER' }, state, scope).own).toBeNull();
    expect(project('owner').own!.fragments.map(f => f.text)).not.toContain('TEXT_BRAVO'); // p1's view never contains p2's fragment
  });
  it('reveals nothing about the amount, ids, titles, lengths or recipients of secret fragments before a release', () => {
    const smaller = createSecretRoleDeal({ ...dealInput({ roleIds: [ROLE_Z], participantIds: ['p1', 'p2'], assignments: [{ participantId: 'p1', roleId: ROLE_Z }, { participantId: 'p2', roleId: ROLE_Z }],
      fragments: [frag('fragonly', 'LANGER_TITEL_UND_TEXT_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', ['p1'])] }) });
    const biggerPublic = JSON.stringify(project('viewer'));
    expect(JSON.stringify(projectSecretInfo({ role: 'VIEWER' }, smaller, scopeOf(smaller)))).toBe(biggerPublic); // 1 fragment / 2 participants == 5 fragments / 5 participants
    expect(JSON.stringify(projectSecretInfo({ role: 'DISPLAY' }, smaller, scopeOf(smaller)))).toBe(biggerPublic);
    expect(JSON.stringify(projectSecretInfo({ role: 'HOST', blindHost: true }, smaller, scopeOf(smaller)))).toBe(biggerPublic);
  });
  it('returns independent copies: mutating a projection or a returned state never reaches the stored state or other projections', () => {
    const released = release(state, ['fragalpha']).state;
    const a = project('owner', released), b = project('owner', released), v = project('viewer', released);
    a.own!.fragments[0].text = 'MUTIERT'; a.released[0].title = 'MUTIERT'; a.scope.dealId = 'mutiert'; v.released.push({ title: 'x', text: 'y' });
    expect(project('owner', released)).toEqual(b);
    expect(project('viewer', released).released).toEqual([view('ALPHA')]);
    const frozen = deepFreeze(clone(released));
    expect(() => project('owner', frozen)).not.toThrow(); // no mutation of its input (a write on a frozen object would throw)
    expect(frozen).toEqual(released);
  });
});

describe('N5 lifecycle: scope, selective release, repetition and replay', () => {
  const state = fresh();
  const scope = scopeOf(state);
  const owner: ProjectionAudience = { role: 'PLAYER', participantId: 'p1' };

  it('rejects another run, round, deal or revision as stale — for projection AND release — and for a malformed scope', () => {
    const cases: [Partial<SecretRoleDealScope>, string][] = [
      [{ runIndex: 3 }, 'STALE_ROUND'], [{ roundId: 'round-8' }, 'STALE_ROUND'], [{ dealId: 'deal-2' }, 'SECRET_INFO_DEAL_STALE'], [{ revision: 'rev-2' }, 'SECRET_INFO_REVISION_STALE'],
    ];
    for (const [change, code] of cases) {
      const wrong = { ...scope, ...change };
      expect(message(() => projectSecretInfo(owner, state, wrong)), JSON.stringify(change)).toBe(code);
      expect(message(() => releaseSecretInformation(state, { scope: wrong, fragmentIds: ['fragalpha'], now: 1 })), JSON.stringify(change)).toBe(code);
    }
    for (const bad of [undefined, null, {}, { runIndex: 2 }, { ...scope, extra: 1 }, 'deal-1', [], { ...scope, runIndex: undefined }]) {
      expect(message(() => projectSecretInfo(owner, state, bad as never)), JSON.stringify(bad)).toBe('SECRET_INFO_SCOPE_INVALID');
      expect(message(() => releaseSecretInformation(state, { scope: bad as never, fragmentIds: ['fragalpha'], now: 1 }))).toBe('SECRET_INFO_SCOPE_INVALID');
    }
    expect(gameErrorCode(new Error('STALE_ROUND'))).toBe('STALE_ROUND');
  });
  it('keeps a second deal of the same round independent: no roles, knowledge or releases are inherited in either direction', () => {
    const second = createSecretRoleDeal(dealInput({ dealId: 'deal-2', revision: 'rev-9', fragments: [frag('fragzulu', 'SECOND', ['p1'])] }));
    const firstReleased = release(state, ['fragalpha', 'fragecho']).state;
    expect(projectSecretInfo(owner, second, scopeOf(second)).own).toEqual({ participantId: 'p1', fragments: [{ title: 'TITLE_SECOND', text: 'TEXT_SECOND' }] });
    expect(projectSecretInfo({ role: 'VIEWER' }, second, scopeOf(second)).released).toEqual([]); // unreleased, whatever deal 1 released
    expect(text(projectSecretInfo(owner, second, scopeOf(second)))).not.toMatch(/ALPHA|ECHO|DELTA/);
    expect(message(() => projectSecretInfo(owner, second, scopeOf(firstReleased)))).toBe('SECRET_INFO_DEAL_STALE'); // an old projection scope cannot be read from deal 2
    expect(message(() => release(second, ['fragalpha'], 1, scopeOf(second)))).toBe('SECRET_INFO_RELEASE_INVALID'); // fragment of deal 1 is unknown in deal 2
    expect(message(() => release(second, ['fragzulu'], 1, scope))).toBe('SECRET_INFO_DEAL_STALE');
    expect(second.released).toEqual([]);
  });
  it('does not let a changed deal keep the same identity: a different revision is a different, rejected scope', () => {
    const changed = createSecretRoleDeal(dealInput({ fragments: [frag('fragalpha', 'GEAENDERT', ['p1'])] })); // same ids, other content, SAME labels
    expect(secretRoleDealScopeOf(changed)).toEqual(scope); // the helper cannot detect it — the consumer must mint a new revision (documented)
    const reminted = createSecretRoleDeal(dealInput({ revision: 'rev-2', fragments: [frag('fragalpha', 'GEAENDERT', ['p1'])] }));
    expect(message(() => projectSecretInfo(owner, reminted, scope))).toBe('SECRET_INFO_REVISION_STALE');
  });
  it('releases exactly the selected fragments, additively, with the caller-supplied time, leaving everything else private and unchanged', () => {
    const frozen = deepFreeze(clone(state));
    const { state: next, changed } = release(frozen, ['fragalpha'], 5000);
    expect(changed).toBe(true);
    expect(next.released).toEqual([{ fragmentId: 'fragalpha', releasedAtMs: 5000 }]);
    expect(frozen.released).toEqual([]); // input untouched
    expect({ ...next, released: [] }).toEqual(state); // nothing but the release log changed: roles, recipients, contents, other fragments
    expect(release(state, ['fragecho'], 0).state.released).toEqual([{ fragmentId: 'fragecho', releasedAtMs: 0 }]); // time 0 is valid
    expect(state.released).toEqual([]); // without an explicit call nothing is public
  });
  it('treats a repeated release as idempotent: no new effect, the FIRST time is kept, a mixed batch adds only the new ids', () => {
    const first = release(state, ['fragalpha'], 5000).state;
    const again = release(first, ['fragalpha'], 9000);
    expect(again.changed).toBe(false);
    expect(again.state).toEqual(first);
    expect(again.state).not.toBe(first); // a fresh copy, never the same reference
    const mixed = release(first, ['fragcharlie', 'fragalpha'], 6000);
    expect(mixed.changed).toBe(true);
    expect(mixed.state.released).toEqual([{ fragmentId: 'fragalpha', releasedAtMs: 5000 }, { fragmentId: 'fragcharlie', releasedAtMs: 6000 }]);
    expect(release(mixed.state, ['fragalpha', 'fragcharlie'], 7000).changed).toBe(false);
  });
  it('rejects an invalid batch as a whole: no partial release for an unknown, duplicate, malformed or empty selection', () => {
    const before = clone(state);
    const reject = (ids: unknown, code = 'SECRET_INFO_RELEASE_INVALID') => expect(message(() => releaseSecretInformation(state, { scope, fragmentIds: ids as never, now: 1 })), JSON.stringify(ids)).toBe(code);
    reject(['fragalpha', 'fraghost']); // a valid id next to an unknown one
    reject(['fraghost', 'fragalpha']);
    reject(['fragalpha', 'fragalpha']); reject(['fragalpha', 'fragbravo', 'fragalpha']);
    reject([]); reject(null); reject(undefined); reject('fragalpha'); reject({ 0: 'fragalpha', length: 1 }); reject([1]); reject([null]); reject(['fragalpha', 7]);
    reject(['*']); reject(['all']); reject(['__proto__']); reject(['constructor']); reject(['FRAGALPHA']); reject(['']);
    reject(Array.from({ length: SECRET_INFO_MAX_FRAGMENTS + 1 }, (_, i) => `frag${i}`));
    expect(thrown(() => releaseSecretInformation(state, { scope, fragmentIds: ['fragalpha', 'fraghost'], now: 1 })).issues).toEqual(['RELEASE_UNKNOWN_FRAGMENT']);
    expect(thrown(() => releaseSecretInformation(state, { scope, fragmentIds: [], now: 1 })).issues).toEqual(['RELEASE_EMPTY']);
    expect(message(() => releaseSecretInformation(state, { scope, fragmentIds: ['fragalpha'], now: 1, all: true } as never))).toBe('SECRET_INFO_RELEASE_INVALID');
    expect(message(() => releaseSecretInformation(state, { scope, fragmentIds: ['fragalpha'] } as never))).toBe('SECRET_INFO_RELEASE_INVALID');
    expect(state).toEqual(before); // the stored state is untouched, nothing was released
  });
  it('accepts only a valid caller-supplied server time and never reads a clock', () => {
    for (const now of [Number.NaN, Infinity, -Infinity, -1, 1.5, '5', null, undefined, 2 ** 53, 1e300]) {
      expect(message(() => releaseSecretInformation(state, { scope, fragmentIds: ['fragalpha'], now: now as never })), String(now)).toBe('SECRET_INFO_TIME_INVALID');
    }
    const clock = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const released = release(state, ['fragalpha', 'fragbravo'], 123).state;
      projectSecretInfo(owner, released, scope); parseSecretRoleDealState(clone(released)); createSecretRoleDeal(dealInput());
      expect(clock).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); random.mockRestore(); }
  });
  it('gives a deterministic output order that does not depend on the order of the release calls or of the ids in a batch', () => {
    const runs = [
      release(state, ['fragdelta', 'fragalpha', 'fragcharlie'], 1).state,
      release(state, ['fragalpha', 'fragcharlie', 'fragdelta'], 1).state,
      release(release(release(state, ['fragcharlie'], 1).state, ['fragdelta'], 1).state, ['fragalpha'], 1).state,
      release(release(release(state, ['fragalpha'], 1).state, ['fragcharlie'], 1).state, ['fragdelta'], 1).state,
    ];
    for (const run of runs) expect(run).toEqual(runs[0]);
    expect(runs[0].released.map(r => r.fragmentId)).toEqual(['fragalpha', 'fragcharlie', 'fragdelta']); // fragment order
    const different = release(release(state, ['fragdelta'], 1).state, ['fragalpha'], 2).state; // other times, same ids
    for (const who of [{ role: 'VIEWER' }, { role: 'PLAYER', participantId: 'p1' }, { role: 'HOST' }] as ProjectionAudience[]) {
      expect(projectSecretInfo(who, different, scope)).toEqual(projectSecretInfo(who, release(state, ['fragalpha', 'fragdelta'], 1).state, scope));
    }
    expect(projectSecretInfo({ role: 'VIEWER' }, runs[0], scope).released.map(f => f.text)).toEqual(['TEXT_ALPHA', 'TEXT_CHARLIE', 'TEXT_DELTA']);
  });
  it('never changes roles, recipients or contents by releasing, and there is no way to un-release', () => {
    const released = release(release(state, ['fragalpha'], 1).state, ['fragbravo', 'fragecho'], 2).state;
    expect(released.assignments).toEqual(state.assignments);
    expect(released.participantIds).toEqual(state.participantIds);
    expect(released.fragments).toEqual(state.fragments);
    expect(release(released, ['fragalpha'], 99).state.released.map(r => r.fragmentId)).toEqual(['fragalpha', 'fragbravo', 'fragecho']);
    expect(Object.keys(domainModule).filter(name => /unreveal|unrelease|revoke|withdraw|reassign|transfer|edit|update|revealAll|releaseAll/i.test(name))).toEqual([]);
  });
  it('roundtrips every stage through JSON unchanged and replays through the existing SDK state events without clock, randomness or a new deal', () => {
    const s0 = state, s1 = release(s0, ['fragalpha'], 5000).state, s2 = release(s1, ['fragcharlie', 'fragalpha'], 6000).state;
    for (const s of [s0, s1, s2]) {
      expect(clone(s)).toEqual(s);
      expect(parseSecretRoleDealState(clone(s))).toEqual(s);
      expect(projectSecretInfo(owner, clone(s), scope)).toEqual(projectSecretInfo(owner, s, scope));
    }
    const snapshot = (value: Record<string, unknown>, stateVersion = 0): EngineStateSnapshot => ({ roomId: 'room-1', runIndex: 2, gameSlug: 'future-social', engineVersion: 1, stateVersion, state: value });
    const base = snapshot({ phase: 'REVEAL', deal: s0, scores: { p1: 0 } });
    const e1 = createStateEvent(base, { phase: 'REVEAL', deal: s1, scores: { p1: 0 } }, { eventId: randomUUID(), type: 'SECRET_RELEASED', commandId: 'c1', actorId: 'host', occurredAtMs: 5000 });
    const mid = snapshot({ phase: 'REVEAL', deal: s1, scores: { p1: 0 } }, 1);
    const e2 = createStateEvent(mid, { phase: 'REVEAL', deal: s2, scores: { p1: 0 } }, { eventId: randomUUID(), type: 'SECRET_RELEASED', commandId: 'c2', actorId: 'host', occurredAtMs: 6000 });
    const clock = vi.spyOn(Date, 'now'), random = vi.spyOn(Math, 'random');
    try {
      const wire = JSON.parse(JSON.stringify([e1, e2]));
      const replay = () => wire.reduce((snap: EngineStateSnapshot, event: unknown) => applyStateEvent(snap, event), base) as EngineStateSnapshot;
      const replayed = replay();
      expect(replay()).toEqual(replayed);
      expect(replayed.stateVersion).toBe(2);
      expect(parseSecretRoleDealState(replayed.state.deal)).toEqual(s2);
      expect(parseSecretRoleDealState(replayed.state.deal).assignments).toEqual(s0.assignments); // replay re-deals nothing
      for (const who of [owner, { role: 'VIEWER' }, { role: 'HOST', blindHost: true }, { role: 'PLAYER', participantId: 'p4' }] as ProjectionAudience[]) {
        expect(projectSecretInfo(who, replayed.state.deal, scope)).toEqual(projectSecretInfo(who, s2, scope));
      }
      expect(replayed.state.scores).toEqual({ p1: 0 }); // replay writes no points
      expect(clock).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); random.mockRestore(); }
    expect(() => applyStateEvent({ ...base, runIndex: 3 }, e1)).toThrow('EVENT_SCOPE_MISMATCH');
    expect(() => applyStateEvent({ ...base, stateVersion: 5 }, e1)).toThrow('EVENT_VERSION_CONFLICT');
    const tampered = clone(e1);
    (tampered.changes.find((c: { key: string }) => c.key === 'deal')!.value as { assignments: { roleId: string }[] }).assignments[0].roleId = 'rolemarkerghost';
    expect(message(() => parseSecretRoleDealState(applyStateEvent(base, tampered).state.deal))).toBe('SECRET_INFO_STATE_INVALID');
  });
  it('repeats the same projection on every read, rejoin and recovery (no re-draw, no re-timing)', () => {
    const released = release(state, ['fragalpha'], 5000).state;
    const results = Array.from({ length: 5 }, () => text(projectSecretInfo(owner, clone(released), scope)));
    expect(new Set(results).size).toBe(1);
  });
});

describe('N5 compatibility with N1–N4 and the existing engines', () => {
  const state = fresh();
  const scope = scopeOf(state);
  it('does not accept private deal data — or a projection — as a legacy answer, a voting ballot or a complete game state', () => {
    const legacy = { participantId: 'p', roundId: 'r', value: 'A', status: 'SUBMITTED', submittedAtMs: 1, judgedAtMs: null, decision: null };
    expect(SubmissionRecordSchema.parse(legacy)).toEqual(legacy);
    const projection = projectSecretInfo({ role: 'PLAYER', participantId: 'p1' }, state, scope);
    for (const foreign of [state, projection, state.assignments[0], state.fragments[0], projection.own]) {
      expect(SubmissionRecordSchema.safeParse(foreign).success).toBe(false);
      expect(SubmissionRecordSchema.safeParse({ ...legacy, value: foreign }).success).toBe(false);
      expect(VotingBallotSchema.safeParse(foreign).success).toBe(false);
    }
    const timer = createTimer('COUNTDOWN', 1000, 20000);
    expect(() => submitOnce({ participantId: 'p', roundId: 'r', value: state.assignments[0] as never, timer, now: 5000 })).toThrow();
    expect(submitOnce({ participantId: 'p', roundId: 'r', value: '7', timer, now: 5000 }).value).toBe('7');
    expect(() => submitOnce({ participantId: 'p', roundId: 'r', value: projection as never, timer, now: 5000 })).toThrow();
  });
  it('keeps N1–N4 and N5 states mutually unreadable; N1–N4 still work', () => {
    const numeric = createNumericRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, scale: 0, min: { units: 0, scale: 0 }, max: { units: 10, scale: 0 }, unit: null, boundsDisclosure: 'PUBLIC' } });
    const textCard = createTextCardRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, fields: [{ fieldId: 'alpha', label: 'A', help: null, required: true }], maxCodePointsPerField: 10, maxTotalCodePoints: 10 } });
    const ordering = createOrderingRound({ runIndex: 1, roundId: 'r', config: { schemaVersion: 1, prompt: null, directionHint: null, items: [{ itemId: 'aa', label: 'A', help: null }, { itemId: 'bb', label: 'B', help: null }] }, referenceRevision: null });
    const voting = createVotingPoll({ runIndex: 1, roundId: 'r', pollId: 'poll-1', config: { schemaVersion: 1, prompt: null, options: [{ optionId: 'aa', label: 'A', help: null }, { optionId: 'bb', label: 'B', help: null }] },
      eligibility: { schemaVersion: 1, revision: 'rev', voters: [{ participantId: 'p1', allowedOptionIds: ['aa'], allowAbstain: true }] } });
    for (const other of [numeric, textCard, ordering, voting]) expect(message(() => parseSecretRoleDealState(other))).toBe('SECRET_INFO_STATE_INVALID');
    expect(message(() => parseNumericRoundState(state))).toBe('NUMERIC_STATE_INVALID');
    expect(message(() => parseTextCardRoundState(state))).toBe('TEXT_CARD_STATE_INVALID');
    expect(message(() => parseOrderingRoundState(state))).toBe('ORDERING_STATE_INVALID');
    expect(message(() => parseVotingPollState(state))).toBe('VOTING_STATE_INVALID');
    expect(parseNumericRoundState(numeric)).toEqual(numeric);
    expect(parseTextCardRoundState(textCard)).toEqual(textCard);
    expect(parseOrderingRoundState(ordering)).toEqual(ordering);
    expect(parseVotingPollState(voting)).toEqual(voting);
  });
  it('gives the three real engines no secret-info entry point', () => {
    const context: CoreActionContext = { gameSlug: 'wer-ist-das', roomStatus: 'RUNNING', state: createWerIstDasState(1, { alice: 'Alice' }),
      informationRole: 'PLAYER', participantId: 'alice', active: true, permissions: new Set(['BUZZER_CONTROL']), now: 100 };
    for (const slug of ['wissensduell', 'jeopardy', 'wer-ist-das']) {
      const contract = getGameEngineContract(slug)!;
      for (const action of ['secret.release', 'secret:release', 'secret.reveal', 'secretInfo:read', 'releaseSecretInformation', 'createSecretRoleDeal', 'role.assign']) {
        expect(contract.validateCommand({ ...context, gameSlug: slug }, { action, payload: { fragmentIds: ['fragalpha'] } }), `${slug}/${action}`).toMatchObject({ success: false });
      }
    }
  });
  it('exposes every secret-info error code on the wire with its own code, and unknown ones stay INTERNAL_ERROR', () => {
    for (const code of SECRET_INFO_ERROR_CODES) expect(gameErrorCode(new Error(code)), code).toBe(code);
    expect(gameErrorCode(new SecretInfoError('SECRET_INFO_RELEASE_INVALID', ['RELEASE_UNKNOWN_FRAGMENT']))).toBe('SECRET_INFO_RELEASE_INVALID');
    expect(gameErrorCode(new Error('SECRET_INFO_SOMETHING_ELSE'))).toBe('INTERNAL_ERROR');
    expect(gameErrorCode(new Error('RELEASE_UNKNOWN_FRAGMENT'))).toBe('INTERNAL_ERROR'); // issue codes are not wire codes
  });
});
