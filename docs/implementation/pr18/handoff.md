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
