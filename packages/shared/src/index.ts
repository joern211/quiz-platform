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
// Single Source of Truth (Regelwerk §5.3, §14, §12.1).
//
// ACHTUNG: Dieses Modul ist bewusst in index.ts INLINE eingebettet
// (kein separates gameCatalog.ts). @quiz/shared wird in der
// Produktion als TypeScript-Quelle konsumiert (package.json main/exports
// → src/index.ts, von Node type-stripped). Nodes natives Type-Stripping
// löst RELATIVE .js→.ts-Imports NICHT auf — eine eigene Datei würde
// daher das Runtime-Loading brechen. Deshalb: eine einzige Quelldatei,
// nur bare-Module-Import (zod). Server (Catalog-API, Registry,
// Room-Create) und Web (Katalog, Kategorien, Routen) nutzen ALLE
// dieselben Daten unten.
// ------------------------------------------------------------


// ------------------------------------------------------------
// Verfügbarkeitsstatus (Regelwerk §5.3)
//   PLANNED  – noch keine Engine / keine startbare Implementierung
//   BETA     – Engine vorhanden, nicht-kritische dokumentierte offene Punkte
//   AVAILABLE– startbare Engine + vollständig getesteter Ablauf (CI grün)
//   HIDDEN   – intern/versteckt, öffentlich nicht sichtbar
// ------------------------------------------------------------
export const GameStatusSchema = z.enum(['PLANNED', 'BETA', 'AVAILABLE', 'HIDDEN']);
export type GameStatus = z.infer<typeof GameStatusSchema>;

// ------------------------------------------------------------
// Kategorien – feste Taxonomie (Anzeigebegriffe)
// Die *sichtbaren* Kategorien und deren Spielzahlen werden aus
// GAME_MANIFESTS abgeleitet (siehe deriveVisibleCategories), nicht
// hart mit Fantasiezahlen eingetragen.
// ------------------------------------------------------------
export const CatalogCategorySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  order: z.number().int(),
});
export type CatalogCategory = z.infer<typeof CatalogCategorySchema>;

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  { slug: 'quiz-wissen', name: 'Quiz & Wissen', description: 'Wissensfragen aus allen Bereichen', icon: '📚', order: 1 },
  { slug: 'buzzer-reaktion', name: 'Buzzer & Reaktion', description: 'Schnelle Reaktion und Buzzer-Spiele', icon: '🔔', order: 2 },
  { slug: 'schaetzen-sortieren', name: 'Schätzen & Sortieren', description: 'Schätzfragen und Reihenfolgen', icon: '🎯', order: 3 },
  { slug: 'bluff-taeuschung', name: 'Bluff & Täuschung', description: 'Lügen, Täuschen und Überzeugen', icon: '🎭', order: 5 },
  { slug: 'social-deduction', name: 'Social Deduction', description: 'Geheime Rollen und Verräter', icon: '🕵️', order: 6 },
  { slug: 'team-kooperation', name: 'Team & Kooperation', description: 'Gemeinsam spielen und gewinnen', icon: '👥', order: 8 },
  { slug: 'meta-spielmodi', name: 'Meta-Spielmodi', description: 'Quizabende und Turniere', icon: '🏆', order: 11 },
];

// ------------------------------------------------------------
// GameManifest – Schema (Regelwerk §5.3)
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
  status: GameStatusSchema.default('PLANNED'),
  hasBuzzer: z.boolean().default(false),
  hasTeams: z.boolean().default(false),
  hasCamera: z.boolean().default(false),
  hasAudio: z.boolean().default(false),
  hasTimer: z.boolean().default(true),
  setupSchemaVersion: z.number().int().default(1),
});

export type GameManifest = z.infer<typeof GameManifestSchema>;

// ------------------------------------------------------------
// Kanonischer Spiel-Slugs (zentral, stabil, Englisch) – Regelwerk §12.1
// ------------------------------------------------------------
export const GAME_SLUGS = {
  wissensduell: 'wissensduell',
  jeopardy: 'jeopardy',
  werIstDas: 'wer-ist-das',
  imposter: 'imposter',
  songQuiz: 'song-quiz',
  lastManStanding: 'last-man-standing',
  higherLower: 'higher-lower',
  timeline: 'timeline',
  partnerChallenge: 'partner-challenge',
  stadtLandFluss: 'stadt-land-fluss',
  sameThought: 'same-thought',
  schaetzMal: 'schaetz-mal',
  millionenfrage: 'millionenfrage',
  wahrOderFake: 'wahr-oder-fake',
  undercover: 'undercover',
  boardRace: 'board-race',
  secretAgent: 'secret-agent',
  yacht: 'yacht',
} as const;

export type CanonicalSlug = (typeof GAME_SLUGS)[keyof typeof GAME_SLUGS];

// ------------------------------------------------------------
// Legacy-Slug-Hilfen (nur für Migration / Compatibility, §5.23)
// ------------------------------------------------------------

/**
 * Alle Legacy-Slugs, die auf einen kanonischen Slug abbilden. Für Timer-
 * Restoration und Slug-Checks über die kanonische Identität, damit Räume,
 * die noch den Legacy-Slug tragen (Migration nicht gelaufen / fehlgeschlagen),
 * ebenfalls gefunden werden. (Regelwerk §5.21/§5.22/§5.23)
 */
export function legacySlugsForCanonical(canonical: string): string[] {
  return Object.entries(LEGACY_SLUG_ALIASES)
    .filter(([, c]) => c === canonical)
    .map(([legacy]) => legacy);
}

/** Kanonischer Slug plus alle erkannten Legacy-Slugs (für DB-Slug-Filter). */
export function slugWithLegacy(canonical: string): string[] {
  return [canonical, ...legacySlugsForCanonical(canonical)];
}

// ------------------------------------------------------------
// Legacy → kanonische Slug-Aliasse (Regelwerk §5.23, §12.1)
//
// Nur für Migration / Compatibility. Alte Begriffe dürfen im Runtime-Code
// nicht als Alias verwendet werden – ausschließlich über diese Tabelle.
// Regelwerk §14:
//   geo                → wissensduell   (Geo/Allgemeinwissen = Content-Kategorien)
//   weristdas          → wer-ist-das
//   wer-luegt, luegen  → imposter
//   song, song-erraten → song-quiz
//   wer-wird-millionaer→ millionenfrage
//   wahrheit-oder-fake → wahr-oder-fake
//   allgemeinwissen    → kein eigenes Game, Content-Kategorie in wissensduell
//                        (Redirect, damit alte Links nicht 404 werden)
// ------------------------------------------------------------
export const LEGACY_SLUG_ALIASES: Readonly<Record<string, CanonicalSlug>> = {
  geo: GAME_SLUGS.wissensduell,
  allgemeinwissen: GAME_SLUGS.wissensduell,
  weristdas: GAME_SLUGS.werIstDas,
  'wer-luegt': GAME_SLUGS.imposter,
  luegen: GAME_SLUGS.imposter,
  song: GAME_SLUGS.songQuiz,
  'song-erraten': GAME_SLUGS.songQuiz,
  'wer-wird-millionaer': GAME_SLUGS.millionenfrage,
  'wahrheit-oder-fake': GAME_SLUGS.wahrOderFake,
};

const CANONICAL_SLUG_SET: ReadonlySet<string> = new Set(Object.values(GAME_SLUGS));

/**
 * Resolved einen (möglicherweise Legacy-)Slug auf den kanonischen Slug.
 * Gibt den Input unverändert zurück, wenn er bereits kanonisch ist.
 * Für unbekannte Slugs (weder kanonisch noch als Legacy bekannt) wird der
 * Input ebenfalls unverändert zurückgegeben – Aufrufer entscheiden dann,
 * ob sie "nicht gefunden" melden.
 */
export function resolveCanonicalSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  if (CANONICAL_SLUG_SET.has(slug)) return slug;
  const aliased = LEGACY_SLUG_ALIASES[slug];
  return aliased ?? slug;
}

// ------------------------------------------------------------
// Kanonischer Spielekatalog (Regelwerk §14)
//
// Status-Ableitung (Regelwerk §5.28, §13.1):
//   AVAILABLE nur, wenn startbare Engine + vollständig getesteter Ablauf
//   existieren und CI grün ist. Auf main (nach PR #9) sind genau drei
//   Engines vollständig implementiert und getestet:
//     wissensduell (ehem. geo)   – E2E G4-* + Integrationstests
//     jeopardy                    – E2E J1-J10 + Integrationstests
//     wer-ist-das (ehem. weristdas) – E2E + socket-flow-Integrationstests
//   Alle weiteren Katalogeinträge haben KEINE Engine → PLANNED.
//   (Die früheren Labels song-erraten/timeline/luegen "AVAILABLE" waren
//    falsch – es existiert dafür keine startbare Engine.)
// ------------------------------------------------------------
export const GAME_MANIFESTS: GameManifest[] = [
  // ── Quiz & Wissen ──────────────────────────────────────────
  {
    slug: GAME_SLUGS.wissensduell,
    name: 'Wissensduell',
    category: 'quiz-wissen',
    shortDescription: 'Multiple-Choice-Duell mit Joker – Geo und Allgemeinwissen',
    description:
      'Das generische Wissens-Duell: Multiple-Choice-Fragen aus Content-Pools ' +
      '(Geografie, Allgemeinwissen, Geschichte, …) mit 50/50-, Spy- und Risk-Joker.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 15,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['quiz', 'joker', 'timer'],
    status: 'AVAILABLE',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.millionenfrage,
    name: 'Millionenfrage',
    category: 'quiz-wissen',
    shortDescription: 'Aufsteigende Schwierigkeit mit Jokern',
    description: 'Die klassische Quizshow mit Gewinnleiter und Jokern (Millionär-Prinzip).',
    minPlayers: 1,
    maxPlayers: 4,
    estimatedDurationMinutes: 30,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['quiz', 'show'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
  },

  // ── Buzzer & Reaktion ──────────────────────────────────────
  {
    slug: GAME_SLUGS.jeopardy,
    name: 'Jeopardy',
    category: 'buzzer-reaktion',
    shortDescription: '2 Boards, 6 Kategorien, Abstauber',
    description: 'Wähle Felder, beantworte Fragen und staube bei falschen Antworten ab.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 30,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['buzzer', 'board'],
    status: 'AVAILABLE',
    hasBuzzer: true,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.werIstDas,
    name: 'Wer ist das?',
    category: 'buzzer-reaktion',
    shortDescription: 'Bild-Fusion + zwei Namen raten (Buzzer)',
    description:
      'Pro Runde zwei Originalbilder, aus denen die Website ein einfach fusioniertes ' +
      'Spielbild erzeugt; zwei Namen bleiben vor Reveal geheim: Erster Buzzer antwortet, ' +
      'der Host bewertet. (BETA: Fusion = einfache Composite, später austauschbar durch ' +
      'echtes Morphing — Regelwerk §13.1, §15.3. Ältere Runden mit einem vorbereiteten ' +
      'Bild (setupSchemaVersion 1) bleiben lauffähig.)',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 15,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['buzzer', 'fusion'],
    status: 'BETA',
    hasBuzzer: true,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 2,
  },
  {
    slug: GAME_SLUGS.songQuiz,
    name: 'Erkenne den Song',
    category: 'buzzer-reaktion',
    shortDescription: 'Synchrones Audio, erster Buzzer antwortet',
    description:
      'Synchronisierter Song-Ausschnitt läuft, der erste Buzzer nennt Titel und Artist. ' +
      'Host prüft als Judge. (Engine in Planung – Regelwerk §15.5)',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 15,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['buzzer', 'audio'],
    status: 'PLANNED',
    hasBuzzer: true,
    hasTeams: false,
    hasCamera: false,
    hasAudio: true,
    hasTimer: false,
    setupSchemaVersion: 1,
  },

  // ── Schätzen & Sortieren ───────────────────────────────────
  {
    slug: GAME_SLUGS.timeline,
    name: 'Timeline',
    category: 'schaetzen-sortieren',
    shortDescription: 'Elemente chronologisch einordnen',
    description: 'Ordne Bilder oder Werte in die richtige Reihenfolge ein.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 20,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['sortieren'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.schaetzMal,
    name: 'Schätz mal',
    category: 'schaetzen-sortieren',
    shortDescription: 'Zahlenwerte schätzen',
    description: 'Schätze Zahlenwerte – die geringste Abweichung gewinnt.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 15,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['schaetzen'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.higherLower,
    name: 'Higher or Lower',
    category: 'schaetzen-sortieren',
    shortDescription: 'Höher oder niedriger entscheiden',
    description: 'Entscheide, ob der nächste Wert höher oder niedriger ist.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 10,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['schaetzen'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
  },

  // ── Bluff & Täuschung ──────────────────────────────────────
  {
    slug: GAME_SLUGS.imposter,
    name: 'Imposter',
    category: 'bluff-taeuschung',
    shortDescription: 'Echte und erfundene Antworten voten',
    description: 'Schreibe plausible falsche Antworten und vote für die echte Antwort.',
    minPlayers: 3,
    maxPlayers: 10,
    estimatedDurationMinutes: 20,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['bluff', 'vote'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.wahrOderFake,
    name: 'Wahr oder Fake?',
    category: 'bluff-taeuschung',
    shortDescription: 'Echte von falschen Behauptungen unterscheiden',
    description: 'Stimme ab, ob Behauptungen wahr oder erfunden sind.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 15,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['bluff', 'vote'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
  },

  // ── Social Deduction ───────────────────────────────────────
  {
    slug: GAME_SLUGS.undercover,
    name: 'Undercover',
    category: 'social-deduction',
    shortDescription: 'Geheime Begriffe, Hinweise, Voting',
    description: 'Secret-Role-/Deduction-Spiel (getrennt von Imposter): geheime Begriffe, Hinweise, Voting.',
    minPlayers: 4,
    maxPlayers: 10,
    estimatedDurationMinutes: 25,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['deduction', 'secret-role'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.secretAgent,
    name: 'Geheim Agent',
    category: 'social-deduction',
    shortDescription: 'Social Deduction mit geheimen Rollen',
    description: 'Social-Deduction-Spiel mit geheimen Rollen und Informationen.',
    minPlayers: 4,
    maxPlayers: 10,
    estimatedDurationMinutes: 25,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['deduction', 'secret-role'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
  },

  // ── Team & Kooperation ─────────────────────────────────────
  {
    slug: GAME_SLUGS.partnerChallenge,
    name: 'Wie weit gehst du?',
    category: 'team-kooperation',
    shortDescription: 'Biet-/Partner-Challenge',
    description: 'Partner-Challenge: Bieten, Aufgabe erfüllen, gegnerische Validierung.',
    minPlayers: 4,
    maxPlayers: 8,
    estimatedDurationMinutes: 25,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['team', 'bidding'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: true,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.sameThought,
    name: 'Gleicher Gedanke',
    category: 'team-kooperation',
    shortDescription: 'Assoziations-/Partner-Matching',
    description: 'Partner geben unabhängig Begriffe ein – gleiche Assoziation ergibt Erfolg.',
    minPlayers: 2,
    maxPlayers: 8,
    estimatedDurationMinutes: 15,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['team', 'association'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: true,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
  },

  // ── Meta-Spielmodi ─────────────────────────────────────────
  {
    slug: GAME_SLUGS.stadtLandFluss,
    name: 'Stadt, Land, Fluss',
    category: 'meta-spielmodi',
    shortDescription: 'Klassisches Raten in Kategorien',
    description: 'Neuer Spieltyp: Kategorien abfahren, erste gültige Antwort gewinnt den Punkt.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 20,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['raterunde'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.boardRace,
    name: 'Raus damit!',
    category: 'meta-spielmodi',
    shortDescription: 'Digitales Figuren-Rennspiel',
    description: 'Digitales Figuren-Rennspiel: Würfeln, Figuren bewegen, Heimfeld.',
    minPlayers: 2,
    maxPlayers: 6,
    estimatedDurationMinutes: 20,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['rennspiel', 'dice'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.yacht,
    name: 'Yacht',
    category: 'meta-spielmodi',
    shortDescription: 'Würfelspiel nach Kniffel-Prinzip',
    description: 'Würfelspiel nach klassischem Kniffel-Prinzip: 5 Würfel, Kategorien, Scorecard.',
    minPlayers: 1,
    maxPlayers: 8,
    estimatedDurationMinutes: 20,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['dice', 'solitär'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
  },
  {
    slug: GAME_SLUGS.lastManStanding,
    name: 'Last Man Standing',
    category: 'meta-spielmodi',
    shortDescription: 'Feste Turn Order, einzigartige Antworten',
    description: 'Letzter Überlebender: feste Turn Order, einzigartige gültige Antworten, Leben/KO.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 20,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['turn-based', 'lives'],
    status: 'PLANNED',
    hasBuzzer: false,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
  },
];

// ------------------------------------------------------------
// Abgeleitete, sichtbare Kategorien (aus den Katalogdaten)
// Regelwerk §12.1: keine doppelten Hardcodes, keine Fantasiezahlen.
// Nur Kategorien, die tatsächlich mindestens ein Spiel im Katalog
// enthalten, werden sichtbar; gameCount = echte Anzahl.
// ------------------------------------------------------------
export interface VisibleCategory extends CatalogCategory {
  gameCount: number;
  gameSlugs: string[];
}

export function deriveVisibleCategories(manifests: GameManifest[] = GAME_MANIFESTS): VisibleCategory[] {
  const bySlug = new Map<string, string[]>();
  for (const m of manifests) {
    if (m.status === 'HIDDEN') continue;
    const list = bySlug.get(m.category) ?? [];
    list.push(m.slug);
    bySlug.set(m.category, list);
  }
  const result: VisibleCategory[] = [];
  for (const cat of CATALOG_CATEGORIES) {
    const slugs = bySlug.get(cat.slug);
    if (!slugs || slugs.length === 0) continue; // nur Kategorien mit echten Spielen
    result.push({ ...cat, gameCount: slugs.length, gameSlugs: slugs });
  }
  return result;
}

// ------------------------------------------------------------
// Lookup-Helfer
// ------------------------------------------------------------
export function getGameManifest(slug: string | null | undefined): GameManifest | undefined {
  const canonical = resolveCanonicalSlug(slug);
  if (!canonical) return undefined;
  return GAME_MANIFESTS.find((m) => m.slug === canonical);
}

export function isStartableGame(status: GameStatus): boolean {
  return status === 'AVAILABLE' || status === 'BETA';
}

export const ALL_CANONICAL_SLUGS: readonly string[] = Object.values(GAME_SLUGS);

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
