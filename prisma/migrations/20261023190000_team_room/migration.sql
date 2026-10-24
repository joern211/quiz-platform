-- CreateTable
CREATE TABLE "room_teams" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "room_teams_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "team_memberships" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "participationId" TEXT NOT NULL,
    "teamId" TEXT,
    "runIndex" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "team_memberships_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "room_feed_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "room_feed_entries_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "room_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "runIndex" INTEGER NOT NULL,
    "gameDefinitionId" TEXT NOT NULL,
    "engineVersion" INTEGER,
    "configSnapshotJson" TEXT,
    "stateJson" TEXT,
    "scoresJson" TEXT NOT NULL,
    "teamsJson" TEXT NOT NULL,
    "endedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "room_runs_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "room_invites" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "roomId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    CONSTRAINT "room_invites_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Additive changes preserve existing rows, indexes and foreign-key identities.
ALTER TABLE "rooms" ADD COLUMN "roomPolicyJson" TEXT;
ALTER TABLE "rooms" ADD COLUMN "lifecycle" TEXT;
ALTER TABLE "rooms" ADD COLUMN "scheduledAt" DATETIME;
ALTER TABLE "rooms" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "rooms" ADD COLUMN "runIndex" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "participations" ADD COLUMN "userId" TEXT;
ALTER TABLE "participations" ADD COLUMN "guestKeyHash" TEXT;
ALTER TABLE "participations" ADD COLUMN "admission" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "participations" ADD COLUMN "bannedAt" DATETIME;
ALTER TABLE "participations" ADD COLUMN "leftAt" DATETIME;
ALTER TABLE "participations" ADD COLUMN "activeNameKey" TEXT;
ALTER TABLE "participations" ADD COLUMN "nameHistoryJson" TEXT NOT NULL DEFAULT '[]';
UPDATE "participations" SET "userId" = (SELECT "hostUserId" FROM "rooms" WHERE "rooms"."id" = "participations"."roomId") WHERE "role" = 'HOST';
CREATE UNIQUE INDEX "participations_roomId_activeNameKey_key" ON "participations"("roomId", "activeNameKey");
-- CreateIndex
CREATE INDEX "room_teams_roomId_idx" ON "room_teams"("roomId");

-- CreateIndex
CREATE INDEX "team_memberships_roomId_participationId_idx" ON "team_memberships"("roomId", "participationId");

-- CreateIndex
CREATE INDEX "room_feed_entries_roomId_createdAt_idx" ON "room_feed_entries"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "room_runs_roomId_runIndex_key" ON "room_runs"("roomId", "runIndex");

-- CreateIndex
CREATE UNIQUE INDEX "room_invites_tokenHash_key" ON "room_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "room_invites_roomId_idx" ON "room_invites"("roomId");


ALTER TABLE "score_events" ADD COLUMN "teamId" TEXT;
ALTER TABLE "score_events" ADD COLUMN "runIndex" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "participations" ADD COLUMN "lastRoundTripMs" INTEGER;

ALTER TABLE "participations" ADD COLUMN "hasSeenHostSecrets" BOOLEAN NOT NULL DEFAULT false;
UPDATE "participations" SET "hasSeenHostSecrets" = true WHERE "role" = 'HOST';

ALTER TABLE "rooms" ADD COLUMN "createdByUserId" TEXT;
UPDATE "rooms" SET "createdByUserId" = "hostUserId";
DROP INDEX "rooms_idempotencyKey_hostUserId_key";
CREATE UNIQUE INDEX "rooms_idempotencyKey_createdByUserId_key" ON "rooms"("idempotencyKey", "createdByUserId");
