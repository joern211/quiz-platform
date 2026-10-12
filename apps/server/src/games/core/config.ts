// ============================================================
// Game Config Core (BASIS-STANDARDS, Master §5.24, §12.14, §12.8)
// ============================================================
// Zentrale Konfigurationsauflösung für die drei vorhandenen Engines.
//
//   Priorität (spezifischer gewinnt):
//     SYSTEM_DEFAULT → HOST_DEFAULT → ROOM_TEMPLATE → GAME_PRESET
//     → ROOM_CONFIG → GAME_CONFIG → LIVE_OVERRIDE
//
//   - Auflösung behält echte `false`, `0` und (nullable Felder) `null`:
//     "gesetzt" heißt Key existiert mit einem Wert ≠ undefined.
//     Kein `value || default`.
//   - Änderungsklassen: EDITABLE | LOCKED_AFTER_START.
//     LOCKED_AFTER_START kann nach Raumstart NICHT durch
//     LIVE_OVERRIDE überschrieben werden.
//   - Beim Spielstart werden die endgültigen Werte als unveränderlicher
//     GameConfigSnapshot (gameConfigSnapshotJson, configSchemaVersion=1)
//     zusammen mit gameSlug + engineVersion persistiert. Live-Änderungen
//     verändern den Snapshot NICHT rückwirkend; Rejoin/Resync/Reopen
//     verwenden den gespeicherten Zustand.
//   - Legacy-Strategie (configSchemaVersion=0, bestehende Räume):
//     Der Reader liest setupSnapshotJson + die Feld-Defaults — es wird
//     KEIN historischer Snapshot aus heutigen Defaults erfunden und kein
//     laufender Raum still umgedeutet.
//
//   HOST_DEFAULT/ROOM_TEMPLATE/GAME_PRESET sind als Auflösungsstufen
//   unterstetzt (die Writer/Ebenen liefern heute nur SYSTEM_DEFAULT +
//   GAME_CONFIG + LIVE_OVERRIDE); vollständige Editor-/Persistenz-
//   Oberflächen dafür bleiben späteren Paketen vorbehalten.
// ============================================================

import {
  resolveConfigValue,
  canLiveOverride,
  type ConfigFieldSpec,
  type GameConfigSnapshot,
  type ResolvedConfigValue,
  GameConfigSnapshotSchema,
  PROTOCOL_VERSION,
} from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import type { Room } from '@prisma/client';

/** Konfigurations-Schema-Version dieses Writers. */
export const GAME_CONFIG_SCHEMA_VERSION = 1;

// ── Feld-Spezifikationen (Einheiten/Nullability/Änderungsklassen) ──
// durationMs: Millisekunden (Master §12.8). Die Legacy-Setspeicherungen von
// Geo tragen `timerDuration` in SEKUNDEN — der Adapter multipliziert mit 1000
// (dokumentierte Kompatibilität, kein stilles Umdenken).
export const GAME_CONFIG_FIELDS: Record<string, Record<string, ConfigFieldSpec>> = {
  geo: {
    questionCount: { key: 'questionCount', unit: 'count', changeClass: 'LOCKED_AFTER_START', systemDefault: 10 },
    timerDurationMs: { key: 'timerDurationMs', unit: 'durationMs', changeClass: 'EDITABLE', systemDefault: 20000 },
  },
  'wer-ist-das': {
    roundCount: { key: 'roundCount', unit: 'count', changeClass: 'LOCKED_AFTER_START', systemDefault: 5 },
  },
  jeopardy: {
    boardCount: { key: 'boardCount', unit: 'count', changeClass: 'LOCKED_AFTER_START', systemDefault: 1 },
  },
};

/**
 * Adapter: Legacy-Setup-Werte (Sekunden) → kanonische Einheiten (ms).
 * NUR für geo.timerDuration, das vor BASIS-STANDARDS in Sekunden gespeichert
 * wurde. `undefined` = nicht gesetzt (→ Vererbung); 0/`false` bleiben erhalten.
 */
function legacyTimerDurationMs(legacySetup: Record<string, unknown>): number | undefined {
  const raw = legacySetup.timerDuration;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw * 1000;
  return undefined;
}

/**
 * Aktuelle Konfigurationswerte eines Raums (Snapshot oder Legacy-Auflösung)
 * als Resolved-Werte — Basis für No-Op-Entscheidungen und Validierung.
 */
export async function loadGameConfigValues(
  room: Pick<Room, 'gameConfigSnapshotJson' | 'configSchemaVersion' | 'setupSnapshotJson' | 'liveConfigJson' | 'id'>,
  gameSlug: string,
): Promise<Record<string, ResolvedConfigValue<unknown>>> {
  const loaded = await loadGameConfig(room, gameSlug);
  return loaded?.values ?? {};
}

export interface GameConfigLayers {
  systemDefault?: Record<string, unknown> | null;
  hostDefault?: Record<string, unknown> | null;
  roomTemplate?: Record<string, unknown> | null;
  gamePreset?: Record<string, unknown> | null;
  roomConfig?: Record<string, unknown> | null;
  gameConfig?: Record<string, unknown> | null;
  liveOverride?: Record<string, unknown> | null;
}

/**
 * Löst alle Felder eines Spiels über die 7 Ebenen auf (in aufsteigender
 * Priorität). Fehlende Ebenen = null (nicht gesetzt).
 */
export function resolveGameConfig(
  gameSlug: string,
  layers: GameConfigLayers,
): Record<string, ResolvedConfigValue<unknown>> {
  const fields = GAME_CONFIG_FIELDS[gameSlug] ?? {};
  const ordered: Array<Record<string, unknown> | null> = [
    layers.systemDefault ?? null,
    layers.hostDefault ?? null,
    layers.roomTemplate ?? null,
    layers.gamePreset ?? null,
    layers.roomConfig ?? null,
    layers.gameConfig ?? null,
    layers.liveOverride ?? null,
  ];
  const out: Record<string, ResolvedConfigValue<unknown>> = {};
  for (const spec of Object.values(fields)) {
    out[spec.key] = resolveConfigValue(spec, ordered);
  }
  return out;
}

export function buildConfigSnapshot(
  gameSlug: string,
  engineVersion: number,
  values: Record<string, ResolvedConfigValue<unknown>>,
): GameConfigSnapshot {
  return {
    gameSlug,
    engineVersion,
    values,
    createdAt: new Date().toISOString(),
  };
}

export interface LoadedGameConfig {
  /** Endgültige Werte inkl. Herkunft (Snapshot oder Legacy-Auflösung). */
  values: Record<string, ResolvedConfigValue<unknown>>;
  /** true = unveränderlicher Start-Snapshot; false = Legacy-Auflösung. */
  fromSnapshot: boolean;
  configSchemaVersion: number;
}

/**
 * Liest die gültige Spielkonfiguration eines Raums:
 *   1. configSchemaVersion >= 1 + Snapshot → unveränderlichen Snapshot.
 *   2. sonst (Legacy) → setupSnapshotJson + Feld-Defaults
 *      (keine erfundenen historischen Snapshots).
 */
function parseLiveConfigJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Legt die effektiven Live-Überschreibungen (liveConfigJson, Quelle
 * LIVE_OVERRIDE) über die Basiswerte (Snapshot oder Legacy-Auflösung).
 * Nur gesetzte Keys überschreiben; der Rest behält Basiswert + Herkunft.
 */
export function applyLiveOverrides(
  base: Record<string, ResolvedConfigValue<unknown>>,
  liveRaw: Record<string, unknown>,
  gameSlug: string,
): Record<string, ResolvedConfigValue<unknown>> {
  const out: Record<string, ResolvedConfigValue<unknown>> = {};
  for (const [key, spec] of Object.entries(GAME_CONFIG_FIELDS[gameSlug] ?? {})) {
    const raw = liveRaw[key];
    if (raw !== undefined) {
      out[key] = { value: raw, source: 'LIVE_OVERRIDE' };
    } else {
      out[key] = base[key] ?? { value: spec.systemDefault, source: 'SYSTEM_DEFAULT' };
    }
  }
  return out;
}

export async function loadGameConfig(
  room: Pick<Room, 'gameConfigSnapshotJson' | 'configSchemaVersion' | 'setupSnapshotJson' | 'liveConfigJson' | 'id'>,
  gameSlug: string,
): Promise<LoadedGameConfig | null> {
  if (!gameSlug) return null;

  let base: Record<string, ResolvedConfigValue<unknown>> | null = null;
  let fromSnapshot = false;

  if (room.configSchemaVersion >= GAME_CONFIG_SCHEMA_VERSION && room.gameConfigSnapshotJson) {
    const parsed = GameConfigSnapshotSchema.safeParse(
      JSON.parse(room.gameConfigSnapshotJson),
    );
    if (parsed.success) {
      base = parsed.data.values as unknown as Record<string, ResolvedConfigValue<unknown>>;
      fromSnapshot = true;
    }
  }

  // Legacy-Strategie (oder Snapshot-Fallback): bestehende Räume korrekt
  // weiter lesen — keine erfundenen historischen Snapshots.
  if (!base) {
    let legacySetup: Record<string, unknown> = {};
    try {
      const raw = room.setupSnapshotJson;
      if (raw) legacySetup = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      legacySetup = {};
    }
    base = resolveGameConfig(gameSlug, {
      systemDefault: null,
      gameConfig: null,
      // Legacy-Adapter: setup.timerDuration (Sekunden) → ms, falls gesetzt.
      roomConfig: legacyTimerDurationMs(legacySetup) === undefined
        ? null
        : { timerDurationMs: legacyTimerDurationMs(legacySetup) },
    });
  }

  // E3: effektive Live-Überschreibungen (auch nach Start, nur EDITABLE-Felder).
  const values = applyLiveOverrides(base, parseLiveConfigJson(room.liveConfigJson), gameSlug);
  return { values, fromSnapshot, configSchemaVersion: room.configSchemaVersion };
}

/**
 * Persistiert den unveränderlichen Start-Snapshot (nur beim Start, einmalig).
 * Ruft loadGameConfig auf, um bei Legacy-Räumen die aufgelösten Werte zu
 * verwenden — es werden keine Defaults neu erfunden.
 */
export async function persistConfigSnapshot(
  room: Room,
  gameSlug: string,
  engineVersion: number,
): Promise<GameConfigSnapshot> {
  // Endgültige Werte = Basis (Legacy/Setup) + vor dem Start getätigte
  // Live-Änderungen — als EINMALIGER, unveränderlicher Start-Snapshot
  // (E4). Die Live-Zielwerte werden danach in den Snapshot eingebunden und
  // liveConfigJson geleert (kein redundanter zweiter Speicher).
  // Hinweis: Kein Revision-Bump — der Snapshot ist Metadaten, keine
  // fachliche Zustandsänderung; die Start-Mutation (LOBBY→RUNNING) im
  // Handler erhöht die Revision bereits.
  const loaded = await loadGameConfig(room, gameSlug);
  const values = loaded?.values ?? resolveGameConfig(gameSlug, {});
  const snapshot = buildConfigSnapshot(gameSlug, engineVersion, values);
  await prisma.room.update({
    where: { id: room.id },
    data: {
      gameConfigSnapshotJson: JSON.stringify(snapshot),
      configSchemaVersion: GAME_CONFIG_SCHEMA_VERSION,
      liveConfigJson: null,
    },
  });
  return snapshot;
}

export type ConfigUpdateResult =
  | { ok: true; changed: boolean; revision: number; values: Record<string, ResolvedConfigValue<unknown>> }
  | { ok: false; error: 'REVISION_CONFLICT' | 'INVALID_CONFIG' | 'LOCKED_AFTER_START' | 'ROOM_NOT_FOUND' | 'NOT_HOST' | 'WRONG_ROOM' };

/**
 * Serverseitig validierte Konfigurationsänderung (LIVE_OVERRIDE) mit
 * Optimistic Locking:
 *   - expectedRevision muss zum aktuellen room.revision passen, sonst
 *     REVISION_CONFLICT (konkurrierende Änderung wird NICHT überschrieben).
 *   - No-op (identische Werte) → keine Revisionserhöhung.
 *   - RUNNING + LOCKED_AFTER_START-Feld → LOCKED_AFTER_START (Ablehnung).
 *   - RUNNING: Snapshot bleibt unberührt; neue Räume/Starts nutzen die
 *     geänderten Werte.
 */
export async function updateRoomConfig(
  args: {
    roomId: string;
    actorUserId: string;
    expectedRevision: number;
    /** Explizite Feldwerte der Änderung (nur gesetzte Keys werden geändert). */
    changes: Record<string, unknown>;
  },
): Promise<ConfigUpdateResult> {
  const room = await prisma.room.findUnique({
    where: { id: args.roomId },
    include: { gameDefinition: true },
  });
  if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
  if (room.hostUserId !== args.actorUserId) return { ok: false, error: 'NOT_HOST' };

  const gameSlug = room.gameDefinition.slug;
  const fields = GAME_CONFIG_FIELDS[gameSlug] ?? {};

  // Validierung: unbekannte Felder + Einheiten (durationMs/points Integer).
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args.changes)) {
    const spec = fields[key];
    if (!spec) return { ok: false, error: 'INVALID_CONFIG' };
    if (value === undefined) continue; // "nicht gesetzt" ≠ 0/false
    if (value !== null) {
      if (
        (spec.unit === 'durationMs' || spec.unit === 'points' || spec.unit === 'count' || spec.unit === 'bytes')
        && (!Number.isInteger(value) || (value as number) < 0)
      ) {
        return { ok: false, error: 'INVALID_CONFIG' };
      }
      if (spec.unit === 'percent' && (typeof value !== 'number' || value < 0 || value > 100)) {
        return { ok: false, error: 'INVALID_CONFIG' };
      }
      if (spec.unit === 'bool' && typeof value !== 'boolean') {
        return { ok: false, error: 'INVALID_CONFIG' };
      }
    } else if (!spec.nullable) {
      return { ok: false, error: 'INVALID_CONFIG' };
    }
    // LOCKED_AFTER_START: nach Start nicht änderbar (E3).
    if (room.status === 'RUNNING' && spec.changeClass === 'LOCKED_AFTER_START') {
      return { ok: false, error: 'LOCKED_AFTER_START' };
    }
    changes[key] = value;
  }
  if (Object.keys(changes).length === 0) return { ok: false, error: 'INVALID_CONFIG' };

  // No-Op (E5): Änderung, die gegen die aktuelle AUFLÖSUNG (inkl. vorhandener
  // Live-Overrides) nichts ändert → keine Revisionserhöhung.
  const baseValues = await loadGameConfigValues(room, gameSlug);
  const isNoOp = Object.entries(changes).every(([key, value]) => {
    const resolved = baseValues[key];
    return resolved !== undefined && JSON.stringify(resolved.value) === JSON.stringify(value);
  });

  if (isNoOp) {
    // No-Op: nur prüfen, dass die erwartete Revision aktuell ist (CAS-Lock
    // ohne Schreib-Auswirkung). updateMany mit leerem data liefert count 0 →
    // bewusst ein gezielter Read statt eines No-Write-Update.
    const exists = await prisma.room.findUnique({ where: { id: room.id }, select: { revision: true } });
    if (!exists || exists.revision !== args.expectedRevision) {
      return { ok: false, error: 'REVISION_CONFLICT' };
    }
    const values = await loadGameConfigValues(room, gameSlug);
    return { ok: true, changed: false, revision: exists.revision, values };
  }

  const updated = await prisma.room.updateMany({
    where: { id: room.id, revision: args.expectedRevision },
    data: { revision: { increment: 1 } },
  });
  if (updated.count !== 1) return { ok: false, error: 'REVISION_CONFLICT' };

  const fresh = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
  // E3: effektive Live-Overrides zusammenführen und persistieren.
  // E4: Der START-Snapshot (gameConfigSnapshotJson) bleibt UNVERÄNDERT.
  const currentLive = parseLiveConfigJson(fresh.liveConfigJson);
  const mergedLive = { ...currentLive, ...changes };
  await prisma.room.update({
    where: { id: fresh.id },
    data: { liveConfigJson: JSON.stringify(mergedLive) },
  });
  const after = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
  const values = await loadGameConfigValues(after, gameSlug);
  return { ok: true, changed: true, revision: fresh.revision, values };
}

export { canLiveOverride, PROTOCOL_VERSION };
