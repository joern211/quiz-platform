// ============================================================
// Online Quiz Plattform - Catalog Router
// GET /api/v1/catalog/...
//
// Alle Daten stammen aus dem kanonischen Katalog in @quiz/shared
// (Single Source of Truth, Regelwerk §12.1). Kategorien und
// Spielzahlen werden aus den tatsächlichen Manifesten abgeleitet –
// keine fest eingetragenen Fantasiezahlen (Regelwerk §14).
// ============================================================

import { Router } from 'express';
import {
  GAME_MANIFESTS,
  resolveCanonicalSlug,
  getGameManifest,
  deriveVisibleCategories,
  type GameManifest,
} from '@quiz/shared';
import { isStartableSlug } from '../games/registry.js';

export const catalogRouter : ReturnType<typeof Router> = Router();

// Sichtbare Kategorien, aus den Katalogdaten abgeleitet (echte gameCount).
const visibleCategories = deriveVisibleCategories();

// GET /api/v1/catalog/categories
// Sichtbare Kategorien aus den Katalogdaten abgeleitet (echte gameCount).
// id = slug (stabiler, nicht erratbarer sichtbarer Ref laut Regelwerk §12.6).
catalogRouter.get('/categories', (_req, res) => {
  res.json({
    success: true,
    data: visibleCategories.map(({ gameSlugs, ...rest }) => ({ ...rest, id: rest.slug })),
  });
});

// GET /api/v1/catalog/games
// Ohne Parameter: nur sichtbare (nicht HIDDEN) Spiele.
// ?status=...  : nach Status filtern
// ?category=...: nach Kategorie filtern
// ?showAll=true: auch HIDDEN mitliefern
catalogRouter.get('/games', (req, res) => {
  const { category, status, showAll } = req.query as Record<string, string | undefined>;

  let games: GameManifest[] = [...GAME_MANIFESTS];

  if (!showAll) {
    games = games.filter((g) => g.status !== 'HIDDEN');
  }
  if (category) {
    games = games.filter((g) => g.category === category);
  }
  if (status) {
    games = games.filter((g) => g.status === status);
  }

  res.json({
    success: true,
    data: games,
  });
});

// GET /api/v1/catalog/games/:slug
// Kanonische Slugs liefern das Manifest. Bekannte Legacy-Slugs werden
// auf den kanonischen aufgelöst und per 301 auf den kanonischen Pfad
// weitergeleitet (alte Links funktionieren kontrolliert weiter,
// Regelwerk §5.23). Unbekannte Slugs → 404.
catalogRouter.get('/games/:slug', (req, res) => {
  const raw = req.params.slug;
  const canonical = resolveCanonicalSlug(raw);
  const game = getGameManifest(raw);

  if (!game) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Spiel nicht gefunden.' },
    });
  }

  // Legacy-Link → eindeutiger Übergang auf den kanonischen Pfad.
  if (canonical && canonical !== raw) {
    return res.redirect(301, `/api/v1/catalog/games/${canonical}`);
  }

  res.json({
    success: true,
    data: game,
  });
});

// GET /api/v1/catalog/meta
// Ehrlicher Startbarkeits-Status pro Spiel, abgeleitet aus der
// tatsächlichen Engine-Registry (Regelwerk §13.1): AVAILABLE/BETA im
// Manifest ZUSÄTZLICH mit einem echten Registry-Handler.
catalogRouter.get('/meta', (_req, res) => {
  const data = GAME_MANIFESTS
    .filter((g) => g.status !== 'HIDDEN')
    .map((g) => ({
      slug: g.slug,
      name: g.name,
      status: g.status,
      startable: isStartableSlug(g.slug),
    }));
  res.json({ success: true, data });
});
