-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_media_assets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration" INTEGER,
    "sha256" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "roomId" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "thumbnailPath" TEXT,
    "derivedFromAssetIds" TEXT,
    "processStatus" TEXT NOT NULL DEFAULT 'READY',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_media_assets" ("createdAt", "duration", "fileSize", "filename", "height", "id", "mimeType", "originalName", "processed", "roomId", "sha256", "storagePath", "thumbnailPath", "type", "uploadedBy", "visibility", "width") SELECT "createdAt", "duration", "fileSize", "filename", "height", "id", "mimeType", "originalName", "processed", "roomId", "sha256", "storagePath", "thumbnailPath", "type", "uploadedBy", "visibility", "width" FROM "media_assets";
DROP TABLE "media_assets";
ALTER TABLE "new_media_assets" RENAME TO "media_assets";
CREATE UNIQUE INDEX "media_assets_sha256_key" ON "media_assets"("sha256");
CREATE INDEX "media_assets_sha256_idx" ON "media_assets"("sha256");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
