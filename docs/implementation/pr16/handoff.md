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
