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

/** Kantenlänge des quadratischen Fusion-Bilds. */
export const COMPOSITE_SIZE = 1024;
/** Algorithmus-Versionskennung (steckt im Filenamen, §5.22). */
export const COMPOSITE_ALGORITHM = 'crossfade-v1';

export interface CreateGameImageParams {
  personAImageAssetId: string;
  personBImageAssetId: string;
  hostUserId: string;
  roomId: string;
  /** Nur für den Filenamen — enthält KEINE Lösung. */
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

  // Persistieren: eindeutiger Name aus Quellen + Algorithmus (keine Namen).
  const derived = [personAImageAssetId, personBImageAssetId].sort().join('+');
  const digest = crypto.createHash('sha256').update(`${COMPOSITE_ALGORITHM}:${derived}`).digest('hex').slice(0, 16);
  const filename = `fusion-${roundId}-${digest}.webp`;
  const uploadDir = path.resolve(config.storagePaths.uploads);
  await fs.mkdir(uploadDir, { recursive: true });
  const storagePath = path.join(uploadDir, filename);
  const sha256 = crypto.createHash('sha256').update(out).digest('hex');

  // Idempotenz/Reparatur (Nacharbeit A):
  //   Gleiche Quellen + Algorithmus → gleiche Bytes → eindeutiger sha256.
  //   Wir suchen VOR dem Schreiben ein vorhandenes Asset und löschen NIEMALS
  //   die finale Datei:
  //     - Datei vorhanden  → Asset wiederverwenden (kein Schreibzugriff).
  //     - Datei fehlt      → kontrollierte Re-Materialisierung (determinische
  //                          Bytes) am (ggf. neuen) Pfad, storagePath updaten.
  //   So überlebt die im Asset referenzierte Datei einen Wiederholungsaufruf
  //   (UI „Spielbild neu erzeugen") und ein fehlendes Bild wird repariert.
  const existing = await prisma.mediaAsset.findFirst({
    where: { sha256, uploadedBy: hostUserId, type: 'image' },
  });
  if (existing) {
    let fileExists = true;
    try { await fs.access(existing.storagePath); } catch { fileExists = false; }
    if (fileExists) {
      logger.info('Composite reused (idempotent)', { assetId: existing.id });
      return { gameImageAssetId: existing.id, width: existing.width ?? COMPOSITE_SIZE, height: existing.height ?? COMPOSITE_SIZE };
    }
    // Datei fehlte (alter Bug/verlust) → deterministisch wiederherstellen
    // am Pfad des Assets (Bytes sind deterministisch → bytegleich).
    try {
      await writeAtomic(existing.storagePath, out);
    } catch {
      throw new Error('COMPOSITE_FAILED');
    }
    logger.info('Composite file re-materialized (deterministic repair)', { assetId: existing.id, path: existing.storagePath });
    return { gameImageAssetId: existing.id, width: existing.width ?? COMPOSITE_SIZE, height: existing.height ?? COMPOSITE_SIZE };
  }

  // Neues Asset: Datei ATOMAR an den Final-Pfad (tmp + rename).
  await writeAtomic(storagePath, out);

  let gameImage;
  try {
    gameImage = await prisma.mediaAsset.create({
      data: {
        type: 'image',
        mimeType: 'image/webp',
        filename,
        originalName: 'fusion.webp', // keine Lösung im Namen
        fileSize: out.length,
        width: COMPOSITE_SIZE,
        height: COMPOSITE_SIZE,
        sha256,
        storagePath,
        uploadedBy: hostUserId,
        visibility: 'ROOM_TEMP',
        roomId,
        processStatus: 'READY',
        processed: true,
        derivedFromAssetIds: JSON.stringify([personAImageAssetId, personBImageAssetId]),
      },
    });
  } catch (error) {
    // Parallel-Race (P2002): ein paralleler identischer Aufruf hat das Asset
    // angelegt. Wir löschen NIE die finale Datei (deterministisch, von beiden
    // Aufrufen gleich); wir lösen auf das bestehende Asset auf und reparieren
    // dessen Datei, falls nötig. Die eigene (unterschiedliche) tmp-Datei ist
    // via writeAtomic bereits finalisiert → nichts Eigenes aufzuräumen.
    if (isUniqueConflict(error)) {
      const winner = await prisma.mediaAsset.findFirst({ where: { sha256, uploadedBy: hostUserId, type: 'image' } });
      if (winner) {
        let fileExists = true;
        try { await fs.access(winner.storagePath); } catch { fileExists = false; }
        if (!fileExists) {
          try { await writeAtomic(winner.storagePath, out); } catch { /* best effort */ }
        }
        logger.info('Composite deduped after unique conflict', { assetId: winner.id });
        return { gameImageAssetId: winner.id, width: winner.width ?? COMPOSITE_SIZE, height: winner.height ?? COMPOSITE_SIZE };
      }
    }
    // Anderer Fehler → die von UNS angelegte Datei kontrolliert entfernen
    // (sie gehört nur diesem Aufruf; ein anderer DB-Eintrag verweist nicht
    // darauf, da das Asset nicht angelegt wurde).
    await fs.unlink(storagePath).catch(() => {});
    throw new Error('COMPOSITE_FAILED');
  }
  logger.info('Composite created', { assetId: gameImage.id, roomId, roundId });
  return { gameImageAssetId: gameImage.id, width: COMPOSITE_SIZE, height: COMPOSITE_SIZE };
}

/**
 * Atomares Schreiben: legt die Bytes in eine eindeutige tmp-Datei im selben
 * Verzeichnis ab und benennt sie um (atomic rename). Überschreibt eine
 * bereits vorhandene finale Datei NIE (wir schreiben nur, wenn sie fehlt).
 * @throws COMPOSITE_FAILED bei I/O-Fehlern (tmp-Datei wird aufgeräumt).
 */
async function writeAtomic(finalPath: string, bytes: Buffer): Promise<void> {
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(dir, `.${path.basename(finalPath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmpPath, bytes);
    await fs.rename(tmpPath, finalPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Finale Datei existiert bereits (parallel) — für uns deterministisch
      // identisch → wir verlassen uns auf die vorhandene (kein Überschreiben).
      return;
    }
    throw new Error('COMPOSITE_FAILED');
  }
}

/** Erkennt Prisma-Unique-Konflikte (P2002) robust an code/message. */
function isUniqueConflict(error: unknown): boolean {
  if (!error) return false;
  const e = error as { code?: string; message?: string };
  if (e.code === 'P2002') return true;
  return typeof e.message === 'string' && /Unique constraint failed|UNIQUE constraint failed/i.test(e.message);
}
