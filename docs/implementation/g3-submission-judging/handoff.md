# G3 — Handoff

Basis: main `3d28d6f7ff039d8af010941cdcbf8572e1044809` (enthält G1, G2/PR23 und
PR24). Arbeitsbranch `claude/gallant-carson-l71ezz` (Schema der Umgebung; Vorschlag
des Auftrags war `feature/g3-submission-judging`), PR
[joern211/quiz-platform#25](https://github.com/joern211/quiz-platform/pull/25) gegen
`main`. Keine gestapelte Feature-Kette, PR21 nicht eingemischt. Voller Umfang und
Nachweise: [Matrix](matrix.md).

## Stand

- Erste Abnahme (Head `1d6b470`): CI und E2E grün. Ein unabhängiger Prüfbericht
  fand danach vier Fehlerbereiche (R1–R4), die diese Abnahme nicht abdeckte.
- Nachbesserung (siehe Matrix, „Befunde und Behebung“):
  - **R1** private Empfänger je Auslieferung gegen aktuelle Sitzung/Gerät/Teilnahme.
  - **R2** Urteile an den konkreten Antwortversuch (`attemptId`) gebunden.
  - **R3** `geo:answer` an Partie **und** Runde gebunden (`runIndex` + `questionIndex`).
  - **R4** Client verwirft Bestätigungen aus einem früheren Frage-/Partie-Kontext.
  - Zwei neue Lint-Warnungen aus dem G3-Test sind bereinigt.
- Aktueller Code-Head, CI-Lauf und Zahlen: siehe PR-Beschreibung (maßgeblich ist die
  CI am letzten Head; ältere Läufe gelten nicht für spätere Commits).

## Bewusst nicht geändert

Keine Jeopardy-Teilpunkte, keine automatische verbale Bewertung, keine neuen
Eingabeoptionen/Tabellen/Editoren, kein UI-Redesign, keine neuen Spielregeln.
SKILL.md unverändert (veraltete Gate-/Token-Hinweise sind ein separates Thema).

## Grenzen und Offenes

- **Legacy:** Judge/Answer ohne Kontextfeld bleiben zulässig (alte Clients) und sind
  nicht gebunden; falsche oder unvollständige Kontextfelder werden abgewiesen.
- Core-DoD „zwei Verbraucher“ für die **Auswahlabgabe** offen (nur Wissensduell);
  verbale Abgabe/Bewertung: Jeopardy und WID.
- Normalisierung/Synonym/Fuzzy bleiben H; Zahl, Mehrfeld, Reihenfolge, Freitext als
  Bedarf mit offenen DEC-Punkten (Matrix E) — Entscheidungen des Nutzers.
- G4 (Ergebnis-Amendments, Limits pro Aktion, Fehlerdiagnose) und G5 nicht begonnen.
- `rate-limiter.integration` scheiterte in der Sandbox des Autors mit „Server startup
  timed out“, lief aber in der unabhängigen CI (4/4). Die Ursache lokal ist nicht
  untersucht und nicht als bewiesen zu betrachten.

## Unmittelbar nächster Schritt

CI/E2E am PR-Head abwarten, Reviewbefunde einarbeiten, Merge durch den Nutzer.
Danach G4 vom neuen main.
