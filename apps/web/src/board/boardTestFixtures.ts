// Synthetic fixtures for the N11 web tests: markers instead of game content, an EXPLICIT TEST GEOMETRY (a: sa t1 t2 t3 t4 ha — b: sb t3 t4 t5 t6 hb). No rule here.
import { BOARD_CONTRACT, parseBoardProjection, type BoardExpectedContext, type BoardProjection, type BoardTarget } from '@quiz/shared/board';

export const SCOPE: { runIndex: number; sequenceId: string; rosterRevision: string; unit: 'PLAYER' | 'TEAM' } = { runIndex: 1, sequenceId: 'seq-1', rosterRevision: 'roster-1', unit: 'PLAYER' };
export const EXPECTED: BoardExpectedContext = { ...SCOPE, boardId: 'board-1', recipientId: 'p1', minStateVersion: 1 };
export const GEOMETRY = {
  fields: [
    { id: 'sa', capacity: 2 }, { id: 'sb', capacity: 2 }, { id: 't1', capacity: 1 }, { id: 't2', capacity: 1 }, { id: 't3', capacity: 1 }, { id: 't4', capacity: 1 },
    { id: 't5', capacity: 1 }, { id: 't6', capacity: 1 }, { id: 'ha', capacity: 2 }, { id: 'hb', capacity: 2 },
  ],
  routes: [{ ownerId: 'p1', route: ['sa', 't1', 't2', 't3', 't4', 'ha'] }, { ownerId: 'p2', route: ['sb', 't3', 't4', 't5', 't6', 'hb'] }],
};
export const START_AT: Record<string, string> = { a1: 'sa', a2: 'sa', b1: 'sb', b2: 'sb' };
const OWNER: Record<string, string> = { a1: 'p1', a2: 'p1', b1: 'p2', b2: 'p2' };

/** state = snapshot version, seq = N8 sequence version, turn = N8 turn, bv = board version, dv / roll = the shown roll (null = none) */
export interface Stand { state: number; seq: number; turn: number; bv: number; roll?: { dv: number; count: number; steps: number; spent?: boolean } | null }
export interface Over {
  release?: 'NONE' | 'FIGURES'; recipient?: string | null; holder?: string; at?: Record<string, string>; targets?: BoardTarget[]; boardId?: string; unit?: 'PLAYER' | 'TEAM';
  diceId?: string; lastMove?: BoardProjection extends infer P ? (P extends { lastMove: infer L } ? L : never) : never; scope?: typeof SCOPE;
}

/** A valid projection. `you` is derived like the server derives it: only the holder can move, and only with offered targets. */
export function view(stand: Stand, over: Over = {}): BoardProjection {
  const recipient = over.recipient === undefined ? 'p1' : over.recipient;
  const scope = over.scope ?? SCOPE;
  const base = {
    contract: BOARD_CONTRACT, scope: { ...scope }, boardId: over.boardId ?? 'board-1', recipientId: recipient, stateVersion: stand.state, sequenceVersion: stand.seq, turnNumber: stand.turn, boardVersion: stand.bv,
  };
  if (over.release === 'NONE') return { ...base, release: 'NONE' } as BoardProjection;
  const holderId = over.holder ?? 'p1';
  const at = { ...START_AT, ...over.at };
  const roll = stand.roll === undefined ? { dv: 1, count: 1, steps: 3, spent: false } : stand.roll;
  const holds = recipient !== null && recipient === holderId;
  const targets = over.targets ?? [];
  const canMove = holds && roll !== null && roll.spent !== true && targets.length > 0;
  const you = recipient === null ? null : { holdsTurn: holds, teamHoldsTurn: scope.unit === 'TEAM' ? holds : null, canMove };
  return {
    ...base, release: 'FIGURES', geometry: JSON.parse(JSON.stringify(GEOMETRY)), figures: Object.keys(START_AT).map(id => ({ id, ownerId: OWNER[id], at: at[id] })),
    lastMove: over.lastMove ?? null, holder: { teamId: scope.unit === 'TEAM' ? 'T1' : null, playerId: holderId },
    roll: roll === null ? null : { diceId: over.diceId ?? `dice-t${stand.turn}`, diceVersion: roll.dv, rollCount: roll.count, steps: roll.steps, spent: roll.spent === true },
    you, targets: canMove || targets.length === 0 ? targets : [],
  } as BoardProjection;
}
export const T1 = (over: Partial<Stand> = {}): Stand => ({ state: 5, seq: 2, turn: 1, bv: 0, ...over });
/** The two offered targets of the roll-3 stand of the geometry above. */
export const OFFERED: BoardTarget[] = [{ figureId: 'a1', to: 't3', captures: [] }, { figureId: 'a2', to: 't3', captures: [] }];
export const valid = (projection: BoardProjection): boolean => parseBoardProjection(projection).ok;
