// ============================================================
// Setup Drafts Router
// ============================================================

import { Router } from 'express';
import { prisma } from '../persistence/prisma.js';
import { verifySession } from '../auth/session.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';

export const setupRouter : ReturnType<typeof Router> = Router();

// GET /api/v1/setups/:id
setupRouter.get('/:id', async (req, res) => {
  try {
    const draft = await prisma.setupDraft.findUnique({
      where: { id: req.params.id },
      include: { gameDefinition: true },
    });

    if (!draft) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Entwurf nicht gefunden.' },
      });
    }

    res.json({
      success: true,
      data: {
        id: draft.id,
        game: draft.gameDefinition,
        config: JSON.parse(draft.configJson),
        content: JSON.parse(draft.contentJson),
        schemaVersion: draft.schemaVersion,
        isValid: draft.isValid,
        validationErrors: draft.validationErrors ? JSON.parse(draft.validationErrors) : null,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      },
    });
  } catch (error) {
    logger.error('Failed to get setup draft', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Entwurf konnte nicht geladen werden.' },
    });
  }
});

// POST /api/v1/setups
setupRouter.post('/', async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' },
      });
    }

    const { gameDefinitionId, config: setupConfig, content } = req.body;

    if (!gameDefinitionId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION', message: 'Spiel-ID erforderlich.' },
      });
    }

    const draft = await prisma.setupDraft.create({
      data: {
        gameDefinitionId,
        ownerId: (await prisma.session.findUnique({ where: { id: sessionId } }))?.userId,
        configJson: JSON.stringify(setupConfig || {}),
        contentJson: JSON.stringify(content || {}),
      },
    });

    res.status(201).json({
      success: true,
      data: { id: draft.id },
    });
  } catch (error) {
    logger.error('Failed to create setup draft', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Entwurf konnte nicht erstellt werden.' },
    });
  }
});

// PUT /api/v1/setups/:id
setupRouter.put('/:id', async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' },
      });
    }

    const { config: setupConfig, content, isValid, validationErrors } = req.body;

    const draft = await prisma.setupDraft.update({
      where: { id: req.params.id },
      data: {
        configJson: setupConfig !== undefined ? JSON.stringify(setupConfig) : undefined,
        contentJson: content !== undefined ? JSON.stringify(content) : undefined,
        isValid: isValid !== undefined ? isValid : undefined,
        validationErrors: validationErrors !== undefined ? JSON.stringify(validationErrors) : undefined,
      },
    });

    res.json({
      success: true,
      data: { id: draft.id, isValid: draft.isValid },
    });
  } catch (error) {
    logger.error('Failed to update setup draft', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Entwurf konnte nicht aktualisiert werden.' },
    });
  }
});
