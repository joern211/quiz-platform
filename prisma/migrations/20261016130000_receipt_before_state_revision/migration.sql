-- Audit PR14, 14-02 (Nacharbeit): State-Revision-Snapshot für den Claim.
-- beforeStateRevision: RoomGameState-Revision, atomar MIT dem Claim gelesen.
--   Die Engines (WID/Geo/Jeopardy) erhöhen bei fachlichen Aktionen die
--   GameState-Revision — NICHT zwingend die Room-Revision. Ein Retry nach
--   verlorenem COMPLETED-Write darf die Mutation NICHT erneut ausführen,
--   wenn IRGENDWELCHER beobachteter Zustand (Room ODER GameState)
--   fortgeschritten ist → kontrollierter Resync statt Doppelwirkung.
--   NULL = Legacy-Zeile (vor dieser Migration) → konservative Behandlung
--   (Resync statt Neu-Ausführung).
ALTER TABLE "command_receipts" ADD COLUMN "beforeStateRevision" INTEGER;
