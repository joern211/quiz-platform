// ============================================================
// Game SDK - Shared game engine types and interfaces
// ============================================================

import { z } from 'zod';
import type { GameManifest, CoreGamePhase } from '@quiz/shared';

export const GameEndReasonSchema = z.enum(['COMPLETED', 'HOST_ABORTED', 'TECHNICAL_ABORT', 'INSUFFICIENT_PLAYERS', 'RULE_TRIGGERED_END', 'TIME_LIMIT_REACHED', 'ERROR_RECOVERY_FAILED']);
export const RoundEndReasonSchema = z.enum(['COMPLETED', 'TIME_EXPIRED', 'ANSWER_CORRECT', 'ANSWER_WRONG', 'TARGET_REACHED', 'PLAYER_GAVE_UP', 'HOST_SKIPPED', 'HOST_ABORTED', 'TECHNICAL_ABORT', 'RULE_TRIGGERED_END']);
export const EngineResultEntrySchema = z.object({ participantId: z.string(), displayName: z.string(), teamId: z.string().nullable(),
  score: z.number().int(), delta: z.number().int(), rank: z.number().int().positive() }).strict();
const resultBase = z.object({ schemaVersion: z.literal(1), roomId: z.string(), runIndex: z.number().int().positive(), gameSlug: z.string(), engineVersion: z.number().int().positive(),
  participants: z.array(EngineResultEntrySchema), winnerIds: z.array(z.string()), contentRefs: z.array(z.string()),
  durationMs: z.number().int().nonnegative().nullable(), aborted: z.boolean(), skipped: z.boolean() });
export const EngineRoundResultSchema = resultBase.extend({ roundIndex: z.number().int().nonnegative(), endReason: RoundEndReasonSchema }).strict();
export const EngineGameResultSchema = resultBase.extend({ roundCount: z.number().int().nonnegative(), endReason: GameEndReasonSchema }).strict();
export type EngineRoundResult = z.infer<typeof EngineRoundResultSchema>;
export type EngineGameResult = z.infer<typeof EngineGameResultSchema>;
export type EngineValidation = { success: true } | { success: false; error: string };
export interface EngineCommand { action: string; payload: unknown }
export interface EngineContractTypes {
  State: unknown; Setup: unknown; InitializeContext: unknown; PreflightContext: unknown; CommandContext: unknown;
  ProjectionContext: unknown; ResultContext: unknown; CommandValidationContext: unknown;
}
/** Runtime ports are server-owned; no client-supplied state is accepted here. */
export interface GameEngineContract<T extends EngineContractTypes> {
  manifest: GameManifest;
  setupSchema: z.ZodType<T['Setup'], z.ZodTypeDef, unknown>;
  contentSchema: z.ZodType<unknown>;
  createInitialState(context: T['InitializeContext']): Promise<T['State']>;
  validateSetup(input: unknown): EngineValidation;
  getLifecyclePhase(state: T['State']): CoreGamePhase;
  preflightCheck(context: T['PreflightContext']): Promise<{ status: 'READY_TO_START' | 'WARNINGS' | 'BLOCKED'; blockers: string[]; warnings: string[] }>;
  validateCommand(context: T['CommandValidationContext'], command: EngineCommand): EngineValidation;
  handleCommand(context: T['CommandContext'], command: EngineCommand): Promise<{ success: boolean; error?: string; [key: string]: unknown }>;
  applyEvent(snapshot: EngineStateSnapshot, event: unknown): EngineStateSnapshot;
  createProjection(context: T['ProjectionContext']): unknown;
  buildRoundResult(context: T['ResultContext']): EngineRoundResult;
  buildGameResult(context: T['ResultContext']): EngineGameResult;
  recovery: { supportedEngineVersions: readonly number[]; resync: 'PERSISTED_STATE'; unsafeState: 'PAUSE_AND_NOTIFY_HOST'; fallbacks: readonly string[] };
}

// Game phase states
export const GamePhaseSchema = z.enum([
  'LOBBY',
  'INTRO',
  'QUESTION',
  'REVEAL',
  'RESULTS',
  'FINAL_RESULTS',
  'ENDED',
]);

export type GamePhase = z.infer<typeof GamePhaseSchema>;

// Base player state
export interface GamePlayerState {
  id: string;
  displayName: string;
  score: number;
  connected: boolean;
  ready: boolean;
  lives?: number;
  teamId?: string;
}

// Game action types
export const GameActionTypeSchema = z.enum([
  'BUZZ',
  'ANSWER',
  'VOTE',
  'SELECT',
  'TEXT_INPUT',
  'REVEAL',
  'START',
  'NEXT',
  'SKIP',
  'KICK',
  'CHAT',
]);

export type GameActionType = z.infer<typeof GameActionTypeSchema>;

// Generic game action
export interface GameAction<T = unknown> {
  type: GameActionType;
  playerId: string;
  payload: T;
  timestamp: number;
}

// Buzzer action payload
export interface BuzzerPayload {
  questionIndex: number;
}

// Answer action payload
export interface AnswerPayload {
  questionIndex: number;
  optionId: string;
  timeMs: number;
}

// Vote action payload
export interface VotePayload {
  targetId: string;
  optionIndex?: number;
}

// Game events emitted to clients
export const GameEventSchema = z.object({
  type: z.string(),
  phase: GamePhaseSchema,
  data: z.record(z.unknown()),
  timestamp: z.number(),
  revision: z.number(),
});

export type GameEvent = z.infer<typeof GameEventSchema>;

// Question interface for quiz games
export interface GameQuestion {
  id: string;
  title?: string;
  prompt: string;
  category: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
  durationMs: number;
  points: number;
  wrongPoints: number;
  explanation?: string;
  mediaAssetId?: string;
  mediaType?: 'image' | 'audio' | 'video';
}

// Game configuration for room setup
export interface GameConfig {
  maxPlayers: number;
  minPlayers: number;
  hasTeams: boolean;
  hasBuzzer: boolean;
  hasAudio: boolean;
  hasCamera: boolean;
  hasTimer: boolean;
  timePerQuestion: number;
  pointsCorrect: number;
  pointsWrong: number;
  allowLateJoin: boolean;
}

// Scoring rule types
export const ScoringRuleTypeSchema = z.enum([
  'CORRECT_ANSWER',
  'FASTEST_ANSWER',
  'STREAK',
  'BUZZER',
  'VOTE',
  'BONUS',
]);

export type ScoringRuleType = z.infer<typeof ScoringRuleTypeSchema>;

// Score event for audit trail
export interface ScoreDelta {
  playerId: string;
  delta: number;
  reason: string;
  source: 'auto' | 'manual';
  roundIndex: number;
  moderatorId?: string;
}

// Team state for team-based games
export interface TeamState {
  id: string;
  name: string;
  score: number;
  playerIds: string[];
}

// Room game state snapshot
export interface RoomGameState {
  roomId: string;
  phase: GamePhase;
  questionIndex: number;
  questions: GameQuestion[];
  players: GamePlayerState[];
  teams?: TeamState[];
  config: GameConfig;
  stateJson: Record<string, unknown>;
  revision: number;
}

// Export all schemas for validation
export const schemas = {
  GamePhase: GamePhaseSchema,
  GameActionType: GameActionTypeSchema,
  GameEvent: GameEventSchema,
  ScoringRuleType: ScoringRuleTypeSchema,
};


const key = z.string().min(1).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), 'UNSAFE_EVENT_KEY');
export const GameStateEventSchema = z.object({
  eventId: z.string().uuid(), roomId: z.string().min(1), runIndex: z.number().int().positive(),
  gameSlug: z.string().min(1), engineVersion: z.number().int().positive(),
  baseStateVersion: z.number().int().nonnegative(), stateVersion: z.number().int().positive(),
  type: z.string().min(1).max(100), commandId: z.string().min(1).nullable(), actorId: z.string().min(1).nullable(),
  occurredAtMs: z.number().int().nonnegative(),
  checkpoint: z.boolean().default(false),
  changes: z.array(z.object({ key, value: z.unknown() }).strict()), removedKeys: z.array(key),
}).strict().superRefine((event, ctx) => {
  const keys = [...event.changes.map(change => change.key), ...event.removedKeys];
  if (new Set(keys).size !== keys.length || event.stateVersion !== event.baseStateVersion + 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_STATE_EVENT' });
});
export type GameStateEvent = z.infer<typeof GameStateEventSchema>;
export interface EngineStateSnapshot {
  roomId: string; runIndex: number; gameSlug: string; engineVersion: number;
  stateVersion: number; state: Record<string, unknown>;
}
export class GameEventError extends Error {
  readonly code: 'EVENT_SCOPE_MISMATCH' | 'EVENT_VERSION_CONFLICT' | 'INVALID_STATE_EVENT';
  constructor(code: GameEventError['code']) { super(code); this.code = code; this.name = 'GameEventError'; }
}
function serializableState(state: unknown): Record<string, unknown> {
  const encoded = JSON.stringify(state);
  if (!encoded) throw new GameEventError('INVALID_STATE_EVENT');
  const clone: unknown = JSON.parse(encoded);
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) throw new GameEventError('INVALID_STATE_EVENT');
  return clone as Record<string, unknown>;
}
/** Compact top-level changes; unchanged question pools are not duplicated per action. */
export function createStateEvent(snapshot: EngineStateSnapshot, nextState: unknown,
  metadata: Pick<GameStateEvent, 'eventId' | 'type' | 'commandId' | 'actorId' | 'occurredAtMs'> & { checkpoint?: boolean }): GameStateEvent {
  const before = metadata.checkpoint ? {} : serializableState(snapshot.state), after = serializableState(nextState);
  return GameStateEventSchema.parse({ ...metadata, roomId: snapshot.roomId, runIndex: snapshot.runIndex,
    gameSlug: snapshot.gameSlug, engineVersion: snapshot.engineVersion,
    baseStateVersion: snapshot.stateVersion, stateVersion: snapshot.stateVersion + 1,
    changes: Object.keys(after).filter(key => !Object.hasOwn(before, key) || JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(key => ({ key, value: after[key] })),
    removedKeys: Object.keys(before).filter(key => !Object.hasOwn(after, key)),
  });
}
/** Deterministic replay: no clock, random source, DB, scoring or socket effects. */
export function applyStateEvent(snapshot: EngineStateSnapshot, input: unknown): EngineStateSnapshot {
  const decoded = GameStateEventSchema.safeParse(input);
  if (!decoded.success) throw new GameEventError('INVALID_STATE_EVENT');
  const event = decoded.data;
  if (event.roomId !== snapshot.roomId || event.runIndex !== snapshot.runIndex || event.gameSlug !== snapshot.gameSlug || event.engineVersion !== snapshot.engineVersion) throw new GameEventError('EVENT_SCOPE_MISMATCH');
  if (event.baseStateVersion !== snapshot.stateVersion) throw new GameEventError('EVENT_VERSION_CONFLICT');
  const state = event.checkpoint ? {} : serializableState(snapshot.state);
  for (const key of event.removedKeys) delete state[key];
  for (const change of event.changes) Object.defineProperty(state, change.key, { value: change.value, enumerable: true, configurable: true, writable: true });
  return { ...snapshot, stateVersion: event.stateVersion, state: serializableState(state) };
}
