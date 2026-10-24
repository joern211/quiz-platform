import type { Socket } from 'socket.io';
import { z } from 'zod';
import { CoreTimerSchema, CoreRuntimeProjectionSchema, resolveCanonicalSlug, type CoreActionKey, type CoreRuntimeProjection, type GamePermission } from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import { socketRoomActor } from '../../rooms/socket.js';
import { CoreRuleError, legacyRoundTimer, timerAcceptsInput } from './runtimePrimitives.js';

const playerState = z.object({ answered: z.boolean(), locked: z.boolean(), jokers: z.object({ used5050: z.boolean(), usedSpy: z.boolean(), usedRisk: z.boolean() }) });
const geoState = z.object({ phase: z.string(), currentRoundIndex: z.number().int(), questions: z.array(z.unknown()), roundStates: z.record(z.object({ revealed: z.boolean(), timer: CoreTimerSchema.optional(), timerStartMs: z.number().nullable().optional(), timerEndMs: z.number().nullable().optional(), pauseRemainingMs: z.number().nullable().optional(), playerStates: z.record(playerState) })) });
const jeopardyState = z.object({ phase: z.string(), currentBoard: z.union([z.literal(1), z.literal(2)]), boardCount: z.number().int().optional(), openFields: z.record(z.unknown()), scores: z.record(z.number()), buzzOpen: z.boolean(), buzzWinner: z.string().nullable(), stealOpen: z.boolean(), stealWinner: z.string().nullable(), currentField: z.object({ firstResponderId: z.string().optional() }).nullable(), timer: CoreTimerSchema.optional() });

type InformationRole = 'HOST' | 'PLAYER' | 'VIEWER' | 'DISPLAY';
export interface CoreActionContext {
  gameSlug: string; roomStatus: string; state: unknown;
  informationRole: InformationRole; participantId: string | null; active: boolean;
  permissions: ReadonlySet<GamePermission>; now: number;
}
interface ActionRule { key: CoreActionKey; event: string; label: string; permission: GamePermission; player?: boolean }
const geoRules: ActionRule[] = [
  { key: 'answer', event: 'geo:answer', label: 'Antwort abgeben', permission: 'BUZZER_CONTROL', player: true },
  { key: 'joker5050', event: 'geo:joker:5050', label: '50/50', permission: 'BUZZER_CONTROL', player: true },
  { key: 'jokerSpy', event: 'geo:joker:spy', label: 'Spy', permission: 'BUZZER_CONTROL', player: true },
  { key: 'jokerRisk', event: 'geo:joker:risk', label: 'Risk', permission: 'BUZZER_CONTROL', player: true },
  { key: 'reveal', event: 'geo:reveal', label: 'Auflösen', permission: 'REVEAL_CONTENT' },
  { key: 'next', event: 'geo:next', label: 'Nächste Frage', permission: 'ROUND_ADVANCE' },
];
const jeopardyRules: ActionRule[] = [
  { key: 'fieldOpen', event: 'jeopardy:field:open', label: 'Feld öffnen', permission: 'BUZZER_CONTROL' },
  { key: 'buzz', event: 'jeopardy:buzz', label: 'Buzzern', permission: 'BUZZER_CONTROL', player: true },
  { key: 'judge', event: 'jeopardy:judge', label: 'Antwort bewerten', permission: 'JUDGE_ANSWER' },
  { key: 'stealBuzz', event: 'jeopardy:steal:buzz', label: 'Abstauben', permission: 'BUZZER_CONTROL', player: true },
  { key: 'stealJudge', event: 'jeopardy:steal:judge', label: 'Abstauber bewerten', permission: 'JUDGE_ANSWER' },
  { key: 'next', event: 'jeopardy:next', label: 'Nächstes Feld', permission: 'ROUND_ADVANCE' },
  { key: 'boardSwitch', event: 'jeopardy:board:switch', label: 'Board abschließen', permission: 'ROUND_ADVANCE' },
];
const commonRules: ActionRule[] = [
  { key: 'pause', event: 'game:pause', label: 'Spiel pausieren', permission: 'GAME_PAUSE' },
  { key: 'resume', event: 'game:resume', label: 'Spiel fortsetzen', permission: 'GAME_PAUSE' },
  { key: 'end', event: 'game:end', label: 'Spiel beenden', permission: 'GAME_ABORT' },
];
function rules(slug: string) {
  return slug === 'wissensduell' ? [...geoRules, ...commonRules] : slug === 'jeopardy' ? [...jeopardyRules, ...commonRules] : [];
}
/** A single predicate powers both public action availability and mutation guards. */
export function coreActionDenial(context: CoreActionContext, key: string): string | null {
  const slug = resolveCanonicalSlug(context.gameSlug) ?? context.gameSlug;
  const rule = rules(slug).find(r => r.key === key);
  if (!rule) return 'COMMAND_UNSUPPORTED';
  if (!context.permissions.has(rule.permission)) return 'FORBIDDEN';
  if (context.roomStatus !== 'RUNNING') return 'GAME_NOT_RUNNING';
  if (rule.player && (context.informationRole !== 'PLAYER' || !context.participantId || !context.active)) return 'FORBIDDEN';
  const parsed = z.object({ phase: z.string() }).safeParse(context.state);
  if (!parsed.success) return 'INVALID_GAME_STATE';
  const phase = parsed.data.phase;
  if (key === 'end') return phase === 'GAME_END' ? 'GAME_NOT_RUNNING' : null;
  if (key === 'resume') return phase === 'PAUSED' ? null : 'NOT_PAUSED';
  if (key === 'pause') return !['PAUSED', 'GAME_END', 'ERROR_RECOVERY'].includes(phase) && (slug !== 'wissensduell' || phase === 'INPUT_OPEN') ? null : 'INVALID_PHASE';
  if (slug === 'wissensduell') {
    const decoded = geoState.safeParse(context.state);
    if (!decoded.success) return 'INVALID_GAME_STATE';
    const state = decoded.data, round = state.roundStates[state.currentRoundIndex];
    if (key === 'next') return phase === 'REVEAL' ? null : 'INVALID_PHASE';
    if (key === 'reveal') return round && !round.revealed && ['INPUT_OPEN', 'INPUT_LOCKED'].includes(phase) ? null : 'INVALID_PHASE';
    if (!round || round.revealed || !['INPUT_OPEN', ...(key === 'jokerSpy' ? ['INPUT_LOCKED'] : [])].includes(phase)) return 'INVALID_PHASE';
    const own = context.participantId ? round.playerStates[context.participantId] : undefined;
    if (!own) return 'PLAYER_NOT_IN_ROUND';
    if (key === 'jokerSpy') {
      if (own.jokers.usedSpy) return 'JOKER_ALREADY_USED';
      return phase === 'INPUT_LOCKED' || Object.entries(round.playerStates).filter(([id]) => id !== context.participantId).every(([, p]) => p.answered) ? null : 'NOT_ALL_ANSWERED';
    }
    try {
      const timer = legacyRoundTimer(round, phase);
      if (!timerAcceptsInput(timer, context.now)) return 'TIME_EXPIRED';
    } catch { return 'INVALID_TIMER_STATE'; }
    if (own.answered || own.locked) return 'ALREADY_ANSWERED';
    if (key === 'joker5050' && own.jokers.used5050 || key === 'jokerRisk' && own.jokers.usedRisk) return 'JOKER_ALREADY_USED';
    return null;
  }
  const decoded = jeopardyState.safeParse(context.state);
  if (!decoded.success) return 'INVALID_GAME_STATE';
  const state = decoded.data;
  if (key === 'fieldOpen') {
    if (!context.permissions.has('REVEAL_CONTENT')) return 'FORBIDDEN';
    return phase === 'SELECTING' ? null : 'PHASE_NOT_SELECTING';
  }
  if (key === 'boardSwitch' && context.informationRole !== 'HOST') return 'FORBIDDEN'; // legacy adapter's actual information-role boundary
  const required = { buzz: 'BUZZ_OPEN', judge: 'BUZZ_LOCKED', stealBuzz: 'STEAL_OPEN', stealJudge: 'STEAL_LOCKED', next: 'FIELD_DONE', boardSwitch: 'BOARD_COMPLETE' } as const;
  const wanted = required[key as keyof typeof required];
  if (phase !== wanted) return `PHASE_NOT_${wanted}`;
  if (rule.player && (!context.participantId || !Object.hasOwn(state.scores, context.participantId))) return 'PLAYER_NOT_IN_GAME';
  if (key === 'buzz') return state.buzzOpen && !state.buzzWinner ? null : 'BUZZ_CLOSED';
  if (key === 'stealBuzz') return context.participantId === state.currentField?.firstResponderId ? 'ALREADY_ANSWERED' : state.stealOpen && !state.stealWinner ? null : 'BUZZ_CLOSED';
  if (key === 'judge' && (!state.buzzWinner || !state.currentField)) return 'PHASE_NOT_BUZZ_LOCKED';
  if (key === 'stealJudge' && (!state.stealWinner || !state.currentField)) return 'PHASE_NOT_STEAL_LOCKED';
  return null;
}
export function availableCoreActions(context: CoreActionContext): CoreRuntimeProjection['availableActions'] {
  return rules(resolveCanonicalSlug(context.gameSlug) ?? context.gameSlug).filter(rule => coreActionDenial(context, rule.key) === null).map(({ key, event, label }) => ({ key, event, label }));
}

async function loadContext(socket: Socket) {
  const { roomId, actor } = await socketRoomActor(socket);
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId }, include: { gameDefinition: true, gameState: true, participations: { where: { id: actor.participantId } } } });
  const self = room.participations[0];
  const informationRole: InformationRole = self?.role === 'HOST' && actor.userId === room.hostUserId ? 'HOST' : self?.role === 'PLAYER' ? 'PLAYER' : 'VIEWER';
  const context: CoreActionContext = { gameSlug: room.gameDefinition.slug, roomStatus: room.status, state: room.gameState ? JSON.parse(room.gameState.stateJson) : null,
    informationRole, participantId: self?.id ?? null, active: !!self && self.admission === 'ACTIVE' && !self.leftAt && !self.kickedAt && !self.bannedAt,
    permissions: actor.permissions, now: Date.now() };
  return { context, room };
}
export async function assertCoreActionAllowed(socket: Socket, key: string, expectedSlug?: string): Promise<void> {
  const { context } = await loadContext(socket);
  if (expectedSlug && resolveCanonicalSlug(expectedSlug) !== resolveCanonicalSlug(context.gameSlug)) throw new CoreRuleError('WRONG_GAME');
  if (!['wissensduell', 'jeopardy'].includes(resolveCanonicalSlug(context.gameSlug) ?? context.gameSlug)) return;
  const denied = coreActionDenial(context, key);
  if (denied) throw new CoreRuleError(denied);
}
export async function projectCoreRuntime(socket: Socket): Promise<CoreRuntimeProjection> {
  const { context, room } = await loadContext(socket);
  if (!room.gameState) throw new CoreRuleError('GAME_NOT_FOUND');
  const slug = resolveCanonicalSlug(context.gameSlug) ?? context.gameSlug;
  let currentRound = 0, totalRounds: number | null = null, completed = 0, timer = null;
  if (slug === 'wissensduell') {
    const state = geoState.parse(context.state), round = state.roundStates[state.currentRoundIndex];
    totalRounds = state.questions.length; currentRound = Math.min(totalRounds, state.currentRoundIndex + 1);
    completed = state.phase === 'GAME_END' ? totalRounds : Math.min(totalRounds, state.currentRoundIndex + (round?.revealed ? 1 : 0));
    if (round && ['INPUT_OPEN', 'PAUSED', 'INPUT_LOCKED'].includes(state.phase)) timer = legacyRoundTimer(round, state.phase);
  } else if (slug === 'jeopardy') {
    const state = jeopardyState.parse(context.state);
    const setup = z.object({ board1: z.object({ categories: z.array(z.object({ clues: z.array(z.unknown()) })) }), board2: z.object({ categories: z.array(z.object({ clues: z.array(z.unknown()) })) }).optional() }).parse(JSON.parse(room.setupSnapshotJson));
    totalRounds = [setup.board1, ...(state.boardCount === 1 ? [] : [setup.board2])].reduce((sum, board) => sum + (board?.categories.reduce((n, category) => n + category.clues.length, 0) ?? 0), 0);
    completed = state.phase === 'GAME_END' ? totalRounds : Math.max(0, totalRounds - Object.keys(state.openFields).length);
    currentRound = Math.min(totalRounds, completed + 1);
    if (state.timer) timer = state.timer;
  } else throw new CoreRuleError('COMMAND_UNSUPPORTED');
  return CoreRuntimeProjectionSchema.parse({ roomCode: room.code, runIndex: room.runIndex, gameSlug: slug, engineVersion: room.gameState.engineVersion, stateVersion: room.gameState.revision,
    enginePhase: z.object({ phase: z.string() }).parse(context.state).phase, informationRole: context.informationRole, timer,
    progress: { currentRound, totalRounds, remainingRounds: totalRounds === null ? null : totalRounds - completed, progressPercent: totalRounds ? 100 * completed / totalRounds : null },
    availableActions: availableCoreActions(context) });
}
