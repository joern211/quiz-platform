-- PR11 Audit (P1): logische Asset-Identität (assetKey) + Raum-Idempotenz.
--
-- Schließt die Merge-Blocker:
--   11-03 (Composite-Provenienz): Dedupe läuft über die LOGISCHE Identität
--          (assetKey = ordnungs-sensitive Quellen-Identität für Composites),
--          NICHT über die Ausgabe-Bytes → verschiedene Quellpaare behalten
--          eigene Provenienz, selbst bei identischen Bytes.
--   11-04 (Upload-Kontext): ein frischer PRIVATE-Upload erbt den Kontext
--          (visibility) einer bestehenden PUBLIC-Zeile NICHT, weil der
--          Unique-Key um visibility erweitert ist.
--   11-02 (Unveränderlichkeit) + 11-01 (Pfad-Traversing): der Composite-
--          Pfad ist content-geleitet und enthält KEINE roundId (Code-Änderung).
--   11-06 (Raum-Retry): serverseitige Idempotenz über Room.idempotencyKey.
--
-- Invarianten, die BEIHALTEN werden (additiv, keine Datenverluste):
--   - "genau eine nutzbare Zeile pro (Content, Owner, Kontext)" für Uploads:
--     der Legacy-Backfill setzt assetKey := sha256 für Upload-Zeilen OHNE
--     assetKey, sodass die alte Dedupe-Logik (gleiche Bytes + gleicher Owner)
--     über den NEUEN Unique-Key [assetKey, uploadedBy, visibility] weiter
--     greift (für Uploads gilt assetKey = sha256).
--   - LEGACY-COMPOSITES (vor diesem Schritt erzeugte Fusion-Bilder, erkennbar
--     an derivedFromAssetIds IS NOT NULL) werden NICHT mit assetKey = sha256
--     zurückbelegt: ihr sha256 ist der Hash der AUSGABE-Bytes — das würde
--     die Composite-Provenienz verlieren (11-03) und die Bytes-basierte
--     Identität wieder einführen. Sie behalten assetKey = NULL und bleiben
--     über ihre eigene ID lesbar/referenzierbar; der Unique-Index lässt sie
--     durch (SQLite: NULL ist im Unique-Index distinct). Mit neuem Code
--     können sie nicht kollisionieren, weil der Composite-Writer ab diesem
--     Schritt IMMER einen "fusion:…"-assetKey setzt.
--   - Der alte Index [sha256, uploadedBy] wird ERSATZLOS durch den neuen
--     (strengeren) Index ersetzt. Für Uploads gilt assetKey = sha256, daher
--     bleibt [sha256, uploadedBy] faktisch eindeutig (jeweils je visibility);
--     für Composites ist sha256 bewusst NICHT mehr der Identitätsträger
--     (11-02/11-03), was den alten Index ohnehin überholt.
--   - SQLite behandelt NULL in Unique-Indexen immer als distinct → Zeilen
--     mit assetKey = NULL (Seed/Geo-System-Assets, Legacy-Composites)
--     kollidieren NIE.
--
-- Alle Änderungen sind additiv (2 Spalten, 3 neue Indizes, 1 Index-Drop,
-- 1 idempotenter, gezieltes Backfill). Kein Datenumschreiben bestehender
-- Räume/Assets, keine Sichtbarkeits-/Ownership-/Snapshot-Änderung.

-- (1) Neue Spalte: logische Asset-Identität (nullable, Legacy = NULL).
ALTER TABLE "media_assets" ADD COLUMN "assetKey" TEXT;

-- (2) Backfill NUR für Upload-Zeilen: logische Identität = Content-Hash.
--     Kriterium: keine Composite-Provenienz (derivedFromAssetIds IS NULL) und
--     noch kein assetKey. Legacy-Composites (derivedFromAssetIds gesetzt)
--     bleiben bewusst NULL — s. Invarianten oben.
UPDATE "media_assets"
   SET "assetKey" = "sha256"
 WHERE "assetKey" IS NULL
   AND "derivedFromAssetIds" IS NULL;

-- (3) Lookup-Index auf assetKey.
CREATE INDEX "media_assets_assetKey_idx" ON "media_assets"("assetKey");

-- (4) Neuer Unique-Key: logische Identität pro Uploader UND pro Kontext.
CREATE UNIQUE INDEX "media_assets_assetKey_uploadedBy_visibility_key" ON "media_assets"("assetKey", "uploadedBy", "visibility");

-- (5) Alten, ersatzlos überholten Index entfernen (s. Invarianten oben).
DROP INDEX "media_assets_sha256_uploadedBy_key";

-- (6) Neue Spalte: serverseitiges Idempotency-Token für Raum-Erstellung.
ALTER TABLE "rooms" ADD COLUMN "idempotencyKey" TEXT;

-- (7) Unique-Key: ein Token gehört zu genau einem Raum des Hosts.
CREATE UNIQUE INDEX "rooms_idempotencyKey_hostUserId_key" ON "rooms"("idempotencyKey", "hostUserId");
