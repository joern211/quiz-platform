// ============================================================
// Wer ist das? — Composite/Fusion-Bild (Regelwerk §15.3, §7.5)
//
// Erzeugt ECHTES, reproduzierbares Fusion-Spielbild aus zwei
// Originalbildern:
//   - beide Originale werden normalisiert (center-crop) auf ein
//     festes quadratisches 1024×1024,
//   - B wird als 50%-Alpha-Overlay über A gemischt (sichtbare
//     Überblendung, keine KI, keine externe Dienstleistung),
//   - Ergebnis als WebP.
//
// WICHTIG:
//   - Der Algorithmus ist deterministisch (kein Zufall, keine
//     Zeitabhängigkeit) und hinter createGameImage() gekapselt —
//     ein späterer echter Morph ersetzt nur diese Funktion
//     (gleiche Signatur, gleiches Asset-Modell).
//   - Das Ergebnis wird EXAKT EINMAL als unveränderliches Asset
//     persistiert (Immutable, §7.4). Bei Rejoin/Reload/Resync/
//     Serverrestart wird es NICHT neu erzeugt — nur referenziert.
//   - Filenamen enthalten KEINE Personen-/Lösungsnamen.
// ============================================================

import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import sharp from 'sharp';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { config } from '../../config/index.js';
import { withMediaTransaction } from '../../media/transaction.js';

/** Kantenlänge des quadratischen Fusion-Bilds. */
export const COMPOSITE_SIZE = 1024;
/** Algorithmus-Versionskennung (steckt im Filenamen, §5.22). */
export const COMPOSITE_ALGORITHM = 'crossfade-v1';

export interface CreateGameImageParams {
  personAImageAssetId: string;
  personBImageAssetId: string;
  hostUserId: string;
  roomId: string;
  /** Diagnose-ID; wird weder im Dateipfad noch in der logischen Identität verwendet. */
  roundId: string;
}

export interface CreateGameImageResult {
  gameImageAssetId: string;
  width: number;
  height: number;
}

/** Lädt und prüft ein Original-Asset (Eigentum, Typ, Status). */
async function loadSourceAsset(assetId: string, hostUserId: string) {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new Error('ASSET_NOT_FOUND');
  if (asset.type !== 'image') throw new Error('ASSET_NOT_IMAGE');
  if (asset.processStatus !== 'READY') throw new Error('ASSET_NOT_READY');
  if (asset.uploadedBy !== hostUserId) throw new Error('ASSET_NOT_OWNED');
  try {
    await fs.access(asset.storagePath);
  } catch {
    throw new Error('ASSET_FILE_MISSING');
  }
  return asset;
}

/**
 * Erzeugt das Composite aus beiden Originalen und persistiert es EINMAL
 * als unveränderliches ROOM_TEMP-Asset mit nachvollziehbarer Quelle.
 * @throws ASSET_NOT_FOUND | ASSET_NOT_IMAGE | ASSET_NOT_READY |
 *         ASSET_NOT_OWNED | ASSET_FILE_MISSING | COMPOSITE_FAILED
 */
export async function createGameImage(params: CreateGameImageParams): Promise<CreateGameImageResult> {
  const { personAImageAssetId, personBImageAssetId, hostUserId, roomId, roundId } = params;
  if (personAImageAssetId === personBImageAssetId) throw new Error('SOURCES_MUST_DIFFER');
  const [assetA, assetB] = await Promise.all([
    loadSourceAsset(personAImageAssetId, hostUserId),
    loadSourceAsset(personBImageAssetId, hostUserId),
  ]);

  // Normalisieren: beide Originale center-crop auf 1024×1024.
  const [aBuf, bBuf] = await Promise.all([
    sharp(assetA.storagePath).resize(COMPOSITE_SIZE, COMPOSITE_SIZE, { fit: 'cover' }).toBuffer(),
    sharp(assetB.storagePath).resize(COMPOSITE_SIZE, COMPOSITE_SIZE, { fit: 'cover' }).toBuffer(),
  ]);

  // B mit 50% Alpha (deterministischer Crossfade über A).
  const bRaw = await sharp(bBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = bRaw;
  const alphaHalf = Math.round(255 / 2); // 128
  for (let i = 3; i < data.length; i += 4) data[i] = alphaHalf;
  // Overlay als verlustfreies PNG (Alpha bleibt erhalten), dann über A
  // compositen. (sharp 0.33: CreateRaw-Typ kennt kein `data`-Feld.)
  const bOverlayPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();

  let out: Buffer;
  try {
    out = await sharp(aBuf)
      .composite([{ input: bOverlayPng }])
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new Error('COMPOSITE_FAILED');
  }

  // Persistieren (Audit 11-01/11-02/11-03): 
  //   - LOGISCHE Identität = ordnungs-sensitive Quellen-Menge (A/B ≠ B/A,
  //     verschiedene Quellen ≠ identische Bytes) → `assetKey`. Dedupe läuft
  //     über assetKey, NICHT über die Ausgabe-Bytes (sonst würde ein anderes
  //     Quellpaar mit identischen Bytes die Provenienz eines anderen
  //     Assets erben, 11-03; und vertauschte Quellen würden denselben
  //     Pfad/Hash überschreiben, 11-02).
  //   - Dateipfad = ausschließlich aus den AUSGABE-BYTES (deterministisch)
  //     abgeleitet, OHNE roundId → kein Pfad-Traversing über roundId (11-01)
  //     und eindeutiger immutable Blob-Pfad (gleiche Bytes → gleicher Pfad,
  //     unterschiedliche Bytes → unterschiedlicher Pfad).
  const assetKey = `fusion:${COMPOSITE_ALGORITHM}:${personAImageAssetId}:${personBImageAssetId}`;
  const sha256 = crypto.createHash('sha256').update(out).digest('hex');
  const filename = `fusion-${sha256.slice(0, 32)}.webp`;
  const uploadDir = path.resolve(config.storagePaths.uploads);
  await fs.mkdir(uploadDir, { recursive: true });
  const storagePath = path.join(uploadDir, filename);
  // Defensive containment (11-01): der finale Pfad MUSS im Upload-Verzeichnis
  // liegen. Da der Name ausschließlich aus dem (safe) SHA256-Digest besteht,
  // ist dies garantiert — die Prüfung ist reine Absicherung.
  assertPathContained(uploadDir, storagePath);

  try {
    return await withMediaTransaction(prisma, async tx => {
      const existing = await tx.mediaAsset.findFirst({
        where: { assetKey, uploadedBy: hostUserId, visibility: 'ROOM_TEMP' },
      });
      if (existing) {
        let stored: Buffer | undefined;
        try { stored = await fs.readFile(existing.storagePath); } catch { /* missing file */ }
        if (!stored || crypto.createHash('sha256').update(stored).digest('hex') !== existing.sha256) {
          // Repair restores the recorded bytes, never a different algorithm/
          // source result under an already used asset identity.
          if (sha256 !== existing.sha256) throw new Error('COMPOSITE_FAILED');
          await writeAtomic(existing.storagePath, out);
          logger.info('Composite file repaired', { assetId: existing.id });
        }
        return { gameImageAssetId: existing.id, width: existing.width ?? COMPOSITE_SIZE, height: existing.height ?? COMPOSITE_SIZE };
      }

      // Insert FIRST, publish SECOND, commit LAST. A failed insert has no
      // published file to delete. Never unlink the shared final path on an
      // error: another logical asset may already use it. A write error rolls
      // back the row; temp files are cleaned by writeAtomic.
      const gameImage = await tx.mediaAsset.create({
        data: {
          type: 'image', mimeType: 'image/webp', filename,
          originalName: 'fusion.webp', fileSize: out.length,
          width: COMPOSITE_SIZE, height: COMPOSITE_SIZE, sha256, assetKey,
          storagePath, uploadedBy: hostUserId, visibility: 'ROOM_TEMP', roomId,
          processStatus: 'READY', processed: true,
          derivedFromAssetIds: JSON.stringify([personAImageAssetId, personBImageAssetId]),
        },
      });
      await writeAtomic(storagePath, out);
      logger.info('Composite stored', { assetId: gameImage.id, roomId, roundId });
      return { gameImageAssetId: gameImage.id, width: COMPOSITE_SIZE, height: COMPOSITE_SIZE };
    });
  } catch {
    // A transaction/commit error may leave an unreferenced final blob.
    // Preserve it rather than risk deleting a concurrent winner. General
    // file-only garbage collection is separate from tmp-row startup cleanup.
    throw new Error('COMPOSITE_FAILED');
  }
}

/**
 * Defensive Absicherung (Audit 11-01): der finale Pfad muss innerhalb des
 * Basis-Verzeichnisses liegen. Wirft, falls (trotz content-geleiteten Namens)
 * ein Pfad außerhalb liegen sollte — dann wird NICHT geschrieben.
 */
function assertPathContained(baseDir: string, finalPath: string): void {
  const rel = path.relative(baseDir, finalPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('COMPOSITE_FAILED');
  }
}

/** Publish a complete file without overwriting a valid existing blob.
 * A corrupt/missing blob is repaired atomically while holding the media lock.
 */
async function writeAtomic(finalPath: string, bytes: Buffer): Promise<void> {
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(dir, `.${path.basename(finalPath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmpPath, bytes, { flag: 'wx' });
    try {
      await fs.link(tmpPath, finalPath); // EEXIST, unlike rename, never overwrites.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stored = await fs.readFile(finalPath);
      if (!stored.equals(bytes)) {
        // Only this deterministic output is allowed at this content path.
        // Readers see the complete old or repaired file, never a gap.
        await fs.rename(tmpPath, finalPath);
      }
    }
  } catch {
    throw new Error('COMPOSITE_FAILED');
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}
