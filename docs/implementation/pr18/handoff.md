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

## Siebter Teil — Content-Medien / geschützte Auslieferung

c125c13: CI grün,22/23 Browserfälle grün (Run40221081025). Der neue C3
scheiterte auch im Retry am exakten Namen eines bereits gefüllten Textareas.
Artefakte tatsächlich geladen (/tmp/quiz-batch-e2e); der Trace enthält
Frage-Label plus initialen Textarea-Inhalt. Input-/Textarea-Felder haben
jetzt explizite aria-labels. Keine fachliche Assertion/Teststrecke entfernt.

Neu implementiert:
- Bild-/Audioreferenz und strukturierte Medienquelle/URL/Autor/Lizenz/eigenes
  Material/Personeneinwilligung im gemeinsamen Schema, Editor und in allen
  Import-/Exportformaten. Privater Multipart-Upload über den echten Medien-
  Endpunkt; Austausch übernimmt alte Rechte nicht still. Neue Referenz ergibt
  DRAFT; READY/Public-Review/Selection/Preflight prüfen Medium, Datei, Typ,
  Verarbeitungsstatus und Rechte. Gesperrte Assets werden nicht ausgeliefert.
- Normalisierte, revisionsgebundene ContentMediaReference mit FKs und
  Unveränderlichkeit. Eine beliebige ID in einem alten Draft ist KEINE
  Zugriffsfreigabe. Nur eigene/öffentliche Assets oder zuvor autorisiert
  referenzierte Inhalte eines lesbaren Pools dürfen neu verbunden werden.
  Fork/Copy/Import/Restore gehen durch dieselbe Referenzprüfung.
- Kontextsignierte kurzlebige URLs: Editor benötigt zusätzlich eine aktive
  berechtigte Session und aktuelle Itemrevision; Spielzugriff ist an Raum,
  Partie, konkret gepinnte Frage und aktuell geöffnete Phase gebunden.
  Kein Ausliefern künftiger Medien nur wegen ID oder gültiger Signatur.
- Beide echten Engines geben nur aktuelle Medien weiter; Reload/Resync
  erzeugt URLs aus dem persistierten Zustand. Spätere Pool-/Assetreferenz-
  Änderungen beeinflussen die aktive Partie nicht. Alle drei Rollen zeigen
  Bilder/manuell startbares Audio, mit neutralem Fehler und erneuter
  Anforderung. Keine Signed-URLs in historischen ContentUses gespeichert.
- Cleanup schützt neue Referenzen sowie alte Geo-Medien; historische
  Referenzen verhindern Asset-Löschung. Bestehende WID-Original-/Composite-
  Policy bleibt erhalten. Auch alte host-Signaturen verlangen jetzt einen
  nicht deaktivierten Account.
- Additive echte Bestandsmigration: unangetastete ungenutzte Legacykopien
  erhalten fehlende Medien in NEUER DRAFT-Revision. Alte Revisionen und
  bereits bearbeitete Kopien bleiben unverändert. Fremde private Legacy-
  Asset-IDs erhalten keine automatische Freigabe. Originaltabellen bleiben.
- C1 ergänzt echten Upload/Rechte/Vorschau für beide Spiele. C3 bleibt aktiv.

Nachweise: vollständige lokale Server-Suite463/463 (54 Dateien), Web112/112
(20 Dateien), gezielte Media-/Content-/Migrationstests; beide Builds,
Typecheck und Lint0 Fehler/113 bestehende Warnungen sind grün. Nach den
letzten Delivery-/Preview-/Session-Korrekturen53/53 gezielte Tests plus
28/28 finale Content-Tests und112/112 Webtests grün. GitHub CI/E2E am
folgenden Head noch offen.

Kein pauschaler Abschluss des Content-/Media-Cores: der vorhandene Audio-
Uploader prüft bisher Header, nicht vollständig Decoder/Normalisierung.
Erweiterte Legacy-Optionsfelder bleiben ggf. sichtbar als invalider DRAFT
und werden nicht still gestrichen. Keine historischen Ergebnisse bekommen
nachträglich private Medien freigegeben. Erweiterte Assets/Übersetzungen/
Statistik/Retention gehören weiterhin zu ihren vorgesehenen Cores.
Offen in Punkt4: BLIND_HOST, Progression/Presets/Templates, Playtest,
Review-Assignments/Batch-Review sowie weitere verbindliche §6-Details.
Punkt5 (Voice/Kamera/Display/Audio-Systeme) bleibt unbegonnen; kein Merge.

## Achter Teil — Vorlagen / Prüfaufgaben / Review-Warteschlange

cdadb97: vollständige GitHub-CI und23/23 E2E grün, Run40222792665.

Neu umgesetzt:
- SYSTEM-Quickvorlagen plus persistierte private Host-Fragenvorlagen für
  Wissensduell/Jeopardy. Jede Verwendung erzeugt eine neue DRAFT-Identität;
  Receipts, Pool-/Vorlagenrevision und aktueller Zugriff werden geprüft.
  Archivierung verändert erzeugte Fragen nicht. Konkrete Mediendateien
  werden bei Vorlagen bewusst nach UI-Bestätigung ausgelassen, während
  Medienoptionen erhalten bleiben. Server verbietet stille Asset-ID-Kopien
  in der Vorlage. Upload setzt Rechte weiterhin ausdrücklich neu.
- Owner/Admin weist aktuellen Editor-Prüfauftrag mit fester Itemrevision
  zu. OPEN → IN_REVIEW → DONE, Aufgabe und Content unabhängig. Bei neuer
  Contentrevision/Poolwechsel ist explizite Neuzuweisung erforderlich.
  Session/Grant/Assignment-CAS, Inbox und Audit sind integriert. Abschluss
  veröffentlicht weder privat noch öffentlich und verändert keine Frage.
- Einzeln bedienbare Review-Warteschlange mit Original/Vorschlag, Grund,
  Skip/Next, Fortschritt, kontogebundenem Wiederaufnahmecursor und A/R/S/N.
  Tastaturbefehle greifen nicht beim Tippen; fehlende Entscheiderrechte
  werden auch per Tastatur nicht übergangen. PUBLIC final weiter ADMIN.
- Zugriffslücken geschlossen: fremde PUBLIC-Leser erhalten keine internen
  Reviews/ungeprüften Vorschläge oder alten privaten Draftrevisionen.
  Mutation-Receipt-Replay prüft interne Kommentare/Tasks/Reviews sowie
  historische Itemversionen nach geändertem Scope/Grant erneut.
- Interne Leserechte/Review-Zuweisung getrennt von Editierbarkeit: Kommentare,
  Historie und Aufgaben bleiben für Berechtigte bei Review-Sperre verfügbar,
  ohne dadurch die Inhaltssperre aufzuheben.
- C4 ergänzt echte Template-Erstellung/Verwendung, getrennten Aufgabenabschluss
  und Review-Queue-Entscheidung über Tastatur. Alle24 Browserfälle aktiv.

Nachweise:467/467 Server (54 Dateien),116/116 Web (21 Dateien), beide Builds
und Typecheck grün, Lint0 Fehler/113 bestehende Warnungen. Content32/32 mit
beiden Template-Schemas, neuen DRAFT-IDs/Receipts, Eigentums-/Revisionsgrenzen,
Aufgaben ohne Publishing und PUBLIC-Privacy/Replay-Gegenproben. Exakte
GitHub-CI/E2E am folgenden Head noch offen.

Punkt4 bleibt in Arbeit. Nächste Lücken: echtes Playtest, Auswahl-/Difficulty-
Progression, Spiel-Presets/Room-Templates und BLIND_HOST über alle Lese- und
Recovery-Pfade; außerdem weitere Master-§6-Detailabnahmen. Vorhandene Audio-
Headerprüfung ist weiterhin kein vollständiger Decoder/Normalizer. Punkt5
noch nicht begonnen. Kein Merge, Push weiterhin autorisiert.

## Neunter Teil — Testisolation und verspätete Präsenzantworten

787a92f: CI im zweiten Versuch grün; E2E23/24, C3 scheiterte am
Anwesenheitshinweis. C4 (Vorlagen/Aufgaben/Review) bestanden. Der erste
CI-Versuch hatte zwei Datenbank-/Socket-Timeouts in der älteren P14-Suite.

- P14 erhält eine eigene frisch migrierte und gesäte Testdatenbank. Die
  echten Datenbank-/Socket-Rennen und alle23 bestehenden Assertions bleiben.
  Beim Abbau werden Spieltimer gestoppt und Disconnect-Identitäten abgewartet.
- Eine verspätete room:probe-Antwort schreibt nach Disconnect oder Wechsel
  von Raum/Teilnehmer nicht mehr. Drei gezielte Gegenproben decken aktive
  Identität, Disconnect und Identitätswechsel ab. DB-Identitätszaun bleibt.
- C3 wartet beim Öffnen jedes Editors auf dessen erfolgreiche
  Anwesenheitsregistrierung, bevor der nächste Tab startet. So hängt der
  Hinweis nicht vom15-Sekunden-Heartbeat bei5-Sekunden-Assertion ab.
  Keine Assertions entfernt, keine pauschalen Retries/Timeout-Erhöhungen.

Gezielt26/26 und vollständig470/470 Server-Tests (55 Dateien), beide
Builds/Typecheck und Lint0 Fehler/113 Warnungen grün. Lokal als6693b5b
gesichert. Push durch automatische Freigabeprüfung blockiert; auch nach
Wiederfinden der Nutzeranweisung zu regelmäßigen Zwischenpushes wurde die
Freigabe aus Personal Context nicht akzeptiert. Kein Push-Workaround.
Playtest ist der nächste Teil; sein lokaler Entwurf gehört noch nicht
zu diesem gesicherten Commit. Paket4 offen, Paket5 unbegonnen, kein Merge.

## Zehnter Teil — PLAYTEST aus dem Editor (§6.27)

- Gespeicherte Frage aus dem Editor als Playtest starten, auch INVALID/DRAFT.
  Eigener Zustand mit gepinnten ausgewählten Revisionen; unveränderliche
  Snapshot-/Owner-/Pool-/Code-Identität per SQL-Trigger. Keine normalen Räume,
  Teilnahmen, ContentUses, ScoreEvents, Runden-/Spielergebnisse oder Eventpunkte.
- Eine Stunde gültiger kryptographischer Testcode für andere Geräte. Player,
  Viewer und Team als Gast; HOST und Steuerung nur für den Ersteller mit
  aktuell gültiger Hostsession. Accountdeaktivierung oder Verlust des
  Poolzugriffs widerruft auch den Gastcode und seine Medien. Beenden und
  Ablauf sperren Gast-/Medienzugriff. Kein Zugang zu anderen Poolfragen.
- Host/Player/Viewer/Team haben explizite Projektionen. Lösungen nur HOST
  oder nach gemeinsamer Auflösung. INVALID-DRAFT-Optionen werden ebenfalls
  über Feld-Allowlist projiziert. Ein Perspektivwechsel entfernt Hostdaten
  sofort und ignoriert alte Antworten. Keine Raum-/Socket-Aktivierung.
- Zeitgrenze, revisionsgebundene Reveal/Next/Close-Steuerung, eine Testantwort
  pro Client/Frage, identischer Retry ohne Duplikat und Wiederaufnahme nach
  Reload. Quizoptionen servervalidiert; Viewer/Team können nichts abgeben.
  Jeopardy hat eine freie Testantwort; dieser Fragenplaytest simuliert keinen
  vollständigen Multiplayer-Buzzer-/Steal-/Judge-Ablauf.
- Validierungswarnungen plus explizite Fehlermeldungen aus Testgeräten.
  Gesammelte Meldungen nur in der HOST-Ansicht. Fehler beim Senden erhalten
  den Text. Testdaten ändern oder veröffentlichen die Ausgangsfrage nicht.
- Medienkontext an Code/aktuelle Frage/Revision gebunden. Signierte spätere
  Fragen bleiben gesperrt; alte Links verlieren beim Weitergehen Zugriff.
  Echte HTTP-Tests decken Assetswap, Ablauf, Close und Zugriffsentzug ab.
- C5 bildet Editorstart, echtes zweites Gastgerät, Rollenwechsel, Testantwort,
  Reload, Meldung, Auflösung und Close ab. Insgesamt25 Browserfälle gelistet.
  Browserausführung am neuen Stand noch offen: lokal kein Chromium vorhanden,
  GitHub-Push derzeit blockiert. Kein behauptetes Browser-Grün.

Nachweise: sechs neue echte HTTP-/DB-Fälle für beide Spiele und vier neue
Webfälle; vollständige Server-Suite476/476 (56 Dateien), Websuite120/120
(22 Dateien), beide Builds und Typecheck grün. Lint0 Fehler/113 bestehende
Warnungen. C5 ist gelistet, jedoch noch nicht im Browser ausgeführt.

Paket4 ist weiterhin offen: Auswahl-/Difficulty-Progression, Spiel-Presets /
Room-Templates und BLIND_HOST durch alle Lese-/Recovery-/Info-Pfade sowie
weitere Master-§6-Detailabnahmen. Audio-Headerprüfung ist kein vollständiger
Decoder/Normalizer. Paket5 bleibt unbegonnen. Kein Merge.

## Elfter Teil — Difficulty-Verläufe und private Schwierigkeitsvorlagen

Vorheriger Stand5ac3566 vollständig auf GitHub grün:476 Server-/120 Web- und
25 Browserfälle ohne Retry (Run40226692379). Push-Sperre des vorherigen
Handoffs durch ausdrückliche Nutzerfreigabe aufgehoben; Dateibäume identisch.

Neu: genaue Prozentverteilungen, lückenlose Rundenbereiche, Steigend-Preset,
SYSTEM Locker/Normal/Steigend/Hardcore und persistierte private Host-Vorlagen.
UI zeigt tatsächliche gerundete Counts und validiert Änderungen der Fragenzahl.
Bei festen Pool-Anzahlen gilt deren Summe. Einzel-Difficulty und MANUAL können
nicht still mit Verläufen kombiniert werden. Eigene Vorlagen archivieren
verändert weder aktuelle Auswahl noch gespeicherte Partien.

Server erfüllt Difficulty-/Pool-Quoten gemeinsam statt mit einem Greedy-Pick;
PREFER_UNSEEN minimiert benötigte bereits verwendete Fragen global. Fehlende
READY-Inhalte/unklassifizierte Difficulty führen zu atomarem Abbruch ohne
schwierigkeitsfremden Fallback. Snapshot und echte Engine-Reihenfolge bleiben
auch nach Editoränderungen gleich. Jeopardy erlaubt Verteilungen, aber keine
vorgebliche lineare Rundenfolge über sein frei wählbares Board.

Gezielt38/38 Servertests und123/123 Webtests (23 Dateien) grün. C6 bildet
Validierung, private Vorlage und tatsächliche Raumerstellung im Browser ab;
26 Browserfälle aktiv. Vollständige Server-Suite482/482 (57 Dateien),
123/123 Webtests, beide Builds und Typecheck grün. Lint0 Fehler/113
bestehende Warnungen. Exakte GitHub-Prüfung am nächsten Head noch offen.

Paket4 bleibt offen: vollständige Spiel-Presets/Room-Templates/Quick Setup,
BLIND_HOST über alle Lese-/Recovery-/Info-Pfade sowie restliche Master-§6-
Detailabnahmen. Adaptive Difficulty ist laut Master später vorgesehen.
Vollständige Audio-Decodierung/Normalisierung bleibt offen; Paket5 unbegonnen.
Kein Merge. Nächster Schritt nach diesem Checkpoint: Spiel-/Room-Vorlagen.


4a5958c: GitHub-CI vollständig grün (482 Server/123 Web), Browser24/26.
C1 hat einen mehrdeutigen alten Textselektor (Textarea plus Vorschau) gezeigt;
C6 einen impliziten Select-Labelnamen, der Optionstexte enthält. Vorschau-
Assertion auf die tatsächliche Vorschau begrenzt und Select explizit
beschriftet. Keine Tests/Assertions entfernt, keine Timeouts/Retry erhöht.
Neuer Browserlauf nach dem Korrekturcommit erforderlich.
