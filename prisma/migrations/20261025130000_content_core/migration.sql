-- CreateTable
CREATE TABLE "content_pools" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameSlug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL DEFAULT 'PRIVATE',
    "ownerId" TEXT,
    "editorIdsJson" TEXT NOT NULL DEFAULT '[]',
    "defaultsJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "forkedFromPoolId" TEXT,
    "legacyPackId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poolId" TEXT NOT NULL,
    "gameSlug" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "payloadJson" TEXT NOT NULL,
    "language" TEXT,
    "difficulty" TEXT,
    "tagIdsJson" TEXT,
    "source" TEXT NOT NULL DEFAULT '',
    "sourceUrl" TEXT NOT NULL DEFAULT '',
    "license" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "reviewState" TEXT NOT NULL DEFAULT 'NOT_REVIEWED',
    "lockState" TEXT NOT NULL DEFAULT 'EDITABLE',
    "duplicatedFromId" TEXT,
    "legacyQuestionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "content_items_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "content_pools" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "content_revisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "actorId" TEXT,
    "kind" TEXT NOT NULL,
    "changedFieldsJson" TEXT NOT NULL,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_revisions_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "content_items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "content_tags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "content_uses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "runIndex" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "itemRevision" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "snapshotJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_uses_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "content_items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "content_mutation_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "intentHash" TEXT NOT NULL,
    "responseJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "content_pools_legacyPackId_key" ON "content_pools"("legacyPackId");

-- CreateIndex
CREATE INDEX "content_pools_gameSlug_scope_ownerId_idx" ON "content_pools"("gameSlug", "scope", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "content_items_legacyQuestionId_key" ON "content_items"("legacyQuestionId");

-- CreateIndex
CREATE INDEX "content_items_poolId_status_idx" ON "content_items"("poolId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "content_revisions_itemId_revision_key" ON "content_revisions"("itemId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "content_tags_slug_key" ON "content_tags"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "content_uses_roomId_runIndex_itemId_key" ON "content_uses"("roomId", "runIndex", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "content_mutation_receipts_actorId_commandId_key" ON "content_mutation_receipts"("actorId", "commandId");


-- Preserve legacy identity and ownership. Legacy content requires explicit revalidation
-- in the new editor; existing room/engine readers remain unchanged.
INSERT INTO content_pools (id, gameSlug, name, description, scope, ownerId, legacyPackId, defaultsJson, createdAt, updatedAt)
SELECT id, 'wissensduell', title, COALESCE(description, ''), 'PRIVATE', createdBy, id, '{"language":"de-DE","difficulty":null,"tagIds":[]}', createdAt, updatedAt
FROM question_packs WHERE gameSlug IN ('wissensduell', 'geo');
INSERT INTO content_items (id, poolId, gameSlug, title, payloadJson, legacyQuestionId, createdAt, updatedAt)
SELECT q.id, q.packId, 'wissensduell', COALESCE(q.title, ''),
 json_object('prompt', q.prompt, 'category', q.category, 'options', json(CASE WHEN json_valid(q.options) THEN q.options ELSE '[]' END), 'correctOptionId', q.correctOptionId,
 'explanation', COALESCE(q.explanation, ''), 'points', q.points, 'wrongPoints', q.wrongPoints, 'durationMs', q.durationMs),
 q.id, q.createdAt, q.updatedAt FROM geo_questions q JOIN content_pools p ON p.id=q.packId;
INSERT INTO content_revisions (id, itemId, revision, kind, changedFieldsJson, snapshotJson)
SELECT 'legacy:' || id, id, 1, 'LEGACY_IMPORT', '["legacyQuestionId"]',
 json_object('title', title, 'payloadJson', payloadJson, 'language', language, 'difficulty', difficulty, 'tagIdsJson', tagIdsJson, 'source', source, 'sourceUrl', sourceUrl, 'license', license) FROM content_items;
CREATE TRIGGER content_revisions_no_update BEFORE UPDATE ON content_revisions BEGIN SELECT RAISE(ABORT, 'immutable content revision'); END;
CREATE TRIGGER content_uses_no_update BEFORE UPDATE ON content_uses BEGIN SELECT RAISE(ABORT, 'immutable content snapshot'); END;
