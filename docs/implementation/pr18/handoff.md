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

## Dritter Teil — Pool-Einstellungen / Auth-Routenvertrag

Run 40199727713 am b44c7dc: komplette CI grün, 20 bestehende E2E grün,
C1/C2 nicht grün. Traces aus /tmp/quiz-pr18-e2e2 zeigen zusätzlich zum
Envelope den bisher ungenutzten falschen Clientpfad /auth/me. Der reale
Server hat /auth/session. Clientpfad korrigiert; Webtest prüft jetzt URL
UND Envelope, HTTP-Test bestätigt reale /auth/session-Antwort. C2 hatte
Import, DRAFT, READY und Public-Einreichung bereits komplett geschafft.
Kein Pflichtfall entfernt; T1 diesmal ohne Flake grün.

Pool-Standards/Sprache/Difficulty/Tags und explizite Shared-Editor-Verwaltung
sind jetzt auch in der UI vorhanden; nur Eigentümer/Admin darf Zugriffe
ändern. Suche liefert nur IDs/Anzeigenamen, keine E-Mail-Liste. Historische
Legacy-Account-IDs dürfen zugewiesen werden. Globale Tags können explizit
erstellt werden; Aliases verwaltet nur ADMIN, Slug-/Alias-Kollisionen werden
verweigert. Importvorschauen pinnen auch die Tagzuordnung; spätere globale
Tagänderung erfordert neue Preview. Item-Tags zeigen inherited/local und
können auf Pool-Defaults zurückgesetzt werden. Editor-Modus pro Hostkonto.
PinnedContent speichert zusätzlich die Pool-Revision.

Gezielte Content-Suite 16/16, Web103/103, beide Builds und Typecheck grün,
Lint 0 Fehler / 113 Warnungen. Voller Serverlauf zuletzt am vorherigen
Produktstand 445/445; neuer kompletter CI/E2E-Lauf nach Push noch offen.
Weitere Punkt4-Lücken wie oben bleiben bestehen; kein Paketabschluss.

## Vierter Teil — Auswahlfilter / Spieler-Korrekturen / Konfliktauflösung

Run 40200438987 am 5099662: vollständige CI grün, C2 und alle 20 bestehenden
E2E grün. C1 blieb am exakten Label-Locator Spiel hängen. Der Trace
(/tmp/quiz-pr18-e2e3) zeigt /auth/session 200, volle neue Seite und aktivierte
Pool-Erstellung. Das verschachtelte Select hat jetzt ein explizites
aria-label Spiel; der Prüfablauf selbst bleibt unverändert.

- Auswahl-UI in beiden Setups für Sprache, Difficulty, Kategorie, Tags,
  Repeat-Regeln und feste Counts je Pool. Der Server prüft exakt alle
  Pool-Keys/Counts und verfügbare READY-Inhalte; kein stilles Auffüllen.
- Gast-Korrekturen über echte Teilnehmer-ID + Rejoin-Token, Raum-/Partie-
  Bindung und explizite persistierte Public-Release-Evidenz. Keine künftigen
  Fragen aus dem gesnapshotteten Pool, keine abgebrochenen/geskippten oder
  ungeprüften Legacy-Runden. Ergebnisansicht lädt Fragen erst beim Öffnen
  des Meldeformulars. Submit ist receipted; Owner/Admin prüft anschließend.
  Ursprüngliche Snapshots/Ergebnisse bleiben unverändert. Abgelaufene/
  geschlossene Räume und fremde Tokens sind gesperrt.
- EngineRoundResultSchema akzeptiert publicContentIds additiv/optional.
  Die Evidenz wird im selben Write wie die echte Auflösung gespeichert.
  Historische Ergebnisse werden nicht nachträglich als öffentlich erfunden.
  Jeopardy speichert zusätzlich zu seinen Feldkoordinaten echte Content-IDs.
  Reale Socket-Buzz-/Judge-/Reveal- und HTTP-Tests belegen beide Consumer.
- Versionskonflikt-UI hat jetzt Compare, aktuelle Fassung übernehmen und
  bewusst eigenen Entwurf auf Basis der angezeigten aktuellen Revision
  speichern. Weitere fremde Änderungen bleiben per CAS geschützt.
- HTTP-Content-Client hält Command-IDs über ungewisse Netzwerkfehler stabil;
  erst bestätigter Erfolg beendet die Absicht. Neue absichtliche Erstellung
  danach bekommt eine neue ID. Zusätzlicher Webtest prüft das Wire-Payload.

Abnahme lokal: 449/449 Server (52 Dateien), 106/106 Web (18 Dateien), beide
Builds/Typecheck grün, Lint0 Fehler/113 bestehende Warnungen. Browserliste
enthält weiterhin alle 22 aktiven Fälle. Vollständige GitHub-CI/E2E am
folgenden Remote-Head noch ausstehend. Kein Paketabschluss behauptet.

Rest Punkt4: BLIND_HOST (nicht auswählbar, bis Informationsrechte vollständig
integriert sind), Progression/Presets/Host-Templates/Room-Templates,
Concurrent-Editor-Anzeige, Bulk/Playtest, Review-Zuweisungen/weitere UI für
Kommentare/Locks/Verwendungsnachweise und weitere Master-§6-Details.
Medienreferenzen benötigen insbesondere noch einen verlustfreien neuen
Content-Reader und Delivery-/READY-Prüfung; die Legacy-Tabellen wurden nie
verändert, aber das neue Modell ist hier noch nicht vollständig. Punkt5
(Audio/Voice/Kamera/Display) bleibt unbegonnen. Weiter regelmäßig sichern;
kein Merge. Keine Push-Rückfrage erforderlich.

## Wiederaufnahme nach Chatabbruch — fünfter Teil

f3f14e3 ist auf GitHub vollständig CI/E2E-grün (Run 40202295665).
Die lokalen Folgeänderungen sind erhalten und jetzt geprüft:
- Raum-Subscriptions teilen die bestehende Admission-Queue. Verschachtelte
  Viewer-Aufnahme bleibt möglich; abgelaufene Async-Kontexte dürfen keine
  spätere Queue umgehen. Disconnect-CAS bleibt gegenüber Geräteersatz
  unabhängig, danach Feed/Projektion serialisiert; Identität immer bereinigt.
- Der Editor liest effektive Spiel-Defaults. Public-Metadatenänderungen
  werden dadurch nicht fälschlich zu Gameplayänderungen. Lokale Poollisten
  bleiben auch bei wiederholten Antworten frei von doppelten IDs.
- Korrekturtest bindet Snapshot-Nachweis an die tatsächliche Content-ID.
- Abnahme: 453/453 Server (53 Dateien), 106/106 Web (18 Dateien), beide Builds,
  Typecheck und Lint 0 Fehler/113 bestehende Warnungen. Neue Queue-Fälle
  prüfen Reentranz, unabhängige Räume, Fehlerfreigabe und detached-Kontexte;
  bestehende echte Socket-/DB-/Rejoin-/Rematch-Gegenproben bleiben aktiv.

Nächster Teil: Sammelbearbeitung, Zusammenarbeit/Prüfwerkzeuge und danach
vollständige Medienreferenzen. Punkt4 bleibt offen; Punkt5 unbegonnen.

## Sechster Teil — Sammelaktionen / Zusammenarbeit

9a03c4f: vollständige CI und E2E grün (Run 40220311085), Dateibaum identisch
zum lokalen Wiederaufnahme-Commit 1d43145. Dieser Commit ist kein Paketabschluss.

Neu implementiert:
- Multi-Select bis100; Vorschau der Auswirkungen und historische Uses;
  ausdrückliche Bestätigung; Status/Tags/Difficulty/Move/Copy über denselben
  Revisions-/Status-/Rechtepfad wie Einzeländerungen. Ergebnis je Frage,
  Teilfehler sichtbar; technische Fehler rollen die Transaktion zurück.
  Copy erzeugt neue DRAFT-IDs, Move behält Identität/Historie; effektive
  Pool-Vererbung wird materialisiert, nicht vom Ziel still verändert.
- Concurrent-Editor-Anzeige mit Session-/Tab-gebundener DB-Presence,
  Heartbeat und45s Ablauf. Keine Schreibsperre; CAS bleibt autoritativ.
  Keine Session-IDs/Tokens im Response; deaktivierte/revokierte Accounts
  und entzogene Shared-Grants werden aus der Anzeige entfernt.
- Interne Kommentare, Erledigt/Ablehnen/Wiederöffnen, manuelle Locks und
  Verwendungsnachweise jetzt in der Oberfläche. Fremde PUBLIC-Pool-Leser
  erhalten keine internen Kommentare/Presence/Raumverwendung. Bestehende
  reine GET-Lücke für öffentliche interne Kommentare geschlossen.
- Content-Schreibtransaktionen nehmen die SQLite-Writerreservation VOR
  dem Autorisierungs-Readset. Zwei echte parallele Editorwrites ergeben
  genau einen Erfolg und einen REVISION_CONFLICT statt Read-Upgrade-Deadlock.
- Receipt-Replay prüft auch Pools eingebetteter Review-/Batch-Items neu.
- Browserfall C3: zwei Tabs, Presence, Autosave-Konflikt ohne Textverlust,
  bewusste Konfliktauflösung, Kommentar und bestätigte Sammelarchivierung.
  Alle23 Browserfälle bleiben aktiv. GitHub-Abnahme am neuen Head noch offen.

Lokal: 459/459 Server (53 Dateien),109/109 Web (19 Dateien). Beide Builds,
Typecheck und Lint0 Fehler/113 bestehende Warnungen sind ebenfalls grün.
Content-Suite am endgültigen Produktstand25/25 inkl. simultaner HTTP-Writes.
Offene Punkt4-Bereiche weiterhin u.a. Medien-Reader/Refs/READY/Delivery,
BLIND_HOST, Templates/Presets/Progression, Playtest, Review-Assignments und
Batch-Review. Punkt5 bleibt unbegonnen; kein Merge.
