// ============================================================
// N11 — Board and figures (domain building block, SERVER-PRIVATE)
//
// A small, validated, serialisable board: explicit fields, one explicit route per owner (start ... home), figures with unique ids and an owner, and ONE
// deterministic transition — a figure moves along its owner's route by the steps of an already stored N9 dice roll, optionally capturing the figures that
// stand on the target (an ADAPTER decision, passed as an explicit policy), and reaching the home field. The move and the reset of captured figures are
// ONE state transition. It is a building block for a later "Raus damit!" engine (board-race). It is NOT an engine: no win or points logic, no turn end,
// no route, socket event, table or setup UI, and NO platform default for board size, number of figures, leaving the start, overshooting the home field,
// stacking (field capacity is explicit data), protected fields, forced capture, extra rolls or team rules.
//
// Boundary — what THIS module does: pure state transitions on already trusted input, the N8 turn authorisation of a move (`authorizeTurnAction`, first),
// the binding of a move to the N9 roll it uses, and the allowlist projection. What the later runtime ADAPTER must do (see docs/implementation/n11-board-foundation):
// authentication, admission, team assignment, pause and phase facts, the N6 eligibility, the persistence of board + (N8 basis step) in ONE compare-and-swap
// together with the state event and the command receipt, closing the turn, scoring, and everything about rules. Alone this module guarantees no exactly-once.
//
// The roll is SPENT by the move itself: the board state keeps the last move including the `diceId` + `rollCount` it used; the same roll can never move a
// second figure, a refused move spends nothing. No randomness, no clock anywhere here: a roll is read from the stored dice state, never drawn.
// ============================================================

import { z } from 'zod';
import {
  BOARD_CAPTURE_MODES, BOARD_ERROR_CODES, BOARD_CONTRACT, BOARD_MAX_COUNTER, BOARD_MAX_FIGURES, BOARD_MAX_FIELDS, BOARD_MAX_OWNERS, BOARD_MAX_ROUTE, BOARD_MAX_STEPS, BOARD_RELEASES, BOARD_SCHEMA_VERSION,
  BoardActorIdSchema, BoardCounterSchema, BoardFigureSchema, BoardGeometrySchema, BoardLastMoveSchema, BoardMoveIntentSchema, BoardProjectionSchema, BoardRefSchema, BoardRunIndexSchema,
  BoardScopeSchema, BoardStateVersionSchema, BoardUnitSchema, BoardError, boardCapturableFields, boardGeometryIssues,
  type BoardCaptureMode, type BoardGeometry, type BoardIssueCode, type BoardMoveIntent, type BoardProjection, type BoardScope, type BoardTarget,
} from '@quiz/shared/board';
import { parseDiceTurnState, type DiceTurnState } from './diceTurn.js';
import {
  authorizeTurnAction, currentTurnHolder, parseTurnSequenceState, turnEligibilityAdvancesBasis,
  type TurnActionCaller, type TurnActionGate, type TurnEligibility, type TurnSequenceState,
} from './turnSequence.js';
import { TURN_SEQUENCE_MAX_COUNTER } from '@quiz/shared/turnSequence';
import { canView, type ProjectionAudience } from './visibility.js';

export { BoardError, BOARD_ERROR_CODES };
export type { BoardProjection, BoardScope };

// ── Helpers ──────────────────────────────────────────────────

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
/** Exact key set: every required key present, no key outside required ∪ optional. */
const keysWithin = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
function args_(condition: boolean): asserts condition { if (!condition) throw new BoardError('BOARD_ARGS_INVALID'); }

// ── Adapter policy (explicit, NO default) ────────────────────

/** The adapter's explicit decisions. `capture` is REQUIRED: there is no platform default for capturing. */
export interface BoardPolicy { capture: BoardCaptureMode }
const PolicySchema = z.object({ capture: z.enum(BOARD_CAPTURE_MODES) }).strict();
function readPolicy(raw: unknown): BoardPolicy {
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) throw new BoardError('BOARD_POLICY_INVALID');
  return parsed.data;
}

// ── Server-private state ─────────────────────────────────────

const RollRefSchema = z.object({ diceId: BoardRefSchema, rollCount: BoardCounterSchema.min(1), turnNumber: BoardCounterSchema.min(1) }).strict();
const BindingSchema = z.object({ sequenceId: BoardRefSchema, rosterRevision: BoardRefSchema, unit: BoardUnitSchema }).strict();

export const BoardStateSchema = z.object({
  kind: z.literal('BOARD'),
  schemaVersion: z.literal(BOARD_SCHEMA_VERSION),
  runIndex: BoardRunIndexSchema,
  boardId: BoardRefSchema,
  binding: BindingSchema,
  geometry: BoardGeometrySchema,
  figures: z.array(BoardFigureSchema).min(1).max(BOARD_MAX_FIGURES),
  /** local version: +1 per applied move */
  version: BoardCounterSchema,
  lastMove: BoardLastMoveSchema.nullable(),
}).strict();
export type BoardState = z.infer<typeof BoardStateSchema>;

const routeOf = (state: BoardState, ownerId: string): readonly string[] | undefined => state.geometry.routes.find(route => route.ownerId === ownerId)?.route;

/** Cross-field invariants of a structurally valid state (bounds were checked first). Code-only issues. */
function stateIssues(state: BoardState): BoardIssueCode[] {
  const issues = new Set<BoardIssueCode>(boardGeometryIssues(state.geometry));
  const add = (code: BoardIssueCode, condition: boolean) => { if (condition) issues.add(code); };
  if (issues.size > 0) return [...issues]; // positions cannot be judged against a broken geometry
  const { figures, geometry, lastMove } = state;
  add('FIGURE_DUPLICATE', new Set(figures.map(figure => figure.id)).size !== figures.length);
  const capacity = new Map(geometry.fields.map(field => [field.id, field.capacity] as const));
  const load = new Map<string, number>();
  const perOwner = new Map<string, number>();
  for (const figure of figures) {
    const route = routeOf(state, figure.ownerId);
    if (route === undefined) { issues.add('FIGURE_OWNER_UNKNOWN'); continue; }
    add('FIGURE_POSITION_INVALID', !route.includes(figure.at));
    load.set(figure.at, (load.get(figure.at) ?? 0) + 1);
    perOwner.set(figure.ownerId, (perOwner.get(figure.ownerId) ?? 0) + 1);
  }
  for (const [id, count] of load) add('CAPACITY_EXCEEDED', count > (capacity.get(id) ?? 0));
  for (const { ownerId, route } of geometry.routes) {
    add('OWNER_WITHOUT_FIGURE', !perOwner.has(ownerId));
    // a captured figure always returns to the start of its owner: that start must hold ALL of the owner's figures
    add('START_CAPACITY', (perOwner.get(ownerId) ?? 0) > (capacity.get(route[0]) ?? 0));
  }
  add('COUNTER_CONFLICT', (lastMove === null) !== (state.version === 0));
  if (lastMove !== null) {
    const mover = figures.find(figure => figure.id === lastMove.figureId);
    const route = mover === undefined ? undefined : routeOf(state, mover.ownerId);
    // the last move is the newest change: its figure still stands on the target, the captured ones stand on their start
    add('LASTMOVE_CONFLICT', mover === undefined || route === undefined || mover.at !== lastMove.to || route.indexOf(lastMove.from) < 0 || route.indexOf(lastMove.to) <= route.indexOf(lastMove.from));
    for (const id of lastMove.captured) {
      const victim = figures.find(figure => figure.id === id);
      const victimRoute = victim === undefined ? undefined : routeOf(state, victim.ownerId);
      add('LASTMOVE_CONFLICT', victim === undefined || victimRoute === undefined || victim.at !== victimRoute[0] || (mover !== undefined && victim.ownerId === mover.ownerId));
    }
    add('LASTMOVE_CONFLICT', new Set(lastMove.captured).size !== lastMove.captured.length);
  }
  return [...issues];
}

/**
 * Loading and every returned state go through here: strict structure first (bounds before cross-comparison), then the invariants. A damaged state is
 * rejected as a whole (BOARD_STATE_INVALID with code-only issues) — never repaired, clamped, moved or restarted.
 */
export function parseBoardState(raw: unknown): BoardState {
  if (isPlain(raw)) { // cheap bound check on the arrays BEFORE the element-wise parse
    const big = (value: unknown, max: number) => Array.isArray(value) && value.length > max;
    const geometry = raw.geometry;
    if (big(raw.figures, BOARD_MAX_FIGURES) || (isPlain(geometry) && (big(geometry.fields, BOARD_MAX_FIELDS) || big(geometry.routes, BOARD_MAX_OWNERS)
      || (Array.isArray(geometry.routes) && geometry.routes.some(route => isPlain(route) && big(route.route, BOARD_MAX_ROUTE)))))) throw new BoardError('BOARD_STATE_INVALID', ['LIMIT_EXCEEDED']);
  }
  const parsed = BoardStateSchema.safeParse(raw);
  if (!parsed.success) throw new BoardError('BOARD_STATE_INVALID', ['SHAPE_INVALID']);
  const issues = stateIssues(parsed.data);
  if (issues.length) throw new BoardError('BOARD_STATE_INVALID', issues);
  return parsed.data;
}

export function boardScopeOf(state: BoardState): BoardScope {
  return { runIndex: state.runIndex, sequenceId: state.binding.sequenceId, rosterRevision: state.binding.rosterRevision, unit: state.binding.unit };
}
function readScope(raw: unknown): BoardScope {
  const scope = BoardScopeSchema.safeParse(raw);
  if (!scope.success) throw new BoardError('BOARD_ARGS_INVALID');
  return scope.data;
}
const sameScope = (a: BoardScope, b: BoardScope): boolean => a.runIndex === b.runIndex && a.sequenceId === b.sequenceId && a.rosterRevision === b.rosterRevision && a.unit === b.unit;
/** A malformed scope is an argument error; a well-formed scope of another run / sequence / roster revision / unit, or another board, is STALE. */
function assertBoardScope(state: BoardState, scopeRaw: unknown, boardId: unknown): void {
  const scope = readScope(scopeRaw);
  args_(BoardRefSchema.safeParse(boardId).success);
  if (!sameScope(scope, boardScopeOf(state)) || boardId !== state.boardId) throw new BoardError('BOARD_SCOPE_STALE');
}
function assertMatchesSequence(state: BoardState, sequence: TurnSequenceState): void {
  if (!sameScope(boardScopeOf(state), { runIndex: sequence.runIndex, sequenceId: sequence.sequenceId, rosterRevision: sequence.rosterRevision, unit: sequence.unit })) throw new BoardError('BOARD_SCOPE_STALE');
  // the owners ARE actors of this sequence (players in player mode, teams in team mode)
  if (state.geometry.routes.some(route => !sequence.order.includes(route.ownerId))) throw new BoardError('BOARD_SCOPE_STALE');
}
function assertVersion(state: BoardState, expected: unknown): void {
  // a malformed expectedVersion can never equal the stored counter: rejected with the same code (fail closed)
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected !== state.version) throw new BoardError('BOARD_VERSION_STALE');
}
/** The id of the owner (actor of the sequence) that currently holds the turn: the player (player mode) or the team (team mode). */
function holderOwnerId(sequence: TurnSequenceState): string | null {
  const holder = currentTurnHolder(sequence);
  if (holder === null) return null;
  return sequence.unit === 'TEAM' ? holder.teamId : holder.playerId;
}

// ── Preparation ──────────────────────────────────────────────

/**
 * Prepares a board for ONE N8 sequence: geometry, figures (id + owner; every figure starts on the START field of its owner) and the scope read from the
 * server-side N8 `sequence`. Owners must be actors of that sequence. Every route owner needs at least one figure and the start field must hold all of them.
 * Version 0, no last move. Invalid configuration → BOARD_CONFIG_INVALID (code-only issues); nothing is corrected.
 */
export function prepareBoard(args: { scope: BoardScope; boardId: string; geometry: BoardGeometry; figures: readonly { id: string; ownerId: string }[]; sequence: unknown }): BoardState {
  args_(isPlain(args) && keysWithin(args, ['scope', 'boardId', 'geometry', 'figures', 'sequence']));
  const scope = readScope(args.scope);
  args_(BoardRefSchema.safeParse(args.boardId).success);
  const sequence = parseTurnSequenceState(args.sequence);
  if (!sameScope(scope, { runIndex: sequence.runIndex, sequenceId: sequence.sequenceId, rosterRevision: sequence.rosterRevision, unit: sequence.unit })) throw new BoardError('BOARD_SCOPE_STALE');
  const geometry = BoardGeometrySchema.safeParse(args.geometry);
  if (!geometry.success) throw new BoardError('BOARD_CONFIG_INVALID', ['SHAPE_INVALID']);
  if (!Array.isArray(args.figures) || args.figures.length > BOARD_MAX_FIGURES || args.figures.some(figure => !isPlain(figure) || !keysWithin(figure, ['id', 'ownerId']))) throw new BoardError('BOARD_CONFIG_INVALID', ['SHAPE_INVALID']);
  const startOf = new Map(geometry.data.routes.map(route => [route.ownerId, route.route[0]] as const));
  const figures = args.figures.map(figure => ({ id: figure.id, ownerId: figure.ownerId, at: startOf.get(figure.ownerId) ?? '' }));
  if (figures.some(figure => figure.at === '')) throw new BoardError('BOARD_CONFIG_INVALID', ['FIGURE_OWNER_UNKNOWN']);
  if (geometry.data.routes.some(route => !sequence.order.includes(route.ownerId))) throw new BoardError('BOARD_CONFIG_INVALID', ['FIGURE_OWNER_UNKNOWN']);
  try {
    return parseBoardState({
      kind: 'BOARD', schemaVersion: BOARD_SCHEMA_VERSION, runIndex: scope.runIndex, boardId: args.boardId,
      binding: { sequenceId: scope.sequenceId, rosterRevision: scope.rosterRevision, unit: scope.unit },
      geometry: { fields: geometry.data.fields.map(field => ({ ...field })), routes: geometry.data.routes.map(route => ({ ownerId: route.ownerId, route: [...route.route] })) },
      figures, version: 0, lastMove: null,
    });
  } catch (error) {
    if (error instanceof BoardError && error.code === 'BOARD_STATE_INVALID') throw new BoardError('BOARD_CONFIG_INVALID', error.issues);
    throw error;
  }
}

// ── Legal moves (pure, deterministic) ────────────────────────

export interface BoardMove { figureId: string; from: string; to: string; captured: string[] }

/**
 * The legal moves of ONE owner for a given step count. A figure at route index i may move to route index i+steps iff that index exists (overshooting the
 * home field is simply NOT a move — no platform rule for it) and the target is either free (fewer figures than its capacity) or full of figures that all
 * belong to OTHER owners, the policy ALLOWS capture and the field is capturable (neither a start nor a home field): then those figures are captured and go
 * back to the start of their owner. A full field with an own figure, or a full field under FORBIDDEN capture, is not a target. Intermediate fields are
 * not examined (no blocking rule). A figure on its home field has no move. Order = figure order of the state.
 */
export function legalBoardMoves(rawState: unknown, args: { ownerId: string; steps: number; policy: BoardPolicy }): BoardMove[] {
  const state = parseBoardState(rawState);
  args_(isPlain(args) && keysWithin(args, ['ownerId', 'steps', 'policy']));
  args_(BoardActorIdSchema.safeParse(args.ownerId).success && typeof args.steps === 'number' && Number.isSafeInteger(args.steps) && args.steps >= 1 && args.steps <= BOARD_MAX_STEPS);
  return movesOf(state, args.ownerId, args.steps, readPolicy(args.policy));
}
function movesOf(state: BoardState, ownerId: string, steps: number, policy: BoardPolicy): BoardMove[] {
  const route = routeOf(state, ownerId);
  if (route === undefined) return [];
  const capacity = new Map(state.geometry.fields.map(field => [field.id, field.capacity] as const));
  const capturable = boardCapturableFields(state.geometry);
  const moves: BoardMove[] = [];
  for (const figure of state.figures) {
    if (figure.ownerId !== ownerId) continue;
    const index = route.indexOf(figure.at);
    const target = route[index + steps];
    if (index < 0 || target === undefined) continue;
    const occupants = state.figures.filter(other => other.at === target);
    if (occupants.length < (capacity.get(target) ?? 0)) { moves.push({ figureId: figure.id, from: figure.at, to: target, captured: [] }); continue; }
    if (policy.capture === 'ALLOWED' && capturable.has(target) && occupants.length > 0 && occupants.every(other => other.ownerId !== ownerId)) {
      moves.push({ figureId: figure.id, from: figure.at, to: target, captured: occupants.map(other => other.id) });
    }
  }
  return moves;
}

// ── The transition ───────────────────────────────────────────

export interface BoardTransition {
  versionBefore: number; versionAfter: number;
  figureId: string; from: string; to: string; captured: string[]; steps: number; diceId: string; rollCount: number; turnNumber: number;
}
export interface BoardChange { state: BoardState; changed: true; transition: BoardTransition }
/** `sequenceBasisAdvanced`: the supplied N6 stand is NEWER than the committed N8 basis → the consumer MUST also persist `refreshEligibilityBasis` in the same commit (N8-02). */
export interface BoardActionResult extends BoardChange { sequenceBasisAdvanced: boolean }

function assertCapacity(version: number): void {
  if (version + 1 > BOARD_MAX_COUNTER) throw new BoardError('BOARD_COUNTER_LIMIT');
}

/**
 * Applies an ALREADY DECIDED move (server-private; `moveFigure` composes it after every check, a replay could use it). It re-derives the legal move from the
 * state itself and requires the decided result to equal it EXACTLY: the figure belongs to `ownerId`, `to` is a legal target of that figure for `steps`, and
 * `captured` is exactly the set the rules give — otherwise BOARD_TARGET_ILLEGAL / BOARD_RESULT_INVALID, nothing is clamped or repaired. The roll named in `roll`
 * must not be the one the last move already spent (BOARD_ROLL_SPENT). The moved figure, the reset of the captured figures (to their owner's start), the
 * version step and the last move are ONE new state. No random source, no clock, no mutation of the input.
 */
export function applyDecidedBoardMove(rawState: unknown, args: {
  expectedVersion: number; ownerId: string; figureId: string; to: string; captured: readonly string[]; steps: number; policy: BoardPolicy; roll: { diceId: string; rollCount: number; turnNumber: number };
}): BoardChange {
  const state = parseBoardState(rawState);
  args_(isPlain(args) && keysWithin(args, ['expectedVersion', 'ownerId', 'figureId', 'to', 'captured', 'steps', 'policy', 'roll']));
  assertVersion(state, args.expectedVersion);
  const rollParsed = RollRefSchema.safeParse(args.roll);
  args_(rollParsed.success);
  const roll = rollParsed.data;
  args_(BoardActorIdSchema.safeParse(args.ownerId).success && BoardRefSchema.safeParse(args.figureId).success && BoardRefSchema.safeParse(args.to).success
    && typeof args.steps === 'number' && Number.isSafeInteger(args.steps) && args.steps >= 1 && args.steps <= BOARD_MAX_STEPS && Array.isArray(args.captured));
  const policy = readPolicy(args.policy);
  if (state.lastMove !== null && state.lastMove.diceId === roll.diceId && state.lastMove.rollCount === roll.rollCount) throw new BoardError('BOARD_ROLL_SPENT');
  const figure = state.figures.find(candidate => candidate.id === args.figureId);
  if (figure === undefined) throw new BoardError('BOARD_FIGURE_UNKNOWN');
  if (figure.ownerId !== args.ownerId) throw new BoardError('BOARD_FIGURE_NOT_OWNED');
  const move = movesOf(state, args.ownerId, args.steps, policy).find(candidate => candidate.figureId === figure.id && candidate.to === args.to);
  if (move === undefined) throw new BoardError('BOARD_TARGET_ILLEGAL');
  if (args.captured.length !== move.captured.length || args.captured.some((id, i) => id !== move.captured[i])) throw new BoardError('BOARD_RESULT_INVALID');
  assertCapacity(state.version);
  const startOf = (ownerId: string): string => (routeOf(state, ownerId) as readonly string[])[0];
  const figures = state.figures.map(other => {
    if (other.id === figure.id) return { ...other, at: move.to };
    if (move.captured.includes(other.id)) return { ...other, at: startOf(other.ownerId) };
    return { ...other };
  });
  const next = parseBoardState({
    ...state, binding: { ...state.binding },
    geometry: { fields: state.geometry.fields.map(field => ({ ...field })), routes: state.geometry.routes.map(route => ({ ownerId: route.ownerId, route: [...route.route] })) },
    figures, version: state.version + 1,
    lastMove: { figureId: figure.id, from: move.from, to: move.to, captured: [...move.captured], steps: args.steps, diceId: roll.diceId, rollCount: roll.rollCount, turnNumber: roll.turnNumber },
  }); // validated once more: a transition can never produce an invalid state
  return {
    state: next, changed: true,
    transition: { versionBefore: state.version, versionAfter: next.version, figureId: figure.id, from: move.from, to: move.to, captured: [...move.captured], steps: args.steps, diceId: roll.diceId, rollCount: roll.rollCount, turnNumber: roll.turnNumber },
  };
}

// ── Client intents at the server boundary ────────────────────

/** Parses a client intent strictly (unknown keys such as `steps`, `captured`, `resetTo` or `roll` are rejected). The ORIGIN is required; failure is BOARD_ARGS_INVALID. */
export function readBoardMoveIntent(raw: unknown): BoardMoveIntent {
  const parsed = BoardMoveIntentSchema.safeParse(raw);
  if (!parsed.success) throw new BoardError('BOARD_ARGS_INVALID');
  return parsed.data;
}

export interface BoardActionArgs {
  /** from the CLIENT's intent (`boardActionArgsFromIntent`), NEVER from the state the consumer happens to load now */
  scope: BoardScope; boardId: string; diceId: string;
  expectedTurnNumber: number; expectedSequenceVersion: number; expectedBoardVersion: number; expectedDiceVersion: number; expectedRollCount: number;
  figureId: string; to: string;
  /** the CURRENT N8 state and the CURRENT N9 dice state of the turn (read only here) */
  sequence: unknown; dice: unknown;
  /** from the CURRENTLY admitted session and team assignment, never from a payload */
  caller: TurnActionCaller; gate: TurnActionGate; eligibility: TurnEligibility;
  /** the adapter's explicit decision */
  policy: BoardPolicy;
}
/**
 * The ONLY intended way to turn a validated client intent into the origin part of the action arguments: target (`scope`, `boardId`, `diceId`), all counters and
 * the NAMED figure / wished target come from the intent. Spread its result and add what comes from the SERVER (`sequence`, `dice`, `caller`, `gate`,
 * `eligibility`, `policy`). Filling the origin from the loaded state would turn every comparison into a tautology and let a late intent of an old board move a new one.
 */
export function boardActionArgsFromIntent(intent: BoardMoveIntent): Pick<BoardActionArgs, 'scope' | 'boardId' | 'diceId' | 'expectedTurnNumber' | 'expectedSequenceVersion' | 'expectedBoardVersion' | 'expectedDiceVersion' | 'expectedRollCount' | 'figureId' | 'to'> {
  const parsed = BoardMoveIntentSchema.safeParse(intent);
  if (!parsed.success) throw new BoardError('BOARD_ARGS_INVALID');
  const b = parsed.data;
  return { scope: b.scope, boardId: b.boardId, diceId: b.diceId, expectedTurnNumber: b.turnNumber, expectedSequenceVersion: b.sequenceVersion, expectedBoardVersion: b.boardVersion, expectedDiceVersion: b.diceVersion, expectedRollCount: b.rollCount, figureId: b.figureId, to: b.to };
}
const ACTION_KEYS = ['scope', 'boardId', 'diceId', 'expectedTurnNumber', 'expectedSequenceVersion', 'expectedBoardVersion', 'expectedDiceVersion', 'expectedRollCount', 'figureId', 'to', 'sequence', 'dice', 'caller', 'gate', 'eligibility', 'policy'];

/** The roll a move would use, read from the STORED dice state: its steps are the sum of the dice values (one die = the face). Null when there is none. */
function usableRoll(dice: DiceTurnState, sequence: TurnSequenceState, board: BoardState): { steps: number } | null {
  if (!sameScope(boardScopeOf(board), { runIndex: dice.runIndex, sequenceId: dice.binding.sequenceId, rosterRevision: dice.binding.rosterRevision, unit: dice.binding.unit })) return null;
  const holder = currentTurnHolder(sequence);
  if (sequence.phase !== 'ACTIVE' || holder === null || dice.binding.turnNumber !== sequence.turnNumber || dice.binding.playerId !== holder.playerId || dice.binding.teamId !== holder.teamId) return null;
  if (dice.phase === 'CLOSED' || dice.rollCount < 1 || dice.values === null) return null;
  return { steps: dice.values.reduce((sum, value) => sum + value, 0) };
}

/**
 * Moves ONE figure with the stored roll of the CURRENT turn. Order: board state → shape → N8 turn authorisation (`authorizeTurnAction`: state, scope, closed,
 * sequence version, turn number, sequence phase, gate, role, holder, eligibility) → board binding (scope, board id, sequence match, board version) → dice
 * (scope, process id, current turn and holder, not closed, dice version, roll number, a roll exists) → the roll is not spent → figure exists → figure belongs to
 * the HOLDER's owner id → the wished target is among the server-derived legal targets → counter capacity → ONLY THEN `applyDecidedBoardMove` (which re-derives
 * and re-checks the target). Every earlier rejection changes nothing and spends no roll. The client names figure and target only; steps, capture and the reset
 * come from the stored dice and the board. The returned `sequenceBasisAdvanced` obliges the consumer to persist N8 `refreshEligibilityBasis` in the same commit.
 */
export function moveFigure(rawBoard: unknown, args: BoardActionArgs): BoardActionResult {
  const board = parseBoardState(rawBoard);
  args_(isPlain(args) && keysWithin(args as unknown as Record<string, unknown>, ACTION_KEYS));
  const sequence = parseTurnSequenceState(args.sequence);
  authorizeTurnAction(sequence, { scope: args.scope, expectedVersion: args.expectedSequenceVersion, expectedTurnNumber: args.expectedTurnNumber, caller: args.caller, gate: args.gate, eligibility: args.eligibility });
  assertBoardScope(board, args.scope, args.boardId);
  assertMatchesSequence(board, sequence);
  assertVersion(board, args.expectedBoardVersion);
  const policy = readPolicy(args.policy);
  const dice = parseDiceTurnState(args.dice);
  args_(BoardRefSchema.safeParse(args.diceId).success);
  if (!sameScope(boardScopeOf(board), { runIndex: dice.runIndex, sequenceId: dice.binding.sequenceId, rosterRevision: dice.binding.rosterRevision, unit: dice.binding.unit }) || dice.diceId !== args.diceId) throw new BoardError('BOARD_SCOPE_STALE');
  const holder = currentTurnHolder(sequence) as NonNullable<ReturnType<typeof currentTurnHolder>>; // authorizeTurnAction guarantees an ACTIVE turn with a holder
  if (dice.binding.turnNumber !== sequence.turnNumber || dice.binding.playerId !== holder.playerId || dice.binding.teamId !== holder.teamId) throw new BoardError('BOARD_TURN_STALE');
  if (dice.phase === 'CLOSED') throw new BoardError('BOARD_NO_ROLL');
  if (typeof args.expectedDiceVersion !== 'number' || args.expectedDiceVersion !== dice.version || typeof args.expectedRollCount !== 'number' || args.expectedRollCount !== dice.rollCount) throw new BoardError('BOARD_ROLL_STALE');
  const roll = usableRoll(dice, sequence, board);
  if (roll === null) throw new BoardError('BOARD_NO_ROLL');
  if (board.lastMove !== null && board.lastMove.diceId === dice.diceId && board.lastMove.rollCount === dice.rollCount) throw new BoardError('BOARD_ROLL_SPENT');
  args_(BoardRefSchema.safeParse(args.figureId).success && BoardRefSchema.safeParse(args.to).success);
  const figure = board.figures.find(candidate => candidate.id === args.figureId);
  if (figure === undefined) throw new BoardError('BOARD_FIGURE_UNKNOWN');
  const ownerId = holderOwnerId(sequence) as string;
  if (figure.ownerId !== ownerId) throw new BoardError('BOARD_FIGURE_NOT_OWNED');
  const move = movesOf(board, ownerId, roll.steps, policy).find(candidate => candidate.figureId === figure.id && candidate.to === args.to);
  if (move === undefined) throw new BoardError('BOARD_TARGET_ILLEGAL');
  assertCapacity(board.version);
  const sequenceBasisAdvanced = turnEligibilityAdvancesBasis(sequence, { scope: args.scope, eligibility: args.eligibility });
  // the consumer must persist that basis step (N8 `refreshEligibilityBasis`: sequence version +1): refuse BEFORE any change if the sequence counter has no room for it
  if (sequenceBasisAdvanced && sequence.version + 1 > TURN_SEQUENCE_MAX_COUNTER) throw new BoardError('BOARD_COUNTER_LIMIT');
  const change = applyDecidedBoardMove(board, {
    expectedVersion: board.version, ownerId, figureId: figure.id, to: move.to, captured: move.captured, steps: roll.steps, policy,
    roll: { diceId: dice.diceId, rollCount: dice.rollCount, turnNumber: sequence.turnNumber },
  });
  return { ...change, sequenceBasisAdvanced };
}

// ── Projection ───────────────────────────────────────────────

const INFORMATION_ROLES = ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'];

/**
 * Projection for ONE caller through a small allowlist (no spread of the private state); re-checked against the strict client schema (`safeParse`, never a
 * ZodError). `audience` must come from the server's admission/session path (a playing host is projected as PLAYER). `sequence` is the CURRENT N8 state (same
 * scope, or BOARD_SCOPE_STALE), `dice` the CURRENT dice state of this board's turn or null (a dice state of a moved-on turn simply yields no roll).
 * - `release` is REQUIRED: NONE → binding and ordering counters only; FIGURES → additionally geometry, figures, last move, holder, the roll of the current turn,
 *   `you` and the offered `targets`.
 * - `you` and `targets` exist only for a PLAYER audience that holds the current turn (own id via PLAYER_PRIVATE, own team via TEAM_PRIVATE). HOST / VIEWER /
 *   DISPLAY / non-holders get none: seeing is not acting. `canMove` additionally needs a live, unspent roll and at least one legal target.
 * - `recipientId` (every release) names the recipient the packet was made for; a UI accepts it only for exactly the recipient it expects.
 */
export function projectBoard(audience: ProjectionAudience, rawBoard: unknown, args: { scope: BoardScope; sequence: unknown; dice: unknown; policy: BoardPolicy; release: 'NONE' | 'FIGURES'; stateVersion: number }): BoardProjection {
  const board = parseBoardState(rawBoard);
  args_(isPlain(args) && keysWithin(args, ['scope', 'sequence', 'dice', 'policy', 'release', 'stateVersion']));
  assertBoardScope(board, args.scope, board.boardId);
  const sequence = parseTurnSequenceState(args.sequence);
  assertMatchesSequence(board, sequence);
  if (typeof args.release !== 'string' || !(BOARD_RELEASES as readonly string[]).includes(args.release)) throw new BoardError('BOARD_RELEASE_INVALID');
  args_(BoardStateVersionSchema.safeParse(args.stateVersion).success);
  const policy = readPolicy(args.policy);
  const dice = args.dice === null ? null : parseDiceTurnState(args.dice);
  const bad = () => new BoardError('BOARD_AUDIENCE_INVALID');
  if (!isPlain(audience) || typeof audience.role !== 'string' || !INFORMATION_ROLES.includes(audience.role)) throw bad();
  for (const id of [audience.participantId, audience.teamId] as unknown[]) {
    if (id !== undefined && id !== null && !BoardActorIdSchema.safeParse(id).success) throw bad();
  }
  const recipientId = audience.role === 'PLAYER' && typeof audience.participantId === 'string' && audience.participantId !== '' ? audience.participantId : null;
  const base = {
    contract: BOARD_CONTRACT, scope: boardScopeOf(board), boardId: board.boardId, recipientId, stateVersion: args.stateVersion, sequenceVersion: sequence.version,
    turnNumber: sequence.turnNumber, boardVersion: board.version,
  };
  let projection: Record<string, unknown>;
  if (args.release === 'NONE') projection = { ...base, release: 'NONE' };
  else {
    const holder = currentTurnHolder(sequence);
    const usable = dice === null ? null : usableRoll(dice, sequence, board);
    const spent = dice !== null && board.lastMove !== null && board.lastMove.diceId === dice.diceId && board.lastMove.rollCount === dice.rollCount;
    const roll = dice !== null && usable !== null ? { diceId: dice.diceId, diceVersion: dice.version, rollCount: dice.rollCount, steps: usable.steps, spent } : null;
    let you: { holdsTurn: boolean; teamHoldsTurn: boolean | null; canMove: boolean } | null = null;
    let targets: BoardTarget[] = [];
    if (recipientId !== null) {
      const playerMatch = holder !== null && canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: holder.playerId });
      const teamMatch = holder !== null && holder.teamId !== null && canView(audience, { scope: 'TEAM_PRIVATE', ownerTeamId: holder.teamId });
      const holdsTurn = sequence.unit === 'TEAM' ? playerMatch && teamMatch : playerMatch;
      if (holdsTurn && sequence.phase === 'ACTIVE' && roll !== null && !roll.spent) {
        targets = movesOf(board, holderOwnerId(sequence) as string, roll.steps, policy).map(move => ({ figureId: move.figureId, to: move.to, captures: [...move.captured] }));
      }
      you = { holdsTurn, teamHoldsTurn: sequence.unit === 'TEAM' ? teamMatch : null, canMove: targets.length > 0 };
    }
    projection = {
      ...base, release: 'FIGURES',
      geometry: { fields: board.geometry.fields.map(field => ({ ...field })), routes: board.geometry.routes.map(route => ({ ownerId: route.ownerId, route: [...route.route] })) },
      figures: board.figures.map(figure => ({ ...figure })), lastMove: board.lastMove === null ? null : { ...board.lastMove, captured: [...board.lastMove.captured] },
      holder: holder === null ? null : { teamId: holder.teamId, playerId: holder.playerId }, roll, you, targets,
    };
  }
  const checked = BoardProjectionSchema.safeParse(projection);
  if (!checked.success) throw new BoardError('BOARD_PROJECTION_INVALID'); // never a ZodError: its message could echo values
  return checked.data;
}
