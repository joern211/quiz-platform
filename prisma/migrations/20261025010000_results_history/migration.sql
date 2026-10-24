ALTER TABLE "score_events" ADD COLUMN "roundKey" TEXT;
ALTER TABLE "score_events" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'GAME_SCORE';
ALTER TABLE "score_events" ADD COLUMN "referenceEventId" TEXT;
CREATE TABLE "game_results" (
 "id" TEXT NOT NULL PRIMARY KEY, "roomId" TEXT NOT NULL, "runIndex" INTEGER NOT NULL,
 "gameSlug" TEXT NOT NULL, "engineVersion" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'GAME_END',
 "revision" INTEGER NOT NULL DEFAULT 1, "configSnapshotJson" TEXT, "endedAt" DATETIME NOT NULL, "finalizedAt" DATETIME,
 FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "game_results_roomId_runIndex_key" ON "game_results"("roomId", "runIndex");
CREATE TABLE "game_result_versions" (
 "id" TEXT NOT NULL PRIMARY KEY, "resultId" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "kind" TEXT NOT NULL, "actorId" TEXT, "reason" TEXT, "dataJson" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("resultId") REFERENCES "game_results"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "game_result_versions_resultId_revision_key" ON "game_result_versions"("resultId", "revision");
CREATE TABLE "round_results" (
 "id" TEXT NOT NULL PRIMARY KEY, "roomId" TEXT NOT NULL, "runIndex" INTEGER NOT NULL, "roundKey" TEXT NOT NULL,
 "stateVersion" INTEGER NOT NULL, "dataJson" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "round_results_roomId_runIndex_roundKey_key" ON "round_results"("roomId", "runIndex", "roundKey");
CREATE TRIGGER "game_result_versions_immutable" BEFORE UPDATE ON "game_result_versions" BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RESULT_VERSION'); END;
CREATE TRIGGER "round_results_immutable" BEFORE UPDATE ON "round_results" BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_ROUND_RESULT'); END;
CREATE TRIGGER "score_events_immutable" BEFORE UPDATE ON "score_events" BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_SCORE_EVENT'); END;
