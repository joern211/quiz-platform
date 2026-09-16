// ============================================================
// Game SDK - Shared game engine types and interfaces
// ============================================================

import { z } from 'zod';

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
