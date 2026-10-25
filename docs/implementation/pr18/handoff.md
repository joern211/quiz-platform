# Punkt 4 — Content / Editor — 25.10.2026

Basis 7316415 (PR17, vollständige CI/E2E grün). Gestapelte Folgebranch
feature/pr18-content-editor. Autorisierter Fünf-Schritte-Auftrag; kein Merge.
Projekt-SKILL.md gelesen: beide Builds vor jedem Commit, API-Envelope,
ESM-Extensions, bestehende Spiele und Secrets beachten. Master-Regelwerk
28.09.2026 vollständig erneut gelesen (lokal via pandoc /tmp/quiz-master.txt).

## Erster implementierter Teil (noch kein Abschluss von Punkt 4)

- Additive ContentPool/Item/Revision/Tag/Use/Receipt-Tabellen; explizite
  Bestandsmigration für QuestionPack/GeoQuestion mit stabilen IDs. Neue
  Legacy-Kopien sind DRAFT und erfordern Revalidierung; alte Engine-Pfade
  werden nicht umgedeutet. Nicht zuordenbare Legacy-Pools bleiben PRIVATE,
  Owner null, nur ADMIN kann sie verwalten. Keine automatische Veröffentlichung.
- PRIVATE/SHARED mit expliziten Editoren; PUBLIC/SYSTEM für Hosts nicht
  direkt editierbar, Fork nach PRIVATE mit neuen DRAFT-IDs. Aktive Session
  und nicht deaktivierter Account für jede Anfrage; Schreibvorgänge,
  Revision, Audit und Idempotenz-Receipt in derselben Transaktion.
- Gemeinsame game-spezifische Content-Schemas für Wissensduell + Jeopardy,
  Defaults/Inheritance, Ready-Gate, Archivierung statt Trash bei Nutzung,
  Versionshistorie, Restore als neue Revision, Duplicate, secretfreie
  Player/Viewer/Team-Preview. Immutable DB-Trigger für Revisionen und Uses.
- Echter Editor /inhalte, Quick/Advanced, Autosave nach 800ms, lokale Texte
  bei Konflikten erhalten, Save-in-flight überschreibt keine neueren Eingaben,
  explizites READY, Vorschau/Versionen, Poolauswahl in beiden Setup-Seiten.
- Raum-Erstellung materialisiert nur berechtigte READY-Inhalte in der
  Schreibtransaktion. Wissensduell liest echte gespeicherte ContentUses,
  Jeopardy das materialisierte Board; nachträgliche Pooländerungen verändern
  die Partie nicht. Rematch/Spielwechsel kopiert aktuell die gepinnte Auswahl.

## Nachweise / offen vor Abschluss

Gezielte HTTP-/DB-/Socket-Suite: 8/8. Echte game:start- und Jeopardy field-open
Consumer belegen beide Engines. Webtests 99/99 inkl. 5 Editorregressionen.
Voller Serverlauf 439/439, Web99/99, Typecheck und beide Builds grün;
Lint 0 Fehler / 113 bestehende Warnungen. Der volle Lauf fand zunächst
einen echten Produktionsstartfehler durch .js-Reexport aus dem direkt von
Node geladenen Shared-TS-Einstieg. Neue Schemas sind deshalb wie die
bisherigen Contracts im Shared-Einstieg enthalten; der echte Produktions-
und Rate-Limit-Test besteht wieder. C1-Browserfall ergänzt; exakte
GitHub-CI/E2E noch offen. Keine Pflichtfälle entfernt.

Punkt 4 ist groß und NICHT fertig: Repeat-Regeln für folgende Partien,
BLIND_HOST (aktuell ausdrücklich nicht auswählbar), feste Anzahl pro Pool,
Progression/Presets/Templates, Tags-/Sharing-/Pooldefaults-UI, Concurrent-
Editor-Anzeige, Review/Public-Workflow, Inbox/Corrections/Locks/Quality,
CSV/XLSX/JSON-Import/Export mit Preview/Entscheidungen, Playtest und weitere
Master-§6-Funktionen noch vervollständigen. Source/License/Media-Refs sowie
Legacy-Daten und Restart/Rematch gezielt weiter abnehmen. Punkt 5 unbegonnen.

## Wiederaufnahme / Tools

Repo /workspace/scratch/74c8834207ac/quiz-platform, sauberer Ausgangsstand
7316415. pnpm9.12 via /tmp/quiz-tools/pnpm (corepack); PATH entsprechend setzen.
Server-Suiten niemals parallel gegen /tmp/quiz-server-test.db ausführen.
Lokal keine Browser installiert; Browserabnahme via GitHub Actions.
GitHub-Push ist autorisiert, kein erneutes Nachfragen. GitHub-API-Objekte
verwenden, Datei-Baum-SHA vergleichen, Ref nur Fast-Forward mit expected_sha.
Aktuelle Prüf-Logs unter /tmp/quiz-content-*.log.

## Zweiter gesicherter Teil — Import / Review / Repeat

Erster Remote-Stand e43afd9 mit Run 40198146513: komplette CI grün,
Browserabnahme nicht grün. C1 fand einen echten Auth-Envelope-Fehler:
authApi.me war flach typisiert, Server liefert data.user. Dadurch blieb
Pool-Erstellung deaktiviert. Typ und Consumer korrigiert; neuer Webtest
verifiziert das echte verschachtelte Envelope. T1 war im ersten Versuch
nach Rematch ohne Panel, im Retry grün; bleibt weiter Pflichtfall.
Traces/Error-Contexts tatsächlich aus GitHub geladen und gelesen
(/tmp/quiz-pr18-e2e). Kein Test entfernt oder fachlich abgeschwächt.

Neu umgesetzt:
- JSON/CSV/XLSX-Export und -Import mit serverseitig persistierter Vorschau,
  5MB/500-Zeilen-Grenzen, XLSX-Expansion-Grenze, keine Formeln/komplexen
  Zellen, CSV-Formelschutz. Preview NEW/EXACT/SIMILAR/CONFLICT/INVALID,
  Vorschlag/Originalvergleich, explizite Skip/Import/Update/DRAFT-Entscheide,
  Tag create/map/ignore (UI derzeit create/ignore), Preview-/Revisionsfence,
  Wiederholungsschutz, keine stille READY-Freigabe. Exporte ohne Sessions/
  Tokens/Storage-Pfade. ExcelJS4.4 Dokument-Workbook direkt geladen (keine
  unnötigen Streaming-Reader-Abhängigkeiten im VM/Produktionspfad).
- Public-Pool-Einreichung mit Quellen-/Lizenz-/READY-Gate, Poolsperre,
  finaler ADMIN-Entscheidung. Gameplay-Änderung als persistierter Vorschlag,
  alte veröffentlichte Fassung bleibt bis Freigabe nutzbar. Metadaten-PATCH
  durch Owner ohne Gameplayänderung, ansonsten konservativ Admin-Reapproval.
  Historische Revisionen bleiben unverändert.
- Inbox/Review-UI, interne Kommentar- und Lock-Endpunkte sowie konkrete
  Quality-Counts/Gründe ohne erfundenen 0–100-Score. Öffentliche Drafts
  sind für fremde Hosts auch bei Direktzugriff/Export verborgen.
- NO_REPEAT_IN_ROOM nutzt echte ContentUse-Historie bei Rematch;
  PREFER_UNSEEN priorisiert ungesehene Fragen; ALLOW_REPEATS darf die
  Historie wiederverwenden. Erschöpfung rollt Rematch vollständig zurück.
  Socket meldet dafür fachlichen Content-Fehler, kein unbekanntes Outcome.

Nachweise am lokalen Folgestand: 445/445 Servertests (52 Dateien),
103/103 Webtests (16 Dateien), Typecheck und beide Builds grün, Lint
0 Fehler / 113 bestehende Warnungen. Content-Suite 14 echte Fälle inkl.
XLSX-Roundtrip/Formelablehnung, Import-Stale/Dedup/Tags, Admin-Reapproval,
Originalhistorie und echter Socket-Rematch. Cleanup wartet auf echte
Disconnect-Handler. C1 bleibt aktiv; C2 ergänzt Browser-Import bis zur
ADMIN-Freigabe. Ganze CI/E2E am neuen Remote-Head noch offen.

Weiter offen in Punkt4: BLIND_HOST, feste Counts/Filter je Pool,
Progression/Presets/weitere Templates, Tags-/Sharing-/Pooldefaults-UI,
Concurrent-Editor-Anzeige, vollständige Korrektur-/Reviewzuweisungs-/Bulk-/
Playtest-Funktionen und weitere Master-§6-Details. Medienreferenzen und
Legacy-Migration auf vollständigen Erhalt weiter prüfen. Kein Abschluss
von Punkt4; Punkt5 noch nicht begonnen.
