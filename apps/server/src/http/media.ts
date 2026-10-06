// ============================================================
// Media Router — Upload + geschützte Auslieferung
//
// Regelwerk §7.3/§7.6/§7.7/§7.8/§7.9, §10.7/§10.8:
//   - MIME + echten Content prüfen (nicht nur client-beschrieben),
//     serverseitig decodieren, Metadaten säubern.
//   - PRIVATE/SHARED/ROOM_TEMP: keine permanente offene URL,
//     Auth + kurzlebige Signed URL, storagePath nie an den Browser.
//   - Keine öffentliche Langzeit-Cache für nicht-öffentliche Inhalte.
//
// Zugriff:
//   - PUBLIC / SYSTEM  → offen, kurz cachebar (Geo/Wissensduell-Public-Medien).
//   - Sonst            → nur über gültige Signed URL (`?exp=…&sig=…`):
//        audience "game" → freigegebenes Spielbild (Composite / v1-Bild),
//                          an Player/Viewer/Display ohne Login.
//        audience "host" → Originale, NUR zusätzlich mit Session eines
//                          berechtigten Hosts (uploader == user ODER
//                          user == Host von asset.roomId).
// ============================================================

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import { prisma } from '../persistence/prisma.js';
import { verifySession } from '../auth/session.js';
import { logger } from '../observability/logger.js';
import { config } from '../config/index.js';
import {
  signMediaAccess, buildSignedMediaUrl, verifySignedAccess,
  MEDIA_URL_TTL_SECONDS, MEDIA_HOST_URL_TTL_SECONDS, type MediaUrlAudience,
} from '../media/signedUrl.js';

export const mediaRouter : ReturnType<typeof Router> = Router();

// Re-Export für bestehende Importe (Tests nutzen sie über media.js).
export { signMediaAccess, buildSignedMediaUrl, verifySignedAccess, MEDIA_URL_TTL_SECONDS, MEDIA_HOST_URL_TTL_SECONDS };
export type { MediaUrlAudience };

// ------------------------------------------------------------
// (Signed-URL-Helfer leben jetzt in media/signedUrl.ts)
// ------------------------------------------------------------

// ------------------------------------------------------------
// Upload-Storage
// ------------------------------------------------------------

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const uploadDir = path.resolve(config.storagePaths.uploads);
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (_req, _file, cb) => {
    const uniqueId = crypto.randomBytes(16).toString('hex');
    cb(null, `${uniqueId}.bin`); // Suffix kommt erst nach Content-Prüfung
  },
});

const upload = multer({ storage, limits: { fileSize: config.maxFileSizes.image } });

// ------------------------------------------------------------
// Content-Prüfung: echter Content, keine Client-Claims
// ------------------------------------------------------------

interface ProcessedMedia {
  ok: boolean;
  error?: { code: string; message: string };
  buffer?: Buffer;
  type?: 'image' | 'audio';
  mimeType?: string;
  width?: number;
  height?: number;
}

function detectAudioMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'audio/mpeg'; // ID3 (MP3)
  if (buf[0] === 0xFF && (buf[1] & 0xE6) === 0xE2) return 'audio/mpeg'; // MP3 frame sync
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'audio/wav'; // RIFF (WAV)
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4'; // M4A/AAC
  if (buf.slice(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  return null;
}

/**
 * Prüft den tatsächlichen Content. Bilder: decodieren via sharp, EXIF/Metadaten-
 * Strip, als WebP normalisieren. Audio: Magic-Bytes prüfen, Content unverändert.
 * Das Format/MIME kommt aus dem Content, nie aus der Client-Assertion.
 */
async function processUploaded(filePath: string, fileSize: number): Promise<ProcessedMedia> {
  const rejected = (message: string): ProcessedMedia => ({ ok: false, error: { code: 'MEDIA_REJECTED', message } });
  try {
    const buf = await fs.readFile(filePath);
    if (fileSize > config.maxFileSizes.image) return rejected('Datei ist zu groß.');

    // Erst: Bild? sharp meldet bei nicht-Bildern einen Fehler.
    let imageMeta: { width?: number; height?: number; format?: string } | null = null;
    try {
      const input = sharp(filePath, { failOn: 'error' });
      const metadata = await input.metadata();
      if (metadata.format && metadata.width && metadata.height) imageMeta = metadata;
    } catch {
      imageMeta = null; // kein Bild → evtl. Audio
    }

    if (imageMeta) {
      const { width, height, format } = imageMeta;
      if (width! > config.maxFileSizes.imageDimension || height! > config.maxFileSizes.imageDimension) {
        return rejected(`Bild ist zu groß (max. ${config.maxFileSizes.imageDimension}px).`);
      }
      if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
        return rejected('Nur JPG, PNG oder WebP sind erlaubt.');
      }
      const normalized = await sharp(filePath, { animated: false })
        .rotate() // EXIF-Orientation anwenden
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      return { ok: true, buffer: normalized.data, type: 'image', mimeType: 'image/webp', width, height };
    }

    // Kein Bild → Audio?
    const audioMime = detectAudioMime(buf);
    if (audioMime) {
      return { ok: true, buffer: buf, type: 'audio', mimeType: audioMime };
    }

    return rejected('Nicht unterstützter oder beschädigter Inhalt (nur JPG/PNG/WebP oder MP3/WAV/M4A/AAC/OGG).');
  } catch {
    return rejected('Datei konnte nicht gelesen oder verarbeitet werden.');
  }
}

// ------------------------------------------------------------
// POST /api/v1/media — Upload (Session erforderlich)
// ------------------------------------------------------------

mediaRouter.post('/', upload.single('file'), async (req, res) => {
  const uploadedPath: string | undefined = (req as { file?: { path: string } }).file?.path;
  const uploadedSize: number = (req as { file?: { size: number } }).file?.size ?? 0;
  const removeUploaded = () => { if (uploadedPath) fs.unlink(uploadedPath).catch(() => {}); };

  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      removeUploaded();
      return res.status(401).json({ success: false, error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' } });
    }
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      removeUploaded();
      return res.status(401).json({ success: false, error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' } });
    }
    if (!uploadedPath) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Keine Datei hochgeladen.' } });
    }

    const processed = await processUploaded(uploadedPath, uploadedSize);
    if (!processed.ok || !processed.buffer) {
      removeUploaded();
      return res.status(415).json({ success: false, error: processed.error });
    }

    // Normalisiertes/neues Ergebnis ablegen (Bilder: WebP, saubere Metadaten).
    const ext = processed.type === 'image' ? '.webp' : path.extname(
      (req as { file?: { originalname: string } }).file?.originalname ?? ''
    ) || '.bin';
    const outPath = path.join(path.dirname(uploadedPath), crypto.randomBytes(16).toString('hex') + ext);
    await fs.writeFile(outPath, processed.buffer);
    await fs.unlink(uploadedPath).catch(() => {});

    const sha256 = crypto.createHash('sha256').update(processed.buffer).digest('hex');

    // Dedupe: gleiche Bytes + gleicher Uploader → Asset wiederverwenden (kein 500, keine Duplizierung).
    const existing = await prisma.mediaAsset.findUnique({ where: { sha256 } });
    if (existing && existing.uploadedBy === session.userId) {
      await fs.unlink(outPath).catch(() => {});
      return res.status(200).json({
        success: true,
        data: { id: existing.id, type: existing.type, mimeType: existing.mimeType, filename: existing.filename, fileSize: existing.fileSize, deduplicated: true },
      });
    }

    const asset = await prisma.mediaAsset.create({
      data: {
        type: processed.type!,
        mimeType: processed.mimeType!,
        filename: path.basename(outPath),
        originalName: (req as { file?: { originalname: string } }).file?.originalname ?? 'upload', // Audit-only, nie an Client
        fileSize: processed.buffer.length,
        width: processed.width ?? null,
        height: processed.height ?? null,
        sha256,
        storagePath: outPath,
        uploadedBy: session.userId,
        visibility: 'PRIVATE',
        processStatus: 'READY',
        processed: processed.type === 'image',
      },
    });
    logger.info('Media uploaded (validated)', { assetId: asset.id, type: processed.type, size: processed.buffer.length });
    return res.status(201).json({
      success: true,
      data: { id: asset.id, type: processed.type, mimeType: processed.mimeType, filename: asset.filename, fileSize: asset.fileSize },
    });
  } catch (error) {
    removeUploaded();
    logger.error('Failed to upload media', { error });
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Upload fehlgeschlagen.' } });
  }
});

// ------------------------------------------------------------
// POST /api/v1/media/composite — Fusion-Spielbild erzeugen (PR11, §15.3)
//
// Zwei vom Host selbst hochgeladene Originale → ein reproduzierbares,
// EINMAL persistiertes Composite (ROOM_TEMP, roomId, derivedFrom).
// Idempotent: gleiche Quellen + Algorithmus → gleiche Asset-ID, keine
// Duplikate bei Wiederholungsaufruf.
// ------------------------------------------------------------

mediaRouter.post('/composite', async (req, res) => {
  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      return res.status(401).json({ success: false, error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' } });
    }
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return res.status(401).json({ success: false, error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' } });
    }

    const body = z.object({
      personAImageAssetId: z.string().uuid(),
      personBImageAssetId: z.string().uuid(),
      roundId: z.string().min(1).max(100),
      roomId: z.string().min(1).max(100).optional(),
    });
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Ungültige Parameter.' } });
    }
    const { personAImageAssetId, personBImageAssetId, roundId, roomId } = parsed.data;
    if (personAImageAssetId === personBImageAssetId) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Beide Bilder müssen unterschiedlich sein.' } });
    }
    // Ein Raum wird nur für ROOM_TEMP gesetzt, wenn der aufrufende Host den
    // Raum besitzt (sonst bleibt roomId leer — kein fremdes Raum-Asset).
    let effectiveRoomId: string | null = null;
    if (roomId) {
      const room = await prisma.room.findUnique({ where: { id: roomId }, select: { id: true, hostUserId: true } });
      if (!room || room.hostUserId !== session.userId) {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Raum gehört dir nicht.' } });
      }
      effectiveRoomId = room.id;
    }

    const { createGameImage } = await import('../games/weristdas/composite.js');
    const result = await createGameImage({
      personAImageAssetId,
      personBImageAssetId,
      hostUserId: session.userId,
      roomId: effectiveRoomId ?? `tmp-${session.userId}`,
      roundId,
    });
    return res.status(201).json({
      success: true,
      data: {
        gameImageAssetId: result.gameImageAssetId,
        width: result.width,
        height: result.height,
        gameImageUrl: buildSignedMediaUrl({ assetId: result.gameImageAssetId, audience: 'game' }),
      },
    });
  } catch (error) {
    const message = (error as Error).message;
    const publicErrors = ['ASSET_NOT_FOUND', 'ASSET_NOT_IMAGE', 'ASSET_NOT_READY', 'ASSET_NOT_OWNED', 'ASSET_FILE_MISSING', 'SOURCES_MUST_DIFFER', 'COMPOSITE_FAILED'];
    const code = publicErrors.includes(message) ? message : 'INTERNAL_ERROR';
    const friendly = {
      ASSET_NOT_FOUND: 'Ein Bild wurde nicht gefunden.',
      ASSET_NOT_IMAGE: 'Ein gewähltes Asset ist kein Bild.',
      ASSET_NOT_READY: 'Ein Bild ist noch nicht verarbeitet.',
      ASSET_NOT_OWNED: 'Ein Bild gehört dir nicht.',
      ASSET_FILE_MISSING: 'Eine Bilddatei fehlt.',
      SOURCES_MUST_DIFFER: 'Beide Bilder müssen unterschiedlich sein.',
      COMPOSITE_FAILED: 'Das Spielbild konnte nicht erzeugt werden.',
      INTERNAL_ERROR: 'Fehler bei der Erstellung des Spielbilds.',
    }[code];
    if (code === 'INTERNAL_ERROR') logger.error('Composite failed', { error });
    const status = code === 'ASSET_NOT_FOUND' || code === 'ASSET_FILE_MISSING' ? 404
      : code === 'INTERNAL_ERROR' ? 500 : 400;
    return res.status(status).json({ success: false, error: { code, message: friendly } });
  }
});

// ------------------------------------------------------------
// GET /api/v1/media/host/:id — Original-Assets für den Host-Kontext
// (Reveal-Vorschau, Setup-Korrektur). Zusätzlich zur Signed-URL mit
// audience "host" ist eine gültige Session + (uploader ODER Raum-Host)
// erforderlich. Spieler-/Zuschauer-Projektionen nutzen diese Route nie.
// ------------------------------------------------------------

mediaRouter.get('/host/:id', async (req, res) => {
  try {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: req.params.id } });
    if (!asset || asset.visibility === 'PUBLIC' || asset.visibility === 'SYSTEM') {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Medium nicht gefunden.' } });
    }
    const sessionId = verifySession(req, config.sessionSecret);
    const session = sessionId ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
    const allowed = Boolean(session && (
      asset.uploadedBy === session.userId
      || (asset.roomId ? await isRoomHost(asset.roomId, session.userId) : false)
    ));
    if (!allowed) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Zugriff nicht erlaubt.' } });
    }
    try {
      await fs.access(asset.storagePath);
    } catch {
      return res.status(404).json({ success: false, error: { code: 'FILE_MISSING', message: 'Datei nicht gefunden.' } });
    }
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Content-Disposition', 'inline; filename="media"');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.resolve(asset.storagePath));
  } catch (error) {
    logger.error('Failed to get host media', { error });
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Medium konnte nicht geladen werden.' } });
  }
});

// ------------------------------------------------------------
// GET /api/v1/media/:id — Zugriffspolitik + Signed-URL-Prüfung
// ------------------------------------------------------------

async function isRoomHost(roomId: string, userId: string): Promise<boolean> {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { hostUserId: true } });
  return room?.hostUserId === userId;
}

mediaRouter.get('/:id', async (req, res) => {
  try {
    const asset = await prisma.mediaAsset.findUnique({ where: { id: req.params.id } });
    if (!asset) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Medium nicht gefunden.' } });
    }
    try {
      await fs.access(asset.storagePath);
    } catch {
      return res.status(404).json({ success: false, error: { code: 'FILE_MISSING', message: 'Datei nicht gefunden.' } });
    }

    const isPublic = asset.visibility === 'PUBLIC' || asset.visibility === 'SYSTEM';
    let allowed = false;

    if (isPublic) {
      allowed = true;
    } else {
      const exp = req.query.exp as string | undefined;
      const sig = req.query.sig as string | undefined;
      const gameOk = verifySignedAccess({ assetId: asset.id, audience: 'game', exp, sig });
      const hostSigOk = verifySignedAccess({ assetId: asset.id, audience: 'host', exp, sig });

      if (gameOk) {
        // Freigegebenes Spielbild (Composite / v1-Bild) → Player/Viewer/Display.
        allowed = true;
      } else if (hostSigOk) {
        // Originale: zusätzlich gültige Session + Host-Recht.
        const sessionId = verifySession(req, config.sessionSecret);
        const session = sessionId ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
        if (session && (asset.uploadedBy === session.userId
          || (asset.roomId ? await isRoomHost(asset.roomId, session.userId) : false))) {
          allowed = true;
        }
      }
    }

    if (!allowed) {
      // Generisch: keine Existenz-/Rechte-Leaks.
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Zugriff nicht erlaubt.' } });
    }

    res.setHeader('Content-Type', asset.mimeType);
    // Nie storagePath/originalName in Header. Nicht-öffentliche: no-store.
    res.setHeader('Content-Disposition', 'inline; filename="media"');
    res.setHeader('Cache-Control', isPublic ? 'public, max-age=86400' : 'no-store');
    res.sendFile(path.resolve(asset.storagePath));
  } catch (error) {
    logger.error('Failed to get media', { error });
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Medium konnte nicht geladen werden.' } });
  }
});
