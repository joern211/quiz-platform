import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { EngineGameResultSchema, EngineRoundResultSchema, type EngineGameResult } from '@quiz/game-sdk';
import { resolveCanonicalSlug } from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import { coreLifecyclePhase } from './lifecycle.js';
import { rankScores } from './roundFlow.js';
import { CoreRuleError } from './runtimePrimitives.js';
import type { EngineResultContext } from './resultBuilders.js';

const teamSchema = z.object({ id: z.string(), name: z.string(), color: z.string(), icon: z.string(), score: z.number().int(), rank: z.number().int().positive() }).strict();
export const StoredGameResultSchema = z.object({
  result: EngineGameResultSchema, roomName: z.string(), gameName: z.string(),
  scoring: z.enum(['INDIVIDUAL_SCORE', 'TEAM_SCORE']), teams: z.array(teamSchema),
  teamWinnerIds: z.array(z.string()), integrity: z.enum(['VERIFIED', 'REVIEW_REQUIRED']),
}).strict();
export type StoredGameResult = z.infer<typeof StoredGameResultSchema>;
const stateSchema = z.object({ phase: z.string(), scores: z.record(z.number().int()), currentRoundIndex: z.number().int().optional(),
  roundIndex: z.number().int().optional(), currentBoard: z.number().int().optional(), roundCount: z.number().int().optional(),
  questions: z.array(z.object({ id: z.string() }).passthrough()).optional(),
  currentField: z.object({ categoryIndex: z.number(), value: z.number() }).nullable().optional(),
  lastResolvedFieldKey: z.string().optional(), openFields: z.record(z.unknown()).optional(),
}).passthrough();

/** Stable content identity, never answer text or an unrevealed setup object. */
export function resultRoundKey(slug: string, input: unknown): string | null {
  const s = stateSchema.parse(input);
  if (slug === 'wissensduell') return s.currentRoundIndex !== undefined && s.currentRoundIndex < (s.questions?.length ?? 0) ? `question:${s.currentRoundIndex}` : null;
  if (slug === 'wer-ist-das') return `round:${s.roundIndex}`;
  if (slug === 'jeopardy') return s.currentField ? `field:${s.currentBoard}-${s.currentField.categoryIndex}-${s.currentField.value}` : s.lastResolvedFieldKey ? `field:${s.lastResolvedFieldKey}` : null;
  return null;
}
async function context(tx: Prisma.TransactionClient, roomId: string, input: unknown, engineVersion: number, endReason: EngineGameResult['endReason']) {
  const room = await tx.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true, participations: { where: { role: 'PLAYER' } }, teams: true } });
  const state = stateSchema.parse(input), gameSlug = resolveCanonicalSlug(room.gameDefinition.slug) ?? room.gameDefinition.slug;
  const events = await tx.scoreEvent.findMany({ where: { roomId, runIndex: room.runIndex }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const scores: Record<string, number> = Object.fromEntries(Object.keys(state.scores).map(id => [id, 0]));
  for (const event of events) scores[event.participationId] = (scores[event.participationId] ?? 0) + event.delta;
  const participants = room.participations.filter(p => Object.hasOwn(scores, p.id)).map(p => ({ id: p.id, displayName: p.displayName, teamId: p.teamId }));
  // Ledger recipients cannot disappear merely because they left, were kicked or changed teams.
  const integrity = Object.keys(scores).every(id => scores[id] === (state.scores[id] ?? 0)) && participants.length === Object.keys(scores).length ? 'VERIFIED' as const : 'REVIEW_REQUIRED' as const;
  const rounds = await tx.roundResultRecord.findMany({ where: { roomId, runIndex: room.runIndex }, orderBy: { stateVersion: 'asc' } });
  const contentRefs = rounds.flatMap(r => EngineRoundResultSchema.parse(JSON.parse(r.dataJson)).contentRefs);
  const ctx: EngineResultContext = { roomId, runIndex: room.runIndex, gameSlug, engineVersion, roundIndex: state.currentRoundIndex ?? state.roundIndex ?? rounds.length,
    roundCount: rounds.length, participants, scores: integrity === 'VERIFIED' ? scores : state.scores, scoreEvents: events, contentRefs: [...new Set(contentRefs)],
    durationMs: room.startedAt ? Math.max(0, (room.endedAt?.getTime() ?? Date.now()) - room.startedAt.getTime()) : null,
    gameEndReason: endReason, roundEndReason: 'COMPLETED' };
  return { room, state, events, ctx, integrity };
}

/** Called inside the same transaction AFTER its score writes and BEFORE losing round runtime. */
export async function persistRoundResult(tx: Prisma.TransactionClient, args: { roomId: string; gameSlug: string; engineVersion: number; stateVersion: number; state: unknown; previous?: unknown }) {
  const slug = resolveCanonicalSlug(args.gameSlug) ?? args.gameSlug;
  if (coreLifecyclePhase(slug, args.state) !== 'ROUND_END') return;
  const key = resultRoundKey(slug, args.state);
  if (!key) return; // Honest legacy absence; never fabricate a field identity.
  const { room, ctx, events, state } = await context(tx, args.roomId, args.state, args.engineVersion, 'COMPLETED');
  if (await tx.roundResultRecord.findUnique({ where: { roomId_runIndex_roundKey: { roomId: args.roomId, runIndex: room.runIndex, roundKey: key } } })) return;
  const selected = events.filter(e => e.roundKey === key || e.roundKey === null && slug !== 'jeopardy' && e.roundIndex === ctx.roundIndex);
  ctx.scoreEvents = selected.map(e => ({ ...e, roundIndex: ctx.roundIndex }));
  ctx.durationMs = null; // No invented duration for legacy or untimed rounds.
  const setup: unknown = JSON.parse(room.setupSnapshotJson);
  if (slug === 'wissensduell') ctx.contentRefs = state.questions?.[ctx.roundIndex]?.id ? [state.questions[ctx.roundIndex].id] : [];
  else if (slug === 'wer-ist-das') {
    const decoded = z.object({ rounds: z.array(z.object({ id: z.string() })) }).parse(setup);
    ctx.contentRefs = decoded.rounds[ctx.roundIndex] ? [decoded.rounds[ctx.roundIndex].id] : [];
  } else {
    ctx.contentRefs = [key];
    const [board, category, value] = key.replace(/^field:/, '').split('-').map(Number);
    const decoded = z.object({ board1: z.object({ categories: z.array(z.object({ clues: z.array(z.object({ value: z.number(), contentId: z.string().optional() }).passthrough()) }).passthrough()) }).passthrough(),
      board2: z.object({ categories: z.array(z.object({ clues: z.array(z.object({ value: z.number(), contentId: z.string().optional() }).passthrough()) }).passthrough()) }).passthrough().optional() }).safeParse(setup);
    if (decoded.success) {
      const item = (board === 1 ? decoded.data.board1 : decoded.data.board2)?.categories[category]?.clues.find(q => q.value === value);
      if (item?.contentId) ctx.contentRefs.push(item.contentId);
    }
  }
  const { getGameEngineContract } = await import('./engineContract.js');
  const result = getGameEngineContract(slug)!.buildRoundResult(ctx);
  const publicState = z.object({ roundStates: z.record(z.object({ revealed: z.boolean() })).optional(),
    openFields: z.record(z.object({ answered: z.boolean() })).optional(), lastResolvedFieldKey: z.string().optional() }).safeParse(state);
  const actuallyRevealed = publicState.success && (slug === 'wissensduell' ? publicState.data.roundStates?.[ctx.roundIndex]?.revealed === true
    : slug === 'jeopardy' && publicState.data.lastResolvedFieldKey === key.replace(/^field:/, '')
      && !Object.hasOwn(publicState.data.openFields ?? {}, key.replace(/^field:/, '')));
  await tx.roundResultRecord.create({ data: { roomId: args.roomId, runIndex: room.runIndex, roundKey: key, stateVersion: args.stateVersion,
    dataJson: JSON.stringify({ ...result, publicContentIds: actuallyRevealed ? result.contentRefs : [] }) } });
}

/** Initial immutable result, committed with GAME_END. Repeated end commands never create a second result. */
export async function persistGameResult(tx: Prisma.TransactionClient, args: { roomId: string; state: unknown; engineVersion: number; endReason: EngineGameResult['endReason'] }) {
  const { room, ctx, integrity } = await context(tx, args.roomId, args.state, args.engineVersion, args.endReason);
  const existing = await tx.gameResultRecord.findUnique({ where: { roomId_runIndex: { roomId: room.id, runIndex: room.runIndex } } });
  if (existing) return existing;
  const { getGameEngineContract } = await import('./engineContract.js');
  const contract = getGameEngineContract(ctx.gameSlug);
  if (!contract) throw new CoreRuleError('WRONG_GAME');
  const teamScores = new Map<string, number>();
  for (const event of await tx.scoreEvent.findMany({ where: { roomId: room.id, runIndex: room.runIndex, teamId: { not: null } } })) teamScores.set(event.teamId!, (teamScores.get(event.teamId!) ?? 0) + event.delta);
  const teams = rankScores(room.teams.map(t => ({ participantId: t.id, id: t.id, name: t.name, color: t.color, icon: t.icon, score: teamScores.get(t.id) ?? 0 }))).map(({ participantId: _id, ...team }) => team);
  const scoring = room.roomPolicyJson && JSON.parse(room.roomPolicyJson).scoring === 'TEAM_SCORE' ? 'TEAM_SCORE' as const : 'INDIVIDUAL_SCORE' as const;
  const result = contract.buildGameResult(ctx);
  const summary = StoredGameResultSchema.parse({ result, roomName: room.roomName, gameName: room.gameDefinition.name, teams, scoring, integrity,
    teamWinnerIds: result.aborted ? [] : teams.filter(t => t.rank === 1).map(t => t.id) });
  return tx.gameResultRecord.create({ data: { roomId: room.id, runIndex: room.runIndex, gameSlug: ctx.gameSlug, engineVersion: args.engineVersion,
    configSnapshotJson: room.gameConfigSnapshotJson, endedAt: room.endedAt ?? new Date(), versions: { create: { revision: 1, kind: 'GAME_ENDED', dataJson: JSON.stringify(summary) } } } });
}

/** Historical reads use pinned result rows even after rematch, transfer or renaming. */
export async function readGameResult(roomId: string, runIndex: number, revision?: number) {
  const row = await prisma.gameResultRecord.findUnique({ where: { roomId_runIndex: { roomId, runIndex } }, include: { versions: { orderBy: { revision: 'desc' } } } });
  if (!row) return null;
  const version = row.versions.find(v => v.revision === (revision ?? row.revision));
  if (!version) throw new CoreRuleError('RESULT_REVISION_NOT_FOUND');
  const summary = StoredGameResultSchema.parse(JSON.parse(version.dataJson));
  return { row, version, summary };
}

/** Result status a stored revision had when it was written (the record's own status is always the latest one). */
const STATUS_AT_REVISION: Record<string, 'GAME_END' | 'RESULT_REVIEW' | 'FINALIZED'> = {
  GAME_ENDED: 'GAME_END', REVIEW: 'RESULT_REVIEW', ADJUST: 'RESULT_REVIEW', ROLLBACK: 'RESULT_REVIEW', FINALIZE: 'FINALIZED', RESULT_AMENDMENT: 'FINALIZED',
};

export function publicResultView(roomCode: string, read: NonNullable<Awaited<ReturnType<typeof readGameResult>>>) {
  const { row, summary, version } = read;
  return { roomCode, roomName: summary.roomName, status: 'ENDED', runPhase: row.status,
    runIndex: row.runIndex, resultRevision: version.revision, resultStatus: row.status,
    // `resultStatus` is always the record's CURRENT status; these say what the addressed revision itself was.
    latestRevision: row.revision, isLatestRevision: version.revision === row.revision, revisionKind: version.kind, statusAtRevision: STATUS_AT_REVISION[version.kind] ?? null,
    game: { slug: row.gameSlug, name: summary.gameName }, engineVersion: row.engineVersion,
    scores: summary.result.participants.map(p => ({ rank: p.rank, participationId: p.participantId, displayName: p.displayName, role: 'PLAYER', score: p.score, delta: p.delta, teamId: p.teamId })),
    teams: summary.teams, scoring: summary.scoring,
    winnerIds: summary.scoring === 'TEAM_SCORE' ? summary.teamWinnerIds : summary.result.winnerIds,
    endReason: summary.result.endReason, aborted: summary.result.aborted, durationMs: summary.result.durationMs,
    requiresReview: summary.integrity !== 'VERIFIED', endedAt: row.endedAt, finalizedAt: row.finalizedAt,
    versions: row.versions.map(v => ({ revision: v.revision, kind: v.kind, createdAt: v.createdAt })),
  };
}
