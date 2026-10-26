CREATE TABLE "content_difficulty_presets" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "gameSlug" TEXT NOT NULL,
  "name" TEXT NOT NULL, "planJson" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "content_difficulty_presets_ownerId_gameSlug_status_idx" ON "content_difficulty_presets"("ownerId", "gameSlug", "status");
