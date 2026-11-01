import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as secretInfoModule from '@quiz/shared/secretInfo';
import {
  SECRET_INFO_CONTRACT, SECRET_INFO_ERROR_CODES, SECRET_INFO_ISSUE_CODES, SECRET_INFO_MAX_FRAGMENTS, SECRET_INFO_MAX_TEXT_LENGTH,
  SECRET_INFO_MAX_TEXT_LINES, SECRET_INFO_MAX_TITLE_LENGTH, SecretInfoError, SecretInfoProjectionSchema, SecretInfoTextSchema, SecretInfoTitleSchema,
  parseSecretInfoProjection, secretInfoContextKey, secretInfoProjectionMatches, type SecretInfoExpectedContext, type SecretInfoProjection,
} from '@quiz/shared/secretInfo';
import { VotingOptionDefSchema } from '@quiz/shared/voting';

// Synthetic fixtures: no game preset, no role names with meaning.
const U = (...cp: number[]) => String.fromCodePoint(...cp);
const scope = { runIndex: 2, roundId: 'round-7', dealId: 'deal-1', revision: 'rev-1' };
const projection = (over: Partial<SecretInfoProjection> = {}): SecretInfoProjection => ({
  contract: SECRET_INFO_CONTRACT, scope: { ...scope },
  own: { participantId: 'p1', fragments: [{ title: 'Titel', text: 'Text' }] }, released: [], ...over,
});
const expected = (over: Partial<SecretInfoExpectedContext> = {}): SecretInfoExpectedContext => ({ ...scope, participantId: 'p1', ...over });

describe('N5 client contract: bounds and display text', () => {
  it('names its limits as constants and enforces them exactly', () => {
    expect(SECRET_INFO_MAX_TITLE_LENGTH).toBe(80);
    expect(SECRET_INFO_MAX_TEXT_LENGTH).toBe(1000);
    expect(SECRET_INFO_MAX_TEXT_LINES).toBe(20);
    expect(SecretInfoTitleSchema.safeParse('x'.repeat(80)).success).toBe(true);
    expect(SecretInfoTitleSchema.safeParse('x'.repeat(81)).success).toBe(false);
    expect(SecretInfoTextSchema.safeParse('x'.repeat(1000)).success).toBe(true);
    expect(SecretInfoTextSchema.safeParse('x'.repeat(1001)).success).toBe(false);
    expect(SecretInfoTextSchema.safeParse(Array(20).fill('a').join('\n')).success).toBe(true);
    expect(SecretInfoTextSchema.safeParse(Array(21).fill('a').join('\n')).success).toBe(false);
    expect(SecretInfoTitleSchema.safeParse('').success).toBe(false);
    expect(SecretInfoTextSchema.safeParse('').success).toBe(false);
  });
  it('applies the SAME single-line rule as the N4 voting label (parity, so N2/N3/N4/N5 stay together)', () => {
    const probes = ['ok', 'mit Leerzeichen', ' führend', 'folgend ', '', '   ', 'a\tb', 'a\nb', 'a\rb', U(0x7), 'a' + U(0x202e) + 'b', 'a' + U(0x2066) + 'b', U(0xfeff) + 'a',
      'a' + U(0x2028) + 'b', 'a' + U(0xd800) + 'b', U(0x1f600), 'ä ö ü ß', U(0x200b), 'a' + U(0x200b), '<b>fett</b>', 'x'.repeat(80), 'x'.repeat(81)];
    for (const probe of probes) {
      const label = VotingOptionDefSchema.shape.label.safeParse(probe).success;
      const title = SecretInfoTitleSchema.safeParse(probe).success;
      // the voting label allows up to 120 characters, the title 80: compare within the common range
      if (probe.length <= 80) expect(title, JSON.stringify(probe)).toBe(label);
    }
  });
  it('allows plain line feeds in the TEXT but no other control character, no markup interpretation and no surrounding blank lines', () => {
    expect(SecretInfoTextSchema.safeParse('Zeile eins\nZeile zwei').success).toBe(true);
    expect(SecretInfoTextSchema.safeParse('<script>alert(1)</script>\n&amp; <b>x</b>').success).toBe(true); // plain text stays verbatim
    for (const bad of ['\nführend', 'folgend\n', 'a\r\nb', 'a\tb', 'a' + U(0x202e) + 'b', 'a' + U(0x2028) + 'b', 'a' + U(0xdc00) + 'b', '\n\n', U(0xfeff) + 'a']) {
      expect(SecretInfoTextSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(SecretInfoTextSchema.parse('<b>x</b>')).toBe('<b>x</b>');
  });
});

describe('N5 client projection contract', () => {
  it('accepts a valid projection and returns an independent copy', () => {
    const source = projection({ released: [{ title: 'Öffentlich', text: 'Zeile 1\nZeile 2' }] });
    const result = parseSecretInfoProjection(source);
    expect(result.ok && result.projection).toEqual(source);
    if (result.ok) {
      result.projection.released[0].text = 'MUTIERT';
      result.projection.scope.dealId = 'mutiert';
    }
    expect(source.released[0].text).toBe('Zeile 1\nZeile 2');
    expect(source.scope.dealId).toBe('deal-1');
  });
  it('accepts null for the private part (viewer, display, host) and zero fragments (a valid, neutral state)', () => {
    expect(parseSecretInfoProjection(projection({ own: null })).ok).toBe(true);
    expect(parseSecretInfoProjection(projection({ own: { participantId: 'p1', fragments: [] } })).ok).toBe(true);
  });
  it('is strict: no role, id, recipient, assignment, seed or any extra field fits — at any level', () => {
    const base = projection({ released: [{ title: 'T', text: 'X' }] });
    for (const extra of ['role', 'roleId', 'fragmentId', 'recipientIds', 'assignments', 'participants', 'seed', 'teamId', 'releasedAtMs']) {
      expect(parseSecretInfoProjection({ ...base, [extra]: 'x' }).ok, `projection.${extra}`).toBe(false);
      expect(parseSecretInfoProjection({ ...base, scope: { ...base.scope, [extra]: 'x' } }).ok, `scope.${extra}`).toBe(false);
      expect(parseSecretInfoProjection({ ...base, own: { ...base.own, [extra]: 'x' } }).ok, `own.${extra}`).toBe(false);
      expect(parseSecretInfoProjection({ ...base, own: { ...base.own!, fragments: [{ title: 'T', text: 'X', [extra]: 'x' }] } }).ok, `own fragment.${extra}`).toBe(false);
      expect(parseSecretInfoProjection({ ...base, released: [{ title: 'T', text: 'X', [extra]: 'x' }] }).ok, `released.${extra}`).toBe(false);
    }
  });
  it('rejects wrong contract, missing parts, bad scope fields and over-long lists — as a whole, with a code only', () => {
    const bad: unknown[] = [null, undefined, 'x', [], {}, { ...projection(), contract: 'SECRET_INFO_V2' }, { ...projection(), contract: undefined },
      { ...projection(), released: undefined }, { ...projection(), own: undefined }, { ...projection(), scope: { ...scope, runIndex: 0 } },
      { ...projection(), scope: { ...scope, runIndex: 1.5 } }, { ...projection(), scope: { ...scope, roundId: '' } }, { ...projection(), scope: { ...scope, dealId: 'a b' } },
      { ...projection(), scope: { ...scope, revision: '' } }, { ...projection(), scope: undefined },
      projection({ own: { participantId: '', fragments: [] } }),
      projection({ released: Array.from({ length: SECRET_INFO_MAX_FRAGMENTS + 1 }, () => ({ title: 'T', text: 'X' })) })];
    for (const input of bad) expect(parseSecretInfoProjection(input), JSON.stringify(input)).toEqual({ ok: false, code: 'SECRET_INFO_PROJECTION_INVALID' });
    expect(SecretInfoProjectionSchema.safeParse(null).success).toBe(false);
  });
  it('binds a projection to exactly the expected run, round, deal, revision and recipient', () => {
    const ok = projection();
    expect(secretInfoProjectionMatches(ok, expected())).toBe(true);
    for (const wrong of [{ runIndex: 3 }, { roundId: 'round-8' }, { dealId: 'deal-2' }, { revision: 'rev-2' }, { participantId: 'p2' }]) {
      expect(secretInfoProjectionMatches(ok, expected(wrong)), JSON.stringify(wrong)).toBe(false);
    }
    expect(secretInfoProjectionMatches(projection({ own: null }), expected())).toBe(false); // no private part → never usable
  });
  it('derives the UI context key from labels only, never from fragment content', () => {
    const key = secretInfoContextKey(expected());
    expect(key).toBe(JSON.stringify(['SECRET_INFO', 2, 'round-7', 'deal-1', 'rev-1', 'p1']));
    for (const wrong of [{ runIndex: 3 }, { roundId: 'round-8' }, { dealId: 'deal-2' }, { revision: 'rev-2' }, { participantId: 'p2' }]) {
      expect(secretInfoContextKey(expected(wrong)), JSON.stringify(wrong)).not.toBe(key);
    }
    expect(secretInfoContextKey(expected())).toBe(key); // stable
  });
});

describe('N5 client contract: errors, exports and strip-only loading', () => {
  it('is a typed error with a code only', () => {
    const error = new SecretInfoError('SECRET_INFO_RELEASE_INVALID', ['RELEASE_UNKNOWN_FRAGMENT']);
    expect(error.message).toBe('SECRET_INFO_RELEASE_INVALID');
    expect(error.code).toBe('SECRET_INFO_RELEASE_INVALID');
    expect(error.name).toBe('SecretInfoError');
    expect(error.issues).toEqual(['RELEASE_UNKNOWN_FRAGMENT']);
    expect(new Set(SECRET_INFO_ERROR_CODES).size).toBe(SECRET_INFO_ERROR_CODES.length);
    expect(new Set(SECRET_INFO_ISSUE_CODES).size).toBe(SECRET_INFO_ISSUE_CODES.length);
  });
  it('exports no server-private schema, no deal, no role map and no state helper to the browser', () => {
    const names = Object.keys(secretInfoModule);
    // limit constants (SECRET_INFO_MAX_*) and code lists are not secrets; any schema/function about the private state would be
    expect(names.filter(name => !/^SECRET_INFO_(MAX_|SCHEMA_VERSION|CONTRACT|ISSUE_CODES|ERROR_CODES)/.test(name)
      && /Deal|Assignment|RoleMap|Recipient|Release(?!d)|ServerPrivate|State|Private/i.test(name))).toEqual([]);
    expect(names).not.toContain('createSecretRoleDeal');
    expect(names).not.toContain('SecretRoleDealStateSchema');
  });
  it('imports nothing but zod: no server code, no secret configuration, no relative module', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/secretInfo.ts', import.meta.url));
    const imports = readFileSync(file, 'utf8').split('\n').filter(line => /^\s*(import|export)\b.*\bfrom\b/.test(line));
    expect(imports).toEqual(["import { z } from 'zod';"]);
  });
  it('is registered as a shared subpath export', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../packages/shared/package.json', import.meta.url)), 'utf8')) as { exports: Record<string, string> };
    expect(manifest.exports['./secretInfo']).toBe('./src/secretInfo.ts');
  });
  it('loads as plain TypeScript in Node strip-only mode, as dist/app.js does with @quiz/shared', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/secretInfo.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(file)}); const e = new m.SecretInfoError('SECRET_INFO_STATE_INVALID', ['SHAPE_INVALID']);
       const p = m.parseSecretInfoProjection({ contract: 'SECRET_INFO_V1', scope: { runIndex: 1, roundId: 'r', dealId: 'd', revision: 'v' }, own: { participantId: 'p', fragments: [{ title: 'T', text: 'a\\nb' }] }, released: [] });
       const x = m.parseSecretInfoProjection({ contract: 'SECRET_INFO_V1', scope: { runIndex: 1, roundId: 'r', dealId: 'd', revision: 'v' }, own: null, released: [], role: 'x' });
       console.log(JSON.stringify([e.code, e.message, e.issues.length, p.ok, x.ok, m.secretInfoContextKey({ runIndex: 1, roundId: 'r', dealId: 'd', revision: 'v', participantId: 'p' })]));`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim())).toEqual(['SECRET_INFO_STATE_INVALID', 'SECRET_INFO_STATE_INVALID', 1, true, false, '["SECRET_INFO",1,"r","d","v","p"]']);
  });
});
