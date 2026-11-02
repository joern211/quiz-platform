// ============================================================
// N9 — Dice turn contract: CLIENT-SAFE part only (technical foundation, no game rules)
//
// A small dice process bound to ONE concrete N8 turn: N dice with S sides, a bounded number of rolls, optional holding of dice
// between rolls. It decides nothing about points, combinations, winners or the end of a turn. Several layers are kept apart and never
// derived from each other:
//   - the LOCAL dice version (`diceVersion`, +1 per real change of this process: roll, hold change, close),
//   - the ROLL number (`rollCount`, +1 per roll only),
//   - the identity of the N8 TURN the process belongs to (`turnNumber`; a player id alone identifies no turn),
//   - the CURRENT local version of the N8 sequence (`sequenceVersion`; an N6 basis update raises it WITHOUT a new turn and without
//     touching the dice),
//   - the global game `stateVersion` of the caller's own snapshot channel.
//
// This file holds what may leave the server: the PROJECTION one caller receives, the configuration, the intents a client may send,
// bounds, code-only errors and the context binding helpers. The server-private state, the random decision and the transitions live in
// apps/server/src/games/core/diceTurn.ts and must never be imported by the browser. There is deliberately NO schema here that carries
// dice VALUES from a client: values are decided by the server only.
//
// Release policy (explicit, no default — chosen by the server per audience):
//   NONE    only the binding and the ordering counters (a withdrawal stays orderable against older knowledge).
//   VALUES  additionally the configuration, the phase, the current dice values (by position), the hold assignment, the positions of the
//           last roll, the holder and the caller's OWN hints (`you`). Seeing the dice is not the right to roll or hold.
// Seeds / random states do not exist in the platform and are never part of any projection. `you.canRoll`/`you.canHold` are DISPLAY AIDS;
// the server decides on its own with the current session, phase and eligibility.
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no parameter properties, and a self-contained file without
// relative imports (as turnSequence.ts / participation.ts).
// ============================================================

import { z } from 'zod';

export const DICE_SCHEMA_VERSION = 1 as const;
export const DICE_CONTRACT = 'DICE_TURN_STATUS_V1' as const;

/** Protection bounds, not game rules. Counters are small safe integers; bounds are checked BEFORE any cross-comparison. */
export const DICE_MAX_COUNT = 10;
export const DICE_MIN_SIDES = 2;
export const DICE_MAX_SIDES = 20;
export const DICE_MAX_ROLLS = 10;
export const DICE_MAX_ID_LENGTH = 200;
export const DICE_MAX_REF_LENGTH = 80;
export const DICE_MAX_COUNTER = 1_000_000_000;

export const DICE_PHASES = ['PREPARED', 'IN_PROGRESS', 'EXHAUSTED', 'CLOSED'] as const;
export const DICE_RELEASES = ['NONE', 'VALUES'] as const;
export const DICE_UNITS = ['PLAYER', 'TEAM'] as const;
export type DicePhase = typeof DICE_PHASES[number];
export type DiceRelease = typeof DICE_RELEASES[number];
export type DiceUnit = typeof DICE_UNITS[number];

/** Per-issue codes. They never carry a value, an id or a path — only the kind of violation. */
export const DICE_ISSUE_CODES = [
  'SHAPE_INVALID', 'LIMIT_EXCEEDED', 'CONFIG_CONFLICT', 'PHASE_CONFLICT', 'COUNTER_CONFLICT', 'VALUES_CONFLICT', 'HELD_CONFLICT', 'ROLLED_CONFLICT', 'BINDING_CONFLICT',
] as const;
export type DiceIssueCode = typeof DICE_ISSUE_CODES[number];

/**
 * Wire error codes (the message of the thrown error equals the code). They carry no value, order, roster, actor id or reason. Errors of the N8
 * turn check (`TURN_SEQ_*`) pass through unchanged: a dice action is first of all a turn action.
 */
export const DICE_ERROR_CODES = [
  'DICE_ARGS_INVALID', 'DICE_CONFIG_INVALID', 'DICE_STATE_INVALID',
  'DICE_SCOPE_STALE', 'DICE_TURN_STALE', 'DICE_VERSION_STALE', 'DICE_ROLL_STALE',
  'DICE_SEQUENCE_NOT_ACTIVE', 'DICE_CLOSED', 'DICE_NOT_ROLLED', 'DICE_ROLLS_EXHAUSTED', 'DICE_HOLD_DISABLED', 'DICE_HOLD_INVALID', 'DICE_NOTHING_TO_ROLL',
  'DICE_RANDOM_INVALID', 'DICE_RESULT_INVALID', 'DICE_COUNTER_LIMIT',
  'DICE_AUDIENCE_INVALID', 'DICE_RELEASE_INVALID', 'DICE_PROJECTION_INVALID',
] as const;
export type DiceErrorCode = typeof DICE_ERROR_CODES[number];

export class DiceTurnError extends Error {
  readonly code: DiceErrorCode;
  readonly issues: readonly DiceIssueCode[];
  constructor(code: DiceErrorCode, issues: readonly DiceIssueCode[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'DiceTurnError';
  }
}

// ── Field schemas (shared by the client projection and the server-private state) ─────────────

export const DiceActorIdSchema = z.string().min(1).max(DICE_MAX_ID_LENGTH);
/** Opaque server-side label (dice id, sequence id, roster revision). Must not encode values, an order or a hash of private data. */
export const DiceRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(DICE_MAX_REF_LENGTH);
export const DiceRunIndexSchema = z.number().int().safe().positive();
export const DiceUnitSchema = z.enum(DICE_UNITS);
export const DicePhaseSchema = z.enum(DICE_PHASES);
export const DiceCounterSchema = z.number().int().safe().min(0).max(DICE_MAX_COUNTER);
export const DiceStateVersionSchema = z.number().int().safe().nonnegative();
/** A die POSITION (0-based). A position is an identity: two dice with the same value stay two dice. */
export const DicePositionSchema = z.number().int().safe().min(0).max(DICE_MAX_COUNT - 1);

/** The effective configuration of ONE process. Stored unchanged in the state; `holdAllowed` needs at least two rolls (otherwise holding could never be used). */
export const DiceConfigSchema = z.object({
  diceCount: z.number().int().safe().min(1).max(DICE_MAX_COUNT),
  sides: z.number().int().safe().min(DICE_MIN_SIDES).max(DICE_MAX_SIDES),
  maxRolls: z.number().int().safe().min(1).max(DICE_MAX_ROLLS),
  holdAllowed: z.boolean(),
}).strict().refine(config => !config.holdAllowed || config.maxRolls >= 2, { message: 'HOLD_NEEDS_TWO_ROLLS' });
export type DiceConfig = z.infer<typeof DiceConfigSchema>;

/** 5 six-sided dice, at most 3 rolls, holding allowed (basis for a later Yacht engine; no scoring rule). */
export const DICE_CONFIG_FIVE_D6_HOLD: Readonly<DiceConfig> = Object.freeze({ diceCount: 5, sides: 6, maxRolls: 3, holdAllowed: true });
/** One six-sided die, one roll, holding disabled (simple profile for a later board-game consumer; no board rule). */
export const DICE_CONFIG_SINGLE_D6: Readonly<DiceConfig> = Object.freeze({ diceCount: 1, sides: 6, maxRolls: 1, holdAllowed: false });

/** The binding of a dice process to its N8 sequence: run, sequence, pinned roster revision and unit (= the N8 scope). */
export const DiceScopeSchema = z.object({
  runIndex: DiceRunIndexSchema,
  sequenceId: DiceRefSchema,
  rosterRevision: DiceRefSchema,
  unit: DiceUnitSchema,
}).strict();
export type DiceScope = z.infer<typeof DiceScopeSchema>;

// ── Client intents (no values, no seed — the server decides) ───────────────────────────────

/**
 * What a UI action must carry — the COMPLETE ORIGIN of the action, fixed when the intent is made from what the user was shown:
 *   - the TARGET: `scope` (run, N8 sequence, pinned roster revision, unit) and `diceId` (the process). The four counters below are only unique inside ONE such
 *     target (a new game or a new sequence starts again at turn 1, sequence version 1, dice version 0, roll 0); without the target a late, never-applied intent
 *     of an old process would be indistinguishable from a fresh one of the new process.
 *   - the COUNTERS: the concrete turn, the N8 sequence version and the dice version / roll number it was shown for.
 * Every field is REQUIRED (an intent without its origin is invalid, never completed from the server's current state). The server compares the target with the
 * trusted state it loads — it never inserts its own current target for a missing or different one. The target is NOT an authorisation: caller, admission and
 * rights still come only from the server session.
 */
export const DiceActionBindingSchema = z.object({
  scope: DiceScopeSchema,
  diceId: DiceRefSchema,
  turnNumber: DiceCounterSchema.min(1),
  sequenceVersion: DiceCounterSchema,
  diceVersion: DiceCounterSchema,
  rollCount: DiceCounterSchema,
}).strict();
export type DiceActionBinding = z.infer<typeof DiceActionBindingSchema>;
export const DiceRollIntentSchema = DiceActionBindingSchema;
export type DiceRollIntent = DiceActionBinding;
/** `held` is the COMPLETE target assignment (positions held afterwards). `[]` means "release all". Never a toggle. Same origin binding as a roll. */
export const DiceHoldIntentSchema = z.object({
  scope: DiceScopeSchema,
  diceId: DiceRefSchema,
  turnNumber: DiceCounterSchema.min(1),
  sequenceVersion: DiceCounterSchema,
  diceVersion: DiceCounterSchema,
  rollCount: DiceCounterSchema,
  held: z.array(DicePositionSchema).max(DICE_MAX_COUNT),
}).strict();
export type DiceHoldIntent = z.infer<typeof DiceHoldIntentSchema>;
/** Local send-lock key of one binding (target AND counters). Labels and numbers only. */
export function diceActionBindingKey(binding: DiceActionBinding): string {
  const { scope } = binding;
  return JSON.stringify(['DICE_BINDING', scope.runIndex, scope.sequenceId, scope.rosterRevision, scope.unit, binding.diceId, binding.turnNumber, binding.sequenceVersion, binding.diceVersion, binding.rollCount]);
}

// ── Client projection ────────────────────────────────────────

export const DiceHolderViewSchema = z.object({ teamId: DiceActorIdSchema.nullable(), playerId: DiceActorIdSchema }).strict();
/** The caller's OWN hints. Display aids, never a server permission. */
export const DiceYouViewSchema = z.object({
  holdsTurn: z.boolean(),
  /** team mode: does the caller's team hold the turn (the caller may only advise); null in player mode */
  teamHoldsTurn: z.boolean().nullable(),
  canRoll: z.boolean(),
  canHold: z.boolean(),
}).strict();
export type DiceYouView = z.infer<typeof DiceYouViewSchema>;

const baseShape = {
  contract: z.literal(DICE_CONTRACT),
  scope: DiceScopeSchema,
  /** opaque identity of THIS dice process (one per N8 turn) */
  diceId: DiceRefSchema,
  /**
   * WHO this projection was made for: the participant id of a PLAYER audience, null for every other audience. The recipient-specific part
   * (`you`) is only valid for exactly this recipient. A UI compares it with the recipient it expects from its OWN session; a packet made
   * for somebody else is no packet for this UI — at every release level, also NONE.
   */
  recipientId: DiceActorIdSchema.nullable(),
  /** version of the authoritative snapshot this projection belongs to (NOT a private counter) */
  stateVersion: DiceStateVersionSchema,
  /** the CURRENT local version of the N8 sequence (what an action must be bound to) */
  sequenceVersion: DiceCounterSchema,
  /** identity of the N8 turn this process belongs to */
  turnNumber: DiceCounterSchema.min(1),
  /** local dice version */
  diceVersion: DiceCounterSchema,
  /** number of rolls made so far */
  rollCount: DiceCounterSchema,
};
const valuesShape = {
  status: DicePhaseSchema,
  config: DiceConfigSchema,
  /** dice values BY POSITION; null before the first roll (never 0 or a placeholder) */
  values: z.array(z.number().int().safe().min(1).max(DICE_MAX_SIDES)).min(1).max(DICE_MAX_COUNT).nullable(),
  held: z.array(z.boolean()).min(1).max(DICE_MAX_COUNT),
  /** the positions drawn in the LAST roll (animation target only; never decides anything) */
  lastRolled: z.array(DicePositionSchema).max(DICE_MAX_COUNT),
  holder: DiceHolderViewSchema,
  you: DiceYouViewSchema.nullable(),
};

export const DiceProjectionSchema = z.discriminatedUnion('release', [
  z.object({ ...baseShape, release: z.literal('NONE') }).strict(),
  z.object({ ...baseShape, release: z.literal('VALUES'), ...valuesShape }).strict(),
]).superRefine((projection, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (projection.release === 'NONE') return;
  const { config, values, held, lastRolled, status, rollCount } = projection;
  if (rollCount > config.maxRolls) bad('ROLLCOUNT_LIMIT');
  if ((values === null) !== (rollCount === 0)) bad('VALUES_ROLLCOUNT_CONFLICT');
  if (values !== null && (values.length !== config.diceCount || values.some(value => value > config.sides))) bad('VALUES_CONFIG_CONFLICT');
  if (held.length !== config.diceCount) bad('HELD_LENGTH');
  if (!config.holdAllowed && held.some(Boolean)) bad('HELD_DISABLED');
  if (rollCount === 0 && held.some(Boolean)) bad('HELD_BEFORE_ROLL');
  if (lastRolled.some(position => position >= config.diceCount) || new Set(lastRolled).size !== lastRolled.length || lastRolled.some((position, index) => index > 0 && position < lastRolled[index - 1])) bad('LASTROLLED_INVALID');
  if ((rollCount === 0) !== (lastRolled.length === 0)) bad('LASTROLLED_ROLLCOUNT_CONFLICT');
  if (rollCount === 1 && lastRolled.length !== config.diceCount) bad('LASTROLLED_FIRST_ROLL');
  if (status === 'PREPARED' && rollCount !== 0) bad('STATUS_CONFLICT');
  if (status === 'IN_PROGRESS' && (rollCount < 1 || rollCount >= config.maxRolls)) bad('STATUS_CONFLICT');
  if (status === 'EXHAUSTED' && rollCount !== config.maxRolls) bad('STATUS_CONFLICT');
  if ((projection.holder.teamId !== null) !== (projection.scope.unit === 'TEAM')) bad('HOLDER_UNIT_CONFLICT');
  if (projection.you !== null) {
    if (projection.recipientId === null) bad('YOU_RECIPIENT_MISSING');
    if ((projection.you.teamHoldsTurn !== null) !== (projection.scope.unit === 'TEAM')) bad('YOU_UNIT_CONFLICT');
    if ((projection.you.canRoll || projection.you.canHold) && !projection.you.holdsTurn) bad('YOU_ACT_CONFLICT');
    if (projection.you.holdsTurn && projection.you.teamHoldsTurn === false) bad('YOU_HOLDS_CONFLICT');
    if (projection.you.canRoll && !(status === 'PREPARED' || status === 'IN_PROGRESS')) bad('YOU_CANROLL_CONFLICT');
    if (projection.you.canHold && !(status === 'IN_PROGRESS' && config.holdAllowed)) bad('YOU_CANHOLD_CONFLICT');
  }
});
export type DiceProjection = z.infer<typeof DiceProjectionSchema>;

export type DiceProjectionResult = { ok: true; projection: DiceProjection } | { ok: false; code: 'DICE_PROJECTION_INVALID' };
/** Failure carries a code only: no values, no zod paths. Returns a fresh copy. */
export function parseDiceProjection(raw: unknown): DiceProjectionResult {
  const parsed = DiceProjectionSchema.safeParse(raw);
  return parsed.success ? { ok: true, projection: parsed.data } : { ok: false, code: 'DICE_PROJECTION_INVALID' };
}

/**
 * What the UI's own authenticated context expects, INDEPENDENTLY of the projection that arrives: the N8 scope, who is looking (`recipientId`:
 * the caller's own participant id, or null for a viewer / display) and `minStateVersion`, the oldest authoritative snapshot version the
 * caller accepts (from its own snapshot channel — never copied out of the incoming projection). The context is the SEQUENCE, not one dice
 * process: a new turn brings a new process into the same context and the knowledge about older turns stays.
 */
export interface DiceExpectedContext extends DiceScope { recipientId: string | null; minStateVersion: number }

export function diceProjectionMatches(projection: DiceProjection, expected: DiceExpectedContext): boolean {
  return projection.scope.runIndex === expected.runIndex && projection.scope.sequenceId === expected.sequenceId
    && projection.scope.rosterRevision === expected.rosterRevision && projection.scope.unit === expected.unit
    && projection.recipientId === expected.recipientId
    && Number.isSafeInteger(expected.minStateVersion) && projection.stateVersion >= expected.minStateVersion;
}

/** Public UI context key: run, sequence, roster revision, unit and recipient. Labels only — never a value, a holder or a counter. */
export function diceContextKey(expected: DiceExpectedContext): string {
  return JSON.stringify(['DICE_TURN', expected.runIndex, expected.sequenceId, expected.rosterRevision, expected.unit, expected.recipientId]);
}
