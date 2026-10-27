CREATE TABLE "content_media_references" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "itemId" TEXT NOT NULL,
  "itemRevision" INTEGER NOT NULL,
  "assetId" TEXT NOT NULL,
  "authorizedBy" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_media_references_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "content_items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "content_media_references_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "media_assets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "content_media_references_itemId_itemRevision_assetId_key" ON "content_media_references"("itemId", "itemRevision", "assetId");
CREATE INDEX "content_media_references_assetId_idx" ON "content_media_references"("assetId");

-- Recover legacy media into a NEW revision only for untouched, unused copies.
-- Original revisions and all user changes remain immutable. No automatic READY.
UPDATE content_items SET payloadJson = json_patch(payloadJson, (
  SELECT json_object('mediaAssetId', q.mediaAssetId, 'mediaType', q.mediaType) FROM geo_questions q WHERE q.id = content_items.legacyQuestionId
)), revision = revision + 1, updatedAt = CURRENT_TIMESTAMP
WHERE legacyQuestionId IS NOT NULL AND revision = 1 AND status = 'DRAFT'
AND NOT EXISTS (SELECT 1 FROM content_uses u WHERE u.itemId = content_items.id)
AND EXISTS (SELECT 1 FROM geo_questions q WHERE q.id = content_items.legacyQuestionId AND q.mediaAssetId IS NOT NULL);
INSERT INTO content_revisions (id, itemId, revision, kind, changedFieldsJson, snapshotJson)
SELECT 'legacy-media:' || i.id, i.id, i.revision, 'LEGACY_MEDIA_BACKFILL', '["mediaAssetId","mediaType"]',
 json_object('title', i.title, 'payloadJson', i.payloadJson, 'language', i.language, 'difficulty', i.difficulty, 'tagIdsJson', i.tagIdsJson, 'source', i.source, 'sourceUrl', i.sourceUrl, 'license', i.license)
FROM content_items i WHERE i.revision = 2 AND i.legacyQuestionId IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM content_revisions r WHERE r.itemId = i.id AND r.revision = 2);
-- A raw legacy ID is not authorization to another user's private bytes.
INSERT INTO content_media_references (id, itemId, itemRevision, assetId, authorizedBy)
SELECT 'legacy-media:' || i.id, i.id, i.revision, a.id, p.ownerId FROM content_items i
JOIN content_pools p ON p.id = i.poolId JOIN media_assets a ON a.id = json_extract(i.payloadJson, '$.mediaAssetId')
WHERE EXISTS (SELECT 1 FROM content_revisions r WHERE r.itemId = i.id AND r.kind = 'LEGACY_MEDIA_BACKFILL')
AND (a.uploadedBy = p.ownerId OR a.visibility IN ('PUBLIC', 'SYSTEM'));
CREATE TRIGGER content_media_references_no_update BEFORE UPDATE ON content_media_references BEGIN SELECT RAISE(ABORT, 'immutable content media reference'); END;
