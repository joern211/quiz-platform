-- CreateTable
CREATE TABLE "content_import_drafts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poolId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "rowsJson" TEXT NOT NULL,
    "previewJson" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "content_reviews" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poolId" TEXT NOT NULL,
    "itemId" TEXT,
    "actorId" TEXT NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "proposedJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_REVIEW',
    "reviewerId" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "content_notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "itemId" TEXT,
    "message" TEXT NOT NULL,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "content_comments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "content_import_drafts_actorId_expiresAt_idx" ON "content_import_drafts"("actorId", "expiresAt");

-- CreateIndex
CREATE INDEX "content_reviews_poolId_status_idx" ON "content_reviews"("poolId", "status");

-- CreateIndex
CREATE INDEX "content_notifications_userId_readAt_idx" ON "content_notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "content_comments_itemId_status_idx" ON "content_comments"("itemId", "status");

