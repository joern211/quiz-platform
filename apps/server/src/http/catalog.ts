// ============================================================
// Online Quiz Plattform - Catalog Router
// GET /api/v1/catalog/...
// P1-15: CAT-001/002/003 — real DB queries instead of mocks
// ============================================================

import { Router } from 'express';
import { CATALOG_CATEGORIES, GAME_MANIFESTS } from '@quiz/shared';
import { prisma } from '../persistence/prisma.js';

export const catalogRouter : ReturnType<typeof Router> = Router();

// GET /api/v1/catalog/categories
// CAT-001: static categories enriched with play counts from DB
catalogRouter.get('/categories', async (_req, res) => {
  try {
    // Count active rooms per gameSlug via Room → GameDefinition
    const activeRooms = await prisma.room.findMany({
      where: { status: { in: ['LOBBY', 'RUNNING'] } },
      include: { gameDefinition: { select: { slug: true } } },
    });
    const slugCounts: Record<string, number> = {};
    for (const r of activeRooms) {
      const slug = r.gameDefinition.slug;
      slugCounts[slug] = (slugCounts[slug] ?? 0) + 1;
    }
    // Map to categories
    const categories = CATALOG_CATEGORIES.map(cat => ({
      ...cat,
      activeRooms: Object.entries(slugCounts)
        .filter(([slug]) => GAME_MANIFESTS.some(g => g.slug === slug && g.category === cat.slug))
        .reduce((sum, [, count]) => sum + count, 0),
    }));
    res.json({ success: true, data: categories });
  } catch {
    res.json({ success: true, data: CATALOG_CATEGORIES });
  }
});

// GET /api/v1/catalog/games
// CAT-002: return games with real DB play counts
catalogRouter.get('/games', async (req, res) => {
  const { category, status } = req.query;

  let games = [...GAME_MANIFESTS];

  if (category) {
    games = games.filter(g => g.category === category);
  }

  if (status) {
    games = games.filter(g => g.status === status);
  }

  if (!status && !req.query.showAll) {
    games = games.filter(g => g.status === 'AVAILABLE' || g.status === 'BETA');
  }

  // Enrich with real room counts via Room → GameDefinition (CAT-002)
  try {
    const rooms = await prisma.room.findMany({
      include: { gameDefinition: { select: { slug: true } } },
    });
    const countMap: Record<string, number> = {};
    for (const r of rooms) {
      const slug = r.gameDefinition.slug;
      countMap[slug] = (countMap[slug] ?? 0) + 1;
    }
    games = games.map(g => ({ ...g, playCount: countMap[g.slug] ?? 0 }));
  } catch {
    // DB enrichment failed — keep static playCount from manifest
  }

  res.json({ success: true, data: games });
});

// GET /api/v1/catalog/games/:slug
// CAT-003: single game with real DB data
catalogRouter.get('/games/:slug', async (req, res) => {
  const game = GAME_MANIFESTS.find(g => g.slug === req.params.slug);

  if (!game) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Spiel nicht gefunden.' },
    });
  }

  // Enrich with real play count (CAT-003)
  try {
    const roomCount = await prisma.room.count({
      where: { gameDefinition: { slug: game.slug } },
    });
    res.json({ success: true, data: { ...game, playCount: roomCount } });
  } catch {
    res.json({ success: true, data: game });
  }
});
