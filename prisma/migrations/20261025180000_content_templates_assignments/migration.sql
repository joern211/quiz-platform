CREATE TABLE "content_templates" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "gameSlug" TEXT NOT NULL,
  "name" TEXT NOT NULL, "itemJson" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "content_templates_ownerId_gameSlug_status_idx" ON "content_templates"("ownerId", "gameSlug", "status");
CREATE TABLE "content_review_assignments" (
  "id" TEXT NOT NULL PRIMARY KEY, "itemId" TEXT NOT NULL, "poolId" TEXT NOT NULL,
  "assigneeId" TEXT NOT NULL, "assignedBy" TEXT NOT NULL, "itemRevision" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1, "status" TEXT NOT NULL DEFAULT 'OPEN', "note" TEXT NOT NULL DEFAULT '',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, "completedAt" DATETIME
);
CREATE UNIQUE INDEX "content_review_assignments_itemId_assigneeId_key" ON "content_review_assignments"("itemId", "assigneeId");
CREATE INDEX "content_review_assignments_assigneeId_status_idx" ON "content_review_assignments"("assigneeId", "status");
