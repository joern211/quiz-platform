// ============================================================
// N11 — Board and figure contract: CLIENT-SAFE part only (technical foundation, NO game rules)
//
// A small board with explicit fields, one explicit route per owner (start field ... home field) and figures that stand on fields. A figure moves along
// ITS OWNER'S route by the steps of an already stored dice roll (N9). The contract decides nothing about board size, number of figures, how a figure
// leaves the start, what happens on overshooting the home field, stacking, protected fields, forced capture, extra rolls, teams, winners or points:
// geometry and the few adapter decisions (capture allowed or not) are EXPLICIT data, never platform defaults. A route is just data.
//
// Ordering layers, kept apart and never derived from each other:
//   - `boardVersion`   local version of the board state (+1 per real move),
//   - `turnNumber`     identity of the N8 turn (a player id alone identifies no turn),
//   - `sequenceVersion` CURRENT local version of the N8 sequence,
//   - the ROLL the move is made with: `diceId` + `diceVersion` + `rollCount` of the N9 process,
//   - the global game `stateVersion` of the caller's own snapshot channel.
//
// This file holds what may leave the server: the projection one caller receives, the geometry rules (pure, shared by server and client validation), the
// intent a client may send (figure + wished target + the COMPLETE origin it was shown), bounds and code-only errors. The server-private state and the
// transitions live in apps/server/src/games/core/boardState.ts. There is deliberately NO schema that carries a dice value, a step count, a capture
// result or a reset position from a client: they come from trusted state and server-side checks only.
//
// Release policy (explicit, no default — chosen by the server per audience):
//   NONE     only the binding and the ordering counters.
//   FIGURES  additionally geometry, figures with their positions, the last move, the roll shown for this turn, the holder, the caller's OWN hints
//            (`you`) and the targets the server currently OFFERS this caller. Seeing the board is not the right to move.
// `you.canMove` and `targets` are DISPLAY AIDS; the server decides on its own with the current session, phase, eligibility and roll.
//
// Strip-only TypeScript: loaded by plain Node in dist/app.js — no enums, no parameter properties, and a self-contained file without relative imports.
// ============================================================

import { z } from 'zod';

export const BOARD_SCHEMA_VERSION = 1 as const;
export const BOARD_CONTRACT = 'BOARD_STATUS_V1' as const;

/** Protection bounds, not game rules. */
export const BOARD_MAX_FIELDS = 80;
export const BOARD_MAX_OWNERS = 12;
export const BOARD_MAX_ROUTE = 80;
export const BOARD_MAX_CAPACITY = 8;
export const BOARD_MAX_FIGURES = 24;
export const BOARD_MAX_ID_LENGTH = 200;
export const BOARD_MAX_REF_LENGTH = 80;
export const BOARD_MAX_COUNTER = 1_000_000_000;
export const BOARD_MAX_STEPS = 200;

export const BOARD_UNITS = ['PLAYER', 'TEAM'] as const;
export const BOARD_RELEASES = ['NONE', 'FIGURES'] as const;
export const BOARD_CAPTURE_MODES = ['ALLOWED', 'FORBIDDEN'] as const;
export type BoardUnit = typeof BOARD_UNITS[number];
export type BoardRelease = typeof BOARD_RELEASES[number];
export type BoardCaptureMode = typeof BOARD_CAPTURE_MODES[number];

/** Per-issue codes. They never carry a value, an id or a path — only the kind of violation. */
export const BOARD_ISSUE_CODES = [
  'SHAPE_INVALID', 'LIMIT_EXCEEDED', 'FIELD_DUPLICATE', 'FIELD_UNUSED', 'ROUTE_OWNER_DUPLICATE', 'ROUTE_FIELD_UNKNOWN', 'ROUTE_FIELD_DUPLICATE', 'START_SHARED',
  'ROUTE_START_CONFLICT', 'ROUTE_HOME_CONFLICT', 'FIGURE_DUPLICATE', 'FIGURE_OWNER_UNKNOWN', 'OWNER_WITHOUT_FIGURE', 'FIGURE_POSITION_INVALID', 'CAPACITY_EXCEEDED',
  'START_CAPACITY', 'COUNTER_CONFLICT', 'LASTMOVE_CONFLICT', 'BINDING_CONFLICT',
] as const;
export type BoardIssueCode = typeof BOARD_ISSUE_CODES[number];

/**
 * Wire error codes (the message of the thrown error equals the code). They carry no figure, field, step count, roster or reason. Errors of the N8 turn
 * check (`TURN_SEQ_*`) pass through unchanged: a move is first of all a turn action.
 */
export const BOARD_ERROR_CODES = [
  'BOARD_ARGS_INVALID', 'BOARD_CONFIG_INVALID', 'BOARD_STATE_INVALID', 'BOARD_POLICY_INVALID',
  'BOARD_SCOPE_STALE', 'BOARD_TURN_STALE', 'BOARD_VERSION_STALE', 'BOARD_ROLL_STALE',
  'BOARD_SEQUENCE_NOT_ACTIVE', 'BOARD_NO_ROLL', 'BOARD_ROLL_SPENT', 'BOARD_FIGURE_UNKNOWN', 'BOARD_FIGURE_NOT_OWNED', 'BOARD_TARGET_ILLEGAL', 'BOARD_RESULT_INVALID',
  'BOARD_COUNTER_LIMIT', 'BOARD_AUDIENCE_INVALID', 'BOARD_RELEASE_INVALID', 'BOARD_PROJECTION_INVALID',
] as const;
export type BoardErrorCode = typeof BOARD_ERROR_CODES[number];

export class BoardError extends Error {
  readonly code: BoardErrorCode;
  readonly issues: readonly BoardIssueCode[];
  constructor(code: BoardErrorCode, issues: readonly BoardIssueCode[] = []) {
    super(code);
    this.code = code;
    this.issues = issues;
    this.name = 'BoardError';
  }
}

// ── Field schemas (shared by the client projection and the server-private state) ─────────────

export const BoardActorIdSchema = z.string().min(1).max(BOARD_MAX_ID_LENGTH);
/** Opaque label (board id, field id, figure id, sequence id, roster revision, dice id). Must not encode values, an order or a hash of private data. */
export const BoardRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).max(BOARD_MAX_REF_LENGTH);
export const BoardRunIndexSchema = z.number().int().safe().positive();
export const BoardUnitSchema = z.enum(BOARD_UNITS);
export const BoardCounterSchema = z.number().int().safe().min(0).max(BOARD_MAX_COUNTER);
export const BoardStateVersionSchema = z.number().int().safe().nonnegative();

/** The binding of a board to its N8 sequence: run, sequence, pinned roster revision and unit (= the N8 scope). */
export const BoardScopeSchema = z.object({
  runIndex: BoardRunIndexSchema,
  sequenceId: BoardRefSchema,
  rosterRevision: BoardRefSchema,
  unit: BoardUnitSchema,
}).strict();
export type BoardScope = z.infer<typeof BoardScopeSchema>;

// ── Geometry (explicit data; validated, never defaulted) ──────────────────────────────

export const BoardFieldSchema = z.object({ id: BoardRefSchema, capacity: z.number().int().safe().min(1).max(BOARD_MAX_CAPACITY) }).strict();
/** `route[0]` is the owner's START field, the last entry its HOME field; a figure moves forward along it only. */
export const BoardRouteSchema = z.object({ ownerId: BoardActorIdSchema, route: z.array(BoardRefSchema).min(2).max(BOARD_MAX_ROUTE) }).strict();
export const BoardGeometrySchema = z.object({
  fields: z.array(BoardFieldSchema).min(2).max(BOARD_MAX_FIELDS),
  routes: z.array(BoardRouteSchema).min(1).max(BOARD_MAX_OWNERS),
}).strict();
export type BoardField = z.infer<typeof BoardFieldSchema>;
export type BoardRoute = z.infer<typeof BoardRouteSchema>;
export type BoardGeometry = z.infer<typeof BoardGeometrySchema>;

/**
 * Cross-field rules of a structurally valid geometry (code-only issues, [] = valid). Pure and shared: the server validates its state with it, the client
 * re-validates every projection. Rules: unique field ids; unique owners; every route entry is a known field, unique inside the route; every field is used by
 * at least one route; a START field belongs to exactly one owner and appears in no other route and not again in its own; a HOME field is the end of exactly
 * one route and appears in no other route; START and HOME of one owner are different fields (guaranteed by uniqueness inside the route).
 */
export function boardGeometryIssues(geometry: BoardGeometry): BoardIssueCode[] {
  const issues = new Set<BoardIssueCode>();
  const ids = geometry.fields.map(field => field.id);
  const known = new Set(ids);
  if (known.size !== ids.length) issues.add('FIELD_DUPLICATE');
  if (new Set(geometry.routes.map(route => route.ownerId)).size !== geometry.routes.length) issues.add('ROUTE_OWNER_DUPLICATE');
  const used = new Set<string>();
  for (const { route } of geometry.routes) {
    if (new Set(route).size !== route.length) issues.add('ROUTE_FIELD_DUPLICATE');
    for (const id of route) { if (!known.has(id)) issues.add('ROUTE_FIELD_UNKNOWN'); used.add(id); }
  }
  if (ids.some(id => !used.has(id))) issues.add('FIELD_UNUSED');
  const starts = geometry.routes.map(route => route.route[0]);
  const homes = geometry.routes.map(route => route.route[route.route.length - 1]);
  if (new Set(starts).size !== starts.length) issues.add('START_SHARED');
  geometry.routes.forEach((own, index) => {
    const start = own.route[0], home = own.route[own.route.length - 1];
    geometry.routes.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      if (other.route.includes(start)) issues.add('ROUTE_START_CONFLICT');
      if (other.route.includes(home)) issues.add('ROUTE_HOME_CONFLICT');
    });
    if (own.route.indexOf(start) !== 0 || own.route.lastIndexOf(start) !== 0) issues.add('ROUTE_START_CONFLICT');
    if (homes.filter(candidate => candidate === home).length > 1) issues.add('ROUTE_HOME_CONFLICT');
  });
  return [...issues];
}

/** A field on which capture may happen at all: neither the START nor the HOME field of any owner (those are never captured on). */
export function boardCapturableFields(geometry: BoardGeometry): Set<string> {
  const protectedIds = new Set<string>();
  for (const { route } of geometry.routes) { protectedIds.add(route[0]); protectedIds.add(route[route.length - 1]); }
  return new Set(geometry.fields.map(field => field.id).filter(id => !protectedIds.has(id)));
}

// ── Figures and the last move (shared shapes) ─────────────────────────────────────────

export const BoardFigureSchema = z.object({ id: BoardRefSchema, ownerId: BoardActorIdSchema, at: BoardRefSchema }).strict();
export type BoardFigure = z.infer<typeof BoardFigureSchema>;

/** The last applied move. `diceId` + `rollCount` name the roll it SPENT: the same roll can never move a second figure. */
export const BoardLastMoveSchema = z.object({
  figureId: BoardRefSchema, from: BoardRefSchema, to: BoardRefSchema, captured: z.array(BoardRefSchema).max(BOARD_MAX_CAPACITY),
  steps: z.number().int().safe().min(1).max(BOARD_MAX_STEPS), diceId: BoardRefSchema, rollCount: BoardCounterSchema.min(1), turnNumber: BoardCounterSchema.min(1),
}).strict();
export type BoardLastMove = z.infer<typeof BoardLastMoveSchema>;

/**
 * Everything about the LAST move that the board alone can decide (code-only issues, [] = consistent; precondition: the geometry is valid). The last move is the newest change, so:
 * its figure stands on the target; `to` lies strictly FORWARD of `from` on the mover's route and `steps` equals exactly that route distance; a capture happens only on a FULL field (captured figures = the field's capacity), every captured figure belongs to ANOTHER owner, could have
 * stood on that field (it lies on the victim's own route — which is also why a start or home field, exclusive to ONE owner by the geometry rules, can never be a capture field; no separate
 * check for it can be told apart from this one) and now stands on its owner's start. Shared by the server (loading) and the client (projection).
 */
export function boardLastMoveIssues(geometry: BoardGeometry, figures: readonly BoardFigure[], lastMove: BoardLastMove): BoardIssueCode[] {
  const conflict: BoardIssueCode[] = ['LASTMOVE_CONFLICT'];
  const routeOf = (ownerId: string): readonly string[] | undefined => geometry.routes.find(route => route.ownerId === ownerId)?.route;
  const mover = figures.find(figure => figure.id === lastMove.figureId);
  const route = mover === undefined ? undefined : routeOf(mover.ownerId);
  if (mover === undefined || route === undefined || mover.at !== lastMove.to) return conflict;
  const from = route.indexOf(lastMove.from), to = route.indexOf(lastMove.to);
  if (from < 0 || to <= from || lastMove.steps !== to - from) return conflict;
  if (new Set(lastMove.captured).size !== lastMove.captured.length) return conflict;
  if (lastMove.captured.length === 0) return [];
  if (geometry.fields.find(field => field.id === lastMove.to)?.capacity !== lastMove.captured.length) return conflict;
  for (const id of lastMove.captured) {
    const victim = figures.find(figure => figure.id === id);
    const victimRoute = victim === undefined ? undefined : routeOf(victim.ownerId);
    if (victim === undefined || victimRoute === undefined || victim.ownerId === mover.ownerId || victim.at !== victimRoute[0] || !victimRoute.includes(lastMove.to)) return conflict;
  }
  return [];
}

// ── Client intent (figure + wished target + the COMPLETE origin; no step count, no capture, no reset) ───────────

/**
 * The COMPLETE ORIGIN of a move, fixed when the intent is made from what the user was shown:
 *   - the TARGET: `scope` (run, N8 sequence, pinned roster revision, unit) and `boardId`, plus the roll's process `diceId`. The counters below are only unique
 *     inside ONE such target (a new game or a new sequence starts again at turn 1, version 0, roll 1); without it a late, never-applied intent of an old board
 *     would be indistinguishable from a fresh one.
 *   - the COUNTERS: the turn, the N8 sequence version, the board version and the dice version / roll number it was shown for.
 * Every field is REQUIRED. The server compares it with the trusted state it loads and never completes it. The target is NOT an authorisation.
 */
export const BoardActionBindingSchema = z.object({
  scope: BoardScopeSchema,
  boardId: BoardRefSchema,
  turnNumber: BoardCounterSchema.min(1),
  sequenceVersion: BoardCounterSchema,
  boardVersion: BoardCounterSchema,
  diceId: BoardRefSchema,
  diceVersion: BoardCounterSchema,
  rollCount: BoardCounterSchema.min(1),
}).strict();
export type BoardActionBinding = z.infer<typeof BoardActionBindingSchema>;
/** The client NAMES figure and wished target; whether that move is legal, how many steps it takes and what it hits is decided by the server only. */
export const BoardMoveIntentSchema = BoardActionBindingSchema.extend({ figureId: BoardRefSchema, to: BoardRefSchema }).strict();
export type BoardMoveIntent = z.infer<typeof BoardMoveIntentSchema>;
/** Local send-lock key of one binding (target AND counters, NOT figure or target field: two alternative targets of one binding share ONE lock). */
export function boardActionBindingKey(binding: BoardActionBinding): string {
  const { scope } = binding;
  return JSON.stringify(['BOARD_BINDING', scope.runIndex, scope.sequenceId, scope.rosterRevision, scope.unit, binding.boardId, binding.turnNumber, binding.sequenceVersion, binding.boardVersion, binding.diceId, binding.diceVersion, binding.rollCount]);
}

// ── Client projection ────────────────────────────────────────

export const BoardHolderViewSchema = z.object({ teamId: BoardActorIdSchema.nullable(), playerId: BoardActorIdSchema }).strict();
/** The caller's OWN hints. Display aids, never a server permission. */
export const BoardYouViewSchema = z.object({
  holdsTurn: z.boolean(),
  /** team mode: does the caller's team hold the turn (the caller may only advise); null in player mode */
  teamHoldsTurn: z.boolean().nullable(),
  canMove: z.boolean(),
}).strict();
export type BoardYouView = z.infer<typeof BoardYouViewSchema>;
/** The roll of the CURRENT turn as the board sees it: what a move would be bound to. `steps` is the server-derived step count, `spent` whether a move already used it. */
export const BoardRollViewSchema = z.object({
  diceId: BoardRefSchema, diceVersion: BoardCounterSchema, rollCount: BoardCounterSchema.min(1), steps: z.number().int().safe().min(1).max(BOARD_MAX_STEPS), spent: z.boolean(),
}).strict();
export type BoardRollView = z.infer<typeof BoardRollViewSchema>;
/** A target the server currently OFFERS this caller: the figure, the field, and the figures a move there would send back to their start. */
export const BoardTargetSchema = z.object({ figureId: BoardRefSchema, to: BoardRefSchema, captures: z.array(BoardRefSchema).max(BOARD_MAX_CAPACITY) }).strict();
export type BoardTarget = z.infer<typeof BoardTargetSchema>;

const baseShape = {
  contract: z.literal(BOARD_CONTRACT),
  scope: BoardScopeSchema,
  boardId: BoardRefSchema,
  /** WHO this projection was made for: the participant id of a PLAYER audience, null for every other audience (at every release level). */
  recipientId: BoardActorIdSchema.nullable(),
  /** version of the authoritative snapshot this projection belongs to (NOT a private counter) */
  stateVersion: BoardStateVersionSchema,
  /** the CURRENT local version of the N8 sequence (what a move must be bound to) */
  sequenceVersion: BoardCounterSchema,
  /** identity of the CURRENT N8 turn */
  turnNumber: BoardCounterSchema,
  /** local board version */
  boardVersion: BoardCounterSchema,
};
const figuresShape = {
  geometry: BoardGeometrySchema,
  figures: z.array(BoardFigureSchema).min(1).max(BOARD_MAX_FIGURES),
  lastMove: BoardLastMoveSchema.nullable(),
  holder: BoardHolderViewSchema.nullable(),
  roll: BoardRollViewSchema.nullable(),
  you: BoardYouViewSchema.nullable(),
  targets: z.array(BoardTargetSchema).max(BOARD_MAX_FIGURES * BOARD_MAX_FIELDS),
};

export const BoardProjectionSchema = z.discriminatedUnion('release', [
  z.object({ ...baseShape, release: z.literal('NONE') }).strict(),
  z.object({ ...baseShape, release: z.literal('FIGURES'), ...figuresShape }).strict(),
]).superRefine((projection, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (projection.release === 'NONE') return;
  const { geometry, figures, lastMove, holder, roll, you, targets, scope } = projection;
  if (boardGeometryIssues(geometry).length > 0) { bad('GEOMETRY_INVALID'); return; }
  const fieldIds = new Set(geometry.fields.map(field => field.id));
  const capacity = new Map(geometry.fields.map(field => [field.id, field.capacity] as const));
  const routes = new Map(geometry.routes.map(route => [route.ownerId, route.route] as const));
  if (new Set(figures.map(figure => figure.id)).size !== figures.length) bad('FIGURE_DUPLICATE');
  const load = new Map<string, number>();
  for (const figure of figures) {
    const route = routes.get(figure.ownerId);
    if (route === undefined || !route.includes(figure.at)) bad('FIGURE_POSITION_INVALID');
    load.set(figure.at, (load.get(figure.at) ?? 0) + 1);
  }
  for (const [id, count] of load) if (count > (capacity.get(id) ?? 0)) bad('CAPACITY_EXCEEDED');
  if (lastMove !== null && (!fieldIds.has(lastMove.from) || !fieldIds.has(lastMove.to) || boardLastMoveIssues(geometry, figures, lastMove).length > 0)) bad('LASTMOVE_INVALID');
  if (holder !== null && (holder.teamId !== null) !== (scope.unit === 'TEAM')) bad('HOLDER_UNIT_CONFLICT');
  if (roll !== null && holder === null) bad('ROLL_WITHOUT_HOLDER');
  if (you !== null) {
    if (projection.recipientId === null) bad('YOU_RECIPIENT_MISSING');
    if ((you.teamHoldsTurn !== null) !== (scope.unit === 'TEAM')) bad('YOU_UNIT_CONFLICT');
    if (you.canMove && !you.holdsTurn) bad('YOU_ACT_CONFLICT');
    if (you.holdsTurn && you.teamHoldsTurn === false) bad('YOU_HOLDS_CONFLICT');
    if (you.canMove && (roll === null || roll.spent || targets.length === 0)) bad('YOU_CANMOVE_CONFLICT');
  }
  if (targets.length > 0 && (you === null || !you.canMove)) bad('TARGETS_WITHOUT_RIGHT');
  if (you !== null && you.canMove && targets.length === 0) bad('YOU_CANMOVE_CONFLICT');
  const seen = new Set<string>();
  for (const target of targets) {
    const figure = figures.find(candidate => candidate.id === target.figureId);
    const key = `${target.figureId}>${target.to}`;
    if (figure === undefined || !fieldIds.has(target.to) || seen.has(key)) bad('TARGET_INVALID');
    else if (!(routes.get(figure.ownerId) ?? []).includes(target.to)) bad('TARGET_INVALID');
    seen.add(key);
    if (target.captures.some(id => !figures.some(candidate => candidate.id === id))) bad('TARGET_INVALID');
  }
});
export type BoardProjection = z.infer<typeof BoardProjectionSchema>;

export type BoardProjectionResult = { ok: true; projection: BoardProjection } | { ok: false; code: 'BOARD_PROJECTION_INVALID' };
/** Failure carries a code only: no values, no zod paths. Returns a fresh copy. */
export function parseBoardProjection(raw: unknown): BoardProjectionResult {
  const parsed = BoardProjectionSchema.safeParse(raw);
  return parsed.success ? { ok: true, projection: parsed.data } : { ok: false, code: 'BOARD_PROJECTION_INVALID' };
}

/**
 * What the UI's own authenticated context expects, INDEPENDENTLY of the projection that arrives: the N8 scope, the board, who is looking (`recipientId`: the
 * caller's own participant id, or null for a viewer / display) and `minStateVersion`, the oldest authoritative snapshot version the caller accepts (from its
 * own snapshot channel — never copied out of the incoming projection).
 */
export interface BoardExpectedContext extends BoardScope { boardId: string; recipientId: string | null; minStateVersion: number }

export function boardProjectionMatches(projection: BoardProjection, expected: BoardExpectedContext): boolean {
  return projection.scope.runIndex === expected.runIndex && projection.scope.sequenceId === expected.sequenceId
    && projection.scope.rosterRevision === expected.rosterRevision && projection.scope.unit === expected.unit
    && projection.boardId === expected.boardId && projection.recipientId === expected.recipientId
    && Number.isSafeInteger(expected.minStateVersion) && projection.stateVersion >= expected.minStateVersion;
}

/** Public UI context key: run, sequence, roster revision, unit, board and recipient. Labels only — never a figure, a holder or a counter. */
export function boardContextKey(expected: BoardExpectedContext): string {
  return JSON.stringify(['BOARD', expected.runIndex, expected.sequenceId, expected.rosterRevision, expected.unit, expected.boardId, expected.recipientId]);
}
