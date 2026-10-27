CREATE TABLE "content_editor_presence" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "itemId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "editorKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "content_editor_presence_itemId_sessionId_editorKey_key" ON "content_editor_presence"("itemId", "sessionId", "editorKey");
CREATE INDEX "content_editor_presence_itemId_lastSeenAt_idx" ON "content_editor_presence"("itemId", "lastSeenAt");
