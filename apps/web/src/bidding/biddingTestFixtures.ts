// Test-support fixtures for the N10 bidding UI tests and the browser harness: synthetic markers instead of game content. Not imported by any production module.
import { BIDDING_CONTRACT, type BiddingExpectedContext, type BiddingProjection } from '@quiz/shared/bidding';

export const SCOPE = { runIndex: 1, roundId: 'round-1', biddingId: 'bidding-1', sequenceId: 'seq-1', rosterRevision: 'roster-1', rolesRevision: 'roles-1' };
export const NUMERIC = { schemaVersion: 1 as const, scale: 0 as const, unit: { label: 'Städte', factor: 1 as const }, allowNegative: false, bounds: { min: { units: 1, scale: 0 as const }, max: { units: 999, scale: 0 as const } } };
export interface Stand { sv: number; bv: number; qv: number; turn: number }
export interface Over {
  recipient?: string | null; youTeam?: string | null; onTurn?: string | null; leader?: { teamId: string; units: number } | null; passed?: string[]; phase?: 'PREPARED' | 'OPEN' | 'CLOSED' | 'ABORTED';
  scope?: Partial<typeof SCOPE>; category?: string | null; canBid?: boolean; canPass?: boolean; noYou?: boolean; max?: number;
}
const TEAMS = ['T1', 'T2', 'T3'];
export function standing(stand: Stand, over: Over = {}): BiddingProjection {
  const phase = over.phase ?? 'OPEN';
  const leader = over.leader === undefined ? { teamId: 'T2', units: 5 } : over.leader;
  const passed = over.passed ?? [];
  const recipient = over.recipient === undefined ? 'b1' : over.recipient;
  const youTeam = over.youTeam === undefined ? (recipient === null ? null : 'T1') : over.youTeam;
  const onTurn = over.onTurn === undefined ? 'T1' : over.onTurn;
  const holds = phase === 'OPEN' && youTeam !== null && onTurn === youTeam;
  const canBid = (over.canBid ?? true) && holds;
  const closed = phase === 'CLOSED';
  const winner = closed && leader !== null ? leader : null;
  return {
    contract: BIDDING_CONTRACT, release: 'STANDING', scope: { ...SCOPE, ...(over.scope ?? {}) }, recipientId: recipient, stateVersion: stand.sv, phase, biddingVersion: stand.bv, sequenceVersion: stand.qv, turnNumber: stand.turn,
    category: over.category === undefined ? 'Hauptstädte' : over.category,
    numeric: { ...NUMERIC, bounds: { min: NUMERIC.bounds.min, max: { units: over.max ?? 999, scale: 0 } } },
    teams: TEAMS.map(teamId => ({ teamId, status: passed.includes(teamId) ? 'PASSED' as const : 'IN' as const, leading: phase !== 'ABORTED' && leader !== null && leader.teamId === teamId })),
    standing: phase === 'ABORTED' || phase === 'PREPARED' ? null : leader === null ? null : { teamId: leader.teamId, value: { units: leader.units, scale: 0 } },
    onTurn: phase === 'OPEN' && onTurn !== null ? { teamId: onTurn, playerId: `b${onTurn.slice(1)}` } : null,
    outcome: winner === null ? null : { winnerTeamId: winner.teamId, winningValue: { units: winner.units, scale: 0 }, bidderId: `b${winner.teamId.slice(1)}`, performerId: `p${winner.teamId.slice(1)}` },
    endReason: closed ? 'COMPLETED' : phase === 'ABORTED' ? 'HOST_ABORTED' : null,
    you: over.noYou || recipient === null ? null : { teamId: youTeam, holdsTurn: holds, canBid, canPass: canBid && leader !== null && phase === 'OPEN' && (over.canPass ?? true) },
  } as BiddingProjection;
}
export const neutral = (stateVersion: number, over: { recipient?: string | null; phase?: 'PREPARED' | 'OPEN' | 'ENDED'; performer?: boolean; scope?: Partial<typeof SCOPE> } = {}): BiddingProjection => ({
  contract: BIDDING_CONTRACT, release: 'NEUTRAL', scope: { ...SCOPE, ...(over.scope ?? {}) }, recipientId: over.recipient === undefined ? 'p1' : over.recipient, stateVersion, phase: over.phase ?? 'OPEN',
  you: (over.recipient === undefined ? 'p1' : over.recipient) === null ? null : { performer: over.performer ?? true },
});
export const expectedFor = (recipientId: string | null, minStateVersion = 0, scope: Partial<typeof SCOPE> = {}): BiddingExpectedContext => ({ ...SCOPE, ...scope, recipientId, minStateVersion });
