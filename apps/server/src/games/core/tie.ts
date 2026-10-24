import { CoreTieStrategySchema, type CoreTieStrategy } from '@quiz/shared';
import { rankScores } from './roundFlow.js';
import { CoreRuleError } from './runtimePrimitives.js';

export interface TieResolution<T> {
  strategy: CoreTieStrategy; status: 'RESOLVED' | 'PENDING'; winnerIds: string[];
  tiedParticipantIds: string[]; requiredAction: Exclude<CoreTieStrategy, 'ALLOW_TIE'> | null;
  rankings: Array<T & { rank: number }>;
}
/** Strategies are pinned before start. Unresolved ties never select a random winner. */
export function resolveTie<T extends { id: string; score: number }>(entries: readonly T[], inputStrategy: CoreTieStrategy,
  options: { secondaryMetric?: Readonly<Record<string, number>>; hostWinnerId?: string } = {}): TieResolution<T> {
  const strategy = CoreTieStrategySchema.parse(inputStrategy);
  if (new Set(entries.map(e => e.id)).size !== entries.length) throw new CoreRuleError('INVALID_TIE_PARTICIPANTS');
  const rankings = rankScores(entries), leaders = rankings.filter(entry => entry.rank === 1);
  const ids = leaders.map(entry => entry.id);
  if (strategy === 'HOST_DECIDES' && options.hostWinnerId && !ids.includes(options.hostWinnerId)) throw new CoreRuleError('INVALID_TIE_WINNER');
  const base = { strategy, rankings, tiedParticipantIds: ids.length > 1 ? ids : [] };
  if (leaders.length < 2 || strategy === 'ALLOW_TIE') return { ...base, status: 'RESOLVED', winnerIds: ids, requiredAction: null };
  const pending: TieResolution<T> = { ...base, status: 'PENDING', winnerIds: [], requiredAction: strategy };
  if (strategy === 'HOST_DECIDES') {
    if (!options.hostWinnerId) return pending;
    return { ...base, status: 'RESOLVED', winnerIds: [options.hostWinnerId], requiredAction: null,
      rankings: rankings.map(entry => entry.rank !== 1 ? entry : { ...entry, rank: entry.id === options.hostWinnerId ? 1 : 2 }).sort((a, b) => a.rank - b.rank) };
  }
  if (strategy === 'SECONDARY_METRIC') {
    if (ids.some(id => !Number.isFinite(options.secondaryMetric?.[id]))) return pending;
    // Higher is better; an engine must configure/derive its chosen metric in advance.
    const secondary = rankScores(leaders.map(entry => ({ ...entry, score: options.secondaryMetric![entry.id] })));
    if (secondary.filter(entry => entry.rank === 1).length > 1) return pending;
    return { ...base, status: 'RESOLVED', winnerIds: [secondary[0].id], requiredAction: null,
      rankings: [...secondary.map(entry => ({ ...leaders.find(original => original.id === entry.id)!, rank: entry.rank })), ...rankings.filter(entry => entry.rank !== 1)] };
  }
  return pending;
}
