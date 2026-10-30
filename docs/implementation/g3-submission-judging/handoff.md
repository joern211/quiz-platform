# G3 — Handoff

Basis: main `3d28d6f7ff039d8af010941cdcbf8572e1044809` (enthält G1, G2/PR23 und
PR24), direkt darauf der Arbeitsbranch `claude/gallant-carson-l71ezz` (Umgebung
schreibt dieses Branchschema vor; Vorschlag des Auftrags war
`feature/g3-submission-judging`). Keine gestapelte Feature-Kette, PR21 nicht
eingemischt. Voller Umfang und Nachweise: [Matrix](matrix.md).

## Umgesetzt

- **Befund und Fix:** `geo:answer` prüft ein mitgesendetes `questionIndex` gegen die
  aktuelle Runde (`STALE_ROUND`, keine Mutation). Der Web-Client sendet die Runde mit.
  Wire-Code ist öffentlich und auf `STALE_STATE` abgebildet. G1-Matrix angepasst.
- **Abnahme ohne Codeänderung** (bestehender Vertrag belegt, nicht umgeschrieben):
  Eigentümer/Teilnahme/Raum/Rolle, Frist und Pause, Absicht/Konflikt/Parallelität,
  Submit→Lock→Judge-Reihenfolge, EXACT/MANUAL_ONLY, 0 und Teilpunkte, nicht
  unterstützte Urteile, Rollback bei Ledger-Fehler, Sichtbarkeit für Player/Viewer/
  Display/Host/Blind-Host über Broadcast, Resync, Pause, Rejoin, Rechteentzug und
  Prozessneustart.
- **Dokumentiert, nicht gebaut:** Normalisierung/Synonym/Fuzzy bleiben H; Freitext,
  Zahl, Mehrfeld, Reihenfolge als getrennte Bedarfe (Matrix E).

## Nicht geändert (bewusst)

Jeopardy bekommt keine Teilpunkte; keine automatische verbale Bewertung; keine
neuen Eingabeoptionen, Tabellen, Editoren; kein UI-Redesign; SKILL.md unverändert
(veraltete Gate-/Token-Hinweise sind ein separates Thema, nicht Teil von G3).

## Offen für G4/G5 (nicht begonnen)

- G4: Ergebnis-Amendments und historische Korrekturen, Rate-Limits pro Spielaktion,
  Fehlerdiagnose; Wissensduell-Auto-Reveal bei Fristablauf lief bereits in G2.
- G5: Gesamtmatrix. Core-DoD „zwei Verbraucher“ für die **Auswahlabgabe** bleibt offen
  (nur Wissensduell); für verbale Abgabe/Bewertung sind Jeopardy und WID Verbraucher.
- Fachliche DEC-Punkte aus Matrix E (LMS, SAM, SCH, HOL, SLF, TIM, WOF, MIL, SPI, SNG,
  DDF-01…06) sind Entscheidungen des Nutzers, nichts davon wurde festgelegt.

## Prüfstand (lokal, Code-Head ohne spätere Doku-Änderungen)

- `pnpm typecheck` sauber; `pnpm lint` 0 Fehler (111 vorbestehende Warnungen).
- `pnpm build` erfolgreich.
- `pnpm --filter @quiz/server test`: 625 bestanden, 3 übersprungen, 1 Datei
  fehlgeschlagen: `http/rate-limiter.integration.test.ts` („Server startup timed
  out“, Produktions-Kindprozess). **Vorbestehend:** identisch im Basislauf auf
  unverändertem main `3d28d6f` und isoliert reproduzierbar; Ursache hier nicht
  untersucht (vermutlich Sandbox). Die CI muss dies bestätigen.
- `pnpm --filter @quiz/web test`: 161 bestanden.
- Playwright-E2E (Befehl gemäß ci.yml, frische Test-DB): 34 bestanden.
- Neue Tests: 19 + 3 + 3 (siehe Matrix), alle grün.
- **Remote/CI offen:** Push war beim Erstellen mit 403 (GitHub-Zugriff der Session)
  nicht möglich; es gibt keinen CI-Lauf für diesen Head.

## Unmittelbar nächster Schritt

CI/E2E des PR-Heads abwarten, Reviewbefunde einarbeiten, dann Merge durch den
Nutzer. Danach G4 vom neuen main.
