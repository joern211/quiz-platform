import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VOTING_MAX_OPTIONS, VOTING_MAX_VOTERS, VOTING_MIN_OPTIONS, VotingBallotSchema, VotingError, VotingTallySchema,
  parseVotingOptionsConfig, validateVotingBallot, validateVotingEligibility, votingAbstainBallot, votingContextKey, votingOptionBallot,
  votingOptionSetKey, votingOptionsKey, votingSelectableOptionIds, votingTallyIsConsistent,
  type VotingOptionDef, type VotingOptionsConfig, type VotingTally,
} from '@quiz/shared/voting';
import { parseOrderingConfig } from '@quiz/shared/ordering';
import { parseTextCardConfig } from '@quiz/shared/textcard';

// Synthetic fixtures: ids/labels are NOT game presets and carry no author, role, solution or "real/fake" meaning.
const opt = (optionId: string, over: Partial<VotingOptionDef> = {}): VotingOptionDef => ({ optionId, label: `Option ${optionId}`, help: null, ...over });
const config = (ids: string[] = ['aa', 'bb', 'cc'], over: Partial<VotingOptionsConfig> = {}): VotingOptionsConfig =>
  ({ schemaVersion: 1, prompt: null, options: ids.map(id => opt(id)), ...over });
const parsed = (c: unknown): VotingOptionsConfig => { const r = parseVotingOptionsConfig(c); if (!r.ok) throw new Error('config'); return r.config; };
const voter = (participantId: string, allowedOptionIds: string[], allowAbstain = false) => ({ participantId, allowedOptionIds, allowAbstain });
const eligibility = (voters: unknown[], revision = 'roster-1') => ({ schemaVersion: 1, revision, voters });
const optionBallot = (optionId: unknown) => ({ schemaVersion: 1, kind: 'OPTION', optionId });
const abstain = () => ({ schemaVersion: 1, kind: 'ABSTAIN' });
const many = (n: number) => Array.from({ length: n }, (_, i) => `op${i}`);
const codes = (r: { ok: boolean; issues?: { optionId: string | null; code: string }[] }) => (r.ok ? ['OK'] : (r.issues ?? []).map(i => `${i.optionId}:${i.code}`));
const U = (...cp: number[]) => String.fromCodePoint(...cp);

describe('N4 option config: explicit, bounded, versioned, public', () => {
  it('accepts the smallest and the largest poll and refuses one option less / one more', () => {
    expect(VOTING_MIN_OPTIONS).toBe(2);
    expect(VOTING_MAX_OPTIONS).toBe(32);
    expect(parseVotingOptionsConfig(config(many(2))).ok).toBe(true);
    expect(parseVotingOptionsConfig(config(many(32))).ok).toBe(true);
    expect(parseVotingOptionsConfig(config(many(1))).ok).toBe(false);
    expect(parseVotingOptionsConfig(config(many(0))).ok).toBe(false);
    expect(parseVotingOptionsConfig(config(many(33))).ok).toBe(false);
    expect(JSON.stringify(config(many(32), { prompt: 'x'.repeat(200) })).length).toBeLessThan(16 * 1024);
  });
  it('keeps option ids and labels apart: equal labels with different ids stay different options; equal ids are refused', () => {
    const same = parsed(config(['aa', 'bb'], { options: [opt('aa', { label: 'Gleich' }), opt('bb', { label: 'Gleich' })] }));
    expect(same.options.map(o => o.optionId)).toEqual(['aa', 'bb']); // no automatic de-duplication, no normalization
    expect(parseVotingOptionsConfig(config(['aa', 'aa'])).ok).toBe(false);
    expect(parseVotingOptionsConfig(config(['aa', 'bb'], { options: [opt('aa', { label: 'x' }), opt('aa', { label: 'y' })] })).ok).toBe(false);
  });
  it('rejects dangerous, malformed and over-long option ids; "abstain" and "null" are ordinary ids', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype', 'proto', 'Aa', '1a', 'a b', 'a.b', '', 'x'.repeat(41), '-a']) {
      expect(parseVotingOptionsConfig(config(['aa'], { options: [opt('aa'), opt(bad)] })).ok, bad).toBe(false);
    }
    expect(parseVotingOptionsConfig(config(['aa'], { options: [opt('aa'), opt('x'.repeat(40))] })).ok).toBe(true);
    for (const id of ['abstain', 'null', 'none', 'enthalten']) {
      expect(parseVotingOptionsConfig(config(['aa'], { options: [opt('aa'), opt(id)] })).ok, id).toBe(true);
    }
  });
  it('is strict: no author, owner, role, solution, correctness flag, seed or voter data can ride along — at any level', () => {
    const base = config(['aa', 'bb']);
    for (const extra of ['authorId', 'ownerId', 'isCorrect', 'role', 'solution', 'seed', 'voters', 'allowedOptionIds', 'target']) {
      expect(parseVotingOptionsConfig({ ...base, [extra]: 'x' }).ok, `config.${extra}`).toBe(false);
      expect(parseVotingOptionsConfig({ ...base, options: [{ ...base.options[0], [extra]: 'x' }, base.options[1]] }).ok, `option.${extra}`).toBe(false);
    }
    expect(parseVotingOptionsConfig({ ...base, schemaVersion: 2 }).ok).toBe(false);
    expect(parseVotingOptionsConfig({ ...base, schemaVersion: undefined }).ok).toBe(false);
    expect(parseVotingOptionsConfig(null).ok).toBe(false);
    expect(parseVotingOptionsConfig('x').ok).toBe(false);
    const failure = parseVotingOptionsConfig({ ...base, solution: 'GEHEIM' });
    expect(failure).toEqual({ ok: false, code: 'VOTING_CONFIG_INVALID' }); // a code only: no zod path, no echoed value
  });
  it('bounds label, help and prompt and allows exactly one not-set representation (null)', () => {
    const withLabel = (label: string) => parseVotingOptionsConfig(config(['aa', 'bb'], { options: [opt('aa', { label }), opt('bb')] })).ok;
    const withHelp = (help: string | null) => parseVotingOptionsConfig(config(['aa', 'bb'], { options: [opt('aa', { help }), opt('bb')] })).ok;
    expect(withLabel('x'.repeat(120))).toBe(true);
    expect(withLabel('x'.repeat(121))).toBe(false);
    expect(withLabel('')).toBe(false);
    expect(withHelp('x'.repeat(200))).toBe(true);
    expect(withHelp('x'.repeat(201))).toBe(false);
    expect(withHelp('')).toBe(false);
    expect(withHelp(null)).toBe(true);
    expect(parseVotingOptionsConfig(config(['aa', 'bb'], { prompt: 'x'.repeat(200) })).ok).toBe(true);
    expect(parseVotingOptionsConfig(config(['aa', 'bb'], { prompt: 'x'.repeat(201) })).ok).toBe(false);
    expect(parseVotingOptionsConfig(config(['aa', 'bb'], { prompt: '' })).ok).toBe(false);
  });
  it('uses the same display-text policy as N2 and N3 (parity): no padding, control/bidi characters, lone surrogates or blank text', () => {
    const samples = ['ok', 'Ümläut', U(0x1F600), ' x', 'x ', 'a\tb', 'a\nb', U(0x61, 0x202A, 0x62), U(0x61, 0x2066, 0x62), U(0x61, 0xFEFF, 0x62), U(0x61, 0x200D, 0x62),
      U(0xDC00), U(0x61, 0xD83D), 'x'.repeat(80), U(0x2028), U(0x2029)];
    for (const s of samples) {
      const n2 = parseTextCardConfig({ schemaVersion: 1, fields: [{ fieldId: 'aa', label: s, help: null, required: true }], maxCodePointsPerField: 5, maxTotalCodePoints: 5 }).ok;
      const n3 = parseOrderingConfig({ schemaVersion: 1, prompt: null, directionHint: null, items: [{ itemId: 'aa', label: s, help: null }, { itemId: 'bb', label: 'B', help: null }] }).ok;
      const n4 = parseVotingOptionsConfig(config(['aa', 'bb'], { options: [opt('aa', { label: s }), opt('bb')] })).ok;
      expect(n4, JSON.stringify(s)).toBe(n2);
      expect(n4, JSON.stringify(s)).toBe(n3);
    }
    const invisible = U(0x200B, 0x2060);
    expect(parseVotingOptionsConfig(config(['aa', 'bb'], { options: [opt('aa', { label: invisible }), opt('bb')] })).ok).toBe(false); // an invisible option is unusable
  });
  it('pins presentation order in the scope key, the SET in an order-independent key, and keeps labels out of both', () => {
    const a = parsed(config(['ab', 'cd', 'ef']));
    const relabeled = parsed({ ...a, options: a.options.map(o => ({ ...o, label: `Neu ${o.optionId}`, help: 'Neue Hilfe' })) });
    const reshuffled = parsed({ ...a, options: [a.options[2], a.options[0], a.options[1]] });
    const other = parsed(config(['ab', 'cd', 'zz']));
    expect(votingOptionsKey(relabeled)).toBe(votingOptionsKey(a));
    expect(votingOptionsKey(reshuffled)).not.toBe(votingOptionsKey(a)); // a re-shuffled presentation is a different pinned scope
    expect(votingOptionSetKey(reshuffled)).toBe(votingOptionSetKey(a));
    expect(votingOptionSetKey(relabeled)).toBe(votingOptionSetKey(a));
    expect(votingOptionSetKey(other)).not.toBe(votingOptionSetKey(a));
    expect(votingOptionsKey(a)).not.toMatch(/Option/);
  });
  it('builds a public UI context key from run, round, poll and option set — a second poll of the same round differs', () => {
    const c = parsed(config(['aa', 'bb']));
    const key = (over: Record<string, unknown> = {}) => votingContextKey({ runIndex: 1, roundId: 'r1', pollId: 'poll-1', config: c, ...over } as Parameters<typeof votingContextKey>[0]);
    expect(key()).toBe(key());
    expect(key({ pollId: 'poll-2' })).not.toBe(key());
    expect(key({ roundId: 'r2' })).not.toBe(key());
    expect(key({ runIndex: 2 })).not.toBe(key());
    expect(key({ config: parsed(config(['aa', 'cc'])) })).not.toBe(key());
    expect(key({ config: parsed({ ...c, options: [c.options[1], c.options[0]] }) })).toBe(key()); // mere metadata re-ordering of the same ids
    expect(key({ eligibilityRevision: 'roster-2' })).not.toBe(key({ eligibilityRevision: 'roster-1' }));
    expect(key()).not.toMatch(/Option|voter|allow/i);
  });
});

describe('N4 eligibility: private roster, per-voter allowlists, explicit abstention right', () => {
  const c = parsed(config(['aa', 'bb', 'cc']));
  it('accepts a roster with allowlists and keeps given order; returns a fresh canonical copy', () => {
    const voters = [voter('p1', ['aa', 'bb', 'cc'], false), voter('p2', ['bb', 'aa'], true), voter('p3', [], true)];
    const input = eligibility(voters);
    const before = JSON.stringify(input);
    const result = validateVotingEligibility(c, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.eligibility).toEqual(input);
    expect(result.eligibility).not.toBe(input);
    expect(result.eligibility.voters[1].allowedOptionIds).not.toBe(voters[1].allowedOptionIds);
    result.eligibility.voters[0].allowedOptionIds.push('zz');
    expect(JSON.stringify(input)).toBe(before); // no alias, no mutation
  });
  it('bounds the roster: 1 voter is the minimum, 100 the maximum', () => {
    expect(VOTING_MAX_VOTERS).toBe(100);
    const roster = (n: number) => eligibility(Array.from({ length: n }, (_, i) => voter(`p${i}`, ['aa'])));
    expect(validateVotingEligibility(c, roster(1)).ok).toBe(true);
    expect(validateVotingEligibility(c, roster(100)).ok).toBe(true);
    expect(validateVotingEligibility(c, roster(101)).ok).toBe(false);
    expect(validateVotingEligibility(c, roster(0)).ok).toBe(false);
  });
  it('refuses duplicate voters, duplicate or unknown allowed options and a voter with no possible choice', () => {
    expect(codes(validateVotingEligibility(c, eligibility([voter('p1', ['aa']), voter('p1', ['bb'])])))).toEqual(['null:ELIGIBILITY_DUPLICATE_VOTER']);
    expect(codes(validateVotingEligibility(c, eligibility([voter('p1', ['aa', 'aa'])])))).toEqual(['aa:ELIGIBILITY_DUPLICATE_OPTION']);
    expect(codes(validateVotingEligibility(c, eligibility([voter('p1', ['aa', 'zz'])])))).toEqual(['null:ELIGIBILITY_UNKNOWN_OPTION']);
    expect(codes(validateVotingEligibility(c, eligibility([voter('p1', [], false)])))).toEqual(['null:ELIGIBILITY_NO_CHOICE']); // contradiction: nothing to choose, may not abstain
    expect(validateVotingEligibility(c, eligibility([voter('p1', [], true)])).ok).toBe(true); // abstain-only is consistent
  });
  it('requires the abstention right to be explicit — a missing flag is not a default', () => {
    const missing = eligibility([{ participantId: 'p1', allowedOptionIds: ['aa'] }]);
    expect(codes(validateVotingEligibility(c, missing))).toEqual(['null:ELIGIBILITY_MALFORMED']);
    expect(codes(validateVotingEligibility(c, eligibility([{ participantId: 'p1', allowedOptionIds: ['aa'], allowAbstain: 'yes' }])))).toEqual(['null:ELIGIBILITY_MALFORMED']);
    expect(codes(validateVotingEligibility(c, eligibility([{ participantId: 'p1', allowedOptionIds: ['aa'], allowAbstain: null }])))).toEqual(['null:ELIGIBILITY_MALFORMED']);
  });
  it('rejects malformed shapes, wrong versions, bad revisions, extra keys and non-plain input', () => {
    const good = eligibility([voter('p1', ['aa'])]);
    for (const bad of [null, undefined, 'x', 3, [], { ...good, schemaVersion: 2 }, { ...good, extra: 1 }, { ...good, revision: '' }, { ...good, revision: 'bad rev' },
      { ...good, revision: 'x'.repeat(81) }, { ...good, voters: 'p1' }, { schemaVersion: 1, voters: good.voters },
      eligibility([{ participantId: 'p1', allowedOptionIds: ['aa'], allowAbstain: false, role: 'HOST' }]),
      eligibility([{ participantId: '', allowedOptionIds: ['aa'], allowAbstain: false }]),
      eligibility([{ participantId: 'p'.repeat(201), allowedOptionIds: ['aa'], allowAbstain: false }]),
      eligibility([{ participantId: 7, allowedOptionIds: ['aa'], allowAbstain: false }]),
      eligibility([{ participantId: 'p1', allowedOptionIds: 'aa', allowAbstain: false }]),
      eligibility([null]), eligibility(['p1']), Object.create({ inherited: true })]) {
      expect(validateVotingEligibility(c, bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateVotingEligibility(c, good).ok).toBe(true);
  });
  it('bounds the work before iterating (huge arrays) and never echoes attacker strings in issues', () => {
    const huge = eligibility(Array.from({ length: 200_000 }, () => voter('p', ['aa'])));
    expect(codes(validateVotingEligibility(c, huge))).toEqual(['null:ELIGIBILITY_MALFORMED']);
    const long = eligibility([voter('p1', Array.from({ length: 200_000 }, () => 'aa'))]);
    expect(codes(validateVotingEligibility(c, long))).toEqual(['null:ELIGIBILITY_MALFORMED']);
    const result = validateVotingEligibility(c, eligibility([voter('p1', ['GEHEIM-ID', '__proto__', 'aa'])]));
    expect(JSON.stringify(result)).not.toMatch(/GEHEIM|__proto__/);
  });
  it('derives the voter-visible choice list in PRESENTATION order from the allowlist', () => {
    expect(votingSelectableOptionIds(c, voter('p1', ['cc', 'aa']))).toEqual(['aa', 'cc']);
    expect(votingSelectableOptionIds(c, voter('p1', []))).toEqual([]);
    expect(votingSelectableOptionIds(c, voter('p1', ['aa', 'bb', 'cc']))).toEqual(['aa', 'bb', 'cc']);
  });
});

describe('N4 ballot: exactly one option or one explicit abstention', () => {
  const c = parsed(config(['aa', 'bb', 'abstain', 'null']));
  const free = voter('p1', ['aa', 'bb', 'abstain', 'null'], true);
  const noAbstain = voter('p2', ['aa', 'bb', 'abstain', 'null'], false);
  const restricted = voter('p3', ['bb'], false);

  it('accepts one allowed option and one allowed abstention as two different, discriminated states', () => {
    const o = validateVotingBallot(c, free, optionBallot('aa'));
    const a = validateVotingBallot(c, free, abstain());
    expect(o).toEqual({ ok: true, ballot: { schemaVersion: 1, kind: 'OPTION', optionId: 'aa' } });
    expect(a).toEqual({ ok: true, ballot: { schemaVersion: 1, kind: 'ABSTAIN' } });
    expect(VotingBallotSchema.safeParse(votingOptionBallot('aa')).success).toBe(true);
    expect(VotingBallotSchema.safeParse(votingAbstainBallot()).success).toBe(true);
    expect('optionId' in votingAbstainBallot()).toBe(false);
  });
  it('has no reserved abstain id: options called "abstain" and "null" are votes for options, never abstentions', () => {
    const asOption = validateVotingBallot(c, free, optionBallot('abstain'));
    expect(asOption.ok && asOption.ballot).toEqual({ schemaVersion: 1, kind: 'OPTION', optionId: 'abstain' });
    const asNull = validateVotingBallot(c, free, optionBallot('null'));
    expect(asNull.ok && asNull.ballot.kind).toBe('OPTION');
    const asAbstain = validateVotingBallot(c, free, abstain());
    expect(asAbstain.ok && asAbstain.ballot.kind).toBe('ABSTAIN');
    expect(codes(validateVotingBallot(c, free, optionBallot(null)))).toEqual(['null:BALLOT_MISSING_CHOICE']); // null is not an abstention either
  });
  it('refuses an abstention where the voter may not abstain, and an option the voter may not choose', () => {
    expect(codes(validateVotingBallot(c, noAbstain, abstain()))).toEqual(['null:BALLOT_ABSTAIN_NOT_ALLOWED']);
    expect(codes(validateVotingBallot(c, restricted, optionBallot('aa')))).toEqual(['null:BALLOT_OPTION_NOT_ALLOWED']);
    expect(validateVotingBallot(c, restricted, optionBallot('bb')).ok).toBe(true);
  });
  it('never turns a missing or empty choice into option 0 or an abstention', () => {
    for (const bad of [null, undefined, { schemaVersion: 1, kind: 'OPTION' }, optionBallot(undefined), optionBallot(null)]) {
      expect(codes(validateVotingBallot(c, free, bad)), JSON.stringify(bad)).toEqual(['null:BALLOT_MISSING_CHOICE']);
    }
    for (const bad of [{}, { schemaVersion: 1 }, { kind: 'OPTION', optionId: 'aa' }, { schemaVersion: 1, kind: 'NONE' }, { schemaVersion: 1, kind: 'abstain' },
      { schemaVersion: 1, kind: 'option', optionId: 'aa' }, { schemaVersion: 1, kind: null }]) {
      expect(validateVotingBallot(c, free, bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('refuses wrong types, labels and indices as identity, multiple choices, extra keys and wrong versions', () => {
    for (const bad of [optionBallot(0), optionBallot(1), optionBallot(true), optionBallot(['aa']), optionBallot({ id: 'aa' }), optionBallot('Option aa'), optionBallot('AA'),
      optionBallot('zz'), optionBallot('x'.repeat(500)), optionBallot('__proto__'),
      { schemaVersion: 1, kind: 'OPTION', optionIds: ['aa', 'bb'] }, { schemaVersion: 1, kind: 'OPTION', optionId: 'aa', optionIds: ['bb'] },
      { schemaVersion: 1, kind: 'OPTION', optionId: 'aa', voterId: 'p9' }, { schemaVersion: 1, kind: 'ABSTAIN', optionId: 'aa' },
      { schemaVersion: 1, kind: 'ABSTAIN', optionId: null }, { schemaVersion: 1, kind: 'ABSTAIN', extra: 1 },
      { schemaVersion: 2, kind: 'OPTION', optionId: 'aa' }, { schemaVersion: '1', kind: 'OPTION', optionId: 'aa' },
      'aa', 7, ['aa'], Object.create({ kind: 'ABSTAIN', schemaVersion: 1 })]) {
      expect(validateVotingBallot(c, free, bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('rejects an own __proto__ key and other prototype tricks as malformed', () => {
    const tricky = JSON.parse('{"schemaVersion":1,"kind":"OPTION","optionId":"aa","__proto__":{"optionId":"bb"}}');
    expect(validateVotingBallot(c, free, tricky).ok).toBe(false);
    const nullProto = Object.assign(Object.create(null), { schemaVersion: 1, kind: 'OPTION', optionId: 'aa' });
    expect(validateVotingBallot(c, free, nullProto).ok).toBe(true);
  });
  it('does not echo attacker strings in issues and returns fresh objects without mutating the input', () => {
    const attack = { schemaVersion: 1, kind: 'OPTION', optionId: 'GEHEIME-OPTION' };
    const bad = validateVotingBallot(c, free, attack);
    expect(JSON.stringify(bad)).not.toMatch(/GEHEIME/);
    const input = optionBallot('aa');
    const frozen = JSON.stringify(input);
    const ok = validateVotingBallot(c, free, input);
    expect(ok.ok && ok.ballot).not.toBe(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(JSON.stringify(restricted)).toBe('{"participantId":"p3","allowedOptionIds":["bb"],"allowAbstain":false}');
  });
});

describe('N4 tally contract: a tally from elsewhere is never trusted', () => {
  const base: VotingTally = {
    contract: 'VOTING_TALLY_V1', pollId: 'poll-1', eligibleCount: 5, castCount: 4, optionVoteCount: 3, abstainCount: 1, missingCount: 1,
    options: [{ optionId: 'aa', votes: 2 }, { optionId: 'bb', votes: 1 }, { optionId: 'cc', votes: 0 }],
    top: { kind: 'SINGLE', votes: 2, optionIds: ['aa'] },
  };
  it('accepts a consistent tally including NONE and TIED shapes', () => {
    expect(votingTallyIsConsistent(base)).toBe(true);
    expect(votingTallyIsConsistent({ ...base, optionVoteCount: 0, abstainCount: 4, options: base.options.map(o => ({ ...o, votes: 0 })), top: { kind: 'NONE', votes: 0, optionIds: [] } })).toBe(true);
    expect(votingTallyIsConsistent({ ...base, castCount: 4, optionVoteCount: 4, abstainCount: 0, options: [{ optionId: 'aa', votes: 2 }, { optionId: 'bb', votes: 2 }, { optionId: 'cc', votes: 0 }], top: { kind: 'TIED', votes: 2, optionIds: ['aa', 'bb'] } })).toBe(true);
  });
  it('detects every tampered counter and a wrong "top"', () => {
    const tampered: VotingTally[] = [
      { ...base, eligibleCount: 6 }, { ...base, missingCount: 0 }, { ...base, castCount: 5 }, { ...base, abstainCount: 0 },
      { ...base, optionVoteCount: 4 }, { ...base, options: [{ optionId: 'aa', votes: 3 }, base.options[1], base.options[2]] },
      { ...base, options: [base.options[0], base.options[0], base.options[2]] },
      { ...base, top: { kind: 'TIED', votes: 2, optionIds: ['aa'] } }, { ...base, top: { kind: 'SINGLE', votes: 2, optionIds: ['bb'] } },
      { ...base, top: { kind: 'NONE', votes: 0, optionIds: [] } }, { ...base, top: { kind: 'SINGLE', votes: 1, optionIds: ['aa'] } },
      { ...base, top: { kind: 'SINGLE', votes: 2, optionIds: ['aa', 'bb'] } },
      { ...base, optionVoteCount: 0, abstainCount: 4, options: base.options.map(o => ({ ...o, votes: 0 })), top: { kind: 'TIED', votes: 0, optionIds: ['aa', 'bb', 'cc'] } }, // all zero is never a "leading group"
    ];
    for (const t of tampered) expect(votingTallyIsConsistent(t), JSON.stringify(t)).toBe(false);
    expect(votingTallyIsConsistent({ ...base, winner: 'aa' } as unknown as VotingTally)).toBe(false); // strict: no winner field
    expect(VotingTallySchema.safeParse({ ...base, voters: ['p1'] }).success).toBe(false); // strict: no voter list
  });
});

describe('N4 serialization and runtime', () => {
  it('roundtrips config, eligibility, ballots and tally through JSON unchanged', () => {
    const c = parsed(config(['aa', 'bb'], { prompt: 'Aufgabe', options: [opt('aa', { help: 'Hilfe' }), opt('bb')] }));
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    const e = validateVotingEligibility(c, JSON.parse(JSON.stringify(eligibility([voter('p1', ['aa', 'bb'], true), voter('p2', [], true)]))));
    expect(e.ok && JSON.parse(JSON.stringify(e.eligibility))).toEqual(eligibility([voter('p1', ['aa', 'bb'], true), voter('p2', [], true)]));
    for (const ballot of [optionBallot('bb'), abstain()]) {
      const v = validateVotingBallot(c, voter('p1', ['aa', 'bb'], true), JSON.parse(JSON.stringify(ballot)));
      expect(v.ok && JSON.parse(JSON.stringify(v.ballot))).toEqual(ballot);
    }
  });
  it('is a typed error with a code only', () => {
    const error = new VotingError('VOTING_INVALID', [{ optionId: 'aa', code: 'BALLOT_UNKNOWN_OPTION' }]);
    expect(error.message).toBe('VOTING_INVALID');
    expect(error.code).toBe('VOTING_INVALID');
    expect(error.name).toBe('VotingError');
  });
  it('loads as plain TypeScript in Node strip-only mode, as dist/app.js does with @quiz/shared', () => {
    const file = fileURLToPath(new URL('../../../../../packages/shared/src/voting.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(file)}); const e = new m.VotingError('VOTING_INVALID', [{ optionId: null, code: 'BALLOT_MALFORMED' }]);
       const cfg = m.VotingOptionsConfigSchema.parse({ schemaVersion: 1, prompt: null, options: [{ optionId: 'aa', label: 'A', help: null }, { optionId: 'bb', label: 'B', help: null }] });
       const v = m.validateVotingBallot(cfg, { allowedOptionIds: ['aa'], allowAbstain: true }, { schemaVersion: 1, kind: 'ABSTAIN' });
       const x = m.validateVotingBallot(cfg, { allowedOptionIds: ['aa'], allowAbstain: true }, { schemaVersion: 1, kind: 'OPTION', optionId: 'bb' });
       console.log(JSON.stringify([e.code, e.message, e.issues.length, v.ok && v.ballot.kind, x.ok, m.votingOptionsKey(cfg)]));`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim())).toEqual(['VOTING_INVALID', 'VOTING_INVALID', 1, 'ABSTAIN', false, '[1,["aa","bb"]]']);
  });
});
