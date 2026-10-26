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

// ============================================================
// Kanonische Rollen (BASIS-STANDARDS, Master §2.1, §12.1)
// ------------------------------------------------------------
// „Moderator" wird als Begriff vollständig durch HOST ersetzt.
// ADMIN/HOST/PLAYER/VIEWER/DISPLAY sind die globalen Rollen-Kontexte.
// NUR diese Werte gelten im Runtime-Code, in Schemas, im DB-Wert (nach
// Migration) und in der UI. Der alte Wert `MODERATOR` bleibt ausschließlich
// in abgegrenzter Migration/Compatibility (LEGACY_PARTICIPATION_ROLE_MAP,
// LEGACY_ROLE_VALUES) und in bewusst erhaltenen Legacy-URL-Routen (/moderator/*).
//
// Trennung (Master §2.2): Accountrolle (ADMIN/HOST), aktive Teilnahme
// (HOST/PLAYER/VIEWER) und Projektions-/Informationskontext sind getrennt.
// Eine HOST-Rolle ist KEIN pauschaler Anspruch auf Player-Geheimnisse oder
// fremde Lösungsdaten — das regeln die Permissions (unten) und die
// Projektionen, nicht die Rolle selbst.
// ============================================================
export const ACCOUNT_ROLES = ['ADMIN', 'HOST'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export const PARTICIPATION_ROLES = ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'] as const;
export type ParticipationRole = (typeof PARTICIPATION_ROLES)[number];

export const PLATFORM_ROLES = ['ADMIN', 'HOST', 'PLAYER', 'VIEWER', 'DISPLAY'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

// Kompatibilität: alte, bereits verteilte Typnamen. Verweisen nur noch auf
// die kanonischen Mengen — `MODERATOR` ist NICHT mehr ein gültiger Wert.
export type UserRole = AccountRole;
export type PlayerRole = ParticipationRole;

export function isAccountRole(r: string): r is AccountRole {
  return (ACCOUNT_ROLES as readonly string[]).includes(r);
}
export function isParticipationRole(r: string): r is ParticipationRole {
  return (PARTICIPATION_ROLES as readonly string[]).includes(r);
}
/**
 * Eindeutige Normalisierung LEGACY → kanonisch. Unbekannte Werte werden
 * NIE still gecastet: `normalizeRole` gibt `null` zurück, der Aufrufer
 * entscheidet (Ablehnung vs. Fallback). Kein allgemeiner String-Cast.
 *
 * Audit PR14, 14-10: Der Legacy-Lookup läuft über ein Objekt OHNE
 * Prototype (`Object.create(null)`) und das Ergebnis wird zusätzlich
 * gegen die kanonische Rollenmenge geprüft. Damit liefern Prototype-
 * Namen wie `constructor`/`__proto__`/`toString` keine geerbten Werte
 * mehr (vorher: `LEGACY_ROLE_VALUES['constructor']` = geerbte
 * Object-Konstruktorfunktion) und kein fremder String kann als Rolle
 * durchgehen.
 */
export const LEGACY_ROLE_VALUES: Readonly<Record<string, PlatformRole>> = Object.assign(
  Object.create(null) as Record<string, PlatformRole>,
  { MODERATOR: 'HOST' },
);
export function normalizeRole(value: string | null | undefined): PlatformRole | null {
  if (!value) return null;
  if ((PLATFORM_ROLES as readonly string[]).includes(value)) return value as PlatformRole;
  if (!Object.prototype.hasOwnProperty.call(LEGACY_ROLE_VALUES, value)) return null;
  const mapped = (LEGACY_ROLE_VALUES as Record<string, PlatformRole>)[value];
  return (PLATFORM_ROLES as readonly string[]).includes(mapped) ? mapped : null;
}

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
  role: z.enum(['ADMIN', 'HOST']),
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
  role: z.enum(['HOST', 'PLAYER', 'VIEWER', 'DISPLAY']),
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
export const GameCapabilitySchema = z.enum([
  'TIMER',
  'BUZZER',
  'TEAMS',
  'SUBMISSIONS',
  'JUDGE',
  'VOICE',
  'CAMERA',
  'VIEWER',
  'BROADCAST',
  'LATE_JOIN',
  'BLIND_HOST',
  'CONTENT_POOLS',
  'ROUND_RESTART',
  'TEAM_RESHUFFLE',
]);
export type GameCapability = z.infer<typeof GameCapabilitySchema>;

export const GameManifestSchema = z.object({
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  shortDescription: z.string(),
  description: z.string(),
  minPlayers: z.number().int().min(1).default(2),
  maxPlayers: z.number().int().min(1).default(10),
  estimatedDurationMinutes: z.number().int().default(15),
  roles: z.array(z.enum(['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'])),
  tags: z.array(z.string()),
  status: GameStatusSchema.default('PLANNED'),
  hasBuzzer: z.boolean().default(false),
  hasTeams: z.boolean().default(false),
  hasCamera: z.boolean().default(false),
  hasAudio: z.boolean().default(false),
  hasTimer: z.boolean().default(true),
  setupSchemaVersion: z.number().int().optional().default(1),
  // ── BASIS-STANDARDS: vollständige §5.3-Feldliste (additiv, ehrlich) ──
  // Diese Felder beschreiben den REALEN Implementierungsstand. Ein gesetztes
  // optionales Feld aktiviert KEIN Feature — Capability/Status entscheiden
  // (§5.4). engineVersion ist die versionierte Engine-Kennung.
  engineVersion: z.number().int().optional().default(1),
  capabilities: z.array(GameCapabilitySchema).optional().default([]),
  lateJoin: z.boolean().optional().default(false),
  viewer: z.boolean().optional().default(true),
  broadcast: z.boolean().optional().default(false),
  // Inhaltstyp des Spiels (Content-System, Master §5.3 Content-Typ).
  contentType: z.enum(['questions', 'board', 'media', 'freeform', 'none']).optional().default('questions'),
});
export type GameManifestInput = z.input<typeof GameManifestSchema>;
/**
 * Vollständiges Manifest NACH Default-Auflösung: alle Basis-Felder und die
 * §5.3-Erweiterung sind zwingend vorhanden (Herkunft nachvollziehbar).
 * Der Katalog `GAME_MANIFESTS` darf weiterhin Eingaben ohne die optionalen
 * Basis-Felder liefern — `normalizeManifest()` liefert die aufgelöste Form.
 */
export const GameManifestResolvedSchema = GameManifestSchema;
export type GameManifestResolved = z.output<typeof GameManifestSchema>;
export function normalizeManifest(input: GameManifestInput): GameManifestResolved {
  return GameManifestSchema.parse(input);
}

export type GameManifest = z.infer<typeof GameManifestSchema>;
export type GameManifestSpec = z.input<typeof GameManifestSchema>;

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
export const GAME_MANIFESTS: GameManifestSpec[] = [
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
    tags: ['quiz', 'joker', 'timer'],
    status: 'AVAILABLE',
    hasBuzzer: false,
    hasTeams: true,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
    engineVersion: 1,
    capabilities: ['TEAMS', 'LATE_JOIN', 'TEAM_RESHUFFLE', 'SUBMISSIONS', 'JUDGE', 'TIMER', 'CONTENT_POOLS', 'BLIND_HOST', 'VIEWER'],
    lateJoin: true,
    viewer: true,
    broadcast: false,
    contentType: 'questions',
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
    tags: ['buzzer', 'board'],
    status: 'AVAILABLE',
    hasBuzzer: true,
    hasTeams: true,
    hasCamera: false,
    hasAudio: false,
    hasTimer: true,
    setupSchemaVersion: 1,
    engineVersion: 1,
    capabilities: ['TEAMS', 'LATE_JOIN', 'TEAM_RESHUFFLE', 'BUZZER', 'JUDGE', 'TIMER', 'CONTENT_POOLS', 'BLIND_HOST', 'VIEWER'],
    lateJoin: true,
    viewer: true,
    broadcast: false,
    contentType: 'board',
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
    tags: ['buzzer', 'fusion'],
    status: 'BETA',
    hasBuzzer: true,
    hasTeams: true,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 2,
    // Audit PR14, 14-04: Manifest trägt die TATSÄCHLICHE Engine-Version
    // (v2: Composite-Setup, rollenbasierte Projektion) — war fälschlich 1.
    engineVersion: 2,
    capabilities: ['TEAMS', 'LATE_JOIN', 'TEAM_RESHUFFLE', 'BUZZER', 'JUDGE', 'CONTENT_POOLS', 'VIEWER'],
    lateJoin: true,
    viewer: true,
    broadcast: false,
    contentType: 'media',
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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
    roles: ['HOST', 'PLAYER', 'VIEWER', 'DISPLAY'],
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

export function deriveVisibleCategories(manifests: GameManifestSpec[] = GAME_MANIFESTS): VisibleCategory[] {
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
  const spec = GAME_MANIFESTS.find((m) => m.slug === canonical);
  if (!spec) return undefined;
  // Auflösung der §5.3-Defaults, damit Konsumenten immer das vollständige,
  // herkunftsbekannte Manifest erhalten (Single Source of Truth).
  return normalizeManifest(spec);
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
  role: z.enum(['HOST', 'PLAYER', 'VIEWER', 'DISPLAY']),
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
    role: z.enum(['ADMIN', 'HOST']),
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

// ============================================================
// BASIS-STANDARDS — Gemeinsame Verträge (Master §2, §5, §10, §12)
// ------------------------------------------------------------
// Diese Blöcke sind die zentrale, von echten HTTP-/Socket-/Frontend-Flows
// genutzte Grundlage. Sie bleiben bewusst in dieser EINEN Datei, weil
// @quiz/shared in der Produktion als TypeScript-Quelle konsumiert wird und
// Node's natives Type-Stripping relative .js→.ts-Imports nicht auflöst.
// Nur bare-Module-Import (zod) ist sicher.
// ============================================================

// ------------------------------------------------------------
// Protocol Versioning (Master §12.4)
//   protocolVersion=1 für /api/v1 und Socket-Handshake.
//   Breaking change = Major; compatible additions = same version.
//   Laufende Session behält die Version (Rejoin/Resync).
// ------------------------------------------------------------
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];
export function isSupportedProtocolVersion(v: unknown): v is number {
  return typeof v === 'number' && (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(v);
}
/**
 * Legacy-Client ohne protocolVersion: wird NUR über diesen dokumentierten,
 * getesteten Kompatibilitätsweg auf PROTOCOL_VERSION gemappt (nicht auf
 * "unbekannt"). Fehlt das Feld, gilt Version 1 — abweichende, explizit
 * inkompatible Werte werden VOR einer Mutation mit CLIENT_VERSION_UNSUPPORTED
 * abgelehnt (siehe Fehlervertrag).
 */
export function resolveProtocolVersion(explicit: unknown): number {
  if (explicit === undefined || explicit === null) return PROTOCOL_VERSION;
  return explicit as number;
}

// ------------------------------------------------------------
// Error / Result Contract (Master §12.2, §12.13)
//   Struktur: code, messageKey, traceId (+ optional details, retryable).
//   Das bisherige lesbare `message` bleibt im Kompatibilitätsfenster erhalten
//   (Field `message` in AppError), solange es Clients brauchen.
// ------------------------------------------------------------
export const ERROR_CODES = [
  'NOT_AUTHENTICATED',
  'NOT_AUTHORIZED',
  'RESOURCE_NOT_ACCESSIBLE',
  'OWNERSHIP_REQUIRED',
  'SCOPE_VIOLATION',
  'ROLE_REQUIRED',
  'INVALID_PAYLOAD',
  'INVALID_PHASE',
  'STALE_STATE',
  'REVISION_CONFLICT',
  'ALREADY_PROCESSED',
  'COMMAND_CONFLICT',
  'ROOM_LOCKED',
  'ROOM_NOT_FOUND',
  'WRONG_ROOM',
  'PLAYER_NOT_FOUND',
  'CONTENT_NOT_READY',
  'CLIENT_VERSION_UNSUPPORTED',
  'RATE_LIMITED',
  'RECOVERY_REQUIRED',
  'GAME_NOT_IMPLEMENTED',
  'GAME_NOT_RUNNING',
  'GAME_NOT_STARTED',
  'GAME_ALREADY_STARTED',
  'GAME_NOT_STARTABLE',
  'NOT_ENOUGH_PLAYERS',
  'NOT_ALL_READY',
  'VIEWERS_CANNOT_MODIFY',
  'NO_PARTICIPATION',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const AppErrorSchema = z.object({
  code: z.string(),
  messageKey: z.string(),
  message: z.string().optional(),
  traceId: z.string(),
  details: z.record(z.unknown()).optional(),
  retryable: z.boolean().optional(),
});
export type AppError = z.infer<typeof AppErrorSchema>;

export interface AppResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: AppError;
}

// ------------------------------------------------------------
// Permission Core (Master §2.3, §2.2)
//   Granulare Rechte; Rollen liefern Defaultpakete; wirksame Rechte
//   = Default ± erlaubte Grants/Entzüge (pro Recht, pro Raum).
//   Verwaltungs- und Secret-/Informationsrechte werden GETRENNT ausgewertet.
// ------------------------------------------------------------
export const GAME_PERMISSIONS = [
  'GAME_START',
  'GAME_PAUSE',
  'ROUND_ADVANCE',
  'JUDGE_ANSWER',
  'SCORE_ADJUST',
  'BUZZER_CONTROL',
  'TIMER_CONTROL',
  'REVEAL_CONTENT',
  'TEAM_MANAGE',
  'PLAYER_MANAGE',
  'GAME_ABORT',
] as const;
export type GamePermission = (typeof GAME_PERMISSIONS)[number];

/** Rechte, die eine Spiel-Informations-/Geheimquelle öffnen (getrennt von Verwaltung). */
export const SECRET_PERMISSIONS: readonly GamePermission[] = ['JUDGE_ANSWER', 'REVEAL_CONTENT', 'SCORE_ADJUST'];

export const ROLE_PERMISSION_PACKAGES: Record<AccountRole, readonly GamePermission[]> = {
  // ADMIN darf die Plattform administrieren und jede Rolle annehmen — im
  // normalen Spielbetrieb gelten aber die Secret-Regeln nach der aktuellen
  // Spielrolle (§2.1). Das Paket trägt die Verwaltungsrechte; Secret-Zugriff
  // kommt nur über die aktuelle Spielrolle, nicht automatisch.
  ADMIN: [
    'GAME_START', 'GAME_PAUSE', 'ROUND_ADVANCE', 'JUDGE_ANSWER', 'SCORE_ADJUST',
    'BUZZER_CONTROL', 'TIMER_CONTROL', 'REVEAL_CONTENT', 'TEAM_MANAGE', 'PLAYER_MANAGE', 'GAME_ABORT',
  ],
  // HOST = eingeloggter Raum-Verwalter. Administrative Rechte; JUDGE/REVEAL/
  // SCORE_ADJUST sind SECRET-Rechte und werden projektionsseitig zusätzlich
  // durch die Spielkontext-Gates begrenzt (ein spielender Host sieht dadurch
  // keine Player-Geheimnisse, §2.1/§2.2).
  HOST: [
    'GAME_START', 'GAME_PAUSE', 'ROUND_ADVANCE', 'JUDGE_ANSWER', 'SCORE_ADJUST',
    'BUZZER_CONTROL', 'TIMER_CONTROL', 'REVEAL_CONTENT', 'TEAM_MANAGE', 'PLAYER_MANAGE', 'GAME_ABORT',
  ],
};

/**
 * Spielerische Basisrechte: mit diesen Rechten ist eine ACTIVE Teilnahme
 * (nicht nur Beobachtung) möglich. Der Guard prüft Rolle UND Recht — ein
 * Player/Viewer, der eine Hostrolle fälscht, scheitert am Rechtesatz
 * (VIEWER/Pure-Viewer haben KEINE dieser Rechte).
 */
/**
 * Spielerische Basisrechte: mit diesen Rechten ist eine ACTIVE Teilnahme
 * (nicht nur Beobachtung) möglich. Der Guard prüft Rolle UND Recht.
 */
export const PLAYER_PLAY_PERMISSIONS: readonly GamePermission[] = ['BUZZER_CONTROL', 'SCORE_ADJUST'];

/**
 * Spielerische Basisrechte einer aktiven Teilnahme. Ein PLAYER erhält
 * genau die Rechte seiner Spielrolle (Antwort/Buzzer) — KEINE
 * Verwaltungs-/Secret-Rechte. Ein VIEWER/DISPLAY erhält leere Pakete
 * (read-only). Der Guard prüft zusätzlich Raum + aktuelle Grants.
 */
export const ROLE_PLAYER_PERMISSIONS: readonly GamePermission[] = ['BUZZER_CONTROL'];


/**
 * Wirksame Rechte einer Rolle im Raum: Defaultpaket ± Grants/Entzüge.
 * `grants`/`revocations` sind pro Raum + Akteur gespeichert (Berechtigungs-
 * Delegation, z.B. Co-Host). Ein Grant für genau ein Recht verleiht NICHT
 * andere Rechte; eine Revocation wirkt sofort (auch bei verbundenem Socket,
 * da wirksame Rechte pro Aktion aus der aktuellen DB-Quelle berechnet werden).
 * VIEWER/DISPLAY haben immer leere Pakete (read-only).
 */
export function effectivePermissions(
  role: PlatformRole,
  grants: readonly GamePermission[] = [],
  revocations: readonly GamePermission[] = [],
): Set<GamePermission> {
  const accountBase = ROLE_PERMISSION_PACKAGES[role as AccountRole] ?? [];
  const playerBase = role === 'PLAYER' ? ROLE_PLAYER_PERMISSIONS : [];
  const base = new Set<GamePermission>([...accountBase, ...playerBase]);
  for (const g of grants) base.add(g);
  for (const r of revocations) base.delete(r);
  return base;
}

export function hasPermission(
  perms: ReadonlySet<GamePermission>,
  permission: GamePermission,
): boolean {
  return perms.has(permission);
}

// ------------------------------------------------------------
// Command Contract (Master §5.17, §5.19, §10.6)
//   Zentrale, validierte Envelope: commandId, protocolVersion,
//   autoritativ aufgelöster Raumbezug, Versionserwartung, Payload-Schema.
//   Kompatibilität: requestId→commandId, roomCode→raum (aber ersetzt KEINE
//   Membership), expectedRevision→stateVersion. Widersprüchliche alte/neue
//   Felder (z.B. requestId UND commandId mit unterschiedlichem Wert) → Ablehnung.
// ------------------------------------------------------------
export const CommandEnvelopeSchema = z.object({
  commandId: z.string().min(1).max(128),
  protocolVersion: z.number().int().optional(),
  // Optional: der serverseitige Raumbezug stammt ausschließlich aus der
  // Socket-Identity; roomCode im Payload dient der Client-Korrelation.
  // Ist es vorhanden, muss es das Raumbenennungsformat erfüllen
  // (Audit PR14, 14-03: ungültiges roomCode wird abgelehnt, fehlendes ist ok).
  roomCode: z.string().regex(/^\d{3}-\d{3}$/).optional(),
  // Revisions-/Versionsnummern sind nicht-negativ (Audit PR14, 14-03:
  // negative Werte sind ungültig, kein Legacy-Pfad).
  stateVersion: z.number().int().min(0).optional(),
  payload: z.unknown(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

/**
 * Kompatible Auflösung einer (möglicherweise Legacy-)Command-Zahlung.
 * `requestId` gilt als commandId, wenn kein explizites commandId gesetzt ist;
 * `expectedRevision` gilt als stateVersion. Werden BEIDE die alte und die neue
 * Feldbezeichnung mit WIDERSPRÜCHLICHEM Wert gesendet, wird null zurückgegeben
 * (Aufrufer lehnt mit INVALID_PAYLOAD/COMMAND_CONFLICT ab).
 */
export function resolveCommandEnvelope(input: {
  commandId?: string;
  requestId?: string;
  protocolVersion?: number;
  roomCode?: string;
  stateVersion?: number;
  expectedRevision?: number;
  payload?: unknown;
}): CommandEnvelope | null {
  const hasNew = typeof input.commandId === 'string' && input.commandId.length > 0;
  const hasOld = typeof input.requestId === 'string' && input.requestId.length > 0;
  let commandId: string | undefined;
  if (hasNew && hasOld) {
    if (input.commandId !== input.requestId) return null; // Widerspruch
    commandId = input.commandId;
  } else if (hasNew) {
    commandId = input.commandId;
  } else if (hasOld) {
    commandId = input.requestId;
  }
  if (!commandId) return null;
  const hasStateNew = typeof input.stateVersion === 'number';
  const hasStateOld = typeof input.expectedRevision === 'number';
  if (hasStateNew && hasStateOld && input.stateVersion !== input.expectedRevision) return null;
  const stateVersion: number | undefined = hasStateNew ? input.stateVersion : input.expectedRevision;
  // Audit PR14, 14-03: Der Resolver ist ein VALIDIERTER Boundary-Contract —
  // das Ergebnis muss CommandEnvelopeSchema passieren (commandId-Länge,
  // roomCode-Format, nicht-negative stateVersion). Ein ungültiges Command
  // ist eine Ablehnung, KEINE Umleitung in einen Legacy-Pfad.
  const candidate = {
    commandId,
    protocolVersion: input.protocolVersion,
    roomCode: input.roomCode,
    stateVersion,
    payload: input.payload,
  };
  const parsed = CommandEnvelopeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Ein Token pro Benutzerabsicht (Frontend). Gleiche Payload ist NICHT die
 * gleiche Absicht; ein neues Absichtstoken erzeugt ein neues commandId.
 * Kein Zeit-/Payload-Fingerprint als allgemeiner Ersatz.
 */
export function newCommandToken(): string {
  // Kryptographisch stark, nicht erratbar (§12.6).
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ------------------------------------------------------------
// GameConfig Snapshot + Config Inheritance (Master §5.24, §12.14, §12.8)
//   Priorität: SYSTEM_DEFAULT → HOST_DEFAULT → ROOM_TEMPLATE → GAME_PRESET
//   → ROOM_CONFIG → GAME_CONFIG → LIVE_OVERRIDE (spezifischer gewinnt).
//   LOCKED_AFTER_START ist nach Start nicht live überschreibbar.
//   Auflösung behält echte false/0/null (kein `value || default`): ein Wert
//   ist nur "gesetzt", wenn die Ebene ihn explizit liefert (undefined ≠ null).
// ------------------------------------------------------------
export const CONFIG_SOURCES = [
  'SYSTEM_DEFAULT',
  'HOST_DEFAULT',
  'ROOM_TEMPLATE',
  'GAME_PRESET',
  'ROOM_CONFIG',
  'GAME_CONFIG',
  'LIVE_OVERRIDE',
] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

/** Änderungsklassen (Master §3.4, §12.14). */
export const CONFIG_CHANGE_CLASSES = ['EDITABLE', 'LOCKED_AFTER_START'] as const;
export type ConfigChangeClass = (typeof CONFIG_CHANGE_CLASSES)[number];

export interface ConfigFieldSpec<V = unknown> {
  key: string;
  minimum?: number;
  maximum?: number;
  unit?: 'durationMs' | 'bytes' | 'percent' | 'points' | 'count' | 'bool' | 'string';
  changeClass: ConfigChangeClass;
  nullable?: boolean;
  allowedValues?: readonly unknown[];
  /** Zentraler Default (SYSTEM_DEFAULT). */
  systemDefault: V;
}

export interface ResolvedConfigValue<V> {
  value: V;
  source: ConfigSource;
}

/**
 * Löst einen Konfigurationswert über die 7 Ebenen auf. `layers` ist in
 * aufsteigender Priorität geordnet (SYSTEM_DEFAULT zuerst … LIVE_OVERRIDE
 * zuletzt). Eine Ebene "setzt" ein Feld nur, wenn sie den Key mit einem
 * Wert liefert, der UNDEFINED nicht ist (explizite false/0/null zählen).
 * Kehrt bei "nicht gesetzt" den SYSTEM_DEFAULT zurück.
 */
export function resolveConfigValue<V>(
  field: ConfigFieldSpec<V>,
  layers: ReadonlyArray<Partial<Record<string, V | null>> | null | undefined>,
): ResolvedConfigValue<V> {
  let result: V = field.systemDefault;
  let source: ConfigSource = 'SYSTEM_DEFAULT';
  for (let i = 0; i < layers.length && i < CONFIG_SOURCES.length; i++) {
    const layer = layers[i];
    if (!layer) continue;
    const v = layer[field.key];
    if (v === undefined) continue; // nicht gesetzt → Vererbung
    // null ist nur zulässig, wenn das Feld nullable ist (Feldspektrum).
    // Der Cast ist hier sicher: v ist V oder null, und für nicht-nullable
    // Felder liefert eine korrekte Ebene nie null (validiert am Schema).
    result = (v as V | null) as V;
    source = CONFIG_SOURCES[i];
  }
  return { value: result, source };
}

export function canLiveOverride(field: ConfigFieldSpec, roomStatus: string): boolean {
  if (roomStatus !== 'RUNNING') return true; // vor Start frei
  return field.changeClass !== 'LOCKED_AFTER_START';
}

export interface GameConfigSnapshot {
  gameSlug: string;
  engineVersion: number;
  /** Endgültige, aufgelöste Werte zum Start (effektiv), inkl. Herkunft. */
  values: Record<string, ResolvedConfigValue<unknown>>;
  createdAt: string;
}

export const GameConfigSnapshotSchema = z.object({
  gameSlug: z.string(),
  engineVersion: z.number().int(),
  values: z.record(z.object({
    value: z.any(),
    source: z.enum(CONFIG_SOURCES),
  })),
  createdAt: z.string().datetime(),
});
export type GameConfigSnapshotParsed = z.infer<typeof GameConfigSnapshotSchema>;

// Transport-neutral intent lifecycle. Both the browser adapter and real socket
// integration tests use this contract without importing another app's sources.
export type CommandResponse = { success: boolean; error?: string; [key: string]: unknown };
export interface CommandEmitter {
  emit(event: string, payload: unknown, ack: (response: unknown) => void): unknown;
}

export function createCommandIntentClient() {
  const tokens = new Map<string, string>();
  const intentToken = (key: string): string => {
    let token = tokens.get(key);
    if (!token) {
      token = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      tokens.set(key, token);
    }
    return token;
  };
  const discardIntentToken = (key: string): void => { tokens.delete(key); };
  const discardIntentTokenIfCurrent = (key: string, sentToken: string): void => {
    if (tokens.get(key) === sentToken) tokens.delete(key);
  };
  const withCommandEnvelope = <T extends object>(payload: T, key: string) => ({
    ...payload, commandId: intentToken(key), protocolVersion: PROTOCOL_VERSION,
  });
  const emitCommand = <T extends object>(
    socket: CommandEmitter, event: string, payload: T, key: string,
    onResponse?: (response: CommandResponse) => void,
  ): void => {
    const envelope = withCommandEnvelope(payload, key);
    socket.emit(event, envelope, (raw) => {
      // Only a definitive response consumes the intent. An in-progress or
      // malformed acknowledgement or explicitly uncertain execution keeps its ID.
      const response = raw as CommandResponse | null;
      if (response && typeof response.success === 'boolean') {
        if (response.error !== 'COMMAND_IN_PROGRESS' && response.outcomeUnknown !== true) {
          discardIntentTokenIfCurrent(key, envelope.commandId);
        }
        onResponse?.(response);
      }
    });
  };
  return { intentToken, discardIntentToken, discardIntentTokenIfCurrent, withCommandEnvelope, emitCommand };
}


export const AccessModeSchema = z.enum(['PUBLIC_JOIN', 'PIN_PROTECTED', 'APPROVAL_REQUIRED', 'INVITE_ONLY']);
export const RoomPolicySchema = z.object({
  playerAccess: AccessModeSchema.default('PUBLIC_JOIN'),
  viewerAccess: AccessModeSchema.default('PUBLIC_JOIN'),
  readyRule: z.enum(['ALL_READY_REQUIRED', 'HOST_CAN_OVERRIDE', 'READY_CHECK_DISABLED']).default('ALL_READY_REQUIRED'),
  allowLateJoin: z.boolean().default(false),
  waitlist: z.boolean().default(false),
  coHostEnabled: z.boolean().default(false),
  hostGraceMs: z.number().int().min(1000).max(86400000).default(60000),
  teamMode: z.enum(['OFF', 'MANUAL', 'RANDOM', 'SELF_SELECT', 'ROTATION']).default('OFF'),
  teamCount: z.number().int().min(2).max(100).default(2),
  minTeamSize: z.number().int().min(1).max(100).default(1),
  maxTeamSize: z.number().int().min(1).max(100).default(100),
  equality: z.enum(['REQUIRED', 'WARN', 'ANY']).default('ANY'),
  scoring: z.enum(['INDIVIDUAL_SCORE', 'TEAM_SCORE']).default('INDIVIDUAL_SCORE'),
  allowTeamReshuffleBetweenRounds: z.boolean().default(false),
}).strict().refine(p => p.minTeamSize <= p.maxTeamSize, { message: 'TEAM_SIZE_INVALID' });
export type RoomPolicy = z.infer<typeof RoomPolicySchema>;
/** Public discovery is a separate projection: never expose setup, PINs or tokens. */
export const PublicRoomSummarySchema = z.object({
  id: z.string(), code: z.string(), roomName: z.string(), status: z.string(), runPhase: z.string(),
  lifecycle: z.enum(['SCHEDULED', 'LOBBY_OPEN', 'LOBBY_LOCKED', 'GAME_ACTIVE', 'PAUSED']),
  scheduledAt: z.string().datetime().nullable(),
  maxPlayers: z.number().int().positive(), allowViewers: z.boolean(), cameraEnabled: z.boolean(),
  playerCount: z.number().int().nonnegative(), viewerCount: z.number().int().nonnegative(),
  canJoin: z.boolean(), waitlist: z.boolean(), accessMode: AccessModeSchema,
  game: z.object({ slug: z.string(), name: z.string(), category: z.string() }),
  createdAt: z.string().datetime(),
});
export type PublicRoomSummary = z.infer<typeof PublicRoomSummarySchema>;
// Shared game primitives. Absolute server timestamps; no browser-owned clocks.
export const CoreTimerSchema = z.object({
  mode: z.enum(['COUNTDOWN', 'COUNTUP', 'UNLIMITED']),
  status: z.enum(['IDLE', 'RUNNING', 'PAUSED', 'EXPIRED']),
  startedAtMs: z.number().int().nonnegative().nullable(),
  endsAtMs: z.number().int().nonnegative().nullable(),
  pausedAtMs: z.number().int().nonnegative().nullable(),
  elapsedBeforeMs: z.number().int().nonnegative(),
  remainingMs: z.number().int().nonnegative().nullable(),
}).strict();
export type CoreTimer = z.infer<typeof CoreTimerSchema>;
export const JudgeDecisionSchema = z.enum(['CORRECT', 'WRONG', 'PARTIAL', 'CANCELLED']);
export type JudgeDecision = z.infer<typeof JudgeDecisionSchema>;
export const SubmissionRecordSchema = z.object({
  participantId: z.string().min(1), roundId: z.string().min(1),
  value: z.string().max(10000).nullable(),
  status: z.enum(['DRAFT', 'SUBMITTED', 'LOCKED', 'JUDGED']),
  submittedAtMs: z.number().int().nonnegative(),
  judgedAtMs: z.number().int().nonnegative().nullable(),
  decision: JudgeDecisionSchema.nullable(),
  matchStatus: z.enum(['MATCH', 'NO_MATCH', 'NEEDS_JUDGE']).optional(),
}).strict();
export type SubmissionRecord = z.infer<typeof SubmissionRecordSchema>;
export const CoreTurnSchema = z.object({
  mode: z.enum(['FIXED', 'RANDOM', 'ROTATING_START', 'CUSTOM_HOST_ORDER']),
  order: z.array(z.string().min(1)).min(1), index: z.number().int().nonnegative(),
  cycle: z.number().int().nonnegative(),
}).strict().refine(t => new Set(t.order).size === t.order.length && t.index < t.order.length, { message: 'INVALID_TURN' });
export type CoreTurn = z.infer<typeof CoreTurnSchema>;
export const CoreTieStrategySchema = z.enum(['ALLOW_TIE', 'SUDDEN_DEATH', 'TIEBREAKER_QUESTION', 'SECONDARY_METRIC', 'HOST_DECIDES']);
export type CoreTieStrategy = z.infer<typeof CoreTieStrategySchema>;
export const CoreBuzzerSchema = z.object({
  open: z.boolean(), winnerId: z.string().nullable(), excludedPlayerIds: z.array(z.string()),
  // Optional only for explicitly supported pre-core states.
  status: z.enum(['CLOSED', 'OPEN', 'LOCKED', 'RESOLVED']).optional(),
  mode: z.enum(['INDIVIDUAL', 'TEAM', 'SELECTED']).optional(), fairness: z.literal('SERVER_ARRIVAL').optional(),
  eligiblePlayerIds: z.array(z.string()).optional(), teamByPlayer: z.record(z.string()).optional(),
  winnerTeamId: z.string().nullable().optional(), claimedAtMs: z.number().int().nonnegative().nullable().optional(),
  overrides: z.array(z.object({ actorId: z.string().min(1), fromPlayerId: z.string().nullable(), toPlayerId: z.string().min(1),
    reason: z.string().max(300).nullable(), atMs: z.number().int().nonnegative() }).strict()).optional(),
}).strict().superRefine((state, ctx) => {
  if (state.status === 'OPEN' && (!state.open || !!state.winnerId) || state.status && state.status !== 'OPEN' && state.open
    || state.status === 'LOCKED' && !state.winnerId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BUZZER_STATUS_CONFLICT' });
  if (state.mode === 'TEAM' && (!state.teamByPlayer || state.winnerId && state.winnerTeamId !== state.teamByPlayer[state.winnerId])) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BUZZER_TEAM_CONFLICT' });
});
export type CoreBuzzer = z.infer<typeof CoreBuzzerSchema>;
export const CoreActionKeySchema = z.enum(['answer', 'joker5050', 'jokerSpy', 'jokerRisk', 'reveal', 'next', 'fieldOpen', 'buzz', 'judge', 'stealBuzz', 'stealJudge', 'boardSwitch', 'pause', 'resume', 'end', 'open', 'hint', 'buzzerOverride']);
export type CoreActionKey = z.infer<typeof CoreActionKeySchema>;
export const CoreGamePhaseSchema = z.enum(['SETUP', 'READY', 'ROUND_PREPARE', 'ROUND_ACTIVE', 'ROUND_RESOLUTION', 'ROUND_END', 'ROUND_TRANSITION', 'GAME_END', 'RESULT_REVIEW', 'FINALIZED', 'PAUSED', 'ABORTED', 'ERROR_RECOVERY']);
export type CoreGamePhase = z.infer<typeof CoreGamePhaseSchema>;
export const CoreRoundTransitionSchema = z.object({ completedRoundId: z.string().min(1), nextRoundId: z.string().min(1).nullable(),
  sequence: z.tuple([z.literal('ROUND_END'), z.literal('ROUND_TRANSITION'), z.enum(['ROUND_PREPARE', 'GAME_END'])]) }).strict();
export type CoreRoundTransition = z.infer<typeof CoreRoundTransitionSchema>;
export const CoreRuntimeProjectionSchema = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/), runIndex: z.number().int().positive(),
  gameSlug: z.string(), engineVersion: z.number().int().positive(), stateVersion: z.number().int().nonnegative(),
  enginePhase: z.string(), corePhase: CoreGamePhaseSchema, informationRole: z.enum(['HOST', 'PLAYER', 'VIEWER', 'DISPLAY']),
  recoveryRequired: z.boolean().optional(),
  timer: CoreTimerSchema.nullable(),
  progress: z.object({ currentRound: z.number().int().nonnegative(), totalRounds: z.number().int().nonnegative().nullable(), remainingRounds: z.number().int().nonnegative().nullable(), progressPercent: z.number().min(0).max(100).nullable() }),
  availableActions: z.array(z.object({ key: CoreActionKeySchema, event: z.string(), label: z.string() }).strict()),
}).strict();
export type CoreRuntimeProjection = z.infer<typeof CoreRuntimeProjectionSchema>;
export const ParticipantNameSchema = z.string().transform(s => s.normalize('NFKC').trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(100).refine(s => !/[\p{Cc}\p{Cf}]/u.test(s), 'NAME_INVALID'));
export function normalizedParticipantName(name: string): string {
  return ParticipantNameSchema.parse(name).toLocaleLowerCase('de-DE');
}
export const RoomOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('POLICY'), policy: RoomPolicySchema }),
  z.object({ type: z.literal('LOCK'), locked: z.boolean() }),
  z.object({ type: z.literal('SCHEDULE'), scheduledAt: z.string().datetime(), expiresAt: z.string().datetime().optional() }),
  z.object({ type: z.literal('OPEN') }),
  z.object({ type: z.literal('DRAFT') }),
  z.object({ type: z.literal('TEAMS_ASSIGN'), mode: z.enum(['MANUAL', 'RANDOM', 'ROTATION']), assignments: z.record(z.string().nullable()).optional(), override: z.boolean().default(false) }),
  z.object({ type: z.literal('TEAM_EDIT'), teamId: z.string(), name: z.string().trim().min(1).max(50), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), icon: z.string().min(1).max(16) }),
  z.object({ type: z.literal('TEAM_SELECT'), teamId: z.string() }),
  z.object({ type: z.literal('ADMIT'), participantId: z.string(), approve: z.boolean(), teamId: z.string().optional() }),
  z.object({ type: z.literal('RENAME'), participantId: z.string(), name: ParticipantNameSchema }),
  z.object({ type: z.literal('LEAVE') }),
  z.object({ type: z.literal('KICK'), participantId: z.string(), reason: z.string().max(300).optional() }),
  z.object({ type: z.literal('BAN'), participantId: z.string(), reason: z.string().max(300).optional() }),
  z.object({ type: z.literal('UNBAN'), participantId: z.string() }),
  z.object({ type: z.literal('TOKEN_ROTATE'), participantId: z.string() }),
  z.object({ type: z.literal('COHOST'), userId: z.string(), permissions: z.array(z.enum(['GAME_START', 'GAME_PAUSE', 'ROUND_ADVANCE', 'JUDGE_ANSWER', 'SCORE_ADJUST', 'BUZZER_CONTROL', 'TIMER_CONTROL', 'REVEAL_CONTENT', 'TEAM_MANAGE', 'PLAYER_MANAGE', 'GAME_ABORT'])).max(11) }),
  z.object({ type: z.literal('TRANSFER'), userId: z.string(), claim: z.boolean().default(false) }),
  z.object({ type: z.literal('INVITE'), role: z.enum(['PLAYER', 'VIEWER']) }),
  z.object({ type: z.literal('MESSAGE'), message: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('LOBBY') }),
  z.object({ type: z.literal('REMATCH'), runIndex: z.number().int().positive().optional() }),
  z.object({ type: z.literal('SWITCH_GAME'), gameSlug: z.string(), sourceRoomId: z.string().optional() }),
  z.object({ type: z.literal('CLOSE') }),
  z.object({ type: z.literal('EMERGENCY'), action: z.enum(['ABORT_ROUND', 'RESTART_ROUND', 'SKIP_ROUND', 'ABORT_GAME']), points: z.enum(['KEEP_POINTS', 'ROLLBACK_ROUND_POINTS']) }),
]);
export type RoomOperation = z.infer<typeof RoomOperationSchema>;
export const RoomCommandSchema = z.object({
  roomCode: z.string().regex(/^\d{3}-\d{3}$/),
  commandId: z.string().min(1).max(128),
  protocolVersion: z.literal(1),
  stateVersion: z.number().int().nonnegative().optional(),
  operation: RoomOperationSchema,
}).strict();
export type RoomCommand = z.infer<typeof RoomCommandSchema>;

export interface RoomCoreView {
  contentVisibility?: 'HOST_PREVIEW' | 'BLIND_HOST';
  gameSlug: string;
  history: Array<{ runIndex: number; endedAt: string; players: Array<{ displayName: string; score: number }> }>;
  switchOptions: Array<{ id: string; roomName: string; gameSlug: string }>;
  revision: number;
  lifecycle: string;
  policy: RoomPolicy;
  scheduledAt: string | null;
  hostStatus: 'ONLINE' | 'DISCONNECTED' | 'HOST_MISSING';
  canManage: boolean;
  isOwner: boolean;
  permissions: string[];
  selfId: string | null;
  selfAdmission: string | null;
  teams: Array<{ id: string; name: string; color: string; icon: string; score: number }>;
  participants: Array<{ id: string; displayName: string; role: string; admission: string; connected: boolean; ready: boolean; teamId: string | null; score: number; banned: boolean; connectionQuality: 'GUT' | 'INSTABIL' | 'SCHLECHT' | 'UNKNOWN'; userId?: string | null }>;
  feed: Array<{ id: string; kind: string; message: string; createdAt: string }>;
  preflight: { status: 'READY_TO_START' | 'WARNINGS' | 'BLOCKED'; blockers: string[]; warnings: string[] };
  runIndex: number;
}

// Results lifecycle is separate from the engine's terminal GAME_END subphase.
export const ResultLifecycleSchema = z.enum(['GAME_END', 'RESULT_REVIEW', 'FINALIZED']);
export const ResultOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('REVIEW') }).strict(),
  z.object({ type: z.literal('FINALIZE') }).strict(),
  z.object({ type: z.enum(['ADJUST', 'AMEND']), participantId: z.string().min(1).max(128), delta: z.number().int().min(-1000000).max(1000000).refine(v => v !== 0), reason: z.string().trim().min(1).max(500), referenceEventId: z.string().min(1).max(128).optional() }).strict(),
  z.object({ type: z.literal('ROLLBACK'), referenceEventId: z.string().min(1).max(128), reason: z.string().trim().min(1).max(500) }).strict(),
]);
export const ResultCommandSchema = z.object({ roomCode: z.string().regex(/^\d{3}-\d{3}$/), runIndex: z.number().int().positive(), resultRevision: z.number().int().positive(),
  commandId: z.string().min(1).max(128), protocolVersion: z.literal(1).default(1), operation: ResultOperationSchema }).strict();
export type ResultOperation = z.infer<typeof ResultOperationSchema>;
export type ResultCommand = z.infer<typeof ResultCommandSchema>;
export const RecoveryCommandSchema = z.object({ roomCode: z.string().regex(/^\d{3}-\d{3}$/), runIndex: z.number().int().positive(), gameStateVersion: z.number().int().positive(),
  commandId: z.string().min(1).max(128), protocolVersion: z.literal(1).default(1), operation: z.literal('RESTORE_REPLAY') }).strict();
export const PublicResultViewSchema = z.object({
  roomCode: z.string(), roomName: z.string(), status: z.string(), runPhase: z.string(), runIndex: z.number().int().positive(),
  resultRevision: z.number().int().positive().nullable(), resultStatus: ResultLifecycleSchema.nullable(),
  game: z.object({ slug: z.string(), name: z.string() }),
  scores: z.array(z.object({ rank: z.number().int().positive(), participationId: z.string(), displayName: z.string(), role: z.string(), score: z.number().int(), teamId: z.string().nullable().optional() })),
  teams: z.array(z.object({ id: z.string(), name: z.string(), score: z.number().int(), rank: z.number().int().positive() })).default([]),
  scoring: z.enum(['INDIVIDUAL_SCORE', 'TEAM_SCORE']).optional(), requiresReview: z.boolean().optional(),
  endReason: z.string().optional(), aborted: z.boolean().optional(),
  versions: z.array(z.object({ revision: z.number().int().positive(), kind: z.string(), createdAt: z.string() })).default([]),
  endedAt: z.string().nullable(),
});
export type PublicResultView = z.infer<typeof PublicResultViewSchema>;
export const ResultReadSchema = z.object({ roomCode: z.string().regex(/^\d{3}-\d{3}$/), runIndex: z.number().int().positive().optional(), revision: z.number().int().positive().optional() }).strict();

// Content pools and shared game-specific editor schemas (Master §6).

export const ContentGameSchema = z.enum(['wissensduell', 'jeopardy']);
export const ContentScopeSchema = z.enum(['PRIVATE', 'SHARED', 'PUBLIC', 'SYSTEM']);
export const ContentStatusSchema = z.enum(['DRAFT', 'READY', 'DISABLED', 'ARCHIVED', 'TRASHED']);
export const ContentDifficultySchema = z.enum(['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD']);
export const ContentLanguageSchema = z.enum(['de-DE', 'en-US', 'tr-TR']);
const text = z.string().trim().min(1).max(10000);
export const ContentMediaRightsSchema = z.object({
  source: z.string().max(2000).default(''), sourceUrl: z.string().url().max(2000).or(z.literal('')).default(''),
  author: z.string().max(500).default(''), license: z.string().max(500).default(''), ownMaterial: z.boolean().default(false),
  recognizablePerson: z.boolean().default(false), consent: z.boolean().default(false),
}).strict();
const contentMediaFields = { mediaAssetId: z.string().uuid().optional(), mediaType: z.enum(['image', 'audio']).optional(), mediaRights: ContentMediaRightsSchema.optional() };
function contentMediaIssues(q: { mediaAssetId?: string; mediaType?: string; mediaRights?: z.infer<typeof ContentMediaRightsSchema> }, ctx: z.RefinementCtx) {
  if (!q.mediaAssetId && !q.mediaType) return;
  if (!q.mediaAssetId || !q.mediaType) ctx.addIssue({ code: 'custom', path: ['mediaAssetId'], message: 'Medium und Medientyp gemeinsam angeben.' });
  const r = q.mediaRights;
  if (!r || (!r.ownMaterial && ((!r.source.trim() && !r.sourceUrl.trim()) || !r.license.trim())) || r.recognizablePerson && !r.consent)
    ctx.addIssue({ code: 'custom', path: ['mediaRights'], message: 'Eigene Rechte oder Quelle und Nutzungserlaubnis sowie gegebenenfalls Einwilligung bestätigen.' });
}
export const QuizContentSchema = z.object({
  ...contentMediaFields, prompt: text, category: z.string().trim().min(1).max(100),
  options: z.array(z.object({ id: z.string().min(1).max(40), text }).strict()).min(2).max(6),
  correctOptionId: z.string().min(1).max(40), explanation: z.string().max(10000).default(''),
  points: z.number().int().min(0).max(100000).default(100),
  wrongPoints: z.number().int().min(-100000).max(0).default(0),
  durationMs: z.number().int().min(1000).max(3600000).default(20000),
}).strict().superRefine((q, ctx) => {
  contentMediaIssues(q, ctx);
  if (new Set(q.options.map(o => o.id)).size !== q.options.length || !q.options.some(o => o.id === q.correctOptionId))
    ctx.addIssue({ code: 'custom', path: ['correctOptionId'], message: 'Eindeutige Optionen und eine gültige richtige Antwort erforderlich.' });
  if (new Set(q.options.map(o => o.text.toLocaleLowerCase().trim())).size !== q.options.length)
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Antwortoptionen dürfen nicht doppelt sein.' });
});
export const JeopardyItemSchema = z.object({
  ...contentMediaFields, question: text, answer: text, category: z.string().trim().min(1).max(100),
  value: z.number().int().min(1).max(100000),
}).strict().superRefine(contentMediaIssues);
export function validateContentPayload(gameSlug: string, payload: unknown) {
  return (gameSlug === 'wissensduell' ? QuizContentSchema : JeopardyItemSchema).safeParse(payload);
}
export const ContentDefaultsSchema = z.object({
  language: ContentLanguageSchema.default('de-DE'), difficulty: ContentDifficultySchema.nullable().default(null),
  tagIds: z.array(z.string().uuid()).max(30).default([]),
}).strict();
export const CreateContentPoolSchema = z.object({
  commandId: z.string().uuid(), gameSlug: ContentGameSchema, name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).default(''), scope: z.enum(['PRIVATE', 'SHARED']).default('PRIVATE'),
  defaults: ContentDefaultsSchema.default({}), editorIds: z.array(z.string().min(1).max(128)).max(30).default([]),
}).strict();
export const ContentItemInputSchema = z.object({
  title: z.string().trim().max(200).default(''), payload: z.record(z.unknown()),
  language: ContentLanguageSchema.nullable().default(null), difficulty: ContentDifficultySchema.nullable().default(null),
  tagIds: z.array(z.string().uuid()).max(30).nullable().default(null),
  source: z.string().max(2000).default(''), sourceUrl: z.string().url().max(2000).or(z.literal('')).default(''),
  license: z.string().max(500).default(''),
}).strict();
export const CONTENT_DIFFICULTIES = ['VERY_EASY', 'EASY', 'MEDIUM', 'HARD', 'VERY_HARD'] as const;
export const ContentDifficultyPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('DISTRIBUTION'), percentages: z.object({ VERY_EASY: z.number().int().min(0).max(100), EASY: z.number().int().min(0).max(100), MEDIUM: z.number().int().min(0).max(100), HARD: z.number().int().min(0).max(100), VERY_HARD: z.number().int().min(0).max(100) }).strict() }).strict(),
  z.object({ kind: z.literal('RANGES'), ranges: z.array(z.object({ from: z.number().int().min(1).max(100), to: z.number().int().min(1).max(100), difficulty: ContentDifficultySchema }).strict()).min(1).max(100) }).strict(),
  z.object({ kind: z.literal('RISING') }).strict(),
]).superRefine((plan, ctx) => {
  if (plan.kind === 'DISTRIBUTION' && Object.values(plan.percentages).reduce((a, b) => a + b, 0) !== 100) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Die Verteilung muss genau 100 Prozent ergeben.' });
  if (plan.kind === 'RANGES') { let next = 1;
    for (const range of plan.ranges) { if (range.from !== next || range.to < range.from) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Rundenbereiche müssen bei 1 beginnen und lückenlos ohne Überschneidung aufeinander folgen.' }); next = range.to + 1; }
  }
});
export type ContentDifficultyPlan = z.infer<typeof ContentDifficultyPlanSchema>;
/** Exact integer allocation; ties use canonical difficulty order. Server randomizes distribution order. */
export function contentDifficultySequence(raw: ContentDifficultyPlan, count: number): Array<z.infer<typeof ContentDifficultySchema>> {
  const plan = ContentDifficultyPlanSchema.parse(raw);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('INVALID_DIFFICULTY_COUNT');
  if (plan.kind === 'RISING') return Array.from({ length: count }, (_, i) => (['EASY', 'MEDIUM', 'HARD'] as const)[Math.min(2, Math.floor(i * 3 / count))]);
  if (plan.kind === 'RANGES') {
    if (plan.ranges.at(-1)!.to !== count) throw new Error('DIFFICULTY_RANGE_COUNT');
    return plan.ranges.flatMap(r => Array.from({ length: r.to - r.from + 1 }, () => r.difficulty));
  }
  const allocations = CONTENT_DIFFICULTIES.map((difficulty, index) => { const exact = count * plan.percentages[difficulty] / 100; return { difficulty, index, count: Math.floor(exact), remainder: exact - Math.floor(exact) }; });
  const extra = count - allocations.reduce((sum, a) => sum + a.count, 0);
  [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index).slice(0, extra).forEach(a => a.count++);
  return allocations.flatMap(a => Array.from({ length: a.count }, () => a.difficulty));
}
export const SYSTEM_DIFFICULTY_PRESETS: Array<{ id: string; name: string; plan: ContentDifficultyPlan }> = [
  { id: 'system:relaxed', name: 'Locker', plan: { kind: 'DISTRIBUTION', percentages: { VERY_EASY: 40, EASY: 60, MEDIUM: 0, HARD: 0, VERY_HARD: 0 } } },
  { id: 'system:normal', name: 'Normal', plan: { kind: 'DISTRIBUTION', percentages: { VERY_EASY: 0, EASY: 20, MEDIUM: 60, HARD: 20, VERY_HARD: 0 } } },
  { id: 'system:rising', name: 'Steigend', plan: { kind: 'RISING' } },
  { id: 'system:hardcore', name: 'Hardcore', plan: { kind: 'DISTRIBUTION', percentages: { VERY_EASY: 0, EASY: 0, MEDIUM: 0, HARD: 40, VERY_HARD: 60 } } },
];
export interface ContentDifficultyPresetView { id: string; name: string; gameSlug: string; revision: number; plan: ContentDifficultyPlan; scope: 'SYSTEM' | 'PRIVATE' }
export const ContentDifficultyPresetInputSchema = z.object({ gameSlug: ContentGameSchema, name: z.string().trim().min(1).max(150), plan: ContentDifficultyPlanSchema }).strict()
  .refine(p => p.gameSlug === 'wissensduell' || p.plan.kind === 'DISTRIBUTION', 'Rundenverläufe sind für Wissensduell vorgesehen; Jeopardy verwendet Verteilungen.');
export const ContentSelectionSchema = z.object({
  poolIds: z.array(z.string().min(1).max(128)).min(1).max(20), count: z.number().int().min(1).max(100).default(10),
  language: ContentLanguageSchema.default('de-DE'), difficulty: ContentDifficultySchema.optional(),
  difficultyPlan: ContentDifficultyPlanSchema.optional(),
  tagIds: z.array(z.string().uuid()).max(30).default([]),
  category: z.string().trim().min(1).max(100).optional(),
  poolCounts: z.record(z.number().int().min(0).max(100)).optional(),
  mode: z.enum(['RANDOM', 'MANUAL']).default('RANDOM'), itemIds: z.array(z.string().min(1).max(128)).max(100).default([]),
  repeatRule: z.enum(['NO_REPEAT_IN_ROOM', 'ALLOW_REPEATS', 'PREFER_UNSEEN']).default('NO_REPEAT_IN_ROOM'),
  visibility: z.enum(['HOST_PREVIEW', 'BLIND_HOST']).default('HOST_PREVIEW'),
}).strict().refine(s => !s.difficultyPlan || !s.difficulty && s.mode === 'RANDOM', 'Schwierigkeitsverläufe erfordern Zufallsauswahl ohne einzelnen Schwierigkeitsfilter.')
.refine(s => s.visibility !== 'BLIND_HOST' || s.mode === 'RANDOM' && s.itemIds.length === 0, 'Blindmoderation erfordert reine Zufallsauswahl.');
export const CONTENT_TEMPLATES = {
  wissensduell: { title: '', payload: { prompt: '', category: 'Allgemeinwissen', options: [
    { id: 'a', text: '' }, { id: 'b', text: '' }, { id: 'c', text: '' }, { id: 'd', text: '' },
  ], correctOptionId: 'a', explanation: '', points: 100, wrongPoints: 0, durationMs: 20000 } },
  jeopardy: { title: '', payload: { question: '', answer: '', category: 'Allgemeinwissen', value: 100 } },
} as const;
export interface ContentItemView {
  id: string; poolId: string; gameSlug: string; revision: number; status: string; title: string;
  payload: Record<string, unknown>; language: string | null; difficulty: string | null; tagIds: string[] | null;
  source: string; sourceUrl: string; license: string; reviewState: string; lockState: string;
  effective: { language: string; difficulty: string | null; tagIds: string[] };
  validation: Array<{ path: string; message: string }>; updatedAt: string;
}
export interface ContentPoolView {
  id: string; gameSlug: string; name: string; description: string; scope: string; ownerId: string | null;
  revision: number; defaults: z.infer<typeof ContentDefaultsSchema>; canEdit: boolean; canPropose?: boolean; canManage?: boolean; canReadInternal?: boolean; canAssignReview?: boolean; editorIds?: string[];
}

export type ContentStatus = z.infer<typeof ContentStatusSchema>;
export const ContentBatchSchema = z.object({
  poolId: z.string().min(1).max(128), poolRevision: z.number().int().positive(),
  items: z.array(z.object({ id: z.string().min(1).max(128), revision: z.number().int().positive() }).strict()).min(1).max(100),
  operation: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('STATUS'), status: ContentStatusSchema }).strict(),
    z.object({ kind: z.literal('TAGS'), tagIds: z.array(z.string().uuid()).max(30).nullable() }).strict(),
    z.object({ kind: z.literal('DIFFICULTY'), difficulty: ContentDifficultySchema.nullable() }).strict(),
    z.object({ kind: z.literal('COPY'), targetPoolId: z.string().min(1).max(128), targetRevision: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('MOVE'), targetPoolId: z.string().min(1).max(128), targetRevision: z.number().int().positive() }).strict(),
  ]),
}).strict();

export const ContentTemplateInputSchema = z.object({ name: z.string().trim().min(1).max(150), gameSlug: ContentGameSchema,
  item: ContentItemInputSchema.refine(v => v.payload.mediaAssetId === undefined, 'Vorlagen enthalten Medienoptionen, keine konkrete Datei.') }).strict();
export interface ContentTemplateView { id: string; name: string; gameSlug: string; scope: 'SYSTEM' | 'PRIVATE'; revision: number; item: z.infer<typeof ContentItemInputSchema> }

export interface ContentPlaytestView {
  code: string; gameSlug: string; phase: 'QUESTION' | 'REVEAL' | 'CLOSED'; version: number; position: number; total: number;
  role: 'HOST' | 'PLAYER' | 'VIEWER' | 'TEAM'; canControl: boolean; expiresAt: string; endsAt: number | null; question: Record<string, unknown> | null;
  warnings: Array<{ path: string; message: string }>; ownAnswer: string | null; ownReport: boolean;
  reports: Array<{ position: number; message: string; createdAt: string }>;
}

// Reusable setup configurations contain settings and content intent, never PINs or session tokens.
export const BlueprintRoomSettingsSchema = z.object({
  maxPlayers: z.number().int().min(2).max(100).optional(), cameraEnabled: z.boolean().optional(), allowViewers: z.boolean().optional(),
  viewerRequiresPin: z.boolean().optional(), viewerLimit: z.number().int().min(0).max(500).optional(), lobbyChatEnabled: z.boolean().optional(), isPublic: z.boolean().optional(), roomPolicy: RoomPolicySchema.optional(),
}).strict();
const blueprintClue = z.object({ value: z.number().int().positive().max(100000), question: z.string().max(10000), answer: z.string().max(10000) }).strict();
const blueprintBoard = z.object({ categories: z.array(z.object({ name: z.string().max(100), clues: z.array(blueprintClue).min(1).max(20) }).strict()).min(1).max(6) }).strict();
export const BlueprintGameSetupSchema = z.object({
  contentSelection: ContentSelectionSchema.optional(), questionCount: z.number().int().min(1).max(100).optional(), timerDuration: z.number().int().min(1).max(3600).optional(),
  selectedQuestionIds: z.array(z.string().min(1).max(128)).max(100).optional(), questionPoolId: z.string().min(1).max(128).optional(), board1: blueprintBoard.optional(), board2: blueprintBoard.optional(),
}).strict();
export const GamePresetConfigurationSchema = z.object({ room: BlueprintRoomSettingsSchema.default({}), setup: BlueprintGameSetupSchema }).strict();
export const RoomTemplateConfigurationSchema = z.object({ room: BlueprintRoomSettingsSchema.default({}), language: ContentLanguageSchema.optional(), preferredGamePresetIds: z.array(z.string().min(1).max(128)).max(20).default([]) }).strict();
export const SetupBlueprintInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('GAME_PRESET'), gameSlug: ContentGameSchema, name: z.string().trim().min(1).max(150), favorite: z.boolean().default(false), configuration: GamePresetConfigurationSchema }).strict(),
  z.object({ kind: z.literal('ROOM_TEMPLATE'), gameSlug: z.null().default(null), name: z.string().trim().min(1).max(150), favorite: z.boolean().default(false), configuration: RoomTemplateConfigurationSchema }).strict(),
]);
export type GamePresetConfiguration = z.infer<typeof GamePresetConfigurationSchema>;
export type BlueprintRoomSettings = z.infer<typeof BlueprintRoomSettingsSchema>;
export type SetupBlueprintInput = z.infer<typeof SetupBlueprintInputSchema>;
export type SetupBlueprintView = SetupBlueprintInput & { id: string; revision: number; scope: 'SYSTEM' | 'PRIVATE' };
export const SetupBlueprintRefSchema = z.object({ id: z.string().min(1).max(128), revision: z.number().int().positive() }).strict();
export type SetupBlueprintRef = z.infer<typeof SetupBlueprintRefSchema>;
