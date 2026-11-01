// ============================================================
// N2 — Text card submission lifecycle (domain building block)
//
// Pure functions over a serializable round state. They authenticate
// nothing: `participantId`, the expected scope, `timer` and `now` MUST come
// from the server-side admission/command boundary of a future engine, never
// from client claims. No socket, DB, clock, randomness, matching or scoring
// here: points, results and the ledger stay with the engine and the central
// score path. `applied` flags are domain information only; exactly-once
// effects need transaction/CAS/receipt at the real consumer.
//
// Lock semantics: the ROUND is the unit that closes. After
// `closeTextCardRound` nobody may submit a card — also not a participant
// who has no record yet, and also not while an external timer still runs.
// Card/field status is DERIVED from the round status and the judgements
// (nothing stored twice), so SUBMITTED/LOCKED/JUDGED can never contradict.
// ============================================================

import { z } from 'zod';
import { JudgeDecisionSchema, type CoreTimer, type JudgeDecision } from '@quiz/shared';
import {
  TEXT_CARD_SCHEMA_VERSION, TextCardConfigSchema, TextCardError, TextCardFieldDefSchema, TextCardValueSchema,
  textCardAnswer, textCardConfigKey, validateTextCard,
  type TextCardConfig, type TextCardValue,
} from '@quiz/shared/textcard';
import { CoreRuleError, timerAcceptsInput } from './runtimePrimitives.js';
import { answerMatchKey } from './roundFlow.js';
import { canView, type ProjectionAudience } from './visibility.js';

const MAX_CARDS = 500;
const idText = z.string().min(1).max(200);

export const TextCardJudgementSchema = z.object({
  fieldId: z.string().min(1).max(100),
  decision: JudgeDecisionSchema,
  judgedAtMs: z.number().int().nonnegative(),
}).strict();
export type TextCardJudgement = z.infer<typeof TextCardJudgementSchema>;

/** The card is immutable after acceptance; judgements are separate data and never touch the answers. */
export const TextCardRecordSchema = z.object({
  participantId: idText,
  card: TextCardValueSchema,
  submittedAtMs: z.number().int().nonnegative(),
  judgements: z.array(TextCardJudgementSchema).max(12),
}).strict();
export type TextCardRecord = z.infer<typeof TextCardRecordSchema>;

/**
 * Persisted state of ONE text-card round. It pins the effective config (a fully public structure: it has no
 * room for private references), so a later config change cannot reinterpret stored answers.
 */
export const TextCardRoundStateSchema = z.object({
  kind: z.literal('TEXT_CARD_ROUND'),
  schemaVersion: z.literal(TEXT_CARD_SCHEMA_VERSION),
  runIndex: z.number().int().positive(),
  roundId: idText,
  config: TextCardConfigSchema,
  status: z.enum(['OPEN', 'CLOSED']),
  closedAtMs: z.number().int().nonnegative().nullable(),
  cards: z.array(TextCardRecordSchema).max(MAX_CARDS),
}).strict().superRefine((state, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if ((state.status === 'CLOSED') !== (state.closedAtMs !== null)) bad('CLOSE_STATE_CONFLICT');
  if (new Set(state.cards.map(c => c.participantId)).size !== state.cards.length) bad('DUPLICATE_CARD_OWNER');
  for (const record of state.cards) {
    const again = validateTextCard(state.config, record.card);
    if (!again.ok || JSON.stringify(again.card) !== JSON.stringify(record.card)) { bad('CARD_CONFIG_CONFLICT'); continue; }
    if (state.status === 'OPEN' && record.judgements.length > 0) bad('JUDGED_BEFORE_CLOSE');
    const seen = new Set<string>();
    for (const judgement of record.judgements) {
      const answered = textCardAnswer(record.card, judgement.fieldId);
      if (seen.has(judgement.fieldId) || typeof answered !== 'string') bad('JUDGEMENT_FIELD_CONFLICT'); // unknown field or nothing to judge
      seen.add(judgement.fieldId);
    }
  }
});
export type TextCardRoundState = z.infer<typeof TextCardRoundStateSchema>;

/** What the caller currently considers authoritative; any difference means the request is stale. */
export interface TextCardScope { runIndex: number; roundId: string; configKey: string }

export function parseTextCardRoundState(raw: unknown): TextCardRoundState {
  const parsed = TextCardRoundStateSchema.safeParse(raw);
  if (!parsed.success) throw new TextCardError('TEXT_CARD_STATE_INVALID');
  return parsed.data;
}
export function textCardScopeOf(state: TextCardRoundState): TextCardScope {
  return { runIndex: state.runIndex, roundId: state.roundId, configKey: textCardConfigKey(state.config) };
}
function assertScope(state: TextCardRoundState, expected: TextCardScope): void {
  if (state.runIndex !== expected.runIndex || state.roundId !== expected.roundId) throw new CoreRuleError('STALE_ROUND');
  if (textCardConfigKey(state.config) !== expected.configKey) throw new TextCardError('TEXT_CARD_CONFIG_STALE');
}
function assertTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new CoreRuleError('INVALID_TIME');
}
const findCard = (state: TextCardRoundState, participantId: string) => state.cards.find(c => c.participantId === participantId);

export function createTextCardRound(input: { runIndex: number; roundId: string; config: unknown }): TextCardRoundState {
  const config = TextCardConfigSchema.safeParse(input.config);
  if (!config.success) throw new TextCardError('TEXT_CARD_CONFIG_INVALID');
  return parseTextCardRoundState({ kind: 'TEXT_CARD_ROUND', schemaVersion: TEXT_CARD_SCHEMA_VERSION,
    runIndex: input.runIndex, roundId: input.roundId, config: config.data, status: 'OPEN', closedAtMs: null, cards: [] });
}

/**
 * Atomic acceptance of one complete card. Order: stored data → scope → round open → deadline → duplicate →
 * card validation. On any failure nothing is stored and the input state is untouched. A second ordinary
 * submission never replaces an accepted card.
 */
export function submitTextCard(rawState: unknown, args: { scope: TextCardScope; participantId: string; input: unknown; timer: CoreTimer; now: number }): TextCardRoundState {
  const state = parseTextCardRoundState(rawState);
  assertScope(state, args.scope);
  assertTime(args.now);
  if (state.status !== 'OPEN') throw new TextCardError('TEXT_CARD_ROUND_CLOSED');
  if (!timerAcceptsInput(args.timer, args.now)) throw new CoreRuleError('TIME_EXPIRED');
  if (findCard(state, args.participantId)) throw new CoreRuleError('ALREADY_ANSWERED');
  const validation = validateTextCard(state.config, args.input);
  if (!validation.ok) throw new TextCardError('TEXT_CARD_INVALID', validation.issues);
  const record: TextCardRecord = { participantId: args.participantId, card: validation.card, submittedAtMs: args.now, judgements: [] };
  return parseTextCardRoundState({ ...state, cards: [...state.cards, record] });
}

/**
 * Closes the round for good (OPEN → CLOSED). This is the real lock: afterwards `submitTextCard` rejects every
 * participant — including those who never submitted — regardless of the timer. Idempotent: closing a closed
 * round returns the identical state (closedAtMs unchanged).
 */
export function closeTextCardRound(rawState: unknown, scope: TextCardScope, now: number): TextCardRoundState {
  const state = parseTextCardRoundState(rawState);
  assertScope(state, scope);
  assertTime(now);
  if (state.status === 'CLOSED') return state;
  return parseTextCardRoundState({ ...state, status: 'CLOSED', closedAtMs: now });
}

/** Reference of one concrete accepted card (scope + owner + acceptance time). A judge command must echo it. */
export function textCardRef(state: TextCardRoundState, participantId: string): string | null {
  const record = findCard(state, participantId);
  return record ? [state.runIndex, state.roundId, record.participantId, record.submittedAtMs].join('|') : null;
}

export type TextCardStatus = 'SUBMITTED' | 'LOCKED' | 'JUDGED';
/** Derived, never stored: JUDGED iff there are answered fields and every one has a judgement. */
export function textCardStatus(state: TextCardRoundState, participantId: string): TextCardStatus | null {
  const record = findCard(state, participantId);
  if (!record) return null;
  if (state.status === 'OPEN') return 'SUBMITTED';
  const answered = record.card.answers.filter(a => a.value !== null);
  const judged = new Set(record.judgements.map(j => j.fieldId));
  return answered.length > 0 && answered.every(a => judged.has(a.fieldId)) ? 'JUDGED' : 'LOCKED';
}

/**
 * Judges ONE field of ONE accepted card, only after the round is closed. `cardRef` must be the reference the
 * judge saw (otherwise TEXT_CARD_STALE_CARD). `applied` is true only for the first judgement of that field:
 * repeating the same decision returns the identical state with `applied: false`; a different decision is
 * rejected (corrections belong to the central correction path, not to a silent overwrite). No points here.
 */
export function judgeTextCardField(rawState: unknown, scope: TextCardScope, args: { participantId: string; fieldId: string; cardRef: string; decision: JudgeDecision; now: number }): { state: TextCardRoundState; applied: boolean } {
  const state = parseTextCardRoundState(rawState);
  assertScope(state, scope);
  assertTime(args.now);
  if (state.status !== 'CLOSED') throw new TextCardError('TEXT_CARD_NOT_CLOSED');
  const decision = JudgeDecisionSchema.safeParse(args.decision);
  if (!decision.success) throw new CoreRuleError('JUDGE_DECISION_UNSUPPORTED');
  const record = findCard(state, args.participantId);
  if (!record) throw new TextCardError('TEXT_CARD_NOT_FOUND');
  if (textCardRef(state, args.participantId) !== args.cardRef) throw new TextCardError('TEXT_CARD_STALE_CARD');
  const answered = textCardAnswer(record.card, args.fieldId);
  if (answered === undefined) throw new TextCardError('TEXT_CARD_FIELD_UNKNOWN');
  if (answered === null) throw new CoreRuleError('SUBMISSION_NOT_JUDGEABLE'); // an empty field has nothing to judge
  const existing = record.judgements.find(j => j.fieldId === args.fieldId);
  if (existing) {
    if (existing.decision === decision.data) return { state, applied: false };
    throw new TextCardError('TEXT_CARD_ALREADY_JUDGED');
  }
  const judged: TextCardRecord = { ...record, judgements: [...record.judgements, { fieldId: args.fieldId, decision: decision.data, judgedAtMs: args.now }] };
  const cards = state.cards.map(c => (c.participantId === record.participantId ? judged : c));
  return { state: parseTextCardRoundState({ ...state, cards }), applied: true };
}

/**
 * Neutral grouping of identical answers within THIS round and the SAME fieldId (server-internal; only after
 * the round closed). Same word in another category or round is never grouped; null is never grouped. Only
 * groups with at least two owners are returned. It decides nothing: no winner, no invalidation, no points.
 */
export function findSharedAnswers(rawState: unknown, mode: 'EXACT' | 'NORMALIZED'): Array<{ fieldId: string; participantIds: string[] }> {
  const state = parseTextCardRoundState(rawState);
  if (state.status !== 'CLOSED') throw new TextCardError('TEXT_CARD_NOT_CLOSED');
  const groups: Array<{ fieldId: string; participantIds: string[] }> = [];
  for (const def of state.config.fields) {
    const byKey = new Map<string, string[]>();
    for (const record of state.cards) {
      const value = textCardAnswer(record.card, def.fieldId);
      if (typeof value !== 'string') continue;
      const key = mode === 'EXACT' ? value : answerMatchKey(value);
      byKey.set(key, [...(byKey.get(key) ?? []), record.participantId]);
    }
    for (const owners of byKey.values()) if (owners.length > 1) groups.push({ fieldId: def.fieldId, participantIds: owners.sort() });
  }
  return groups;
}

export const TextCardProjectionSchema = z.object({
  config: TextCardConfigSchema,
  status: z.enum(['OPEN', 'CLOSED']),
  cards: z.array(z.object({
    participantId: z.string(),
    status: z.enum(['SUBMITTED', 'LOCKED', 'JUDGED']),
    card: TextCardValueSchema,
    judgements: z.array(TextCardJudgementSchema),
  }).strict()),
}).strict();
export type TextCardProjection = z.infer<typeof TextCardProjectionSchema>;

/**
 * Role/audience projection through the existing visibility helper. Cards are PLAYER_PRIVATE until `revealed`:
 * team membership grants nothing (TEAM_PRIVATE is deliberately not used), and neither do host rights, a blind
 * host, other players, viewers or displays. Judgements appear only with the reveal. The public config contains
 * no private data. This is a DOMAIN projection: a playing host must be given the PLAYER information role by
 * the engine to see his own card; without an engine nothing here proves socket/rejoin behaviour.
 */
export function projectTextCardRound(audience: ProjectionAudience, rawState: unknown, options: { revealed: boolean }): TextCardProjection {
  const state = parseTextCardRoundState(rawState);
  const cards = state.cards
    .filter(record => canView(audience, { scope: 'PLAYER_PRIVATE', ownerParticipantId: record.participantId, publiclyRevealed: options.revealed }))
    .sort((a, b) => (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0))
    .map(record => ({ participantId: record.participantId, status: textCardStatus(state, record.participantId) as TextCardStatus,
      card: record.card, judgements: options.revealed ? record.judgements : [] }));
  return { config: state.config, status: state.status, cards };
}

export { TextCardFieldDefSchema };
export type { TextCardConfig, TextCardValue };
