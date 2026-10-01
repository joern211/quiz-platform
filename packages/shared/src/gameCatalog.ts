// ============================================================
// Kanonischer Spielekatalog – Single Source of Truth
//
// Dieses Modul ist die EINE verbindliche Quelle für:
//   - die kanonischen Spiel-Slugs (Regelwerk §14, "FESTGELEGT")
//   - die Anzeigennamen
//   - die ehrlichen Verfügbarkeitsstatus (Regelwerk §5.3, §13.1)
//   - die Legacy-Slug-Aliasse für Migration/Compatibility (Regelwerk §5.23, §12.1)
//   - die aus den Katalogdaten abgeleiteten, sichtbaren Kategorien
//
// Server (Catalog-API, Registry, Room-Create) und Web (Katalog,
// Kategorien, Setup-/Spielrouten) nutzen ALLE diese Daten. Es gibt
// keine doppelten Hardcodes mehr.
//
// WICHTIG – Slug vs. interner Name:
//   Ein Spiel-Slug ist die sichtbare Identität (DB, API, URL).
//   Interne Modulnamen (games/geo, games/weristdas), Socket-Event-Namen
//   (geo:*, weristdas:*) und DB-Tabellen-/Modellnamen (GeoQuestion) sind
//   NICHT Slugs und bleiben unverändert, solange das interne Protokoll
//   dafür nicht zwingend migriert werden muss (Regelwerk §5.23, §12.1).
// ============================================================

import { z } from 'zod';

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
    shortDescription: 'Fusionbilder erkennen',
    description: 'Errate, welche beiden Personen im Fusionsbild stecken. Erster Buzzer antwortet.',
    minPlayers: 2,
    maxPlayers: 10,
    estimatedDurationMinutes: 15,
    roles: ['MODERATOR', 'PLAYER', 'VIEWER'],
    tags: ['buzzer', 'fusion'],
    status: 'AVAILABLE',
    hasBuzzer: true,
    hasTeams: false,
    hasCamera: false,
    hasAudio: false,
    hasTimer: false,
    setupSchemaVersion: 1,
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
