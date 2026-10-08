// ============================================================
// Medien-Lebenszyklus (PR11 Nacharbeit E)
//
// Die Setup-UI erzeugt das Composite-Spielbild VOR der Raumerstellung.
// Bis dahin kennt die API keinen Raum und bindet solche Assets an
// `tmp-<hostUserId>` (MediaAsset.roomId). Nach erfolgreicher Raumerstellung
// müssen die zum Raum gehörenden tmp-Assets KONTROLLIERT an die echte
// Raum-ID gebunden werden, und ungebundene/verwaiste tmp-Artefakte
// (abgebrochene Setups, gelöschte Runden, Quellaustausch, fehlgeschlagene
// Raumerstellung, Prozessunterbrechung) dürfen nicht unbegrenzt bleiben.
//
// Regeln (sicherheitsrelevant, BETA):
//   - Gebunden wird NUR: visibility ROOM_TEMP + roomId 'tmp-<Host>' +
//     uploadedBy = Host + im Snapshot des NEUEN Raums referenziert.
//   - Bereits an einen ECHTEN Raum gebundene Assets werden NICHT gestohlen
//     (zweiter Raum, der dieselben IDs referenziert, bleibt trotzdem lauffähig:
//     Startvalidierung prüft Eigentum + Provenienz, nicht roomId).
//   - Originale (PRIVATE) werden NICHT umgebunden (bleiben owner-only;
//     roomId bleibt null) — minimalste Metadaten-Änderung.
//   - Cleanup löscht NUR tmp-Assets, die in KEINEM Raumsnapshot referenziert
//     sind (auch nicht in ENDED-Räumen — historisch benötigte Bilder bleiben)
//     UND älter als die TTL sind. Aktive/historische Bilder sind damit geschützt.
// ============================================================

import { rm } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../observability/logger.js';

/**
 * Bindet die in einem Raumsnapshot referenzierten tmp-Assets des Hosts an
 * den echten Raum. IDEMPOTENT: wiederholte Aufrufe ändern nichts; Assets,
 * die bereits an einen echten Raum gebunden sind, bleiben dort.
 *
 * @returns Anzahl neu gebundener Assets.
 */
export async function bindSnapshotAssetsToRoom(
  prisma: PrismaClient,
  params: { roomId: string; hostUserId: string; snapshotJson: string },
): Promise<number> {
  const { roomId, hostUserId, snapshotJson } = params;
  let snapshot: { rounds?: Array<Record<string, unknown> | null> };
  try { snapshot = JSON.parse(snapshotJson); } catch { return 0; }
  if (!Array.isArray(snapshot.rounds)) return 0;

  // Referenzierte Asset-IDs aus dem Snapshot (alle vier Bildfelder — so
  // sehen wir alle Composite-Kandidaten; Originale scheitern an der
  // ROOM_TEMP-Filterung unten).
  const referenced = new Set<string>();
  for (const round of snapshot.rounds) {
    if (!round) continue;
    for (const field of ['imageAssetId', 'gameImageAssetId', 'personAImageAssetId', 'personBImageAssetId']) {
      const v = round[field];
      if (typeof v === 'string') referenced.add(v);
    }
  }
  if (referenced.size === 0) return 0;

  // NUR ungebundene tmp-Assets des Hosts, die im Snapshot stehen.
  const candidates = await prisma.mediaAsset.findMany({
    where: {
      id: { in: [...referenced] },
      visibility: 'ROOM_TEMP',
      uploadedBy: hostUserId,
      roomId: { startsWith: 'tmp-' },
    },
    select: { id: true },
  });

  if (candidates.length === 0) return 0;
  const result = await prisma.mediaAsset.updateMany({
    where: { id: { in: candidates.map(c => c.id) }, roomId: { startsWith: 'tmp-' } },
    data: { roomId },
  });
  if (result.count > 0) {
    logger.info('Temp-Assets an Raum gebunden', { roomId, hostUserId, bound: result.count });
  }
  return result.count;
}

/**
 * Ist das Asset in IRGEND einem Raumsnapshot referenziert (v1/v2, jedes
 * Bildfeld)? Ja → historisch benötigt → niemals löschen.
 */
async function isReferencedInAnySnapshot(prisma: PrismaClient, assetId: string): Promise<boolean> {
  const candidates = await prisma.room.findMany({
    where: { setupSnapshotJson: { contains: assetId } },
    select: { setupSnapshotJson: true },
  });
  for (const room of candidates) {
    let snapshot: { rounds?: Array<Record<string, unknown> | null> };
    try { snapshot = JSON.parse(room.setupSnapshotJson); } catch { continue; }
    if (!Array.isArray(snapshot.rounds)) continue;
    for (const round of snapshot.rounds) {
      if (!round) continue;
      for (const field of ['imageAssetId', 'gameImageAssetId', 'personAImageAssetId', 'personBImageAssetId']) {
        if (round[field] === assetId) return true;
      }
    }
  }
  return false;
}

/**
 * Räumt verwaiste tmp-Assets auf: roomId 'tmp-<Host>', NICHT in einem
 * Raumsnapshot referenziert, älter als `ttlMs`. Löscht DATEI + DB-Zeile.
 * Idempotent; sichere Obergrenze für die BETA (kein allgemeiner
 * Storage-GC — der folgt bewusst später, siehe Doku).
 *
 * @returns Anzahl bereinigter Assets.
 */
export async function cleanupOrphanedTempAssets(
  prisma: PrismaClient,
  ttlMs: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ttlMs);
  const orphans = await prisma.mediaAsset.findMany({
    where: {
      roomId: { startsWith: 'tmp-' },
      createdAt: { lt: cutoff },
    },
    select: { id: true, storagePath: true },
  });

  let cleaned = 0;
  for (const asset of orphans) {
    if (await isReferencedInAnySnapshot(prisma, asset.id)) continue; // aktiv/historisch
    try { await prisma.mediaAsset.delete({ where: { id: asset.id } }); } catch { continue; }
    try { await rm(asset.storagePath, { force: true }); } catch { /* Datei fehlt evtl. schon */ }
    cleaned += 1;
  }
  if (cleaned > 0) {
    logger.info('Verwaiste tmp-Medien bereinigt', { cleaned, ttlMs });
  }
  return cleaned;
}
