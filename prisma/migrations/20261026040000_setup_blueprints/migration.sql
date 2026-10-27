ALTER TABLE "rooms" ADD COLUMN "setupBlueprintsJson" TEXT;
CREATE TABLE "setup_blueprints" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "kind" TEXT NOT NULL, "gameSlug" TEXT,
  "name" TEXT NOT NULL, "configurationJson" TEXT NOT NULL, "favorite" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "setup_blueprints_ownerId_kind_status_idx" ON "setup_blueprints"("ownerId", "kind", "status");
