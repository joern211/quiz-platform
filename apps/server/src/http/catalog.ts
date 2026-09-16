// ============================================================
// Online Quiz Plattform - Catalog Router
// GET /api/v1/catalog/...
// ============================================================

import { Router } from 'express';
import { CATALOG_CATEGORIES, GAME_MANIFESTS } from '@quiz/shared';

export const catalogRouter = Router();

// GET /api/v1/catalog/categories
catalogRouter.get('/categories', (_req, res) => {
  res.json({
    success: true,
    data: CATALOG_CATEGORIES,
  });
});

// GET /api/v1/catalog/games
catalogRouter.get('/games', (req, res) => {
  const { category, status } = req.query;
  
  let games = [...GAME_MANIFESTS];
  
  if (category) {
    games = games.filter(g => g.category === category);
  }
  
  if (status) {
    games = games.filter(g => g.status === status);
  }
  
  // Default: only show AVAILABLE and BETA
  if (!status && !req.query.showAll) {
    games = games.filter(g => g.status === 'AVAILABLE' || g.status === 'BETA');
  }

  res.json({
    success: true,
    data: games,
  });
});

// GET /api/v1/catalog/games/:slug
catalogRouter.get('/games/:slug', (req, res) => {
  const game = GAME_MANIFESTS.find(g => g.slug === req.params.slug);
  
  if (!game) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Spiel nicht gefunden.' },
    });
  }

  res.json({
    success: true,
    data: game,
  });
});
