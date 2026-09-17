// ============================================================
// Media Upload Router
// ============================================================

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { prisma } from '../persistence/prisma.js';
import { verifySession } from '../auth/session.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';

export const mediaRouter = Router();

// Configure multer
const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const uploadDir = path.resolve(config.storagePaths.uploads);
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSizes.upload },
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      'image/png', 'image/jpeg', 'image/webp',
      'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Nicht unterstützter Dateityp'));
    }
  },
});

// POST /api/v1/media - Upload media
mediaRouter.post('/', upload.single('file'), async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' },
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION', message: 'Keine Datei hochgeladen.' },
      });
    }

    // Calculate hash
    const fileBuffer = await fs.readFile(req.file.path);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Determine type
    const mimeType = req.file.mimetype;
    const type = mimeType.startsWith('image/') ? 'image' : 'audio';

    // Create database entry
    const asset = await prisma.mediaAsset.create({
      data: {
        type,
        mimeType,
        filename: req.file.filename,
        originalName: req.file.originalname,
        fileSize: req.file.size,
        sha256,
        storagePath: req.file.path,
        uploadedBy: (await prisma.session.findUnique({ where: { id: sessionId } }))?.userId,
        visibility: 'PRIVATE',
      },
    });

    logger.info('Media uploaded', { assetId: asset.id, mimeType, size: req.file.size });

    res.status(201).json({
      success: true,
      data: {
        id: asset.id,
        type: asset.type,
        mimeType: asset.mimeType,
        filename: asset.filename,
        fileSize: asset.fileSize,
      },
    });
  } catch (error) {
    logger.error('Failed to upload media', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Upload fehlgeschlagen.' },
    });
  }
});

// GET /api/v1/media/:id - Get media
mediaRouter.get('/:id', async (req, res) => {
  try {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: req.params.id },
    });

    if (!asset) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Medium nicht gefunden.' },
      });
    }

    // Check file exists
    try {
      await fs.access(asset.storagePath);
    } catch {
      return res.status(404).json({
        success: false,
        error: { code: 'FILE_MISSING', message: 'Datei nicht gefunden.' },
      });
    }

    // Set headers and send file
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${asset.originalName}"`);
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache
    
    res.sendFile(path.resolve(asset.storagePath));
  } catch (error) {
    logger.error('Failed to get media', { error });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Medium konnte nicht geladen werden.' },
    });
  }
});
