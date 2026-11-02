// ============================================================
// N9 — Dice turn (domain building block, SERVER-PRIVATE)
//
// A small, validated, serialisable dice process bound to ONE concrete N8 turn: N dice with S sides, a bounded number of rolls, optional
// holding of dice between rolls, explicit closing. It is a building block for later engines (Yacht, a board race). It is NOT an engine:
// it scores nothing, recognises no combination, decides no winner and never advances, closes or restarts the N8 turn. It opens no route,
// socket event, table or setup UI.
//
// What it does NOT do (the later real consumer must supply it): authentication, admission, team assignment, rights, pause, phase, the
// N6 participation status, persistence, CAS, receipts, state events, audit. `rollDice` / `setDiceHeld` call the N8 `authorizeTurnAction`
// FIRST (turn identity, sequence version, holder, eligibility, gate) and only ADD the dice checks; a known participant id or a stored
// owner id is no authorisation.
//
// Randomness: there is NO seed / random-state core in the platform (only `shuffleServer` and ad-hoc `randomInt` uses). This module uses
// the same secure source (`node:crypto.randomInt`, unbiased) at exactly ONE place: the decision step of `rollDice`, AFTER every check.
// The truth is the stored RESULT (values, hold assignment, roll count); load, projection, rejoin, resync, restart and replay never draw.
// `applyDecidedDiceRoll` applies an ALREADY decided result and calls neither a random source nor a clock; it is server-private and no
// client payload schema can reach it (the shared roll intent has no values).
//
// Versions (kept apart; see design.md §3): `version` is the LOCAL counter of THIS process (+1 per real change), `rollCount` the roll
// number, `binding.turnNumber` the identity of the N8 turn. None of them is the N8 sequence version or the global `stateVersion`. The
// consumer commits a new dice state together with the state event in ONE CAS and under the command receipt (and, when
// `sequenceBasisAdvanced`, with N8 `refreshEligibilityBasis`). Alone this module guarantees no exactly-once processing.
// ============================================================

import { randomInt } from 'node:crypto';
import { z } from 'zod';
import {
  DICE_ERROR_CODES, DICE_MAX_COUNT, DICE_MAX_COUNTER, DICE_MAX_SIDES, DICE_RELEASES, DICE_SCHEMA_VERSION, DICE_CONTRACT, DiceActionBindingSchema, DiceActorIdSchema, DiceConfigSchema, DiceCounterSchema,
  DiceHoldIntentSchema, DicePhaseSchema, DiceProjectionSchema, DiceRefSchema, DiceRunIndexSchema, DiceScopeSchema, DiceStateVersionSchema, DiceTurnError, DiceUnitSchema,
  type DiceConfig, type DiceHoldIntent, type DiceIssueCode, type DicePhase, type DiceProjection, type DiceRollIntent, type DiceScope,
} from '@quiz/shared/dice';
import {
  authorizeTurnAction, currentTurnHolder, parseTurnSequenceState, turnEligibilityAdvancesBasis,
  type TurnActionCaller, type TurnActionGate, type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';
import { TURN_SEQUENCE_MAX_COUNTER } from '@quiz/shared/turnSequence';
import { canView, type ProjectionAudience } from './visibility.js';

export { DiceTurnError, DICE_ERROR_CODES };
export type { DiceProjection, DiceScope };

// ── Helpers ──────────────────────────────────────────────────

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
/** Exact key set: every required key present, no key outside required ∪ optional. */
const keysWithin = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
function args_(condition: boolean): asserts condition { if (!condition) throw new DiceTurnError('DICE_ARGS_INVALID'); }

// ── Server-private state ─────────────────────────────────────

const BindingSchema = z.object({
  sequenceId: DiceRefSchema,
  rosterRevision: DiceRefSchema,
  unit: DiceUnitSchema,
  /** the N8 turn this process belongs to (a player id alone is no turn) */
  turnNumber: DiceCounterSchema.min(1),
  playerId: DiceActorIdSchema,
  teamId: DiceActorIdSchema.nullable(),
}).strict();

export const DiceTurnStateSchema = z.object({
  kind: z.literal('DICE_TURN'),
  schemaVersion: z.literal(DICE_SCHEMA_VERSION),
  runIndex: DiceRunIndexSchema,
  diceId: DiceRefSchema,
  binding: BindingSchema,
  /** the effective configuration of THIS process — never changed after opening */
  config: DiceConfigSchema,
  phase: DicePhaseSchema,
  version: DiceCounterSchema,
  rollCount: DiceCounterSchema,
  /** values BY POSITION; null before the first roll */
  values: z.array(z.number().int().safe().min(1).max(DICE_MAX_SIDES)).min(1).max(DICE_MAX_COUNT).nullable(),
  held: z.array(z.boolean()).min(1).max(DICE_MAX_COUNT),
  /** the positions drawn in the LAST roll, ascending */
  lastRolled: z.array(z.number().int().safe().min(0).max(DICE_MAX_COUNT - 1)).max(DICE_MAX_COUNT),
}).strict();
export type DiceTurnState = z.infer<typeof DiceTurnStateSchema>;

/** Cross-field invariants of a structurally valid state (bounds were checked first). Code-only issues. */
function stateIssues(state: DiceTurnState): DiceIssueCode[] {
  const issues = new Set<DiceIssueCode>();
  const add = (code: DiceIssueCode, condition: boolean) => { if (condition) issues.add(code); };
  const { config, rollCount, values, held, lastRolled } = state;
  add('BINDING_CONFLICT', (state.binding.unit === 'TEAM') !== (state.binding.teamId !== null));
  add('COUNTER_CONFLICT', rollCount > config.maxRolls || state.version < rollCount);
  if (state.phase === 'PREPARED') add('PHASE_CONFLICT', rollCount !== 0 || state.version !== 0);
  if (state.phase === 'IN_PROGRESS') add('PHASE_CONFLICT', rollCount < 1 || rollCount >= config.maxRolls);
  if (state.phase === 'EXHAUSTED') add('PHASE_CONFLICT', rollCount !== config.maxRolls);
  if (state.phase === 'CLOSED') add('COUNTER_CONFLICT', state.version < rollCount + 1);
  add('VALUES_CONFLICT', (values === null) !== (rollCount === 0));
  add('VALUES_CONFLICT', values !== null && (values.length !== config.diceCount || values.some(value => value > config.sides)));
  add('HELD_CONFLICT', held.length !== config.diceCount || (held.some(Boolean) && (rollCount === 0 || !config.holdAllowed)));
  add('ROLLED_CONFLICT', lastRolled.some((position, index) => position >= config.diceCount || (index > 0 && position <= lastRolled[index - 1])));
  add('ROLLED_CONFLICT', (rollCount === 0) !== (lastRolled.length === 0));
  add('ROLLED_CONFLICT', rollCount === 1 && lastRolled.length !== config.diceCount);
  return [...issues];
}

/**
 * Loading and every returned state go through here: strict structure first (bounds before cross-comparison), then the invariants. A damaged
 * state is rejected as a whole (DICE_STATE_INVALID with code-only issues) — never repaired, clamped, re-rolled or restarted.
 */
export function parseDiceTurnState(raw: unknown): DiceTurnState {
  if (isPlain(raw)) { // cheap bound check on the arrays BEFORE the element-wise parse
    const big = (value: unknown) => Array.isArray(value) && value.length > DICE_MAX_COUNT;
    if (big(raw.values) || big(raw.held) || big(raw.lastRolled)) throw new DiceTurnError('DICE_STATE_INVALID', ['LIMIT_EXCEEDED']);
  }
  const parsed = DiceTurnStateSchema.safeParse(raw);
  if (!parsed.success) throw new DiceTurnError('DICE_STATE_INVALID', ['SHAPE_INVALID']);
  const issues = stateIssues(parsed.data);
  if (issues.length) throw new DiceTurnError('DICE_STATE_INVALID', issues);
  return parsed.data;
}

// ── Scope and binding to the N8 turn ─────────────────────────

export function diceTurnScopeOf(state: DiceTurnState): DiceScope {
  return { runIndex: state.runIndex, sequenceId: state.binding.sequenceId, rosterRevision: state.binding.rosterRevision, unit: state.binding.unit };
}
function readScope(raw: unknown): DiceScope {
  const scope = DiceScopeSchema.safeParse(raw);
  if (!scope.success) throw new DiceTurnError('DICE_ARGS_INVALID');
  return scope.data;
}
/** A malformed scope is an argument error; a well-formed scope of another run / sequence / roster revision / unit, or another dice process, is STALE. */
function assertDiceScope(state: DiceTurnState, scopeRaw: unknown, diceId: unknown): void {
  const scope = readScope(scopeRaw);
  args_(DiceRefSchema.safeParse(diceId).success);
  const own = diceTurnScopeOf(state);
  if (scope.runIndex !== own.runIndex || scope.sequenceId !== own.sequenceId || scope.rosterRevision !== own.rosterRevision || scope.unit !== own.unit || diceId !== state.diceId) throw new DiceTurnError('DICE_SCOPE_STALE');
}
/** The process must belong to the CURRENT N8 turn and to its holder. A later turn of the SAME player is another turn. */
function assertCurrentTurn(state: DiceTurnState, sequence: TurnSequenceState): void {
  const holder = currentTurnHolder(sequence);
  if (state.runIndex !== sequence.runIndex || state.binding.sequenceId !== sequence.sequenceId || state.binding.rosterRevision !== sequence.rosterRevision || state.binding.unit !== sequence.unit) throw new DiceTurnError('DICE_SCOPE_STALE');
  if (state.binding.turnNumber !== sequence.turnNumber || holder === null || holder.playerId !== state.binding.playerId || holder.teamId !== state.binding.teamId) throw new DiceTurnError('DICE_TURN_STALE');
}
function assertVersion(state: DiceTurnState, expected: unknown): void {
  // a malformed expectedVersion can never equal the stored counter: rejected with the same code (fail closed)
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected !== state.version) throw new DiceTurnError('DICE_VERSION_STALE');
}
function assertRollCount(state: DiceTurnState, expected: unknown): void {
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected !== state.rollCount) throw new DiceTurnError('DICE_ROLL_STALE');
}

// ── Opening ──────────────────────────────────────────────────

/**
 * Opens the dice process of the CURRENT N8 turn: `sequence` is the N8 state AFTER the transition that began the turn (phase ACTIVE), `expectedTurnNumber`
 * the turn the consumer means. Run, sequence, roster revision, unit, turn number and holder (player, and in team mode the team) are read from the
 * server-side N8 state, never from a request. Starts PREPARED: no values, nothing held, no roll. One process per N8 turn; a later turn (also of the same
 * player) needs a NEW process with a new `diceId`. The consumer opens it in the SAME commit as the N8 transition (and closes the previous one there).
 */
export function openDiceTurn(args: { scope: DiceScope; diceId: string; config: DiceConfig; sequence: unknown; expectedTurnNumber: number }): DiceTurnState {
  args_(isPlain(args) && keysWithin(args, ['scope', 'diceId', 'config', 'sequence', 'expectedTurnNumber']));
  const scope = readScope(args.scope);
  args_(DiceRefSchema.safeParse(args.diceId).success);
  const config = DiceConfigSchema.safeParse(args.config);
  if (!config.success) throw new DiceTurnError('DICE_CONFIG_INVALID');
  const sequence = parseTurnSequenceState(args.sequence);
  if (scope.runIndex !== sequence.runIndex || scope.sequenceId !== sequence.sequenceId || scope.rosterRevision !== sequence.rosterRevision || scope.unit !== sequence.unit) throw new DiceTurnError('DICE_SCOPE_STALE');
  if (typeof args.expectedTurnNumber !== 'number' || !Number.isSafeInteger(args.expectedTurnNumber) || args.expectedTurnNumber !== sequence.turnNumber) throw new DiceTurnError('DICE_TURN_STALE');
  const holder = currentTurnHolder(sequence);
  if (sequence.phase !== 'ACTIVE' || holder === null) throw new DiceTurnError('DICE_SEQUENCE_NOT_ACTIVE');
  return parseDiceTurnState({
    kind: 'DICE_TURN', schemaVersion: DICE_SCHEMA_VERSION, runIndex: sequence.runIndex, diceId: args.diceId,
    binding: { sequenceId: sequence.sequenceId, rosterRevision: sequence.rosterRevision, unit: sequence.unit, turnNumber: sequence.turnNumber, playerId: holder.playerId, teamId: holder.teamId },
    config: { ...config.data }, phase: 'PREPARED', version: 0, rollCount: 0, values: null, held: Array.from({ length: config.data.diceCount }, () => false), lastRolled: [],
  });
}

// ── Transitions ──────────────────────────────────────────────

export type DiceTransitionKind = 'ROLL' | 'HOLD' | 'CLOSE';
/**
 * The small SERVER-PRIVATE before/after record of one real change, so the later consumer can build its existing SDK state event and audit. For
 * a roll it carries the DECIDED result (positions and values) — the record from which `applyDecidedDiceRoll` reproduces the transition without any
 * random source. Never send it to a client as such.
 */
export interface DiceTransition {
  kind: DiceTransitionKind;
  versionBefore: number; versionAfter: number;
  rollCountBefore: number; rollCountAfter: number;
  phaseBefore: DicePhase; phaseAfter: DicePhase;
  rolled: { indices: number[]; values: number[] } | null;
  held: number[] | null;
}
export interface DiceChange { state: DiceTurnState; changed: boolean; transition: DiceTransition | null }
/** `sequenceBasisAdvanced`: the supplied N6 stand is NEWER than the committed N8 basis → the consumer MUST also persist `refreshEligibilityBasis` in the same commit (N8-02). */
export interface DiceActionResult extends DiceChange { sequenceBasisAdvanced: boolean }

const heldPositions = (state: DiceTurnState): number[] => state.held.flatMap((isHeld, index) => (isHeld ? [index] : []));
const unheldPositions = (state: DiceTurnState): number[] => state.held.flatMap((isHeld, index) => (isHeld ? [] : [index]));

function commit(before: DiceTurnState, kind: DiceTransitionKind, patch: Partial<DiceTurnState>, rolled: { indices: number[]; values: number[] } | null): DiceChange {
  const after = { ...before, ...patch, binding: { ...before.binding }, config: { ...before.config }, values: (patch.values ?? before.values)?.slice() ?? null, held: (patch.held ?? before.held).slice(), lastRolled: (patch.lastRolled ?? before.lastRolled).slice() };
  after.version = before.version + 1;
  const state = parseDiceTurnState(after); // validated once more: a transition can never produce an invalid state
  return {
    state, changed: true,
    transition: { kind, versionBefore: before.version, versionAfter: state.version, rollCountBefore: before.rollCount, rollCountAfter: state.rollCount, phaseBefore: before.phase, phaseAfter: state.phase, rolled, held: kind === 'HOLD' ? heldPositions(state) : null },
  };
}

/**
 * Applies an ALREADY DECIDED roll (server-private; replay and recovery use it, `rollDice` composes it after the random decision). It calls no random source and
 * no clock and mutates nothing. `indices` must be EXACTLY the currently not held positions (ascending), `values` one value per index within 1..sides. Version
 * and roll number are checked like every other change; a result that does not fit is DICE_RESULT_INVALID — nothing is clamped, redrawn or repaired.
 * Positions are identities: held dice keep their value exactly, equal values on different positions stay different dice.
 */
export function applyDecidedDiceRoll(rawState: unknown, args: { expectedVersion: number; expectedRollCount: number; indices: readonly number[]; values: readonly number[] }): DiceChange {
  const state = parseDiceTurnState(rawState);
  args_(isPlain(args) && keysWithin(args, ['expectedVersion', 'expectedRollCount', 'indices', 'values']));
  if (state.phase === 'CLOSED') throw new DiceTurnError('DICE_CLOSED');
  assertVersion(state, args.expectedVersion);
  assertRollCount(state, args.expectedRollCount);
  if (state.rollCount >= state.config.maxRolls) throw new DiceTurnError('DICE_ROLLS_EXHAUSTED');
  const expectedIndices = unheldPositions(state);
  if (!Array.isArray(args.indices) || !Array.isArray(args.values) || args.indices.length !== expectedIndices.length || args.values.length !== expectedIndices.length
    || args.indices.some((position, i) => position !== expectedIndices[i])
    || args.values.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > state.config.sides)) throw new DiceTurnError('DICE_RESULT_INVALID');
  if (expectedIndices.length === 0) throw new DiceTurnError('DICE_NOTHING_TO_ROLL');
  assertCapacity(state.version, 2);
  const next: number[] = state.values === null ? new Array<number>(state.config.diceCount).fill(0) : [...state.values];
  expectedIndices.forEach((position, i) => { next[position] = args.values[i]; });
  const rollCount = state.rollCount + 1;
  return commit(state, 'ROLL', { rollCount, phase: rollCount >= state.config.maxRolls ? 'EXHAUSTED' : 'IN_PROGRESS', values: next, lastRolled: [...expectedIndices] }, { indices: [...expectedIndices], values: [...args.values] });
}

/** Injectable random source: `(minInclusive, maxExclusive) => integer` — the signature of `node:crypto.randomInt`. Tests only; there is no wish-number API. */
export type DiceIntSource = (minInclusive: number, maxExclusive: number) => number;

export interface DiceActionArgs {
  /**
   * The TARGET the client prepared the action for (run, N8 sequence, roster revision, unit) and the dice process it saw — taken from the client's intent
   * (`diceActionArgsFromIntent`), NEVER from the state the consumer happens to load now. This function compares it with that state; filling it from the loaded
   * state would turn every comparison into a tautology and let a late intent of an old process roll a new one.
   */
  scope: DiceScope;
  diceId: string;
  /** the CURRENT N8 state (read only — a dice action never changes the sequence) */
  sequence: unknown;
  /** from the CLIENT's intent: what it saw. All four are compared with the loaded state; none is taken from it. */
  expectedTurnNumber: number; expectedSequenceVersion: number; expectedVersion: number; expectedRollCount: number;
  /** from the CURRENTLY admitted session and team assignment, never from a payload */
  caller: TurnActionCaller; gate: TurnActionGate; eligibility: TurnEligibility;
}
/**
 * The ONLY intended way to turn a validated client intent into the origin part of the action arguments: target (`scope`, `diceId`) and the four counters all come
 * from the intent. Spread its result into the arguments and add what comes from the SERVER (`sequence`, `caller`, `gate`, `eligibility`, and `held` from a hold
 * intent). It accepts an already parsed intent (`readDiceRollIntent` / `readDiceHoldIntent`); an intent without its origin has been refused there.
 */
export function diceActionArgsFromIntent(intent: DiceRollIntent | DiceHoldIntent): Pick<DiceActionArgs, 'scope' | 'diceId' | 'expectedTurnNumber' | 'expectedSequenceVersion' | 'expectedVersion' | 'expectedRollCount'> {
  const parsed = DiceActionBindingSchema.safeParse({ scope: intent?.scope, diceId: intent?.diceId, turnNumber: intent?.turnNumber, sequenceVersion: intent?.sequenceVersion, diceVersion: intent?.diceVersion, rollCount: intent?.rollCount });
  if (!parsed.success) throw new DiceTurnError('DICE_ARGS_INVALID');
  const b = parsed.data;
  return { scope: b.scope, diceId: b.diceId, expectedTurnNumber: b.turnNumber, expectedSequenceVersion: b.sequenceVersion, expectedVersion: b.diceVersion, expectedRollCount: b.rollCount };
}

/**
 * Counter capacity, checked BEFORE any random draw (a predictable refusal must not consume randomness). Every change of a process needs one local version step, and a
 * roll or a hold change must leave one more for the closing — a process whose counter is exhausted could otherwise never be closed. Nothing wraps, clamps or is
 * re-drawn: the process simply accepts no further roll/hold (`DICE_COUNTER_LIMIT`); the consumer ends it with its turn and opens a new process.
 */
function assertCapacity(version: number, steps: number): void {
  if (version + steps > DICE_MAX_COUNTER) throw new DiceTurnError('DICE_COUNTER_LIMIT');
}

const ACTION_KEYS = ['scope', 'diceId', 'sequence', 'expectedTurnNumber', 'expectedSequenceVersion', 'expectedVersion', 'expectedRollCount', 'caller', 'gate', 'eligibility'];

/** Shared prefix of roll and hold: the N8 turn check first, then the binding of the dice process to that turn. Nothing here draws. */
function authorizeAction(rawDice: unknown, args: DiceActionArgs, extraKeys: readonly string[], optionalKeys: readonly string[] = []): { dice: DiceTurnState; sequenceBasisAdvanced: boolean } {
  const dice = parseDiceTurnState(rawDice);
  args_(isPlain(args) && keysWithin(args as unknown as Record<string, unknown>, [...ACTION_KEYS, ...extraKeys], optionalKeys));
  const sequence = parseTurnSequenceState(args.sequence);
  authorizeTurnAction(sequence, { scope: args.scope, expectedVersion: args.expectedSequenceVersion, expectedTurnNumber: args.expectedTurnNumber, caller: args.caller, gate: args.gate, eligibility: args.eligibility });
  assertDiceScope(dice, args.scope, args.diceId);
  assertCurrentTurn(dice, sequence);
  if (dice.phase === 'CLOSED') throw new DiceTurnError('DICE_CLOSED');
  assertVersion(dice, args.expectedVersion);
  assertRollCount(dice, args.expectedRollCount);
  const sequenceBasisAdvanced = turnEligibilityAdvancesBasis(sequence, { scope: args.scope, eligibility: args.eligibility });
  // the consumer must persist that basis step (N8 `refreshEligibilityBasis`: sequence version +1): refuse BEFORE a draw if the sequence counter has no room for it
  if (sequenceBasisAdvanced && sequence.version + 1 > TURN_SEQUENCE_MAX_COUNTER) throw new DiceTurnError('DICE_COUNTER_LIMIT');
  return { dice, sequenceBasisAdvanced };
}

/**
 * The ONLY place that decides new dice values. Allowed in PREPARED and IN_PROGRESS for the holder of the CURRENT N8 turn. Order: dice state → shape → N8 turn
 * authorisation (state, scope, closed, sequence version, turn number, sequence phase, gate, role, holder, eligibility) → dice binding (scope, process id,
 * current turn and holder) → CLOSED → dice version → roll number → roll limit → "nothing to roll" → ONLY THEN the random source, once per not held position.
 * Every earlier rejection draws nothing. Held dice keep their value exactly; the roll number rises once; the decided result is returned in the transition.
 * All dice held → DICE_NOTHING_TO_ROLL, no draw, no consumed roll, no implicit rule, no scoring, no turn end. Equal old and new values are a valid result (no redraw).
 */
export function rollDice(rawDice: unknown, args: DiceActionArgs & { source?: DiceIntSource }): DiceActionResult {
  const { dice, sequenceBasisAdvanced } = authorizeAction(rawDice, args, [], ['source']);
  if (dice.rollCount >= dice.config.maxRolls) throw new DiceTurnError('DICE_ROLLS_EXHAUSTED');
  const indices = unheldPositions(dice);
  if (indices.length === 0) throw new DiceTurnError('DICE_NOTHING_TO_ROLL');
  assertCapacity(dice.version, 2); // before the random source: a refusal that is foreseeable here consumes nothing
  const source = args.source ?? randomInt;
  args_(typeof source === 'function');
  const values = indices.map(() => {
    const value = source(1, dice.config.sides + 1);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > dice.config.sides) throw new DiceTurnError('DICE_RANDOM_INVALID');
    return value;
  });
  return { ...applyDecidedDiceRoll(dice, { expectedVersion: dice.version, expectedRollCount: dice.rollCount, indices, values }), sequenceBasisAdvanced };
}

/**
 * Sets the hold assignment to an explicit TARGET: `held` lists the positions that are held afterwards (any order; unique integers inside 0..diceCount-1;
 * `[]` = release all). Never a toggle. Only in IN_PROGRESS of a profile with holding (PREPARED → DICE_NOT_ROLLED, EXHAUSTED → DICE_ROLLS_EXHAUSTED, profile without
 * holding → DICE_HOLD_DISABLED, CLOSED → DICE_CLOSED); invalid positions → DICE_HOLD_INVALID. Values and roll number never change. The same assignment again at
 * the CURRENT version is a valid no-op (`changed:false`, no version step); an older version or roll number stays stale (checked first). Every real change raises
 * the dice version, so a roll or hold prepared against the older hold assignment can never mix with the newer one.
 */
export function setDiceHeld(rawDice: unknown, args: DiceActionArgs & { held: readonly number[] }): DiceActionResult {
  const { dice, sequenceBasisAdvanced } = authorizeAction(rawDice, args, ['held']);
  if (!dice.config.holdAllowed) throw new DiceTurnError('DICE_HOLD_DISABLED');
  if (dice.rollCount === 0) throw new DiceTurnError('DICE_NOT_ROLLED');
  if (dice.rollCount >= dice.config.maxRolls) throw new DiceTurnError('DICE_ROLLS_EXHAUSTED');
  const target = args.held;
  if (!Array.isArray(target) || target.length > dice.config.diceCount || target.some(position => typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || position >= dice.config.diceCount) || new Set(target).size !== target.length) throw new DiceTurnError('DICE_HOLD_INVALID');
  const next = dice.held.map((_, index) => target.includes(index));
  if (next.every((isHeld, index) => isHeld === dice.held[index])) return { state: dice, changed: false, transition: null, sequenceBasisAdvanced };
  assertCapacity(dice.version, 2);
  return { ...commit(dice, 'HOLD', { held: next }, null), sequenceBasisAdvanced };
}

/**
 * Terminal close, decided by the SERVER-side consumer (the engine scored, the turn moved on, the sequence ended). It carries no points and does not touch the
 * N8 sequence. A closed process never reopens or resets; a new real turn gets a NEW process. Closing needs no N8 turn check (the turn may already have moved
 * on — the consumer closes it in the same commit that moves it), but it is bound to the process: scope, `diceId`, the turn number it belongs to and the dice
 * version. Closing an already closed process at its current version is `changed:false`; an older version is stale. Never reachable from a client intent.
 */
export function closeDiceTurn(rawDice: unknown, args: { scope: DiceScope; diceId: string; expectedTurnNumber: number; expectedVersion: number }): DiceChange {
  const dice = parseDiceTurnState(rawDice);
  args_(isPlain(args) && keysWithin(args, ['scope', 'diceId', 'expectedTurnNumber', 'expectedVersion']));
  assertDiceScope(dice, args.scope, args.diceId);
  if (typeof args.expectedTurnNumber !== 'number' || !Number.isSafeInteger(args.expectedTurnNumber) || args.expectedTurnNumber !== dice.binding.turnNumber) throw new DiceTurnError('DICE_TURN_STALE');
  assertVersion(dice, args.expectedVersion);
  if (dice.phase === 'CLOSED') return { state: dice, changed: false, transition: null };
  assertCapacity(dice.version, 1);
  return commit(dice, 'CLOSE', { phase: 'CLOSED' }, null);
}

// ── Client intents at the server boundary ────────────────────

/**
 * Parses a client intent strictly (unknown keys such as `values`, `seed` or `roll` are rejected). The ORIGIN is required: target (`scope`, `diceId`) and all four
 * counters; an intent without them is DICE_ARGS_INVALID, never completed from current state. Returns a fresh copy; failure is DICE_ARGS_INVALID.
 */
export function readDiceRollIntent(raw: unknown): DiceRollIntent {
  const parsed = DiceActionBindingSchema.safeParse(raw);
  if (!parsed.success) throw new DiceTurnError('DICE_ARGS_INVALID');
  return parsed.data;
}
export function readDiceHoldIntent(raw: unknown): DiceHoldIntent {
  const parsed = DiceHoldIntentSchema.safeParse(raw);
  if (!parsed.success) throw new DiceTurnError('DICE_ARGS_INVALID');
  return parsed.data;
}

// ── Projection ───────────────────────────────────────────────

const INFORMATION_ROLES = ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'];

/**
 * Projection for ONE caller through a small allowlist (no spread of the private state); re-checked against the strict client schema (`safeParse`, never a
 * ZodError). `audience` must come from the server's admission/session path: the information role is the CURRENT game role — a playing host or administrator
 * is projected as PLAYER; an unknown role or malformed id → DICE_AUDIENCE_INVALID. `sequence` is the CURRENT N8 state (same run / sequence / roster / unit, or
 * DICE_SCOPE_STALE): the action hints come from it.
 * - `release` is REQUIRED: NONE → binding and ordering counters only; VALUES → additionally configuration, phase, values, hold assignment, `lastRolled`, holder, `you`.
 * - `you` exists only for a PLAYER audience (own id via PLAYER_PRIVATE, own team via TEAM_PRIVATE). HOST / VIEWER / DISPLAY get none: seeing is not acting. `canRoll` /
 *   `canHold` additionally need that the N8 turn is still THIS turn and ACTIVE (a moved-on, HELD or closed sequence → false).
 * - `recipientId` (every release, also NONE) names the recipient the packet was made for; a UI accepts it only for exactly the recipient it expects.
 * - There is no seed, no random state and no precomputed future roll anywhere in the state, hence none in the projection.
 */
export function projectDiceTurn(audience: ProjectionAudience, rawDice: unknown, args: { scope: DiceScope; sequence: unknown; release: 'NONE' | 'VALUES'; stateVersion: number }): DiceProjection {
  const dice = parseDiceTurnState(rawDice);
  args_(isPlain(args) && keysWithin(args, ['scope', 'sequence', 'release', 'stateVersion']));
  assertDiceScope(dice, args.scope, dice.diceId);
  const sequence = parseTurnSequenceState(args.sequence);
  if (dice.runIndex !== sequence.runIndex || dice.binding.sequenceId !== sequence.sequenceId || dice.binding.rosterRevision !== sequence.rosterRevision || dice.binding.unit !== sequence.unit) throw new DiceTurnError('DICE_SCOPE_STALE');
  if (typeof args.release !== 'string' || !(DICE_RELEASES as readonly string[]).includes(args.release)) throw new DiceTurnError('DICE_RELEASE_INVALID');
  args_(DiceStateVersionSchema.safeParse(args.stateVersion).success);
  const bad = () => new DiceTurnError('DICE_AUDIENCE_INVALID');
  if (!isPlain(audience) || typeof audience.role !== 'string' || !INFORMATION_ROLES.includes(audience.role)) throw bad();
  for (const id of [audience.participantId, audience.teamId] as unknown[]) {
    if (id !== undefined && id !== null && !DiceActorIdSchema.safeParse(id).success) throw bad();
  }
  const recipientId = audience.role === 'PLAYER' && typeof audience.participantId === 'string' && audience.participantId !== '' ? audience.participantId : null;
  const base = {
    contract: DICE_CONTRACT, scope: diceTurnScopeOf(dice), diceId: dice.diceId, recipientId, stateVersion: args.stateVersion, sequenceVersion: sequence.version,
    turnNumber: dice.binding.turnNumber, diceVersion: dice.version, rollCount: dice.rollCount,
  };
  let projection: Record<string, unknown>;
  if (args.release === 'NONE') projection = { ...base, release: 'NONE' };
  else {
    let you: { holdsTurn: boolean; teamHoldsTurn: boolean | null; canRoll: boolean; canHold: boolean } | null = null;
    if (recipientId !== null) {
      const playerMatch = canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: dice.binding.playerId });
      const teamMatch = dice.binding.teamId !== null && canView(audience, { scope: 'TEAM_PRIVATE', ownerTeamId: dice.binding.teamId });
      const holdsTurn = dice.binding.unit === 'TEAM' ? playerMatch && teamMatch : playerMatch;
      const holder = currentTurnHolder(sequence);
      const live = sequence.phase === 'ACTIVE' && sequence.turnNumber === dice.binding.turnNumber && holder !== null && holder.playerId === dice.binding.playerId && holder.teamId === dice.binding.teamId;
      you = {
        holdsTurn, teamHoldsTurn: dice.binding.unit === 'TEAM' ? teamMatch : null,
        canRoll: holdsTurn && live && (dice.phase === 'PREPARED' || dice.phase === 'IN_PROGRESS') && dice.held.some(isHeld => !isHeld),
        canHold: holdsTurn && live && dice.phase === 'IN_PROGRESS' && dice.config.holdAllowed,
      };
    }
    projection = {
      ...base, release: 'VALUES', status: dice.phase, config: { ...dice.config }, values: dice.values === null ? null : [...dice.values], held: [...dice.held], lastRolled: [...dice.lastRolled],
      holder: { teamId: dice.binding.teamId, playerId: dice.binding.playerId }, you,
    };
  }
  const checked = DiceProjectionSchema.safeParse(projection);
  if (!checked.success) throw new DiceTurnError('DICE_PROJECTION_INVALID'); // never a ZodError: its message could echo values
  return checked.data;
}
