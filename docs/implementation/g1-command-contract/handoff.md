# G1 — Handoff

- Basis main `75013448`; Feature-Branch `feature/g1-command-contract` direkt darauf.
- [PR22](https://github.com/joern211/quiz-platform/pull/22) ist der unabhängige
  Umsetzungs-PR. Planungs-PR21 wird dafür nicht vorausgesetzt. Kein Merge durch Codex.
- [Matrix](matrix.md) erfasst alle 27 registrierten Spielmutationen, sieben
  Lesewege sowie die revisionsbasierte Konfigurationsänderung.
- Behoben: fehlende Lifecycle-Laufzeitvalidierung; wegparsen/überschreiben expliziter
  Raumcodes; fehlende aktuelle Teilnahme-/Sitzungsprüfung vor Lifecycle/Replay/
  Resync; fehlende gemeinsame Pause-/Resume-Phasengrenze; abweichende Geo-/Raum-/
  Lobby-UI-Freigaben. Vorhandene Transaktions-/CAS-/Eventpfade bleiben erhalten.
- Zwischenstand 1 `35b09f7`: 17 neue Tests und Typecheck erfolgreich; Remote-Draft.
  Seine CI fand drei fehlgeschlagene Prüfungen wegen bisher ungültiger Test-Raumcodes
  (`E4...` und siebenstellige Restart-Codes). Fixtures auf echte NNN-NNN-Codes
  korrigiert, Assertions und reale Restart-Szenarien bleiben erhalten.
- Aktueller Arbeitsstand: erweiterte Socket- und UI-Regressionen lokal erfolgreich;
  abschließende Typecheck/Lint/Build sowie CI/E2E des neuen Code-Heads noch in Arbeit.
- Neue Tests verwenden eine eigene temporäre DB und räumen nur eigene Daten ab.
  Die künstliche Receipt-Verzögerung dient dem realen Rechteentzug zwischen
  Eingangsprüfung und neuer Ausführung, nicht einem simulierten zweiten Spiel.
- G2 (Zeit/Zug/Buzzer/Rundenfluss) erst nach G1-Abnahme angehen. Aktionsbezogene
  Socket-Limits sind als begründete G4-Arbeit erfasst. Keine weiteren Spiele oder
  pauschale Behauptung, alle zukünftigen Mechaniken seien fertig.
