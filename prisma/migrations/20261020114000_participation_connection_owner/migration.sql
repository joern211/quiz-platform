-- A rejoin replaces the presence owner. A disconnect updates only its own
-- connection, so an in-flight old disconnect cannot set a new session offline.
-- Existing identities, ready flags, scores and rejoin tokens remain intact.
ALTER TABLE "participations" ADD COLUMN "connectionId" TEXT;
