CREATE TABLE "content_playtests" (
  "id" TEXT NOT NULL PRIMARY KEY, "code" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "poolId" TEXT NOT NULL,
  "gameSlug" TEXT NOT NULL, "snapshotJson" TEXT NOT NULL, "position" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1, "phase" TEXT NOT NULL DEFAULT 'QUESTION',
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "content_playtests_code_key" ON "content_playtests"("code");
CREATE INDEX "content_playtests_ownerId_expiresAt_idx" ON "content_playtests"("ownerId", "expiresAt");
CREATE TABLE "content_playtest_feedback" (
  "id" TEXT NOT NULL PRIMARY KEY, "playtestId" TEXT NOT NULL, "position" INTEGER NOT NULL,
  "clientKey" TEXT NOT NULL, "kind" TEXT NOT NULL, "value" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_playtest_feedback_playtestId_fkey" FOREIGN KEY ("playtestId") REFERENCES "content_playtests" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "content_playtest_feedback_playtestId_position_clientKey_kind_key" ON "content_playtest_feedback"("playtestId", "position", "clientKey", "kind");

-- Question identities, payloads and sharing authority never drift after creation.
CREATE TRIGGER "content_playtests_snapshot_immutable"
BEFORE UPDATE OF "snapshotJson", "ownerId", "poolId", "gameSlug", "code" ON "content_playtests"
BEGIN SELECT RAISE(ABORT, 'CONTENT_PLAYTEST_SNAPSHOT_IMMUTABLE'); END;
