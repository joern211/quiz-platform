# PR11: Wer ist das — Composite und geschützte Medienkette (BETA)

Zwei Originalbilder werden zu einem deterministischen Fusion-Spielbild. Vor Reveal erhalten Spieler und Viewer nur das freigegebene Spielbild; Namen und Originale bleiben geschützt. Setup v2 ergänzt die Asset-Referenzen; v1-Räume und gespeicherte Engine-Versionen bleiben kompatibel. Der PR bleibt Draft und BETA; kein Merge oder Wechsel zu AVAILABLE.

## Änderungen

- Host-gebundene Uploads mit Content-/Größenvalidierung, WebP-Normalisierung und Metadatenbereinigung; kurzlebige HMAC-URLs mit Audience-/Session-/Eigentumsprüfung. Private Medien erhalten keinen öffentlichen Kontext durch Byte-Dedupe.
- Logische Identität über `assetKey` und Unique-Key `[assetKey, uploadedBy, visibility]`; gemeinsame Byte-Dateien über Ausgabe-SHA256. Unterschiedliche Quellpaare erhalten getrennte Provenienz, A/B-Reihenfolge bleibt relevant. `roundId` beeinflusst keinen Dateipfad.
- Composite-Insert, Dateiveröffentlichung und Replay unter SQLite-Writer-Lock: Insert zuerst, vollständige Datei danach, Commit zuletzt. Fehlgeschlagene Inserts löschen niemals gemeinsame finale Blobs. Bestehende gültige Bytes werden nicht überschrieben; fehlende/beschädigte Dateien kontrolliert repariert.
- Startup-GC prüft Snapshot, Alter, Binding und Referenzen unter derselben Sperre. Zeilenlöschung wird vor Dateilöschung committet; danach werden neue Verweise unter erneuter Sperre geprüft. Count-Fehler vor Zeilenlöschung erhalten Datei und Zeile. Rollback und zwischenzeitlicher Publisher sind durch Gegenproben abgedeckt.
- Raum + Host-Teilnahme atomar; explizites Token pro Erstellungsabsicht in allen Web-Setup-Seiten, einschließlich tatsächlich gerouteter ModeratorSetupPage. Gleiches Token liefert denselben Raum, anderes Token eine eigene Identität. Tokenloser Fallback verwendet eine feste Uhrminute, kein gleitendes 60-s-Fenster.
- Upload-Reparatur erhält neue Dateien bei degradiertem Referenzcheck und meldet `MEDIA_ASSET_REPAIR_DEGRADED`; FAILED-Markierung ist bei zusätzlichem DB-Ausfall best effort.
- Setup-Vorschau nutzt Host-Audience mit Eigentümer-Session schon vor Raumerstellung. Player-Projektionen/Resync geben keine Originale/Namen vor Reveal frei; v1/v2-Recovery mit Rejoin vorhanden. Ersteller-Konto ist vom Mitspielen eigener WID-Runden ausgeschlossen.
- Bestehende additive Migrationen erhalten Legacy-Composites ohne erfundene Provenienz. Diese Nacharbeit ändert kein Schema.

## Validierung

Lokal: **283 Server-Tests / 29 Dateien**, darunter **27 Audit-Gegenproben + 9 Medien-Lebenszyklus-Tests**; **52 Web-Tests**; Typecheck aller 5 Pakete; Lint ohne Fehler; Build. Server-Testskript mit Migration + Seed verwendet.

Gezielte Gegenproben: parallele Quellpaare mit identischen Ausgabe-Bytes; fehlgeschlagener Insert; alter tatsächlicher Null-Referenz-Snapshot gefolgt von erfolgreichem Publisher; Referenzabfragefehler; Rollback der GC-Zeilenlöschung; neue Referenz zwischen GC-Transaktionen. Echte Raumrequests bei 59.950/59.990/60.010 s und expliziter Token-Retry über die Minutengrenze.

Lokaler Chromium-Download lieferte ein ungültiges Archiv; neue E2E-Ergebnisse werden deshalb anhand des GitHub-Laufs am veröffentlichten Head belegt. Frühere lokale Ergebnisse werden nicht als neue Ausführung ausgegeben.

## Grenzen

- SQLite und Dateisystem haben keinen gemeinsamen Crash-Commit. Ein Commit-/Prozessfehler nach Veröffentlichung oder ein Fehler der Datei-Cleanup-Phase kann eine reine Datei ohne Zeile erhalten. Allgemeiner Storage-GC ist ein Folgeauftrag; Startup-GC bearbeitet nur alte tmp-DB-Zeilen.
- Tokenlose identische neue Absichten innerhalb derselben Uhrminute werden zusammengeführt; Retry über die Minutengrenze kann einen neuen Raum erzeugen. Für allgemeine Idempotenz ist das explizite Token erforderlich.
- ROOM_TEMP-GC läuft beim Serverstart mit 24-h-Schwelle. Automatische Weiterführung aller laufenden Räume und allgemeiner PRIVATE-GC sind separate Aufgaben.
- Die Kontosperre erkennt keine anonyme Zweitidentität; einfacher Crossfade bleibt BETA, echtes Morphing ist später.

Handoff: `docs/implementation/pr11-handoff.md`; Verhalten: `docs/wer-ist-das.md`.
