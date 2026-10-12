-- BASIS-STANDARDS (Planplatz "PR13", GitHub-PR #14):
--   A) Kanonische Rollen: MODERATOR → HOST (User.role, Participation.role)
--      + Room-Schema-Erweiterungen (Config, Berechtigungs-Delegation,
--      Command-Receipts).
--
-- Begründung (Master-Regelwerk §2.1/§2.2, §12.1):
--   - "Moderator" wird als Begriff vollständig durch HOST ersetzt.
--   - ADMIN bleibt ADMIN (kein Umbenennen).
--   - Unbekannte Rollenwerte bleiben bewusst in der DB stehen: sie werden
--     an der Code-Grenze (Auth/Socket/HTTP) mit ROLE_REQUIRED abgelehnt,
--     NICHT still gecastet oder stumm "berichtigt" (kein beliebiger
--     String-Cast).
--   - Alle IDs, Sessions, Rejoin-Tokens, Referenzen, Ergebnisse,
--     Engine-/Setup-Versionen bleiben UNBERÜHRT.
--
-- Invarianten (Beleg: migration.roles.test.ts):
--   1. ADMIN bleibt ADMIN.
--   2. MODERATOR → HOST in User.role und Participation.role.
--   3. PLAYER/VIEWER/DISPLAY bleiben unverändert.
--   4. Unbekannte Werte (z.B. 'SUPERUSER') bleiben als-is (Grenzabwurf).
--   5. Wiederholte Ausführung ist ein No-op (idempotent).
--   6. IDs/Spaltenbestand anderer Tabellen unverändert (additiv).

-- (1) User.role: nur der bekannte Legacy-Wert wird umgeschrieben.
UPDATE "users" SET "role" = 'HOST' WHERE "role" = 'MODERATOR';

-- (2) Participation.role: derselbe, eindeutig begründete Umbau.
UPDATE "participations" SET "role" = 'HOST' WHERE "role" = 'MODERATOR';

-- (3) Room: Konfigurations-Schema-Version + unveränderlicher Start-Snapshot.
--     NULL/0 bedeutet "keiner (Legacy)" — Legacy-Strategie liest
--     setupSnapshotJson + Manifest-Defaults, nie eine Neu-Interpretation.
ALTER TABLE "rooms" ADD COLUMN "configSchemaVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "rooms" ADD COLUMN "gameConfigSnapshotJson" TEXT;
--     Mutables Live-Override-Ziel (EDITABLE-Felder, auch nach Start).
ALTER TABLE "rooms" ADD COLUMN "liveConfigJson" TEXT;

-- (4) Berechtigungs-Delegation (Grants/Revocations, getrennt je Recht).
CREATE TABLE "room_permission_grants" (
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "RoomPermissionGrant_pkey" PRIMARY KEY ("roomId","userId","permission","direction"),
    CONSTRAINT "RoomPermissionGrant_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoomPermissionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RoomPermissionGrant_roomId_idx" ON "room_permission_grants"("roomId");
CREATE INDEX "RoomPermissionGrant_userId_idx" ON "room_permission_grants"("userId");

-- (5) Command-Receipts (Wiederholungssicherheit, atomar über Unique-Key).
CREATE TABLE "command_receipts" (
    "roomId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "stateVersion" INTEGER,
    "status" TEXT NOT NULL,
    "responseJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CommandReceipt_pkey" PRIMARY KEY ("roomId","commandId"),
    CONSTRAINT "CommandReceipt_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CommandReceipt_roomId_idx" ON "command_receipts"("roomId");
