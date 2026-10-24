# GAME-CORE — Handoff

Roadmap-Planplatz PR15; Folgebranch feature/pr16-game-core auf PR15 f26e8fb.
Punkt 1 des Nutzerplans ist abgeschlossen: CI + 20/20 E2E am exakten Head
f26e8fb, Run 40104459714. Kein Merge. Dieser Branch setzt Punkt 2 um und
bleibt Draft, bis der vollständige Paketumfang nachgewiesen ist.

## Aktueller Teilumfang

- Gemeinsame Timer-/Submission-/Judge-Schemas und Primitiven.
- Wissensduell speichert tatsächliche Abgaben/Bewertungen; Countdown,
  Deadline, Pause/Resume nutzen dieselben Primitiven. Eingaben in Pause oder
  außerhalb INPUT_OPEN sind ausdrücklich gesperrt.
- Jeopardy nutzt dieselben Abgabe-/Bewertungsregeln für verbale
  Buzzerantworten. Kein Antworttext wird erfunden; value=null bedeutet
  verbale Bewertung. Zeitlimit bleibt gemäß bestehendem Verhalten unbegrenzt.
- Neue Rundendaten sind additive Felder. Expliziter Legacy-Timer-Reader;
  alte manuell bewertete Antworten bekommen keine erfundenen Zeitstempel.
- Pause/Resume stellt Gameplay exakt wieder her und nimmt die Uhr mit
  neuem Serverzeitpunkt wieder auf. Bestehender Test prüft beides getrennt.
- CI akzeptiert Feature-Basen für gestapelte PRs.

## Nicht abgeschlossen

Vollständiger Engine-Vertrag, Invariants, Rundenübergänge und weitere
Master-Cores sind noch offen. Die neue gemeinsame Metadaten-Projektion
ersetzt noch nicht alle inhaltlichen Engine-Projektionen.
Dieser Teilumfang allein ist **kein** vollständiger GAME-CORE-DoD-Nachweis.
Results/Finalisierung folgen anschließend in Punkt 3 des Nutzerplans.

## Nächster Schritt

Lokale Abnahme dieses Zwischenstands: **392/392 Server-Tests (42 Dateien)**,
**83/83 Webtests**, Typecheck und beide Builds grün; Lint 0 Fehler / 115
Warnungen. Zwei neue echte Socket-/DB-Fälle belegen dieselben Primitiven in
Wissensduell und Jeopardy inkl. Pause, Rejoin und Bewertungs-Replay; vier
Primitive-Tests prüfen Deadline, Serialisierung, lange Pause, Count-up,
unbegrenzte Zeit, doppelte Abgabe und manuelle/partielle Bewertung.

Zwischenstand pushen und GitHub-CI/E2E prüfen. Danach gemeinsame Aktionsregeln und
Projektionen an beide Engines anbinden. Keine Pflicht-Tests überspringen.

## Zweiter Teil — Aktionsregeln und öffentliche Runtime-Projektion

Eine gemeinsame Prüfung liefert verfügbare Aktionen und prüft tatsächliche
Engine-Mutationen. Sie wird innerhalb der Receipt-Mutation angewendet, damit
bereits abgeschlossene Commands vor einem Phasenwechsel weiter korrekt
replayed werden. Der Engine-Slug ist eine serverseitige Handlerbindung;
fremde Spiel-Events bleiben WRONG_GAME statt irrtümlich gegen die Regeln
des aktuellen Raums geprüft zu werden. Alte spezifische Wire-Codes bleiben.

`game:core:read` liefert eine strikt validierte, secretfreie Projektion:
Raumcode/Run, Engine-Version, State-Version, Phase, Timer, Fortschritt und
erlaubte Aktionen. Wissensduell-/Jeopardy-Hostseiten richten Controls danach
aus. Der Client verwirft fremde Räume, veraltete Antworten und Antworten
nach Disconnect/Unmount. Fehlgeschlagener Refresh entfernt alte Rechte.

Gegenproben: gemeinsame Predicate-Tests; echte Zwei-Engine-Sockets inkl.
Viewer, Replay und Raumgrenzen; Hook-Tests für verspätete Snapshots und
Entzug. Vorheriger Zwischenstand 322ad86 hat grüne CI/E2E
([Run 40105496666](https://github.com/joern211/quiz-platform/actions/runs/40105496666));
die neue Änderung benötigt einen eigenen aktuellen Nachweis.

Lokale Abnahme des zweiten Teils: **395/395 Servertests (43 Dateien)**,
**85/85 Webtests (12 Dateien)**, Typecheck und beide Builds grün; Lint
0 Fehler / 115 Warnungen. Keine übersprungenen Tests. Die alten
Cross-Game-Fehlercodes wurden durch eine explizite serverseitige
Engine-Bindung erhalten. Der bestehende Recovery-Test verwendet nun auch
die reale Socket-off-Schnittstelle für das saubere Entfernen neuer Listener.

## Dritter Teil — Rundenregeln (Fortsetzung)

Gemeinsames Fisher-Yates-Shuffle mit kryptographischem Serverzufall ersetzt
zufälliges Sortieren in Wissensduell und wird auch von Teamzuweisungen genutzt.
Die konkrete Auswahl bleibt im State. Matching EXACT/NORMALIZED/SYNONYM/FUZZY/
MANUAL_ONLY liefert explizit MATCH/NO_MATCH/NEEDS_JUDGE; Fuzzy-Näherungen werden
nie automatisch gewertet. Wissensduell nutzt EXACT, Jeopardy MANUAL_ONLY.
Antwortrechte werden in Jeopardy und Wer ist das? mit dem Buzzergewinner
abgeglichen; Altstates ohne Turn werden explizit über ihren gespeicherten
Gewinner gelesen. Rundenwechsel von Wissensduell und Wer ist das? prüfen die
Grenze gemeinsam. Wissensduell und Jeopardy liefern Competition-Ränge ohne
zufällige Tie-Auflösung. Diese Änderungen sind Teilfortschritt, nicht die
vollständige Abnahme sämtlicher Turn-/Tie-/Buzzer-Funktionen.

Abnahme: 398/398 Servertests (44 Dateien), anschließend gezielte echte
Socketfälle erneut inkl. natürlichem Wissensduell-Spielende und unverändertem
Jeopardy-Antwortrecht nach Gerätewechsel. Typecheck und beide Builds grün.
Fortsetzung: vollständige Visibility-Anbindung, State-Invariants und Engine-
Vertrag. Voriger Head 4d637b7 hat grüne CI/E2E (Run 40106514606).

## Vierter Teil — Visibility und Invariants (lokal geprüft, Push blockiert)

- Ein serverseitiger Visibility-Core trennt HOST_PRIVATE, PLAYER_PRIVATE,
  TEAM_PRIVATE und PUBLIC. Administrative Rechte ersetzen keine Informationsrolle.
  Wissensduell und Wer ist das? nutzen ihn in ihren echten Projektionen;
  verweigerte Werte/Signed-URLs werden nicht einmal erzeugt. Wissensduell nutzt
  eine explizite Feldliste einschließlich öffentlicher Medien/Optionslabels.
- Gemeinsame State-Invariants prüfen Phase, Runde/Board, Scores, Timer,
  Submission-Zuordnung, Buzzergewinner und Turn. Alle drei realen Engines binden
  ihre Start-/CAS-/End-Writer daran; auch der Untimed-Pause-Adapter prüft vor
  dem Commit den wiederherzustellenden Zustand.
- Beim Start, vor Aktionen, Resync und Timerablauf werden bestehende States
  geprüft. Beschädigte bekannte States werden per CAS in ERROR_RECOVERY
  angehalten. Der Originalzustand bleibt ausschließlich serverseitig erhalten;
  es wird weder neu gewürfelt noch gewertet. Unbekannte Engine-Versionen werden
  ausdrücklich abgewiesen und nicht umgeschrieben. Die neue Runtime-Projektion
  liefert dann nur sichere Recovery-Metadaten und keine Spielaktionen. Beide
  Hostoberflächen zeigen eine dauerhafte Fehlermeldung. Reparatur, vollständige
  Wiederherstellung und Results/Finalisierung bleiben Punkt 3 vorbehalten.
- Echte Socket-/DB-Gegenproben für Wissensduell und Jeopardy belegen abgewiesene
  ungültige Writes, atomare Quarantäne, keine Punkte, keine Secrets im Viewer-
  Snapshot und unveränderte Revision bei weiteren Reads. Ein weiterer Fall
  prüft kaputtes JSON beim Lesen. Vorbestehender CONFIG_SNAPSHOT_INVALID-
  Recovery und kontrolliertes Beenden bleiben erhalten.
- Die Prozess-Recovery-Suite nimmt einen vom OS zugeteilten Port statt eines
  kleinen Zufallsbereichs. Die natürliche Intro-Transition wird nach ihrem
  tatsächlichen Zustand abgenommen; die DB-basierte Disconnect-Bereinigung
  wartet ebenfalls auf den Abschluss statt auf eine starre Zeitannahme.

### Letzte lokale Abnahme

405/405 Servertests (46 Dateien), 85/85 Webtests (12 Dateien), Typecheck,
Server-/Webbuild, Dokuchecker und git diff --check grün. Lint: 0 Fehler,
115 Warnungen. Kein Pflicht-Test übersprungen. Lokaler Chromium fehlt;
Browsertests/CI für die neuen Commits sind deshalb ausdrücklich noch offen.
Die grüne Remote-CI/E2E gilt nur für 4d637b7 (Run 40106514606).

### Wiederaufnahme / konkreter Blocker

Der Commit d98e2bc und der anschließende Visibility-/Invariant-Commit sind
lokal gesichert. Zwei normale Push-Versuche wurden von der automatischen
Freigabeprüfung abgewiesen: Sie erkannte keine ausdrückliche Nutzerfreigabe
für die Veröffentlichung auf diesem Remote/Branch. Keine Umgehung verwenden.
Im übergebenen Auftrag steht zwar „pushe immer zwischendurch“; verifiziert
wurden außerdem Remote https://github.com/joern211/quiz-platform.git,
Login/Owner joern211, public Repository und Push-Recht. Das reichte der
Freigabeprüfung nicht. Für die Fortsetzung ist deshalb die konkrete
Push-Freigabe des Nutzers einzuholen. Kein Merge und keine Ersatzpublikation.

Nach Freigabe: normalen Push von feature/pr16-game-core ausführen, PR16-
Beschreibung dem tatsächlichen Umfang anpassen, CI/E2E am neuen Head prüfen.
Danach vollständigen Engine-Vertrag, restliche Buzzer-/Turn-/Tie-Funktionen,
Reveal-Integration und Rundenübergaben vervollständigen. Punkt 2 bleibt offen;
Punkte 3–5 nicht als begonnen oder abgeschlossen darstellen.

## Fünfter Teil — gespeicherte Events und Buzzer-Zustände

Die Nutzerfreigabe vom 24.10.2026 hat den früheren Push-Blocker aufgehoben.
Die Git-Shell hat keine Anmeldung; Übertragung erfolgt über den verbundenen
GitHub-Zugang per normalem Fast-Forward mit erwartetem Remote-Head. Die Bäume
von d98e2bc/710697e sind exakt identisch zu 3b0f302/298e97f. 298e97f hat
vollständig grüne CI/E2E (Run 40115586491). Lokale Originalcommits bleiben
auf Checkpoint-Branches erhalten. Kein Merge und kein Force-Push.

- Additive Migration game_domain_events: Server-only-Events je Raum/Run/
  State-Version. DB-Trigger verbietet Updates, die Versionsfolge ist geprüft.
- Die drei tatsächlichen Engine-Writer sowie Untimed-Pause speichern Event
  und daraus materialisierten Zustand in derselben Transaktion. CAS-Konflikt
  oder Score-Fehler rollen beides zurück. Command-/Actor-IDs kommen aus dem
  serverseitigen Ausführungskontext; technische Timer erfinden keine Person.
- Der SDK-Reducer spielt gespeicherte Änderungen ohne Uhr, Zufall, Punkte-
  Mutation oder Socket-Ausgabe ab. Unveränderte Inhaltslisten werden nicht
  bei jeder Aktion dupliziert. Explizite vollständige Checkpoints unterstützen
  bestehende Spiele ohne erfundene historische Events. Fremde Räume/Runs,
  Versionssprünge und Prototype-Keys werden abgelehnt.
- Nicht erfolgreich gestartete, noch nicht akzeptierte Initialisierungen
  werden mit dem eigenen Startversuch zurückgerollt; erfolgreiche Spiel-
  Historie wird nicht umgeschrieben. Der echte migrate-deploy-Test umfasst
  die neue additive Migration und danach spielbare v1/v2-Bestandsräume.
- Jeopardy und Wer ist das? persistieren Core-Buzzer-Zustände mit Status,
  Server-Arrival-Fairness, Teilnehmerauswahl und Gewinner-Zeitpunkt. Legacy-
  Zustände ohne Zusatzfelder bleiben ausdrücklich lesbar. Das reine API
  unterstützt TEAM, Teamsperre bei falscher Antwort, Reopen/Reset und
  protokollierbare Gewinnerkorrektur. Host-Commands/Oberfläche und die
  vollständige Team-Anbindung sind noch NICHT als abgenommen zu melden.

Abnahme dieses Teils: 408/408 Server-Tests (47 Dateien), 85/85 Webtests,
Typecheck und beide Builds grün; Lint 0 Fehler / 115 Warnungen; Dokuchecker
und diff --check grün. Nach der letzten Anpassung der reinen Jeopardy-
State-Adapter wurden deren State-/Buzzer-Tests zusätzlich gezielt geprüft.
Die Produktions-Prozessprüfung ist relevant: der als TypeScript exportierte
SDK bleibt in Node-Strip-Mode lauffähig (keine Parameter-Properties und kein
nicht vorhandener relativer .js-Export).

Nächster Schritt bleibt Punkt 2: vollständiger Engine-Vertrag, Host-Overrides,
Tie-Regeln, echte Team-Anbindung, Visibility/Projektionen und Rundenübergaben.
Punkte 3–5 bleiben danach. Neue CI/E2E gelten erst nach Prüfung des neuen
Remote-Heads, nicht automatisch durch die grüne Vorläufer-CI.
