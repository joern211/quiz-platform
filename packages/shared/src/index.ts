// ============================================================
// Online Quiz Plattform - Shared Types & Schemas
// Zentraler Vertrag zwischen Client und Server
// ============================================================

import { z } from 'zod';

// ------------------------------------------------------------
// Basis-Typen
// ------------------------------------------------------------

export type RoomCode = string; // Format: NNN-NNN (z.B. "123-456")
export type UUID = string;
export type ISO8601 = string;
export type UnixMs = number;

export type UserRole = 'ADMIN' | 'MODERATOR';
export type PlayerRole = 'MODERATOR' | 'PLAYER' | 'VIEWER';

export type RoomStatus = 'CREATED' | 'LOBBY' | 'RUNNING' | 'ENDED' | 'ARCHIVED';
export type RunPhase =
  | 'DRAFT' | 'VALIDATING'           // CREATED
  | 'OPEN' | 'LOCKED' | 'STARTING_COUNTDOWN'  // LOBBY
  | 'INTRO' | 'ROUND_ACTIVE' | 'ROUND_LOCKED' | 'REVEAL' | 'PAUSED' | 'INTERMISSION'  // RUNNING
  | 'RESULTS' | 'REMATCH_PENDING';   // ENDED

// ------------------------------------------------------------
// Client/Server Event Envelopes
// ------------------------------------------------------------

export interface ClientCommand<T = unknown> {
  requestId: string;
  roomCode: RoomCode;
  expectedRevision?: number;
  clientTime?: number;
  payload: T;
}

export interface ServerEvent<T = unknown> {
  eventId: string;
  roomCode: RoomCode;
  revision: number;
  serverTime: UnixMs;
  type: string;
  payload: T;
}

// ------------------------------------------------------------
// User / Session
// ------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1).max(50),
  role: z.enum(['ADMIN', 'MODERATOR']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  disabledAt: z.string().datetime().nullable(),
});

export type User = z.infer<typeof UserSchema>;

// ------------------------------------------------------------
// Room
// ------------------------------------------------------------

export const RoomConfigSchema = z.object({
  maxPlayers: z.number().int().min(2).max(10).default(10),
  cameraEnabled: z.boolean().default(false),
  allowViewers: z.boolean().default(true),
  viewerRequiresPin: z.boolean().default(true),
  viewerLimit: z.number().int().min(1).max(50).default(50),
  lobbyChatEnabled: z.boolean().default(true),
  pin: z.string().optional(),
});

export type RoomConfig = z.infer<typeof RoomConfigSchema>;

export const RoomSchema = z.object({
  id: z.string().uuid(),
  code: z.string().regex(/^\d{3}-\d{3}$/),
  roomName: z.string().min(1).max(100),
  gameSlug: z.string(),
  status: z.enum(['CREATED', 'LOBBY', 'RUNNING', 'ENDED', 'ARCHIVED']),
  runPhase: z.string(),
  hostUserId: z.string().uuid(),
  pinHash: z.string().nullable(),
  config: RoomConfigSchema,
  setupSnapshotJson: z.record(z.unknown()),
  setupSchemaVersion: z.number().int(),
  revision: z.number().int(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  archivedAt: z.string().datetime().nullable(),
  eventSeriesId: z.string().uuid().nullable(),
});

export type Room = z.infer<typeof RoomSchema>;

// ------------------------------------------------------------
// Participation
// ------------------------------------------------------------

export const AvatarSchema = z.object({
  mode: z.enum(['none', 'avatar', 'camera']),
  assetId: z.string().uuid().optional(),
  generated: z.object({
    initials: z.string().max(3),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    icon: z.string().optional(),
  }).optional(),
});

export type Avatar = z.infer<typeof AvatarSchema>;

export const PlayerProfileSchema = z.object({
  displayName: z.string().min(1).max(50),
  avatar: AvatarSchema,
  preferredVideoDeviceId: z.string().optional(),
  preferredAudioDeviceId: z.string().optional(),
});

export type PlayerProfile = z.infer<typeof PlayerProfileSchema>;

export const ParticipationSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  displayName: z.string(),
  normalizedName: z.string(),
  avatar: AvatarSchema,
  role: z.enum(['MODERATOR', 'PLAYER', 'VIEWER']),
  connected: z.boolean(),
  ready: z.boolean(),
  kickedAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime(),
  score: z.number().int().default(0),
  lives: z.number().int().optional(),
  teamId: z.string().uuid().nullable(),
  rejoinToken: z.string(),
  rejoinTokenVersion: z.number().int(),
});

export type Participation = z.infer<typeof ParticipationSchema>;

// ------------------------------------------------------------
// Geo-Quiz Types
// ------------------------------------------------------------

export const GeoOptionSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
});

export const GeoQuestionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().optional(),
  prompt: z.string().min(1),
  category: z.string(),
  mediaAssetId: z.string().uuid().optional(),
  mediaType: z.enum(['image', 'audio']).optional(),
  options: z.tuple([GeoOptionSchema, GeoOptionSchema, GeoOptionSchema, GeoOptionSchema]),
  correctOptionId: z.string().uuid(),
  explanation: z.string().optional(),
  durationMs: z.number().int().min(5000).default(20000),
  points: z.number().int().min(0).default(100),
  wrongPoints: z.number().int().default(0),
  enabled: z.boolean().default(true),
});

export type GeoQuestion = z.infer<typeof GeoQuestionSchema>;
export type GeoOption = z.infer<typeof GeoOptionSchema>;

export const GeoSetupSchema = z.object({
  questionPoolId: z.string().uuid().optional(),
  selectedQuestionIds: z.array(z.string().uuid()).optional(),
  randomFill: z.boolean().default(true),
  categories: z.array(z.string()).optional(),
  timerMs: z.number().int().min(5000).default(20000),
  points: z.number().int().min(0).default(100),
  wrongPoints: z.number().int().default(0),
  joker5050Count: z.number().int().min(0).max(1).default(1),
  spyCount: z.number().int().min(0).max(1).default(1),
  riskCount: z.number().int().min(0).max(1).default(1),
  speedBonus: z.boolean().default(false),
  // Joker-Verbrauch pro Spieler
  jokerUsage: z.record(z.object({
    used5050: z.boolean().default(false),
    usedSpy: z.boolean().default(false),
    usedRisk: z.boolean().default(false),
  })).optional(),
});

export type GeoSetup = z.infer<typeof GeoSetupSchema>;

// ------------------------------------------------------------
// Geo Game State
// ------------------------------------------------------------

export const GeoPlayerStateSchema = z.object({
  answered: z.boolean().default(false),
  selectedOptionId: z.string().uuid().nullable(),
  locked: z.boolean().default(false),
  score: z.number().int().default(0),
  jokers: z.object({
    used5050: z.boolean().default(false),
    usedSpy: z.boolean().default(false),
    usedRisk: z.boolean().default(false),
  }),
  eliminated: z.boolean().default(false),
});

export const GeoRoundStateSchema = z.object({
  questionIndex: z.number().int(),
  question: GeoQuestionSchema,
  revealed: z.boolean().default(false),
  timerStartMs: z.number().int().nullable(),
  timerEndMs: z.number().int().nullable(),
  buzzWinnerId: z.string().uuid().nullable(),
  buzzOpen: z.boolean().default(false),
  playerStates: z.record(z.string(), GeoPlayerStateSchema),
  spyDistribution: z.record(z.string(), z.number()).nullable().optional(), // optionId -> percentage
});

export const GeoGameStateSchema = z.object({
  phase: z.enum(['INTRO', 'PROMPT', 'INPUT_OPEN', 'INPUT_LOCKED', 'BUZZ_OPEN', 'JUDGING', 'REVEAL', 'SCORING', 'ROUND_END', 'GAME_END']),
  currentRoundIndex: z.number().int(),
  questions: z.array(GeoQuestionSchema),
  roundStates: z.array(GeoRoundStateSchema),
  scores: z.record(z.string(), z.number().int()), // participationId -> totalScore
});

export type GeoPlayerState = z.infer<typeof GeoPlayerStateSchema>;
export type GeoRoundState = z.infer<typeof GeoRoundStateSchema>;
export type GeoGameState = z.infer<typeof GeoGameStateSchema>;

// ------------------------------------------------------------
// Game Manifest & Kanonischer Spielekatalog
// Single Source of Truth: gameCatalog.ts (Regelwerk §5.3, §14, §12.1)
// Server (Catalog-API, Registry, Room-Create) und Web (Katalog,
// Kategorien, Routen) nutzen ALLE dieselben Daten.
// ------------------------------------------------------------

export {
  GameStatusSchema,
  CatalogCategorySchema,
  GameManifestSchema,
  CATALOG_CATEGORIES,
  GAME_MANIFESTS,
  GAME_SLUGS,
  LEGACY_SLUG_ALIASES,
  ALL_CANONICAL_SLUGS,
  resolveCanonicalSlug,
  getGameManifest,
  deriveVisibleCategories,
  isStartableGame,
} from './gameCatalog.js';

export type {
  GameStatus,
  CatalogCategory,
  GameManifest,
  VisibleCategory,
  CanonicalSlug,
} from './gameCatalog.js';

// ------------------------------------------------------------
// API Response Types
// ------------------------------------------------------------

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ------------------------------------------------------------
// Lobby Chat
// ------------------------------------------------------------

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  senderId: z.string().uuid().nullable(), // null for system
  senderName: z.string(),
  content: z.string().max(300),
  createdAt: z.string().datetime(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ------------------------------------------------------------
// Score Events (Audit Trail)
// ------------------------------------------------------------

export const ScoreEventSchema = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  participationId: z.string().uuid(),
  roundIndex: z.number().int(),
  delta: z.number().int(),
  reason: z.string(),
  source: z.enum(['auto', 'manual']),
  moderatorId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});

export type ScoreEvent = z.infer<typeof ScoreEventSchema>;

// ============================================================
// API Contract — Request / Response Schemas
// ============================================================

// ── POST /api/v1/rooms ──────────────────────────────────────

export const CreateRoomInputSchema = z.object({
  gameSlug: z.string().optional(),
  gameDefinitionId: z.string().uuid().optional(),
  roomName: z.string().min(1).max(100),
  pin: z.string().max(10).optional(),
  maxPlayers: z.number().int().min(2).max(10).default(10),
  cameraEnabled: z.boolean().default(false),
  allowViewers: z.boolean().default(true),
  viewerRequiresPin: z.boolean().default(true),
  viewerLimit: z.number().int().min(1).max(50).default(50),
  lobbyChatEnabled: z.boolean().default(true),
  setupSnapshotJson: z.record(z.unknown()).optional(),
});

export type CreateRoomInput = z.infer<typeof CreateRoomInputSchema>;

export const CreateRoomResponseSchema = z.object({
  code: z.string().regex(/^\d{3}-\d{3}$/),
  roomId: z.string().uuid(),
});

export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

// ── POST /api/v1/rooms/:code/join ───────────────────────────

export const JoinRoomInputSchema = z.object({
  displayName: z.string().min(1).max(50),
  pin: z.string().max(10).optional(),
});

export type JoinRoomInput = z.infer<typeof JoinRoomInputSchema>;

export const JoinRoomResponseSchema = z.object({
  rejoinToken: z.string(),
  participationId: z.string().uuid(),
  role: z.enum(['MODERATOR', 'PLAYER', 'VIEWER']),
  roomCode: z.string().regex(/^\d{3}-\d{3}$/),
});

export type JoinRoomResponse = z.infer<typeof JoinRoomResponseSchema>;

// ── POST /api/v1/auth/login ─────────────────────────────────

export const LoginInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof LoginInputSchema>;

export const LoginResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    role: z.enum(['ADMIN', 'MODERATOR']),
  }),
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ── POST /api/v1/setups ─────────────────────────────────────

export const SetupInputSchema = z.object({
  gameDefinitionId: z.string().uuid(),
  config: z.record(z.unknown()).optional(),
  content: z.record(z.unknown()).optional(),
});

export type SetupInput = z.infer<typeof SetupInputSchema>;

export const CreateSetupResponseSchema = z.object({
  id: z.string().uuid(),
});

export type CreateSetupResponse = z.infer<typeof CreateSetupResponseSchema>;

// ── GET /api/v1/setups/:id ──────────────────────────────────

export const SetupResponseSchema = z.object({
  id: z.string().uuid(),
  game: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    category: z.string(),
  }),
  config: z.record(z.unknown()),
  content: z.record(z.unknown()),
  schemaVersion: z.number().int(),
  isValid: z.boolean(),
  validationErrors: z.array(z.object({
    field: z.string(),
    message: z.string(),
  })).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SetupResponse = z.infer<typeof SetupResponseSchema>;
