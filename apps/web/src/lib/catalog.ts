// ============================================================
// Web-Katalog-Helper
//
// Die UI nutzt dieselbe Quelle wie Server und API: den kanonischen
// Katalog in @quiz/shared (Single Source of Truth, Regelwerk §12.1).
// Damit stimmen sichtbare Website-Daten und Katalog-API definitionsgemäß
// überein – keine doppelten Hardcodes, keine Fantasiezahlen (Regelwerk §14).
// ============================================================

import {
  GAME_MANIFESTS,
  CATALOG_CATEGORIES,
  deriveVisibleCategories,
  resolveCanonicalSlug,
  normalizeManifest,
  type GameManifest,
  type GameManifestSpec,
  type GameStatus,
  type VisibleCategory,
} from '@quiz/shared';

// UI-Shape, wie es GameCard/GamePage erwarten (Kategorie als Anzeigename).
export interface UiGame {
  slug: string;
  name: string;
  category: string; // Anzeigename der Kategorie
  shortRules: string;
  playerCount: { min: number; max: number };
  duration: string;
  hasBuzzer: boolean;
  hasTeams: boolean;
  hasCamera: boolean;
  hasAudio: boolean;
  status: GameStatus;
}

const categoryNames: Record<string, string> = Object.fromEntries(
  CATALOG_CATEGORIES.map((c) => [c.slug, c.name]),
);

export function categoryName(slug: string): string {
  return categoryNames[slug] ?? slug;
}

/** Zeitspanne aus Minuten in ein kompaktes UI-Label. */
function durationLabel(minutes: number): string {
  return `~${minutes} Min`;
}

/** Kanonisches Manifest → UI-Shape (eingabefähige Specs werden aufgelöst). */
export function toUiGame(m: GameManifestSpec): UiGame {
  const resolved = normalizeManifest(m);
  return {
    slug: resolved.slug,
    name: resolved.name,
    category: categoryName(resolved.category),
    shortRules: resolved.shortDescription,
    playerCount: { min: resolved.minPlayers, max: resolved.maxPlayers },
    duration: durationLabel(resolved.estimatedDurationMinutes),
    hasBuzzer: resolved.hasBuzzer,
    hasTeams: resolved.hasTeams,
    hasCamera: resolved.hasCamera,
    hasAudio: resolved.hasAudio,
    status: resolved.status,
  };
}

// ── Abgeleitete, sichtbare Kategorien (echte gameCount) ─────────
export function visibleCategories(): VisibleCategory[] {
  return deriveVisibleCategories();
}

// ── Spiel-Lookups (Legacy-Slugs werden auf kanonisch aufgelöst) ──
export function findManifest(slug: string | undefined): GameManifest | undefined {
  const canonical = resolveCanonicalSlug(slug) ?? slug;
  const spec = GAME_MANIFESTS.find((m) => m.slug === canonical);
  if (!spec) return undefined;
  return normalizeManifest(spec);
}

export function gamesByCategory(categorySlug: string): UiGame[] {
  return GAME_MANIFESTS
    .filter((m) => m.category === categorySlug && m.status !== 'HIDDEN')
    .map(toUiGame);
}

/** Startbare Spiele (AVAILABLE oder BETA) – echte Grundlage. */
export function startableGames(): UiGame[] {
  return GAME_MANIFESTS
    .filter((m) => m.status === 'AVAILABLE' || m.status === 'BETA')
    .map(toUiGame);
}

/** Anzahl startbarer Spiele (für Hero-Statistik, echte Zahl). */
export function startableCount(): number {
  return GAME_MANIFESTS.filter((m) => m.status === 'AVAILABLE' || m.status === 'BETA').length;
}
