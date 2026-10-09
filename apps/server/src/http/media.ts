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
//        audience "game" → NUR wenn das Asset in einem Raumsnapshot als
//                          freigegebenes Spielbild referenziert ist
//                          (v1: imageAssetId, v2: gameImageAssetId) — an
//                          Player/Viewer/Display ohne Login. Eine game-Sig
//                          auf ein Original oder ein fremdes Rundenbild
//                          taugt NICHTS (Endpunkt-Prüfung, Nacharbeit C).
//        audience "host" → Originale, NUR zusätzlich mit gültiger, nicht
//                          widerrufen und nicht abgelaufener Session eines
//                          berechtigten Hosts (uploader == user ODER user
//                          == Host von asset.roomId).
//   - Der separate GET /media/host/:id-Pfad existiert NICHT mehr (Nacharbeit
//     C): er umging Signed-URL-Prüfung und die Session-Gültigkeitsprüfung;
//     die Host-Vorschau läuft über die host-audience-Signed-URL von /:id.
// ============================================================

import { Router } from 'express';
import type { Request } from 'express';
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

/** Erkennt Prisma-Unique-Konflikte (P2002) robust an code/message. */
function isUniqueConflict(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: string; message?: string };
  if (e.code === 'P2002') return true;
  return typeof e.message === 'string' && /Unique constraint failed|UNIQUE constraint failed/i.test(e.message);
}

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
  // Alle von UNS erzeugten Pfade zuverlässig aufräumen (Nacharbeit B):
  // `uploadedPath` (Rohupload) und `outPath` (normalisiertes Ergebnis).
  // Wir löschen NUR eigene Dateien — nie eine Datei, auf die ein anderer
  // DB-Eintrag verweist (Dedupe-Winner hat seinen eigenen storagePath).
  let outPath: string | undefined;
  const removeUploaded = () => { if (uploadedPath) return fs.unlink(uploadedPath).catch(() => {}); return Promise.resolve(); };
  // Async + AWAITED auf allen Antwortpfaden (Nacharbeit B): erst wenn die
  // eigenen Dateien wirklich weg sind, wird geantwortet — kein Fenster, in
  // dem ein Orphan existiert (sonst racing File-Counts in Tests/Operation).
  const cleanup = async () => { await removeUploaded(); if (outPath) { const p = outPath; outPath = undefined; await fs.unlink(p).catch(() => {}); } };

  try {
    const sessionId = verifySession(req, config.sessionSecret);
    if (!sessionId) {
      await cleanup();
      return res.status(401).json({ success: false, error: { code: 'NOT_AUTHENTICATED', message: 'Anmeldung erforderlich.' } });
    }
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      await cleanup();
      return res.status(401).json({ success: false, error: { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen.' } });
    }
    if (!uploadedPath) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Keine Datei hochgeladen.' } });
    }

    const processed = await processUploaded(uploadedPath, uploadedSize);
    if (!processed.ok || !processed.buffer) {
      await cleanup();
      return res.status(415).json({ success: false, error: processed.error });
    }

    // Normalisiertes/neues Ergebnis ablegen (Bilder: WebP, saubere Metadaten).
    const ext = processed.type === 'image' ? '.webp' : path.extname(
      (req as { file?: { originalname: string } }).file?.originalname ?? ''
    ) || '.bin';
    outPath = path.join(path.dirname(uploadedPath), crypto.randomBytes(16).toString('hex') + ext);
    await fs.writeFile(outPath, processed.buffer);
    await fs.unlink(uploadedPath).catch(() => {});

    const sha256 = crypto.createHash('sha256').update(processed.buffer).digest('hex');
    const ownerId = session.userId;
    // Audit 11-03/11-04: LOGISCHE Identität für Uploads = Content-Hash
    // (`assetKey = sha256`), getrennt pro Uploader UND pro Zugriffskontext
    // (visibility). Ein Upload ist IMMER PRIVATE; ein frischer PRIVATE-Upload
    // erbt den Kontext (visibility) einer bestehenden PUBLIC-Zeile NICHT (11-04).
    const assetKey = sha256;
    const targetVisibility = 'PRIVATE';

    // (1) Dedupe im GLEICHEN Kontext: (assetKey, Owner, PRIVATE).
    //   Zeile vorhanden + Datei da + READY → wiederverwenden (200).
    //   Zeile vorhanden, aber Datei fehlt / FAILED → Reparatur derselben Zeile
    //   (gleiche ID, neues storagePath, READY) — erst NACH Erfolg die Datei
    //   übergeben (11-07: keine Orphan-Datei bei fehlgeschlagener Reparatur).
    const existing = await prisma.mediaAsset.findFirst({
      where: { assetKey, uploadedBy: ownerId, visibility: targetVisibility },
    });
    if (existing) {
      let fileOk = true;
      try { await fs.access(existing.storagePath); } catch { fileOk = false; }
      if (fileOk && existing.processStatus === 'READY') {
        await fs.unlink(outPath).catch(() => {});
        outPath = undefined;
        return res.status(200).json({
          success: true,
          data: { id: existing.id, type: existing.type, mimeType: existing.mimeType, filename: existing.filename, fileSize: existing.fileSize, deduplicated: true },
        });
      }
      const repairFilename = path.basename(outPath!);
      const repair = await repairAssetRow(existing.id, outPath!, {
        type: processed.type!, mimeType: processed.mimeType!,
        fileSize: processed.buffer.length, width: processed.width ?? null, height: processed.height ?? null,
        processed: processed.type === 'image',
      });
      if (!repair) throw new Error('MEDIA_ASSET_REPAIR_FAILED'); // outPath bleibt uns → cleanup() entfernt sie (11-07)
      outPath = undefined; // erst NACH erfolgreichem DB-Update: Datei gehört zur reparierten Zeile
      logger.info('Media asset repaired in place (dedupe)', { assetId: existing.id });
      return res.status(200).json({
        success: true,
        data: { id: existing.id, type: processed.type!, mimeType: processed.mimeType!, filename: repairFilename, fileSize: processed.buffer.length, deduplicated: true },
      });
    }

    // (2) Audit 11-04: gleicher Content + gleicher Owner, aber ANDERER
    //     Zugriffskontext (z.B. die Bytes liegen bereits als PUBLIC vor).
    //     Der frische PRIVATE-Upload erbt diesen Kontext NICHT: er legt eine
    //     EIGENE PRIVATE-Zeile an (getrennte logische Identität). Da die Bytes
    //     bereits gespeichert sind, wird die vorhandene DATEI wiederverwendet
    //     (keine neuen Bytes geschrieben → 200/deduplicated), die PUBLIC-Zeile
    //     bleibt unverändert öffentlich.
    const crossCtx = await prisma.mediaAsset.findFirst({
      where: { assetKey, uploadedBy: ownerId, visibility: { not: targetVisibility } },
    });
    if (crossCtx) {
      let fileOk = true;
      try { await fs.access(crossCtx.storagePath); } catch { fileOk = false; }
      if (fileOk) {
        const sharedPath = crossCtx.storagePath;
        await fs.unlink(outPath!).catch(() => {});
        outPath = undefined;
        let ctxAsset;
        try {
          ctxAsset = await prisma.mediaAsset.create({
            data: {
              type: processed.type!, mimeType: processed.mimeType!,
              filename: path.basename(sharedPath),
              originalName: (req as { file?: { originalname: string } }).file?.originalname ?? 'upload',
              fileSize: processed.buffer.length, width: processed.width ?? null, height: processed.height ?? null,
              sha256, assetKey, storagePath: sharedPath, uploadedBy: ownerId,
              visibility: targetVisibility, processStatus: 'READY', processed: processed.type === 'image',
            },
          });
        } catch (error) {
          // P2002-Parallel-Race auf (assetKey, owner, PRIVATE): ein paralleler
          // Upload hat die PRIVATE-Zeile angelegt → auf sie auflösen (Datei geteilt, deterministisch).
          if (isUniqueConflict(error)) {
            const winner = await prisma.mediaAsset.findFirst({ where: { assetKey, uploadedBy: ownerId, visibility: targetVisibility } });
            if (winner) {
              return res.status(200).json({
                success: true,
                data: { id: winner.id, type: winner.type, mimeType: winner.mimeType, filename: winner.filename, fileSize: winner.fileSize, deduplicated: true },
              });
            }
          }
          throw error;
        }
        return res.status(200).json({
          success: true,
          data: { id: ctxAsset.id, type: processed.type!, mimeType: processed.mimeType!, filename: path.basename(sharedPath), fileSize: processed.buffer.length, deduplicated: true },
        });
      }
      // Datei des fremden Kontexts fehlt → unten neu anlegen (eigene Datei).
    }

    let asset;
    try {
      asset = await prisma.mediaAsset.create({
        data: {
          type: processed.type!,
          mimeType: processed.mimeType!,
          filename: path.basename(outPath!),
          originalName: (req as { file?: { originalname: string } }).file?.originalname ?? 'upload', // Audit-only, nie an Client
          fileSize: processed.buffer.length,
          width: processed.width ?? null,
          height: processed.height ?? null,
          sha256,
          assetKey,
          storagePath: outPath!,
          uploadedBy: ownerId,
          visibility: targetVisibility,
          processStatus: 'READY',
          processed: processed.type === 'image',
        },
      });
    } catch (error) {
      // Paralleler identischer Upload desselben Users + Kontexts: P2002 auf
      // (assetKey, uploadedBy, visibility) → kontrollierte Auflösung.
      if (isUniqueConflict(error)) {
        const winner = await prisma.mediaAsset.findFirst({
          where: { assetKey, uploadedBy: ownerId, visibility: targetVisibility },
        });
        if (winner) {
          let fileOk = true;
          try { await fs.access(winner.storagePath); } catch { fileOk = false; }
          if (fileOk && winner.processStatus === 'READY') {
            await fs.unlink(outPath!).catch(() => {});
          } else {
            const repaired = await repairAssetRow(winner.id, outPath!, {
              type: processed.type!, mimeType: processed.mimeType!,
              fileSize: processed.buffer.length, width: processed.width ?? null, height: processed.height ?? null,
              processed: processed.type === 'image',
            });
            if (!repaired) throw error;
          }
          outPath = undefined;
          const final = await prisma.mediaAsset.findUnique({ where: { id: winner.id } });
          return res.status(200).json({
            success: true,
            data: { id: winner.id, type: final?.type ?? winner.type, mimeType: final?.mimeType ?? winner.mimeType, filename: final?.filename ?? winner.filename, fileSize: final?.fileSize ?? winner.fileSize, deduplicated: true },
          });
        }
      }
      throw error; // → allgemeiner Fehlerpfad (Cleanup unten)
    }
    outPath = undefined; // Datei gehört jetzt zum Asset.
    logger.info('Media uploaded (validated)', { assetId: asset.id, type: asset.type, size: processed.buffer.length });
    return res.status(201).json({
      success: true,
      data: { id: asset.id, type: asset.type, mimeType: asset.mimeType, filename: asset.filename, fileSize: asset.fileSize },
    });
  } catch (error) {
    await cleanup();
    logger.error('Failed to upload media', { error });
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Upload fehlgeschlagen.' } });
  }
});

/**
 * Kontrollierte In-Place-Reparatur einer Asset-Zeile (Nacharbeit B):
 * Die Zeile behält ihre ID (stabile Referenzen), ihr storagePath zeigt auf
 * die neue Datei, Status wird READY. Die alte Datei wird nur gelöscht, wenn
 * kein ANDERER DB-Eintrag sie referenziert und sie sich von der neuen
 * unterscheidet. @returns true bei Erfolg.
 */
async function repairAssetRow(
  assetId: string,
  newStoragePath: string,
  data: { type: string; mimeType: string; fileSize: number; width: number | null; height: number | null; processed: boolean },
): Promise<boolean> {
  try {
    const current = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
    if (!current) return false;
    const oldPath = current.storagePath;
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        type: data.type,
        mimeType: data.mimeType,
        filename: path.basename(newStoragePath),
        fileSize: data.fileSize,
        width: data.width,
        height: data.height,
        storagePath: newStoragePath,
        processStatus: 'READY',
        processed: data.processed,
      },
    });
    if (oldPath && oldPath !== newStoragePath) {
      const referencedElsewhere = await prisma.mediaAsset.count({
        where: { storagePath: oldPath, NOT: { id: assetId } },
      });
      if (referencedElsewhere === 0) await fs.unlink(oldPath).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

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
    // Audit 11-05 (P1): Setup-Vorschau VOR der Raumerstellung.
    //   Die "game"-Audience verlangt eine Spielbild-Referenz in einem
    //   bestehenden Raumsnapshot — genau der fehlt während des Setups
    //   (Raum existiert noch nicht) → game-URL würde 403 liefern.
    //   Für die Vorschau wird daher eine "host"-Audience-URL geladen:
    //   gültige Signatur + gültige Session + Host-Recht. Das Composite ist
    //   owner-geschützt (uploadedBy == Session-User, roomId = tmp-<User>),
    //   damit lädt die host-URL OHNE einen Raum. Die eigentliche
    //   "game"-Freigabe (an Player/Viewer/Display ohne Login) entsteht erst
    //   mit der Raumerstellung, wenn das Bild im Snapshot referenziert ist.
    //   Kein Original-/Game-Leak: host-Audience + Session + Ownership.
    return res.status(201).json({
      success: true,
      data: {
        gameImageAssetId: result.gameImageAssetId,
        width: result.width,
        height: result.height,
        gameImageUrl: buildSignedMediaUrl({ assetId: result.gameImageAssetId, audience: 'host' }),
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
// GET /api/v1/media/:id — Zentrale Zugriffspolitik (Nacharbeit C)
//
// Eine einzige Policy für alle nicht-öffentlichen Medien:
//   - audience "game": gültige Signatur + Asset ist in einem Raumsnapshot
//     als freigegebenes Spielbild referenziert (v1 imageAssetId / v2
//     gameImageAssetId). Damit kann eine game-Signatur NIEMALS ein
//     Original oder ein Bild einer anderen Runde freigeben. Der Status ist
//     snapshot-basiert (statisch) — game:end, Reveal oder Rejoin ändern
//     daran nichts.
//   - audience "host": gültige Signatur + gültige Session (existiert, NICHT
//     widerrufen, NICHT abgelaufen) + Host-Recht (uploader ODER Raum-Host).
//     Der separate /host/:id-Pfad (ohne Signatur, ohne Gültigkeitsprüfung)
//     existiert nicht mehr.
// ------------------------------------------------------------

async function isRoomHost(roomId: string, userId: string): Promise<boolean> {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { hostUserId: true } });
  return room?.hostUserId === userId;
}

/**
 * Ist das Asset in einem Raumsnapshot als FREIGEGEBENES SPIELBILD
 * referenziert? (v1: round.imageAssetId, v2: round.gameImageAssetId —
 * NIE personA/BImageAssetId.) Snapshot-basiert → unabhängig von
 * Reveal/Phase/game:end (Nacharbeit C).
 */
async function isReleasedGameImage(assetId: string): Promise<boolean> {
  const candidates = await prisma.room.findMany({
    where: { setupSnapshotJson: { contains: assetId } },
    select: { setupSnapshotJson: true },
  });
  for (const room of candidates) {
    let snapshot: unknown;
    try { snapshot = JSON.parse(room.setupSnapshotJson); } catch { continue; }
    const rounds = (snapshot as { rounds?: unknown[] })?.rounds;
    if (!Array.isArray(rounds)) continue;
    for (const round of rounds) {
      const r = round as Record<string, unknown>;
      if (r.imageAssetId === assetId || r.gameImageAssetId === assetId) return true;
    }
  }
  return false;
}

/** Lädt die Session aus dem Cookie + prüft ECHTE Gültigkeit (C). */
async function loadValidSession(req: Request): Promise<{ userId: string } | null> {
  const sessionId = verifySession(req, config.sessionSecret);
  if (!sessionId) return null;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  return { userId: session.userId };
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
        // Freigegebenes Spielbild: die Signatur ALLEIN genügt nicht — das
        // Asset muss tatsächlich als Spielbild in einem Raumsnapshot
        // referenziert sein (C: kein Original, kein fremdes Rundenbild).
        allowed = await isReleasedGameImage(asset.id);
      } else if (hostSigOk) {
        // Originale: gültige, NICHT widerrufene, NICHT abgelaufene Session
        // + Host-Recht. Bloße Kenntnis von ID/Signatur genügt nicht.
        const session = await loadValidSession(req);
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
