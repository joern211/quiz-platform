// ============================================================
// Kanonischer Spielekatalog – Konsistenztests
//
// Regelwerk §14 (FESTGELEGT), §12.1 (Single Source of Truth),
// §13.1 (ehrlicher Status), §5.3 (GameManifest).
//
// Prüft:
//   - exakt EIN kanonischer Eintrag pro festgelegtem Spiel
//   - keine veralteten / doppelten oder Legacy-Slugs im Katalog
//   - Legacy-Aliasse lösen exakt auf die kanonischen Slugs auf
//   - geplante Spiele sind NICHT startbar, startbare haben echten Handler
//   - Catalog-API (games/categories/meta) stimmt mit @quiz/shared überein
// ============================================================

import { describe, it, expect } from 'vitest';
import supertest from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GAME_MANIFESTS,
  LEGACY_SLUG_ALIASES,
  ALL_CANONICAL_SLUGS,
  deriveVisibleCategories,
  getGameManifest,
  resolveCanonicalSlug,
  type GameManifest,
} from '@quiz/shared';
import {
  getGameHandler,
  isStartableSlug,
  startableSlugs,
  listGames,
} from '../games/registry.js';
import { createApp } from '../app.js';

// ── Die 18 FESTGELEGTEN Spiele aus Regelwerk §14 ────────────────
const CANONICAL_CATALOG = [
  { slug: 'wissensduell', name: 'Wissensduell' },
  { slug: 'jeopardy', name: 'Jeopardy' },
  { slug: 'wer-ist-das', name: 'Wer ist das?' },
  { slug: 'imposter', name: 'Imposter' },
  { slug: 'song-quiz', name: 'Erkenne den Song' },
  { slug: 'last-man-standing', name: 'Last Man Standing' },
  { slug: 'higher-lower', name: 'Higher or Lower' },
  { slug: 'timeline', name: 'Timeline' },
  { slug: 'partner-challenge', name: 'Wie weit gehst du?' },
  { slug: 'stadt-land-fluss', name: 'Stadt, Land, Fluss' },
  { slug: 'same-thought', name: 'Gleicher Gedanke' },
  { slug: 'schaetz-mal', name: 'Schätz mal' },
  { slug: 'millionenfrage', name: 'Millionenfrage' },
  { slug: 'wahr-oder-fake', name: 'Wahr oder Fake?' },
  { slug: 'undercover', name: 'Undercover' },
  { slug: 'board-race', name: 'Raus damit!' },
  { slug: 'secret-agent', name: 'Geheim Agent' },
  { slug: 'yacht', name: 'Yacht' },
] as const;

describe('Kanonischer Spielekatalog – Eindeutigkeit (§14)', () => {
  it('enthält exakt die 18 FESTGELEGTEN Spiele (keine mehr, keine weniger)', () => {
    expect(GAME_MANIFESTS).toHaveLength(18);
    const slugs = GAME_MANIFESTS.map((m) => m.slug);
    for (const { slug, name } of CANONICAL_CATALOG) {
      expect(slugs, `fehlt: ${slug}`).toContain(slug);
      const m = GAME_MANIFESTS.find((x) => x.slug === slug)!;
      expect(m.name, `Name stimmt nicht für ${slug}`).toBe(name);
    }
  });

  it('hat pro festgelegtem Spiel EXAKT einen Eintrag (keine Doppelungen)', () => {
    const slugs = GAME_MANIFESTS.map((m) => m.slug);
    const seen = new Map<string, number>();
    for (const s of slugs) seen.set(s, (seen.get(s) ?? 0) + 1);
    for (const [slug, count] of seen) {
      expect(count, `Doppelung bei ${slug}`).toBe(1);
    }
  });

  it('enthält KEINE veralteten / Legacy-Slugs als Manifest-Slug', () => {
    const slugs = new Set(GAME_MANIFESTS.map((m) => m.slug));
    const legacySlugs = new Set([...Object.keys(LEGACY_SLUG_ALIASES)]);
    for (const s of slugs) {
      expect(legacySlugs.has(s), `Legacy-Slug ${s} taucht im Katalog auf`).toBe(false);
    }
    // explizite Spot-Checks der kritischen Legacy-Begriffe
    for (const legacy of ['geo', 'weristdas', 'luegen', 'wer-luegt', 'song', 'song-erraten', 'allgemeinwissen']) {
      expect(slugs.has(legacy), `Legacy ${legacy} als Spiel vorhanden`).toBe(false);
    }
  });

  it('läuft GAME_MANIFESTS-Slugs durch das Manifest-Schema valid', () => {
    for (const m of GAME_MANIFESTS) {
      expect(typeof m.slug).toBe('string');
      expect(typeof m.name).toBe('string');
      expect(['PLANNED', 'BETA', 'AVAILABLE', 'HIDDEN']).toContain(m.status);
      expect(m.maxPlayers).toBeGreaterThanOrEqual(m.minPlayers);
    }
  });
});

describe('Legacy-Slug-Auflösung (§5.23, §12.1)', () => {
  const aliasExpectations: Record<string, string> = {
    geo: 'wissensduell',
    allgemeinwissen: 'wissensduell',
    weristdas: 'wer-ist-das',
    'wer-luegt': 'imposter',
    luegen: 'imposter',
    song: 'song-quiz',
    'song-erraten': 'song-quiz',
  };

  it('_ALIAS-Tabelle enthält alle definierten Legacy-Äquivalente', () => {
    for (const [legacy, canonical] of Object.entries(aliasExpectations)) {
      expect(LEGACY_SLUG_ALIASES[legacy], `Fehlt Alias ${legacy}`).toBe(canonical);
    }
  });

  it('resolveCanonicalSlug: Legacy → kanonisch', () => {
    for (const [legacy, canonical] of Object.entries(aliasExpectations)) {
      expect(resolveCanonicalSlug(legacy)).toBe(canonical);
    }
  });

  it('resolveCanonicalSlug: kanonisch bleibt unverändert', () => {
    for (const slug of ALL_CANONICAL_SLUGS) {
      expect(resolveCanonicalSlug(slug)).toBe(slug);
    }
    // unbekannte Slugs werden unverändert zurückgegeben (Aufrufer entscheidet)
    expect(resolveCanonicalSlug('unbekanntes-spiel')).toBe('unbekanntes-spiel');
    expect(resolveCanonicalSlug(null)).toBeNull();
    expect(resolveCanonicalSlug('')).toBeNull();
  });

  it('getGameManifest: Legacy-Slug liefert das kanonische Manifest', () => {
    expect(getGameManifest('geo')?.slug).toBe('wissensduell');
    expect(getGameManifest('weristdas')?.slug).toBe('wer-ist-das');
    expect(getGameManifest('song')?.slug).toBe('song-quiz');
    // kanonisch direkt
    expect(getGameManifest('jeopardy')?.slug).toBe('jeopardy');
    // unbekannt
    expect(getGameManifest('definitiv-nicht-da')).toBeUndefined();
  });
});

describe('Ehrlicher Status & Startbarkeit (§13.1)', () => {
  const availableSlugs = GAME_MANIFESTS.filter((m) => m.status === 'AVAILABLE').map((m) => m.slug);
  const plannedSlugs = GAME_MANIFESTS.filter((m) => m.status === 'PLANNED').map((m) => m.slug);

  it('exakt diese drei sind AVAILABLE (nachgewiesene Engine + getesteter Ablauf)', () => {
    expect([...availableSlugs].sort()).toEqual(['jeopardy', 'wer-ist-das', 'wissensduell'].sort());
  });

  it('startbare Spiele (AVAILABLE/BETA) haben einen echten Registry-Handler', () => {
    for (const m of GAME_MANIFESTS) {
      if (m.status === 'AVAILABLE' || m.status === 'BETA') {
        expect(getGameHandler(m.slug), `kein Handler für ${m.slug}`).not.toBeNull();
      }
    }
  });

  it('geplante Spiele sind NICHT startbar (kein Registry-Handler)', () => {
    expect(plannedSlugs.length).toBe(18 - availableSlugs.length - GAME_MANIFESTS.filter((m) => m.status === 'HIDDEN' || m.status === 'BETA').length);
    for (const slug of plannedSlugs) {
      expect(isStartableSlug(slug), `${slug} sollte nicht startbar sein`).toBe(false);
      expect(getGameHandler(slug), `${slug} hätte unerwartet einen Handler`).toBeNull();
    }
  });

  it('Registry listet genau die AVAILABLE-Slugs als startbar', () => {
    expect([...startableSlugs()].sort()).toEqual([...availableSlugs].sort());
    expect([...listGames()].sort()).toEqual([...availableSlugs].sort());
  });

  it('Legacy-Slugs der startbaren Spiele lösen auf den Handler auf', () => {
    // alte Links/Räume mit "geo" / "weristdas" finden weiterhin den Handler
    expect(isStartableSlug('geo')).toBe(true);
    expect(isStartableSlug('weristdas')).toBe(true);
    expect(getGameHandler('geo')?.slug).toBe('wissensduell');
    expect(getGameHandler('weristdas')?.slug).toBe('wer-ist-das');
  });
});

describe('Seed ↔ Katalog-Sync (Regelwerk §14)', () => {
  // prisma/seed.ts läuft vom Repo-Root und importiert @quiz/shared NICHT
  // (pnpm verlinkt den Workspace-Import nicht ins Root). Deshalb: Guard-Test,
  // der die im Seed hart kodierte Spiel-Menge mit dem kanonischen Katalog
  // abgleicht. Wenn @quiz/shared sich ändert, schlägt dieser Test rot,
  // bis der Seed synchronisiert wurde.
  // Test-Datei liegt in apps/server/src/games/ → Monorepo-Root ist 4 Ebenen hoch
  // (games → src → server → apps → root).
  const gamesDir = resolve(fileURLToPath(import.meta.url), '..');
  const rootDir = resolve(gamesDir, '..', '..', '..', '..');
  const seedSource = readFileSync(resolve(rootDir, 'prisma', 'seed.ts'), 'utf8');

  it('Seed definiert exakt die 18 kanonischen Slugs (keine Legacy, keine Doppelungen)', () => {
    // Nur die `slug: '...'`-Felder der Spiel-Menge zählen (nicht das gameSlug des Fragepakets)
    const gameSlugs = [...seedSource.matchAll(/\{\s*slug:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(gameSlugs).toHaveLength(18);
    expect(new Set(gameSlugs).size).toBe(18); // keine Doppelung
    const canonicalSet = new Set(GAME_MANIFESTS.map((m) => m.slug));
    expect(new Set(gameSlugs)).toEqual(canonicalSet);
    // kein Legacy-Slug im Seed
    for (const legacy of Object.keys(LEGACY_SLUG_ALIASES)) {
      expect(gameSlugs, `Legacy ${legacy} im Seed`).not.toContain(legacy);
    }
  });

  it('Seed-Status stimmt mit dem ehrlichen Katalog-Status überein', () => {
    const statusMatches = [...seedSource.matchAll(/\{\s*slug:\s*'([^']+)'[\s\S]*?status:\s*'([^']+)'/g)]
      .map((m) => ({ slug: m[1], status: m[2] }));
    expect(statusMatches).toHaveLength(18);
    for (const { slug, status } of statusMatches) {
      const manifest = GAME_MANIFESTS.find((m) => m.slug === slug)!;
      expect(manifest, `Manifest für ${slug}`).toBeDefined();
      expect(status, `Status für ${slug}`).toBe(manifest.status);
    }
  });

  it('Default-Fragepaket nutzt den kanonischen Slug wissensduell (nicht "geo")', () => {
    expect(seedSource).toMatch(/gameSlug:\s*'wissensduell'/);
    expect(seedSource).not.toMatch(/gameSlug:\s*'geo'/);
  });
});

describe('Catalog-API ↔ @quiz/shared Übereinstimmung (§12.1)', () => {
  const { app } = createApp();
  const api = supertest(app);

  it('GET /api/v1/catalog/games liefert genau die sichtbaren Manifeste', async () => {
    const res = await api.get('/api/v1/catalog/games').expect(200);
    expect(res.body.success).toBe(true);
    const visible = GAME_MANIFESTS.filter((m) => m.status !== 'HIDDEN');
    expect(res.body.data).toHaveLength(visible.length);
    const apiSlugs = new Set(res.body.data.map((g: GameManifest) => g.slug));
    for (const m of visible) expect(apiSlugs.has(m.slug)).toBe(true);
    // Manifest-Inhalte identisch (Shared ist Single Source)
    for (const apiGame of res.body.data as GameManifest[]) {
      const expected = GAME_MANIFESTS.find((m) => m.slug === apiGame.slug)!;
      expect(apiGame).toEqual(expected);
    }
  });

  it('GET /api/v1/catalog/games?showAll=true enthält auch HIDDEN', async () => {
    const res = await api.get('/api/v1/catalog/games?showAll=true').expect(200);
    expect(res.body.data).toHaveLength(GAME_MANIFESTS.length);
  });

  it('GET /api/v1/catalog/games?status=AVAILABLE filtert korrekt', async () => {
    const res = await api.get('/api/v1/catalog/games?status=AVAILABLE').expect(200);
    const expected = GAME_MANIFESTS.filter((m) => m.status === 'AVAILABLE').map((m) => m.slug);
    expect(res.body.data.map((g: GameManifest) => g.slug).sort()).toEqual(expected.sort());
  });

  it('GET /api/v1/catalog/categories stimmt mit deriveVisibleCategories überein (echte gameCount)', async () => {
    const res = await api.get('/api/v1/catalog/categories').expect(200);
    expect(res.body.success).toBe(true);
    const expected = deriveVisibleCategories();
    expect(res.body.data).toHaveLength(expected.length);
    for (const apiCat of res.body.data as Array<{ slug: string; gameCount: number; id: string }>) {
      const exp = expected.find((c) => c.slug === apiCat.slug)!;
      expect(exp).toBeDefined();
      expect(apiCat.gameCount).toBe(exp.gameCount);
      expect(apiCat.id).toBe(exp.slug);
      // gameCount muss der tatsächlichen Anzahl sichtbarer Spiele entsprechen
      const realCount = GAME_MANIFESTS.filter((m) => m.category === exp.slug && m.status !== 'HIDDEN').length;
      expect(apiCat.gameCount).toBe(realCount);
    }
  });

  it('GET /api/v1/catalog/meta: startable stimmt mit der Registry überein', async () => {
    const res = await api.get('/api/v1/catalog/meta').expect(200);
    expect(res.body.success).toBe(true);
    for (const entry of res.body.data as Array<{ slug: string; status: string; startable: boolean }>) {
      expect(entry.startable, `meta.startable für ${entry.slug}`).toBe(isStartableSlug(entry.slug));
    }
    const startable = res.body.data.filter((e: { startable: boolean }) => e.startable).map((e: { slug: string }) => e.slug);
    expect([...startable].sort()).toEqual([...startableSlugs()].sort());
  });

  it('GET /api/v1/catalog/games/:slug – Legacy löst per 301 auf kanonisch weiter', async () => {
    const res = await api.get('/api/v1/catalog/games/geo').expect(301);
    expect(res.headers.location).toBe('/api/v1/catalog/games/wissensduell');
    const res2 = await api.get('/api/v1/catalog/games/weristdas').expect(301);
    expect(res2.headers.location).toBe('/api/v1/catalog/games/wer-ist-das');
  });

  it('GET /api/v1/catalog/games/:slug – kanonisch liefert Manifest, unbekannt 404', async () => {
    const ok = await api.get('/api/v1/catalog/games/wissensduell').expect(200);
    expect(ok.body.data.slug).toBe('wissensduell');
    expect(ok.body.data.name).toBe('Wissensduell');
    await api.get('/api/v1/catalog/games/definitiv-nicht-da').expect(404);
  });
});
