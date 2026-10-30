# G1 — Handoff

- Basis main `75013448`; Feature-Branch `feature/g1-command-contract` direkt darauf.
- [PR22](https://github.com/joern211/quiz-platform/pull/22) ist der unabhängige
  Umsetzungs-PR. Planungs-PR21 wird dafür nicht vorausgesetzt. Kein Merge durch Codex.
- [Matrix](matrix.md) erfasst alle 27 registrierten Spielmutationen, sieben
  Lesewege, die revisionsbasierte Konfigurationsänderung und die relevanten
  Spiel-/Roster-/Credential-Anschlüsse von `room:command`.
- Behoben: fehlende Lifecycle-Laufzeitvalidierung; wegparsen/überschreiben expliziter
  Raumcodes; fehlende aktuelle Teilnahme-/Sitzungsprüfung vor Lifecycle/Replay/
  Resync; fehlende gemeinsame Pause-/Resume-Phasengrenze; abweichende Geo-/Raum-/
  Lobby-UI-Freigaben. Vorhandene Transaktions-/CAS-/Eventpfade bleiben erhalten.
- Zwischenstand 1 `35b09f7`: 17 neue Tests und Typecheck erfolgreich; Remote-Draft.
  Seine CI fand drei fehlgeschlagene Prüfungen wegen bisher ungültiger Test-Raumcodes
  (`E4...` und siebenstellige Restart-Codes). Fixtures auf echte NNN-NNN-Codes
  korrigiert, Assertions und reale Restart-Szenarien bleiben erhalten.
- Umsetzung abgeschlossen: 37 neue Servertests (davon 28 echte Socket-/DB-Fälle,
  darunter 40 Raumscope-Ablehnungen) und neun neue UI-Regressionen. Alte Receipt-
  Fingerprints bleiben kompatibel; fremder Scope wird trotzdem vor Replay abgewiesen.
  Raum-Abbruch und private Credential-Replays prüfen aktuelle Autorität.
- Lokale Abnahme: Typecheck, Lint (0 Fehler, bestehende Warnungen), Server-/Web-Build,
  neue Regressionen und betroffene Verbraucherprüfungen. Der verbindliche letzte
  CI-/E2E-Stand und die freigegebene Head-SHA stehen an PR22. Ein älterer grüner
  Lauf ist keine Abnahme für einen späteren Code-Head.
- Neue Tests verwenden eine eigene temporäre DB und räumen nur eigene Daten ab.
  Die künstliche Receipt-Verzögerung dient dem realen Rechteentzug zwischen
  Eingangsprüfung und neuer Ausführung, nicht einem simulierten zweiten Spiel.
- G2 (Zeit/Zug/Buzzer/Rundenfluss) erst nach G1-Abnahme angehen. Aktionsbezogene
  Socket-Limits sind als begründete G4-Arbeit erfasst. Keine weiteren Spiele oder
  pauschale Behauptung, alle zukünftigen Mechaniken seien fertig.
