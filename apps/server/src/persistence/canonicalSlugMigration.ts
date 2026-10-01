// ============================================================
// Versionierte, idempotente Slug-Migration (Regelwerk §5.22, §5.23, §12.1)
//
// Migriert bestehende Daten von Legacy-Slugs auf die kanonischen Slugs
// (Regelwerk §14) OHNE Datenverlust und OHNE historische Results zu
// umschreiben.
//
// Prinzipien:
//   - versioniert  : jede Migration hat eine Nummer; der Stand wird in der
//                    AuditLog-Tabelle protokolliert (metadata.version).
//   - idempotent   : jeder Schritt prüft seine Vorbedingung ("Legacy-Daten
//                    vorhanden?") und ist damit bei Wiederholung ein No-op.
//   - Kollisionen   : wenn alter UND neuer Slug gleichzeitig als
//                    GameDefinition existieren, wird NIE gelöscht. Die
//                    Kinder (Rooms, SetupDrafts, QuestionPacks) werden auf
//                    die kanonische Definition umgebunden und die Legacy-
//                    Definition wird HIDDEN markiert (bleibt erhalten).
//   - keine stillen Schreibungen: jede Änderung wird in einer AuditLog-
//                    Zeile zusammengefasst (action = 'canonical_slug_migration').
//   - aktive vs. abgeschlossene Spiele: Rooms werden NUR über ihre stabile
//                    gameDefinitionId gelöst. Da bei einem reinen Rename die
//                    GameDefinition-ID unverändert bleibt, verweisen aktive
//                    UND abgeschlossene Räume automatisch weiterhin korrekt.
//                    Nur bei einer Kollision wird die ID umgebunden.
//   - Engine-Version: room_game_states.engineVersion und setupSchemaVersion
//                    bleiben unberührt → Recovery nutzt exakt dieselbe Engine.
// ============================================================

import type { PrismaClient, PrismaPromise } from '@prisma/client';
import { GAME_MANIFESTS, LEGACY_SLUG_ALIASES } from '@quiz/shared';
import { logger } from '../observability/logger.js';

export const CANONICAL_SLUG_MIGRATION_VERSION = 1;

// Marker für verarbeitete Legacy-Definitionen (Kollisionsfall).
// Nach dem Merge wird die Legacy-Definition HIDDEN + mit diesem Präfix
// markiert. Beim zweiten Lauf wird sie dadurch übersprungen → echte
// Idempotenz (keine doppelte Audit-Protokollierung, keine Wiederholung).
const MIGRATED_DEF_NAME_PREFIX = '[slug-migrated]';

export interface SlugMigrationResult {
  version: number;
  applied: boolean;
  renamedDefinitions: string[];
  mergedCollisions: Array<{ legacy: string; canonical: string }>;
  repointedRooms: number;
  repointedSetups: number;
  repointedQuestionPacks: number;
  hiddenDefinitions: string[];
  changes: number;
}

type DbClient = PrismaClient | (PrismaClient & { $transaction: (fn: (tx: any) => Promise<any>) => Promise<any> });

/** Katalog-Attribute aus dem kanonischen Manifest für eine Slug-Ausrichtung. */
function manifestAttributes(canonicalSlug: string) {
  const m = GAME_MANIFESTS.find((g) => g.slug === canonicalSlug);
  if (!m) return null;
  return {
    name: m.name,
    category: m.category,
    shortDescription: m.shortDescription,
    description: m.description,
    status: m.status,
    minPlayers: m.minPlayers,
    maxPlayers: m.maxPlayers,
    estimatedMinutes: m.estimatedDurationMinutes,
    hasBuzzer: m.hasBuzzer,
    hasTeams: m.hasTeams,
    hasCamera: m.hasCamera,
    hasAudio: m.hasAudio,
    hasTimer: m.hasTimer,
    setupSchemaVersion: m.setupSchemaVersion,
  };
}

/**
 * Führt die kanonische Slug-Migration aus. Atomar (ein $transaction) und
 * idempotent. Akzeptiert einen PrismaClient ODER eine Prisma-Tx-Instanz.
 */
export async function runCanonicalSlugMigration(client: PrismaClient): Promise<SlugMigrationResult> {
  const result: SlugMigrationResult = {
    version: CANONICAL_SLUG_MIGRATION_VERSION,
    applied: false,
    renamedDefinitions: [],
    mergedCollisions: [],
    repointedRooms: 0,
    repointedSetups: 0,
    repointedQuestionPacks: 0,
    hiddenDefinitions: [],
    changes: 0,
  };

  // Dedupliziere die Legacy→kanonische Mapping auf Zielbasis:
  // multiple Legacy-Slugs können denselben kanonischen Slug targeten
  // (z.B. wer-luegt + luegen → imposter). Wir bearbeiten jede Legacy-Quelle,
  // binden aber auf dieselbe kanonische Definition.
  const legacyToCanonical = new Map<string, string>(Object.entries(LEGACY_SLUG_ALIASES));

  await client.$transaction(async (tx: any) => {
    // ── Schritt 1: GameDefinition (Identität) ─────────────────────────
    for (const [legacySlug, canonicalSlug] of legacyToCanonical) {
      const legacy = await tx.gameDefinition.findUnique({ where: { slug: legacySlug } });
      if (!legacy) continue; // schon migriert / nie vorhanden → No-op

      // Bereits verarbeitete Legacy-Definition (Kollisionsfall) → überspringen.
      // (Idempotenz: die Definition ist HIDDEN + markiert und hat keine
      //  verbliebenen Kinder mehr, daher bleibt der 2. Lauf ein echtes No-op.)
      if (typeof legacy.name === 'string' && legacy.name.startsWith(MIGRATED_DEF_NAME_PREFIX)) {
        continue;
      }

      const canonical = await tx.gameDefinition.findUnique({ where: { slug: canonicalSlug } });
      const attrs = manifestAttributes(canonicalSlug);

      if (!canonical) {
        // NORMALFALL: nur Legacy vorhanden → auf kanonischen Slug umbenennen.
        const data: Record<string, unknown> = { slug: canonicalSlug };
        if (attrs) Object.assign(data, attrs);
        await tx.gameDefinition.update({ where: { id: legacy.id }, data });
        result.renamedDefinitions.push(`${legacySlug} → ${canonicalSlug}`);
        result.changes += 1;
      } else {
        // KOLLISION: beide vorhanden. KEIN Löschen.
        // Kinder der Legacy-Definition auf die kanonische umbinden.
        const rooms = await tx.room.updateMany({
          where: { gameDefinitionId: legacy.id },
          data: { gameDefinitionId: canonical.id },
        });
        const setups = await tx.setupDraft.updateMany({
          where: { gameDefinitionId: legacy.id },
          data: { gameDefinitionId: canonical.id },
        });
        result.repointedRooms += rooms.count;
        result.repointedSetups += setups.count;

        // Fragepakete der Legacy-Slug auf die kanonische Slug.
        const packs = await tx.questionPack.updateMany({
          where: { gameSlug: legacySlug },
          data: { gameSlug: canonicalSlug },
        });
        result.repointedQuestionPacks += packs.count;

        // Legacy-Definition bleibt erhalten (ID stabil, keine Datenverlust),
        // wird aber HIDDEN + mit Migrations-Marker versehen, damit sie
        // öffentlich nicht mehr erscheint, nicht doppelt startbar ist und
        // bei Wiederholung der Migration übersprungen wird.
        await tx.gameDefinition.update({
          where: { id: legacy.id },
          data: { status: 'HIDDEN', name: `${MIGRATED_DEF_NAME_PREFIX} ${legacy.name}` },
        });
        result.hiddenDefinitions.push(legacySlug);
        result.mergedCollisions.push({ legacy: legacySlug, canonical: canonicalSlug });
        result.changes += 1 + rooms.count + setups.count + packs.count;
      }
    }

    // ── Schritt 2: Fragepakete (Content) auf kanonische Slug ───────────
    // Unabhängig von Schritt 1: auch nach einem reinen Rename verweisen
    // die Packs noch auf den alten Slug und müssen ausgerichtet werden.
    for (const [legacySlug, canonicalSlug] of legacyToCanonical) {
      const packs = await tx.questionPack.updateMany({
        where: { gameSlug: legacySlug },
        data: { gameSlug: canonicalSlug },
      });
      if (packs.count > 0) result.changes += packs.count;
    }

    // ── Schritt 3: kanonische Definitionen an den Manifest ausrichten ──
    // Stellt sicher, dass die DB die ehrlichen Katalog-Status trägt
    // (AVAILABLE nur bei startbarer, getesteter Engine). Nur für die
    // tatsächlich existierenden kanonischen Definitionen.
    for (const m of GAME_MANIFESTS) {
      const def = await tx.gameDefinition.findUnique({ where: { slug: m.slug } });
      if (!def) continue;
      const attrs = manifestAttributes(m.slug)!;
      await tx.gameDefinition.update({ where: { id: def.id }, data: attrs });
    }

    // ── Schritt 4: Audit-Protokoll (nur bei Änderungen) ────────────────
    if (result.changes > 0) {
      result.applied = true;
      await tx.auditLog.create({
        data: {
          action: 'canonical_slug_migration',
          resource: 'GameDefinition',
          resourceId: null,
          metadata: JSON.stringify({
            version: CANONICAL_SLUG_MIGRATION_VERSION,
            renamedDefinitions: result.renamedDefinitions,
            mergedCollisions: result.mergedCollisions,
            repointedRooms: result.repointedRooms,
            repointedSetups: result.repointedSetups,
            repointedQuestionPacks: result.repointedQuestionPacks,
            hiddenDefinitions: result.hiddenDefinitions,
          }),
        },
      });
    }
  });

  if (result.applied) {
    logger.info('Canonical slug migration applied', {
      version: result.version,
      renamed: result.renamedDefinitions,
      collisions: result.mergedCollisions,
      repointedRooms: result.repointedRooms,
    });
  }
  return result;
}

/**
 * Start-Hook: führt die Migration idempotent aus. Ein Fehler darf den
 * Server nicht blockieren, wird aber prominent geloggt (Recovery-Prinzip:
 * besser lauten als falschen State erzeugen).
 */
export async function migrateCanonicalSlugsOnStartup(client: PrismaClient): Promise<void> {
  try {
    const result = await runCanonicalSlugMigration(client);
    if (!result.applied) {
      logger.debug('Canonical slug migration: no changes (already canonical)');
    }
  } catch (error) {
    logger.error('Canonical slug migration FAILED — check database before continuing', { error });
    // Kein throw: der Server kann auch mit unverändertem (legacy) State
    // fahren, da die Runtime-Lösung (resolveCanonicalSlug) Legacy-Slugs
    // ebenfalls auflöst. Die Migration ist aber für saubere Daten nötig.
  }
}
