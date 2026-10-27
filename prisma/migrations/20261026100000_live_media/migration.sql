CREATE TABLE "room_media_controls" (
  "roomId" TEXT NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "policyJson" TEXT NOT NULL DEFAULT '{}',
  CONSTRAINT "room_media_controls_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "participant_media_controls" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "hostMuted" BOOLEAN NOT NULL DEFAULT false,
  "cameraHidden" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "participant_media_controls_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "participant_media_controls_roomId_participantId_key" ON "participant_media_controls"("roomId", "participantId");

CREATE TABLE "display_sessions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "roomId" TEXT NOT NULL,
  "connected" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "display_sessions_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "display_sessions_roomId_idx" ON "display_sessions"("roomId");
