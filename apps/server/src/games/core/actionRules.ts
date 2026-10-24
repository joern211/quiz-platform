import { z } from 'zod';
import { CoreTimerSchema, CoreBuzzerSchema, resolveCanonicalSlug, type CoreActionKey, type CoreRuntimeProjection, type GamePermission } from '@quiz/shared';
import { legacyRoundTimer, timerAcceptsInput } from './runtimePrimitives.js';

const playerState = z.object({ answered: z.boolean(), locked: z.boolean(), jokers: z.object({ used5050: z.boolean(), usedSpy: z.boolean(), usedRisk: z.boolean() }) });
export const geoState = z.object({ phase: z.string(), currentRoundIndex: z.number().int(), questions: z.array(z.unknown()), roundStates: z.record(z.object({ revealed: z.boolean(), timer: CoreTimerSchema.optional(), timerStartMs: z.number().nullable().optional(), timerEndMs: z.number().nullable().optional(), pauseRemainingMs: z.number().nullable().optional(), playerStates: z.record(playerState) })) });
export const jeopardyState = z.object({ phase: z.string(), currentBoard: z.union([z.literal(1), z.literal(2)]), boardCount: z.number().int().optional(), openFields: z.record(z.unknown()), scores: z.record(z.number()), buzzOpen: z.boolean(), buzzWinner: z.string().nullable(), stealOpen: z.boolean(), stealWinner: z.string().nullable(), currentField: z.object({ firstResponderId: z.string().optional() }).nullable(), timer: CoreTimerSchema.optional() });

type InformationRole = 'HOST' | 'PLAYER' | 'VIEWER' | 'DISPLAY';
export const widState = z.object({ phase: z.string(), roundIndex: z.number().int().nonnegative(), roundCount: z.number().int().positive(),
  hintActive: z.boolean(), revealed: z.boolean(), playerNames: z.record(z.string()), scores: z.record(z.number()), buzzer: CoreBuzzerSchema });
export interface CoreActionContext {
  gameSlug: string; roomStatus: string; state: unknown;
  informationRole: InformationRole; participantId: string | null; active: boolean;
  permissions: ReadonlySet<GamePermission>; now: number;
  buzzerController?: boolean;
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
const buzzerOverrideRule: ActionRule = { key: 'buzzerOverride', event: 'game:buzzer:override', label: 'Buzzer-Gewinner korrigieren', permission: 'BUZZER_CONTROL' };
const commonRules: ActionRule[] = [
  { key: 'pause', event: 'game:pause', label: 'Spiel pausieren', permission: 'GAME_PAUSE' },
  { key: 'resume', event: 'game:resume', label: 'Spiel fortsetzen', permission: 'GAME_PAUSE' },
  { key: 'end', event: 'game:end', label: 'Spiel beenden', permission: 'GAME_ABORT' },
];
const widRules: ActionRule[] = [
  { key: 'open', event: 'weristdas:buzzer:open', label: 'Buzzer öffnen', permission: 'BUZZER_CONTROL' },
  { key: 'buzz', event: 'weristdas:buzz', label: 'Buzzern', permission: 'BUZZER_CONTROL', player: true },
  { key: 'hint', event: 'weristdas:hint', label: 'Hinweis aktivieren', permission: 'ROUND_ADVANCE' },
  { key: 'judge', event: 'weristdas:judge', label: 'Antwort bewerten', permission: 'JUDGE_ANSWER' },
  { key: 'reveal', event: 'weristdas:reveal', label: 'Auflösen', permission: 'REVEAL_CONTENT' },
  { key: 'next', event: 'weristdas:next', label: 'Nächste Runde', permission: 'ROUND_ADVANCE' },
];
function rules(slug: string) {
  return slug === 'wissensduell' ? [...geoRules, ...commonRules] : slug === 'jeopardy' ? [...jeopardyRules, buzzerOverrideRule, ...commonRules] : slug === 'wer-ist-das' ? [...widRules, buzzerOverrideRule, ...commonRules] : [];
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
  if (key === 'buzzerOverride') {
    if (!(context.buzzerController ?? context.informationRole === 'HOST')) return 'FORBIDDEN';
    return (slug === 'jeopardy' ? ['BUZZ_LOCKED', 'STEAL_LOCKED'] : ['ANSWERING']).includes(phase) ? null : 'INVALID_PHASE';
  }
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
  if (slug === 'wer-ist-das') {
    const decoded = widState.safeParse(context.state);
    if (!decoded.success) return 'INVALID_GAME_STATE';
    const s = decoded.data;
    if (key === 'open') {
      // The PLAYER default BUZZER_CONTROL permits buzzing, not opening it.
      if (!(context.buzzerController ?? context.informationRole === 'HOST')) return 'FORBIDDEN';
      if (s.phase !== 'ROUND_READY') return 'INVALID_PHASE';
      return Object.keys(s.playerNames).every(id => s.buzzer.excludedPlayerIds.includes(id)) ? 'NO_ELIGIBLE_PLAYERS' : null;
    }
    if (key === 'hint') return !context.permissions.has('REVEAL_CONTENT') ? 'FORBIDDEN'
      : ['ROUND_READY', 'BUZZ_OPEN', 'ANSWERING'].includes(s.phase) && !s.hintActive ? null : 'INVALID_PHASE';
    if (key === 'judge') return s.phase === 'ANSWERING' && s.buzzer.winnerId ? null : 'INVALID_PHASE';
    if (key === 'reveal') return ['ROUND_READY', 'BUZZ_OPEN'].includes(s.phase) ? null : 'INVALID_PHASE';
    if (key === 'next') return s.phase === 'REVEAL' ? null : 'INVALID_PHASE';
    if (s.phase !== 'BUZZ_OPEN' || !s.buzzer.open) return 'INVALID_PHASE';
    if (!context.participantId || !Object.hasOwn(s.playerNames, context.participantId)) return 'PLAYER_NOT_IN_GAME';
    return s.buzzer.excludedPlayerIds.includes(context.participantId) ? 'PLAYER_EXCLUDED' : null;
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

