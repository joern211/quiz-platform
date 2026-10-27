import { CONTENT_DIFFICULTIES, contentDifficultySequence, type ContentDifficultyPlan } from '@quiz/shared';
import { shuffleServer } from '../games/core/roundFlow.js';

type Candidate = { id: string; poolId: string; difficulty: string | null };
export class DifficultySelectionError extends Error {}
type Edge = { to: number; reverse: number; capacity: number; cost: number };
/** Min-cost flow satisfies both difficulty and pool quotas, preferring unseen items globally. */
export function selectByDifficulty<T extends Candidate>(candidates: T[], poolIds: string[], count: number, plan: ContentDifficultyPlan, poolCounts: Record<string, number> | undefined, unseen: Set<string> | undefined): T[] {
  let sequence: ReturnType<typeof contentDifficultySequence>;
  try { sequence = contentDifficultySequence(plan, count); } catch { throw new DifficultySelectionError('DIFFICULTY_RANGE_COUNT'); }
  if (plan.kind === 'DISTRIBUTION') sequence = shuffleServer(sequence);
  const poolOrder = shuffleServer(poolIds), sink = 6 + poolIds.length, graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const add = (from: number, to: number, capacity: number, cost = 0) => { const edge = { to, capacity, cost, reverse: graph[to].length }; graph[from].push(edge); graph[to].push({ to: from, capacity: 0, cost: -cost, reverse: graph[from].length - 1 }); return edge; };
  const groups: Array<{ edge: Edge; original: number; items: T[]; difficulty: string }> = [];
  for (const [i, difficulty] of CONTENT_DIFFICULTIES.entries()) {
    add(0, 1 + i, sequence.filter(d => d === difficulty).length);
    for (const [p, poolId] of poolOrder.entries()) for (const played of [false, true]) {
      const items = shuffleServer(candidates.filter(c => c.poolId === poolId && c.difficulty === difficulty && (unseen ? !unseen.has(c.id) : false) === played));
      if (items.length) groups.push({ edge: add(1 + i, 6 + p, items.length, played ? 1 : 0), original: items.length, items, difficulty });
    }
  }
  poolOrder.forEach((id, p) => add(6 + p, sink, poolCounts?.[id] ?? count));
  for (let sent = 0; sent < count; sent++) {
    const distance = Array(graph.length).fill(Infinity), previous: Array<[number, number] | undefined> = Array(graph.length); distance[0] = 0;
    for (let loop = 0; loop < graph.length - 1; loop++) { let changed = false;
      for (let from = 0; from < graph.length; from++) for (let e = 0; e < graph[from].length; e++) { const edge = graph[from][e];
        if (edge.capacity > 0 && distance[from] + edge.cost < distance[edge.to]) { distance[edge.to] = distance[from] + edge.cost; previous[edge.to] = [from, e]; changed = true; }
      }
      if (!changed) break;
    }
    if (!previous[sink]) throw new DifficultySelectionError('DIFFICULTY_CONTENT_NOT_READY');
    for (let node = sink; node !== 0;) { const [from, index] = previous[node]!; const edge = graph[from][index]; edge.capacity--; graph[node][edge.reverse].capacity++; node = from; }
  }
  const chosen = new Map<string, T[]>();
  for (const group of groups) chosen.set(group.difficulty, [...(chosen.get(group.difficulty) ?? []), ...group.items.slice(0, group.original - group.edge.capacity)]);
  for (const [difficulty, items] of chosen) chosen.set(difficulty, shuffleServer(items));
  return sequence.map(d => chosen.get(d)!.pop()!);
}
