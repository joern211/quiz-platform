CREATE TABLE "game_domain_events" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "runIndex" INTEGER NOT NULL,
  "gameSlug" TEXT NOT NULL,
  "engineVersion" INTEGER NOT NULL,
  "baseStateVersion" INTEGER NOT NULL,
  "stateVersion" INTEGER NOT NULL CHECK ("stateVersion" = "baseStateVersion" + 1),
  "type" TEXT NOT NULL,
  "commandId" TEXT,
  "actorId" TEXT,
  "payloadJson" TEXT NOT NULL,
  "occurredAt" DATETIME NOT NULL,
  CONSTRAINT "game_domain_events_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "game_domain_events_roomId_runIndex_stateVersion_key" ON "game_domain_events"("roomId", "runIndex", "stateVersion");
CREATE INDEX "game_domain_events_roomId_runIndex_commandId_idx" ON "game_domain_events"("roomId", "runIndex", "commandId");
CREATE TRIGGER "game_domain_events_immutable" BEFORE UPDATE ON "game_domain_events"
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_GAME_EVENT');
END;
