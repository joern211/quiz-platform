ALTER TABLE "media_assets" ADD COLUMN "variantKind" TEXT NOT NULL DEFAULT 'WEB';
CREATE TABLE "media_processing_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "commandId" TEXT NOT NULL,
  "inputHash" TEXT NOT NULL, "originalId" TEXT NOT NULL, "outputId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'QUEUED', "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT, "leaseUntil" DATETIME, "errorCode" TEXT, "retryable" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "media_processing_jobs_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "media_processing_jobs_ownerId_commandId_key" ON "media_processing_jobs"("ownerId", "commandId");
CREATE INDEX "media_processing_jobs_status_leaseUntil_idx" ON "media_processing_jobs"("status", "leaseUntil");
CREATE TABLE "media_asset_variants" (
  "id" TEXT NOT NULL PRIMARY KEY, "originalId" TEXT NOT NULL, "assetId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  CONSTRAINT "media_asset_variants_originalId_fkey" FOREIGN KEY ("originalId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "media_asset_variants_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "media_asset_variants_originalId_kind_key" ON "media_asset_variants"("originalId", "kind");
