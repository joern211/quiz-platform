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

Gemeinsame Aktionsregeln/NextAction, Engine-Vertrag, Projektionen,
Invariants, Rundenübergänge und weitere Master-Cores sind noch offen.
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
