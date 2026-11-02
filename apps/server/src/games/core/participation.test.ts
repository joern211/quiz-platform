import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as contract from '@quiz/shared/participation';
import {
  PARTICIPATION_CONTRACT, PARTICIPATION_ERROR_CODES, PARTICIPATION_ISSUE_CODES, PARTICIPATION_MAX_ACTORS, PARTICIPATION_MAX_LIVES,
  ParticipationError, ParticipationProjectionSchema, parseParticipationProjection, participationActorView, participationContextKey,
  participationProjectionMatches, type ParticipationExpectedContext, type ParticipationProjection,
} from '@quiz/shared/participation';

// Synthetic fixtures: ids are not names, no game preset, no rule.
const scope = { runIndex: 2, trackId: 'track-1', rosterRevision: 'roster-1', actorKind: 'PARTICIPANT' as const };
const projection = (over: Partial<ParticipationProjection> = {}): ParticipationProjection => ({
  contract: PARTICIPATION_CONTRACT, scope: { ...scope }, stateVersion: 7,
  own: { actorId: 'p1', status: 'ACTIVE', lives: { state: 'VALUE', value: 3 } },
  public: [{ actorId: 'p2', status: 'ELIMINATED', lives: { state: 'HIDDEN' } }], ...over,
});
const expected = (over: Partial<ParticipationExpectedContext> = {}): ParticipationExpectedContext => ({ ...scope, actorId: 'p1', minStateVersion: 5, ...over });

describe('N6 client contract: bounds, enumerations, lives view', () => {
  it('names its bounds as constants', () => {
    expect(PARTICIPATION_MAX_ACTORS).toBe(100);
    expect(PARTICIPATION_MAX_LIVES).toBe(1000);
    expect(contract.PARTICIPATION_ACTOR_KINDS).toEqual(['PARTICIPANT', 'TEAM']);
    expect(contract.PARTICIPATION_STATUSES).toEqual(['ACTIVE', 'ELIMINATED']);
    expect(contract.PARTICIPATION_ZERO_LIVES_POLICIES).toEqual(['ELIMINATE', 'KEEP_ACTIVE']);
    expect(contract.PARTICIPATION_RELEASES).toEqual(['NONE', 'STATUS', 'STATUS_AND_LIVES']);
    expect(new Set(PARTICIPATION_ERROR_CODES).size).toBe(PARTICIPATION_ERROR_CODES.length);
    expect(new Set(PARTICIPATION_ISSUE_CODES).size).toBe(PARTICIPATION_ISSUE_CODES.length);
  });
  it('keeps a real 0, an explicit "no life model" and a hidden value apart', () => {
    const lives = (value: unknown) => parseParticipationProjection(projection({ own: { actorId: 'p1', status: 'ACTIVE', lives: value as never } })).ok;
    expect(lives({ state: 'VALUE', value: 0 })).toBe(true);
    expect(lives({ state: 'VALUE', value: 1000 })).toBe(true);
    expect(lives({ state: 'NO_MODEL' })).toBe(true);
    for (const bad of [{ state: 'VALUE', value: 1001 }, { state: 'VALUE', value: -1 }, { state: 'VALUE', value: 1.5 }, { state: 'VALUE', value: null }, { state: 'VALUE' },
      { state: 'VALUE', value: Number.NaN }, { state: 'VALUE', value: Infinity }, { state: 'VALUE', value: 2 ** 53 }, { state: 'NO_MODEL', value: 0 }, { state: 'HIDDEN', value: 0 },
      { state: 'ZERO' }, null, 0, 3, 'HIDDEN']) expect(lives(bad), JSON.stringify(bad)).toBe(false);
    expect(lives({ state: 'HIDDEN' })).toBe(false); // an own record is never "hidden"
    const pub = (value: unknown) => parseParticipationProjection(projection({ public: [{ actorId: 'p2', status: 'ACTIVE', lives: value as never }] })).ok;
    expect(pub({ state: 'HIDDEN' })).toBe(true);
    expect(pub({ state: 'VALUE', value: 0 })).toBe(true);
  });
});

describe('N6 client projection contract', () => {
  it('accepts a valid projection and returns an independent copy', () => {
    const source = projection();
    const result = parseParticipationProjection(source);
    expect(result.ok && result.projection).toEqual(source);
    if (result.ok) { result.projection.own!.status = 'ELIMINATED'; result.projection.public[0].actorId = 'zz'; result.projection.scope.trackId = 'x'; }
    expect(source.own!.status).toBe('ACTIVE');
    expect(source.public[0].actorId).toBe('p2');
    expect(source.scope.trackId).toBe('track-1');
  });
  it('accepts the empty shapes: nothing released, no own record (viewer / display / host)', () => {
    expect(parseParticipationProjection(projection({ own: null, public: [] })).ok).toBe(true);
  });
  it('is strict at every level: no policy, bound, start value, cause, time, counter, roster, member list or role fits', () => {
    const base = projection();
    for (const extra of ['maxLives', 'startLives', 'zeroLivesPolicy', 'cause', 'eliminatedAtMs', 'version', 'roster', 'members', 'role', 'seed', 'history']) {
      expect(parseParticipationProjection({ ...base, [extra]: 1 }).ok, `projection.${extra}`).toBe(false);
      expect(parseParticipationProjection({ ...base, scope: { ...base.scope, [extra]: 1 } }).ok, `scope.${extra}`).toBe(false);
      expect(parseParticipationProjection({ ...base, own: { ...base.own, [extra]: 1 } }).ok, `own.${extra}`).toBe(false);
      expect(parseParticipationProjection({ ...base, public: [{ ...base.public[0], [extra]: 1 }] }).ok, `public.${extra}`).toBe(false);
      expect(parseParticipationProjection({ ...base, own: { ...base.own!, lives: { state: 'VALUE', value: 1, [extra]: 1 } } }).ok, `lives.${extra}`).toBe(false);
    }
  });
  it('rejects wrong contract, bad scope fields, bad versions, duplicates and over-long lists — code only', () => {
    const base = projection();
    const bad: unknown[] = [null, undefined, 'x', [], {}, { ...base, contract: 'PARTICIPATION_STATUS_V2' }, { ...base, stateVersion: -1 }, { ...base, stateVersion: 1.5 },
      { ...base, stateVersion: Number.NaN }, { ...base, stateVersion: 2 ** 53 }, { ...base, stateVersion: '7' }, { ...base, stateVersion: undefined },
      { ...base, scope: { ...scope, runIndex: 0 } }, { ...base, scope: { ...scope, trackId: '' } }, { ...base, scope: { ...scope, rosterRevision: 'a b' } }, { ...base, scope: { ...scope, actorKind: 'PLAYER' } },
      { ...base, scope: { runIndex: 2, trackId: 'track-1', rosterRevision: 'roster-1' } }, { ...base, own: undefined }, { ...base, public: undefined },
      { ...base, own: { actorId: '', status: 'ACTIVE', lives: { state: 'NO_MODEL' } } }, { ...base, own: { actorId: 'p1', status: 'DEAD', lives: { state: 'NO_MODEL' } } },
      { ...base, public: [base.public[0], base.public[0]] }, { ...base, public: Array.from({ length: PARTICIPATION_MAX_ACTORS + 1 }, (_, i) => ({ actorId: `a${i}`, status: 'ACTIVE', lives: { state: 'HIDDEN' } })) }];
    for (const input of bad) expect(parseParticipationProjection(input), JSON.stringify(input)).toEqual({ ok: false, code: 'PARTICIPATION_PROJECTION_INVALID' });
    expect(ParticipationProjectionSchema.safeParse(null).success).toBe(false);
  });
  it('binds a projection to the expected run, track, roster revision, actor kind AND a snapshot not older than expected', () => {
    const ok = projection();
    expect(participationProjectionMatches(ok, expected())).toBe(true);
    expect(participationProjectionMatches(ok, expected({ minStateVersion: 7 }))).toBe(true); // equal is fine
    expect(participationProjectionMatches(ok, expected({ minStateVersion: 8 }))).toBe(false); // an older snapshot than the caller already holds
    for (const wrong of [{ runIndex: 3 }, { trackId: 'track-2' }, { rosterRevision: 'roster-2' }, { actorKind: 'TEAM' as const }]) {
      expect(participationProjectionMatches(ok, expected(wrong)), JSON.stringify(wrong)).toBe(false);
    }
    expect(participationProjectionMatches(ok, expected({ minStateVersion: Number.NaN }))).toBe(false);
    expect(participationProjectionMatches(ok, expected({ minStateVersion: 1.5 }))).toBe(false);
  });
  it('finds an actor: the own record first (private), else only the explicitly released public entry', () => {
    const p = projection();
    expect(participationActorView(p, 'p1')).toEqual({ view: p.own, own: true });
    expect(participationActorView(p, 'p2')).toEqual({ view: p.public[0], own: false });
    expect(participationActorView(p, 'p9')).toBeNull();
    expect(participationActorView(projection({ own: null, public: [] }), 'p1')).toBeNull();
    expect(participationActorView(p, '__proto__')).toBeNull();
  });
  it('derives the UI context key from labels only — actor kind and actor id are part of it, the expected snapshot version is not', () => {
    const key = participationContextKey(expected());
    expect(key).toBe(JSON.stringify(['PARTICIPATION', 2, 'track-1', 'roster-1', 'PARTICIPANT', 'p1']));
    for (const wrong of [{ runIndex: 3 }, { trackId: 'track-2' }, { rosterRevision: 'roster-2' }, { actorKind: 'TEAM' as const }, { actorId: 'p2' }]) {
      expect(participationContextKey(expected(wrong)), JSON.stringify(wrong)).not.toBe(key);
    }
    expect(participationContextKey(expected({ minStateVersion: 99 }))).toBe(key);
  });
});

describe('N6 client contract: errors, exports and strip-only loading', () => {
  it('is a typed error with a code only', () => {
    const error = new ParticipationError('PARTICIPATION_VERSION_STALE', ['SHAPE_INVALID']);
    expect(error.message).toBe('PARTICIPATION_VERSION_STALE');
    expect(error.code).toBe('PARTICIPATION_VERSION_STALE');
    expect(error.name).toBe('ParticipationError');
    expect(error.issues).toEqual(['SHAPE_INVALID']);
  });
  it('exports no server-private schema, no track, no mutation and no config to the browser', () => {
    const names = Object.keys(contract);
    expect(names.filter(name => !/^PARTICIPATION_(MAX_|SCHEMA_VERSION|CONTRACT|ACTOR_KINDS|STATUSES|ZERO_LIVES_POLICIES|RELEASES|ELIMINATION_CAUSES|ISSUE_CODES|ERROR_CODES)/.test(name)
      && /Track|Config|Elimination|Mutation|changeLives|eliminate|Private|Roster(?!Revision)|State(?!Version)/i.test(name))).toEqual([]);
    expect(names).not.toContain('createParticipationTrack');
    expect(names).not.toContain('ParticipationTrackStateSchema');
  });
  it('imports nothing but zod: no server code, no secret configuration, no relative module', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/participation.ts', import.meta.url));
    const imports = readFileSync(file, 'utf8').split('\n').filter(line => /^\s*(import|export)\b.*\bfrom\b/.test(line));
    expect(imports).toEqual(["import { z } from 'zod';"]);
  });
  it('is registered as a shared subpath export', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../packages/shared/package.json', import.meta.url)), 'utf8')) as { exports: Record<string, string> };
    expect(manifest.exports['./participation']).toBe('./src/participation.ts');
  });
  it('loads as plain TypeScript in Node strip-only mode, as dist/app.js does with @quiz/shared', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/participation.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(file)}); const e = new m.ParticipationError('PARTICIPATION_STATE_INVALID', ['SHAPE_INVALID']);
       const scope = { runIndex: 1, trackId: 't', rosterRevision: 'r', actorKind: 'TEAM' };
       const p = m.parseParticipationProjection({ contract: 'PARTICIPATION_STATUS_V1', scope, stateVersion: 3, own: { actorId: 'a', status: 'ELIMINATED', lives: { state: 'VALUE', value: 0 } }, public: [] });
       const x = m.parseParticipationProjection({ contract: 'PARTICIPATION_STATUS_V1', scope, stateVersion: 3, own: null, public: [], maxLives: 3 });
       console.log(JSON.stringify([e.code, e.message, e.issues.length, p.ok, x.ok, m.participationContextKey({ ...scope, actorId: 'a', minStateVersion: 0 })]));`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim())).toEqual(['PARTICIPATION_STATE_INVALID', 'PARTICIPATION_STATE_INVALID', 1, true, false, '["PARTICIPATION",1,"t","r","TEAM","a"]']);
  });
});
