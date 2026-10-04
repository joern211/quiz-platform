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
  type GameManifest,
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

/** Kanonisches Manifest → UI-Shape. */
export function toUiGame(m: GameManifest): UiGame {
  return {
    slug: m.slug,
    name: m.name,
    category: categoryName(m.category),
    shortRules: m.shortDescription,
    playerCount: { min: m.minPlayers, max: m.maxPlayers },
    duration: durationLabel(m.estimatedDurationMinutes),
    hasBuzzer: m.hasBuzzer,
    hasTeams: m.hasTeams,
    hasCamera: m.hasCamera,
    hasAudio: m.hasAudio,
    status: m.status,
  };
}

// ── Abgeleitete, sichtbare Kategorien (echte gameCount) ─────────
export function visibleCategories(): VisibleCategory[] {
  return deriveVisibleCategories();
}

// ── Spiel-Lookups (Legacy-Slugs werden auf kanonisch aufgelöst) ──
export function findManifest(slug: string | undefined): GameManifest | undefined {
  const canonical = resolveCanonicalSlug(slug) ?? slug;
  return GAME_MANIFESTS.find((m) => m.slug === canonical);
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
