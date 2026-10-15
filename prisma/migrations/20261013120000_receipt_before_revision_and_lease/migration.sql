-- Audit PR14, 14-02: Receipt-Recovery-Spalten.
-- beforeRevision: Room-Revision, atomar mit dem Claim gelesen. Ein Retry
--   kann so entscheiden, ob der ursprüngliche Command bereits gewirkt hat:
--   Revision fortgeschritten → keine Neu-Ausführung (Resync); unverändert
--   → sichere Neu-Ausführung. Schließt die Doppelwirkungs-Lücke, wenn der
--   COMPLETED-Write nach einem committeten CAS verloren geht.
-- leaseExpiresAt: PENDING-Lease. Prozessabbruch zwischen Claim und
--   Abschluss hinterlässt PENDING; abgelaufene Lease = abgestürzter
--   Besitzer → Recovery statt dauerhaftem COMMAND_IN_PROGRESS.
-- Beide Spalten nullable: Bestandszeilen (vor dieser Migration) tragen
-- NULL → konservative Behandlung (Resync statt Neu-Ausführung).
ALTER TABLE "command_receipts" ADD COLUMN "beforeRevision" INTEGER;
ALTER TABLE "command_receipts" ADD COLUMN "leaseExpiresAt" DATETIME;
