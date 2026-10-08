-- PR11-Nacharbeit B: Content-Identität je Uploader statt global.
--
-- Vorher: globales UNIQUE (sha256) → identischer Upload eines ANDEREN Hosts
-- kollidierte (P2002 → 500), parallele identische Uploads desselben Hosts
-- kollidierten ebenso, Cleanup ließ die fertig geschriebene Datei liegen.
--
-- Jetzt: UNIQUE (sha256, uploadedBy). Gleicher Host + gleicher Content →
-- Dedupe; fremder Host + gleicher Content → eigenes Asset (201). Parallele
-- identische Uploads desselben Hosts kollidieren kontrolliert mit P2002
-- (Handler löst auf das bestehende Asset auf, räumt nur die eigene Datei auf).
--
-- SQLite-Verhalten: NULL-Werte sind in Unique-Indexen immer unterschiedlich,
-- daher bleiben Legacy-Zeilen mit uploadedBy = NULL (z. B. Seed/Geo) unver-
-- ändert lesbar und können nicht gegen neue Uploads kollidieren.
--
-- Additiv: keine Datenänderung, keine Datenverluste; das reguläre
-- media_assets_sha256_idx (Lookup) bleibt bestehen.

-- DropIndex (globales Unique auf sha256)
DROP INDEX "media_assets_sha256_key";

-- CreateIndex (Unique je Content + Uploader)
CREATE UNIQUE INDEX "media_assets_sha256_uploadedBy_key" ON "media_assets"("sha256", "uploadedBy");
