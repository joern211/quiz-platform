-- CreateIndex
CREATE INDEX "viewer_sessions_roomId_connected_idx" ON "viewer_sessions"("roomId", "connected");
