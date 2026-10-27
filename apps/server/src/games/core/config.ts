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
  resolveCanonicalSlug,
  type ConfigFieldSpec,
  type GameConfigSnapshot,
  type ResolvedConfigValue,
  GameConfigSnapshotSchema,
  PROTOCOL_VERSION,
} from '@quiz/shared';
import { prisma } from '../../persistence/prisma.js';
import { logger } from '../../observability/logger.js';
import { WER_IST_DAS_ENGINE_VERSION, SUPPORTED_ENGINE_VERSIONS as WER_IST_DAS_SUPPORTED_VERSIONS } from '../weristdas/contracts.js';
import type { Room } from '@prisma/client';
import { assertCommandMutation } from './commandExecution.js';

/** Konfigurations-Schema-Version dieses Writers. */
export const GAME_CONFIG_SCHEMA_VERSION = 1;

// ============================================================
// Audit PR14, 14-04: Echte Engine-Versionen + unterstützte Versionen
// pro kanonischem Slug. Die zentrale Quelle für die Start-Snapshots
// (früher: hartkodiertes 1 in game.ts — WID-State wurde mit v2
// persistiert, der Snapshot behauptete v1).
// ============================================================
export const ENGINE_VERSIONS: Record<string, { current: number; supported: readonly number[] }> = {
  'wissensduell': { current: 1, supported: [1] },
  'jeopardy': { current: 1, supported: [1] },
  'wer-ist-das': { current: WER_IST_DAS_ENGINE_VERSION, supported: WER_IST_DAS_SUPPORTED_VERSIONS },
};

// ── Feld-Spezifikationen (Einheiten/Nullability/Änderungsklassen) ──
// Audit PR14, 14-04: NUR kanonische Slugs als Feld-Keys. Legacy-Slugs
// (z.B. "geo") werden an der Grenze per resolveCanonicalSlug aufgelöst —
// KEINE parallele Feldliste mehr unter dem alten Slug.
// durationMs: Millisekunden (Master §12.8). Die Legacy-Setspeicherungen von
// Geo tragen `timerDuration` in SEKUNDEN — der Adapter multipliziert mit 1000
// (dokumentierte Kompatibilität, kein stilles Umdenken).
export const GAME_CONFIG_FIELDS: Record<string, Record<string, ConfigFieldSpec>> = {
  'wissensduell': {
    tieStrategy: { key: 'tieStrategy', unit: 'string', allowedValues: ['ALLOW_TIE'], changeClass: 'LOCKED_AFTER_START', systemDefault: 'ALLOW_TIE' },
    questionCount: { key: 'questionCount', unit: 'count', minimum: 1, changeClass: 'LOCKED_AFTER_START', systemDefault: 10 },
    timerDurationMs: { key: 'timerDurationMs', unit: 'durationMs', minimum: 1, maximum: 2147483647, changeClass: 'EDITABLE', systemDefault: 20000 },
  },
  'wer-ist-das': {
    tieStrategy: { key: 'tieStrategy', unit: 'string', allowedValues: ['ALLOW_TIE'], changeClass: 'LOCKED_AFTER_START', systemDefault: 'ALLOW_TIE' },
    roundCount: { key: 'roundCount', unit: 'count', minimum: 1, changeClass: 'LOCKED_AFTER_START', systemDefault: 5 },
  },
  jeopardy: {
    tieStrategy: { key: 'tieStrategy', unit: 'string', allowedValues: ['ALLOW_TIE'], changeClass: 'LOCKED_AFTER_START', systemDefault: 'ALLOW_TIE' },
    boardCount: { key: 'boardCount', unit: 'count', minimum: 1, maximum: 2, changeClass: 'LOCKED_AFTER_START', systemDefault: 1 },
  },
};

/**
 * Audit PR14, 14-04: Tatsächliche Setup-Daten → Konfigurationswerte.
 * Die Werte, die beim Start FACHLICH gelten (Rundenanzahl, Frageanzahl,
 * Boardanzahl), kommen aus dem Setup — nicht aus pauschalen Defaults.
 * `undefined`-Keys = nicht abgeleitbar (→ Auflösung weiter).
 */
export function setupConfigOverrides(gameSlug: string, setup: Record<string, unknown> | null): Record<string, unknown> {
  if (!setup || typeof setup !== 'object') return {};
  switch (gameSlug) {
    case 'wissensduell': {
      const out: Record<string, unknown> = {};
      const ids = setup.selectedQuestionIds;
      if (Array.isArray(ids) && ids.length > 0) out.questionCount = ids.length;
      else if (typeof setup.questionCount === 'number') out.questionCount = setup.questionCount;
      return out;
    }
    case 'jeopardy':
      // Beide Boards vorhanden → 2, sonst 1 (bestehende Semantik).
      return { boardCount: setup.board1 && setup.board2 ? 2 : 1 };
    case 'wer-ist-das': {
      const rounds = setup.rounds;
      if (Array.isArray(rounds) && rounds.length > 0) return { roundCount: rounds.length };
      return {};
    }
    default:
      return {};
  }
}

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

function parseSetupSnapshot(room: Pick<Room, 'setupSnapshotJson'>): Record<string, unknown> | null {
  try {
    const raw = room.setupSnapshotJson;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Aktuelle Konfigurationswerte eines Raums (Snapshot oder Legacy-Auflösung)
 * als Resolved-Werte — Basis für No-Op-Entscheidungen und Validierung.
 */
export async function loadGameConfigValues(
  room: Pick<Room, 'gameConfigSnapshotJson' | 'configSchemaVersion' | 'setupSnapshotJson' | 'liveConfigJson' | 'id'> & { setupBlueprintsJson?: string | null },
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

/** Audit PR14, 14-04: Alle Funktionen normalisieren den Slug auf kanonisch. */
function canonicalSlugOf(gameSlug: string): string | null {
  if (!gameSlug) return null;
  return resolveCanonicalSlug(gameSlug);
}

/**
 * Löst alle Felder eines Spiels über die 7 Ebenen auf (in aufsteigender
 * Priorität). Fehlende Ebenen = null (nicht gesetzt).
 */
export function resolveGameConfig(
  gameSlug: string,
  layers: GameConfigLayers,
): Record<string, ResolvedConfigValue<unknown>> {
  const fields = GAME_CONFIG_FIELDS[canonicalSlugOf(gameSlug) ?? ''] ?? {};
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
 *
 * Audit PR14, 14-04: Ein gespeicherter Snapshot wird beim LESEN geprüft:
 * Schema, Spiel-Zuordnung (gameSlug) und unterstützte engineVersion müssen
 * passen. Ein unpassender/defekter Snapshot wird NICHT still durch heutige
 * Defaults ersetzt — die Legacy-Auflösung greift nur, wenn der Snapshot
 * für DIESES Spiel gültig ist oder der Raum noch Legacy ist
 * (configSchemaVersion < 1). Ein defekter v1-Snapshot ist ein kontrollierter
 * Fehler (CONFIG_SNAPSHOT_INVALID), keine stille Neu-Deutung.
 */
export class ConfigSnapshotError extends Error {
  readonly code = 'CONFIG_SNAPSHOT_INVALID';
  constructor(roomId: string, reason: string) {
    super(`Invalid game config snapshot for room ${roomId}: ${reason}`);
    this.name = 'ConfigSnapshotError';
  }
}

/** Initializers use the same effective count that the snapshot will pin. */
export async function loadInitialGameCount(roomId: string, gameSlug: string, key: string): Promise<number> {
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
  const loaded = await loadGameConfig(room, gameSlug);
  const value = loaded?.values[key]?.value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigSnapshotError(roomId, `invalid ${key}`);
  }
  return value;
}
/** Existing games historically allowed ties. Other strategies need engine-specific rounds/controls. */
export async function loadInitialTieStrategy(roomId: string, gameSlug: string): Promise<'ALLOW_TIE'> {
  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
  const loaded = await loadGameConfig(room, gameSlug);
  const value = loaded?.values.tieStrategy?.value;
  if (value === undefined) return 'ALLOW_TIE';
  if (value !== 'ALLOW_TIE') throw new ConfigSnapshotError(roomId, 'tie strategy unsupported by this engine');
  return value;
}

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
  for (const [key, spec] of Object.entries(GAME_CONFIG_FIELDS[canonicalSlugOf(gameSlug) ?? ''] ?? {})) {
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
  room: Pick<Room, 'gameConfigSnapshotJson' | 'configSchemaVersion' | 'setupSnapshotJson' | 'liveConfigJson' | 'id'> & { setupBlueprintsJson?: string | null },
  gameSlug: string,
): Promise<LoadedGameConfig | null> {
  const canonical = canonicalSlugOf(gameSlug);
  if (!canonical) return null;

  let base: Record<string, ResolvedConfigValue<unknown>> | null = null;
  let fromSnapshot = false;

  if (room.configSchemaVersion >= GAME_CONFIG_SCHEMA_VERSION) {
    // v1-Raum: Der Start-Snapshot IST die Quelle. Er muss gültig sein —
    // Schema, Spiel-Zuordnung und unterstützte engineVersion (14-04).
    if (!room.gameConfigSnapshotJson) {
      throw new ConfigSnapshotError(room.id, 'configSchemaVersion>=1 ohne Snapshot');
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(room.gameConfigSnapshotJson);
    } catch {
      throw new ConfigSnapshotError(room.id, 'Snapshot nicht parsebar (JSON)');
    }
    const parsed = GameConfigSnapshotSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ConfigSnapshotError(room.id, 'Snapshot verletzt das GameConfigSnapshotSchema');
    }
    if (parsed.data.gameSlug !== canonical) {
      throw new ConfigSnapshotError(room.id, `Snapshot gehört zu "${parsed.data.gameSlug}", Raum zu "${canonical}"`);
    }
    const supported = ENGINE_VERSIONS[canonical]?.supported;
    if (supported && !supported.includes(parsed.data.engineVersion)) {
      throw new ConfigSnapshotError(room.id, `Snapshot engineVersion ${parsed.data.engineVersion} nicht unterstützt (erwartet ${supported.join('/')})`);
    }
    base = parsed.data.values as unknown as Record<string, ResolvedConfigValue<unknown>>;
    fromSnapshot = true;
  } else {
    // Legacy-Strategie (configSchemaVersion < 1): bestehende Räume korrekt
    // weiter lesen — TATSÄCHLICHE Setupwerte + Feld-Defaults, KEINE
    // erfundenen historischen Snapshots.
    const legacySetup = parseSetupSnapshot(room) ?? {};
    const setupOverrides = setupConfigOverrides(canonical, legacySetup);
    const timerMs = legacyTimerDurationMs(legacySetup);
    const prepared: { presetSetup?: Record<string, unknown>; explicitSetup?: Record<string, unknown> } | null = room.setupBlueprintsJson ? JSON.parse(room.setupBlueprintsJson) : null;
    const configOf = (setup: Record<string, unknown>) => {
      const out = setupConfigOverrides(canonical, setup), selection = setup.contentSelection as { count?: number; poolCounts?: Record<string, number> } | undefined;
      if (canonical === 'wissensduell' && selection) { if (selection.poolCounts) out.questionCount = Object.values(selection.poolCounts).reduce((a, b) => a + b, 0); else if (selection.count !== undefined) out.questionCount = selection.count; }
      if (canonical === 'jeopardy' && !setup.board1 && !setup.board2 && !setup.contentSelection) delete out.boardCount;
      const timer = legacyTimerDurationMs(setup); if (timer !== undefined) out.timerDurationMs = timer;
      return out;
    };
    base = resolveGameConfig(canonical, {
      systemDefault: null,
      gamePreset: prepared ? configOf(prepared.presetSetup ?? {}) : null,
      gameConfig: null,
      // Tatsächliche Setup-Daten (Runden/Fragen/Boards) + Legacy-Adapter
      // timerDuration (Sekunden) → ms, falls gesetzt.
      roomConfig: prepared ? configOf(prepared.explicitSetup ?? {}) : {
        ...setupOverrides,
        ...(timerMs !== undefined ? { timerDurationMs: timerMs } : {}),
      },
    });
  }

  // E3: effektive Live-Überschreibungen (auch nach Start, nur EDITABLE-Felder).
  const values = applyLiveOverrides(base, parseLiveConfigJson(room.liveConfigJson), canonical);
  return { values, fromSnapshot, configSchemaVersion: room.configSchemaVersion };
}

/**
 * Persistiert den unveränderlichen Start-Snapshot (nur beim Start, einmalig).
 *
 * Audit PR14, 14-04:
 *   - Der Snapshot trägt den KANONISCHEN Slug und die TATSÄCHLICHE
 *     Engine-Version (aufrufend über ENGINE_VERSIONS übergeben) — kein
 *     pauschales 1 mehr.
 *   - Die Werte kommen aus der TATSÄCHLICHEN Auflösung (Setup-Daten über
 *     setupConfigOverrides, Legacy-Adapter, vor-Start-Live-Änderungen) —
 *     keine leeren values durch Slug-Fehlzuordnung.
 *   - Fehler (unbekannter Slug, defekter Legacy-Setup) werden als
 *     ConfigSnapshotError weitergereicht → der Start wird kontrolliert
 *     abgelehnt/gerollt (kein RUNNING ohne gültigen Snapshot, 14-05).
 */
export async function persistConfigSnapshot(
  room: Room,
  gameSlug: string,
  engineVersion: number,
): Promise<GameConfigSnapshot> {
  const canonical = canonicalSlugOf(gameSlug);
  if (!canonical || !GAME_CONFIG_FIELDS[canonical]) {
    throw new ConfigSnapshotError(room.id, `unbekannter Spiel-Slug "${gameSlug}"`);
  }
  // Endgültige Werte = TATSÄCHLICHE Basis (Setup/Setup-Adapter/Live) —
  // als EINMALIGER, unveränderlicher Start-Snapshot (E4). Die Live-Zielwerte
  // werden danach in den Snapshot eingebunden und liveConfigJson geleert
  // (kein redundanter zweiter Speicher).
  // Hinweis: Kein Revision-Bump — der Snapshot ist Metadaten, keine
  // fachliche Zustandsänderung; die Start-Mutation (LOBBY→RUNNING) im
  // Handler erhöht die Revision bereits.
  return prisma.$transaction(async (tx) => {
    await assertCommandMutation(tx, room.id);
    const fresh = await tx.room.findUniqueOrThrow({ where: { id: room.id } });
    const loaded = await loadGameConfig(fresh, canonical);
    const values = loaded?.values ?? resolveGameConfig(canonical, {});
    const row = await tx.roomGameState.findUnique({ where: { roomId: room.id } });
    if (row) {
      const state = JSON.parse(row.stateJson) as { questions?: unknown[]; roundCount?: number; boardCount?: number };
      const key = canonical === 'wissensduell' ? 'questionCount' : canonical === 'wer-ist-das' ? 'roundCount' : 'boardCount';
      const actual = canonical === 'wissensduell' ? state.questions?.length : state[key as 'roundCount' | 'boardCount'];
      if (typeof actual === 'number') values[key] = { ...values[key], value: actual };
    }
    const snapshot = buildConfigSnapshot(canonical, engineVersion, values);
    await tx.room.update({ where: { id: room.id }, data: {
      gameConfigSnapshotJson: JSON.stringify(snapshot), configSchemaVersion: GAME_CONFIG_SCHEMA_VERSION, liveConfigJson: null,
    } });
    return snapshot;
  });
}

export type ConfigUpdateResult =
  | { ok: true; changed: boolean; revision: number; values: Record<string, ResolvedConfigValue<unknown>> }
  | { ok: false; error: 'REVISION_CONFLICT' | 'INVALID_CONFIG' | 'LOCKED_AFTER_START' | 'ROOM_NOT_FOUND' | 'NOT_HOST' | 'WRONG_ROOM' | 'CONFIG_SNAPSHOT_INVALID' | 'INTERNAL_ERROR' };

/**
 * Serverseitig validierte Konfigurationsänderung (LIVE_OVERRIDE) mit
 * Optimistic Locking:
 *   - expectedRevision muss zum aktuellen room.revision passen, sonst
 *     REVISION_CONFLICT (konkurrierende Änderung wird NICHT überschrieben).
 *   - No-op (identische Werte) → keine Revisionserhöhung.
 *   - RUNNING + LOCKED_AFTER_START-Feld → LOCKED_AFTER_START (Ablehnung).
 *   - RUNNING: Snapshot bleibt unberührt; neue Räume/Starts nutzen die
 *     geänderten Werte.
 *
 * Audit PR14, 14-05: STATUS-Check (LOCKED_AFTER_START), CAS, MERGE und
 * PERSISTENZ laufen in EINER interaktiven Transaktion. Ein Fehler nach der
 * Revisionserhöhung kann nicht mehr einen halben Zustand hinterlassen
 * (früher: Revision-bump als eigener Write, liveConfigJson als zweiter —
 * Fehler dazwischen = Revision verbraucht, Werte NULL). Ein konkurrierender
 * Start (LOBBY→RUNNING + Revision-Bump) wird vom CAS erwischt, weil der
 * Start die Revision erhöht.
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
  try {
    const room = await prisma.room.findUnique({
      where: { id: args.roomId },
      include: { gameDefinition: true },
    });
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    if (room.hostUserId !== args.actorUserId) return { ok: false, error: 'NOT_HOST' };

    const gameSlug = room.gameDefinition.slug;
    const fields = GAME_CONFIG_FIELDS[canonicalSlugOf(gameSlug) ?? ''] ?? {};

    // Validierung: unbekannte Felder + Einheiten (durationMs/points Integer).
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args.changes)) {
      const spec = Object.hasOwn(fields, key) ? fields[key] : undefined;
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
        if (spec.unit === 'string' && typeof value !== 'string' || spec.allowedValues && !spec.allowedValues.includes(value)) {
          return { ok: false, error: 'INVALID_CONFIG' };
        }
        if (typeof value === 'number'
          && ((spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum))) {
          return { ok: false, error: 'INVALID_CONFIG' };
        }
      } else if (!spec.nullable) {
        return { ok: false, error: 'INVALID_CONFIG' };
      }
      // LOCKED_AFTER_START: nach Start nicht änderbar (E3). Der endgültige
      // Check läuft IN der Transaktion auf frischem Status (14-05).
      if (room.status === 'RUNNING' && spec.changeClass === 'LOCKED_AFTER_START') {
        return { ok: false, error: 'LOCKED_AFTER_START' };
      }
      const setup = parseSetupSnapshot(room);
      if (key === 'roundCount' && Array.isArray(setup?.rounds) && (value as number) > setup.rounds.length) {
        return { ok: false, error: 'INVALID_CONFIG' };
      }
      if (key === 'boardCount' && (value as number) > (setup?.board1 && setup?.board2 ? 2 : 1)) {
        return { ok: false, error: 'INVALID_CONFIG' };
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
      // ohne Schreib-Auswirkung).
      const exists = await prisma.room.findUnique({ where: { id: room.id }, select: { revision: true } });
      if (!exists || exists.revision !== args.expectedRevision) {
        return { ok: false, error: 'REVISION_CONFLICT' };
      }
      const values = await loadGameConfigValues(room, gameSlug);
      return { ok: true, changed: false, revision: exists.revision, values };
    }

    // Audit PR14, 14-05: EINE Transaktion — Status-Check (frisch), CAS,
    // Merge und Persistenz. Abbruch an beliebiger Stelle = vollständiger
    // Rollback (Revision bleibt unverbraucht, Werte unverändert).
    return await prisma.$transaction(async (tx) => {
      const fresh = await tx.room.findUnique({ where: { id: room.id } });
      if (!fresh) return { ok: false as const, error: 'ROOM_NOT_FOUND' as const };
      // Frischer Status-Check IN der Transaktion (14-05: kein vorab gelesener
      // Status mehr — ein Start zwischen Read und Write ist damit ausgeschlossen).
      for (const [key] of Object.entries(args.changes)) {
        const spec = fields[key];
        if (spec && fresh.status === 'RUNNING' && spec.changeClass === 'LOCKED_AFTER_START') {
          return { ok: false as const, error: 'LOCKED_AFTER_START' as const };
        }
      }
      const updated = await tx.room.updateMany({
        where: { id: room.id, revision: args.expectedRevision },
        data: {
          revision: { increment: 1 },
          // E3: effektive Live-Overrides zusammenführen (im selben Write).
          // E4: Der START-Snapshot (gameConfigSnapshotJson) bleibt UNVERÄNDERT.
          liveConfigJson: JSON.stringify({ ...parseLiveConfigJson(fresh.liveConfigJson), ...changes }),
        },
      });
      if (updated.count !== 1) return { ok: false as const, error: 'REVISION_CONFLICT' as const };
      const after = await tx.room.findUniqueOrThrow({ where: { id: room.id } });
      const values = await loadGameConfigValues(after, gameSlug);
      return { ok: true as const, changed: true as const, revision: after.revision, values };
    });
  } catch (error) {
    logger.error('updateRoomConfig failed', { roomId: args.roomId, error });
    return { ok: false, error: error instanceof ConfigSnapshotError ? 'CONFIG_SNAPSHOT_INVALID' : 'INTERNAL_ERROR' };
  }
}

export { canLiveOverride, PROTOCOL_VERSION };
