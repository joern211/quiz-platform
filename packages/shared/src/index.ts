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
// Game Manifest
// ------------------------------------------------------------

export const GameManifestSchema = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  shortDescription: z.string(),
  description: z.string(),
  minPlayers: z.number().int().min(1).default(2),
  maxPlayers: z.number().int().min(1).default(10),
  estimatedDurationMinutes: z.number().int().default(15),
  roles: z.array(z.enum(['MODERATOR', 'PLAYER', 'VIEWER'])),
  tags: z.array(z.string()),
  status: z.enum(['AVAILABLE', 'BETA', 'PLANNED', 'HIDDEN']).default('PLANNED'),
  hasBuzzer: z.boolean().default(false),
  hasTeams: z.boolean().default(false),
  hasCamera: z.boolean().default(false),
  hasAudio: z.boolean().default(false),
  hasTimer: z.boolean().default(true),
  setupSchemaVersion: z.number().int().default(1),
});

export type GameManifest = z.infer<typeof GameManifestSchema>;

// ------------------------------------------------------------
// Catalog
// ------------------------------------------------------------

export const CategorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  order: z.number().int(),
});

export type Category = z.infer<typeof CategorySchema>;

export const CATALOG_CATEGORIES: Category[] = [
  { id: '1', slug: 'quiz-wissen', name: 'Quiz & Wissen', description: 'Wissensfragen aus allen Bereichen', icon: '📚', order: 1 },
  { id: '2', slug: 'buzzer-reaktion', name: 'Buzzer & Reaktion', description: 'Schnelle Reaktion und Buzzer-Spiele', icon: '🔔', order: 2 },
  { id: '3', slug: 'schaetzen-sortieren', name: 'Schätzen & Sortieren', description: 'Schätzfragen und Reihenfolgen', icon: '🎯', order: 3 },
  { id: '4', slug: 'kreativ-schreiben', name: 'Kreativ & Schreiben', description: 'Kreative Antworten und Geschichten', icon: '✏️', order: 4 },
  { id: '5', slug: 'bluff-taeuschung', name: 'Bluff & Täuschung', description: 'Lügen, Täuschen und Überzeugen', icon: '🎭', order: 5 },
  { id: '6', slug: 'social-deduction', name: 'Social Deduction', description: 'Geheime Rollen und Verräter', icon: '🕵️', order: 6 },
  { id: '7', slug: 'medien-erkennen', name: 'Medien & Erkennen', description: 'Bilder, Sounds und Medien erraten', icon: '🎬', order: 7 },
  { id: '8', slug: 'team-kooperation', name: 'Team & Kooperation', description: 'Gemeinsam spielen und gewinnen', icon: '👥', order: 8 },
  { id: '9', slug: 'freundesgruppe-insider', name: 'Freundesgruppe & Insider', description: 'Fragen über die Gruppe', icon: '💬', order: 9 },
  { id: '10', slug: 'minigames', name: 'Minigames', description: 'Kurze Spaßspiele', icon: '🎮', order: 10 },
  { id: '11', slug: 'meta-spielmodi', name: 'Meta-Spielmodi', description: 'Quizabende und Turniere', icon: '🏆', order: 11 },
];

export const GAME_MANIFESTS: GameManifest[] = [
  // Kategorie 1: Quiz & Wissen
  { slug: 'geo', name: 'Geografie-Quiz', category: 'quiz-wissen', setupSchemaVersion: 1, shortDescription: 'Multiple-Choice Quiz mit Joker', description: 'Teste dein Geografie-Wissen mit vier Antwortoptionen und nutze Joker.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 15, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['quiz', 'joker', 'timer'], status: 'AVAILABLE', hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: true, hasTimer: true },
  { slug: 'allgemeinwissen', name: 'Allgemeinwissen-Quiz', category: 'quiz-wissen', setupSchemaVersion: 1, shortDescription: 'Fragen aus allen Wissensgebieten', description: 'Allgemeinwissen aus verschiedenen Bereichen.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 15, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['quiz'], status: 'PLANNED', hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
  { slug: 'wer-wird-millionaer', name: 'Wer wird Millionär', category: 'quiz-wissen', setupSchemaVersion: 1, shortDescription: 'Aufsteigende Schwierigkeit mit Jokern', description: 'Die klassische Quizshow mit Gewinnleiter und Jokern.', minPlayers: 1, maxPlayers: 4, estimatedDurationMinutes: 30, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['quiz', 'show'], status: 'PLANNED', hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
  
  // Kategorie 2: Buzzer & Reaktion
  { slug: 'jeopardy', name: 'Jeopardy', category: 'buzzer-reaktion', setupSchemaVersion: 1, shortDescription: '2 Boards, 6 Kategorien, Abstauber', description: 'Wähle Felder, beantworte Fragen und staube bei falschen Antworten ab.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 30, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['buzzer', 'board'], status: 'AVAILABLE', hasBuzzer: true, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
  { slug: 'song-erraten', name: 'Erkenne den Song', category: 'buzzer-reaktion', setupSchemaVersion: 1, shortDescription: 'Musik-Buzzer-Spiel', description: 'Höre Clips und sei der Erste, der Titel und Interpret nennt.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 20, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['buzzer', 'audio'], status: 'AVAILABLE', hasBuzzer: true, hasTeams: false, hasCamera: false, hasAudio: true, hasTimer: false },
  { slug: 'wer-ist-das', name: 'Wer ist das?', category: 'buzzer-reaktion', setupSchemaVersion: 1, shortDescription: 'Fusionbilder erkennen', description: 'Errate welche beiden Personen im Fusionsbild stecken.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 15, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['buzzer', 'fusion'], status: 'AVAILABLE', hasBuzzer: true, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
  
  // Kategorie 3: Schätzen & Sortieren
  { slug: 'timeline', name: 'Timeline', category: 'schaetzen-sortieren', setupSchemaVersion: 1, shortDescription: 'Elemente chronologisch einordnen', description: 'Ordne Bilder oder Werte in die richtige Reihenfolge ein.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 20, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['sortieren', 'leben'], status: 'PLANNED', hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
  { slug: 'schaetz-mal', name: 'Schätz mal', category: 'schaetzen-sortieren', setupSchemaVersion: 1, shortDescription: 'Zahlenwerte schätzen', description: 'Schätze Zahlenwerte - die geringste Abweichung gewinnt.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 15, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['schaetzen'], status: 'PLANNED', hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: true },
  { slug: 'higher-lower', name: 'Higher or Lower', category: 'schaetzen-sortieren', setupSchemaVersion: 1, shortDescription: 'Höher oder niedriger entscheiden', description: 'Entscheide ob der nächste Wert höher oder niedriger ist.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 10, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['schaetzen'], status: 'PLANNED', hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
  
  // Kategorie 5: Bluff & Täuschung
  { slug: 'wer-luegt', name: 'Wer lügt am besten?', category: 'bluff-taeuschung', setupSchemaVersion: 1, shortDescription: 'Echte und erfundene Antworten voten', description: 'Schreibe plausible falsche Antworten und vote für die beste Lüge.', minPlayers: 3, maxPlayers: 10, estimatedDurationMinutes: 20, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['bluff', 'vote'], status: 'AVAILABLE', hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
  { slug: 'wahrheit-oder-fake', name: 'Wahrheit oder Fake?', category: 'bluff-taeuschung', setupSchemaVersion: 1, shortDescription: 'Echte von falschen Behauptungen unterscheiden', description: 'Stimme ab ob Behauptungen wahr oder erfunden sind.', minPlayers: 2, maxPlayers: 10, estimatedDurationMinutes: 15, roles: ['MODERATOR', 'PLAYER', 'VIEWER'], tags: ['bluff', 'vote'], status: 'PLANNED', hasBuzzer: false, hasTeams: false, hasCamera: false, hasAudio: false, hasTimer: false },
];

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

export type ScoreEvent = z.infer<typeof GameManifestSchema>;
